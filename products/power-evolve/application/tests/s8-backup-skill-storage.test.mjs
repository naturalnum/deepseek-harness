/** Real PG dump/restore and the trial's storage mapping retain every immutable Skill version. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import { SkillService } from '../lib/platform/skills.js'
import { backupSourceRoots, copyPosixTree, prepareRestoredSkillMounts, requireSkillPackageVersions,
  resolveTrialStorage, trialDataPath } from '../../scripts/backup-posix.mjs'

const repository = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const image = process.env.PE_TEST_BACKUP_POSTGRES_IMAGE
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const trees = ['workspaces', 'homes', 'skill-packages', 'artifacts']

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: repository, timeout: 60000,
    maxBuffer: 16 * 1024 * 1024, ...options })
  assert.equal(result.error, undefined, `${executable} must complete without an execution error`)
  assert.equal(result.signal, null, `${executable} must complete without being killed`)
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr?.toString().slice(-2000)}`)
  return result.stdout
}

async function cleanup(path) {
  const writable = async directory => {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(directory, 0o700)
    for (const name of await readdir(directory)) await writable(join(directory, name))
  }
  await writable(path)
  await rm(path, { recursive: true, force: true })
}

async function inventory(root) {
  const entries = []
  const walk = async (path, relative) => {
    const stat = await lstat(path)
    if (stat.isDirectory()) {
      entries.push({ path: relative, mode: stat.mode & 0o7777 })
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`)
    } else {
      assert(stat.isFile())
      entries.push({ path: relative, mode: stat.mode & 0o7777, size: stat.size, sha256: hash(await readFile(path)) })
    }
  }
  await walk(root, '')
  return entries
}

function selection(item) {
  const { skillId, name, description, revision, kind, version, digest,
    packageDigest, manifestDigest } = item
  return { skillId, name, description, revision, kind, version, digest, packageDigest, manifestDigest }
}

async function prepare(privateDir, name, override = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PE_PRIVATE_DIR: privateDir,
    PE_TRIAL_NAME: name, DEEPSEEK_API_KEY: 'fixture-only-unused-model-key', ...override }
  command(process.execPath, ['products/power-evolve/scripts/prepare-trial.mjs'], { env })
  const storage = await resolveTrialStorage(privateDir, null, {}, true)
  const profile = await readFile(join(repository, '.artifacts/power-evolve', name,
    'trial/platform/profiles/power-evolve-platform/cordis.patch.yml'), 'utf8')
  for (const field of ['workspaceRoot', 'artifactRoot', 'skillLibraryRoot']) {
    assert(profile.includes(`    ${field}: ${JSON.stringify(storage[field])}\n`))
  }
  return storage
}

async function upload(skills, user, root, version, body) {
  const directory = join(root, `upload-${version}`)
  await mkdir(directory)
  await writeFile(join(directory, 'SKILL.md'), `---\nname: retained-note\ndescription: Historical upload\n---\n${body}\n`)
  await writeFile(join(directory, 'skill-package.json'), JSON.stringify({ schemaVersion: 1, version }))
  const zip = join(root, `upload-${version}.zip`)
  command('zip', ['-q', '-X', zip, 'SKILL.md', 'skill-package.json'], { cwd: directory })
  const bytes = await readFile(zip)
  const ticket = await skills.issueUploadTicket(user, randomUUID(), bytes.length, hash(bytes), 'http://127.0.0.1:18881')
  return selection((await skills.upload(ticket.ticket, Readable.from([bytes]))).item)
}

test('custom no-Sandbox storage restores old, disabled, revoked and report-suite bytes with PG receipts',
  { skip: !image && 'Set PE_TEST_BACKUP_POSTGRES_IMAGE to an available PostgreSQL image', timeout: 120000 },
  async t => {
    const base = join(homedir(), '.config/power-evolve')
    await mkdir(base, { recursive: true, mode: 0o700 })
    const root = await mkdtemp(join(base, 's8-backup-storage-'))
    const suffix = randomBytes(6).toString('hex')
    const sourceName = `s8backup-${suffix}-src`, targetName = `s8backup-${suffix}-dst`
    const legacyName = `s8backup-${suffix}-legacy`
    const container = `pe-backup-storage-${suffix}`
    const sourcePrivate = join(root, 'source'), targetPrivate = join(root, 'target')
    let admin, sourcePool, targetPool, legacyPool, acquired = false
    t.after(async () => {
      await Promise.all([sourcePool?.end(), targetPool?.end(), legacyPool?.end(), admin?.end()])
      if (acquired) command('docker', ['rm', '-f', '-v', container])
      await cleanup(root)
      for (const name of [sourceName, targetName, legacyName]) {
        await rm(join(repository, '.artifacts/power-evolve', name), { recursive: true, force: true })
      }
    })
    await mkdir(sourcePrivate)
    await mkdir(targetPrivate)
    const source = await prepare(sourcePrivate, sourceName,
      { PE_SKILL_LIBRARY_ROOT: join(root, 'custom-source-library') })
    assert.deepEqual(await prepare(sourcePrivate, sourceName), source)
    const envFile = join(root, 'postgres.env')
    const password = randomBytes(24).toString('base64url')
    await writeFile(envFile, `POSTGRES_USER=powerevolve\nPOSTGRES_DB=powerevolve\nPOSTGRES_PASSWORD=${password}\n`,
      { flag: 'wx', mode: 0o600 })
    command('docker', ['run', '-d', '--name', container, '--env-file', envFile,
      '--tmpfs', '/var/lib/postgresql/data', '-p', '127.0.0.1::5432', image])
    acquired = true
    const port = Number(command('docker', ['port', container, '5432/tcp']).toString().trim().split(':').at(-1))
    const databaseUrl = new URL(`postgresql://powerevolve@127.0.0.1:${port}/powerevolve`)
    databaseUrl.password = password
    admin = new Pool({ connectionString: databaseUrl.href, max: 1, connectionTimeoutMillis: 500 })
    const deadline = Date.now() + 30000
    for (;;) {
      try { await admin.query('SELECT 1'); break }
      catch (error) { if (Date.now() >= deadline) throw error; await delay(100) }
    }
    await admin.query('CREATE DATABASE backup_source')
    await admin.query('CREATE DATABASE backup_target')
    const sourceUrl = new URL(databaseUrl), targetUrl = new URL(databaseUrl)
    sourceUrl.pathname = '/backup_source'; targetUrl.pathname = '/backup_target'
    sourcePool = new Pool({ connectionString: sourceUrl.href, max: 2 })
    await initializeDatabase(sourcePool)
    const user = { userId: randomUUID(), username: 'alice' }
    await sourcePool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 100, revision: 1 }])
    // Terminal rows are storage fixtures; this backup drill executes no commands.
    const workspaceId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID(), executionId = randomUUID()
    const output = { stdout: '\u0000表😀', stderr: 'literal \\u0000', exitCode: 0 }
    await sourcePool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspaceId, user.userId])
    await sourcePool.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header)
      VALUES($1,$2,$3,$4,'{}')`, [sessionId, user.userId, workspaceId, randomUUID()])
    await sourcePool.query(`INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
      VALUES($1,$2,$3,'backup storage fixture','{}','completed')`, [operationId, sessionId, randomUUID()])
    await sourcePool.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,0,$2)', [sessionId, output])
    await sourcePool.query(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,
      request_digest,state,result) VALUES($1,$2,$3,$4,'fixture','true','','digest','succeeded',$5)`,
    [executionId, user.userId, sessionId, operationId, output])
    const skills = new SkillService(sourcePool, source.workspaceRoot, source.skillLibraryRoot)
    await skills.init()
    const reports = []
    for (const [id, version] of [
      ['builtin.report-workflow-orchestrator', '1.1.27'],
      ['builtin.power-grid-technical-report-writer', '1.1.37'],
      ['builtin.report-reviewer', '1.1.0'], ['builtin.tech-report-writer', '1.1.39'],
    ]) reports.push(selection(await skills.installBuiltin(user, randomUUID(), id, version)))
    const suite = await skills.runtimeResourceBase(user.userId, reports, reports[0].skillId)
    assert.equal(suite.suiteAvailable, true)
    const word = selection(await skills.installBuiltin(user, randomUUID(), 'builtin.word', '1.0.2'))
    await skills.toggle(user, word.skillId, false)
    const revoked = selection(await skills.installBuiltin(user, randomUUID(), 'builtin.pdf', '1.0.0'))
    await skills.revoke(user, revoked.skillId)
    const old = await upload(skills, user, root, '1.0.0', 'Original historical instructions.')
    const current = await upload(skills, user, root, '2.0.0', 'New current instructions.')
    const oldRead = await skills.readSelected(user.userId, old, old.skillId)
    const packages = (await sourcePool.query(
      'SELECT user_id,archive_digest,manifest_digest,manifest FROM pe_skill_package_versions ORDER BY id')).rows
    const receipts = (await sourcePool.query('SELECT * FROM pe_builtin_skill_install_requests ORDER BY request_id')).rows
    const versions = (await sourcePool.query('SELECT * FROM pe_skill_package_versions ORDER BY id')).rows
    const originalTree = await inventory(trialDataPath(source, 'skill-packages'))
    await requireSkillPackageVersions(trialDataPath(source, 'skill-packages'), packages)
    const omitted = join(root, 'original-bug')
    await copyPosixTree(join(sourcePrivate, 'skill-packages'), omitted)
    await assert.rejects(requireSkillPackageVersions(omitted, packages), { code: 'ENOENT' })
    const bundle = join(root, 'bundle')
    await mkdir(join(bundle, 'data'), { recursive: true })
    for (const name of trees) await copyPosixTree(trialDataPath(source, name), join(bundle, 'data', name))
    const dump = command('docker', ['exec', container, 'pg_dump', '-U', 'powerevolve', '-d', 'backup_source',
      '--format=custom', '--no-owner', '--no-acl'])
    await writeFile(join(bundle, 'database.dump'), dump, { flag: 'wx', mode: 0o600 })
    const manifest = { format: 2, sourceSharedRoot: source.sharedRoot, storage: source }
    assert(backupSourceRoots(manifest).includes(source.skillLibraryRoot))
    const target = await resolveTrialStorage(targetPrivate, null, {})
    assert.equal(target.skillLibraryRoot, join(targetPrivate, 'skill-library'))
    for (const name of trees) {
      const path = trialDataPath(target, name)
      await mkdir(dirname(path), { recursive: true })
      await copyPosixTree(join(bundle, 'data', name), path)
    }
    command('docker', ['exec', '-i', container, 'pg_restore', '-U', 'powerevolve', '-d', 'backup_target',
      '--no-owner', '--no-acl', '--exit-on-error'], { input: dump })
    targetPool = new Pool({ connectionString: targetUrl.href, max: 2 })
    assert.deepEqual((await targetPool.query('SELECT * FROM pe_builtin_skill_install_requests ORDER BY request_id')).rows, receipts)
    assert.deepEqual((await targetPool.query('SELECT * FROM pe_skill_package_versions ORDER BY id')).rows, versions)
    await requireSkillPackageVersions(trialDataPath(target, 'skill-packages'), packages)
    assert.equal(await prepareRestoredSkillMounts(trialDataPath(target, 'skill-packages'), [user.userId]), 0)
    assert.deepEqual(await inventory(trialDataPath(target, 'skill-packages')), originalTree)
    assert.deepEqual(await prepare(targetPrivate, targetName), target)
    const restored = new SkillService(targetPool, target.workspaceRoot, target.skillLibraryRoot)
    await restored.init()
    assert.deepEqual(await restored.readSelected(user.userId, old, old.skillId), oldRead)
    assert.match((await restored.readSelected(user.userId, current, current.skillId)).instructions, /New current/)
    assert.match((await restored.readSelected(user.userId, word, word.skillId)).instructions, /Word documents/)
    await assert.rejects(restored.readSelected(user.userId, revoked, revoked.skillId), { code: 'skill_revoked' })
    assert.deepEqual(await restored.runtimeResourceBase(user.userId, reports, reports[0].skillId), suite)
    assert.deepEqual(await inventory(trialDataPath(target, 'skill-packages')), originalTree)
    assert.equal((await targetPool.query('SELECT count(*)::integer AS n FROM pe_cloud_executions')).rows[0].n, 1)
    assert.deepEqual((await targetPool.query('SELECT result FROM pe_cloud_executions WHERE id=$1', [executionId])).rows[0].result, output)
    assert.deepEqual((await targetPool.query('SELECT event FROM pe_events WHERE session_id=$1', [sessionId])).rows[0].event, output)
    assert.equal((await targetPool.query('SELECT count(*)::integer AS n FROM pe_sandbox_instances')).rows[0].n, 0)
    const legacyManifest = { format: 1, sourceSharedRoot: source.sharedRoot }
    assert.deepEqual(backupSourceRoots(legacyManifest), [source.sharedRoot])
    const legacyPrivate = join(root, 'legacy-target')
    await mkdir(legacyPrivate)
    const legacyOverride = { PE_SKILL_LIBRARY_ROOT: join(root, 'legacy-custom-library') }
    const legacyStorage = await resolveTrialStorage(legacyPrivate, null, legacyOverride)
    for (const name of trees) {
      const path = trialDataPath(legacyStorage, name)
      await mkdir(dirname(path), { recursive: true })
      await copyPosixTree(join(bundle, 'data', name), path)
    }
    await admin.query('CREATE DATABASE backup_legacy_target')
    command('docker', ['exec', '-i', container, 'pg_restore', '-U', 'powerevolve', '-d', 'backup_legacy_target',
      '--no-owner', '--no-acl', '--exit-on-error'], { input: dump })
    const legacyUrl = new URL(databaseUrl)
    legacyUrl.pathname = '/backup_legacy_target'
    legacyPool = new Pool({ connectionString: legacyUrl.href, max: 2 })
    assert.deepEqual((await legacyPool.query('SELECT * FROM pe_builtin_skill_install_requests ORDER BY request_id')).rows, receipts)
    await requireSkillPackageVersions(trialDataPath(legacyStorage, 'skill-packages'), packages)
    assert.deepEqual(await inventory(trialDataPath(legacyStorage, 'skill-packages')), originalTree)
    assert.deepEqual(await prepare(legacyPrivate, legacyName, legacyOverride), legacyStorage)
    const legacySkills = new SkillService(legacyPool, legacyStorage.workspaceRoot, legacyStorage.skillLibraryRoot)
    await legacySkills.init()
    assert.deepEqual(await legacySkills.readSelected(user.userId, old, old.skillId), oldRead)
    assert.deepEqual(await legacySkills.runtimeResourceBase(user.userId, reports, reports[0].skillId), suite)
    const missingRoot = join(root, 'incomplete-package-copy')
    await copyPosixTree(trialDataPath(target, 'skill-packages'), missingRoot)
    const revokedSkillRoot = join(missingRoot, user.userId, 'sha256', revoked.packageDigest, 'skill')
    await chmod(revokedSkillRoot, 0o700)
    await rm(join(revokedSkillRoot, 'SKILL.md'))
    await assert.rejects(requireSkillPackageVersions(missingRoot, packages), { code: 'skill_package_unavailable' })
  })
