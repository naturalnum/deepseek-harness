/** Selected Skill resources are read as verified data without starting a cloud execution. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import { SkillService } from '../lib/platform/skills.js'
import { identity } from '../lib/contracts.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice2')
const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

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

function selected(item) {
  const { skillId, name, description, revision, kind, version, digest: instructionDigest,
    packageDigest, manifestDigest } = item
  return { skillId, name, description, revision, kind, version, digest: instructionDigest,
    packageDigest, manifestDigest }
}

test('readSelectedResource lists and reads only owned, intact UTF-8 files from the accepted version',
  { timeout: 120000 }, async t => {
    const database = `pe_s8_resources_${randomBytes(10).toString('hex')}`
    const root = await mkdtemp(join(tmpdir(), 'pe-s8-resources-'))
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
    const skills = new SkillService(pool, join(root, 'workspaces'), join(root, 'sandbox'))
    await skills.init()

    const grid = selected(await skills.installBuiltin(alice, randomUUID(),
      'builtin.power-grid-technical-report-writer', '1.1.31'))
    const bobGrid = selected(await skills.installBuiltin(bob, randomUUID(),
      'builtin.power-grid-technical-report-writer', '1.1.31'))
    const format = selected(await skills.installBuiltin(alice, randomUUID(),
      'builtin.tech-report-writer', '1.1.31'))
    const listed = await skills.readSelectedResource(alice.userId, grid)
    assert.equal(listed.kind, 'list')
    const rule = listed.files.find(file => file.path === 'references/chapter-summary.md')
    assert(rule)
    assert(listed.files.some(file => file.path === 'compiled-packs/20-outline.md'
      && file.size > 64 * 1024 && file.size < 256 * 1024))
    assert(listed.files.every(file => !file.path.startsWith('skill/')))
    const loaded = await skills.readSelectedResource(alice.userId, grid, rule.path)
    assert.equal(loaded.kind, 'text')
    assert.equal(loaded.path, rule.path)
    assert.equal(Buffer.byteLength(loaded.text), rule.size)
    assert.equal(digest(loaded.text), rule.sha256)
    assert.equal((await skills.readSelectedResource(alice.userId, grid,
      'compiled-packs/20-outline.md')).kind, 'text')
    await assert.rejects(skills.readSelectedResource(bob.userId, grid, rule.path),
      { status: 404, code: 'skill_not_found' })
    assert.equal((await skills.readSelectedResource(bob.userId, bobGrid, rule.path)).kind, 'text')
    for (const path of ['/etc/passwd', 'C:/Windows/system.ini', '../SKILL.md', 'references/../SKILL.md',
      'references\\chapter-summary.md', 'references/\0chapter-summary.md']) {
      await assert.rejects(skills.readSelectedResource(alice.userId, grid, path),
        { status: 400, code: 'invalid_skill_resource_path' })
    }
    await assert.rejects(skills.readSelectedResource(alice.userId, grid, 'references/missing.md'),
      { status: 404, code: 'skill_resource_not_found' })
    const binaryList = await skills.readSelectedResource(alice.userId, format)
    assert(binaryList.files.some(file => file.path === 'assets/report.docx'))
    await assert.rejects(skills.readSelectedResource(alice.userId, format, 'assets/report.docx'),
      { status: 415, code: 'skill_resource_not_text' })

    const textId = randomUUID()
    const text = selected(await skills.install(alice, textId, 'personal-note', 'Personal note', 'A small text Skill.'))
    assert.deepEqual(await skills.readSelectedResource(alice.userId, text), {
      kind: 'list', files: [{ path: 'SKILL.md', size: Buffer.byteLength('A small text Skill.'),
        sha256: digest('A small text Skill.') }] })
    assert.equal((await skills.readSelectedResource(alice.userId, text, 'SKILL.md')).text,
      'A small text Skill.')
    await assert.rejects(skills.readSelectedResource(alice.userId, text, 'other.md'),
      { status: 404, code: 'skill_resource_not_found' })

    const upgradeRoot = join(root, 'upgrade-source')
    await mkdir(join(upgradeRoot, 'new-grid'), { recursive: true })
    await writeFile(join(upgradeRoot, 'new-grid', 'SKILL.md'),
      '---\nname: power-grid-technical-report-writer\ndescription: Newer report package\n---\nNew version.\n')
    await writeFile(join(upgradeRoot, 'new-grid', 'skill-package.json'),
      JSON.stringify({ schemaVersion: 1, version: '1.1.32' }))
    const upgradePath = join(upgradeRoot, 'upgrade.zip')
    execFileSync('zip', ['-q', '-r', '-X', upgradePath, 'new-grid'], { cwd: upgradeRoot })
    const upgradeArchive = await readFile(upgradePath)
    const upgradeTicket = await skills.issueUploadTicket(alice, randomUUID(), upgradeArchive.length,
      digest(upgradeArchive), 'http://127.0.0.1:18881')
    const upgraded = (await skills.upload(upgradeTicket.ticket, Readable.from([upgradeArchive]))).item
    assert.equal(upgraded.skillId, grid.skillId)
    assert.equal(upgraded.version, '1.1.32')
    assert.equal((await skills.readSelectedResource(alice.userId, grid, rule.path)).text, loaded.text)

    const source = join(root, 'oversize-source')
    await mkdir(join(source, 'big-skill'), { recursive: true })
    await writeFile(join(source, 'big-skill', 'SKILL.md'),
      '---\nname: big-resource\ndescription: Large resource fixture\n---\nRead reference when needed.\n')
    const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM reference')])
    await writeFile(join(source, 'big-skill', 'bom.md'), bomBytes)
    await writeFile(join(source, 'big-skill', 'large.md'), 'a'.repeat(256 * 1024 + 1))
    const archivePath = join(source, 'big.zip')
    execFileSync('zip', ['-q', '-r', '-X', archivePath, 'big-skill'], { cwd: source })
    const archive = await readFile(archivePath)
    const ticket = await skills.issueUploadTicket(alice, randomUUID(), archive.length, digest(archive),
      'http://127.0.0.1:18881')
    const big = selected((await skills.upload(ticket.ticket, Readable.from([archive]))).item)
    const bigFiles = (await skills.readSelectedResource(alice.userId, big)).files
    assert(bigFiles.some(file => file.path === 'large.md'))
    assert.deepEqual(bigFiles.find(file => file.path === 'bom.md'),
      { path: 'bom.md', size: bomBytes.length, sha256: digest(bomBytes) })
    const bom = await skills.readSelectedResource(alice.userId, big, 'bom.md')
    assert.equal(bom.kind, 'text')
    assert.equal(bom.text, '\uFEFFBOM reference')
    assert.equal(Buffer.byteLength(bom.text), bomBytes.length)
    assert.equal(digest(bom.text), bom.sha256)
    await assert.rejects(skills.readSelectedResource(alice.userId, big, 'large.md'),
      { status: 413, code: 'skill_resource_too_large' })

    await skills.toggle(alice, grid.skillId, false)
    assert.equal((await skills.readSelectedResource(alice.userId, grid, rule.path)).kind, 'text')
    const published = join(root, 'sandbox', 'skill-packages', alice.userId, 'sha256', grid.packageDigest,
      'skill', rule.path)
    await chmod(published, 0o600)
    await writeFile(published, 'modified source')
    await assert.rejects(skills.readSelectedResource(alice.userId, grid, rule.path),
      { status: 503, code: 'skill_package_unavailable' })
    const bobPublished = join(root, 'sandbox', 'skill-packages', bob.userId, 'sha256', bobGrid.packageDigest,
      'skill', rule.path)
    await chmod(join(root, 'sandbox', 'skill-packages', bob.userId, 'sha256', bobGrid.packageDigest,
      'skill', 'references'), 0o755)
    await rm(bobPublished)
    await writeFile(join(root, 'outside.txt'), 'outside')
    await symlink(join(root, 'outside.txt'), bobPublished)
    await assert.rejects(skills.readSelectedResource(bob.userId, bobGrid, rule.path),
      { status: 503, code: 'skill_package_unavailable' })
    await skills.revoke(alice, grid.skillId)
    await assert.rejects(skills.readSelectedResource(alice.userId, grid),
      { status: 409, code: 'skill_revoked' })
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_cloud_executions')).rows[0].n, 0)
  })
