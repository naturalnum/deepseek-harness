/** Built-in Skills use the real per-user package publisher and isolated PostgreSQL state. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import { SkillService } from '../lib/platform/skills.js'
import { identity } from '../lib/contracts.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice2')
const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

async function addUser(pool, username) {
  const userId = randomUUID()
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [userId, username, 'test-only', { model: 'fixture', maxTokens: 100, revision: 1 }])
  return identity.parse({ userId, username })
}

async function cleanupRoot(path) {
  const writable = async directory => {
    let stat
    try { stat = await lstat(directory) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name))
    }
  }
  await writable(path)
  await rm(path, { recursive: true, force: true })
}

test('built-in catalog and installs isolate users, bind requests, and preserve disabled or revoked history',
  { timeout: 120000 }, async t => {
    const database = `pe_s8_builtin_${randomBytes(10).toString('hex')}`
    const root = await mkdtemp(join(tmpdir(), 'pe-s8-platform-'))
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
    const alice = await addUser(pool, 'alice')
    const bob = await addUser(pool, 'bob')
    const charlie = await addUser(pool, 'charlie')
    const dana = await addUser(pool, 'dana')
    const skills = new SkillService(pool, join(root, 'workspaces'), join(root, 'sandbox'))
    await skills.init()

    const initial = await skills.catalog(alice)
    assert.equal(initial.items.length, 9)
    assert(initial.items.every(item => item.installedSkillId === null))
    assert(!JSON.stringify(initial).includes(root))
    assert.deepEqual((await skills.catalog(bob)).items, initial.items)

    const requestId = randomUUID()
    const word = await skills.installBuiltin(alice, requestId, 'builtin.word', '1.0.1')
    assert.equal(word.kind, 'package')
    assert.equal(word.version, '1.0.1')
    assert.equal((await skills.catalog(alice)).items.find(item => item.id === 'builtin.word').installedSkillId,
      word.skillId)
    assert.equal((await skills.catalog(bob)).items.find(item => item.id === 'builtin.word').installedSkillId,
      null)
    assert.deepEqual(await skills.installBuiltin(alice, requestId, 'builtin.word', '1.0.1'), word)
    await assert.rejects(skills.installBuiltin(alice, requestId, 'builtin.pdf', '1.0.0'),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(skills.installBuiltin(alice, requestId, 'builtin.word', '9.0.0'),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(skills.installBuiltin(bob, requestId, 'builtin.word', '1.0.1'),
      { status: 409, code: 'request_id_conflict' })
    const aliasRequestId = randomUUID()
    const alias = await skills.installBuiltin(alice, aliasRequestId, 'builtin.word', '1.0.1')
    assert.equal(alias.skillId, word.skillId)
    const wordRelease = initial.items.find(item => item.id === 'builtin.word')
    await assert.rejects(skills.issueUploadTicket(alice, aliasRequestId, wordRelease.archiveSize,
      wordRelease.archiveDigest, 'http://127.0.0.1:18881'),
    { status: 409, code: 'request_id_conflict' })
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_skill_package_versions WHERE user_id=$1',
      [alice.userId])).rows[0].n, 1)
    const bobWord = await skills.installBuiltin(bob, randomUUID(), 'builtin.word', '1.0.1')
    assert.notEqual(bobWord.skillId, word.skillId)
    await assert.rejects(skills.readSelected(bob.userId, { ...word, skillId: word.skillId }, word.skillId),
      { status: 404, code: 'skill_not_found' })

    const accepted = { skillId: word.skillId, name: word.name, description: word.description,
      revision: word.revision, kind: 'package', version: word.version, digest: word.digest,
      packageDigest: word.packageDigest, manifestDigest: word.manifestDigest }
    const loaded = await skills.readSelected(alice.userId, accepted, word.skillId)
    assert.match(loaded.instructions, /Word documents/)
    await skills.toggle(alice, word.skillId, false)
    assert.equal((await skills.readSelected(alice.userId, accepted, word.skillId)).instructions,
      loaded.instructions)
    await skills.revoke(alice, word.skillId)
    await assert.rejects(skills.readSelected(alice.userId, accepted, word.skillId),
      { status: 409, code: 'skill_revoked' })
    await skills.ensurePreinstalled(alice, ['builtin.word', 'builtin.pdf'])
    assert.equal((await skills.list(alice)).items.length, 2)
    assert.equal((await skills.list(alice)).items.find(item => item.skillId === word.skillId).observedState,
      'revoked')
    const pdf = (await skills.list(alice)).items.find(item => item.name !== word.name)
    await skills.toggle(alice, pdf.skillId, false)
    const restarted = new SkillService(pool, join(root, 'workspaces'), join(root, 'sandbox'))
    await restarted.init()
    await restarted.ensurePreinstalled(alice, ['builtin.word', 'builtin.pdf'])
    const afterRestart = (await restarted.list(alice)).items
    assert.equal(afterRestart.length, 2)
    assert.equal(afterRestart.find(item => item.skillId === word.skillId).observedState, 'revoked')
    assert.equal(afterRestart.find(item => item.skillId === pdf.skillId).enabled, false)

    const manualRoot = join(root, 'manual-source')
    await mkdir(join(manualRoot, 'custom-pdf'), { recursive: true })
    await writeFile(join(manualRoot, 'custom-pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: User PDF package\n---\nKeep the user package.\n')
    await writeFile(join(manualRoot, 'custom-pdf', 'skill-package.json'),
      JSON.stringify({ schemaVersion: 1, version: '2.0.0' }))
    const archivePath = join(manualRoot, 'custom.zip')
    execFileSync('zip', ['-q', '-r', '-X', archivePath, 'custom-pdf'], { cwd: manualRoot })
    const manualArchive = await readFile(archivePath)
    const manualDigest = createHash('sha256').update(manualArchive).digest('hex')
    const manualTicket = await skills.issueUploadTicket(dana, randomUUID(), manualArchive.length,
      manualDigest, 'http://127.0.0.1:18881')
    const manual = await skills.upload(manualTicket.ticket, Readable.from([manualArchive]))
    await skills.ensurePreinstalled(dana, ['builtin.pdf'])
    assert.equal((await skills.list(dana)).items.length, 1)
    assert.equal((await skills.list(dana)).items[0].skillId, manual.item.skillId)
    assert.equal((await skills.list(dana)).items[0].packageDigest, manualDigest)
    await assert.rejects(skills.installBuiltin(dana, randomUUID(), 'builtin.pdf', '1.0.0'),
      { status: 409, code: 'skill_name_conflict' })

    // A historical catalog fixture uses real imported bytes and PG receipts. It
    // exercises upgrades without changing the production catalog trust root.
    const upgradedUser = await addUser(pool, 'upgrade-owner')
    const oldRoot = join(root, 'old-release')
    await mkdir(join(oldRoot, 'pdf'), { recursive: true })
    await writeFile(join(oldRoot, 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: Previous PDF release\n---\nImmutable previous instructions.\n')
    await writeFile(join(oldRoot, 'pdf', 'skill-package.json'),
      JSON.stringify({ schemaVersion: 1, version: '0.9.0' }))
    const oldZip = join(oldRoot, 'old.zip')
    execFileSync('zip', ['-q', '-r', '-X', oldZip, 'pdf'], { cwd: oldRoot })
    const oldBytes = await readFile(oldZip)
    const oldDigest = createHash('sha256').update(oldBytes).digest('hex')
    const oldRequest = randomUUID()
    const oldTicket = await skills.issueUploadTicket(upgradedUser, oldRequest, oldBytes.length,
      oldDigest, 'http://127.0.0.1:18881')
    const old = (await skills.upload(oldTicket.ticket, Readable.from([oldBytes]))).item
    await pool.query(`INSERT INTO pe_builtin_skill_install_requests
      (request_id,user_id,catalog_id,version,archive_digest,package_version_id)
      VALUES($1,$2,'builtin.pdf','0.9.0',$3,$4)`,
    [randomUUID(), upgradedUser.userId, oldDigest, oldRequest])
    await skills.toggle(upgradedUser, old.skillId, false)
    await skills.ensurePreinstalled(upgradedUser, ['builtin.pdf'])
    assert.equal((await skills.list(upgradedUser)).items[0].version, '0.9.0')
    const disabledRevision = (await skills.list(upgradedUser)).items[0].revision
    const upgradeId = randomUUID()
    const upgraded = await skills.installBuiltin(upgradedUser, upgradeId, 'builtin.pdf', '1.0.0')
    assert.equal(upgraded.skillId, old.skillId)
    assert.equal(upgraded.version, '1.0.0')
    assert.equal(upgraded.enabled, false)
    assert.equal(upgraded.revision, disabledRevision + 1)
    assert.equal((await skills.list(upgradedUser)).items.length, 1)
    assert.match((await skills.readSelected(upgradedUser.userId, old, old.skillId)).instructions,
      /Immutable previous instructions/)
    assert.deepEqual(await skills.installBuiltin(upgradedUser, upgradeId, 'builtin.pdf', '1.0.0'), upgraded)
    assert.equal((await skills.catalog(upgradedUser)).items.find(item => item.id === 'builtin.pdf').installedSkillId,
      old.skillId)

    const racedRequestId = randomUUID()
    const raced = await Promise.allSettled([
      skills.installBuiltin(bob, racedRequestId, 'builtin.excel', '1.0.1'),
      skills.installBuiltin(charlie, racedRequestId, 'builtin.excel', '1.0.1'),
    ])
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(raced.filter(result => result.status === 'rejected').length, 1)
    assert.equal(raced.find(result => result.status === 'rejected').reason.code, 'request_id_conflict')

    const ids = initial.items.map(item => item.id)
    await skills.ensurePreinstalled(charlie, ids)
    assert.equal((await skills.list(charlie)).items.length, 9)
    assert.equal((await skills.catalog(charlie)).items.filter(item => item.installedSkillId).length, 9)
    await assert.rejects(skills.installBuiltin(charlie, randomUUID(), 'builtin.missing', '1.0.0'),
      { status: 404, code: 'builtin_skill_not_found' })
    const capped = new SkillService(pool, join(root, 'workspaces'), join(root, 'sandbox'), 9)
    await assert.rejects(capped.install(charlie, randomUUID(), 'extra', 'extra', 'extra'),
      { status: 413, code: 'skill_limit' })
  })
