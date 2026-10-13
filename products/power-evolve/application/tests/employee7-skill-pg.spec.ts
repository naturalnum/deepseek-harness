/** Isolated real PG, HTTP upload streams, TaskStore grants and immutable report-package bytes. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { inflateRawSync } from 'node:zlib'
import { zipSync, type Zippable } from 'fflate'
import type { PoolClient } from 'pg'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { requestId, runtimeSkillSnapshot } from '../src/contracts.ts'
import { BuiltinSkillCatalog } from '../src/platform/builtin-skills.ts'
import { extractSkillPackage } from '../src/platform/skill-package-extraction.ts'
import { skillPackageManifest } from '../src/platform/skill-package-manifest.ts'
import { SkillService } from '../src/platform/skills.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { readRuntimeSkill, readRuntimeSkillResource } from '../src/platform/runtime-skills.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const pending = z.object({ state: z.literal('pending'), ticket: z.string() })
const publicSkill = z.object({ skillId: z.uuid(), name: z.string(), version: z.string().nullable(), packageDigest: z.string().nullable() })
const completeBuiltinIds = (await new BuiltinSkillCatalog().list()).map(item => item.id)

function firstValue<T>(values: readonly T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error('Owned fixture query returned no row')
  return value
}

async function writable(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  await chmod(path, 0o700)
  for (const entry of await readdir(path)) await writable(join(path, entry))
}

type CloudCase = Parameters<Parameters<typeof cloudFixture>[0]>[0]

async function withSkills(run: (f: CloudCase, skills: SkillService, library: string) => Promise<void>): Promise<void> {
  await cloudFixture(async (f) => {
    const library = join(f.root, 'library')
    const skills = new SkillService(f.pool, join(f.root, 'workspace'), library, 64, completeBuiltinIds)
    await skills.init()
    try { await run(f, skills, library) }
    finally { await writable(library) }
  })
}

function archive(version: string, name = 'employee-seven', resources: Zippable = {}): Buffer {
  return Buffer.from(zipSync({ 'SKILL.md': Buffer.from(`---\nname: ${name}\ndescription: "Owned YAML: 中文"\n---\nVersion ${version}.\n`),
    'skill-package.json': Buffer.from(JSON.stringify({ schemaVersion: 1, version })), ...resources }, { level: 6 }))
}

/** Feed the production SkillService a genuine loopback HTTP IncomingMessage and await socket teardown. */
async function upload(skills: SkillService, ticket: string, bytes: Buffer): Promise<Awaited<ReturnType<SkillService['upload']>>> {
  let resolveOutcome: (value: Awaited<ReturnType<SkillService['upload']>>) => void = () => { throw new Error('Outcome not initialized') }
  let rejectOutcome: (error: unknown) => void = () => { throw new Error('Outcome not initialized') }
  const outcome = new Promise<Awaited<ReturnType<SkillService['upload']>>>((resolve, reject) => {
    resolveOutcome = resolve; rejectOutcome = reject
  })
  const server = createServer((body, response) => {
    skills.upload(ticket, body).then((value) => { response.end('finished'); resolveOutcome(value) }, (error: unknown) => {
      body.resume(); response.statusCode = 400; response.end('failed'); rejectOutcome(error)
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind an owned port')
    const sent = new Promise<void>((resolve, reject) => {
      const outgoing = request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: '/owned-upload', agent: false }, (response) => {
        response.once('error', reject); response.once('end', resolve); response.resume()
      })
      outgoing.once('error', reject)
      outgoing.end(bytes)
    })
    const [result] = await Promise.all([outcome, sent])
    return result
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }
}

/** Observe actual blocked transactions in this case's database before releasing the owner's row lock. */
async function whileAccountLocked<T>(f: CloudCase, count: number, start: () => Promise<PromiseSettledResult<T>[]>,
  change?: (client: PoolClient) => Promise<void>): Promise<PromiseSettledResult<T>[]> {
  const blocker = await f.pool.connect()
  let locked = false
  let work: Promise<PromiseSettledResult<T>[]> | undefined
  try {
    await blocker.query('BEGIN'); locked = true
    await blocker.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.alice.user.userId])
    const pid = firstValue((await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows).pid
    work = start()
    const deadline = Date.now() + 5000
    for (;;) {
      const result = await f.pool.query<{ n: number }>(`WITH RECURSIVE blocked AS (
        SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
          WHERE a.datname=current_database()
      ) SELECT count(*)::integer AS n FROM blocked`, [pid])
      if (firstValue(result.rows).n === count) break
      if (Date.now() >= deadline) throw new Error('Owned requests did not reach the publication lock')
      await delay(25)
    }
    await change?.(blocker)
    await blocker.query('COMMIT'); locked = false
    return await work
  } finally {
    if (locked) await blocker.query('ROLLBACK')
    blocker.release()
    await work
  }
}

test('concurrent use of one upload bearer commits exactly once after both requests reach the publication lock', () => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0')
  const id = randomUUID()
  const ticket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  const outcomes = await whileAccountLocked(f, 2, () => Promise.allSettled([
    upload(skills, ticket.ticket, bytes), upload(skills, ticket.ticket, bytes),
  ]))
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = outcomes.find(result => result.status === 'rejected')
  if (!rejected || rejected.status !== 'rejected') throw new Error('Duplicate upload was not rejected')
  expect(rejected.reason).toMatchObject({ status: 401, code: 'invalid_upload_ticket' })
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions')).rows).n).toBe(1)
  expect(firstValue((await f.pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM pe_skill_upload_intents WHERE request_id=$1', [id])).rows).consumed_at).not.toBeNull()
  expect((await skills.read(f.alice.user, id)).version).toBe('1.0.0')
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test.each(['expired ticket', 'disabled account'] as const)('upload rechecks %s after real extraction and a publication lock wait', mode => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0')
  const id = randomUUID()
  const ticket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  const outcomes = await whileAccountLocked(f, 1, () => Promise.allSettled([upload(skills, ticket.ticket, bytes)]), async (client) => {
    if (mode === 'expired ticket') await client.query('UPDATE pe_skill_upload_intents SET expires_at=clock_timestamp()-interval \'1 second\' WHERE request_id=$1', [id])
    else await client.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.alice.user.userId])
  })
  const result = firstValue(outcomes)
  if (result.status !== 'rejected') throw new Error('Stale admission committed a package')
  expect(result.reason).toMatchObject({ status: 401, code: mode === 'expired ticket' ? 'invalid_upload_ticket' : 'account_disabled' })
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions')).rows).n).toBe(0)
  expect(firstValue((await f.pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM pe_skill_upload_intents WHERE request_id=$1', [id])).rows).consumed_at).toBeNull()
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
  const bobId = randomUUID()
  const bob = pending.parse(await skills.issueUploadTicket(f.bob.user, bobId, bytes.length, hash(bytes), 'http://127.0.0.1'))
  expect((await upload(skills, bob.ticket, bytes)).created).toBe(true)
  await expect(skills.read(f.bob.user, id)).rejects.toMatchObject({ code: 'skill_not_found' })
}))

test.each(['same request', 'distinct requests'] as const)('concurrent builtin installation with %s reuses one verified package and binds receipts', mode => withSkills(async (f, skills, library) => {
  const release = (await skills.catalog(f.alice.user)).items.find(item => item.id === 'builtin.word')
  if (!release) throw new Error('Pinned Word release was not available')
  const firstId = randomUUID(), secondId = mode === 'same request' ? firstId : randomUUID()
  const outcomes = await whileAccountLocked(f, 2, () => Promise.allSettled([
    skills.installBuiltin(f.alice.user, firstId, release.id, release.version),
    skills.installBuiltin(f.alice.user, secondId, release.id, release.version),
  ]))
  const installed = outcomes.map((result) => {
    if (result.status !== 'fulfilled')
      throw new Error('Idempotent builtin installation rejected', { cause: result.reason })
    return publicSkill.parse(result.value)
  })
  expect(installed[0]).toEqual(installed[1])
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions')).rows).n).toBe(1)
  const receipts = firstValue((await f.pool.query<{ n: number }>(
    'SELECT count(*)::integer AS n FROM pe_builtin_skill_install_requests')).rows).n
  expect(receipts).toBe(mode === 'same request' ? 1 : 2)
  const installedRelease = (await skills.catalog(f.alice.user)).items.find(item => item.id === release.id)
  expect(installedRelease?.installedSkillId).toBe(firstValue(installed).skillId)
  await expect(skills.installBuiltin(f.bob.user, secondId, release.id, release.version)).rejects.toMatchObject({ code: 'request_id_conflict' })
  await expect(skills.installBuiltin(f.alice.user, secondId, release.id, '99.0.0')).rejects.toMatchObject({ code: 'request_id_conflict' })
  if (mode === 'distinct requests') await expect(skills.issueUploadTicket(f.alice.user, secondId, 100, 'a'.repeat(64), 'http://127.0.0.1'))
    .rejects.toMatchObject({ code: 'request_id_conflict' })
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test.each(['complete', 'corrupted'] as const)('upload recovers a %s orphaned published tree without replacing existing bytes', mode => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0', 'employee-seven', { 'references/guide.txt': Buffer.from('original') })
  const target = join(library, 'skill-packages', f.alice.user.userId, 'sha256', hash(bytes))
  await mkdir(target, { recursive: true })
  const archivePath = join(f.root, 'orphan.zip')
  await writeFile(archivePath, bytes)
  const files = await extractSkillPackage(archivePath, target)
  const manifest = skillPackageManifest(hash(bytes), files)
  await writeFile(join(target, 'manifest.json'), manifest, { mode: 0o444 })
  const resource = join(target, 'skill/references/guide.txt')
  if (mode === 'corrupted') { await chmod(resource, 0o600); await writeFile(resource, 'tampered') }
  const prior = await lstat(resource)
  const id = randomUUID()
  const ticket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  if (mode === 'complete') {
    expect((await upload(skills, ticket.ticket, bytes)).created).toBe(true)
    expect((await skills.read(f.alice.user, id)).version).toBe('1.0.0')
  } else {
    await expect(upload(skills, ticket.ticket, bytes)).rejects.toMatchObject({ status: 503, code: 'skill_package_unavailable' })
    expect(firstValue((await f.pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM pe_skill_upload_intents WHERE request_id=$1', [id])).rows).consumed_at).toBeNull()
  }
  expect((await lstat(resource)).ino).toBe(prior.ino)
  expect(await readFile(resource, 'utf8')).toBe(mode === 'complete' ? 'original' : 'tampered')
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions')).rows).n).toBe(mode === 'complete' ? 1 : 0)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test('user import of authentic builtin bytes retains its archive version and cannot claim a pinned release identity', () => withSkills(async (f, skills, library) => {
  const catalog = new BuiltinSkillCatalog()
  const release = (await catalog.list()).find(item => item.id === 'builtin.word')
  if (!release) throw new Error('Pinned Word release was not available')
  const loaded = await catalog.get(release.id, release.version)
  if (!loaded) throw new Error('Pinned Word archive was not available')
  const id = randomUUID(), bytes = loaded.archive
  const ticket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  await upload(skills, ticket.ticket, bytes)
  const original = await skills.read(f.alice.user, id)
  expect(original.version).toBe(`sha256:${hash(bytes)}`)
  await expect(skills.installBuiltin(f.alice.user, randomUUID(), release.id, release.version)).rejects.toMatchObject({ code: 'skill_version_conflict' })
  await skills.ensurePreinstalled(f.alice.user, [release.id])
  expect(await skills.read(f.alice.user, id)).toEqual(original)
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_builtin_skill_install_requests')).rows).n).toBe(0)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test('presets preserve private text name conflicts while genuine capacity errors propagate', () => withSkills(async (f, skills, library) => {
  const releases = (await skills.catalog(f.alice.user)).items
  const word = releases.find(item => item.id === 'builtin.word'), pdf = releases.find(item => item.id === 'builtin.pdf')
  if (!word || !pdf) throw new Error('Pinned document releases were not available')
  const bob = publicSkill.parse(await skills.installBuiltin(f.bob.user, randomUUID(), word.id, word.version))
  const id = randomUUID()
  const original = await skills.install(f.alice.user, id, bob.name, 'Private text', 'Private instructions')
  await skills.ensurePreinstalled(f.alice.user, [])
  await skills.ensurePreinstalled(f.alice.user, [word.id, word.id])
  expect(await skills.read(f.alice.user, id)).toMatchObject({ instructions: 'Private instructions' })
  expect((await skills.list(f.alice.user)).items).toEqual([original])
  await expect(skills.installBuiltin(f.alice.user, randomUUID(), word.id, word.version)).rejects.toMatchObject({ code: 'skill_name_conflict' })
  const limited = new SkillService(f.pool, join(f.root, 'workspace'), library, 1)
  await expect(limited.ensurePreinstalled(f.bob.user, [pdf.id])).rejects.toMatchObject({ code: 'skill_limit' })
  expect((await skills.read(f.bob.user, bob.skillId)).version).toBe(word.version)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test('malformed compressed bytes with a matching upload digest fail package preparation without committing or consuming the ticket', () => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0')
  const start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28)
  const central = bytes.readUInt32LE(bytes.length - 22 + 16)
  bytes[start] = 0x07
  expect(() => inflateRawSync(bytes.subarray(start, start + bytes.readUInt32LE(central + 20)))).toThrow()
  const id = randomUUID()
  const ticket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  await expect(upload(skills, ticket.ticket, bytes)).rejects.toMatchObject({ status: 400, code: 'invalid_skill_package' })
  expect(firstValue((await f.pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM pe_skill_upload_intents WHERE request_id=$1', [id])).rows).consumed_at).toBeNull()
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions')).rows).n).toBe(0)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test.each(['oversized manifest', 'malformed JSON', 'wrong archive', 'missing instructions', 'unsafe persisted path', 'instruction digest drift'] as const)('durable %s rejects private and accepted reads while retaining original package bytes', mode => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0', 'employee-seven', { 'references/guide.txt': Buffer.from('owned guide') })
  const id = randomUUID()
  const ticket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  await upload(skills, ticket.ticket, bytes)
  const tasks = new TaskStore(f.pool, limits)
  const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'before durable corruption', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Accepted package grant was not claimed')
  const saved = firstValue((await f.pool.query<{ manifest: string; manifest_digest: string }>(
    'SELECT manifest,manifest_digest FROM pe_skill_package_versions WHERE id=$1', [id])).rows)
  const document = z.object({ schemaVersion: z.literal(1), artifactSha256: z.string(),
    files: z.array(z.object({ path: z.string(), size: z.number(), sha256: z.string() })) }).parse(JSON.parse(saved.manifest))
  let manifest: string
  if (mode === 'oversized manifest') manifest = ' '.repeat(128 * 1024 + 1)
  else if (mode === 'malformed JSON') manifest = '{'
  else {
    if (mode === 'wrong archive') document.artifactSha256 = '0'.repeat(64)
    if (mode === 'missing instructions') document.files = document.files.filter(file => file.path !== 'skill/SKILL.md')
    if (mode === 'unsafe persisted path') firstValue(document.files.filter(file => file.path !== 'skill/SKILL.md')).path = 'skill/../sentinel.txt'
    if (mode === 'instruction digest drift') firstValue(document.files.filter(file => file.path === 'skill/SKILL.md')).sha256 = '0'.repeat(64)
    manifest = JSON.stringify(document)
  }
  const sentinel = join(f.root, 'sentinel.txt')
  await writeFile(sentinel, 'outside package')
  const packagePath = join(library, 'skill-packages', f.alice.user.userId, 'sha256', hash(bytes))
  const priorInstructions = await readFile(join(packagePath, 'skill/SKILL.md'))
  await f.pool.query('UPDATE pe_skill_package_versions SET manifest=$2,manifest_digest=$3 WHERE id=$1', [id, manifest, hash(Buffer.from(manifest))])
  await expect(skills.read(f.alice.user, id)).rejects.toMatchObject({ status: 503, code: 'skill_package_unavailable' })
  await expect(readRuntimeSkill(tasks, skills, grant.token, id)).rejects.toMatchObject({ status: 503, code: 'skill_package_unavailable' })
  await expect(skills.read(f.bob.user, id)).rejects.toMatchObject({ code: 'skill_not_found' })
  expect(await readFile(join(packagePath, 'manifest.json'), 'utf8')).toBe(saved.manifest)
  expect(await readFile(join(packagePath, 'skill/SKILL.md'))).toEqual(priorInstructions)
  expect(await readFile(sentinel, 'utf8')).toBe('outside package')
  await f.pool.query('UPDATE pe_skill_package_versions SET manifest=$2,manifest_digest=$3 WHERE id=$1', [id, saved.manifest, saved.manifest_digest])
  expect((await skills.read(f.alice.user, id)).version).toBe('1.0.0')
  expect(await readRuntimeSkill(tasks, skills, grant.token, id)).toMatchObject({ version: '1.0.0' })
}))

test('rotating owner-bound upload tickets reject stale bearers and damaged bytes without consuming retry identity', () => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0')
  const id = randomUUID()
  const first = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  const second = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  expect(second.ticket).not.toBe(first.ticket)
  await expect(skills.issueUploadTicket(f.bob.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
    .rejects.toMatchObject({ code: 'request_id_conflict' })
  await expect(upload(skills, first.ticket, bytes)).rejects.toMatchObject({ code: 'invalid_upload_ticket' })
  const corrupt = Buffer.from(bytes); corrupt[0] = corrupt.readUInt8(0) ^ 1
  await expect(upload(skills, second.ticket, corrupt)).rejects.toMatchObject({ code: 'skill_archive_mismatch' })
  await expect(upload(skills, second.ticket, Buffer.concat([bytes, Buffer.from('extra')]))).rejects.toMatchObject({ code: 'skill_package_too_large' })
  expect(firstValue((await f.pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM pe_skill_upload_intents WHERE request_id=$1', [id])).rows).consumed_at).toBeNull()
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions')).rows).n).toBe(0)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
  const installed = await upload(skills, second.ticket, bytes)
  expect(installed.created).toBe(true)
  await expect(upload(skills, second.ticket, bytes)).rejects.toMatchObject({ code: 'invalid_upload_ticket' })
  expect(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
    .toEqual({ state: 'ready', item: installed.item })
  await expect(skills.read(f.bob.user, id)).rejects.toMatchObject({ code: 'skill_not_found' })
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test('invalid YAML and semantic-version conflicts clean staging and retain prior committed packages', () => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0')
  const id = randomUUID()
  const ticket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  await upload(skills, ticket.ticket, bytes)
  const original = await skills.read(f.alice.user, id)
  const conflict = archive('1.0.0', 'employee-seven', { 'new.txt': Buffer.from('new bytes') })
  const conflictId = randomUUID()
  const conflictTicket = pending.parse(await skills.issueUploadTicket(f.alice.user, conflictId, conflict.length, hash(conflict), 'http://127.0.0.1'))
  await expect(upload(skills, conflictTicket.ticket, conflict)).rejects.toMatchObject({ code: 'skill_version_conflict' })
  const bad = archive('2.0.0', 'Invalid_Name')
  const badId = randomUUID()
  const badTicket = pending.parse(await skills.issueUploadTicket(f.alice.user, badId, bad.length, hash(bad), 'http://127.0.0.1'))
  await expect(upload(skills, badTicket.ticket, bad)).rejects.toMatchObject({ code: 'invalid_skill_metadata' })
  expect(await skills.read(f.alice.user, id)).toEqual(original)
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions')).rows).n).toBe(1)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test('real operation grants retain accepted package resources across upgrades and disabling but enforce live revocation', () => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0', 'employee-seven', { 'references/guide.txt': Buffer.from('原始资料'),
    'binary.bin': Buffer.from([0xff, 0xfe]), 'control.txt': Buffer.from('a\0b'), 'large.txt': Buffer.alloc(262_145, 65) })
  const id = randomUUID()
  const firstTicket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  await upload(skills, firstTicket.ticket, bytes)
  const tasks = new TaskStore(f.pool, limits)
  const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'accepted v1', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Real operation grant was not claimed')
  expect(grant.selection).toHaveLength(1)
  const selected = firstValue(grant.selection)
  const v1Path = join(library, 'skill-packages', f.alice.user.userId, 'sha256', hash(bytes), 'skill/SKILL.md')
  const v1 = await readFile(v1Path)
  const next = archive('2.0.0', 'employee-seven', { 'references/guide.txt': Buffer.from('新版本资料') })
  const nextTicket = pending.parse(await skills.issueUploadTicket(f.alice.user, randomUUID(), next.length, hash(next), 'http://127.0.0.1'))
  await upload(skills, nextTicket.ticket, next)
  expect((await skills.read(f.alice.user, id)).version).toBe('2.0.0')
  await skills.toggle(f.alice.user, id, false)
  const runtime = runtimeSkillSnapshot.parse(await readRuntimeSkill(tasks, skills, grant.token, id))
  expect(runtime.version).toBe('1.0.0')
  expect(runtime.instructions).toContain('Version 1.0.0.')
  expect(runtime.suiteAvailable).toBe(false)
  expect(await readRuntimeSkillResource(tasks, skills, grant.token, id, 'references/guide.txt')).toMatchObject({ kind: 'text', text: '原始资料' })
  const resources = z.object({ kind: z.literal('list'), files: z.array(z.object({ path: z.string() })) })
    .parse(await readRuntimeSkillResource(tasks, skills, grant.token, id))
  expect(resources.files.some(file => file.path === 'binary.bin')).toBe(true)
  for (const path of ['../escape', '/absolute', 'a\\b', 'a:b', 'a//b', 'a\0b']) {
    await expect(readRuntimeSkillResource(tasks, skills, grant.token, id, path)).rejects.toMatchObject({ code: 'invalid_skill_resource_path' })
  }
  await expect(readRuntimeSkillResource(tasks, skills, grant.token, id, 'missing.txt')).rejects.toMatchObject({ code: 'skill_resource_not_found' })
  for (const path of ['binary.bin', 'control.txt']) await expect(readRuntimeSkillResource(tasks, skills, grant.token, id, path))
    .rejects.toMatchObject({ code: 'skill_resource_not_text' })
  await expect(readRuntimeSkillResource(tasks, skills, grant.token, id, 'large.txt')).rejects.toMatchObject({ code: 'skill_resource_too_large' })
  await expect(skills.readSelected(f.bob.user.userId, selected, id)).rejects.toMatchObject({ code: 'skill_not_found' })
  await expect(readRuntimeSkill(tasks, skills, grant.token, randomUUID())).rejects.toMatchObject({ code: 'skill_not_found' })
  await expect(readRuntimeSkillResource(tasks, skills, grant.token, randomUUID())).rejects.toMatchObject({ code: 'skill_not_found' })
  await skills.revoke(f.alice.user, id)
  await expect(readRuntimeSkill(tasks, skills, grant.token, id)).rejects.toMatchObject({ code: 'skill_revoked' })
  await expect(readRuntimeSkillResource(tasks, skills, grant.token, id)).rejects.toMatchObject({ code: 'skill_revoked' })
  expect(await skills.snapshot(f.alice.user.userId, [selected])).toEqual([expect.objectContaining({ version: '1.0.0' })])
  expect(await readFile(v1Path)).toEqual(v1)
  await f.pool.query('UPDATE pe_sessions SET lease_until=clock_timestamp()-interval \'1 second\' WHERE id=$1', [session.sessionId])
  await expect(readRuntimeSkill(tasks, skills, grant.token, id)).rejects.toMatchObject({ code: 'lease_lost' })
  await expect(readRuntimeSkillResource(tasks, skills, grant.token, id)).rejects.toMatchObject({ code: 'lease_lost' })
}))

test('text selection, tenant rejection, persistent disabling and tampered bytes use the real file service', () => withSkills(async (f, skills) => {
  const id = randomUUID()
  const installed = await skills.install(f.alice.user, id, 'employee-seven-text', 'Text description', '文字说明')
  expect(await skills.install(f.alice.user, id, 'employee-seven-text', 'Text description', '文字说明')).toEqual(installed)
  await expect(skills.install(f.bob.user, id, 'employee-seven-text', 'Text description', '文字说明')).rejects.toMatchObject({ code: 'request_id_conflict' })
  await expect(skills.toggle(f.bob.user, id, false)).rejects.toMatchObject({ code: 'skill_not_found' })
  await expect(skills.revoke(f.bob.user, id)).rejects.toMatchObject({ code: 'skill_not_found' })
  const tasks = new TaskStore(f.pool, limits)
  const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'text selection', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Real text grant was not claimed')
  await skills.toggle(f.alice.user, id, false)
  const disabled = await skills.toggle(f.alice.user, id, false)
  expect(disabled.revision).toBe(2)
  expect(await readRuntimeSkill(tasks, skills, grant.token, id)).toMatchObject({ instructions: '文字说明', runtimePath: null, suiteAvailable: false })
  expect(await readRuntimeSkillResource(tasks, skills, grant.token, id)).toEqual({ kind: 'list', files: [{ path: 'SKILL.md', size: Buffer.byteLength('文字说明'), sha256: hash(Buffer.from('文字说明')) }] })
  expect(await readRuntimeSkillResource(tasks, skills, grant.token, id, 'SKILL.md')).toMatchObject({ text: '文字说明' })
  await expect(readRuntimeSkillResource(tasks, skills, grant.token, id, 'other')).rejects.toMatchObject({ code: 'skill_resource_not_found' })
  const resumed = new SkillService(f.pool, join(f.root, 'workspace'), join(f.root, 'library'))
  await resumed.init()
  expect((await resumed.list(f.alice.user)).items).toEqual([disabled])
  const file = join(f.root, 'workspace/extensions', f.alice.user.userId, `${id}.md`)
  await writeFile(file, '损坏说明')
  await expect(readRuntimeSkill(tasks, resumed, grant.token, id)).rejects.toMatchObject({ code: 'skill_unavailable' })
  await writeFile(file, '文字说明')
  const revoked = await skills.revoke(f.alice.user, id)
  expect(await skills.revoke(f.alice.user, id)).toEqual(revoked)
  await expect(skills.toggle(f.alice.user, id, true)).rejects.toMatchObject({ code: 'skill_revoked' })
  expect(await readFile(file, 'utf8')).toBe('文字说明')
}))

test('accepted four-report suite resolves physical sibling bytes, survives reconstruction and rejects corruption without repair', () => withSkills(async (f, skills, library) => {
  const ids = ['builtin.report-workflow-orchestrator', 'builtin.power-grid-technical-report-writer', 'builtin.report-reviewer', 'builtin.tech-report-writer']
  await skills.ensurePreinstalled(f.alice.user, ids)
  const tasks = new TaskStore(f.pool, limits)
  const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'four reports', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Real report grant was not claimed')
  expect(grant.selection).toHaveLength(4)
  const selected = grant.selection.find(item => item.name === 'report-workflow-orchestrator')!
  const ordinary = await skills.runtimeResourceBase(f.alice.user.userId, [selected], selected.skillId)
  expect(ordinary.suiteAvailable).toBe(false)
  const resolved = await skills.runtimeResourceBase(f.alice.user.userId, grant.selection, selected.skillId)
  expect(resolved.suiteAvailable).toBe(true)
  if (!resolved.runtimePath) throw new Error('Report suite path is missing')
  const suite = join(library, 'skill-packages', f.alice.user.userId, resolved.runtimePath.slice('/opt/power-evolve/skills/'.length))
  const suiteRoot = join(suite, '..')
  expect((await readdir(suiteRoot)).sort()).toEqual([...grant.selection.map(item => item.name), 'suite-manifest.json'].sort())
  const bytes = await readFile(join(suite, 'SKILL.md'))
  for (const item of grant.selection) {
    const actual = await readFile(join(suiteRoot, item.name, 'SKILL.md'))
    expect(hash(actual)).toBe(item.digest)
    expect((await lstat(join(suiteRoot, item.name))).mode & 0o777).toBe(0o555)
  }
  const resumed = new SkillService(f.pool, join(f.root, 'workspace'), library); await resumed.init()
  expect(await resumed.runtimeResourceBase(f.alice.user.userId, grant.selection, selected.skillId)).toEqual(resolved)
  await expect(resumed.runtimeResourceBase(f.bob.user.userId, grant.selection, selected.skillId)).rejects.toMatchObject({ code: 'skill_not_found' })
  await expect(resumed.runtimeResourceBase(f.alice.user.userId, grant.selection, randomUUID())).rejects.toMatchObject({ code: 'skill_not_found' })
  const target = join(suite, 'SKILL.md')
  await chmod(target, 0o600)
  const corrupt = Buffer.from(bytes); corrupt[0] = corrupt.readUInt8(0) ^ 1; await writeFile(target, corrupt); await chmod(target, 0o444)
  await expect(resumed.runtimeResourceBase(f.alice.user.userId, grant.selection, selected.skillId)).rejects.toMatchObject({ code: 'skill_package_unavailable' })
  expect(await readFile(target)).toEqual(corrupt)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test('report suite requires real built-in receipts and preinstallation never revives revoked history', () => withSkills(async (f, skills, library) => {
  const ids = ['builtin.report-workflow-orchestrator', 'builtin.power-grid-technical-report-writer', 'builtin.report-reviewer', 'builtin.tech-report-writer']
  await skills.ensurePreinstalled(f.alice.user, ids)
  const tasks = new TaskStore(f.pool, limits)
  const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'report ownership', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Real report grant was not claimed')
  const selected = grant.selection.find(item => item.name === 'report-workflow-orchestrator')!
  const reviewer = grant.selection.find(item => item.name === 'report-reviewer')!
  await f.pool.query('DELETE FROM pe_builtin_skill_install_requests WHERE user_id=$1 AND catalog_id=$2', [f.alice.user.userId, 'builtin.report-reviewer'])
  expect((await skills.runtimeResourceBase(f.alice.user.userId, grant.selection, selected.skillId)).suiteAvailable).toBe(false)
  await skills.revoke(f.alice.user, reviewer.skillId)
  await skills.ensurePreinstalled(f.alice.user, ids)
  expect((await skills.read(f.alice.user, reviewer.skillId)).observedState).toBe('revoked')
  await expect(skills.runtimeResourceBase(f.alice.user.userId, grant.selection, selected.skillId)).rejects.toMatchObject({ code: 'skill_revoked' })
  await expect(skills.ensurePreinstalled(f.alice.user, ['builtin.missing'])).rejects.toMatchObject({ code: 'builtin_skill_not_found' })
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions WHERE user_id=$1', [f.alice.user.userId])).rows).n).toBe(4)
  expect((await skills.catalog(f.bob.user)).items.every(item => item.installedSkillId === null)).toBe(true)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test('published package corruption rejects selected reads and preserves damaged evidence after service restart', () => withSkills(async (f, skills, library) => {
  const word = (await skills.catalog(f.alice.user)).items.find(item => item.id === 'builtin.word')!
  const installed = publicSkill.parse(await skills.installBuiltin(f.alice.user, randomUUID(), word.id, word.version))
  const tasks = new TaskStore(f.pool, limits)
  const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'package corruption', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant || !installed.packageDigest) throw new Error('Real package grant was not claimed')
  const path = join(library, 'skill-packages', f.alice.user.userId, 'sha256', installed.packageDigest, 'skill/SKILL.md')
  const original = await readFile(path)
  await chmod(path, 0o600)
  const corrupt = Buffer.from(original); corrupt[0] = corrupt.readUInt8(0) ^ 1; await writeFile(path, corrupt); await chmod(path, 0o444)
  const resumed = new SkillService(f.pool, join(f.root, 'workspace'), library); await resumed.init()
  await expect(readRuntimeSkill(tasks, resumed, grant.token, installed.skillId)).rejects.toMatchObject({ code: 'skill_package_unavailable' })
  await expect(readRuntimeSkillResource(tasks, resumed, grant.token, installed.skillId)).rejects.toMatchObject({ code: 'skill_package_unavailable' })
  expect(await readFile(path)).toEqual(corrupt)
  await chmod(join(path, '..'), 0o700)
  await rm(path)
  await expect(resumed.read(f.alice.user, installed.skillId)).rejects.toMatchObject({ code: 'skill_package_unavailable' })
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions WHERE user_id=$1', [f.alice.user.userId])).rows).n).toBe(1)
}))

test('pending upload capacity, expiry and identity conflicts leave owned metadata and staging unchanged', () => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0')
  const requests: { id: string; ticket: string }[] = []
  for (let index = 0; index < 16; index++) {
    const id = randomUUID()
    const ticket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
    requests.push({ id, ticket: ticket.ticket })
  }
  await expect(skills.issueUploadTicket(f.alice.user, randomUUID(), bytes.length, hash(bytes), 'http://127.0.0.1'))
    .rejects.toMatchObject({ code: 'skill_upload_limit' })
  const original = firstValue(requests)
  await expect(skills.issueUploadTicket(f.alice.user, original.id, bytes.length + 1, hash(bytes), 'http://127.0.0.1'))
    .rejects.toMatchObject({ code: 'request_id_conflict' })
  await f.pool.query('UPDATE pe_skill_upload_intents SET expires_at=clock_timestamp()-interval \'1 second\' WHERE request_id=$1', [original.id])
  await expect(upload(skills, original.ticket, bytes)).rejects.toMatchObject({ code: 'invalid_upload_ticket' })
  const renewed = pending.parse(await skills.issueUploadTicket(f.alice.user, original.id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  expect(renewed.ticket).not.toBe(original.ticket)
  const textId = randomUUID()
  await skills.install(f.bob.user, textId, 'employee-seven-text', 'description', 'text')
  await expect(skills.issueUploadTicket(f.bob.user, textId, bytes.length, hash(bytes), 'http://127.0.0.1'))
    .rejects.toMatchObject({ code: 'request_id_conflict' })
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_upload_intents')).rows).n).toBe(16)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test('capacity, name collisions and missing package storage reject installation without producing partial records', () => withSkills(async (f, skills, library) => {
  const limited = new SkillService(f.pool, join(f.root, 'workspace'), library, 1, completeBuiltinIds); await limited.init()
  await limited.install(f.alice.user, randomUUID(), 'owned-text', 'description', 'original')
  await expect(limited.install(f.alice.user, randomUUID(), 'second', 'description', 'another')).rejects.toMatchObject({ code: 'skill_limit' })
  await expect(limited.install(f.alice.user, randomUUID(), 'owned-text', 'description', 'another')).rejects.toMatchObject({ code: 'skill_name_conflict' })
  const word = (await skills.catalog(f.alice.user)).items.find(item => item.id === 'builtin.word')!
  await expect(limited.installBuiltin(f.alice.user, randomUUID(), word.id, word.version)).rejects.toMatchObject({ code: 'skill_limit' })
  await expect(skills.installBuiltin(f.alice.user, randomUUID(), 'builtin.missing', '1.0.0')).rejects.toMatchObject({ code: 'builtin_skill_not_found' })
  const noPackages = new SkillService(f.pool, join(f.root, 'text-only')); await noPackages.init()
  await expect(noPackages.installBuiltin(f.bob.user, randomUUID(), word.id, word.version)).rejects.toMatchObject({ code: 'skill_package_unavailable' })
  const bytes = archive('1.0.0')
  await expect(noPackages.issueUploadTicket(f.bob.user, randomUUID(), bytes.length, hash(bytes), 'http://127.0.0.1'))
    .rejects.toMatchObject({ code: 'skill_package_unavailable' })
  expect((await skills.list(f.alice.user)).items).toHaveLength(1)
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions')).rows).n).toBe(0)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))

test('an account disabled after ticket issue cannot commit package bytes, and Bob remains able to upload', () => withSkills(async (f, skills, library) => {
  const bytes = archive('1.0.0')
  const id = randomUUID()
  const ticket = pending.parse(await skills.issueUploadTicket(f.alice.user, id, bytes.length, hash(bytes), 'http://127.0.0.1'))
  await f.pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.alice.user.userId])
  await expect(upload(skills, ticket.ticket, bytes)).rejects.toMatchObject({ status: 401, code: 'account_disabled' })
  expect(firstValue((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_skill_package_versions WHERE user_id=$1', [f.alice.user.userId])).rows).n).toBe(0)
  const bobTicket = pending.parse(await skills.issueUploadTicket(f.bob.user, randomUUID(), bytes.length, hash(bytes), 'http://127.0.0.1'))
  const bob = await upload(skills, bobTicket.ticket, bytes)
  expect(bob.created).toBe(true)
  expect((await skills.list(f.bob.user)).items).toHaveLength(1)
  expect(await readdir(join(library, 'skill-packages/.staging'))).toEqual([])
}))
