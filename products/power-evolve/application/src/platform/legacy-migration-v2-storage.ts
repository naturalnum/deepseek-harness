/** Exclusively owned detached business-file candidates; attachment object aliases use their maintained separate adapter. */
import { constants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { LegacyImportError, legacyDigest, type LegacyFileEntry } from './legacy-import-codec.ts'
import type { LegacyStorageOptions, LegacyCandidateRoots } from './legacy-import-storage.ts'

/** Explicit observed original POSIX owners; per-entry UID/GID remains authenticated in the source file inventory. */
export interface LegacyMigrationStorageOptions extends LegacyStorageOptions {
  readonly sourceOwners?: readonly { readonly uid: number; readonly gid: number }[]
}
import { assertLegacyMigrationPlan, type LegacyMigrationPlan } from './legacy-migration-v2-plan.ts'
import { verifyLegacyMigrationSkillPackages } from './legacy-migration-v2-storage-owners.ts'

/** New candidate identity and runtime roots; only this process's actual inode can be removed. */
export interface LegacyMigrationStorage {
  readonly root: string
  readonly ownershipId: string
  readonly roots: LegacyCandidateRoots
  readonly migrationId: string
}
const ownership = new WeakMap<LegacyMigrationStorage, {
  dev: bigint
  ino: bigint
}>()
const fileEntry = z.object({ area: z.enum(['workspace', 'home', 'skill-text', 'skill-package', 'office']),
  owner: z.uuid(), resource: z.string().min(1), path: z.string(), kind: z.enum(['file', 'directory']),
  sourcePath: z.string().nullable(), bytes: z.string().nullable(), sha256: z.string().nullable(),
  mode: z.number().int().min(0).max(0o777), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative() }).strict()
function safeRelative(path: string, allowEmpty = false): void {
  if (allowEmpty && path === '') return
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || Buffer.from(path).toString('utf8') !== path
    || path.split('/').some(part => !part || part === '.' || part === '..')) throw new LegacyImportError('migration_file_path')
}
function fileDestination(entry: LegacyFileEntry, plan: LegacyMigrationPlan): string {
  safeRelative(entry.path, true)
  if (entry.resource.includes('/') || entry.resource.includes('\\') || entry.resource === '.' || entry.resource === '..'
    || Buffer.from(entry.resource).toString('utf8') !== entry.resource || entry.resource.includes('\0')) {
    throw new LegacyImportError('migration_file_resource')
  }
  if (!plan.rows.some(row => row.table === 'pe_users' && row.values.id === entry.owner)) throw new LegacyImportError('migration_file_owner')
  const owned = (table: string, column: string) => plan.rows.find(row => row.table === table
    && row.values.user_id === entry.owner && row.values[column] === entry.resource)
  switch (entry.area) {
    case 'workspace':
      if (!owned('pe_storage_spaces', 'root_key')) throw new LegacyImportError('migration_file_space')
      return join('workspaces', entry.resource, entry.path)
    case 'home':
      if (entry.resource !== entry.owner) throw new LegacyImportError('migration_file_home')
      return join('sandbox', 'homes', entry.owner, entry.path)
    case 'skill-text':
      if (!owned('pe_user_skills', 'id') || entry.path !== '' || entry.kind !== 'file') throw new LegacyImportError('migration_skill_file')
      return join('workspaces', 'extensions', entry.owner, `${entry.resource}.md`)
    case 'skill-package':
      if (!owned('pe_skill_package_versions', 'archive_digest')) throw new LegacyImportError('migration_skill_version')
      return join('skills', 'skill-packages', entry.owner, 'sha256', entry.resource, entry.path)
    case 'office':
      if (!owned('pe_office_preview_jobs', 'id')) throw new LegacyImportError('migration_office_file')
      return join('office', entry.resource, entry.path)
  }
}
async function sourceFile(bundleRoot: string, sourcePath: string): Promise<string> {
  safeRelative(sourcePath)
  const root = await realpath(resolve(bundleRoot))
  if (!isAbsolute(bundleRoot) || (await lstat(bundleRoot)).isSymbolicLink()) throw new LegacyImportError('migration_bundle_root')
  const path = join(root, sourcePath)
  let cursor = dirname(path)
  while (cursor !== root) {
    const value = await lstat(cursor)
    if (!value.isDirectory() || value.isSymbolicLink()) throw new LegacyImportError('migration_file_ancestor')
    cursor = dirname(cursor)
  }
  return path
}

/** Validate the complete original business-file selection before creating a target candidate.
 * @param plan Issued fixed-schema2 relation/file plan.
 * @param options Explicit detached/candidate roots and source/target ownership mapping.
 * @returns Completion only for complete ready-root inventories and verified ordinary original file descriptors.
 */
export async function verifyLegacyMigrationStorage(plan: LegacyMigrationPlan, options: LegacyMigrationStorageOptions): Promise<void> {
  assertLegacyMigrationPlan(plan)
  if (!isAbsolute(options.candidateRoot) || !isAbsolute(options.bundleRoot)
    || (await lstat(dirname(options.candidateRoot))).isSymbolicLink()) throw new LegacyImportError('migration_candidate_root')
  const physicalCandidate = join(await realpath(dirname(options.candidateRoot)), basename(options.candidateRoot))
  const suffix = relative(await realpath(options.bundleRoot), physicalCandidate)
  if (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)) throw new LegacyImportError('migration_roots_overlap')
  if (plan.files.length > plan.limits.maxFiles) throw new LegacyImportError('migration_file_count')
  const aliases = new Set<string>()
  let total = 0n
  for (const input of plan.files) {
    const entry = fileEntry.parse(input), destination = fileDestination(entry, plan)
    const alias = destination.normalize('NFC').toLowerCase()
    if (aliases.has(alias)) throw new LegacyImportError('migration_file_alias')
    aliases.add(alias)
    const owners = options.sourceOwners ?? [{ uid: options.sourceUid, gid: options.sourceGid }]
    if (!owners.length || owners.some(owner => !Number.isSafeInteger(owner.uid) || owner.uid < 0
      || !Number.isSafeInteger(owner.gid) || owner.gid < 0)
      || !owners.some(owner => entry.uid === owner.uid && entry.gid === owner.gid)) throw new LegacyImportError('migration_file_uid')
    if (entry.kind === 'directory') {
      if (entry.sourcePath !== null || entry.bytes !== null || entry.sha256 !== null) throw new LegacyImportError('migration_directory_entry')
      continue
    }
    if (entry.sourcePath === null || entry.bytes === null || !/^(?:0|[1-9][0-9]*)$/u.test(entry.bytes)
      || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')) throw new LegacyImportError('migration_file_entry')
    total += BigInt(entry.bytes)
    if (BigInt(entry.bytes) > BigInt(plan.limits.maxFileBytes) || total > BigInt(plan.limits.maxStorageBytes)) {
      throw new LegacyImportError('migration_file_bytes')
    }
    const path = await sourceFile(options.bundleRoot, entry.sourcePath)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size !== Number(entry.bytes)
        || before.uid !== entry.uid || before.gid !== entry.gid || (before.mode & 0o777) !== entry.mode) {
        throw new LegacyImportError('migration_file_stat')
      }
      if (legacyDigest(await handle.readFile()) !== entry.sha256) throw new LegacyImportError('migration_file_digest')
      const after = await handle.stat(), linked = await lstat(path)
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || linked.dev !== before.dev || linked.ino !== before.ino) throw new LegacyImportError('migration_file_changed')
    } finally { await handle.close() }
  }
  for (const row of plan.rows) {
    if (row.table === 'pe_storage_spaces' && !plan.files.some(file => file.area === 'workspace' && file.kind === 'directory'
      && file.owner === row.values.user_id && file.resource === row.values.root_key && file.path === '')) {
      throw new LegacyImportError('migration_ready_root_missing')
    }
  }
  for (const entry of plan.files) {
    if (entry.area === 'skill-text') continue
    const parts = entry.path.split('/').filter(Boolean)
    for (let count = 0; count < parts.length; count++) {
      if (!plan.files.some(parent => parent.area === entry.area && parent.owner === entry.owner && parent.resource === entry.resource
        && parent.kind === 'directory' && parent.path === parts.slice(0, count).join('/'))) throw new LegacyImportError('migration_file_parent_missing')
    }
  }
}

/** Copy only into a fresh owned candidate, preserving original business bytes and declared target ownership.
 * @param plan Issued complete relation/file plan.
 * @param options Explicit source/target roots and ownership.
 * @returns Registered owned root; a failed copy removes only its actual allocated inode.
 */
export async function stageLegacyMigrationStorage(plan: LegacyMigrationPlan,
  options: LegacyMigrationStorageOptions): Promise<LegacyMigrationStorage> {
  await verifyLegacyMigrationStorage(plan, options)
  const root = join(await realpath(dirname(options.candidateRoot)), basename(options.candidateRoot))
  await mkdir(root, { mode: 0o700 })
  const stat = await lstat(root, { bigint: true })
  const candidate = Object.freeze({ root, ownershipId: randomUUID(), migrationId: plan.migrationId,
    roots: Object.freeze({ workspaceRoot: join(root, 'workspaces'), sandboxLocalRoot: join(root, 'sandbox'),
      skillLibraryRoot: join(root, 'skills'), officeRoot: join(root, 'office'), attachmentRoot: join(root, 'attachments') }) })
  ownership.set(candidate, { dev: stat.dev, ino: stat.ino })
  try {
    for (const directory of Object.values(candidate.roots)) await mkdir(directory, { mode: 0o700 })
    const ordered = [...plan.files].sort((left, right) => left.path.split('/').length - right.path.split('/').length)
    for (const entry of ordered) {
      const destination = join(root, fileDestination(entry, plan))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      if (entry.kind === 'directory') await mkdir(destination, { recursive: true, mode: 0o700 })
      else {
        const source = await open(await sourceFile(options.bundleRoot, entry.sourcePath ?? ''), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const data = await source.readFile()
          if (data.byteLength !== Number(entry.bytes) || legacyDigest(data) !== entry.sha256) throw new LegacyImportError('migration_file_changed')
          await writeFile(destination, data, { flag: 'wx', mode: entry.mode })
        } finally { await source.close() }
      }
      if (entry.kind === 'file') await chmod(destination, entry.mode)
    }
    await verifyLegacyMigrationSkillPackages(candidate.roots.skillLibraryRoot, plan.rows, plan.limits)
    for (const entry of ordered.toReversed()) {
      const destination = join(root, fileDestination(entry, plan))
      if (entry.kind === 'directory') await chmod(destination, entry.mode)
      if (options.targetUid !== process.getuid?.() || options.targetGid !== process.getgid?.()) {
        await chown(destination, options.targetUid, options.targetGid)
      }
    }
    return candidate
  } catch (error) { await discardLegacyMigrationStorage(candidate); throw error }
}

/** Record a private stage receipt only in the registered candidate.
 * @param candidate Actual registered target root.
 * @param phase Explicit lifecycle outcome.
 * @param facts Secret-free row/object/digest facts; original private cells belong in the protected capture archive.
 * @returns Completion after atomic receipt replacement.
 */
export async function writeLegacyMigrationReceipt(candidate: LegacyMigrationStorage, phase: string, facts: object): Promise<void> {
  const expected = ownership.get(candidate), actual = await lstat(candidate.root, { bigint: true })
  if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino || !actual.isDirectory()) {
    throw new LegacyImportError('migration_candidate_ownership')
  }
  const temporary = join(candidate.root, `.receipt-${randomUUID()}`)
  await writeFile(temporary, JSON.stringify({ version: 2, migrationId: candidate.migrationId,
    ownershipId: candidate.ownershipId, phase, facts }) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temporary, join(candidate.root, 'migration-receipt.json'))
}

/** Remove an uncommitted candidate only when its registered inode still belongs to this invocation.
 * @param candidate Registered candidate from this process.
 * @returns Completion after removing only that exact new root.
 */
export async function discardLegacyMigrationStorage(candidate: LegacyMigrationStorage): Promise<void> {
  const expected = ownership.get(candidate), actual = await lstat(candidate.root, { bigint: true })
  if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new LegacyImportError('migration_candidate_ownership')
  const writableDirectories = async (path: string): Promise<void> => {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(path, 0o700)
    for (const name of await readdir(path)) await writableDirectories(join(path, name))
  }
  await writableDirectories(candidate.root)
  await rm(candidate.root, { recursive: true })
  ownership.delete(candidate)
}
