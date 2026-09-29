/** PostgreSQL regression for S2 Workspace ownership and the V8 data migration. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { initializeDatabase } from '../lib/platform/database.js'
import { FileService } from '../lib/platform/files.js'
import { NativeWorkspaceRead } from '../lib/platform/native-workspace-read.js'
import { NativeFileRead } from '../lib/platform/native-files.js'
import { NativeSessionRead } from '../lib/platform/native-session-read.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { identity, requestId, workspaceId } from '../lib/contracts.js'
import { schema, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8 } from '../lib/platform/schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice2')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

async function isolated(run) {
  const name = `pe_s2_${randomBytes(10).toString('hex')}`
  const root = await mkdtemp(join(tmpdir(), 'pe-s2-workspaces-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  let pool
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(databaseUrl)
    url.pathname = `/${name}`
    pool = new Pool({ connectionString: url.href, max: 8 })
    await run(pool, root)
  } finally {
    await pool?.end()
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
}

async function user(pool, username) {
  const id = randomUUID()
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [id, username, 'test-only', { model: 'fixture', maxTokens: 100, revision: 1 }])
  return identity.parse({ userId: id, username })
}

function header(id) {
  return { id, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false }
}

async function bootstrapV8(pool) {
  await pool.query(schema)
  await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
  for (const step of [schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8]) await pool.query(step)
}

test('S2 Workspaces bind Sessions immutably and scope native files to their owner', { timeout: 30000 }, async () => {
  await isolated(async (pool, root) => {
    await initializeDatabase(pool)
    const alice = await user(pool, 'alice')
    const bob = await user(pool, 'bob')
    const files = new FileService(pool, join(root, 'workspaces'))
    await files.init()
    const tasks = new TaskStore(pool, { leaseMs: 3000, maxPendingPerUser: 8, maxActivePerUser: 1 })
    const workspaces = new NativeWorkspaceRead(pool, files, new NativeSessionRead(pool), 3)
    const nativeFiles = new NativeFileRead(pool, files)
    const aliceDefault = (await workspaces.list(alice)).items[0]
    const bobDefault = (await workspaces.list(bob)).items[0]
    assert.equal(aliceDefault.isDefault, true)
    assert.notEqual(aliceDefault.workspaceId, bobDefault.workspaceId)

    const request = requestId.parse(randomUUID())
    const project = await workspaces.create(alice, request, 'Project A')
    assert.equal(project.title, 'Project A')
    assert.equal(project.isDefault, false)
    assert.deepEqual(await workspaces.create(alice, request, 'Project A'), project)
    await assert.rejects(workspaces.create(alice, request, 'Other title'), { status: 409, code: 'request_id_conflict' })
    const other = await workspaces.create(alice, requestId.parse(randomUUID()), 'Project B')
    await assert.rejects(workspaces.create(alice, requestId.parse(randomUUID()), 'Project C'),
      { status: 429, code: 'workspace_limit' })

    const createId = requestId.parse(randomUUID())
    const first = await tasks.create(alice, createId, workspaceId.parse(project.workspaceId))
    assert.deepEqual(await tasks.create(alice, createId, workspaceId.parse(project.workspaceId)), first)
    await assert.rejects(tasks.create(alice, createId, workspaceId.parse(other.workspaceId)),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(tasks.create(alice, createId, workspaceId.parse(bobDefault.workspaceId)),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(tasks.create(alice, createId, workspaceId.parse(randomUUID())),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(tasks.create(bob, requestId.parse(randomUUID()), workspaceId.parse(project.workspaceId)),
      { status: 404, code: 'workspace_not_found' })
    const defaultSession = await tasks.create(alice, requestId.parse(randomUUID()))
    const row = await pool.query('SELECT workspace_id FROM pe_sessions WHERE id=$1', [defaultSession.sessionId])
    assert.equal(row.rows[0].workspace_id, aliceDefault.workspaceId)
    await assert.rejects(pool.query('UPDATE pe_sessions SET workspace_id=$2 WHERE id=$1',
      [defaultSession.sessionId, project.workspaceId]), /Session Workspace is immutable/)

    await files.put(alice, randomUUID(), 'note.txt', null, Buffer.from('project A').toString('base64'), project.workspaceId)
    await files.put(alice, randomUUID(), 'note.txt', null, Buffer.from('default').toString('base64'))
    assert.equal((await nativeFiles.read(alice, { sessionId: first.sessionId, path: '/workspace/note.txt', range: {} })).text, 'project A')
    assert.equal((await nativeFiles.read(alice, { sessionId: defaultSession.sessionId, path: '/workspace/note.txt', range: {} })).text, 'default')
    await assert.rejects(nativeFiles.read(bob, { sessionId: first.sessionId, path: '/workspace/note.txt', range: {} }),
      { status: 404, code: 'session_not_found' })
    const baseline = await workspaces.baseline(alice)
    assert.equal(baseline.items.length, 3)
    assert.deepEqual(baseline.items.find(item => item.workspaceId === project.workspaceId).sessionIds, [first.sessionId])
    assert.deepEqual(baseline.items.find(item => item.workspaceId === aliceDefault.workspaceId).sessionIds, [defaultSession.sessionId])
    assert.equal(JSON.stringify(baseline).includes(root), false)
  })
})

test('V8 migration retains default Workspace bytes and blocks a legacy live Pod', { timeout: 30000 }, async () => {
  await isolated(async (pool, root) => {
    await bootstrapV8(pool)
    const alice = await user(pool, 'legacy-alice')
    const legacyWorkspace = randomUUID()
    const legacySession = randomUUID()
    const podUid = randomUUID()
    await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [legacyWorkspace, alice.userId])
    await pool.query('INSERT INTO pe_sessions(id,user_id,create_request_id,header) VALUES($1,$2,$3,$4)',
      [legacySession, alice.userId, randomUUID(), header(legacySession)])
    await pool.query("INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id) VALUES($1,$2,$3,'ready',$4,$5)",
      [legacySession, alice.userId, `pe-sb-${legacySession.replaceAll('-', '')}`, podUid, randomUUID()])
    const directory = join(root, 'workspaces', legacyWorkspace)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'history.txt'), 'old Git and file bytes')

    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 13)
    assert.equal((await pool.query('SELECT workspace_id FROM pe_sessions WHERE id=$1', [legacySession])).rows[0].workspace_id,
      legacyWorkspace)
    assert.equal((await pool.query('SELECT id FROM pe_workspaces WHERE user_id=$1 AND is_default', [alice.userId])).rows[0].id,
      legacyWorkspace)
    assert.equal((await pool.query('SELECT state,pod_uid FROM pe_mount_slots WHERE user_id=$1', [alice.userId])).rows[0].state,
      'unknown')
    const files = new FileService(pool, join(root, 'workspaces'))
    await files.init()
    assert.equal((await files.workspaceForUser(alice.userId)).id, legacyWorkspace)
    assert.equal(await readFile(join(directory, 'history.txt'), 'utf8'), 'old Git and file bytes')
    await assert.rejects(files.put(alice, randomUUID(), 'new.txt', null, Buffer.from('blocked').toString('base64')),
      { status: 409, code: 'workspace_busy' })

    await pool.query("UPDATE pe_sandbox_instances SET state='deleted' WHERE session_id=$1", [legacySession])
    const nextSession = randomUUID()
    await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [nextSession, alice.userId, legacyWorkspace, randomUUID(), header(nextSession)])
    const reusedName = `pe-sb-${legacySession.replaceAll('-', '')}`
    await pool.query("INSERT INTO pe_sandbox_instances(session_id,user_id,name,state) VALUES($1,$2,$3,'creating')",
      [nextSession, alice.userId, reusedName])
    const thirdSession = randomUUID()
    await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [thirdSession, alice.userId, legacyWorkspace, randomUUID(), header(thirdSession)])
    await assert.rejects(pool.query("INSERT INTO pe_sandbox_instances(session_id,user_id,name,state) VALUES($1,$2,$3,'creating')",
      [thirdSession, alice.userId, reusedName]), { code: '23505' })
  })
})

test('V8 migration refuses multiple legacy writable Pods for one user', { timeout: 30000 }, async () => {
  await isolated(async pool => {
    await bootstrapV8(pool)
    const alice = await user(pool, 'legacy-two-pods')
    const workspace = randomUUID()
    await pool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspace, alice.userId])
    for (let index = 0; index < 2; index++) {
      const session = randomUUID()
      await pool.query('INSERT INTO pe_sessions(id,user_id,create_request_id,header) VALUES($1,$2,$3,$4)',
        [session, alice.userId, randomUUID(), header(session)])
      await pool.query("INSERT INTO pe_sandbox_instances(session_id,user_id,name,state) VALUES($1,$2,$3,'creating')",
        [session, alice.userId, `pe-sb-${session.replaceAll('-', '')}`])
    }
    await assert.rejects(initializeDatabase(pool), { code: '23505' })
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 8)
  })
})
