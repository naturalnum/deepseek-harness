/** Real PostgreSQL checks for owner-scoped SSH admission and fenced dispatch intent. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { SshCallFixtureStore as SshCallStore } from './task-credential-fixture.mjs'
import { SshConnectionService } from '../lib/platform/ssh.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-native-s5')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const key = randomBytes(32)
const digest = value => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex')

test('S6 SSH calls retain exact user requests, fence workers, and reconcile a persisted intent',
  { timeout: 60_000 }, async t => {
    const database = `pe_s6_ssh_calls_${randomBytes(8).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    let pool, created = false
    t.after(async () => {
      await pool?.end()
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
      await admin.end()
    })
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 8 })
    await initializeDatabase(pool)
    assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 25)
    const alice = identity.parse({ userId: randomUUID(), username: 'alice' })
    const bob = identity.parse({ userId: randomUUID(), username: 'bob' })
    const connections = [randomUUID(), randomUUID()]
    const connectionService = new SshConnectionService(pool, randomBytes(32).toString('base64url'),
      'fixture.example.test:2222')
    for (const [index, user] of [alice, bob].entries()) {
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
      const ticket = await connectionService.issueTicket(user, { requestId: connections[index],
        displayName: `${user.username} server`, host: 'fixture.example.test', port: 2222,
        username: user.username, hostKeySha256: `SHA256:${'A'.repeat(43)}`,
        credentialKind: 'password', sizeBytes: 7, enabled: true }, 'http://127.0.0.1:19221')
      await connectionService.upload(ticket.ticket, Readable.from([Buffer.from('fixture')]))
    }
    const sessionId = randomUUID(), operationId = randomUUID(), workspaceId = randomUUID()
    await pool.query('INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,$3,true)',
      [workspaceId, alice.userId, 'Workspace'])
    await pool.query(
      `INSERT INTO pe_sessions(id,user_id,create_request_id,header,workspace_id)
       VALUES($1,$2,$3,$4,$5)`, [sessionId, alice.userId, randomUUID(), {}, workspaceId])
    await pool.query(
      `INSERT INTO pe_operations(id,session_id,request_id,input,settings,state)
       VALUES($1,$2,$3,$4,$5,'running')`, [operationId, sessionId, randomUUID(), 'test', {}])

    const store = new SshCallStore(pool)
    const requestId = randomUUID()
    const check = { requestId, connectionId: connections[0], connectionRevision: 1,
      kind: 'ssh.authenticate', requestDigest: digest({ kind: 'ssh.authenticate', timeoutMs: 5000 }) }
    const first = await store.admit(alice, check)
    assert.equal(first.state, 'accepted')
    assert.deepEqual(await store.admit(alice, check), first)
    await assert.rejects(store.admit(alice, { ...check, requestDigest: digest({ changed: true }) }),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(store.get(bob, first.id), { status: 404, code: 'ssh_call_not_found' })
    assert.deepEqual(await store.list(bob), [])
    const second = await store.admit(bob, { ...check, connectionId: connections[1] })
    assert.notEqual(second.id, first.id, 'request IDs are scoped by the verified user')
    assert.equal((await store.list(alice)).length, 1)
    await assert.rejects(store.admit(bob, { ...check, requestId: randomUUID(),
      connectionId: connections[1], kind: 'ssh.execute', operationId }),
    { status: 403, code: 'ssh_operation_not_owned' })
    const command = 'echo sensitive-command'
    const execute = await store.admit(alice, { ...check, requestId: randomUUID(), kind: 'ssh.execute',
      operationId, requestDigest: digest({ kind: 'ssh.execute', command, timeoutMs: 5000 }) })
    await pool.query(`INSERT INTO pe_ssh_execute_actions(id,user_id,session_id,operation_id,call_key,
      connection_id,connection_revision,credential_revision,command_sealed,request_digest,state)
      VALUES($1,$2,$3,$4,'store-fixture',$5,1,1,$6,$7,'approved')`,
    [execute.id, alice.userId, sessionId, operationId, connections[0], randomBytes(29), execute.request_digest])
    assert.equal(JSON.stringify(execute).includes(command), false)
    assert.equal(execute.operation_id, operationId)
    assert.equal((await store.cancel(bob, second.id)).state, 'cancelled')

    const workerA = randomUUID(), workerB = randomUUID()
    const claimed = await store.claim(workerA, 5000, 'ssh.authenticate')
    assert.equal(claimed.id, first.id)
    const leaseA = { callId: first.id, owner: workerA, epoch: claimed.lease_epoch }
    await store.startPreparing(leaseA)
    const handle = { callId: first.id, podUid: randomUUID(), instanceId: randomUUID(),
      destination: { ip: '192.0.2.42', port: 2222, username: 'alice',
        hostKeySha256: `SHA256:${'A'.repeat(43)}` } }
    await store.markReady(leaseA, handle)
    const runnerDigest = digest({ callId: first.id, handle })
    const intent = await store.markDispatchIntent(leaseA, runnerDigest)
    assert.equal(intent.state, 'dispatch-intent')
    assert.equal(intent.pod_uid, handle.podUid)
    assert.equal(intent.runner_instance_id, handle.instanceId)
    assert.equal(intent.dispatch_digest, runnerDigest)
    await assert.rejects(store.markDispatchIntent(leaseA, runnerDigest),
      { status: 409, code: 'ssh_call_state_or_lease_changed' }, 'a committed permit cannot be granted twice')
    await store.assertDispatchLease(leaseA)
    await pool.query("UPDATE pe_ssh_calls SET lease_until=now()-interval '1 second' WHERE id=$1", [first.id])
    const recovered = new SshCallStore(pool)
    const reclaimed = await recovered.claim(workerB, 5000, 'ssh.authenticate')
    assert.equal(reclaimed.id, first.id)
    assert.equal(reclaimed.state, 'dispatch-intent')
    assert.equal(reclaimed.dispatch_digest, runnerDigest)
    const leaseB = { callId: first.id, owner: workerB, epoch: reclaimed.lease_epoch }
    await assert.rejects(store.assertDispatchLease(leaseA), { status: 409, code: 'ssh_call_lease_lost' })
    await assert.rejects(recovered.assertDispatchLease(leaseB), { status: 409, code: 'ssh_call_lease_lost' })
    await assert.rejects(store.recordStatus(leaseA, { callId: first.id, instanceId: handle.instanceId,
      digest: runnerDigest, state: 'running' }), { status: 409, code: 'ssh_call_state_or_identity_changed' })
    await assert.rejects(recovered.recordStatus(leaseB, { callId: first.id, instanceId: handle.instanceId,
      digest: digest('wrong'), state: 'succeeded' }), { status: 409, code: 'ssh_call_state_or_identity_changed' })
    await recovered.recordStatus(leaseB, { callId: first.id, instanceId: handle.instanceId,
      digest: runnerDigest, state: 'running' })
    const done = await recovered.recordStatus(leaseB, { callId: first.id, instanceId: handle.instanceId,
      digest: runnerDigest, state: 'succeeded', result: { kind: 'ssh.authenticate', serverBanner: 'test' } })
    assert.equal(done.state, 'succeeded')
    assert.equal((await recovered.get(alice, first.id)).state, 'succeeded')
    assert.equal(await recovered.claim(workerA, 150, 'ssh.authenticate'), null,
      'the authentication worker must not claim an execute call it cannot handle')
    const executeClaim = await recovered.claim(workerA, 5000, 'ssh.execute')
    assert.equal(executeClaim.id, execute.id)
    const oldExecuteLease = { callId: execute.id, owner: workerA, epoch: executeClaim.lease_epoch }
    await recovered.startPreparing(oldExecuteLease)
    await recovered.markReady(oldExecuteLease, { ...handle, callId: execute.id })
    await pool.query("UPDATE pe_ssh_calls SET lease_until=now()-interval '1 second' WHERE id=$1", [execute.id])
    const executeReclaimed = await recovered.claim(workerB, 5000, 'ssh.execute')
    assert.equal(executeReclaimed.id, execute.id)
    const executeLease = { callId: execute.id, owner: workerB, epoch: executeReclaimed.lease_epoch }
    await assert.rejects(recovered.markDispatchIntent(oldExecuteLease, digest({ callId: execute.id, command })),
      { status: 409, code: 'ssh_call_state_or_lease_changed' })
    await recovered.markDispatchIntent(executeLease, digest({ callId: execute.id, command }))
    const cancelledIntent = await recovered.cancel(alice, execute.id)
    assert.equal(cancelledIntent.state, 'uncertain')
    assert.equal(cancelledIntent.cancel_requested, true)
    await assert.rejects(recovered.assertDispatchLease(executeLease),
      { status: 409, code: 'ssh_call_lease_lost' })
    assert.equal(JSON.stringify(await pool.query('SELECT * FROM pe_ssh_calls')).includes(command), false)

    const waiting = await recovered.admit(alice, { ...check, requestId: randomUUID() })
    const waitingClaim = await recovered.claim(workerA, 5000, 'ssh.authenticate')
    assert.equal(waitingClaim.id, waiting.id)
    const waitingLease = { callId: waiting.id, owner: workerA, epoch: waitingClaim.lease_epoch }
    await recovered.startPreparing(waitingLease)
    await recovered.markReady(waitingLease, { ...handle, callId: waiting.id })
    const blocker = await pool.connect()
    let pending
    try {
      await blocker.query('BEGIN')
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query('SELECT id FROM pe_ssh_connections WHERE id=$1 FOR UPDATE', [connections[0]])
      await pool.query("UPDATE pe_ssh_calls SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [waiting.id])
      pending = assert.rejects(recovered.markDispatchIntent(waitingLease, runnerDigest),
        { status: 409, code: 'ssh_call_state_or_lease_changed' })
      let observedWait = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const blocked = await pool.query(
          'SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',
          [blockerPid])
        if (blocked.rowCount) { observedWait = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(observedWait, true, 'the worker is waiting for the connection lock')
      await blocker.query(
        `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (lease_until-clock_timestamp())))+0.05)
         FROM pe_ssh_calls WHERE id=$1`, [waiting.id])
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
    }
    const expired = await recovered.get(alice, waiting.id)
    assert.equal(expired.state, 'ready')
    assert.equal(expired.dispatch_digest, null, 'lease expiry during lock wait prevents a permit')

    await recovered.markCleanupComplete(execute.id, handle.podUid)
    const unapproved = await recovered.admit(alice, { ...check, requestId: randomUUID(),
      kind: 'ssh.execute', operationId, requestDigest: digest({ command: 'unapproved' }) })
    const unapprovedClaim = await recovered.claim(workerA, 5000, 'ssh.execute')
    assert.equal(unapprovedClaim.id, unapproved.id)
    const unapprovedLease = { callId: unapproved.id, owner: workerA, epoch: unapprovedClaim.lease_epoch }
    await recovered.startPreparing(unapprovedLease)
    await recovered.markReady(unapprovedLease, { ...handle, callId: unapproved.id })
    const refused = await recovered.markDispatchIntent(unapprovedLease, runnerDigest)
    assert.equal(refused.state, 'failed')
    assert.equal(refused.error_code, 'ssh_action_not_approved')
    assert.equal(refused.dispatch_digest, null, 'a call without matching approval grants no POST')
  })
