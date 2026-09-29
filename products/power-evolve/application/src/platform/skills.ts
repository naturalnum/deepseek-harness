/** Per-user skill catalog; executable package bytes stay outside the shared Host. */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, type Identity, type skillSelection } from '../contracts.ts'
import { transaction } from './database.ts'
import { extractSkillPackage, MAX_ARCHIVE_BYTES, type ExtractedSkillFile } from './skill-package-extraction.ts'
import { readNativeSkillMetadata } from './skill-metadata.ts'
import { skillPackageManifest, skillPackageVersion, verifyPublishedSkillPackage } from './skill-package-manifest.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const TICKET_LIFETIME_MS = 5 * 60_000
const MANIFEST_MAX_BYTES = 128 * 1024

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

const skillColumns = `s.id,s.user_id AS "userId",s.name,s.description,s.digest,s.enabled,s.revision,s.kind,
  s.revoked_at AS "revokedAt",s.package_version_id AS "packageVersionId",v.version,
  v.archive_digest AS "packageDigest",v.manifest_digest AS "manifestDigest",v.manifest`
const skillJoin = 'pe_user_skills s LEFT JOIN pe_skill_package_versions v ON v.id=s.package_version_id'

function hash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

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

  constructor(private readonly pool: Pool, workspaceRoot: string, sandboxLocalRoot = '') {
    this.textRoot = join(resolve(workspaceRoot), 'extensions')
    this.packageRoot = sandboxLocalRoot ? join(resolve(sandboxLocalRoot), 'skill-packages') : null
  }

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

  async list(user: Identity): Promise<{ items: Record<string, unknown>[] }> {
    const result = await this.pool.query<SkillRow>(
      `SELECT ${skillColumns} FROM ${skillJoin} WHERE s.user_id=$1 ORDER BY s.name,s.id`, [user.userId])
    return { items: result.rows.map(publicItem) }
  }

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

  async install(user: Identity, id: string, name: string, description: string, instructions: string): Promise<Record<string, unknown>> {
    const digest = hash(instructions)
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
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
      if (Number(count.rows[0]!.n) >= 8) throw new PlatformError(413, 'skill_limit')
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

  async toggle(user: Identity, id: string, enabled: boolean): Promise<Record<string, unknown>> {
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
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

  async revoke(user: Identity, id: string): Promise<Record<string, unknown>> {
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      const result = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin}
        WHERE s.id=$1 AND s.user_id=$2 FOR UPDATE OF s`, [id, user.userId])
      if (!result.rows[0]) throw new PlatformError(404, 'skill_not_found')
      if (result.rows[0].revokedAt === null) await client.query(
        'UPDATE pe_user_skills SET revoked_at=now(),enabled=false,revision=revision+1,updated_at=now() WHERE id=$1', [id])
      const updated = await client.query<SkillRow>(`SELECT ${skillColumns} FROM ${skillJoin} WHERE s.id=$1`, [id])
      return publicItem(updated.rows[0]!)
    })
  }

  /** Issue a browser-only bearer ticket without accepting archive bytes into the Host. */
  async issueUploadTicket(user: Identity, requestId: string, sizeBytes: number, sha256: string,
    platformOrigin: string): Promise<Record<string, unknown>> {
    if (this.packageRoot === null) throw new PlatformError(503, 'skill_package_unavailable')
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
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

  /** Consume one bounded ZIP and commit its immutable version after private extraction. */
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
      const unpacked = join(stage, 'unpacked')
      await mkdir(unpacked, { mode: 0o700 })
      let files: readonly ExtractedSkillFile[]
      try { files = await extractSkillPackage(archive, unpacked) }
      catch (error) {
        if (error instanceof PlatformError) throw error
        throw new PlatformError(400, 'invalid_skill_package')
      }
      const metadata = await readNativeSkillMetadata(join(unpacked, 'skill'))
      const version = await skillPackageVersion(join(unpacked, 'skill'), intent.archive_digest, files)
      const manifest = skillPackageManifest(intent.archive_digest, files)
      if (Buffer.byteLength(manifest) > MANIFEST_MAX_BYTES) throw new PlatformError(400, 'invalid_skill_package')
      const manifestDigest = hash(manifest)
      await writeFile(join(unpacked, 'manifest.json'), manifest, { flag: 'wx', mode: 0o444 })
      await chmod(join(unpacked, 'manifest.json'), 0o444)
      const manifestHandle = await open(join(unpacked, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await manifestHandle.sync() } finally { await manifestHandle.close() }
      const instructionDigest = files.find(file => file.path === 'skill/SKILL.md')!.sha256
      return await transaction(this.pool, async client => {
        await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [intent.user_id])
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
          if (Number(count.rows[0]!.n) >= 8) throw new PlatformError(413, 'skill_limit')
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

  /** Resolve exactly the accepted version; later upgrades and revocation do not rewrite an Operation. */
  async snapshot(userId: string, selection: z.infer<typeof skillSelection>[]): Promise<unknown[]> {
    return Promise.all(selection.map(async selected => {
      if (selected.kind === 'text') return { name: selected.name, description: selected.description,
        instructions: await this.textContent(userId, selected.skillId, selected.digest), revision: selected.revision,
        kind: 'text', version: null, digest: selected.digest, packageDigest: null, manifestDigest: null }
      if (!selected.packageDigest || !selected.manifestDigest || !selected.version)
        throw new PlatformError(503, 'skill_package_unavailable')
      const result = await this.pool.query<PackageVersionRow>(
        `SELECT * FROM pe_skill_package_versions WHERE user_id=$1 AND archive_digest=$2 AND manifest_digest=$3`,
        [userId, selected.packageDigest, selected.manifestDigest])
      const version = result.rows[0]
      if (!version || version.skill_id !== selected.skillId || version.version !== selected.version
        || version.instruction_digest !== selected.digest) throw new PlatformError(503, 'skill_package_unavailable')
      return { name: selected.name, description: selected.description,
        instructions: await this.packageContent(userId, selected.packageDigest, selected.manifestDigest,
          selected.digest, version.manifest), revision: selected.revision, kind: 'package',
        version: selected.version, digest: selected.digest, packageDigest: selected.packageDigest,
        manifestDigest: selected.manifestDigest }
    }))
  }
}
