/** Fixed skill work runs on the original bound files lane; this module adds no scheduler or service owner. */
import { reclaimSkillBundles } from './skill-bundle-reclaim.ts'
import type { BundleReclaimInput } from './skill-bundle-reclaim.ts'
import { createSkillBundleWork } from './skill-bundle-work.ts'
import type { SkillBundleWork } from './skill-bundle-work.ts'
import { createHash, randomUUID } from 'node:crypto'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { FdMutationFailure, FdWorkerFailure } from './worker-client.ts'
import type { FdWorkerClient } from './worker-client.ts'
import type { FdRootIdentity } from './worker-protocol.ts'
import type { ResidentResult } from './work-queue.ts'
import type { SkillCurrent, SkillVersion, SkillVersionId, SkillVersionLimits, SkillVersionPort,
  SkillVersionSource } from './skill-versions.ts'

/** Original lane executors; the root storage owner supplies actual private identity and admission. */
export interface SkillVersionWork {
  readonly bundles?: Omit<SkillBundleWork, 'work' | 'issueLegacy' | 'forgetLegacy'>
  readonly binding: AccountBinding
  readonly root: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly maxReadBytes: number
  readonly limits: SkillVersionLimits
  assertCurrent(): void
  /** Bind a private same-worker reader to the original pool; never accepts a path or issues project authority. */
  bindProjectionRead?(read: (client: FdWorkerClient, version: SkillVersion, control: AbortSignal) => Promise<{
    skill: Uint8Array<ArrayBuffer>
    resource: Uint8Array<ArrayBuffer> }>,
    resolve: (id: SkillVersionId, expected: Omit<SkillVersion, 'binding'>) => SkillVersion | undefined): void
  mutate<T>(kind: 'prepare' | 'commit', work: (client: FdWorkerClient, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal): Promise<ResidentResult<T>>
  read<T>(work: (client: FdWorkerClient, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<ResidentResult<T>>
}

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function refused(code: 'FS_PERMISSION_DENIED' | 'FS_TOO_LARGE' | 'FS_STALE_VERSION' = 'FS_PERMISSION_DENIED'): never {
  throw new FdMutationFailure('not-published', code)
}
function sameRecord(a: SkillVersion, b: Omit<SkillVersion, 'binding'>): boolean {
  return a.id === b.id && a.skillSha256 === b.skillSha256 && a.resourceSha256 === b.resourceSha256
    && a.skillBytes === b.skillBytes && a.resourceBytes === b.resourceBytes
}

/** Internal readonly context used by the original live lane or original post-drain root operation. */
type SkillVersionReadInput = Pick<SkillVersionWork, 'binding' | 'root' | 'limits' | 'assertCurrent'>

async function childRoot(client: FdWorkerClient, parent: FdRootIdentity, leaf: string,
  signal: AbortSignal): Promise<FdRootIdentity | undefined> {
  const info = await client.lstat(parent, leaf, signal)
  if (info === undefined) return undefined
  if (info.type !== 'directory' || parent.rootMountId === undefined) refused()
  const [rootDevice, rootInode] = info.identity.split(':')
  if (rootDevice !== parent.rootDevice || rootInode === undefined) refused()
  return Object.freeze({ rootPath: `${parent.rootPath}/${leaf}`, rootDevice, rootInode, rootMountId: parent.rootMountId })
}

async function readSkillVersion(client: FdWorkerClient, input: SkillVersionReadInput, version: SkillVersion, signal: AbortSignal) {
  input.assertCurrent(); signal.throwIfAborted()
  const skills = await childRoot(client, input.root, 'skills', signal)
  if (skills === undefined) refused()
  const root = await childRoot(client, skills, version.id, signal)
  if (root === undefined) refused()
  const beforeSkill = await client.lstat(root, 'SKILL.md', signal), beforeResource = await client.lstat(root, 'resource.bin', signal)
  if (beforeSkill?.type !== 'file' || beforeResource?.type !== 'file'
    || beforeSkill.size !== version.skillBytes || beforeResource.size !== version.resourceBytes) refused()
  // Reads anchor at the exact version inode. Even a final symlink cannot reach another private subtree.
  const skill = await client.read(root, 'SKILL.md', input.limits.maxFileBytes, signal)
  const resource = await client.read(root, 'resource.bin', input.limits.maxFileBytes, signal)
  const afterSkill = await client.lstat(root, 'SKILL.md', signal), afterResource = await client.lstat(root, 'resource.bin', signal)
  if (afterSkill?.version !== beforeSkill.version || afterResource?.version !== beforeResource.version
    || skill.byteLength !== version.skillBytes || resource.byteLength !== version.resourceBytes
    || hash(skill) !== version.skillSha256 || hash(resource) !== version.resourceSha256) refused('FS_STALE_VERSION')
  new TextDecoder('utf-8', { fatal: true }).decode(skill)
  return { skill, resource }
}

/**
 * Keep original versions that may still be referenced by persistent project copies after the original lane actually joins.
 * @param input Original post-drain root context and deployment choice; not a caller authorization callback.
 * @param client The original exclusive root worker client.
 * @param control Actual root-operation cancellation, independent of the retired account observer.
 * @returns A conservative retention reason, or retirement only after confirmed absence of project-copy metadata.
 */
export async function retireSkillVersionsAfterDrain(
  input: SkillVersionReadInput & { readonly uid: number; readonly gid: number; readonly projectionConfigured: boolean; readonly bundles?: Omit<BundleReclaimInput, 'binding' | 'root' | 'uid' | 'gid' | 'sourceLimits' | 'assertCurrent'> },
  client: FdWorkerClient, control: AbortSignal,
): Promise<'retained-projection' | 'retained-association' | 'retired'> {
  input.assertCurrent()
  control.throwIfAborted()
  if (input.bundles !== undefined) {
    await reclaimSkillBundles({ ...input.bundles, binding: input.binding, root: input.root, uid: input.uid, gid: input.gid,
      sourceLimits: input.limits, assertCurrent: input.assertCurrent }, client, new Set(), control)
    return 'retired'
  }
  if (input.projectionConfigured) return 'retained-projection'
  // Existence only inhibits deletion. It never issues copy/source authority, even for an invalid or pending store.
  if (await client.lstat(input.root, 'skill-working-copies', control) !== undefined) return 'retained-association'
  const current = await observeSkillCurrent(input, client, control)
  await client.retireSkillVersions({ kind: 'skill-retire', root: input.root, uid: input.uid, gid: input.gid,
    current: current === undefined ? undefined : { id: current.version.id, revision: current.revision } }, input.limits.maxVersions,
  control)
  return 'retired'
}

/**
 * Observe a complete native pointer and both actual version bytes without issuing account authority.
 * @param input Original live lane or post-drain root read context.
 * @param client The original exclusive worker client.
 * @param control Actual read cancellation; it does not certify source or account drain.
 * @returns Validated current data and native revision, or undefined only for confirmed absence.
 */
export async function observeSkillCurrent(input: SkillVersionReadInput, client: FdWorkerClient,
  control: AbortSignal): Promise<SkillCurrent | undefined> {
  input.assertCurrent()
  const root = await childRoot(client, input.root, 'skills', control)
  if (root === undefined) return undefined
  const before = await client.lstat(root, 'current.json', control)
  if (before === undefined) return undefined
  if (before.type !== 'file' || before.size === undefined || before.size > 512) refused()
  const bytes = await client.read(root, 'current.json', 512, control)
  const after = await client.lstat(root, 'current.json', control)
  if (after?.version !== before.version) refused('FS_STALE_VERSION')
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refused()
  const row: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  if (Object.keys(row).length !== 6 || row.schema !== 1 || typeof row.id !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id)
    || typeof row.skillSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.skillSha256)
    || typeof row.resourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.resourceSha256)
    || typeof row.skillBytes !== 'number' || !Number.isSafeInteger(row.skillBytes) || row.skillBytes < 0
      || row.skillBytes > input.limits.maxFileBytes
    || typeof row.resourceBytes !== 'number' || !Number.isSafeInteger(row.resourceBytes) || row.resourceBytes < 0
      || row.resourceBytes > input.limits.maxFileBytes) refused()
  const version: SkillVersion = { binding: input.binding, id: row.id as SkillVersionId,
    skillSha256: row.skillSha256, resourceSha256: row.resourceSha256, skillBytes: row.skillBytes, resourceBytes: row.resourceBytes }
  await readSkillVersion(client, input, version, control)
  return Object.freeze({ version, revision: FsVersion(before.version) })
}

/**
 * Attach finite version capabilities to one existing bound files port, retaining every live version.
 * @param input Original static storage identity, original lane and its complete resident reservation.
 * @returns Methods recognized only by this original account generation, without a private path in their public values.
 */
export function createSkillVersionWork(input: SkillVersionWork): SkillVersionPort {
  const issued = new Map<SkillVersionId, SkillVersion>()
  input.binding.lifetime.addEventListener('abort', () => { issued.clear() }, { once: true })
  const recognize = (value: SkillVersion): void => {
    input.assertCurrent()
    if (issued.get(value.id) !== value || value.binding !== input.binding) refused()
  }
  const issue = (value: SkillVersion): SkillVersion => {
    const previous = issued.get(value.id)
    if (previous !== undefined) {
      if (!sameRecord(previous, value)) refused('FS_STALE_VERSION')
      return previous
    }
    if (issued.size >= input.limits.maxVersions) refused('FS_TOO_LARGE')
    const result = Object.freeze(value)
    if (!input.binding.lifetime.aborted) issued.set(value.id, result)
    return result
  }
  const load = (client: FdWorkerClient, version: SkillVersion, signal: AbortSignal) => readSkillVersion(client, input, version, signal)
  input.bindProjectionRead?.(async (client, version, control) => { recognize(version); return await load(client, version, control) },
    (id, expected) => {
      input.assertCurrent()
      const value = issued.get(id)
      if (value !== undefined) return sameRecord(value, expected) ? value : undefined
      // Managed copy records are parsed by the original protected store before this private resolver runs.
      // Actual two-file content and every copy directory are still verified before issuing an operation borrow.
      return input.bundles === undefined ? undefined : issue({ ...expected, binding: input.binding })
    })
  const legacy: SkillVersionPort = {
    prepare: async (value, signal) => {
      input.assertCurrent(); signal.throwIfAborted()
      const markdown = value.skillMarkdown, resourceInput = value.resource
      const length = Buffer.byteLength(markdown)
      if (length > input.limits.maxFileBytes || resourceInput.byteLength > input.limits.maxFileBytes
        || length + resourceInput.byteLength + 1024 > input.limits.maxTotalBytes) refused('FS_TOO_LARGE')
      if (!(resourceInput.buffer instanceof ArrayBuffer) || resourceInput.byteOffset !== 0
        || resourceInput.byteLength !== resourceInput.buffer.byteLength || Buffer.from(markdown).toString('utf8') !== markdown) refused()
      // Copy inside the original admitted operation, before worker transport. The source cannot race those owned bytes.
      return input.mutate('prepare', async (client, control) => {
        if (resourceInput.byteLength > input.limits.maxFileBytes) refused('FS_TOO_LARGE')
        const skill = new TextEncoder().encode(markdown), resource = Uint8Array.from(resourceInput)
        const version = randomUUID() as SkillVersionId
        const facts = await client.prepareSkillVersion({ kind: 'skill-prepare', root: input.root, uid: input.uid, gid: input.gid,
          version, skill, resource, limits: input.limits }, control)
        if (facts.outcome !== 'prepared') throw new FdMutationFailure('unknown', 'FS_IO_ERROR')
        return issue({ binding: input.binding, id: version, skillSha256: hash(skill), resourceSha256: hash(resource),
          skillBytes: skill.byteLength, resourceBytes: resource.byteLength })
      }, signal)
    },
    current: signal => input.read(async (client, control) => {
      const value = await observeSkillCurrent(input, client, control)
      return value === undefined ? undefined : Object.freeze({ ...value, version: issue(value.version) })
    }, signal),
    commit: (version, expected, signal) => {
      recognize(version)
      return input.mutate('commit', async (client, control) => {
        await load(client, version, control)
        const text = JSON.stringify({ schema: 1, id: version.id, skillSha256: version.skillSha256,
          resourceSha256: version.resourceSha256, skillBytes: version.skillBytes, resourceBytes: version.resourceBytes })
        if (Buffer.byteLength(text) > 512) refused('FS_TOO_LARGE')
        const outcome = await client.writeText(input.root, 'skills/current.json', text,
          expected === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: expected }, input.maxReadBytes, control)
        // No cancellation check after confirmed native publication: the real durable outcome must reach the save owner.
        return Object.freeze({ version, revision: FsVersion(outcome.version) })
      }, signal)
    },
    withSource: async (version, consume, signal) => {
      recognize(version)
      const snapshot = await input.read((client, control) => load(client, version, control), signal)
      let active = true
      let emittedBytes = 0
      const emit = (bytes: number): void => {
        const cost = bytes + 512
        if (!Number.isSafeInteger(cost) || emittedBytes + cost > Math.floor(input.limits.reservationBytes / 4)) refused('FS_TOO_LARGE')
        emittedBytes += cost
      }
      const current = (control?: AbortSignal): void => {
        input.assertCurrent(); signal.throwIfAborted(); control?.throwIfAborted()
        if (!active) throw new FdWorkerFailure('FS_PERMISSION_DENIED')
      }
      const source: SkillVersionSource = Object.freeze({ version,
        readText: (name: unknown, control?: AbortSignal) => Promise.resolve().then(() => {
          current(control)
          if (name !== 'SKILL.md') refused()
          emit(2 * snapshot.value.skill.byteLength)
          return new TextDecoder('utf-8', { fatal: true }).decode(snapshot.value.skill)
        }),
        readBytes: (name: unknown, control?: AbortSignal) => Promise.resolve().then(() => {
          current(control)
          if (name !== 'SKILL.md' && name !== 'resource.bin') refused()
          emit(name === 'SKILL.md' ? snapshot.value.skill.byteLength : snapshot.value.resource.byteLength)
          return Uint8Array.from(name === 'SKILL.md' ? snapshot.value.skill : snapshot.value.resource)
        }),
      })
      try {
        // Native source FDs and the worker/running slot have ended; the original resident result stays charged through consumption.
        const value = await consume(source, signal)
        return { value, release: () => { snapshot.release() } }
      } catch (error) { snapshot.release(); throw error } finally { active = false }
    },
  }
  return input.bundles === undefined ? legacy : createSkillBundleWork({ ...input.bundles, work: input, issueLegacy: issue,
    forgetLegacy: (id) => { issued.delete(id) } })
}
