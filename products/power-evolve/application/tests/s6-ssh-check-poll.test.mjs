/** Real PG authentication polling with controlled Runner replies and unchanged dispatch identities. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { identity } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { SshCallFixtureStore as SshCallStore } from './task-credential-fixture.mjs'
import { SshAuthenticationFixtureCheck as SshAuthenticationCheck } from './task-credential-fixture.mjs'
import { SshConnectionService } from '../lib/platform/ssh.js'

class Runner {
  posts = []
  prepared = []
  lookups = []
  cleaned = []
  reply = 'running'
  async prepare(callId, destination) {
    const handle = { callId, destination, podUid: randomUUID(), instanceId: randomUUID() }
    this.prepared.push(handle)
    return handle
  }
  digestFor(handle, request) {
    return createHash('sha256').update(JSON.stringify({ handle, request })).digest('hex')
  }
  observation(handle, digest) {
    if (this.reply === 'unknown') return { state: 'uncertain', reason: 'dispatch_outcome_unknown' }
    return { state: 'known', status: { callId: handle.callId, instanceId: handle.instanceId,
      digest: this.reply === 'wrong-digest' ? '0'.repeat(64) : digest,
      state: this.reply === 'succeeded' ? 'succeeded' : 'running',
      ...(this.reply === 'succeeded' ? { result: { kind: 'ssh.authenticate', serverBanner: 'fixture server' } } : {}) } }
  }
  async dispatchFirst(handle, request) {
    this.posts.push({ handle, request })
    return this.observation(handle, this.digestFor(handle, request))
  }
  async reconcile(handle, dispatched, digest) {
    this.lookups.push({ handle, dispatched, digest })
    return this.observation(handle, digest)
  }
  async cleanup(callId) { this.cleaned.push(callId) }
}

const options = { ownerId: randomUUID(), requestKey: randomBytes(32).toString('base64url'),
  leaseMs: 90_000, pollMs: 1000, resolveHost: async () => '192.0.2.42' }

test('authentication polling requires an explicit bounded interval', () => {
  for (const pollMs of [undefined, 0, 99, 100.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new SshAuthenticationCheck({}, {}, {}, { ...options, pollMs }),
      /Invalid SSH check configuration/u)
  }
  assert.doesNotThrow(() => new SshAuthenticationCheck({}, {}, {}, { ...options, pollMs: 100 }))
})

test('authentication observations use configured polling while lease and dispatch fences survive handoff',
  { timeout: 30_000 }, async t => {
    const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-native-s5')
    const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
    const database = `pe_s6_ssh_check_poll_${randomBytes(8).toString('hex')}`
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
    pool = new Pool({ connectionString: url.href, max: 4 })
    await initializeDatabase(pool)
    const alice = identity.parse({ userId: randomUUID(), username: 'alice' })
    const bob = identity.parse({ userId: randomUUID(), username: 'bob' })
    const connections = new SshConnectionService(pool, randomBytes(32).toString('base64url'),
      'fixture.example.test:2222')
    const saved = []
    for (const user of [alice, bob]) {
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
      const ticket = await connections.issueTicket(user, { requestId: randomUUID(),
        displayName: `${user.username} fixture`, host: 'fixture.example.test', port: 2222,
        username: user.username, hostKeySha256: `SHA256:${'A'.repeat(43)}`,
        credentialKind: 'password', sizeBytes: 7, enabled: true }, 'http://127.0.0.1:19221')
      saved.push((await connections.upload(ticket.ticket, Readable.from([Buffer.from('fixture')]))).item)
    }
    const calls = new SshCallStore(pool), runner = new Runner()
    const coordinator = new SshAuthenticationCheck(calls, connections, runner, options)
    const submit = (worker, user, index) => worker.submit(user, { requestId: randomUUID(),
      connectionId: saved[index].connectionId, connectionRevision: 1 })
    const leaseOf = row => ({ callId: row.id, owner: options.ownerId, epoch: row.lease_epoch })
    const dispatchOf = row => ({ destination: row.destination, podUid: row.pod_uid,
      instanceId: row.runner_instance_id, digest: row.dispatch_digest,
      owner: row.dispatch_owner, epoch: row.dispatch_epoch })

    await t.test('running is reclaimed after the poll delay, not the 90-second lease', async () => {
      const admitted = await submit(coordinator, alice, 0)
      assert.equal(await coordinator.pump(), true)
      const running = await calls.get(alice, admitted.callId)
      const oldLease = leaseOf(running)
      assert.equal(running.state, 'running')
      assert.equal(running.lease_owner, null)
      assert.equal(running.lease_until.getTime() - running.updated_at.getTime(), options.pollMs)
      assert.equal(await coordinator.pump(), false)
      await assert.rejects(calls.renew(oldLease, options.leaseMs), { code: 'ssh_call_lease_lost' },
        'a late heartbeat cannot extend the released lease')
      await assert.rejects(coordinator.status(bob, admitted.callId), { status: 404, code: 'ssh_call_not_found' })
      await delay(options.pollMs + 50)

      const recoveredCalls = new SshCallStore(pool)
      const claim = recoveredCalls.claim.bind(recoveredCalls)
      let fenced = false
      // Reuse the same owner so these failures specifically require the epoch check.
      recoveredCalls.claim = async (...args) => {
        const row = await claim(...args)
        if (row && !fenced) {
          fenced = true
          assert.equal(row.id, running.id)
          assert.ok(row.lease_epoch > oldLease.epoch)
          await assert.rejects(calls.renew(oldLease, options.leaseMs), { code: 'ssh_call_lease_lost' })
          await assert.rejects(calls.deferRunning(oldLease, 100), { code: 'ssh_call_lease_lost' })
          await assert.rejects(calls.recordStatus(oldLease, { callId: row.id, instanceId: row.runner_instance_id,
            digest: row.dispatch_digest, state: 'running' }), { code: 'ssh_call_state_or_identity_changed' })
          await assert.rejects(calls.assertDispatchLease(leaseOf(row)), { code: 'ssh_call_lease_lost' },
            'a reclaimed running call has no new first-POST permit')
          const current = await recoveredCalls.get(alice, row.id)
          assert.equal(current.lease_epoch, row.lease_epoch)
          assert.equal(current.lease_owner, options.ownerId)
          assert.equal(current.lease_until.getTime(), row.lease_until.getTime())
        }
        return row
      }
      const recovered = new SshAuthenticationCheck(recoveredCalls, connections, runner, { ...options, pollMs: 200 })
      assert.equal(await recovered.pump(), true)
      assert.equal(fenced, true)
      const observed = await calls.get(alice, running.id)
      assert.equal(observed.state, 'running')
      assert.equal(observed.lease_owner, null)
      assert.equal(observed.lease_until.getTime() - observed.updated_at.getTime(), 200)
      assert.deepEqual(dispatchOf(observed), dispatchOf(running))
      assert.deepEqual(runner.lookups[0], { handle: runner.prepared[0], dispatched: true,
        digest: running.dispatch_digest })
      await delay(250)
      runner.reply = 'succeeded'
      assert.equal(await recovered.pump(), true)
      const finished = await calls.get(alice, running.id)
      assert.equal(finished.state, 'succeeded')
      assert.equal(finished.cleanup_complete, true)
      assert.deepEqual(dispatchOf(finished), dispatchOf(running))
      assert.equal(runner.posts.length, 1)
      assert.equal(runner.prepared.length, 1)
      assert.equal(runner.lookups.length, 2)
      assert.deepEqual(runner.cleaned, [running.id])
      await assert.rejects(calls.deferRunning(leaseOf(finished), 100), { code: 'ssh_call_lease_lost' })
    })

    await t.test('unknown and unverified running replies retain their recovery lease', async () => {
      for (const [reply, state] of [['unknown', 'uncertain'], ['wrong-digest', 'dispatch-intent']]) {
        runner.reply = reply
        const admitted = await submit(coordinator, bob, 1)
        assert.equal(await coordinator.pump(), true)
        const row = await calls.get(bob, admitted.callId)
        assert.equal(row.state, state)
        assert.equal(row.lease_owner, options.ownerId)
        assert.ok(row.lease_until.getTime() - row.updated_at.getTime() > 80_000)
        await assert.rejects(calls.deferRunning(leaseOf(row), 100), { code: 'ssh_call_lease_lost' })
        assert.equal(await coordinator.pump(), false)
      }
      assert.equal(runner.posts.length, 3)
      assert.equal(runner.lookups.length, 2)
    })

    await t.test('invalid poll delay is rejected before a store query', async () => {
      for (const pollMs of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(calls.deferRunning({ callId: randomUUID(), owner: options.ownerId, epoch: 1 }, pollMs),
          /Invalid SSH call poll delay/u)
      }
    })
  })
