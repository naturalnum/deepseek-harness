/** Bounded project-copy metadata and borrows on the original account files mutation/lane. */
import { parseBundleManifest } from './bundle-codec.ts'
import type { BundleTree } from './bundle-codec.ts'
import type { SkillBundleVersion, SkillBundleWorkingCopy, SkillBundleLimits, SkillBundleOperationCopies } from './skill-bundles.ts'
import { createHash } from 'node:crypto'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { StaticStorageDomain } from './storage-types.ts'
import type { ResidentResult } from './work-queue.ts'
import type { FdProjectMetadataDirectory, FdRootIdentity } from './worker-protocol.ts'
import type { FdWorkerClient } from './worker-client.ts'
import { FdMutationFailure, FdWorkerFailure } from './worker-client.ts'
import type { SkillRecordRevalidation } from './skill-revalidation.ts'
import type { SkillVersion, SkillVersionId, SkillVersionLimits } from './skill-versions.ts'
import { skillSourceContext } from './skill-projection.ts'
import type { SkillSourceContext, SkillProjectGrant, SkillWorkingCopyGrant, SkillOperationCopies,
  SkillProjectionLimits } from './skill-projection.ts'

/** Original bound port only; there is no public path or assertion callback on CloudAccountFiles. */
export interface SkillProjectPort {
  materializeBundle(project: SkillProjectGrant, version: SkillBundleVersion,
    signal: AbortSignal): Promise<ResidentResult<SkillBundleWorkingCopy>>
  borrowBundles(project: SkillProjectGrant, copies: readonly (SkillWorkingCopyGrant | SkillBundleWorkingCopy)[] | undefined,
    signal: AbortSignal): Promise<ResidentResult<SkillBundleOperationCopies>>
  assertBundleBorrow(value: SkillBundleOperationCopies): void
  prepareProject(workspace: Workspace, assertRegistered: () => void, signal: AbortSignal): Promise<ResidentResult<SkillProjectGrant>>
  materialize(project: SkillProjectGrant, version: SkillVersion, signal: AbortSignal): Promise<ResidentResult<SkillWorkingCopyGrant>>
  borrow(project: SkillProjectGrant, copies: readonly SkillWorkingCopyGrant[],
    signal: AbortSignal): Promise<ResidentResult<SkillOperationCopies>>
  borrowAll(project: SkillProjectGrant, signal: AbortSignal): Promise<ResidentResult<SkillOperationCopies>>
  assertProject(project: SkillProjectGrant): void
  assertCopy(copy: SkillWorkingCopyGrant): void
  assertBorrow(borrow: SkillOperationCopies): void
}

/** Existing storage authority, same-worker source reader and original serial mutation executor. */
export interface SkillProjectWork {
  readonly bundleLimits?: SkillBundleLimits
  bundleSource?(client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal): Promise<BundleTree>
  bundleAuthorize?(client: FdWorkerClient, version: SkillBundleVersion, control: AbortSignal): Promise<void>
  resolveBundle?(version: Omit<SkillBundleVersion, 'binding'>): SkillBundleVersion
  readonly binding: AccountBinding
  readonly privateRoot: FdRootIdentity
  readonly uid: number
  readonly gid: number
  readonly quota: StaticStorageDomain
  readonly limits: SkillProjectionLimits
  readonly sourceLimits: SkillVersionLimits
  /** Original text transport capacity; record bodies remain bounded by maxRecordBytes. */
  readonly maxReadBytes: number
  readonly maxPathBytes: number
  readonly maxReplyBytes: number
  /** Single old-record authority from the original Root lease; absence preserves every ordinary scope/mount refusal. */
  readonly revalidation?: SkillRecordRevalidation
  assertCurrent(): void
  project(client: FdWorkerClient, workspace: Workspace, control: AbortSignal): Promise<FdRootIdentity>
  resolveSource(source: LegacySource): SkillVersion | undefined
  source(client: FdWorkerClient, version: SkillVersion, control: AbortSignal): Promise<{ skill: Uint8Array<ArrayBuffer>
    resource: Uint8Array<ArrayBuffer> }>
  /** Only a completed parent grant is passive; operation-copy borrows and publication results remain ordinary work. */
  mutate<T>(work: (client: FdWorkerClient, control: AbortSignal) => Promise<T>, signal: AbortSignal,
    retention?: 'lease'): Promise<ResidentResult<T>>
}

type LegacySource = Pick<SkillVersion, 'id' | 'skillSha256' | 'resourceSha256' | 'skillBytes' | 'resourceBytes'>
type Source = LegacySource | Omit<SkillBundleVersion, 'binding'>
type Version = SkillVersion | SkillBundleVersion
type CopyGrant = SkillWorkingCopyGrant | SkillBundleWorkingCopy
type Copy = { readonly source: Source; readonly directory: FdProjectMetadataDirectory }
type RecordValue = { readonly schema: 1 | 2
  readonly accountId: string
  readonly workspaceId: string
  readonly project: FdRootIdentity
  readonly sourceContext: SkillSourceContext
  readonly metadata: FdProjectMetadataDirectory
  readonly skills: FdProjectMetadataDirectory | null
  readonly state: 'preparing-parent' | 'preparing-copy' | 'complete'
  readonly pending: Source | null
  readonly copies: readonly Copy[] }
type RecordRead = { readonly value: RecordValue; readonly revision: string; readonly bytes: number }

function denied(code: 'FS_PERMISSION_DENIED' | 'FS_TOO_LARGE' | 'FS_STALE_VERSION' = 'FS_PERMISSION_DENIED'): never {
  throw new FdMutationFailure('not-published', code)
}
function unknown(cause?: unknown): never { throw new FdMutationFailure('unknown', 'FS_IO_ERROR', undefined, { cause }) }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null
  && !Array.isArray(value) }
function array(value: unknown): boolean { return Array.isArray(value) }
function exact(row: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(row).length === keys.length
  && keys.every(k => Object.hasOwn(row, k)) }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)
  && BigInt(value) <= 0xffffffffffffffffn }
function label(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length > 0
  && !value.includes('\0') && Buffer.byteLength(value) <= maximum }
function sameRoot(a: FdRootIdentity, b: FdRootIdentity): boolean { return a.rootPath === b.rootPath
  && a.rootDevice === b.rootDevice && a.rootInode === b.rootInode && a.rootMountId === b.rootMountId }
function sameDirectory(a: FdProjectMetadataDirectory, b: FdProjectMetadataDirectory): boolean {
  return (['device', 'inode', 'mountId', 'uid', 'gid', 'mode'] as const).every(k => a[k] === b[k])
}
function source(version: Version): Source {
  if ('format' in version) { const { binding: _binding, ...value } = version; return Object.freeze(value) }
  return Object.freeze({ id: version.id, skillSha256: version.skillSha256, resourceSha256: version.resourceSha256,
    skillBytes: version.skillBytes, resourceBytes: version.resourceBytes })
}
function sameSource(a: Source, b: Source): boolean {
  if ('format' in a || 'format' in b) return 'format' in a && 'format' in b && a.id === b.id && a.format === b.format
    && a.treeSha256 === b.treeSha256 && JSON.stringify(a) === JSON.stringify(b)
  return a.id === b.id && a.skillSha256 === b.skillSha256 && a.resourceSha256 === b.resourceSha256
    && a.skillBytes === b.skillBytes && a.resourceBytes === b.resourceBytes
}
function legacyCopy(value: CopyGrant): value is SkillWorkingCopyGrant { return !('format' in value.version) }
function file(workspaceId: string): string { return `project-${createHash('sha256').update(workspaceId).digest('hex')}.json` }
function child(root: FdRootIdentity, name: string, identity: FdProjectMetadataDirectory): FdRootIdentity {
  return Object.freeze({ rootPath: `${root.rootPath}/${name}`, rootDevice: identity.device, rootInode: identity.inode,
    rootMountId: identity.mountId })
}

function parseRecord(raw: unknown, input: Pick<SkillProjectWork, 'binding' | 'limits' | 'sourceLimits' | 'maxPathBytes' | 'uid' | 'gid' | 'bundleLimits'>): RecordValue {
  if (!object(raw) || !exact(raw, ['schema', 'accountId', 'workspaceId', 'project', 'sourceContext', 'metadata', 'skills', 'state',
    'pending', 'copies'])
    || raw.schema !== 1 && raw.schema !== 2 || raw.accountId !== input.binding.accountId || !label(raw.workspaceId, input.maxPathBytes)
    || !object(raw.project) || !exact(raw.project, ['rootPath', 'rootDevice', 'rootInode', 'rootMountId'])
    || !label(raw.project.rootPath, input.maxPathBytes) || !raw.project.rootPath.startsWith('/')
    || !decimal(raw.project.rootDevice) || !decimal(raw.project.rootInode) || !decimal(raw.project.rootMountId)) unknown()
  const context = skillSourceContext(raw.sourceContext)
  if (context === undefined) unknown()
  const project: FdRootIdentity = Object.freeze({ rootPath: raw.project.rootPath, rootDevice: raw.project.rootDevice,
    rootInode: raw.project.rootInode, rootMountId: raw.project.rootMountId })
  const directory = (value: unknown): FdProjectMetadataDirectory => {
    if (!object(value) || !exact(value, ['device', 'inode', 'mountId', 'uid', 'gid', 'mode']) || !decimal(value.device)
      || !decimal(value.inode) || value.inode === '0' || !decimal(value.mountId) || value.mountId === '0'
      || value.device !== project.rootDevice || value.mountId !== project.rootMountId
      || value.uid !== input.uid || value.gid !== input.gid || value.mode !== 0o40700) unknown()
    return Object.freeze({ device: value.device, inode: value.inode, mountId: value.mountId, uid: input.uid, gid: input.gid,
      mode: 0o40700 })
  }
  const parseSource = (value: unknown): Source => {
    if (object(value) && 'format' in value) {
      const limits = input.bundleLimits
      if (limits === undefined || raw.schema !== 2 || !exact(value, ['id', 'format', 'files', 'directories', 'treeSha256',
        'contentBytes', 'directoryCount', 'chargedBytes', 'chargedInodes']) || typeof value.id !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id)
        || value.format !== 'bundle-tree-v1' && value.format !== 'legacy-two-file') unknown()
      const manifest = parseBundleManifest({ schema: 1, files: value.files, directories: value.directories,
        treeSha256: value.treeSha256, contentBytes: value.contentBytes }, limits)
      const chargedBytes = manifest.contentBytes + (value.format === 'bundle-tree-v1' ? Buffer.byteLength(JSON.stringify(manifest)) : 0)
      const chargedInodes = value.format === 'bundle-tree-v1' ? 3 + manifest.files.length + manifest.directories.length : 3
      if (value.directoryCount !== manifest.directories.length || value.chargedBytes !== chargedBytes
        || value.chargedInodes !== chargedInodes) unknown()
      return Object.freeze({ id: value.id as SkillVersionId, format: value.format, files: manifest.files,
        directories: manifest.directories, treeSha256: manifest.treeSha256, contentBytes: manifest.contentBytes,
        directoryCount: manifest.directories.length, chargedBytes, chargedInodes })
    }
    if (!object(value) || !exact(value, ['id', 'skillSha256', 'resourceSha256', 'skillBytes', 'resourceBytes'])
      || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id)
      || typeof value.skillSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.skillSha256)
      || typeof value.resourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.resourceSha256)
      || typeof value.skillBytes !== 'number' || typeof value.resourceBytes !== 'number'
      || ![value.skillBytes, value.resourceBytes].every(n => Number.isSafeInteger(n) && n >= 0
        && n <= input.sourceLimits.maxFileBytes)) unknown()
    return Object.freeze({ id: value.id as SkillVersion['id'], skillSha256: value.skillSha256, resourceSha256: value.resourceSha256,
      skillBytes: value.skillBytes, resourceBytes: value.resourceBytes })
  }
  if (!Array.isArray(raw.copies) || raw.copies.length > input.limits.maxCopiesPerProject) unknown()
  const copies = raw.copies.map((value: unknown): Copy => {
    if (!object(value) || !exact(value, ['source', 'directory'])) unknown()
    return Object.freeze({ source: parseSource(value.source), directory: directory(value.directory) })
  })
  if (new Set(copies.map(c => c.source.id)).size !== copies.length) unknown()
  const skills = raw.skills === null ? null : directory(raw.skills), pending = raw.pending === null ? null : parseSource(raw.pending)
  if (raw.state !== 'complete' && raw.state !== 'preparing-parent' && raw.state !== 'preparing-copy') unknown()
  if (raw.state === 'complete' ? skills === null || pending !== null : raw.state === 'preparing-parent'
    ? skills !== null || pending !== null || copies.length !== 0 : skills === null || pending === null) unknown()
  return Object.freeze({ schema: raw.schema, accountId: input.binding.accountId, workspaceId: raw.workspaceId, project,
    sourceContext: context, metadata: directory(raw.metadata), skills, state: raw.state, pending, copies: Object.freeze(copies) })
}

/**
 * Attach bounded persistent associations and exact borrows to the existing account files port.
 * @param input Original storage qualification, lane, mutation and source reader; no separate scheduler is created.
 * @returns Project/copy/operation capabilities; actual consumers retain results through their existing settlement chains.
 */
export function createSkillProjectWork(input: SkillProjectWork): SkillProjectPort {
  const parents = new Map<string, { readonly value: SkillProjectGrant; readonly current: () => void }>()
  const copies = new Map<string, CopyGrant>()
  const parentRefs = new Map<SkillProjectGrant, number>()
  const operations = new WeakSet<SkillOperationCopies | SkillBundleOperationCopies>()
  let parentBorrows = 0, operationBorrows = 0
  const current = (): void => { input.assertCurrent(); if (input.binding.lifetime.aborted) denied() }
  const parent = (value: SkillProjectGrant): { readonly value: SkillProjectGrant; readonly current: () => void } => {
    current(); const row = parents.get(value.workspaceId)
    if (row?.value !== value || (parentRefs.get(value) ?? 0) < 1) denied()
    row.current(); return row
  }
  const recognizeCopy = (value: CopyGrant): void => {
    current(); if (copies.get(`${value.workspaceId}:${value.version.id}`) !== value) denied()
    const issuedParent = parents.get(value.workspaceId)
    if (issuedParent === undefined) denied()
    issuedParent.current()
  }
  const io = <T>(work: (client: FdWorkerClient, signal: AbortSignal) => Promise<T>, signal: AbortSignal,
    retention?: 'lease'): Promise<ResidentResult<T>> => {
    current(); signal.throwIfAborted()
    return input.mutate(async (client, control) => {
      try { return await work(client, control) } catch (error) {
        if (error instanceof FdMutationFailure) throw error
        if (error instanceof FdWorkerFailure) throw new FdMutationFailure('not-published', error.code, undefined, { cause: error })
        throw error
      }
    }, signal, retention)
  }
  const store = async (client: FdWorkerClient, control: AbortSignal, allowCreate = false,
    selected?: { readonly workspace: Workspace; readonly root: FdRootIdentity; readonly assertRegistered: () => void }) => {
    const context = await client.skillSourceContext(control)
    const before = await client.lstat(input.privateRoot, 'skill-working-copies', control)
    if (before === undefined && !allowCreate || before !== undefined && before.type !== 'directory') unknown()
    const prepared = await client.skillDirectory(input.privateRoot, input.uid, input.gid,
      before === undefined ? 'store' : 'store-verify', input.limits, control)
    const root = child(input.privateRoot, 'skill-working-copies', prepared.directory)
    const names = await client.list(root, '.', input.limits.maxProjects, input.maxReplyBytes, control)
    const rows = new Map<string, RecordRead>(); let total = 0
    let revalidate: { readonly name: string; readonly row: RecordRead } | undefined
    for (const entry of names) {
      if (!/^project-[a-f0-9]{64}\.json$/.test(entry.name) || entry.type !== 'file') unknown()
      const before = await client.lstat(root, entry.name, control)
      if (before?.type !== 'file' || before.size === undefined || before.size < 1 || before.size > input.limits.maxRecordBytes) unknown()
      const bytes = await client.read(root, entry.name, input.limits.maxRecordBytes, control)
      const after = await client.lstat(root, entry.name, control)
      if (after?.version !== before.version || bytes.byteLength !== before.size) unknown()
      let value: RecordValue
      try { value = parseRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), input) } catch (cause) {
        unknown(cause) }
      if (entry.name !== file(value.workspaceId) || value.state !== 'complete') unknown()
      // Source namespace numbers are interpreted only in their recorded kernel scope. Rebinding needs Root volume evidence.
      const changedScope = value.sourceContext.bootId !== context.bootId || value.sourceContext.mountNamespace !== context.mountNamespace
      const selectedRecord = selected?.workspace.id === value.workspaceId
      const digest = createHash('sha256').update(bytes).digest('hex'), authority = input.revalidation
      const forced = selectedRecord && !parents.has(value.workspaceId) && authority?.workspaceId === value.workspaceId
        && authority.pending && authority.recordSha256 === digest
      if (changedScope || selectedRecord && !sameRoot(value.project, selected.root) || forced) {
        if (!selectedRecord || authority === undefined || authority.workspaceId !== value.workspaceId
          || authority.recordSha256 !== digest || revalidate !== undefined) denied('FS_STALE_VERSION')
        authority.assertRecord(before.version)
        revalidate = { name: entry.name, row: { value, revision: before.version, bytes: bytes.byteLength } }
      }
      total += bytes.byteLength
      rows.set(entry.name, { value, revision: before.version, bytes: bytes.byteLength })
    }
    if (total + input.limits.maxRecordBytes > input.limits.maxMetadataBytes || rows.size
      + 2 > input.limits.maxMetadataInodes) denied('FS_TOO_LARGE')
    if (revalidate !== undefined) {
      if (selected === undefined || input.revalidation === undefined) denied('FS_STALE_VERSION')
      const previous = revalidate.row, value = await revalidateRecord(client, previous.value, selected.root, context, control)
      const bytes = Buffer.byteLength(JSON.stringify(value))
      if (total - previous.bytes + bytes + input.limits.maxRecordBytes > input.limits.maxMetadataBytes) denied('FS_TOO_LARGE')
      current(); selected.assertRegistered(); if (selected.workspace.id !== value.workspaceId) denied('FS_STALE_VERSION')
      input.revalidation.assertRecord(previous.revision)
      control.throwIfAborted()
      const committed = await write(client, root, value, previous.revision, control)
      input.revalidation.confirmRecord(previous.revision, committed.version)
      rows.set(revalidate.name, { value, revision: committed.version, bytes }); total += bytes - previous.bytes
    }
    return { root, rows, total, context }
  }
  const write = async (client: FdWorkerClient, root: FdRootIdentity, value: RecordValue, revision: string | undefined,
    control: AbortSignal) => {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > input.limits.maxRecordBytes) denied('FS_TOO_LARGE')
    return await client.writeText(root, file(value.workspaceId), text, revision === undefined ? { kind: 'createIfAbsent' }
      : { kind: 'replaceIfVersion', version: FsVersion(revision) }, input.maxReadBytes, control)
  }
  const validateParent = async (client: FdWorkerClient, value: RecordValue, control: AbortSignal): Promise<SkillProjectGrant> => {
    if (value.skills === null || value.project.rootMountId === undefined) unknown()
    const metadataRoot = child(value.project, '.pe', value.metadata)
    const actual = await client.skillDirectory(metadataRoot, input.uid, input.gid, 'parent-verify', input.limits, control)
    if (!sameDirectory(actual.directory, value.skills)) denied('FS_STALE_VERSION')
    const listed = await client.list(child(metadataRoot, 'skills', value.skills), '.', input.limits.maxCopiesPerProject,
      input.maxReplyBytes, control)
    const wanted = new Set(value.copies.map(c => c.source.id))
    if (listed.length !== wanted.size || listed.some(e => e.type !== 'directory' || !wanted.has(e.name as SkillVersion['id']))) unknown()
    return Object.freeze({ binding: input.binding, workspaceId: value.workspaceId as Workspace['id'],
      project: Object.freeze({ ...value.project, rootMountId: value.project.rootMountId, quota: Object.freeze({
        device: input.quota.rootDevice, mountId: input.quota.rootMountId,
        maximumBytes: input.quota.maximumBytes, maximumInodes: input.quota.maximumInodes }) }), metadataDirectory: value.metadata,
      skillsDirectory: value.skills })
  }
  const issueParent = (value: SkillProjectGrant, assertRegistered: () => void): SkillProjectGrant => {
    const previous = parents.get(value.workspaceId)
    if (previous !== undefined) {
      previous.current()
      if (!sameRoot(previous.value.project, value.project) || !sameDirectory(previous.value.metadataDirectory, value.metadataDirectory)
        || !sameDirectory(previous.value.skillsDirectory, value.skillsDirectory)) denied('FS_STALE_VERSION')
      return previous.value
    }
    if (parents.size >= input.limits.maxProjects) denied('FS_TOO_LARGE')
    parents.set(value.workspaceId, { value, current: assertRegistered }); return value
  }
  const resolve = (value: Source): Version | undefined => 'format' in value ? input.resolveBundle?.(value) : input.resolveSource(value)
  const projectCopy = async (client: FdWorkerClient, value: RecordValue, version: Version, expectedCopyInode: string,
    control: AbortSignal) => {
    if ('format' in version) {
      if (input.bundleSource === undefined || input.bundleLimits === undefined) denied()
      const tree = await input.bundleSource(client, version, control)
      const facts = await client.bundle({ kind: 'bundle-project', root: value.project, uid: input.uid, gid: input.gid,
        version: version.id, tree, metadata: value.metadata, expectedCopyInode, retained: [], revision: '',
        limits: input.bundleLimits, storage: { ...input.sourceLimits, maxVersions: input.limits.maxCopiesPerProject } }, control)
      if (facts.outcome !== 'complete') unknown()
      const actual = await client.skillDirectory(child(value.project, '.pe', value.metadata), input.uid, input.gid,
        'parent-verify', input.limits, control)
      return { reused: facts.reused, copyDirectory: facts.directory, skillsDirectory: actual.directory }
    }
    const original = await input.source(client, version, control)
    return client.projectSkillVersion({ kind: 'skill-project', root: value.project, metadata: value.metadata,
      uid: input.uid, gid: input.gid, version: version.id,
      skill: Uint8Array.from(original.skill), resource: Uint8Array.from(original.resource),
      limits: input.sourceLimits, maximumCopies: input.limits.maxCopiesPerProject, expectedCopyInode }, control)
  }
  const verifyCopy = async (client: FdWorkerClient, project: SkillProjectGrant, value: RecordValue, version: Version,
    control: AbortSignal) => {
    const found = value.copies.find(c => c.source.id === version.id)
    if (found === undefined || !sameSource(found.source, source(version))) denied('FS_STALE_VERSION')
    const facts = await projectCopy(client, value, version, found.directory.inode, control)
    if (!facts.reused || !sameDirectory(facts.copyDirectory, found.directory)
      || !sameDirectory(facts.skillsDirectory, project.skillsDirectory)) unknown()
    return found
  }
  const revalidateRecord = async (client: FdWorkerClient, previous: RecordValue, root: FdRootIdentity,
    context: SkillSourceContext, control: AbortSignal): Promise<RecordValue> => {
    const rootMountId = root.rootMountId
    if (rootMountId === undefined || previous.state !== 'complete' || previous.pending !== null || previous.skills === null
      || previous.project.rootPath !== root.rootPath || previous.project.rootDevice !== root.rootDevice
      || previous.project.rootInode !== root.rootInode) denied('FS_STALE_VERSION')
    const expected = (old: FdProjectMetadataDirectory): FdProjectMetadataDirectory => Object.freeze({ ...old,
      mountId: rootMountId })
    // These are expected facts only. Original native verification must confirm every actual directory before CAS.
    const value: RecordValue = Object.freeze({ ...previous, project: root, sourceContext: context,
      metadata: expected(previous.metadata), skills: expected(previous.skills),
      copies: Object.freeze(previous.copies.map(copy => Object.freeze({ source: copy.source, directory: expected(copy.directory) }))) })
    const project = await validateParent(client, value, control)
    for (const copy of value.copies) {
      const version = resolve(copy.source)
      if (version === undefined) denied('FS_STALE_VERSION')
      await verifyCopy(client, project, value, version, control)
    }
    return value
  }
  const issueCopy = (project: SkillProjectGrant, version: Version, directory: FdProjectMetadataDirectory): CopyGrant => {
    const key = `${project.workspaceId}:${version.id}`, previous = copies.get(key)
    if (previous !== undefined) {
      if (previous.version !== version || !sameDirectory(previous.copyDirectory, directory)) denied('FS_STALE_VERSION')
      return previous
    }
    if (copies.size >= input.limits.maxProjects * input.limits.maxCopiesPerProject) denied('FS_TOO_LARGE')
    const common = { binding: input.binding, workspaceId: project.workspaceId,
      resourceBase: `.pe/skills/${version.id}/`, metadataDirectory: project.metadataDirectory,
      skillsDirectory: project.skillsDirectory, copyDirectory: directory }
    const result: CopyGrant = 'format' in version
      ? Object.freeze<SkillBundleWorkingCopy>({ ...common, version })
      : Object.freeze<SkillWorkingCopyGrant>({ ...common, version })
    copies.set(key, result); return result
  }
  const borrow = async (project: SkillProjectGrant, selected: readonly CopyGrant[] | undefined,
    signal: AbortSignal): Promise<ResidentResult<SkillBundleOperationCopies>> => {
    parent(project)
    if (operationBorrows >= input.limits.maxOperationBorrows || selected !== undefined && (!array(selected)
      || selected.length > input.limits.maxCopiesPerOperation || new Set(selected).size !== selected.length)) denied('FS_TOO_LARGE')
    if (selected !== undefined) for (const copy of selected) { recognizeCopy(copy); if (copy.workspaceId !== project.workspaceId) denied() }
    const supplied = selected === undefined ? undefined : Object.freeze([...selected])
    const held = await io(async (client, control) => {
      parent(project)
      const scanned = await store(client, control), existing = scanned.rows.get(file(project.workspaceId))
      if (existing === undefined) unknown()
      const actual = await validateParent(client, existing.value, control)
      if (!sameRoot(actual.project, project.project) || !sameDirectory(actual.metadataDirectory, project.metadataDirectory)
        || !sameDirectory(actual.skillsDirectory, project.skillsDirectory)) denied('FS_STALE_VERSION')
      const rows = supplied === undefined ? existing.value.copies : supplied.map((copy) => {
        const row = existing.value.copies.find(row => row.source.id === copy.version.id)
        if (row === undefined || !sameDirectory(row.directory, copy.copyDirectory)) denied('FS_STALE_VERSION')
        return row
      })
      if (rows.length > input.limits.maxCopiesPerOperation) denied('FS_TOO_LARGE')
      const complete: Array<{ version: Version; directory: FdProjectMetadataDirectory }> = []
      for (const row of rows) {
        const version = resolve(row.source)
        if (version === undefined) denied('FS_STALE_VERSION')
        const checked = await verifyCopy(client, project, existing.value, version, control)
        complete.push({ version, directory: checked.directory })
      }
      return complete
    }, signal)
    try {
      parent(project); signal.throwIfAborted()
      if (operationBorrows >= input.limits.maxOperationBorrows) denied('FS_TOO_LARGE')
      const fixed = Object.freeze(held.value.map(row => issueCopy(project, row.version, row.directory)))
      const value = Object.freeze({ project, copies: fixed })
      operationBorrows++; operations.add(value)
      let released = false
      return { value, release: () => { if (released) return; released = true; operationBorrows--; operations.delete(value)
        held.release() } }
    } catch (error) { held.release(); throw error }
  }
  const materialize = async (project: SkillProjectGrant, version: Version, signal: AbortSignal): Promise<ResidentResult<CopyGrant>> => {
    parent(project)
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(version.id)) denied()
    const held = await io(async (client, control) => {
      parent(project)
      const scanned = await store(client, control), existing = scanned.rows.get(file(project.workspaceId))
      if (existing === undefined) unknown()
      const value = existing.value
      const actual = await validateParent(client, value, control)
      if (!sameRoot(project.project, actual.project) || !sameDirectory(project.skillsDirectory, actual.skillsDirectory)
          || !sameDirectory(project.metadataDirectory, actual.metadataDirectory)) denied('FS_STALE_VERSION')
      if ('format' in version) {
        if (input.bundleAuthorize === undefined) denied()
        await input.bundleAuthorize(client, version, control)
      }
      const found = value.copies.find(c => c.source.id === version.id)
      if (found !== undefined) return (await verifyCopy(client, project, value, version, control)).directory
      if (value.copies.length >= input.limits.maxCopiesPerProject) denied('FS_TOO_LARGE')
      const pending: RecordValue = { ...value, schema: 'format' in version ? 2 : value.schema, state: 'preparing-copy', pending: source(version) }
      const written = await write(client, scanned.root, pending, existing.revision, control)
      const settlement = new AbortController().signal
      try {
        const facts = await projectCopy(client, value, version, '0', settlement)
        if (facts.reused || !sameDirectory(facts.skillsDirectory, project.skillsDirectory)) unknown()
        const completed: RecordValue = { ...pending, state: 'complete', pending: null,
          copies: [...value.copies, { source: source(version), directory: facts.copyDirectory }] }
        await write(client, scanned.root, completed, written.version, settlement)
        return facts.copyDirectory
      } catch (cause) { unknown(cause) }
    }, signal)
    try { parent(project); signal.throwIfAborted(); return { value: issueCopy(project, 'format' in version ? resolve(source(version)) ?? version : version, held.value), release: () => {
      held.release() } } }
    catch (error) { held.release(); throw error }
  }
  const assertBorrow = (value: SkillOperationCopies | SkillBundleOperationCopies): void => {
    current(); if (!operations.has(value)) denied(); parent(value.project)
    for (const copy of value.copies) recognizeCopy(copy)
  }
  const borrowLegacy = async (project: SkillProjectGrant, selected: readonly SkillWorkingCopyGrant[] | undefined,
    signal: AbortSignal): Promise<ResidentResult<SkillOperationCopies>> => {
    const held = await borrow(project, selected, signal)
    const copies = held.value.copies.filter(legacyCopy)
    if (copies.length !== held.value.copies.length) { held.release(); denied() }
    const value = Object.freeze({ project, copies: Object.freeze(copies) }); operations.add(value)
    return { value, release: () => { operations.delete(value); held.release() } }
  }
  return {
    materializeBundle: async (project, version, signal) => {
      const held = await materialize(project, version, signal)
      if (legacyCopy(held.value)) { held.release(); denied() }
      return { value: held.value, release: () => { held.release() } }
    },
    borrowBundles: borrow,
    assertBundleBorrow: assertBorrow,
    materialize: async (project, version, signal) => {
      const held = await materialize(project, version, signal)
      if (!legacyCopy(held.value)) { held.release(); denied() }
      return { value: held.value, release: () => { held.release() } }
    },
    prepareProject: async (workspace, assertRegistered, signal) => {
      current(); assertRegistered()
      if (parentBorrows >= input.limits.maxParentBorrows) denied('FS_TOO_LARGE')
      const held = await io(async (client, control) => {
        assertRegistered()
        const root = await input.project(client, workspace, control)
        const preexistingParent = await client.lstat(root, '.pe/skills', control)
        const scanned = await store(client, control, preexistingParent === undefined, { workspace, root, assertRegistered })
        const existing = scanned.rows.get(file(workspace.id))
        if (existing !== undefined) {
          if (!sameRoot(existing.value.project, root)) denied('FS_STALE_VERSION')
          return await validateParent(client, existing.value, control)
        }
        if (preexistingParent !== undefined) unknown()
        if (scanned.rows.size >= input.limits.maxProjects) denied('FS_TOO_LARGE')
        const metadata = await client.prepareProjectMetadata(root, input.uid, input.gid, control)
        const pending: RecordValue = { schema: 1, accountId: input.binding.accountId, workspaceId: workspace.id,
          project: root, sourceContext: scanned.context, metadata: metadata.directory, skills: null, state: 'preparing-parent',
          pending: null, copies: [] }
        const written = await write(client, scanned.root, pending, undefined, control)
        const settlement = new AbortController().signal
        try {
          const skills = await client.skillDirectory(child(root, '.pe', metadata.directory), input.uid, input.gid, 'parent-create',
            input.limits, settlement)
          if (!skills.created) unknown()
          const completed: RecordValue = { ...pending, skills: skills.directory, state: 'complete' }
          await write(client, scanned.root, completed, written.version, settlement)
          return await validateParent(client, completed, settlement)
        } catch (cause) { unknown(cause) }
      }, signal, 'lease')
      try {
        current(); signal.throwIfAborted(); assertRegistered()
        if (parentBorrows >= input.limits.maxParentBorrows) denied('FS_TOO_LARGE')
        const value = issueParent(held.value, assertRegistered)
        parentBorrows++; parentRefs.set(value, (parentRefs.get(value) ?? 0) + 1)
        let released = false
        return { value, release: () => { if (released) return; released = true; parentBorrows--; parentRefs.set(value,
          (parentRefs.get(value) ?? 1) - 1); held.release() } }
      } catch (error) { held.release(); throw error }
    },
    borrow: (project, selected, signal) => borrowLegacy(project, selected, signal),
    borrowAll: (project, signal) => borrowLegacy(project, undefined, signal),
    assertProject: (value) => { parent(value) },
    assertCopy: recognizeCopy,
    assertBorrow,
  }
}

/**
 * Read every durable dependency before private reclaim; pending and cold records retain their sources.
 * @param input Original storage identity and explicit projection/parser limits.
 * @param client Original live mutation or post-drain root worker.
 * @param signal Actual operation cancellation; parse failures preserve every source.
 * @returns Complete bounded dependency set, never inferred from passive parent leases.
 */
export async function skillCopyReferences(input: Pick<SkillProjectWork, 'binding' | 'privateRoot' | 'limits' | 'sourceLimits'
  | 'maxPathBytes' | 'maxReplyBytes' | 'uid' | 'gid' | 'bundleLimits'>, client: FdWorkerClient, signal: AbortSignal)
  : Promise<ReadonlySet<SkillVersionId>> {
  const before = await client.lstat(input.privateRoot, 'skill-working-copies', signal)
  if (before === undefined) return new Set()
  if (before.type !== 'directory') unknown()
  const actual = await client.skillDirectory(input.privateRoot, input.uid, input.gid, 'store-verify', input.limits, signal)
  const root = child(input.privateRoot, 'skill-working-copies', actual.directory)
  const names = await client.list(root, '.', input.limits.maxProjects, input.maxReplyBytes, signal)
  const ids = new Set<SkillVersionId>(); let total = 0
  for (const entry of names) {
    if (entry.type !== 'file' || !/^project-[a-f0-9]{64}\.json$/.test(entry.name)) unknown()
    const prior = await client.lstat(root, entry.name, signal)
    if (prior?.type !== 'file' || prior.size === undefined || prior.size > input.limits.maxRecordBytes) unknown()
    const bytes = await client.read(root, entry.name, input.limits.maxRecordBytes, signal)
    const after = await client.lstat(root, entry.name, signal)
    if (prior.version !== after?.version || bytes.byteLength !== prior.size) unknown()
    let value: RecordValue
    try { value = parseRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), input) } catch (cause) { unknown(cause) }
    if (entry.name !== file(value.workspaceId)) unknown()
    for (const copy of value.copies) ids.add(copy.source.id)
    if (value.pending !== null) ids.add(value.pending.id)
    total += bytes.byteLength
    if (total > input.limits.maxMetadataBytes || names.length + 2 > input.limits.maxMetadataInodes) unknown()
  }
  const after = await client.lstat(input.privateRoot, 'skill-working-copies', signal)
  if (after?.version !== before.version) unknown()
  return ids
}
