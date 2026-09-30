/** Real PG approval and encrypted SSH execution with a controlled Runner boundary. */
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { SshCallStore } from '../lib/platform/ssh-calls.js'
import { SshConnectionService } from '../lib/platform/ssh.js'
import { SshExecuteService } from '../lib/platform/ssh-execute.js'
import { TaskStore } from '../lib/platform/tasks.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-native-s5')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const fingerprint = `SHA256:${'A'.repeat(43)}`
const secretCommand = 'printf "alice-sensitive-γ"'

class FakeRunner {
  posts = []
  cleaned = []
  observation
  key = randomBytes(32)
  async prepare(callId, destination) {
    const handle = { callId, destination, podUid: randomUUID(), instanceId: randomUUID() }
    await this.onPrepared?.(handle)
    return handle
  }
  digestFor(handle, request) {
    return createHmac('sha256', this.key).update(JSON.stringify({ handle, request })).digest('hex')
  }
  async dispatchFirst(handle, request) {
    await this.beforePost?.()
    this.posts.push({ handle, request })
    if (this.unknownOnce) { this.unknownOnce = false; return { state: 'uncertain', reason: 'dispatch_outcome_unknown' } }
    if (this.reply) return { state: 'known', status: { callId: handle.callId, instanceId: handle.instanceId,
      digest: this.digestFor(handle, request), ...this.reply } }
    return { state: 'known', status: { callId: handle.callId, instanceId: handle.instanceId,
      digest: this.digestFor(handle, request), state: 'succeeded',
      result: { kind: 'ssh.execute', exitCode: 0, signal: null,
        stdout: `output:${handle.destination.username}`, stderr: '' } } }
  }
  async reconcile(handle, dispatched, digest) {
    this.lookups.push({ handle, dispatched, digest })
    return this.observation ?? { state: 'uncertain', reason: 'dispatched_call_missing' }
  }
  lookups = []
  async cancel(handle, digest) { return this.reconcile(handle, true, digest) }
  async cleanup(callId) { this.cleaned.push(callId) }
}

async function setup(t) {
  const database = `pe_s6_ssh_execute_${randomBytes(9).toString('hex')}`
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
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 23)
  const users = [identity.parse({ userId: randomUUID(), username: 'alice' }),
    identity.parse({ userId: randomUUID(), username: 'bob' })]
  for (const user of users) await pool.query(
    'INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
    [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
  for (const user of users) await pool.query(
    `INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled)
     VALUES($1,'fixture','fixture',64,true)`, [user.userId])
  const key = randomBytes(32).toString('base64url')
  const connections = new SshConnectionService(pool, key, 'fixture.example.test:2222')
  const saved = []
  for (const user of users) {
    const password = `${user.username}-private-password`
    const input = { requestId: randomUUID(), displayName: `${user.username} server`,
      host: 'fixture.example.test', port: 2222, username: user.username,
      hostKeySha256: fingerprint, credentialKind: 'password',
      sizeBytes: Buffer.byteLength(password), enabled: true }
    const ticket = await connections.issueTicket(user, input, 'http://127.0.0.1:19221')
    saved.push((await connections.upload(ticket.ticket, Readable.from([Buffer.from(password)]))).item)
  }
  const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 60_000, maxPendingPerUser: 8,
    maxActivePerUser: 1, sshEnabled: true })
  const calls = new SshCallStore(pool)
  const runner = new FakeRunner()
  const owner = randomUUID()
  const makeService = (worker = owner) => new SshExecuteService(tasks, calls, connections, runner,
    key, worker, 60_000, 100, async () => '192.0.2.42')
  return { pool, users, saved, tasks, calls, runner, connections, makeService }
}

async function propose(fixture, service, user, connection, command, key = 'one-call') {
  const session = await fixture.tasks.create(user, randomUUID())
  const operation = await fixture.tasks.accept(user, session.sessionId, randomUUID(), 'Run a reviewed SSH command')
  const grant = await fixture.tasks.claim(randomUUID())
  assert.deepEqual(grant.sshConnections.map(item => item.connectionId), [connection.connectionId])
  const action = await service.propose(grant.token, key, connection.connectionId,
    connection.revision, connection.credentialRevision, command)
  await fixture.tasks.finish(grant.token, 'completed', null)
  return { session, operation, action }
}

test('two users approve exact encrypted commands, execute once, and resume owned Sessions',
  { timeout: 60_000 }, async t => {
    const f = await setup(t)
    const service = f.makeService()
    const [alice, bob] = f.users
    const aSession = await f.tasks.create(alice, randomUUID())
    const accepted = await f.tasks.accept(alice, aSession.sessionId, randomUUID(), 'Review SSH command')
    const grant = await f.tasks.claim(randomUUID())
    assert.equal(grant.sshConnections[0].host, 'fixture.example.test')
    const a = await service.propose(grant.token, 'stable-call', f.saved[0].connectionId, 1, 1, secretCommand)
    assert.equal(a.state, 'pending')
    assert.deepEqual(await service.propose(grant.token, 'stable-call', f.saved[0].connectionId, 1, 1,
      secretCommand), a)
    await assert.rejects(service.propose(grant.token, 'stable-call', f.saved[0].connectionId, 1, 1,
      'echo changed'), { status: 409, code: 'request_id_conflict' })
    await assert.rejects(service.propose(grant.token, 'stable-call', f.saved[1].connectionId, 1, 1,
      secretCommand), { status: 403, code: 'ssh_connection_not_in_operation' })
    await f.tasks.finish(grant.token, 'completed', null)
    assert.equal((await service.approvals(alice)).items[0].command, secretCommand)
    assert.deepEqual((await service.approvals(bob)).items, [])
    await assert.rejects(service.status(bob, a.actionId), { status: 404, code: 'ssh_action_not_found' })
    await assert.rejects(service.decide(bob, a.actionId, a.fingerprint, true),
      { status: 404, code: 'ssh_action_not_found' })
    await assert.rejects(service.decide(alice, a.actionId, 'a'.repeat(64), true),
      { status: 409, code: 'ssh_action_changed' })
    const raw = await f.pool.query('SELECT command_sealed,request_digest FROM pe_ssh_execute_actions WHERE id=$1',
      [a.actionId])
    assert.equal(raw.rows[0].command_sealed.includes(Buffer.from(secretCommand)), false)
    assert.equal(raw.rows[0].request_digest, a.fingerprint)
    assert.equal((await service.decide(alice, a.actionId, a.fingerprint, true)).state, 'approved')
    assert.equal((await service.decide(alice, a.actionId, a.fingerprint, true)).state, 'approved')
    const admitted = await f.calls.get(alice, a.actionId)
    assert.equal(admitted.state, 'accepted')
    assert.equal(JSON.stringify(admitted).includes(secretCommand), false)
    assert.equal(JSON.stringify(admitted).includes('alice-private-password'), false)
    const row = await f.calls.claim(service.ownerId, 60_000, 'ssh.execute')
    assert.equal(row.id, a.actionId)
    await service.pump(row)
    assert.equal(f.runner.posts.length, 1)
    assert.equal(f.runner.posts[0].request.command, secretCommand)
    assert.equal(f.runner.posts[0].request.credential.password, 'alice-private-password')
    const done = await service.status(alice, a.actionId)
    assert.equal(done.state, 'succeeded')
    assert.equal(done.result.stdout, 'output:alice')
    const stored = await f.pool.query('SELECT result FROM pe_ssh_calls WHERE id=$1', [a.actionId])
    assert.equal(stored.rows[0].result, null)
    const continuation = await f.tasks.claim(randomUUID())
    assert.equal(continuation.source, 'ssh_execute_result')
    assert.equal(continuation.sourceSshExecuteActionId, a.actionId)
    assert.equal(continuation.sessionId, aSession.sessionId)
    assert.match(continuation.text, /output:alice/u)
    await f.tasks.finish(continuation.token, 'completed', null)
    assert.equal(accepted.operationId, admitted.operation_id)

    const b = await propose(f, service, bob, f.saved[1], 'echo bob')
    await service.decide(bob, b.action.actionId, b.action.fingerprint, true)
    const bobRow = await f.calls.claim(service.ownerId, 60_000, 'ssh.execute')
    await service.pump(bobRow)
    assert.equal((await service.status(bob, b.action.actionId)).result.stdout, 'output:bob')
    assert.equal(f.runner.posts[1].request.credential.password, 'bob-private-password')
    assert.equal((await service.list(alice)).items.length, 1)
    assert.equal((await service.list(bob)).items.length, 1)
  })

test('rejection, revocation, cancellation and persisted intent never dispatch an unapproved command',
  { timeout: 60_000 }, async t => {
    const f = await setup(t)
    const service = f.makeService()
    const [alice] = f.users
    const rejected = await propose(f, service, alice, f.saved[0], 'echo rejected')
    assert.equal((await service.decide(alice, rejected.action.actionId,
      rejected.action.fingerprint, false)).state, 'rejected')
    const rejectedContinuation = await f.tasks.claim(randomUUID())
    assert.equal(rejectedContinuation.sourceSshExecuteActionId, rejected.action.actionId)
    await f.tasks.finish(rejectedContinuation.token, 'completed', null)
    const pending = await propose(f, service, alice, f.saved[0], 'echo cancelled')
    assert.equal((await service.cancel(alice, pending.action.actionId)).state, 'cancelled')
    const cancelledContinuation = await f.tasks.claim(randomUUID())
    assert.equal(cancelledContinuation.sourceSshExecuteActionId, pending.action.actionId)
    await f.tasks.finish(cancelledContinuation.token, 'completed', null)
    const approved = await propose(f, service, alice, f.saved[0], 'echo stale')
    await f.connections.toggle(alice, f.saved[0].connectionId, randomUUID(), 1, false)
    assert.equal((await service.decide(alice, approved.action.actionId,
      approved.action.fingerprint, true)).state, 'failed')
    assert.equal(f.runner.posts.length, 0)
    const failedContinuation = await f.tasks.claim(randomUUID())
    assert.equal(failedContinuation.sourceSshExecuteActionId, approved.action.actionId)
    await f.tasks.finish(failedContinuation.token, 'completed', null)
    const enabled = await f.connections.toggle(alice, f.saved[0].connectionId, randomUUID(), 2, true)
    const recovery = await propose(f, service, alice, enabled, 'echo recover')
    await service.decide(alice, recovery.action.actionId, recovery.action.fingerprint, true)
    const handle = { callId: recovery.action.actionId,
      destination: { ip: '192.0.2.42', port: 2222, username: 'alice', hostKeySha256: fingerprint },
      podUid: randomUUID(), instanceId: randomUUID() }
    const digest = 'f'.repeat(64)
    await f.pool.query(`UPDATE pe_ssh_calls SET state='dispatch-intent',destination=$2,pod_uid=$3,
      runner_instance_id=$4,dispatch_digest=$5,dispatch_owner=$6,dispatch_epoch=1
      WHERE id=$1`, [handle.callId, handle.destination, handle.podUid, handle.instanceId,
      digest, randomUUID()])
    f.runner.observation = { state: 'known', status: { callId: handle.callId,
      instanceId: handle.instanceId, digest, state: 'succeeded',
      result: { kind: 'ssh.execute', exitCode: 0, signal: null, stdout: 'recovered', stderr: '' } } }
    const restarted = f.makeService(randomUUID())
    const row = await f.calls.claim(restarted.ownerId, 60_000, 'ssh.execute')
    await restarted.pump(row)
    assert.equal(f.runner.posts.length, 0, 'persisted intent may only issue GET')
    assert.equal(f.runner.lookups.at(-1).dispatched, true)
    assert.equal((await restarted.status(alice, recovery.action.actionId)).result.stdout, 'recovered')
  })

test('cancellation during preparation and uncertain POST reconcile without replay',
  { timeout: 60_000 }, async t => {
    const f = await setup(t)
    const service = f.makeService()
    const [alice] = f.users
    const cancelled = await propose(f, service, alice, f.saved[0], 'echo cancel-before-post')
    await service.decide(alice, cancelled.action.actionId, cancelled.action.fingerprint, true)
    f.runner.onPrepared = async () => { await service.cancel(alice, cancelled.action.actionId) }
    const first = await f.calls.claim(service.ownerId, 60_000, 'ssh.execute')
    await service.pump(first)
    f.runner.onPrepared = undefined
    const recovering = f.makeService(randomUUID())
    const second = await f.calls.claim(recovering.ownerId, 60_000, 'ssh.execute')
    await recovering.pump(second)
    assert.equal((await recovering.status(alice, cancelled.action.actionId)).state, 'cancelled')
    assert.equal(f.runner.posts.length, 0)
    assert.ok(f.runner.cleaned.includes(cancelled.action.actionId))
    const cancelContinuation = await f.tasks.claim(randomUUID())
    assert.equal(cancelContinuation.sourceSshExecuteActionId, cancelled.action.actionId)
    await f.tasks.finish(cancelContinuation.token, 'completed', null)

    const uncertain = await propose(f, service, alice, f.saved[0], 'echo maybe-executed')
    await service.decide(alice, uncertain.action.actionId, uncertain.action.fingerprint, true)
    f.runner.unknownOnce = true
    const claimed = await f.calls.claim(service.ownerId, 60_000, 'ssh.execute')
    await service.pump(claimed)
    assert.equal((await f.calls.get(alice, uncertain.action.actionId)).state, 'uncertain')
    assert.equal((await service.status(alice, uncertain.action.actionId)).state, 'uncertain')
    assert.equal(f.runner.posts.length, 1)
    await f.pool.query(`UPDATE pe_ssh_calls SET created_at=now()-interval '6 minutes',
      lease_until=now()-interval '1 second' WHERE id=$1`, [uncertain.action.actionId])
    const old = await f.calls.claim(recovering.ownerId, 60_000, 'ssh.execute')
    await recovering.pump(old)
    assert.equal((await recovering.status(alice, uncertain.action.actionId)).state, 'uncertain')
    assert.equal((await f.calls.get(alice, uncertain.action.actionId)).cleanup_complete, true)
    assert.equal(f.runner.posts.length, 1, 'reclaimed dispatch intent must not issue a second POST')
    const result = await f.tasks.claim(randomUUID())
    assert.equal(result.sourceSshExecuteActionId, uncertain.action.actionId)
    assert.match(result.text, /结果不明/u)
    await f.tasks.finish(result.token, 'completed', null)
  })

test('connection disable serializes with the first credential-bearing execute POST',
  { timeout: 60_000 }, async t => {
    const f = await setup(t)
    const service = f.makeService()
    const [alice] = f.users
    const approved = await propose(f, service, alice, f.saved[0], 'echo first')
    await service.decide(alice, approved.action.actionId, approved.action.fingerprint, true)
    let entered, release
    const atPost = new Promise(resolve => { entered = resolve })
    const mayFinish = new Promise(resolve => { release = resolve })
    f.runner.beforePost = async () => { entered(); await mayFinish }
    const row = await f.calls.claim(service.ownerId, 60_000, 'ssh.execute')
    const pumping = service.pump(row)
    await atPost
    let disabled = false
    const disabling = f.connections.toggle(alice, f.saved[0].connectionId, randomUUID(), 1, false)
      .then(value => { disabled = true; return value })
    // The POST is still in the call-and-connection lock; a concurrent disable cannot commit yet.
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(disabled, false)
    assert.equal(f.runner.posts.length, 0)
    release()
    await pumping
    const changed = await disabling
    assert.equal(changed.enabled, false)
    assert.equal(f.runner.posts.length, 1)
    assert.equal((await service.status(alice, approved.action.actionId)).state, 'succeeded')
    const continuation = await f.tasks.claim(randomUUID())
    await f.tasks.finish(continuation.token, 'completed', null)

    const enabled = await f.connections.toggle(alice, f.saved[0].connectionId, randomUUID(), 2, true)
    const later = await propose(f, service, alice, enabled, 'echo never')
    await service.decide(alice, later.action.actionId, later.action.fingerprint, true)
    await f.connections.toggle(alice, enabled.connectionId, randomUUID(), 3, false)
    f.runner.beforePost = undefined
    const blocked = await f.calls.claim(service.ownerId, 60_000, 'ssh.execute')
    await service.pump(blocked)
    assert.equal(f.runner.posts.length, 1, 'disable before first POST blocks credential dispatch')
    assert.equal((await service.status(alice, later.action.actionId)).state, 'failed')
  })

test('execute failure effects and missing exit status remain uncertain after restart without replay',
  { timeout: 60_000 }, async t => {
    const f = await setup(t)
    const [alice] = f.users
    const cases = [
      { reply: { state: 'failed', errorCode: 'ssh_authentication_failed', effectMayHaveOccurred: false }, state: 'failed' },
      { reply: { state: 'failed', errorCode: 'ssh_timeout', effectMayHaveOccurred: true }, state: 'uncertain' },
      { reply: { state: 'failed', errorCode: 'ssh_cancelled', effectMayHaveOccurred: true }, state: 'uncertain' },
      { reply: { state: 'failed', errorCode: 'ssh_network_error' }, state: 'uncertain' },
      { reply: { state: 'succeeded', result: { kind: 'ssh.execute', exitCode: null,
        signal: null, stdout: 'effect may already exist', stderr: '' } }, state: 'uncertain' },
      { reply: { state: 'succeeded', result: { kind: 'ssh.execute', exitCode: 7,
        signal: null, stdout: '', stderr: 'known nonzero exit' } }, state: 'succeeded' },
      { reply: { state: 'succeeded', result: { kind: 'ssh.execute', exitCode: null,
        signal: 'TERM', stdout: '', stderr: 'known signal' } }, state: 'succeeded' },
    ]
    for (const [index, entry] of cases.entries()) {
      const service = f.makeService(randomUUID())
      const proposed = await propose(f, service, alice, f.saved[0], `printf 'case-${index}'`)
      await service.decide(alice, proposed.action.actionId, proposed.action.fingerprint, true)
      f.runner.reply = entry.reply
      const row = await f.calls.claim(service.ownerId, 60_000, 'ssh.execute')
      await service.pump(row)
      const restarted = f.makeService(randomUUID())
      const result = await restarted.status(alice, proposed.action.actionId)
      assert.equal(result.state, entry.state)
      if (entry.state === 'succeeded') assert.deepEqual(result.result, entry.reply.result)
      if (index === 4) assert.equal(result.errorCode, 'ssh_exit_missing')
      assert.equal((await f.calls.get(alice, proposed.action.actionId)).state, entry.state)
      if (entry.state === 'uncertain') {
        await f.pool.query("UPDATE pe_ssh_calls SET lease_until=now()-interval '1 second' WHERE id=$1",
          [proposed.action.actionId])
        const cleanup = await f.calls.claim(restarted.ownerId, 60_000, 'ssh.execute')
        assert.equal(cleanup.id, proposed.action.actionId)
        await restarted.pump(cleanup)
        assert.equal((await f.calls.get(alice, proposed.action.actionId)).cleanup_complete, true)
      }
      assert.equal(f.runner.posts.length, index + 1)
      const continuation = await f.tasks.claim(randomUUID())
      assert.equal(continuation.sourceSshExecuteActionId, proposed.action.actionId)
      assert.equal(continuation.source, 'ssh_execute_result')
      if (entry.state === 'uncertain') assert.match(continuation.text, /远端执行结果不明，不得自动重试。/u)
      await f.tasks.finish(continuation.token, 'completed', null)
      assert.equal(await f.tasks.claim(randomUUID()), null)
    }
  })
