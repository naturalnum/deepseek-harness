/** Real PostgreSQL and fake Runner checks for durable SSH authentication coordination. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Pool } from 'pg'
import { identity, PlatformError } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { SshCallStore } from '../lib/platform/ssh-calls.js'
import { SshAuthenticationCheck } from '../lib/platform/ssh-check.js'
import { SshConnectionService } from '../lib/platform/ssh.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-native-s5')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const fingerprint = `SHA256:${'A'.repeat(43)}`

class FakeRunner {
  constructor() { this.posts = []; this.prepared = []; this.lookups = []; this.cleaned = [] }
  async prepare(callId, destination) {
    const handle = { callId, destination, podUid: randomUUID(), instanceId: randomUUID() }
    this.prepared.push(handle)
    await this.onPrepared?.(handle)
    return handle
  }
  digestFor(handle, request) {
    return createHash('sha256').update(JSON.stringify({ handle, request })).digest('hex')
  }
  async dispatchFirst(handle, request) {
    this.posts.push({ handle, request })
    if (this.crashAtIntent) {
      this.crashAtIntent = false
      throw new PlatformError(409, 'ssh_call_lease_lost')
    }
    return { state: 'known', status: { callId: handle.callId, instanceId: handle.instanceId,
      digest: this.digestFor(handle, request), state: 'succeeded',
      result: { kind: 'ssh.authenticate', serverBanner: 'fixture server' } } }
  }
  async reconcile(handle, dispatched, digest) {
    this.lookups.push({ handle, dispatched, digest })
    return this.observation ?? { state: 'uncertain', reason: 'dispatched_call_missing' }
  }
  async cancel(handle, digest) {
    this.lookups.push({ handle, dispatched: true, digest, cancel: true })
    return { state: 'uncertain', reason: 'cancel_effect_unknown' }
  }
  async cleanup(callId) { this.cleaned.push(callId) }
}

test('authentication admission is owner scoped and a restarted worker never repeats a dispatch intent',
  { timeout: 60_000 }, async t => {
    const database = `pe_s6_ssh_check_${randomBytes(8).toString('hex')}`
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
    const users = [identity.parse({ userId: randomUUID(), username: 'alice' }),
      identity.parse({ userId: randomUUID(), username: 'bob' })]
    for (const user of users) await pool.query(
      'INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
      [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
    const key = randomBytes(32).toString('base64url')
    const connections = new SshConnectionService(pool, key, 'fixture.example.test:2222')
    const saved = []
    for (const user of users) {
      const password = `${user.username}-private-password`
      const input = { requestId: randomUUID(), displayName: `${user.username} server`,
        host: 'fixture.example.test', port: 2222, username: user.username,
        hostKeySha256: fingerprint, credentialKind: 'password',
        sizeBytes: Buffer.byteLength(password), enabled: true }
      const issued = await connections.issueTicket(user, input, 'http://127.0.0.1:19221')
      saved.push((await connections.upload(issued.ticket, Readable.from([Buffer.from(password)]))).item)
    }
    const calls = new SshCallStore(pool)
    const runner = new FakeRunner()
    const requestKey = randomBytes(32).toString('base64url')
    const options = { ownerId: randomUUID(), requestKey, leaseMs: 1000,
      resolveHost: async () => '192.0.2.42' }
    const coordinator = new SshAuthenticationCheck(calls, connections, runner, options)
    const requestId = randomUUID()
    const firstInput = { requestId, connectionId: saved[0].connectionId, connectionRevision: 1 }
    const first = await coordinator.submit(users[0], firstInput)
    assert.deepEqual(await coordinator.submit(users[0], firstInput), first)
    await assert.rejects(coordinator.submit(users[0], { ...firstInput, connectionId: saved[1].connectionId }),
      { status: 409, code: 'request_id_conflict' })
    await assert.rejects(coordinator.status(users[1], first.callId),
      { status: 404, code: 'ssh_call_not_found' })
    await assert.rejects(coordinator.cancel(users[1], first.callId),
      { status: 404, code: 'ssh_call_not_found' })
    const second = await coordinator.submit(users[1],
      { requestId, connectionId: saved[1].connectionId, connectionRevision: 1 })
    assert.notEqual(second.callId, first.callId)
    runner.crashAtIntent = true
    assert.equal(await coordinator.pump(), true)
    const intent = await calls.get(users[0], first.callId)
    assert.equal(intent.state, 'dispatch-intent')
    assert.ok(intent.dispatch_digest)
    assert.ok(intent.pod_uid)
    assert.equal(runner.posts.length, 1)
    assert.equal(runner.posts[0].handle.destination.ip, '192.0.2.42')
    assert.equal(JSON.stringify(intent).includes('alice-private-password'), false)
    assert.deepEqual(await coordinator.status(users[0], first.callId),
      { callId: first.callId, state: 'dispatch-intent' })
    await new Promise(resolve => setTimeout(resolve, 1100))
    const restarted = new SshAuthenticationCheck(new SshCallStore(pool),
      new SshConnectionService(pool, key, 'fixture.example.test:2222'), runner,
      { ...options, ownerId: randomUUID() })
    runner.observation = { state: 'known', status: { callId: first.callId,
      instanceId: intent.runner_instance_id, digest: intent.dispatch_digest, state: 'succeeded',
      result: { kind: 'ssh.authenticate', serverBanner: 'recovered server',
        untrustedExtra: 'alice-private-password' } } }
    assert.equal(await restarted.pump(), true)
    assert.equal(runner.posts.length, 1, 'recovery uses GET, never a second POST')
    assert.equal(runner.lookups.at(-1).dispatched, true)
    assert.deepEqual(await restarted.status(users[0], first.callId),
      { callId: first.callId, state: 'succeeded',
        result: { kind: 'ssh.authenticate', serverBanner: 'recovered server' } })
    assert.equal(await restarted.pump(), true)
    assert.equal(runner.posts.length, 2, 'the other user has an independent call')
    assert.equal((await restarted.status(users[1], second.callId)).state, 'succeeded')
    const cancelled = await restarted.submit(users[0], { requestId: randomUUID(),
      connectionId: saved[0].connectionId, connectionRevision: 1 })
    runner.onPrepared = async handle => { await restarted.cancel(users[0], handle.callId) }
    assert.equal(await restarted.pump(), true)
    assert.equal((await restarted.status(users[0], cancelled.callId)).state, 'cancelled')
    assert.equal(runner.posts.length, 2, 'cancellation during preparation prevents dispatch')
    assert.ok(runner.cleaned.includes(cancelled.callId))
    assert.equal(await restarted.pump(), false)
    assert.equal(JSON.stringify(await pool.query('SELECT * FROM pe_ssh_calls')).includes('private-password'), false)
  })
