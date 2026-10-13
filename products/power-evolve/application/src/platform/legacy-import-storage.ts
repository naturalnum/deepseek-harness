/** Owned candidate storage for detached imports; byte publication never launches an application. */
import { constants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyFileEntry } from './legacy-import-codec.ts'
import { assertLegacyImportPlan, type LegacyImportPlan } from './legacy-import-preflight.ts'
import { verifyPublishedSkillPackage } from './skill-package-manifest.ts'

/** Detached packet payload and an exclusively new candidate root; ownership translation is explicit. */
export interface LegacyStorageOptions {
  readonly bundleRoot: string
  readonly candidateRoot: string
  readonly sourceUid: number
  readonly sourceGid: number
  readonly targetUid: number
  readonly targetGid: number
}
/** Configurable roots returned for later reviewed Profile binding. */
export interface LegacyCandidateRoots {
  readonly workspaceRoot: string
  readonly sandboxLocalRoot: string
  readonly skillLibraryRoot: string
  readonly officeRoot: string
  readonly attachmentRoot: string
}
/** Private ownership receipt for an unpublished candidate. */
export interface LegacyStorageCandidate {
  readonly root: string
  readonly roots: LegacyCandidateRoots
  readonly ownershipId: string
  readonly packetSha256: string
  readonly files: number
  readonly bytes: string
}
const candidates = new WeakMap<LegacyStorageCandidate, { dev: number; ino: number }>()
function pathParts(path: string, empty = true): string[] {
  if (path === '' && empty) return []
  const parts = path.split('/')
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || Buffer.from(path).toString('utf8') !== path
    || parts.some(part => !part || part === '.' || part === '..')) throw new LegacyImportError('invalid_storage_path')
  return parts
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}
function destination(entry: LegacyFileEntry, plan: LegacyImportPlan): string {
  const parts = pathParts(entry.path), owner = plan.rows.find(row => row.table === 'pe_users' && row.values.id === entry.owner)
  if (!owner || !/^[a-f0-9-]+$/u.test(entry.resource)) throw new LegacyImportError('file_owner_missing')
  const owned = (table: string, column: string) => plan.rows.find(row => row.table === table
    && row.values[column] === entry.resource && row.values.user_id === entry.owner)
  switch (entry.area) {
    case 'workspace':
      if (!owned('pe_storage_spaces', 'root_key')) throw new LegacyImportError('file_space_missing')
      return ['workspaces', entry.resource, ...parts].join('/')
    case 'home':
      if (entry.resource !== entry.owner) throw new LegacyImportError('file_home_owner')
      return ['sandbox', 'homes', entry.owner, ...parts].join('/')
    case 'skill-text': {
      const skill = owned('pe_user_skills', 'id')
      if (!skill || skill.values.kind !== 'text' || parts.length || entry.kind !== 'file') throw new LegacyImportError('text_skill_file_invalid')
      if (entry.sha256 !== skill.values.digest) throw new LegacyImportError('text_skill_digest')
      return ['workspaces', 'extensions', entry.owner, `${entry.resource}.md`].join('/')
    }
    case 'skill-package':
      if (!owned('pe_skill_package_versions', 'archive_digest')) throw new LegacyImportError('file_skill_version_missing')
      if (entry.path === 'archive.zip') return ['legacy-backup', 'skill-archives', entry.owner, entry.resource, 'archive.zip'].join('/')
      return ['skills', 'skill-packages', entry.owner, 'sha256', entry.resource, ...parts].join('/')
    case 'office':
      if (!owned('pe_office_preview_jobs', 'id')) throw new LegacyImportError('file_office_job_missing')
      return ['office', entry.resource, ...parts].join('/')
  }
}
function packageManifest(row: LegacyImportPlan['rows'][number], plan: LegacyImportPlan) {
  const text = row.values.manifest ?? ''
  const parsed = z.object({ schemaVersion: z.literal(1), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative().max(plan.limits.maxFileBytes),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).min(1).max(plan.limits.maxFiles) }).strict()
    .safeParse(legacyJson(text, plan.limits))
  if (!parsed.success || parsed.data.artifactSha256 !== row.values.archive_digest || legacyDigest(text) !== row.values.manifest_digest) {
    throw new LegacyImportError('skill_manifest_invalid')
  }
  const paths = new Set<string>()
  for (const file of parsed.data.files) {
    pathParts(file.path, false)
    if (!file.path.startsWith('skill/') || paths.has(file.path)) throw new LegacyImportError('skill_manifest_path')
    paths.add(file.path)
  }
  if (!parsed.data.files.some(file => file.path === 'skill/SKILL.md' && file.sha256 === row.values.instruction_digest)) {
    throw new LegacyImportError('skill_instruction_missing')
  }
  return parsed.data.files
}
function skillInventory(plan: LegacyImportPlan): void {
  for (const row of plan.rows) {
    if (row.table === 'pe_user_skills' && row.values.kind === 'text'
      && !plan.files.some(entry => entry.area === 'skill-text' && entry.owner === row.values.user_id && entry.resource === row.values.id)) {
      throw new LegacyImportError('text_skill_bytes_missing')
    }
    if (row.table !== 'pe_skill_package_versions') continue
    const files = packageManifest(row, plan), entries = plan.files.filter(entry => entry.area === 'skill-package'
      && entry.owner === row.values.user_id && entry.resource === row.values.archive_digest)
    const expected = new Map<string, { kind: 'file' | 'directory'; bytes?: string; sha256?: string }>([
      ['', { kind: 'directory' }], ['skill', { kind: 'directory' }],
      ['manifest.json', { kind: 'file', bytes: String(Buffer.byteLength(row.values.manifest ?? '')), sha256: row.values.manifest_digest ?? '' }],
    ])
    for (const file of files) {
      expected.set(file.path, { kind: 'file', bytes: String(file.size), sha256: file.sha256 })
      let parent = dirname(file.path)
      while (parent !== '.') { expected.set(parent, { kind: 'directory' }); parent = dirname(parent) }
    }
    for (const [path, file] of expected) {
      const actual = entries.find(entry => entry.path === path)
      if (!actual || actual.kind !== file.kind || file.kind === 'file' && (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)) {
        throw new LegacyImportError('skill_package_inventory_missing')
      }
    }
    for (const entry of entries) {
      if (entry.path === 'archive.zip') {
        if (entry.kind !== 'file' || entry.sha256 !== row.values.archive_digest || entry.bytes !== row.values.archive_size) {
          throw new LegacyImportError('skill_original_archive_changed')
        }
      } else if (!expected.has(entry.path)) throw new LegacyImportError('skill_package_inventory_extra')
    }
  }
}
function filePlan(plan: LegacyImportPlan, options: LegacyStorageOptions) {
  assertLegacyImportPlan(plan)
  skillInventory(plan)
  const ownership = [options.sourceUid, options.sourceGid, options.targetUid, options.targetGid]
  if (!ownership.every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new LegacyImportError('invalid_storage_ownership')
  }
  const names = new Set<string>(), destinations = new Map<LegacyFileEntry, string>()
  let bytes = 0n
  for (const entry of plan.files) {
    const path = destination(entry, plan), alias = path.normalize('NFKC').toLowerCase()
    if (names.has(alias)) throw new LegacyImportError('storage_path_collision')
    names.add(alias); destinations.set(entry, path)
    if (entry.uid !== options.sourceUid || entry.gid !== options.sourceGid) throw new LegacyImportError('source_ownership_unmapped')
    if (entry.kind === 'directory') {
      if (entry.sourcePath !== null || entry.bytes !== null || entry.sha256 !== null) throw new LegacyImportError('directory_payload')
    } else {
      if (!entry.sourcePath || !entry.bytes || !entry.sha256 || !/^(?:0|[1-9]\d*)$/u.test(entry.bytes)) throw new LegacyImportError('file_payload_missing')
      pathParts(entry.sourcePath, false)
      const length = BigInt(entry.bytes)
      if (length > BigInt(plan.limits.maxFileBytes)) throw new LegacyImportError('file_bytes_limit')
      bytes += length
    }
  }
  if (bytes > BigInt(plan.limits.maxStorageBytes)) throw new LegacyImportError('storage_bytes_limit')
  const roots = plan.files.filter(entry => entry.kind === 'directory' && entry.path === '')
  for (const row of plan.rows) {
    if (row.table === 'pe_storage_spaces' && !roots.some(entry => entry.area === 'workspace' && entry.owner === row.values.user_id && entry.resource === row.values.root_key)) {
      throw new LegacyImportError('ready_space_bytes_missing')
    }
    if (row.table === 'pe_users' && !roots.some(entry => entry.area === 'home' && entry.owner === row.values.id && entry.resource === row.values.id)) {
      throw new LegacyImportError('home_inventory_missing')
    }
  }
  for (const row of plan.rows) if (row.table === 'pe_workspace_bindings') {
    const space = plan.rows.find(space => space.table === 'pe_storage_spaces' && space.values.id === row.values.space_id)
    if (!space || !plan.files.some(entry => entry.area === 'workspace' && entry.owner === row.values.user_id
      && entry.resource === space.values.root_key && entry.kind === 'directory' && entry.path === row.values.root_relative_path)) {
      throw new LegacyImportError('ready_binding_bytes_missing')
    }
  }
  for (const entry of plan.files) if (entry.area !== 'skill-text') {
    const parts = pathParts(entry.path)
    while (parts.length) {
      parts.pop()
      if (!plan.files.some(parent => parent.area === entry.area && parent.owner === entry.owner && parent.resource === entry.resource
        && parent.kind === 'directory' && parent.path === parts.join('/'))) throw new LegacyImportError('directory_inventory_missing')
    }
  }
  for (const [entry, path] of destinations) for (const [other, otherPath] of destinations) {
    if (entry.kind === 'file' && other !== entry && otherPath.startsWith(`${path}/`)) throw new LegacyImportError('file_directory_collision')
  }
  return { destinations, bytes }
}
async function sourceBytes(root: string, entry: LegacyFileEntry, maximum: number): Promise<Buffer> {
  const parts = pathParts(entry.sourcePath ?? '', false)
  let path = root
  for (const part of parts) {
    path = join(path, part)
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw new LegacyImportError('linked_or_special_payload')
  }
  if (!within(root, await realpath(path))) throw new LegacyImportError('payload_escape')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum || BigInt(before.size) !== BigInt(entry.bytes ?? '')) {
      throw new LegacyImportError('payload_size_or_links')
    }
    const buffer = await file.readFile()
    const after = await file.stat(), current = await lstat(path)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()
      || BigInt(buffer.length) !== BigInt(entry.bytes ?? '') || legacyDigest(buffer) !== entry.sha256) throw new LegacyImportError('payload_changed')
    return buffer
  } finally { await file.close() }
}
/** Verify a detached packet's byte inventory without creating candidate storage.
 * @param plan Issued complete relation plan.
 * @param options Explicit roots and ownership mapping.
 * @returns Completion after every declared payload, ready root and binding has been checked.
 */
export async function verifyLegacyStorage(plan: LegacyImportPlan, options: LegacyStorageOptions): Promise<void> {
  filePlan(plan, options)
  if (!isAbsolute(options.bundleRoot) || !isAbsolute(options.candidateRoot)) throw new LegacyImportError('relative_storage_root')
  const root = await realpath(options.bundleRoot), stat = await lstat(options.bundleRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new LegacyImportError('invalid_bundle_root')
  const parent = await realpath(dirname(options.candidateRoot)), target = join(parent, resolve(options.candidateRoot).split(sep).at(-1) ?? '')
  if (within(root, target) || within(target, root)) throw new LegacyImportError('overlapping_storage_roots')
  try { await lstat(options.candidateRoot); throw new LegacyImportError('nonempty_candidate_storage') }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  for (const entry of plan.files) if (entry.kind === 'file') await sourceBytes(root, entry, plan.limits.maxFileBytes)
}
/** Exclusively stage verified regular files and directories in a new unpublished candidate.
 * @param plan Issued import plan.
 * @param options Explicit detached and candidate storage roots.
 * @returns Ownership receipt; failure removes only this newly created candidate.
 */
export async function stageLegacyStorage(plan: LegacyImportPlan, options: LegacyStorageOptions): Promise<LegacyStorageCandidate> {
  await verifyLegacyStorage(plan, options)
  const { destinations, bytes } = filePlan(plan, options), bundleRoot = await realpath(options.bundleRoot)
  const requestedRoot = resolve(options.candidateRoot), ownershipId = randomUUID()
  await mkdir(requestedRoot, { mode: 0o700 })
  const root = await realpath(requestedRoot)
  const stat = await lstat(root)
  const candidate: LegacyStorageCandidate = Object.freeze({ root, roots: Object.freeze({ workspaceRoot: join(root, 'workspaces'),
    sandboxLocalRoot: join(root, 'sandbox'), skillLibraryRoot: join(root, 'skills'), officeRoot: join(root, 'office'),
    attachmentRoot: join(root, 'attachments') }), ownershipId, packetSha256: plan.packetSha256,
  files: plan.files.filter(entry => entry.kind === 'file').length, bytes: String(bytes) })
  candidates.set(candidate, { dev: stat.dev, ino: stat.ino })
  try {
    await writeLegacyStorageReceipt(candidate, 'prepared')
    for (const [entry, path] of [...destinations].sort((a, b) => a[1].split('/').length - b[1].split('/').length)) {
      const target = join(root, ...pathParts(path))
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      if (entry.kind === 'directory') await mkdir(target, { recursive: true, mode: 0o700 })
      else {
        const bytes = await sourceBytes(bundleRoot, entry, plan.limits.maxFileBytes)
        const file = await open(target, 'wx', 0o600)
        try { await file.writeFile(bytes); await file.sync() }
        finally { await file.close() }
      }
    }
    for (const [entry, path] of [...destinations].reverse()) {
      const target = join(root, ...pathParts(path))
      await chown(target, options.targetUid, options.targetGid); await chmod(target, entry.mode)
      const current = await lstat(target)
      if ((current.mode & 0o777) !== entry.mode || current.uid !== options.targetUid || current.gid !== options.targetGid) {
        throw new LegacyImportError('target_permissions_changed')
      }
      if (entry.kind === 'file') await sourceBytes(root, { ...entry, sourcePath: path }, plan.limits.maxFileBytes)
    }
    for (const row of plan.rows) if (row.table === 'pe_skill_package_versions') {
      await verifyPublishedSkillPackage(join(candidate.roots.skillLibraryRoot, 'skill-packages', row.values.user_id ?? '',
        'sha256', row.values.archive_digest ?? ''), row.values.manifest ?? '', packageManifest(row, plan))
    }
    return candidate
  } catch (error) {
    await discardLegacyStorage(candidate)
    throw error
  }
}
/** Atomically persist a candidate's private progress without changing business facts.
 * @param candidate Exclusively owned unpublished root.
 * @param phase Prepared, committed, complete or unresolved failure phase.
 * @returns Completion after receipt and parent directory have been synced.
 */
export async function writeLegacyStorageReceipt(candidate: LegacyStorageCandidate, phase: string): Promise<void> {
  const original = candidates.get(candidate), current = await lstat(candidate.root)
  if (!original || current.dev !== original.dev || current.ino !== original.ino || current.isSymbolicLink()) throw new LegacyImportError('candidate_ownership_lost')
  const temporary = join(candidate.root, `.import-${randomUUID()}`), destination = join(candidate.root, 'legacy-import-receipt.json')
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify({ format: 1, ownershipId: candidate.ownershipId, packetSha256: candidate.packetSha256,
    phase, files: candidate.files, bytes: candidate.bytes }) + '\n'); await file.sync() }
  finally { await file.close() }
  await rename(temporary, destination)
  const directory = await open(candidate.root, constants.O_RDONLY)
  try { await directory.sync() }
  finally { await directory.close() }
}
/** Remove only a candidate whose inode still matches this operation's exclusive receipt.
 * @param candidate Newly created unpublished storage owned by this module.
 * @returns Completion after owned deletion; replacement roots are preserved and rejected.
 */
export async function discardLegacyStorage(candidate: LegacyStorageCandidate): Promise<void> {
  const expected = candidates.get(candidate), actual = await lstat(candidate.root)
  if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.isSymbolicLink()) throw new LegacyImportError('candidate_ownership_lost')
  await rm(candidate.root, { recursive: true }); candidates.delete(candidate)
}
