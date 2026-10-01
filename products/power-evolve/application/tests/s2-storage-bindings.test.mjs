/** Real isolated PG and descriptor-relative POSIX; Pod stop callbacks are explicit infrastructure substitutes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink, access } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { transaction } from '../src/platform/database.ts'
import * as schemaVersions from '../src/platform/schema.ts'
import { schemaV27 } from '../src/platform/storage-binding-schema.ts'
import { FileService } from '../src/platform/files.ts'
import { NativeWorkspaceRead } from '../src/platform/native-workspace-read.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { requestId } from '../src/contracts.ts'
import { requireActiveAccount } from '../src/platform/account-authority.ts'

const execute = promisify(execFile)
const worker = () => ({ ownerId: randomUUID(), leaseMs: 3000 })
const signal = () => new AbortController().signal
const noKubernetes = async () => { throw new Error('No Pod cleanup should be called for a proven free mount') }

async function isolated(run, migrate = true) {
  const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-s3-account-v25-qa')
  const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
  const name = `pe_s2_storage_e2_${randomBytes(10).toString('hex')}`
  const root = await mkdtemp(join(tmpdir(), 'pe-s2-storage-'))
  const admin = new Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 0 })
  let pool
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(databaseUrl); url.pathname = `/${name}`
    pool = new Pool({ connectionString: url.href, max: 12, idleTimeoutMillis: 0 })
    // The predecessor fixture stays V26 when the production initializer advances to V27.
    await transaction(pool, async client => {
      await client.query(schemaVersions.schema)
      await client.query('INSERT INTO pe_schema(version) VALUES(1)')
      for (let version = 2; version <= 26; version++) await client.query(schemaVersions[`schemaV${version}`])
    })
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 26)
    if (migrate) await transaction(pool, client => client.query(schemaV27))
    const files = new FileService(pool, join(root, 'workspaces'))
    await files.init()
    await run({ pool, root, files, bindings: files.bindings,
      workspaces: new NativeWorkspaceRead(pool, files, new NativeSessionRead(pool), 20) })
  } finally {
    await pool?.end()
    try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
}

async function owner(pool) {
  const user = { userId: randomUUID(), username: `fixture-${randomUUID()}` }
  await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [user.userId, user.username, 'fixture-only', { model: 'fixture', maxTokens: 100, revision: 1 }])
  return user
}
async function session(pool, user, workspaceId) {
  const id = randomUUID()
  await pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
    [id, user.userId, workspaceId, randomUUID(), { id, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false }])
  return id
}
async function personal(context, user) {
  const space = (await context.bindings.spaces(user)).items.find(value => value.isDefault)
  const row = (await context.pool.query('SELECT root_key FROM pe_storage_spaces WHERE id=$1', [space.spaceId])).rows[0]
  return { ...space, path: join(context.root, 'workspaces', row.root_key) }
}
async function directory(context, user, space, name, parentPath = '') {
  return context.bindings.createDirectory(user, { requestId: randomUUID(), spaceId: space.spaceId, parentPath, name })
}
async function readyWriter(context, user, workspaceId, generation = '7') {
  const sessionId = await session(context.pool, user, workspaceId), podUid = randomUUID(), runnerInstanceId = randomUUID()
  const binding = await context.files.bindingForId(user.userId, workspaceId)
  await context.pool.query(`INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id,binding_snapshot)
    VALUES($1,$2,$3,'ready',$4,$5,$6)`, [sessionId, user.userId, `fixture-${randomUUID()}`, podUid, runnerInstanceId, binding])
  await context.pool.query(`INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,pod_uid,runner_instance_id,binding_snapshot)
    VALUES($1,$2,$3,$4,'ready',$5,$6,$7)`, [user.userId, sessionId, workspaceId, generation, podUid, runnerInstanceId, binding])
  return { sessionId, podUid, runnerInstanceId, generation }
}
async function stoppedFixture(context, claim, assertLease) {
  await assertLease()
  await transaction(context.pool, async client => {
    await requireActiveAccount(client, claim.userId, 'update')
    // This exercises the actual nested caller path; opening a second lease transaction would deadlock.
    await assertLease(client)
    await client.query("UPDATE pe_sandbox_instances SET state='deleted',pod_uid=NULL,runner_instance_id=NULL WHERE session_id=$1", [claim.stopTarget.sessionId])
    await client.query(`UPDATE pe_mount_slots SET state='free',session_id=NULL,workspace_id=NULL,
      pod_uid=NULL,runner_instance_id=NULL,binding_snapshot=NULL WHERE user_id=$1`, [claim.userId])
  })
  return { kind: 'kubelet_stopped', mountGeneration: claim.stopTarget.mountGeneration, podUid: claim.stopTarget.podUid }
}
const restore = (workspaceId, space, path, generation = 1, id = randomUUID()) => ({
  requestId: id, workspaceId, spaceId: space.spaceId, rootRelativePath: path, expectedGeneration: generation,
})

test('V27 retains legacy bytes, stable Session identity, mutation generation and live mount snapshots', { timeout: 30000 }, async () => {
  await isolated(async c => {
    const alice = await owner(c.pool), workspaceId = randomUUID(), missingId = randomUUID()
    await c.pool.query('INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,$3,true),($4,$2,$5,false)',
      [workspaceId, alice.userId, 'Legacy', missingId, 'Legacy missing'])
    const path = join(c.root, 'workspaces', workspaceId)
    await mkdir(path); await mkdir(join(path, '.git')); await writeFile(join(path, '.git', 'HEAD'), 'legacy Git bytes')
    await writeFile(join(path, 'marker.txt'), 'legacy file bytes')
    const sessionId = await session(c.pool, alice, workspaceId), podUid = randomUUID(), runnerId = randomUUID()
    await c.pool.query("INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id) VALUES($1,$2,'fixture-legacy','ready',$3,$4)",
      [sessionId, alice.userId, podUid, runnerId])
    await c.pool.query("INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,pod_uid,runner_instance_id) VALUES($1,$2,$3,7,'ready',$4,$5)",
      [alice.userId, sessionId, workspaceId, podUid, runnerId])
    await c.pool.query("INSERT INTO pe_file_mutations(user_id,request_id,workspace_id,path,digest,mime,size) VALUES($1,$2,$3,'marker.txt',$4,'text/plain',17)",
      [alice.userId, randomUUID(), workspaceId, '0'.repeat(64)])
    await transaction(c.pool, client => client.query(schemaV27))
    assert.equal((await c.pool.query('SELECT version FROM pe_schema')).rows[0].version, 27)
    assert.equal(await readFile(join(path, '.git', 'HEAD'), 'utf8'), 'legacy Git bytes')
    assert.equal(await readFile(join(path, 'marker.txt'), 'utf8'), 'legacy file bytes')
    const expected = { workspaceId, spaceId: workspaceId, rootKey: workspaceId, rootRelativePath: '', generation: 1 }
    assert.deepEqual((await c.pool.query('SELECT binding_snapshot FROM pe_mount_slots')).rows[0].binding_snapshot, expected)
    assert.deepEqual((await c.pool.query('SELECT binding_snapshot FROM pe_sandbox_instances')).rows[0].binding_snapshot, expected)
    assert.equal((await c.pool.query('SELECT binding_generation FROM pe_file_mutations')).rows[0].binding_generation, '1')
    assert.equal((await c.pool.query('SELECT workspace_id FROM pe_sessions WHERE id=$1', [sessionId])).rows[0].workspace_id, workspaceId)
    await assert.rejects(c.files.workspaceForId(alice.userId, missingId), { status: 503 })
    await assert.rejects(access(join(c.root, 'workspaces', missingId)), { code: 'ENOENT' })
    await assert.rejects(c.pool.query('UPDATE pe_storage_spaces SET root_key=$2 WHERE id=$1', [workspaceId, randomUUID()]), /immutable/u)
  }, false)
})

test('storage selection and recovery use actual PG and POSIX without creating Sandbox resources', { timeout: 90000 }, async t => {
  await isolated(async c => {
    await t.test('native list and baseline retain Session membership without probing storage', async () => {
      const alice = await owner(c.pool), workspace = await c.files.workspaceForUser(alice.userId)
      const sessionId = await session(c.pool, alice, workspace.id)
      await rename(workspace.path, `${workspace.path}-saved`)
      const originalMissing = c.bindings.missing, originalProbe = c.files.safe.probeDirectory
      let missingCalls = 0, probeCalls = 0
      c.bindings.missing = async (...args) => { missingCalls++; return originalMissing.apply(c.bindings, args) }
      c.files.safe.probeDirectory = async (...args) => { probeCalls++; return originalProbe.apply(c.files.safe, args) }
      try {
        assert((await c.workspaces.list(alice)).items.some(item => item.workspaceId === workspace.id))
        const baseline = (await c.workspaces.baseline(alice)).items.find(item => item.workspaceId === workspace.id)
        assert.deepEqual(baseline.sessionIds, [sessionId])
        assert.equal(missingCalls, 0); assert.equal(probeCalls, 0)
        assert.equal((await c.pool.query('SELECT binding_state FROM pe_workspaces WHERE id=$1', [workspace.id])).rows[0].binding_state, 'ready')
        const missing = (await c.bindings.missing(alice)).items.find(item => item.workspaceId === workspace.id)
        assert.equal(missing.state, 'missing'); assert.equal(missingCalls, 1); assert(probeCalls > 0)
      } finally {
        c.bindings.missing = originalMissing; c.files.safe.probeDirectory = originalProbe
      }
    })

    await t.test('provisioning metadata is ordinary; ready roots never silently recreate after loss', async () => {
      const alice = await owner(c.pool)
      const id = await c.files.defaultWorkspaceId(alice.userId)
      assert.deepEqual((await c.bindings.missing(alice)).items, [])
      const initial = await c.files.workspaceForId(alice.userId, id)
      await rename(initial.path, `${initial.path}-saved`)
      for (const action of [() => c.files.workspaceForId(alice.userId, id), () => c.files.list(alice, '', id),
        () => c.files.read(alice, 'marker.txt', id), () => c.files.kind(alice, '', id)]) {
        await assert.rejects(action(), { status: 503 })
      }
      await assert.rejects(access(initial.path), { code: 'ENOENT' })
      const missing = (await c.bindings.missing(alice)).items.find(item => item.workspaceId === id)
      assert.equal(missing.state, 'missing'); assert.equal(missing.recoveryRequestId, null)
      assert((await c.workspaces.baseline(alice)).items.some(item => item.workspaceId === id))
    })

    await t.test('spaces and paged directories enforce owner, cursor and no-symlink access', async () => {
      const alice = await owner(c.pool), bob = await owner(c.pool), space = await personal(c, alice)
      for (const name of ['alpha', 'beta', '报告']) await directory(c, alice, space, name)
      await symlink(tmpdir(), join(space.path, 'outside-link'))
      const first = await c.bindings.directories(alice, { spaceId: space.spaceId, parentPath: '', limit: 2 })
      assert.deepEqual(first.entries.map(item => item.name), ['alpha', 'beta']); assert(first.nextCursor)
      const last = await c.bindings.directories(alice, { spaceId: space.spaceId, parentPath: '', limit: 2, cursor: first.nextCursor })
      assert.deepEqual(last.entries.map(item => item.name), ['报告']); assert.equal(last.nextCursor, undefined)
      await assert.rejects(c.bindings.directories(bob, { spaceId: space.spaceId, parentPath: '', limit: 2, cursor: first.nextCursor }), { status: 404 })
      await assert.rejects(c.bindings.directories(alice, { spaceId: space.spaceId, parentPath: 'alpha', limit: 2, cursor: first.nextCursor }), { status: 400 })
      await assert.rejects(directory(c, alice, space, 'bad', 'outside-link'), { status: 503 })
      await rename(space.path, `${space.path}-saved`)
      assert.equal((await c.bindings.spaces(alice)).items.find(item => item.spaceId === space.spaceId).available, false)
      await assert.rejects(access(space.path), { code: 'ENOENT' })
    })

    await t.test('durable mkdir reconciles a helper failure after actual creation and preserves existing bytes', async () => {
      const alice = await owner(c.pool), space = await personal(c, alice)
      const input = { requestId: randomUUID(), spaceId: space.spaceId, parentPath: '', name: 'project' }
      const original = c.files.safe.createDirectory.bind(c.files.safe)
      let fail = true
      c.files.safe.createDirectory = async (...args) => {
        await original(...args)
        if (fail) { fail = false; throw new Error('fixture interrupted after mkdir') }
      }
      try {
        await assert.rejects(c.bindings.createDirectory(alice, input), /fixture interrupted/u)
        assert.equal((await c.pool.query('SELECT state FROM pe_storage_directory_requests WHERE request_id=$1', [input.requestId])).rows[0].state, 'accepted')
        await writeFile(join(space.path, 'project', 'keep.txt'), 'keep original bytes')
        const result = await c.bindings.createDirectory(alice, input)
        assert.deepEqual(result, { name: 'project', path: 'project' })
        assert.deepEqual(await c.bindings.createDirectory(alice, input), result)
        assert.equal(await readFile(join(space.path, 'project', 'keep.txt'), 'utf8'), 'keep original bytes')
        await assert.rejects(c.bindings.createDirectory(alice, { ...input, name: 'different' }), { status: 409, code: 'request_id_conflict' })
      } finally { c.files.safe.createDirectory = original }
    })

    await t.test('bound publication source rejects intermediate symlinks with real account transactions', async () => {
      const alice = await owner(c.pool)
      const created = await c.workspaces.create(alice, requestId.parse(randomUUID()), 'Publication source')
      const binding = await c.files.bindingForId(alice.userId, created.workspaceId)
      assert.notEqual(binding.rootRelativePath, '')
      const workspace = await c.files.workspaceForId(alice.userId, created.workspaceId)
      const outside = join(c.root, `outside-${randomUUID()}`), secret = 'outside secret'
      await mkdir(outside); await writeFile(join(outside, 'secret.txt'), secret)
      await symlink(outside, join(workspace.path, 'link'))
      await assert.rejects(c.files.readInWorkspace(alice, created.workspaceId, 'link/secret.txt'),
        { status: 400, code: 'invalid_path' })
      await assert.rejects(c.files.readBytesInWorkspace(alice, created.workspaceId, 'link/secret.txt'),
        { status: 400, code: 'invalid_path' })
      await transaction(c.pool, async client => {
        await requireActiveAccount(client, alice.userId, 'update')
        await assert.rejects(c.files.readInWorkspace(alice, created.workspaceId, 'link/secret.txt', client),
          { status: 400, code: 'invalid_path' })
      })
      assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), secret)
    })

    await t.test('nonempty selected directories retain real Git, deny overlap and bind explicit creation retries', async () => {
      const alice = await owner(c.pool), bob = await owner(c.pool), space = await personal(c, alice)
      await directory(c, alice, space, 'project-a'); await directory(c, alice, space, 'project-b')
      const source = join(space.path, 'project-a')
      await writeFile(join(source, 'marker.txt'), 'existing selected bytes')
      await execute('/usr/bin/git', ['init', '-q', source])
      await execute('/usr/bin/git', ['-C', source, 'add', 'marker.txt'])
      await execute('/usr/bin/git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
      const head = (await execute('/usr/bin/git', ['-C', source, 'rev-parse', 'HEAD'])).stdout
      const id = requestId.parse(randomUUID()), target = { spaceId: space.spaceId, rootRelativePath: 'project-a' }
      const created = await c.workspaces.create(alice, id, 'Selected', target)
      assert.deepEqual(await c.workspaces.create(alice, id, 'Selected', target), created)
      assert.equal(Buffer.from((await c.files.readInWorkspace(alice, created.workspaceId, 'marker.txt')).data, 'base64').toString(), 'existing selected bytes')
      assert.equal((await execute('/usr/bin/git', ['-C', source, 'rev-parse', 'HEAD'])).stdout, head)
      for (const rootRelativePath of ['', 'project-a', 'project-a/nested']) {
        if (rootRelativePath.endsWith('/nested')) await directory(c, alice, space, 'nested', 'project-a')
        await assert.rejects(c.workspaces.create(alice, requestId.parse(randomUUID()), 'Overlap', { spaceId: space.spaceId, rootRelativePath }),
          { status: 409, code: 'workspace_storage_overlap' })
      }
      await assert.rejects(c.workspaces.create(alice, id, 'Selected', { ...target, rootRelativePath: 'project-b' }), { status: 409, code: 'request_id_conflict' })
      await assert.rejects(c.workspaces.create(bob, requestId.parse(randomUUID()), 'Foreign', target), { status: 404 })
      const sibling = await c.workspaces.create(alice, requestId.parse(randomUUID()), 'Sibling', { ...target, rootRelativePath: 'project-b' })
      assert.notEqual(created.workspaceId, sibling.workspaceId)
    })

    await t.test('successive free recoveries keep Session identity and ignore completed request references', async () => {
      const alice = await owner(c.pool), workspace = await c.files.workspaceForUser(alice.userId)
      const sessionId = await session(c.pool, alice, workspace.id), mutation = randomUUID()
      await c.files.put(alice, mutation, 'marker.txt', null, Buffer.from('retained bytes').toString('base64'), workspace.id)
      const space = await personal(c, alice)
      await rename(workspace.path, join(space.path, 'restored-project'))
      const before = (await c.workspaces.baseline(alice)).items.find(item => item.workspaceId === workspace.id).updatedAt
      const input = restore(workspace.id, space, 'restored-project')
      assert.equal((await c.bindings.restore(alice, input)).state, 'accepted')
      const refreshed = (await c.bindings.missing(alice)).items.find(item => item.workspaceId === workspace.id)
      assert.equal(refreshed.state, 'recovering'); assert.equal(refreshed.recoveryRequestId, input.requestId)
      await assert.rejects(c.files.readInWorkspace(alice, workspace.id, 'marker.txt'), { status: 503 })
      assert.equal(await c.bindings.poll(noKubernetes, signal(), worker()), true)
      const completed = await c.bindings.status(alice, { requestId: input.requestId })
      assert.equal(completed.state, 'completed'); assert.equal(completed.bindingGeneration, 2)
      assert.equal((await c.pool.query('SELECT recovery_request_id FROM pe_workspaces WHERE id=$1', [workspace.id])).rows[0].recovery_request_id, null)
      assert.deepEqual(await c.bindings.restore(alice, input), completed)
      assert.equal((await c.pool.query('SELECT workspace_id FROM pe_sessions WHERE id=$1', [sessionId])).rows[0].workspace_id, workspace.id)
      await assert.rejects(c.pool.query('UPDATE pe_sessions SET workspace_id=$2 WHERE id=$1', [sessionId, randomUUID()]), /immutable/u)
      assert.equal((await c.files.readBytesInWorkspace(alice, workspace.id, 'marker.txt', undefined, 2)).toString(), 'retained bytes')
      await assert.rejects(c.files.readBytesInWorkspace(alice, workspace.id, 'marker.txt', undefined, 1), { status: 409, code: 'file_binding_changed' })
      await assert.rejects(c.files.put(alice, mutation, 'marker.txt', null, Buffer.from('retained bytes').toString('base64'), workspace.id), { status: 409, code: 'file_binding_changed' })
      await assert.rejects(c.bindings.restore(alice, restore(workspace.id, space, 'restored-project', 1)), { status: 409 })
      const after = (await c.workspaces.baseline(alice)).items.find(item => item.workspaceId === workspace.id).updatedAt
      assert(Date.parse(after) > Date.parse(before))
      await transaction(c.pool, async client => {
        await requireActiveAccount(client, alice.userId, 'update')
        assert.equal(Buffer.from((await c.files.readInWorkspace(alice, workspace.id, 'marker.txt', client)).data, 'base64').toString(), 'retained bytes')
      })
      await rename(join(space.path, 'restored-project'), join(space.path, 'restored-again'))
      // Previously completed V27 recoveries left this reference on their ready Workspace.
      await c.pool.query('UPDATE pe_workspaces SET recovery_request_id=$2 WHERE id=$1', [workspace.id, input.requestId])
      for (let attempt = 0; attempt < 2; attempt++) {
        const missing = (await c.bindings.missing(alice)).items.find(item => item.workspaceId === workspace.id)
        assert.equal(missing.state, 'missing'); assert.equal(missing.generation, 2)
        assert.equal(missing.recoveryRequestId, null)
      }
      assert.deepEqual(await c.bindings.status(alice, { requestId: input.requestId }), completed)
      const second = restore(workspace.id, space, 'restored-again', 2)
      assert.equal((await c.bindings.restore(alice, second)).state, 'accepted')
      const recovering = (await c.bindings.missing(alice)).items.find(item => item.workspaceId === workspace.id)
      assert.equal(recovering.state, 'recovering'); assert.equal(recovering.recoveryRequestId, second.requestId)
      assert.equal(await c.bindings.poll(noKubernetes, signal(), worker()), true)
      const completedAgain = await c.bindings.status(alice, { requestId: second.requestId })
      assert.equal(completedAgain.state, 'completed'); assert.equal(completedAgain.bindingGeneration, 3)
      assert.deepEqual(await c.bindings.restore(alice, second), completedAgain)
      assert.deepEqual(await c.bindings.restore(alice, input), completed)
      const current = (await c.pool.query('SELECT binding_generation,recovery_request_id FROM pe_workspaces WHERE id=$1', [workspace.id])).rows[0]
      assert.equal(current.binding_generation, '3'); assert.equal(current.recovery_request_id, null)
      assert.equal((await c.pool.query('SELECT workspace_id FROM pe_sessions WHERE id=$1', [sessionId])).rows[0].workspace_id, workspace.id)
      assert.deepEqual((await c.workspaces.baseline(alice)).items.find(item => item.workspaceId === workspace.id).sessionIds, [sessionId])
      assert.equal((await c.files.readBytesInWorkspace(alice, workspace.id, 'marker.txt', undefined, 3)).toString(), 'retained bytes')
      assert.deepEqual((await c.bindings.missing(alice)).items, [])
    })

    await t.test('active and unknown writers cannot be accepted as no_writer', async () => {
      const alice = await owner(c.pool), workspace = await c.files.workspaceForUser(alice.userId), space = await personal(c, alice)
      await directory(c, alice, space, 'target')
      const sessionId = await session(c.pool, alice, workspace.id), operationId = randomUUID(), executionId = randomUUID()
      await c.pool.query("INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,'fixture',$4,'completed')",
        [operationId, sessionId, randomUUID(), { model: 'fixture', maxTokens: 100, revision: 1 }])
      await c.pool.query("INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state) VALUES($1,$2,$3,$4,'fixture','true','',$5,'queued')",
        [executionId, alice.userId, sessionId, operationId, '0'.repeat(64)])
      const input = restore(workspace.id, space, 'target')
      await assert.rejects(c.bindings.restore(alice, input), { status: 409, code: 'workspace_execution_active' })
      await c.pool.query("UPDATE pe_cloud_executions SET state='cancelled' WHERE id=$1", [executionId])
      await c.pool.query("INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,state) VALUES($1,$2,$3,'unknown')", [alice.userId, sessionId, workspace.id])
      await assert.rejects(c.bindings.restore(alice, input), { status: 409, code: 'workspace_writer_unconfirmed' })
      assert.equal((await c.pool.query('SELECT count(*)::int AS count FROM pe_workspace_binding_requests WHERE request_id=$1', [input.requestId])).rows[0].count, 0)
    })

    await t.test('proof mismatch blocks recovery; superseding a blocked target cannot revive its old request', async () => {
      const alice = await owner(c.pool), workspace = await c.files.workspaceForUser(alice.userId), space = await personal(c, alice)
      await directory(c, alice, space, 'first'); await directory(c, alice, space, 'second')
      const writer = await readyWriter(c, alice, workspace.id)
      const first = restore(workspace.id, space, 'first')
      await c.bindings.restore(alice, first)
      await c.bindings.poll(async claim => ({ kind: 'kubelet_stopped', mountGeneration: claim.stopTarget.mountGeneration, podUid: randomUUID() }), signal(), worker())
      assert.equal((await c.bindings.status(alice, { requestId: first.requestId })).errorCode, 'workspace_stop_proof_mismatch')
      assert.equal((await c.bindings.missing(alice)).items.find(item => item.workspaceId === workspace.id).recoveryRequestId, first.requestId)
      const second = restore(workspace.id, space, 'second')
      await c.bindings.restore(alice, second)
      assert.equal((await c.bindings.restore(alice, first)).state, 'blocked')
      await c.bindings.poll((claim, lease) => {
        assert.equal(claim.stopTarget.podUid, writer.podUid)
        return stoppedFixture(c, claim, lease)
      }, signal(), worker())
      const binding = await c.files.bindingForId(alice.userId, workspace.id)
      assert.equal(binding.generation, 2); assert.equal(binding.rootRelativePath, 'second')
      assert.equal((await c.bindings.status(alice, { requestId: first.requestId })).state, 'blocked')
    })

    await t.test('an expired worker cannot commit after a second worker proves the captured writer stopped', async () => {
      const alice = await owner(c.pool), workspace = await c.files.workspaceForUser(alice.userId), space = await personal(c, alice)
      await directory(c, alice, space, 'target')
      await readyWriter(c, alice, workspace.id)
      const input = restore(workspace.id, space, 'target')
      await c.bindings.restore(alice, input)
      let entered, release
      const started = new Promise(resolve => { entered = resolve }), continued = new Promise(resolve => { release = resolve })
      const first = c.bindings.poll(async (_claim, assertLease) => { entered(); await continued; await assertLease(); throw new Error('stale worker crossed lease') }, signal(), worker())
      await started
      await c.pool.query("UPDATE pe_workspace_binding_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE request_id=$1", [input.requestId])
      await c.bindings.poll((claim, lease) => stoppedFixture(c, claim, lease), signal(), worker())
      release(); await first
      assert.equal((await c.bindings.status(alice, { requestId: input.requestId })).state, 'completed')
      assert.equal((await c.files.bindingForId(alice.userId, workspace.id)).generation, 2)
      assert.equal((await c.pool.query('SELECT lease_epoch FROM pe_workspace_binding_requests WHERE request_id=$1', [input.requestId])).rows[0].lease_epoch, '2')
    })

    await t.test('retrying the same blocked request retains its target and persisted stop proof', async () => {
      const alice = await owner(c.pool), workspace = await c.files.workspaceForUser(alice.userId), space = await personal(c, alice)
      await directory(c, alice, space, 'target')
      const input = restore(workspace.id, space, 'target')
      await c.bindings.restore(alice, input)
      const original = c.files.safe.probeDirectory.bind(c.files.safe)
      c.files.safe.probeDirectory = async (location, ...args) => location.rootRelativePath === 'target' ? false : original(location, ...args)
      try { await c.bindings.poll(noKubernetes, signal(), worker()) }
      finally { c.files.safe.probeDirectory = original }
      assert.equal((await c.bindings.status(alice, { requestId: input.requestId })).state, 'blocked')
      assert.equal((await c.pool.query('SELECT stop_proof FROM pe_workspace_binding_requests WHERE request_id=$1', [input.requestId])).rows[0].stop_proof.kind, 'no_writer')
      assert.equal((await c.bindings.restore(alice, input)).state, 'accepted')
      await c.bindings.poll(noKubernetes, signal(), worker())
      assert.equal((await c.bindings.status(alice, { requestId: input.requestId })).state, 'completed')
    })

    assert.equal((await c.pool.query("SELECT count(*)::int AS count FROM pe_sandbox_instances WHERE state<>'deleted' AND name NOT LIKE 'fixture-%'")).rows[0].count, 0)
  })
})
