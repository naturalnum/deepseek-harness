/** Report siblings are physical, immutable copies selected from four pinned package versions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { initializeDatabase } from '../lib/platform/database.js'
import { SkillService } from '../lib/platform/skills.js'
import { identity } from '../lib/contracts.js'
import { BuiltinSkillCatalog } from '../lib/platform/builtin-skills.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice2')
const databaseUrl = process.env.PE_TEST_DATABASE_URL ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const report = [
  ['builtin.report-workflow-orchestrator', '1.1.28', 'report-workflow-orchestrator'],
  ['builtin.power-grid-technical-report-writer', '1.1.39', 'power-grid-technical-report-writer'],
  ['builtin.report-reviewer', '1.1.1', 'report-reviewer'],
  ['builtin.tech-report-writer', '1.1.40', 'tech-report-writer'],
]
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
  const { skillId, name, description, digest: instructionDigest, revision, kind, version,
    packageDigest, manifestDigest } = item
  return { skillId, name, description, digest: instructionDigest, revision, kind, version,
    packageDigest, manifestDigest }
}

async function installReport(skills, user) {
  const result = []
  for (const [id, version] of report) {
    result.push(selected(await skills.installBuiltin(user, randomUUID(), id, version)))
  }
  return result
}

test('report suite copies four exact versions once per user and never repairs a corrupted published tree',
  { timeout: 120000 }, async t => {
    const database = `pe_s8_suite_${randomBytes(10).toString('hex')}`
    const root = await mkdtemp(join(tmpdir(), 'pe-s8-suite-'))
    const admin = new Pool({ connectionString: databaseUrl, max: 1 })
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
    pool = new Pool({ connectionString: url.href, max: 1 })
    await initializeDatabase(pool)
    const alice = await addUser(pool, 'alice')
    const bob = await addUser(pool, 'bob')
    const skills = new SkillService(pool, join(root, 'workspaces'), join(root, 'sandbox'))
    await skills.init()
    const aliceSelection = await installReport(skills, alice)
    const bobSelection = await installReport(skills, bob)
    const first = aliceSelection[0]
    // Accepted versions remain executable after catalog publication changes or
    // its distribution files become unavailable; receipts authorize the suite.
    const catalogRead = t.mock.method(BuiltinSkillCatalog.prototype, 'list', async () => {
      throw new Error('Current distribution catalog unavailable')
    })
    assert.equal((await skills.runtimeResourceBase(alice.userId, aliceSelection, first.skillId)).suiteAvailable, true)
    catalogRead.mock.restore()
    const word = selected(await skills.installBuiltin(alice, randomUUID(), 'builtin.word', '1.0.2'))
    assert.deepEqual(await skills.runtimeResourceBase(alice.userId, [word], word.skillId), {
      runtimePath: `/opt/power-evolve/skills/sha256/${word.packageDigest}/skill`, suiteAvailable: false })
    const note = selected(await skills.install(alice, randomUUID(), 'short-note', 'Short note', 'Read me.'))
    assert.deepEqual(await skills.runtimeResourceBase(alice.userId, [note], note.skillId),
      { runtimePath: null, suiteAvailable: false })
    const incomplete = await skills.runtimeResourceBase(alice.userId, aliceSelection.slice(0, 3), first.skillId)
    assert.deepEqual(incomplete, {
      runtimePath: `/opt/power-evolve/skills/sha256/${first.packageDigest}/skill`, suiteAvailable: false })
    await assert.rejects(skills.runtimeResourceBase(bob.userId, aliceSelection, first.skillId),
      { status: 404, code: 'skill_not_found' })
    const [one, two] = await Promise.all([
      skills.runtimeResourceBase(alice.userId, aliceSelection, first.skillId),
      skills.runtimeResourceBase(alice.userId, aliceSelection, aliceSelection[1].skillId),
    ])
    assert.equal(one.suiteAvailable, true)
    assert.equal(two.suiteAvailable, true)
    const runtimeParent = one.runtimePath.slice(0, -'/report-workflow-orchestrator'.length)
    assert.equal(two.runtimePath, `${runtimeParent}/power-grid-technical-report-writer`)
    const key = runtimeParent.split('/').at(-1)
    const suite = join(root, 'sandbox', 'skill-packages', alice.userId, 'report-suites', key)
    const dirs = await readdir(suite)
    assert.deepEqual(dirs.sort(), [...report.map(([, , folder]) => folder), 'suite-manifest.json'].sort())
    const orchestratorScript = join(suite, 'report-workflow-orchestrator', 'scripts', 'run_quality_gate.py')
    const generatorScript = join(suite, 'power-grid-technical-report-writer', 'scripts', 'validate_outline.py')
    assert.equal((await lstat(orchestratorScript)).isSymbolicLink(), false)
    assert.equal((await lstat(generatorScript)).isFile(), true)
    assert.equal((await lstat(suite)).mode & 0o222, 0)
    assert.equal((await lstat(orchestratorScript)).mode & 0o222, 0)
    const original = join(root, 'sandbox', 'skill-packages', alice.userId, 'sha256', first.packageDigest,
      'skill', 'scripts', 'run_quality_gate.py')
    assert.equal(digest(await readFile(orchestratorScript)), digest(await readFile(original)))
    assert.equal((await lstat(orchestratorScript)).mode & 0o111,
      (await lstat(original)).mode & 0o111)
    if (process.env.PE_TEST_REPORT_SUITE_DOCKER_IMAGE) {
      const workspace = join(root, 'workspace-output')
      await mkdir(workspace)
      const mountRoot = await realpath(join(root, 'sandbox', 'skill-packages', alice.userId))
      const working = await realpath(workspace)
      const suiteRuntime = `/opt/power-evolve/skills/report-suites/${key}`
      const inSandbox = (script, args = []) => execFileSync('docker', [
        'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
        '-e', 'PYTHONDONTWRITEBYTECODE=1',
        '--mount', `type=bind,source=${mountRoot},target=/opt/power-evolve/skills,readonly`,
        '--mount', `type=bind,source=${working},target=/workspace`,
        process.env.PE_TEST_REPORT_SUITE_DOCKER_IMAGE, 'python3', script, ...args,
      ], { encoding: 'utf8', timeout: 60000 })
      const workflow = `${suiteRuntime}/report-workflow-orchestrator/scripts/workflow_cli.py`
      inSandbox(workflow, ['init', '/workspace/report-state.json', '--project-id', 'smoke',
        '--title', '电网技术报告', '--goal', '验证四技能同级目录'])
      assert.match(inSandbox(workflow, ['next', '/workspace/report-state.json']), /project_intake/u)
      inSandbox(`${suiteRuntime}/report-workflow-orchestrator/scripts/run_quality_gate.py`, [
        '--outline', `${suiteRuntime}/power-grid-technical-report-writer/examples/outline-specific-topic-example.json`,
      ])
      inSandbox(`${suiteRuntime}/report-workflow-orchestrator/scripts/validate_rule_consistency.py`)
    }
    const restarted = new SkillService(pool, join(root, 'workspaces'), join(root, 'sandbox'))
    await restarted.init()
    assert.deepEqual(await restarted.runtimeResourceBase(alice.userId, aliceSelection, first.skillId), one)
    await skills.toggle(alice, aliceSelection[1].skillId, false)
    assert.deepEqual(await skills.runtimeResourceBase(alice.userId, aliceSelection, first.skillId), one)
    const bobSuite = await skills.runtimeResourceBase(bob.userId, bobSelection, bobSelection[0].skillId)
    assert.equal(bobSuite.suiteAvailable, true)
    assert.notEqual(bobSuite.runtimePath, one.runtimePath)
    const bobKey = bobSuite.runtimePath.split('/').at(-2)
    const bobScript = join(root, 'sandbox', 'skill-packages', bob.userId, 'report-suites', bobKey,
      'report-workflow-orchestrator', 'scripts', 'run_quality_gate.py')
    await chmod(join(bobScript, '..'), 0o755)
    await rm(bobScript)
    await writeFile(join(root, 'outside.txt'), 'outside')
    await symlink(join(root, 'outside.txt'), bobScript)
    await assert.rejects(skills.runtimeResourceBase(bob.userId, bobSelection, bobSelection[0].skillId),
      { status: 503, code: 'skill_package_unavailable' })
    await chmod(orchestratorScript, 0o644)
    await writeFile(orchestratorScript, 'tampered')
    await assert.rejects(skills.runtimeResourceBase(alice.userId, aliceSelection, first.skillId),
      { status: 503, code: 'skill_package_unavailable' })
    await skills.revoke(alice, aliceSelection[1].skillId)
    await assert.rejects(skills.runtimeResourceBase(alice.userId, aliceSelection, first.skillId),
      { status: 409, code: 'skill_revoked' })
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM pe_cloud_executions')).rows[0].n, 0)
  })
