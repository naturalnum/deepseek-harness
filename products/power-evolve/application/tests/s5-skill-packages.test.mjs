/** Real PostgreSQL and POSIX exercise for the browser ticket and immutable Skill package lane. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import * as migrations from '../lib/platform/schema.js'
import { SkillService } from '../lib/platform/skills.js'
import { identity } from '../lib/contracts.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice2')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

test('existing v11 database upgrades once and v14 restart is inert', { timeout: 30000 }, async t => {
  const database = `pe_s5_upgrade_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  let pool
  t.after(async () => {
    await pool?.end()
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    await admin.end()
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(databaseUrl)
  url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 2 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(migrations.schema)
    await client.query('INSERT INTO pe_schema(version) VALUES(1)')
    for (let version = 2; version <= 11; version++) await client.query(migrations[`schemaV${version}`])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
  await initializeDatabase(pool)
  await initializeDatabase(pool)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 19)
  assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM information_schema.tables
    WHERE table_name IN ('pe_skill_package_versions','pe_skill_upload_intents')`)).rows[0].n, 2)
})

async function packageBytes(root, version, script) {
  const source = await mkdtemp(join(root, 'source-'))
  const skill = join(source, 'sample-skill')
  await mkdir(join(skill, 'scripts'), { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '---\nname: sample-skill\ndescription: Runs a sample script\n---\nRun scripts/run.sh in the cloud sandbox.\n')
  if (version !== null) await writeFile(join(skill, 'skill-package.json'), JSON.stringify({ schemaVersion: 1, version }))
  await writeFile(join(skill, 'scripts', 'run.sh'), `#!/bin/sh\nprintf '${script}\\n'\n`)
  await chmod(join(skill, 'scripts', 'run.sh'), 0o755)
  const archive = join(source, 'package.zip')
  execFileSync('zip', ['-q', '-r', '-X', archive, 'sample-skill'], { cwd: source })
  return await readFile(archive)
}

async function addUser(pool, username) {
  const id = randomUUID()
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [id, username, 'test-only', { model: 'fixture', maxTokens: 100, revision: 1 }])
  return identity.parse({ userId: id, username })
}

async function cleanupRoot(path) {
  const writable = async directory => {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name))
    }
  }
  await writable(path)
  await rm(path, { recursive: true, force: true })
}

test('ZIP ticket installs exact user version, retries by request ID, and preserves frozen bytes', { timeout: 60000 }, async t => {
  const database = `pe_s5_skills_${randomBytes(10).toString('hex')}`
  const root = await mkdtemp(join(tmpdir(), 'pe-s5-skills-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  let pool
  let created = false
  t.after(async () => {
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    await admin.end()
    await cleanupRoot(root)
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  const url = new URL(databaseUrl)
  url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 5 })
  await initializeDatabase(pool)
  await initializeDatabase(pool)
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 19)

  const alice = await addUser(pool, 'alice')
  const bob = await addUser(pool, 'bob')
  const charlie = await addUser(pool, 'charlie')
  const skills = new SkillService(pool, join(root, 'workspaces'), join(root, 'sandbox'))
  await skills.init()
  const first = await packageBytes(root, '1.0.0', 'first')
  const firstDigest = createHash('sha256').update(first).digest('hex')
  const racedId = randomUUID()
  const raced = await Promise.allSettled([
    skills.issueUploadTicket(alice, racedId, first.length, firstDigest, 'http://127.0.0.1:18881'),
    skills.issueUploadTicket(bob, racedId, first.length, firstDigest, 'http://127.0.0.1:18881'),
  ])
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(raced.filter(result => result.status === 'rejected').length, 1)
  assert.equal(raced.find(result => result.status === 'rejected').reason.code, 'request_id_conflict')
  const firstId = randomUUID()
  const ticket = await skills.issueUploadTicket(alice, firstId, first.length, firstDigest, 'http://127.0.0.1:18881')
  assert.equal(ticket.state, 'pending')
  assert.equal(ticket.uploadUrl, 'http://127.0.0.1:18881/skills/upload')
  await assert.rejects(skills.issueUploadTicket(bob, firstId, first.length, firstDigest,
    'http://127.0.0.1:18881'), { status: 409, code: 'request_id_conflict' })
  const installed = await skills.upload(ticket.ticket, Readable.from([first]))
  assert.equal(installed.created, true)
  assert.equal(installed.item.version, '1.0.0')
  assert.equal(installed.item.kind, 'package')
  assert.equal(installed.item.packageDigest, firstDigest)
  assert.equal(installed.item.observedState, 'ready')
  await assert.rejects(skills.upload(ticket.ticket, Readable.from([first])),
    { status: 401, code: 'invalid_upload_ticket' })
  const published = join(root, 'sandbox', 'skill-packages', alice.userId, 'sha256', firstDigest, 'skill')
  assert.equal((await lstat(published)).isDirectory(), true)
  assert.equal((await lstat(join(root, 'sandbox', 'skill-packages', alice.userId))).mode & 0o005, 0o005)
  assert.equal((await lstat(published)).mode & 0o005, 0o005)
  assert.equal((await lstat(join(published, 'SKILL.md'))).mode & 0o004, 0o004)
  assert.equal((await lstat(join(published, 'scripts', 'run.sh'))).mode & 0o005, 0o005)
  const orphanParent = join(root, 'sandbox', 'skill-packages', charlie.userId, 'sha256')
  await mkdir(orphanParent, { recursive: true, mode: 0o755 })
  const orphan = join(orphanParent, firstDigest)
  await cp(join(root, 'sandbox', 'skill-packages', alice.userId, 'sha256', firstDigest), orphan,
    { recursive: true })
  await chmod(orphan, 0o700)
  const orphanId = randomUUID()
  const orphanTicket = await skills.issueUploadTicket(charlie, orphanId, first.length, firstDigest,
    'http://127.0.0.1:18881')
  const reconciledOrphan = await skills.upload(orphanTicket.ticket, Readable.from([first]))
  assert.equal(reconciledOrphan.item.packageDigest, firstDigest)
  assert.equal((await lstat(orphan)).mode & 0o005, 0o005)
  assert.equal((await skills.list(bob)).items.length, 0)
  await assert.rejects(skills.read(bob, firstId), { status: 404, code: 'skill_not_found' })
  const read = await skills.read(alice, firstId)
  assert.match(read.instructions, /Run scripts\/run.sh/)
  assert.equal(read.manifestDigest, installed.item.manifestDigest)
  const reconciled = await skills.issueUploadTicket(alice, firstId, first.length, firstDigest, 'http://127.0.0.1:18881')
  assert.equal(reconciled.state, 'ready')
  assert.equal(reconciled.item.packageDigest, firstDigest)
  await assert.rejects(skills.issueUploadTicket(alice, firstId, first.length, '0'.repeat(64),
    'http://127.0.0.1:18881'), { status: 409, code: 'request_id_conflict' })

  const frozen = { skillId: firstId, name: read.name, description: read.description, digest: read.digest,
    revision: read.revision, kind: 'package', version: read.version, packageDigest: read.packageDigest,
    manifestDigest: read.manifestDigest }
  const second = await packageBytes(root, '1.0.1', 'second')
  const secondDigest = createHash('sha256').update(second).digest('hex')
  const secondId = randomUUID()
  const secondTicket = await skills.issueUploadTicket(alice, secondId, second.length, secondDigest,
    'http://127.0.0.1:18881')
  const upgraded = await skills.upload(secondTicket.ticket, Readable.from([second]))
  assert.equal(upgraded.item.skillId, firstId)
  assert.equal(upgraded.item.version, '1.0.1')
  assert.equal(upgraded.item.packageDigest, secondDigest)
  const conflicting = await packageBytes(root, '1.0.1', 'changed-without-version-bump')
  const conflictTicket = await skills.issueUploadTicket(alice, randomUUID(), conflicting.length,
    createHash('sha256').update(conflicting).digest('hex'), 'http://127.0.0.1:18881')
  await assert.rejects(skills.upload(conflictTicket.ticket, Readable.from([conflicting])),
    { status: 409, code: 'skill_version_conflict' })
  assert.equal((await skills.snapshot(alice.userId, [frozen]))[0].packageDigest, firstDigest)

  const unversioned = await packageBytes(root, null, 'bob-only')
  const bobDigest = createHash('sha256').update(unversioned).digest('hex')
  const bobId = randomUUID()
  const bobTicket = await skills.issueUploadTicket(bob, bobId, unversioned.length, bobDigest,
    'http://127.0.0.1:18881')
  const bobPackage = await skills.upload(bobTicket.ticket, Readable.from([unversioned]))
  assert.equal(bobPackage.item.version, `sha256:${bobDigest}`)
  assert.equal((await skills.list(bob)).items.length, 1)
  assert.equal((await skills.list(alice)).items.length, 1)
  assert.equal((await skills.read(alice, firstId)).packageDigest, secondDigest)
  const oldRetry = await skills.issueUploadTicket(alice, firstId, first.length, firstDigest,
    'http://127.0.0.1:18881')
  assert.equal(oldRetry.item.packageDigest, firstDigest)
  await assert.rejects(skills.toggle(bob, firstId, false), { status: 404, code: 'skill_not_found' })
  await skills.toggle(alice, firstId, false)
  assert.equal((await skills.list(alice)).items[0].enabled, false)
  const revoked = await skills.revoke(alice, firstId)
  assert.equal(revoked.observedState, 'revoked')
  await assert.rejects(skills.toggle(alice, firstId, true), { status: 409, code: 'skill_revoked' })
  assert.equal((await skills.snapshot(alice.userId, [frozen]))[0].packageDigest, firstDigest)

  const badId = randomUUID()
  const bad = Buffer.from('not a zip')
  const badDigest = createHash('sha256').update(bad).digest('hex')
  const badTicket = await skills.issueUploadTicket(alice, badId, bad.length, badDigest, 'http://127.0.0.1:18881')
  await assert.rejects(skills.upload(badTicket.ticket, Readable.from([bad])),
    { status: 400, code: 'invalid_skill_package' })
  const unsafeSource = await mkdtemp(join(root, 'unsafe-'))
  await mkdir(join(unsafeSource, 'sample-skill'))
  await writeFile(join(unsafeSource, 'sample-skill', 'SKILL.md'),
    '---\nname: unsafe-skill\ndescription: Invalid link\n---\nDo not install.\n')
  await symlink('../../outside', join(unsafeSource, 'sample-skill', 'escape'))
  const unsafeArchive = join(unsafeSource, 'unsafe.zip')
  execFileSync('zip', ['-q', '-r', '-y', unsafeArchive, 'sample-skill'], { cwd: unsafeSource })
  const unsafe = await readFile(unsafeArchive)
  const unsafeDigest = createHash('sha256').update(unsafe).digest('hex')
  const unsafeId = randomUUID()
  const unsafeTicket = await skills.issueUploadTicket(alice, unsafeId, unsafe.length, unsafeDigest,
    'http://127.0.0.1:18881')
  await assert.rejects(skills.upload(unsafeTicket.ticket, Readable.from([unsafe])),
    { status: 400, code: 'invalid_skill_package' })
  const bombSource = await mkdtemp(join(root, 'bomb-'))
  await mkdir(join(bombSource, 'sample-skill', 'scripts'), { recursive: true })
  await writeFile(join(bombSource, 'sample-skill', 'SKILL.md'),
    '---\nname: bomb-skill\ndescription: Oversized expansion\n---\nDo not install.\n')
  await writeFile(join(bombSource, 'sample-skill', 'scripts', 'huge.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 65))
  const bombArchive = join(bombSource, 'bomb.zip')
  execFileSync('zip', ['-q', '-r', '-X', bombArchive, 'sample-skill'], { cwd: bombSource })
  const bomb = await readFile(bombArchive)
  assert.ok(bomb.length < 1024 * 1024)
  const bombId = randomUUID()
  const bombTicket = await skills.issueUploadTicket(alice, bombId, bomb.length,
    createHash('sha256').update(bomb).digest('hex'), 'http://127.0.0.1:18881')
  await assert.rejects(skills.upload(bombTicket.ticket, Readable.from([bomb])),
    { status: 400, code: 'invalid_skill_package' })
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_skill_package_versions')).rows[0].n, 4)
  assert.equal((await skills.list(alice)).items.length, 1)

  const textOnly = new SkillService(pool, join(root, 'text-only'))
  await textOnly.init()
  const text = await textOnly.install(alice, randomUUID(), 'text-helper', 'Text description', 'Text instructions')
  assert.equal(text.kind, 'text')
  assert.equal(text.version, null)
  await assert.rejects(textOnly.issueUploadTicket(alice, randomUUID(), first.length, firstDigest,
    'http://127.0.0.1:18881'), { status: 503, code: 'skill_package_unavailable' })
})
