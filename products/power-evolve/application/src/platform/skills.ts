/** Per-user skill catalog; executable package bytes stay outside the shared Host. */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { deviceMaterialBinding, deviceMaterialSelection, deviceSkillManifest, deviceSkillMaterial,
  type DeviceMaterialBinding, type DeviceSkillMaterial } from '@power-evolve/contracts/device-execution'
import { PlatformError, type Identity, type skillSelection } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireActiveAccount } from './account-authority.ts'
import { accountUserId } from '../account-contracts.ts'
import { extractSkillPackage, MAX_ARCHIVE_BYTES, type ExtractedSkillFile } from './skill-package-extraction.ts'
import { readNativeSkillMetadata } from './skill-metadata.ts'
import { skillPackageManifest, skillPackageVersion, verifyPublishedSkillPackage } from './skill-package-manifest.ts'
import { BuiltinSkillCatalog, type BuiltinSkillRelease } from './builtin-skills.ts'
import { publishReportSuite, type ReportSuiteSource } from './report-skill-suite.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const TICKET_LIFETIME_MS = 5 * 60_000
const MANIFEST_MAX_BYTES = 128 * 1024
const RESOURCE_MAX_BYTES = 256 * 1024
const REPORT_SKILLS = [
  { id: 'builtin.report-workflow-orchestrator', folder: 'report-workflow-orchestrator' },
  { id: 'builtin.power-grid-technical-report-writer', folder: 'power-grid-technical-report-writer' },
  { id: 'builtin.report-reviewer', folder: 'report-reviewer' },
  { id: 'builtin.tech-report-writer', folder: 'tech-report-writer' },
] as const

type Selection = z.infer<typeof skillSelection>
type SkillResource = { kind: 'list'; files: { path: string; size: number; sha256: string }[] }
  | { kind: 'text'; path: string; text: string; sha256: string }

interface SkillRow {
  id: string
  userId: string
  name: string
  description: string
  digest: string
  enabled: boolean
  revision: number
  kind: 'text' | 'package'
  revokedAt: Date | null
  packageVersionId: string | null
  version: string | null
  packageDigest: string | null
  manifestDigest: string | null
  manifest: string | null
}

interface PackageVersionRow {
  id: string
  user_id: string
  skill_id: string
  name: string
  description: string
  version: string
  archive_digest: string
  archive_size: number
  instruction_digest: string
  manifest_digest: string
  manifest: string
}

interface UploadIntentRow {
  request_id: string
  user_id: string
  size_bytes: number
  archive_digest: string
  token_digest: string | null
  expires_at: Date | null
  consumed_at: Date | null
}

interface BuiltinInstallRequestRow {
  request_id: string
  user_id: string
  catalog_id: string
  version: string
  archive_digest: string
  package_version_id: string
}

interface PreparedPackage {
  unpacked: string
  files: readonly ExtractedSkillFile[]
  metadata: { name: string; description: string }
  version: string
  manifest: string
  manifestDigest: string
  instructionDigest: string
}

const skillColumns = `s.id,s.user_id AS "userId",s.name,s.description,s.digest,s.enabled,s.revision,s.kind,
  s.revoked_at AS "revokedAt",s.package_version_id AS "packageVersionId",v.version,
  v.archive_digest AS "packageDigest",v.manifest_digest AS "manifestDigest",v.manifest`
const skillJoin = 'pe_user_skills s LEFT JOIN pe_skill_package_versions v ON v.id=s.package_version_id'

function hash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

function resourcePath(path: string): string {
  if (path.length < 1 || path.length > 1024 || path.startsWith('/') || /[\0\\:]/u.test(path)
    || path.split('/').some(part => part === '' || part === '.' || part === '..'))
    throw new PlatformError(400, 'invalid_skill_resource_path')
  return path
}

function builtinRequestId(userId: string, catalogId: string, version: string): string {
  const bytes = createHash('sha256').update(`pe-builtin\0${userId}\0${catalogId}\0${version}`).digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function publicItem(row: SkillRow): Record<string, unknown> {
  return { skillId: row.id, name: row.name, description: row.description, kind: row.kind,
    version: row.version, digest: row.digest, packageDigest: row.packageDigest,
    manifestDigest: row.manifestDigest, enabled: row.enabled && row.revokedAt === null,
    revision: row.revision, observedState: row.revokedAt === null ? 'ready' : 'revoked' }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function realDirectory(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PlatformError(503, 'skill_library_unavailable')
  await chmod(path, mode)
}

async function removeStage(path: string): Promise<void> {
  const writable = async (directory: string): Promise<void> => {
    let stat
    try { stat = await lstat(directory) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name))
    }
  }
  await writable(path)
  await rm(path, { recursive: true, force: true })
}

function manifestFiles(manifest: string, expectedArchive: string): ExtractedSkillFile[] {
  if (Buffer.byteLength(manifest) > MANIFEST_MAX_BYTES) throw new PlatformError(503, 'skill_package_unavailable')
  let document: unknown
  try { document = JSON.parse(manifest) }
  catch { throw new PlatformError(503, 'skill_package_unavailable') }
  const parsed = z.object({ schemaVersion: z.literal(1), artifactSha256: z.string().regex(SHA256),
    files: z.array(z.object({ path: z.string(), size: z.number().int().min(0).max(8 * 1024 * 1024),
      sha256: z.string().regex(SHA256) }).strict()).min(1).max(256),
  }).strict().safeParse(document)
  if (!parsed.success || parsed.data.artifactSha256 !== expectedArchive
    || !parsed.data.files.some(file => file.path === 'skill/SKILL.md')
    || parsed.data.files.some(file => !file.path.startsWith('skill/')
      || file.path.split('/').some(part => part === '' || part === '.' || part === '..')
      || /[\\:]/u.test(file.path))) throw new PlatformError(503, 'skill_package_unavailable')
  return parsed.data.files
}

/** Skill content is never imported or executed in this process. */
export class SkillService {
  private readonly textRoot: string
  private readonly packageRoot: string | null
  private readonly builtinCatalog: BuiltinSkillCatalog

  constructor(private readonly pool: Pool, workspaceRoot: string, sandboxLocalRoot = '',
    private readonly maxSkillsPerUser = 64) {
    if (!Number.isInteger(maxSkillsPerUser) || maxSkillsPerUser < 1 || maxSkillsPerUser > 256)
      throw new RangeError('maxSkillsPerUser must be an integer from 1 to 256')
    this.textRoot = join(resolve(workspaceRoot), 'extensions')
    this.packageRoot = sandboxLocalRoot ? join(resolve(sandboxLocalRoot), 'skill-packages') : null
    this.builtinCatalog = new BuiltinSkillCatalog()
  }

  /** Prepare the configured private content and staging directories before accepting skill operations.
   * Rejects filesystem entries that are not real directories; package storage remains unavailable when unconfigured.
   */
  async init(): Promise<void> {
    await realDirectory(this.textRoot, 0o700)
    if (this.packageRoot !== null) {
      await realDirectory(this.packageRoot, 0o700)
      await realDirectory(join(this.packageRoot, '.staging'), 0o700)
    }
  }

  private async textUserRoot(userId: string): Promise<string> {
    const path = join(this.textRoot, userId)
    await realDirectory(path, 0o700)
    return path
  }

  private async packageUserRoot(userId: string): Promise<string> {
    if (this.packageRoot === null) throw new PlatformError(503, 'skill_package_unavailable')
    const path = join(this.packageRoot, userId)
    await realDirectory(path, 0o755)
    await realDirectory(join(path, 'sha256'), 0o755)
    return path
  }

  private async textContent(userId: string, id: string, digest: string): Promise<string> {
    const file = await open(join(await this.textUserRoot(userId), `${id}.md`), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 16_384) throw new PlatformError(503, 'skill_unavailable')
      const body = await file.readFile({ encoding: 'utf8' })
      if (hash(body) !== digest) throw new PlatformError(503, 'skill_unavailable')
      return body
    } finally { await file.close() }
  }

  private async packageContent(userId: string, archiveDigest: string, manifestDigest: string,
    instructionDigest: string, manifest: string): Promise<string> {
    if (!SHA256.test(archiveDigest) || hash(manifest) !== manifestDigest) throw new PlatformError(503, 'skill_package_unavailable')
    const files = manifestFiles(manifest, archiveDigest)
    const expected = files.find(file => file.path === 'skill/SKILL.md')!
    if (expected.sha256 !== instructionDigest) throw new PlatformError(503, 'skill_package_unavailable')
    const packagePath = join(await this.packageUserRoot(userId), 'sha256', archiveDigest)
    await verifyPublishedSkillPackage(packagePath, manifest, files)
    const file = await open(join(packagePath, 'skill', 'SKILL.md'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { return await file.readFile({ encoding: 'utf8' }) } finally { await file.close() }
  }

  /** List this owner's current skill metadata without reading instruction or package bytes.
   * @param user Owner authenticated by the route.
   * @returns Name-ordered metadata, including disabled and revoked skills.
   */
  async list(user: Identity): Promise<{ items: Record<string, unknown>[] }> {
    const result = await this.pool.query<SkillRow>(
      `SELECT ${skillColumns} FROM ${skillJoin} WHERE s.user_id=$1 ORDER BY s.name,s.id`, [user.userId])
    return { items: result.rows.map(publicItem) }
  }

  /** Public fixed-catalog metadata plus this user's current matching package version.
   * @param user Authenticated owner whose installed versions are compared with the catalog.
   * @returns Published releases with a matching installed skill identity, or null when no version matches.
   */
  async catalog(user: Identity): Promise<{ items: (BuiltinSkillRelease & { installedSkillId: string | null })[] }> {
    const releases = await this.builtinCatalog.list()
    const installed = await this.pool.query<{ skill_id: string; archive_digest: string; version: string }>(
      `SELECT s.id AS skill_id,v.archive_digest,v.version FROM pe_user_skills s
       JOIN pe_skill_package_versions v ON v.id=s.package_version_id
       WHERE s.user_id=$1`, [user.userId])
    const byVersion = new Map(installed.rows.map(row => [`${row.archive_digest}:${row.version}`, row.skill_id]))
    return { items: releases.map(release => ({ ...release,
      installedSkillId: byVersion.get(`${release.archiveDigest}:${release.version}`) ?? null })) }
  }

  /** Read an owned skill's current instructions, including disabled or revoked metadata.
   * @param user Owner authenticated by the route.
   * @param id Owned skill identity; absent or foreign skills are reported as skill_not_found.
   * @returns Current public metadata and digest-verified instructions; unavailable content rejects the read.
   */
  async read(user: Identity, id: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<SkillRow>(
      `SELECT ${skillColumns} FROM ${skillJoin} WHERE s.id=$1 AND s.user_id=$2`, [id, user.userId])
    const skill = result.rows[0]
    if (!skill) throw new PlatformError(404, 'skill_not_found')
    const instructions = skill.kind === 'text'
      ? await this.textContent(user.userId, id, skill.digest)
      : await this.packageContent(user.userId, skill.packageDigest!, skill.manifestDigest!, skill.digest, skill.manifest!)
    return { ...publicItem(skill), instructions }
  }

  /** Persist a private text skill for an active account; identical identity and content retries reuse its record.
   * Instruction bytes are synchronized before metadata commits. Conflicting identities, names, or capacity reject installation.
   * @param user Authenticated owner, rechecked inside the transaction.
   * @param id Stable installation identity, also used as the new skill identity.
   * @param name Validated owner-local skill name.
   * @param description Validated catalog description to persist with the instructions.
   * @param instructions Exact validated text whose digest fixes retry identity.
   * @returns Metadata for the newly installed or identical previously installed text skill.
   */
  async install(user: Identity, id: string, name: string, description: string, instructions: string): Promise<Record<string, unknown>> {
    const digest = hash(instructions)
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const prior = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin} WHERE s.id=$1`, [id])
      if (prior.rows[0]) {
        const skill = prior.rows[0]
        if (skill.userId !== user.userId || skill.kind !== 'text'
          || skill.name !== name || skill.description !== description || skill.digest !== digest)
          throw new PlatformError(409, 'request_id_conflict')
        return publicItem(skill)
      }
      const conflict = await client.query('SELECT id FROM pe_user_skills WHERE user_id=$1 AND name=$2', [user.userId, name])
      if (conflict.rowCount) throw new PlatformError(409, 'skill_name_conflict')
      const count = await client.query<{ n: string }>('SELECT count(*) AS n FROM pe_user_skills WHERE user_id=$1', [user.userId])
      if (Number(count.rows[0]!.n) >= this.maxSkillsPerUser) throw new PlatformError(413, 'skill_limit')
      const root = await this.textUserRoot(user.userId)
      const temporary = join(root, `.pe-${id}.tmp`)
      await rm(temporary, { force: true })
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(instructions); await file.sync() } finally { await file.close() }
      try { await rename(temporary, join(root, `${id}.md`)); await syncDirectory(root) }
      finally { await rm(temporary, { force: true }) }
      const inserted = await client.query<SkillRow>(
        `INSERT INTO pe_user_skills(id,user_id,name,description,digest) VALUES($1,$2,$3,$4,$5)
         RETURNING id,user_id AS "userId",name,description,digest,enabled,revision,kind,
           revoked_at AS "revokedAt",package_version_id AS "packageVersionId",
           NULL::text AS version,NULL::text AS "packageDigest",NULL::text AS "manifestDigest",NULL::text AS manifest`,
        [id, user.userId, name, description, digest])
      return publicItem(inserted.rows[0]!)
    })
  }

  /** Change selection eligibility for an active owner's skill without rewriting accepted Operation selections.
   * @param user Authenticated owner, rechecked inside the transaction.
   * @param id Owned skill identity; absent or foreign skills are reported as skill_not_found.
   * @param enabled Requested eligibility for future acceptance; revoked skills cannot be enabled.
   * @returns Current metadata, with a new revision only when eligibility changes.
   */
  async toggle(user: Identity, id: string, enabled: boolean): Promise<Record<string, unknown>> {
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const result = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin}
        WHERE s.id=$1 AND s.user_id=$2 FOR UPDATE OF s`, [id, user.userId])
      const skill = result.rows[0]
      if (!skill) throw new PlatformError(404, 'skill_not_found')
      if (skill.revokedAt !== null && enabled) throw new PlatformError(409, 'skill_revoked')
      if (skill.enabled !== enabled) await client.query(
        'UPDATE pe_user_skills SET enabled=$2,revision=revision+1,updated_at=now() WHERE id=$1', [id, enabled])
      const updated = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin} WHERE s.id=$1`, [id])
      return publicItem(updated.rows[0]!)
    })
  }

  /** Permanently revoke an active owner's skill while retaining its historical bytes and accepted selections.
   * @param user Authenticated owner, rechecked inside the transaction.
   * @param id Owned skill identity; absent or foreign skills are reported as skill_not_found.
   * @returns Disabled, revoked metadata; repeated revocation preserves the existing revision and timestamp.
   */
  async revoke(user: Identity, id: string): Promise<Record<string, unknown>> {
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const result = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin}
        WHERE s.id=$1 AND s.user_id=$2 FOR UPDATE OF s`, [id, user.userId])
      if (!result.rows[0]) throw new PlatformError(404, 'skill_not_found')
      if (result.rows[0].revokedAt === null) await client.query(
        'UPDATE pe_user_skills SET revoked_at=now(),enabled=false,revision=revision+1,updated_at=now() WHERE id=$1', [id])
      const updated = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin} WHERE s.id=$1`, [id])
      return publicItem(updated.rows[0]!)
    })
  }

  /** Issue a browser-only bearer ticket without accepting archive bytes into the Host.
   * An identical pending request rotates its ticket; changed bytes or ownership reject the request.
   * @param user Authenticated owner, rechecked inside the transaction.
   * @param requestId Stable upload identity, retained as the immutable package version identity.
   * @param sizeBytes Validated exact archive byte count to enforce during upload.
   * @param sha256 Validated archive digest to enforce during upload and retries.
   * @param platformOrigin Trusted Platform origin used to construct the direct upload URL.
   * @returns Ready metadata for an installed version, or a pending ticket, upload URL, and expiry.
   */
  async issueUploadTicket(user: Identity, requestId: string, sizeBytes: number, sha256: string,
    platformOrigin: string): Promise<Record<string, unknown>> {
    if (this.packageRoot === null) throw new PlatformError(503, 'skill_package_unavailable')
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      await client.query('SELECT pg_advisory_xact_lock(72819532,hashtext($1))', [requestId])
      const prior = await client.query<PackageVersionRow>(
        'SELECT * FROM pe_skill_package_versions WHERE id=$1', [requestId])
      if (prior.rows[0]) {
        const version = prior.rows[0]
        if (version.user_id !== user.userId || version.archive_digest !== sha256 || version.archive_size !== sizeBytes)
          throw new PlatformError(409, 'request_id_conflict')
        return { state: 'ready', item: await this.versionItem(client, version) }
      }
      const occupied = await client.query('SELECT id FROM pe_user_skills WHERE id=$1', [requestId])
      if (occupied.rowCount) throw new PlatformError(409, 'request_id_conflict')
      const builtinRequest = await client.query(
        'SELECT request_id FROM pe_builtin_skill_install_requests WHERE request_id=$1', [requestId])
      if (builtinRequest.rowCount) throw new PlatformError(409, 'request_id_conflict')
      const existing = await client.query<UploadIntentRow>(
        'SELECT * FROM pe_skill_upload_intents WHERE request_id=$1', [requestId])
      const intent = existing.rows[0]
      if (intent && (intent.user_id !== user.userId || intent.size_bytes !== sizeBytes || intent.archive_digest !== sha256))
        throw new PlatformError(409, 'request_id_conflict')
      if (!intent) {
        const pending = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM pe_skill_upload_intents WHERE user_id=$1
           AND consumed_at IS NULL AND expires_at > now()`, [user.userId])
        if (Number(pending.rows[0]!.n) >= 16) throw new PlatformError(429, 'skill_upload_limit')
      }
      const ticket = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + TICKET_LIFETIME_MS)
      const issued = await client.query(`INSERT INTO pe_skill_upload_intents(request_id,user_id,size_bytes,archive_digest,token_digest,expires_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_id) DO UPDATE
        SET token_digest=EXCLUDED.token_digest,expires_at=EXCLUDED.expires_at
        WHERE pe_skill_upload_intents.user_id=EXCLUDED.user_id
          AND pe_skill_upload_intents.size_bytes=EXCLUDED.size_bytes
          AND pe_skill_upload_intents.archive_digest=EXCLUDED.archive_digest
        RETURNING request_id`,
      [requestId, user.userId, sizeBytes, sha256, hash(ticket), expiresAt])
      if (!issued.rowCount) throw new PlatformError(409, 'request_id_conflict')
      return { state: 'pending', ticket, uploadUrl: new URL('/skills/upload', platformOrigin).href,
        expiresAt: expiresAt.toISOString() }
    })
  }

  private async versionItem(client: PoolClient, version: PackageVersionRow): Promise<Record<string, unknown>> {
    const result = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin}
      WHERE s.id=$1 AND s.user_id=$2`, [version.skill_id, version.user_id])
    const skill = result.rows[0]
    if (!skill) throw new PlatformError(503, 'skill_package_unavailable')
    return { ...publicItem(skill), name: version.name, description: version.description,
      kind: 'package', version: version.version, digest: version.instruction_digest,
      packageDigest: version.archive_digest, manifestDigest: version.manifest_digest,
      enabled: skill.packageVersionId === version.id && skill.enabled && skill.revokedAt === null }
  }

  private async preparePackage(stage: string, archiveDigest: string,
    pinnedVersion?: string): Promise<PreparedPackage> {
    const archive = join(stage, 'archive.zip')
    const unpacked = join(stage, 'unpacked')
    await mkdir(unpacked, { mode: 0o700 })
    let files: readonly ExtractedSkillFile[]
    try { files = await extractSkillPackage(archive, unpacked) }
    catch (error) {
      if (error instanceof PlatformError) throw error
      throw new PlatformError(400, 'invalid_skill_package')
    }
    const metadata = await readNativeSkillMetadata(join(unpacked, 'skill'))
    const authoredVersion = await skillPackageVersion(join(unpacked, 'skill'), archiveDigest, files)
    if (pinnedVersion && authoredVersion !== `sha256:${archiveDigest}` && authoredVersion !== pinnedVersion)
      throw new PlatformError(503, 'skill_package_unavailable')
    const version = pinnedVersion ?? authoredVersion
    const manifest = skillPackageManifest(archiveDigest, files)
    if (Buffer.byteLength(manifest) > MANIFEST_MAX_BYTES) throw new PlatformError(400, 'invalid_skill_package')
    const manifestDigest = hash(manifest)
    await writeFile(join(unpacked, 'manifest.json'), manifest, { flag: 'wx', mode: 0o444 })
    await chmod(join(unpacked, 'manifest.json'), 0o444)
    const manifestHandle = await open(join(unpacked, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await manifestHandle.sync() } finally { await manifestHandle.close() }
    const instructionDigest = files.find(file => file.path === 'skill/SKILL.md')!.sha256
    return { unpacked, files, metadata, version, manifest, manifestDigest, instructionDigest }
  }

  /** Install only a pinned, verified built-in archive through the package publisher.
   * The active owner's request is bound to the catalog identity and version; matching retries reuse its installation record.
   * @param user Authenticated owner, rechecked inside the publication transaction.
   * @param requestId Stable installation identity; conflicting reuse is rejected.
   * @param catalogId Published built-in skill identity, never a caller-supplied archive path.
   * @param version Exact published release to install; no latest-version fallback is used.
   * @returns Metadata for the exact installed version; unavailable releases or conflicting private skills reject installation.
   */
  async installBuiltin(user: Identity, requestId: string, catalogId: string,
    version: string): Promise<Record<string, unknown>> {
    if (this.packageRoot === null) throw new PlatformError(503, 'skill_package_unavailable')
    const existingRequest = await this.pool.query<BuiltinInstallRequestRow>(
      'SELECT * FROM pe_builtin_skill_install_requests WHERE request_id=$1', [requestId])
    if (existingRequest.rows[0] && (existingRequest.rows[0].user_id !== user.userId
      || existingRequest.rows[0].catalog_id !== catalogId || existingRequest.rows[0].version !== version))
      throw new PlatformError(409, 'request_id_conflict')
    const release = await this.builtinCatalog.get(catalogId, version)
    if (!release) throw new PlatformError(404, 'builtin_skill_not_found')
    const { archive } = release
    const stage = await mkdtemp(join(this.packageRoot, '.staging', 'pe-'))
    try {
      await writeFile(join(stage, 'archive.zip'), archive, { flag: 'wx', mode: 0o600 })
      const prepared = await this.preparePackage(stage, release.release.archiveDigest, version)
      const { unpacked, files, metadata, manifest, manifestDigest, instructionDigest } = prepared
      return await transaction(this.pool, async client => {
        await requireActiveAccount(client, user.userId, 'update')
        await client.query('SELECT pg_advisory_xact_lock(72819532,hashtext($1))', [requestId])
        const bound = await client.query<BuiltinInstallRequestRow>(
          'SELECT * FROM pe_builtin_skill_install_requests WHERE request_id=$1', [requestId])
        if (bound.rows[0]) {
          const prior = bound.rows[0]
          if (prior.user_id !== user.userId || prior.catalog_id !== catalogId || prior.version !== version
            || prior.archive_digest !== release.release.archiveDigest)
            throw new PlatformError(409, 'request_id_conflict')
          const result = await client.query<PackageVersionRow>(
            'SELECT * FROM pe_skill_package_versions WHERE id=$1 AND user_id=$2',
            [prior.package_version_id, user.userId])
          if (!result.rows[0]) throw new PlatformError(503, 'skill_package_unavailable')
          return this.versionItem(client, result.rows[0])
        }
        const occupied = await client.query(
          `SELECT id FROM pe_user_skills WHERE id=$1
           UNION ALL SELECT id FROM pe_skill_package_versions WHERE id=$1
           UNION ALL SELECT request_id AS id FROM pe_skill_upload_intents WHERE request_id=$1`, [requestId])
        if (occupied.rowCount) throw new PlatformError(409, 'request_id_conflict')
        const priorPackage = await client.query<PackageVersionRow>(
          'SELECT * FROM pe_skill_package_versions WHERE user_id=$1 AND archive_digest=$2',
          [user.userId, release.release.archiveDigest])
        if (priorPackage.rows[0]) {
          const existing = priorPackage.rows[0]
          if (existing.name !== metadata.name || existing.version !== version
            || existing.manifest_digest !== manifestDigest)
            throw new PlatformError(409, 'skill_version_conflict')
          await client.query(
            `INSERT INTO pe_builtin_skill_install_requests(request_id,user_id,catalog_id,version,
               archive_digest,package_version_id) VALUES($1,$2,$3,$4,$5,$6)`,
            [requestId, user.userId, catalogId, version, release.release.archiveDigest, existing.id])
          return this.versionItem(client, existing)
        }
        const existing = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin}
          WHERE s.user_id=$1 AND s.name=$2 FOR UPDATE OF s`, [user.userId, metadata.name])
        const skill = existing.rows[0]
        if (skill) {
          if (skill.revokedAt !== null) throw new PlatformError(409, 'skill_revoked')
          const origin = await client.query(
            `SELECT 1 FROM pe_builtin_skill_install_requests
             WHERE user_id=$1 AND catalog_id=$2 AND package_version_id=$3`,
            [user.userId, catalogId, skill.packageVersionId])
          if (skill.kind !== 'package' || !origin.rowCount) throw new PlatformError(409, 'skill_name_conflict')
          const sameVersion = await client.query(
            'SELECT 1 FROM pe_skill_package_versions WHERE user_id=$1 AND name=$2 AND version=$3',
            [user.userId, metadata.name, version])
          if (sameVersion.rowCount) throw new PlatformError(409, 'skill_version_conflict')
        } else {
          const count = await client.query<{ n: string }>(
            'SELECT count(*) AS n FROM pe_user_skills WHERE user_id=$1', [user.userId])
          if (Number(count.rows[0]!.n) >= this.maxSkillsPerUser) throw new PlatformError(413, 'skill_limit')
        }
        await this.publish(user.userId, release.release.archiveDigest, unpacked, manifest, files)
        const skillId = skill?.id ?? requestId
        if (!skill) await client.query(
          `INSERT INTO pe_user_skills(id,user_id,name,description,digest,kind)
           VALUES($1,$2,$3,$4,$5,'package')`,
          [skillId, user.userId, metadata.name, metadata.description, instructionDigest])
        await client.query(
          `INSERT INTO pe_skill_package_versions(id,user_id,skill_id,name,description,version,
           archive_digest,archive_size,instruction_digest,manifest_digest,manifest)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [requestId, user.userId, skillId, metadata.name, metadata.description, version,
            release.release.archiveDigest, archive.length, instructionDigest, manifestDigest, manifest])
        await client.query(
          `UPDATE pe_user_skills SET description=$2,digest=$3,package_version_id=$4,
           revision=revision+$5,updated_at=now() WHERE id=$1`,
          [skillId, metadata.description, instructionDigest, requestId, skill ? 1 : 0])
        await client.query(
          `INSERT INTO pe_builtin_skill_install_requests(request_id,user_id,catalog_id,version,
             archive_digest,package_version_id) VALUES($1,$2,$3,$4,$5,$6)`,
          [requestId, user.userId, catalogId, version, release.release.archiveDigest, requestId])
        const inserted = await client.query<SkillRow>(
          `SELECT ${skillColumns} FROM ${skillJoin} WHERE s.id=$1`, [skillId])
        return publicItem(inserted.rows[0]!)
      })
    } finally { await removeStage(stage) }
  }

  /** Presets are applied lazily and never revive an existing package or revoked skill.
   * Prior installation history and conflicting private skills are retained; unknown catalog identities reject the request.
   * @param user Authenticated owner whose missing presets may be installed through installBuiltin.
   * @param catalogIds Trusted preset identities, resolved against the current published catalog.
   */
  async ensurePreinstalled(user: Identity, catalogIds: readonly string[]): Promise<void> {
    if (catalogIds.length === 0) return
    const releases = await this.builtinCatalog.list()
    const known = new Map(releases.map(release => [release.id, release]))
    for (const catalogId of new Set(catalogIds)) {
      const release = known.get(catalogId)
      if (!release) throw new PlatformError(404, 'builtin_skill_not_found')
      const history = await this.pool.query(
        `SELECT 1 FROM pe_builtin_skill_install_requests WHERE user_id=$1 AND catalog_id=$2
         UNION ALL SELECT 1 FROM pe_skill_package_versions WHERE user_id=$1 AND archive_digest=$3`,
        [user.userId, catalogId, release.archiveDigest])
      if (history.rowCount) continue
      try {
        await this.installBuiltin(user, builtinRequestId(user.userId, catalogId, release.version),
          catalogId, release.version)
      } catch (error) {
        if (error instanceof PlatformError && ['skill_name_conflict', 'skill_version_conflict', 'skill_revoked'].includes(error.code))
          continue
        throw error
      }
    }
  }

  /** Consume one bounded ZIP and commit its immutable version after private extraction.
   * The ticket, exact archive bytes, and active account are rechecked before publication; expired or consumed tickets reject upload.
   * @param ticket Browser upload bearer issued for the owner's fixed byte count and archive digest.
   * @param body Direct Platform request stream containing the ZIP bytes, never a Host instruction payload.
   * @returns Installed version metadata and whether this transaction inserted a new version.
   */
  async upload(ticket: string, body: IncomingMessage): Promise<{ item: Record<string, unknown>; created: boolean }> {
    if (this.packageRoot === null) throw new PlatformError(503, 'skill_package_unavailable')
    const ticketDigest = hash(ticket)
    const found = await this.pool.query<UploadIntentRow>(
      'SELECT * FROM pe_skill_upload_intents WHERE token_digest=$1', [ticketDigest])
    const intent = found.rows[0]
    if (!intent || intent.consumed_at !== null || !intent.expires_at || intent.expires_at.getTime() < Date.now())
      throw new PlatformError(401, 'invalid_upload_ticket')
    const stage = await mkdtemp(join(this.packageRoot, '.staging', 'pe-'))
    try {
      const archive = join(stage, 'archive.zip')
      const output = await open(archive, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      let size = 0
      const digest = createHash('sha256')
      try {
        for await (const value of body) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
          size += chunk.length
          if (size > MAX_ARCHIVE_BYTES || size > intent.size_bytes) throw new PlatformError(413, 'skill_package_too_large')
          digest.update(chunk)
          await output.writeFile(chunk)
        }
        await output.sync()
      } finally { await output.close() }
      if (size !== intent.size_bytes || digest.digest('hex') !== intent.archive_digest)
        throw new PlatformError(400, 'skill_archive_mismatch')
      const { unpacked, files, metadata, version, manifest, manifestDigest, instructionDigest } =
        await this.preparePackage(stage, intent.archive_digest)
      return await transaction(this.pool, async client => {
        await requireActiveAccount(client, accountUserId.parse(intent.user_id), 'update')
        const current = await client.query<UploadIntentRow>(
          'SELECT * FROM pe_skill_upload_intents WHERE request_id=$1 FOR UPDATE', [intent.request_id])
        const ticketRow = current.rows[0]
        if (!ticketRow || ticketRow.token_digest !== ticketDigest || ticketRow.consumed_at !== null || !ticketRow.expires_at
          || ticketRow.expires_at.getTime() < Date.now()) throw new PlatformError(401, 'invalid_upload_ticket')
        const prior = await client.query<PackageVersionRow>('SELECT * FROM pe_skill_package_versions WHERE id=$1', [intent.request_id])
        if (prior.rows[0]) {
          if (prior.rows[0].user_id !== intent.user_id || prior.rows[0].archive_digest !== intent.archive_digest)
            throw new PlatformError(409, 'request_id_conflict')
          return { item: await this.versionItem(client, prior.rows[0]), created: false }
        }
        const occupied = await client.query('SELECT id FROM pe_user_skills WHERE id=$1', [intent.request_id])
        if (occupied.rowCount) throw new PlatformError(409, 'request_id_conflict')
        const existing = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin}
          WHERE s.user_id=$1 AND s.name=$2 FOR UPDATE OF s`, [intent.user_id, metadata.name])
        const skill = existing.rows[0]
        if (skill && skill.kind !== 'package') throw new PlatformError(409, 'skill_name_conflict')
        if (skill?.revokedAt !== null && skill?.revokedAt !== undefined) throw new PlatformError(409, 'skill_revoked')
        if (skill) {
          const sameVersion = await client.query('SELECT id FROM pe_skill_package_versions WHERE user_id=$1 AND name=$2 AND version=$3',
            [intent.user_id, metadata.name, version])
          if (sameVersion.rowCount) throw new PlatformError(409, 'skill_version_conflict')
        } else {
          const count = await client.query<{ n: string }>('SELECT count(*) AS n FROM pe_user_skills WHERE user_id=$1', [intent.user_id])
          if (Number(count.rows[0]!.n) >= this.maxSkillsPerUser) throw new PlatformError(413, 'skill_limit')
        }
        await this.publish(intent.user_id, intent.archive_digest, unpacked, manifest, files)
        const skillId = skill?.id ?? intent.request_id
        if (!skill) await client.query(
          `INSERT INTO pe_user_skills(id,user_id,name,description,digest,kind)
           VALUES($1,$2,$3,$4,$5,'package')`,
          [skillId, intent.user_id, metadata.name, metadata.description, instructionDigest])
        await client.query(
          `INSERT INTO pe_skill_package_versions(id,user_id,skill_id,name,description,version,
           archive_digest,archive_size,instruction_digest,manifest_digest,manifest)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [intent.request_id, intent.user_id, skillId, metadata.name, metadata.description, version,
            intent.archive_digest, size, instructionDigest, manifestDigest, manifest])
        await client.query(
          `UPDATE pe_user_skills SET description=$2,digest=$3,package_version_id=$4,
           updated_at=now()
           WHERE id=$1`, [skillId, metadata.description, instructionDigest, intent.request_id])
        await client.query('UPDATE pe_skill_upload_intents SET consumed_at=now() WHERE request_id=$1', [intent.request_id])
        const inserted = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin} WHERE s.id=$1`, [skillId])
        return { item: publicItem(inserted.rows[0]!), created: true }
      })
    } finally { await removeStage(stage) }
  }

  private async publish(userId: string, archiveDigest: string, stage: string, manifest: string,
    files: readonly ExtractedSkillFile[]): Promise<void> {
    const root = join(await this.packageUserRoot(userId), 'sha256')
    const target = join(root, archiveDigest)
    try {
      await verifyPublishedSkillPackage(target, manifest, files)
      await chmod(target, 0o555)
      await syncDirectory(target)
      return
    }
    catch (error) {
      if (!(error instanceof PlatformError) || error.code !== 'skill_package_unavailable') throw error
      try { await lstat(target) } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const directories = new Set<string>(['skill'])
        for (const file of files) {
          let parent = dirname(file.path)
          while (parent !== '.') { directories.add(parent); parent = dirname(parent) }
        }
        for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
          await chmod(join(stage, directory), 0o555)
          await syncDirectory(join(stage, directory))
        }
        await syncDirectory(stage)
        await rename(stage, target)
        await chmod(target, 0o555)
        await syncDirectory(target)
        await syncDirectory(root)
        return
      }
      throw error
    }
  }

  private async activeSelectedSkill(userId: string, selection: Selection,
    database: Pool | PoolClient = this.pool): Promise<SkillRow> {
    const result = await database.query<SkillRow>(
      `SELECT ${skillColumns} FROM ${skillJoin} WHERE s.id=$1 AND s.user_id=$2`, [selection.skillId, userId])
    const skill = result.rows[0]
    if (!skill || skill.kind !== selection.kind) throw new PlatformError(404, 'skill_not_found')
    if (skill.revokedAt !== null) throw new PlatformError(409, 'skill_revoked')
    if (skill.kind === 'text' && (skill.digest !== selection.digest || skill.name !== selection.name
      || skill.description !== selection.description))
      throw new PlatformError(503, 'skill_unavailable')
    return skill
  }

  private async selectedPackageVersion(userId: string, selected: Selection,
    database: Pool | PoolClient = this.pool): Promise<PackageVersionRow> {
    if (!selected.packageDigest || !selected.manifestDigest || !selected.version)
      throw new PlatformError(503, 'skill_package_unavailable')
    const result = await database.query<PackageVersionRow>(
      `SELECT * FROM pe_skill_package_versions WHERE user_id=$1 AND archive_digest=$2 AND manifest_digest=$3`,
      [userId, selected.packageDigest, selected.manifestDigest])
    const version = result.rows[0]
    if (!version || version.skill_id !== selected.skillId || version.version !== selected.version
      || version.instruction_digest !== selected.digest || version.name !== selected.name
      || version.description !== selected.description || hash(version.manifest) !== selected.manifestDigest)
      throw new PlatformError(503, 'skill_package_unavailable')
    return version
  }

  private async devicePackage(userId: string, selected: Selection, database: Pool | PoolClient):
    Promise<{ version: PackageVersionRow; binding: DeviceMaterialBinding; files: ExtractedSkillFile[] }> {
    if (selected.kind !== 'package') throw new PlatformError(404, 'device_material_not_found')
    await this.activeSelectedSkill(userId, selected, database)
    const version = await this.selectedPackageVersion(userId, selected, database)
    if (Buffer.byteLength(version.manifest) > MANIFEST_MAX_BYTES) throw new PlatformError(503, 'skill_package_unavailable')
    let raw: unknown
    try { raw = JSON.parse(version.manifest) }
    catch (_invalidManifest) { throw new PlatformError(503, 'skill_package_unavailable') }
    const manifest = deviceSkillManifest.safeParse(raw)
    const binding = deviceMaterialBinding.safeParse({ skillId: selected.skillId, version: selected.version,
      packageDigest: selected.packageDigest, manifestDigest: selected.manifestDigest, instructionDigest: selected.digest })
    if (!manifest.success || !binding.success
      || manifest.data.artifactSha256 !== binding.data.packageDigest
      || manifest.data.files.find(file => file.path === 'skill/SKILL.md')!.sha256 !== binding.data.instructionDigest) {
      throw new PlatformError(503, 'skill_package_unavailable')
    }
    return { version, binding: binding.data, files: manifest.data.files }
  }

  /** Bind only private packages from the accepted immutable Operation selection.
   * @param userId Original Operation owner.
   * @param selection Accepted text/package versions; text requires no Device material.
   * @param database Existing transaction when validating dispatch admission.
   * @returns Verified package identities, preserving accepted order and versions.
   */
  async deviceBindings(userId: string, selection: readonly Selection[], database: Pool | PoolClient = this.pool): Promise<DeviceMaterialBinding[]> {
    const bindings: DeviceMaterialBinding[] = []
    for (const selected of selection) if (selected.kind === 'package') {
      bindings.push((await this.devicePackage(userId, selected, database)).binding)
    }
    if (!bindings.length) return bindings
    const parsed = deviceMaterialSelection.safeParse(bindings)
    if (!parsed.success) throw new PlatformError(503, 'skill_package_unavailable')
    return parsed.data
  }

  /** Return the original manifest and every verified regular file without rebuilding an archive.
   * @param userId Original accepted owner, never chosen by the Device caller.
   * @param selected Exact accepted private package version.
   * @param binding Frozen dispatch identity to compare with that version.
   * @param database Metadata connection; Device routes perform filesystem reads outside their transactions.
   * @returns Bounded binary-preserving material after whole-tree and current revocation checks.
   */
  async readDeviceMaterial(userId: string, selected: Selection, binding: DeviceMaterialBinding,
    database: Pool | PoolClient = this.pool): Promise<DeviceSkillMaterial> {
    const original = await this.devicePackage(userId, selected, database)
    if (!isDeepStrictEqual(original.binding, binding)) throw new PlatformError(409, 'device_material_binding_changed')
    let material: DeviceSkillMaterial
    try {
      const root = join(await this.packageUserRoot(userId), 'sha256', original.version.archive_digest)
      await verifyPublishedSkillPackage(root, original.version.manifest, original.files)
      const files: DeviceSkillMaterial['files'] = []
      for (const expected of original.files) {
        let parent = root
        for (const part of expected.path.split('/').slice(0, -1)) {
          parent = join(parent, part)
          const stat = await lstat(parent)
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PlatformError(503, 'skill_package_unavailable')
        }
        const file = await open(join(root, expected.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.size) throw new PlatformError(503, 'skill_package_unavailable')
          const bytes = Buffer.alloc(expected.size + 1)
          let length = 0
          while (length < bytes.length) {
            const read = await file.read(bytes, length, bytes.length - length, length)
            if (read.bytesRead === 0) break
            length += read.bytesRead
          }
          if (length !== expected.size || hash(bytes.subarray(0, length)) !== expected.sha256) throw new PlatformError(503, 'skill_package_unavailable')
          files.push({ path: expected.path, data: bytes.subarray(0, length).toString('base64') })
        } finally { await file.close() }
      }
      await verifyPublishedSkillPackage(root, original.version.manifest, original.files)
      const parsed = deviceSkillMaterial.safeParse({ binding, manifest: original.version.manifest, files })
      if (!parsed.success) throw new PlatformError(503, 'skill_package_unavailable')
      material = parsed.data
    } catch (error) { if (error instanceof PlatformError) throw error; throw new PlatformError(503, 'skill_package_unavailable') }
    const current = await this.devicePackage(userId, selected, database)
    if (!isDeepStrictEqual(current.binding, binding)) throw new PlatformError(409, 'device_material_binding_changed')
    return material
  }

  /** Load one accepted skill body for a runner, checking current ownership and revocation.
   * Later upgrades or disabling do not replace the accepted version; missing, revoked, or damaged content rejects the read.
   * @param userId Original Operation owner, supplied by Platform authorization.
   * @param selection Immutable skill metadata frozen at Operation acceptance.
   * @param skillId Requested identity, which must equal the accepted selection identity.
   * @returns Digest-verified instruction snapshot for that accepted version.
   */
  async readSelected(userId: string, selection: Selection, skillId: string): Promise<unknown> {
    if (selection.skillId !== skillId) throw new PlatformError(404, 'skill_not_found')
    await this.activeSelectedSkill(userId, selection)
    return (await this.snapshot(userId, [selection]))[0]
  }

  /** Read one verified UTF-8 resource, or list manifest names, from an accepted version.
   * Current ownership and revocation apply; unsafe paths, unavailable bytes, oversized resources, or non-text files reject the read.
   * @param userId Original Operation owner, supplied by Platform authorization.
   * @param selected Immutable skill version frozen at Operation acceptance.
   * @param path Validated relative resource path, omitted to list manifest files without returning their bodies.
   * @returns Verified bounded text with its digest, or file names, sizes, and digests for the accepted version.
   */
  async readSelectedResource(userId: string, selected: Selection, path?: string): Promise<SkillResource> {
    const relative = path === undefined ? undefined : resourcePath(path)
    await this.activeSelectedSkill(userId, selected)
    if (selected.kind === 'text') {
      const text = await this.textContent(userId, selected.skillId, selected.digest)
      if (relative === undefined) return { kind: 'list', files: [
        { path: 'SKILL.md', size: Buffer.byteLength(text), sha256: selected.digest }] }
      if (relative !== 'SKILL.md') throw new PlatformError(404, 'skill_resource_not_found')
      return { kind: 'text', path: relative, text, sha256: selected.digest }
    }
    const version = await this.selectedPackageVersion(userId, selected)
    const files = manifestFiles(version.manifest, version.archive_digest)
    const packagePath = join(await this.packageUserRoot(userId), 'sha256', version.archive_digest)
    await verifyPublishedSkillPackage(packagePath, version.manifest, files)
    const resources = files.map(file => ({ path: file.path.slice('skill/'.length),
      size: file.size, sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path))
    if (relative === undefined) return { kind: 'list', files: resources }
    const item = resources.find(file => file.path === relative)
    if (!item) throw new PlatformError(404, 'skill_resource_not_found')
    if (item.size > RESOURCE_MAX_BYTES) throw new PlatformError(413, 'skill_resource_too_large')
    const parts = relative.split('/')
    let parent = join(packagePath, 'skill')
    try {
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part)
        const stat = await lstat(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PlatformError(503, 'skill_package_unavailable')
      }
    } catch (_error) {
      throw new PlatformError(503, 'skill_package_unavailable')
    }
    let bytes: Buffer
    try {
      const file = await open(join(parent, parts.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== item.size || stat.size > RESOURCE_MAX_BYTES)
          throw new PlatformError(503, 'skill_package_unavailable')
        bytes = await file.readFile()
      } finally { await file.close() }
    } catch (error) {
      if (error instanceof PlatformError) throw error
      throw new PlatformError(503, 'skill_package_unavailable')
    }
    if (bytes.length !== item.size || hash(bytes) !== item.sha256)
      throw new PlatformError(503, 'skill_package_unavailable')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw new PlatformError(415, 'skill_resource_not_text') }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text))
      throw new PlatformError(415, 'skill_resource_not_text')
    return { kind: 'text', path: relative, text, sha256: item.sha256 }
  }

  /** Resolve one accepted package path; build the pinned four-Skill report layout on demand.
   * Report siblings require all four accepted built-in installation records; missing members use the ordinary package path.
   * Published bytes must match their manifests; damaged packages or suites reject resolution rather than being repaired.
   * @param userId Original Operation owner, supplied by Platform authorization.
   * @param selection Immutable accepted versions used to authorize every report sibling.
   * @param skillId Requested selected skill, checked for current ownership and revocation.
   * @returns A null runtimePath for text skills, an ordinary package path, or a published report path with suiteAvailable true.
   */
  async runtimeResourceBase(userId: string, selection: readonly Selection[], skillId: string):
    Promise<{ runtimePath: string | null; suiteAvailable: boolean }> {
    const selected = selection.find(item => item.skillId === skillId)
    if (!selected) throw new PlatformError(404, 'skill_not_found')
    await this.activeSelectedSkill(userId, selected)
    if (selected.kind === 'text') return { runtimePath: null, suiteAvailable: false }
    const requestedVersion = await this.selectedPackageVersion(userId, selected)
    const userRoot = await this.packageUserRoot(userId)
    const packageRoot = join(userRoot, 'sha256', requestedVersion.archive_digest)
    const requestedFiles = manifestFiles(requestedVersion.manifest, requestedVersion.archive_digest)
    await verifyPublishedSkillPackage(packageRoot, requestedVersion.manifest, requestedFiles)
    const ordinary = { runtimePath: `/opt/power-evolve/skills/sha256/${requestedVersion.archive_digest}/skill`,
      suiteAvailable: false }
    const requestedRole = REPORT_SKILLS.find(role => role.folder === selected.name)
    if (!requestedRole) return ordinary
    const roles = REPORT_SKILLS.map(role => ({ ...role, selected: selection.find(item => item.kind === 'package'
      && item.name === role.folder) }))
    if (roles.some(role => !role.selected)) return ordinary
    const key = hash(JSON.stringify({ userId, roles: roles.map(role => ({ catalogId: role.id,
      skillId: role.selected!.skillId, version: role.selected!.version,
      archiveDigest: role.selected!.packageDigest, manifestDigest: role.selected!.manifestDigest })) }))
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(72819534,hashtext($1))', [`${userId}:${key}`])
      const sources: ReportSuiteSource[] = []
      for (const role of roles) {
        const item = role.selected!
        await this.activeSelectedSkill(userId, item, client)
        const version = await this.selectedPackageVersion(userId, item, client)
        const receipt = await client.query(
          `SELECT 1 FROM pe_builtin_skill_install_requests
           WHERE user_id=$1 AND catalog_id=$2 AND package_version_id=$3`, [userId, role.id, version.id])
        if (!receipt.rowCount) return ordinary
        sources.push({ folder: role.folder, packageRoot: join(userRoot, 'sha256', version.archive_digest),
          manifest: version.manifest, files: manifestFiles(version.manifest, version.archive_digest) })
      }
      await publishReportSuite(userRoot, join(this.packageRoot!, '.staging'), key, sources)
      return { runtimePath: `/opt/power-evolve/skills/report-suites/${key}/${requestedRole.folder}`,
        suiteAvailable: true }
    })
  }

  /** Resolve exactly the accepted version; later upgrades and revocation do not rewrite an Operation.
   * This content lookup does not check current revocation or selection eligibility; callers needing live authorization use readSelected.
   * @param userId Original owner of the accepted content, supplied by the caller's authorization.
   * @param selection Immutable accepted text or package versions in the required output order.
   * @returns Digest-verified instruction snapshots in selection order; missing or damaged content rejects the lookup.
   */
  async snapshot(userId: string, selection: z.infer<typeof skillSelection>[]): Promise<unknown[]> {
    return Promise.all(selection.map(async selected => {
      if (selected.kind === 'text') return { name: selected.name, description: selected.description,
        instructions: await this.textContent(userId, selected.skillId, selected.digest), revision: selected.revision,
        kind: 'text', version: null, digest: selected.digest, packageDigest: null, manifestDigest: null }
      const version = await this.selectedPackageVersion(userId, selected)
      return { name: selected.name, description: selected.description,
        instructions: await this.packageContent(userId, version.archive_digest, version.manifest_digest,
          version.instruction_digest, version.manifest), revision: selected.revision, kind: 'package',
        version: selected.version, digest: selected.digest, packageDigest: selected.packageDigest,
        manifestDigest: selected.manifestDigest }
    }))
  }
}
