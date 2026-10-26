/** Actual original-lane reclaim retains catalog, source borrows and durable copy/cold dependencies. */
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SkillBundleLimits, SkillBundleVersion } from './skill-bundles.ts'
import type { SkillVersionId, SkillVersionLimits } from './skill-versions.ts'
import type { SkillProjectionLimits } from './skill-projection.ts'
import type { FdRootIdentity } from './worker-protocol.ts'
import type { FdWorkerClient } from './worker-client.ts'
import { bundleChild, bundleFile, readSkillBundleTree } from './skill-bundle-work.ts'
import { observeSkillCurrent } from './skill-version-work.ts'
import { parseBundleManifest, rejectBundle } from './bundle-codec.ts'
import { skillCopyReferences } from './skill-project-work.ts'

/** Original storage context; reclaim is never a Remote method or an id-authorized API. */
export interface BundleReclaimInput {
  readonly binding: AccountBinding
  readonly root: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly limits: SkillBundleLimits
  readonly sourceLimits: SkillVersionLimits
  readonly projectionLimits: SkillProjectionLimits
  readonly maxPathBytes: number
  readonly maxReplyBytes: number
  assertCurrent(): void
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function uuid(value: unknown): value is SkillVersionId { return typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) }
function exact(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(k => Object.hasOwn(row, k))
}

/**
 * Reclaim complete private versions only after every actual reference is known; never deletes project copies.
 * @param input Original verified private owner and complete parser capacities.
 * @param client Original exclusive mutation or post-drain worker.
 * @param active Exact same-owner in-flight/prepared references, empty only after actual drain.
 * @param signal Actual root/mutation cancellation; unconfirmed native effects retain their original responsibility.
 * @returns The measured remaining version ids after a confirmed native deletion and complete final inventory.
 */
export async function reclaimSkillBundles(input: BundleReclaimInput, client: FdWorkerClient,
  active: ReadonlySet<SkillVersionId>, signal: AbortSignal): Promise<ReadonlySet<SkillVersionId>> {
  input.assertCurrent(); signal.throwIfAborted()
  const retained = new Set(active)
  const copies = await skillCopyReferences({ binding: input.binding, privateRoot: input.root, uid: input.uid, gid: input.gid,
    limits: input.projectionLimits, sourceLimits: input.sourceLimits, bundleLimits: input.limits,
    maxPathBytes: input.maxPathBytes, maxReplyBytes: input.maxReplyBytes }, client, signal)
  for (const id of copies) retained.add(id)
  const skills = await bundleChild(client, input.root, 'skills', signal)
  if (skills === undefined) {
    if (retained.size) rejectBundle()
    return new Set()
  }
  const pointer = await bundleFile(client, skills, 'current.json', input.limits.maxCatalogBytes, signal)
  if (pointer !== undefined) {
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pointer.bytes)) } catch (_error) { rejectBundle() }
    if (!object(raw)) rejectBundle()
    if (raw.schema === 1) {
      const value = await observeSkillCurrent({ binding: input.binding, root: input.root, limits: input.sourceLimits,
        assertCurrent: () => { input.assertCurrent() } }, client, signal)
      if (value === undefined || value.revision !== pointer.revision) rejectBundle()
      retained.add(value.version.id)
    } else {
      if (!exact(raw, ['schema', 'entries']) || raw.schema !== 2 || !Array.isArray(raw.entries)
        || raw.entries.length > input.limits.maxInstallations) rejectBundle()
      const ids = new Set<string>()
      for (const entry of raw.entries) {
        if (!object(entry) || !exact(entry, ['skillId', 'kind', 'version']) || typeof entry.skillId !== 'string'
          || entry.kind !== 'managed' && entry.kind !== 'legacy-sample'
          || (entry.kind === 'managed' ? !uuid(entry.skillId) : entry.skillId !== 'sample') || ids.has(entry.skillId)
          || !object(entry.version) || !exact(entry.version, ['id', 'format', 'manifest']) || !uuid(entry.version.id)
          || entry.version.format !== 'legacy-two-file' && entry.version.format !== 'bundle-tree-v1') rejectBundle()
        ids.add(entry.skillId)
        const m = parseBundleManifest(entry.version.manifest, input.limits), format = entry.version.format
        if (entry.kind === 'legacy-sample' && (format !== 'legacy-two-file' || m.directories.length !== 0 || m.files.length !== 2
          || !m.files.some(f => f.relativePath === 'resource.bin'))) rejectBundle()
        const version: SkillBundleVersion = { binding: input.binding, id: entry.version.id, format, files: m.files,
          directories: m.directories, treeSha256: m.treeSha256, contentBytes: m.contentBytes, directoryCount: m.directories.length,
          chargedBytes: m.contentBytes + (format === 'legacy-two-file' ? 0 : Buffer.byteLength(JSON.stringify(m))),
          chargedInodes: format === 'legacy-two-file' ? 3 : 3 + m.files.length + m.directories.length }
        await readSkillBundleTree(input, client, version, signal)
        retained.add(version.id)
      }
    }
  }
  if (retained.size > input.sourceLimits.maxVersions) rejectBundle(true)
  for (const id of retained) {
    if (await bundleChild(client, skills, id, signal) === undefined) rejectBundle()
  }
  const facts = await client.bundle({ kind: 'bundle-reclaim', root: input.root, uid: input.uid, gid: input.gid,
    version: '00000000-0000-0000-0000-000000000000' as SkillVersionId, tree: { files: [], directories: [] }, metadata: null,
    expectedCopyInode: '0', retained: [...retained], revision: pointer?.revision ?? '', limits: input.limits,
    storage: input.sourceLimits }, signal)
  if (facts.outcome !== 'complete' || !facts.closed) throw new Error('Private reclaim completion is unconfirmed')
  const remaining = await client.list(skills, '.', input.sourceLimits.maxVersions + 1, input.limits.maxReplyBytes, signal)
  const result = new Set<SkillVersionId>()
  for (const entry of remaining) {
    if (entry.name === 'current.json') continue
    if (entry.type !== 'directory' || !uuid(entry.name) || !retained.has(entry.name)) rejectBundle()
    result.add(entry.name)
  }
  if ([...retained].some(id => !result.has(id))) rejectBundle()
  return result
}
