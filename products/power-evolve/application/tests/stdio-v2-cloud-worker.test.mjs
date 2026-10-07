/** Synthetic orchestration failures; real PG and executor evidence are recorded separately. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { StdioCloudWorkerV2 } from '../lib/platform/stdio-v2-cloud-worker.js'
import { PlatformError } from '../lib/contracts.js'

function gate() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(state = 'queued') {
  const workerId = randomUUID(), actionId = randomUUID(), executionId = randomUUID()
  const lease = { workerId, actionId, leaseEpoch: 1 }
  const writer = { name: 'original', podUid: randomUUID(), runnerInstanceId: randomUUID() }
  const prepared = { prepared: { capture: { kind: 'cloud', runnerInstanceId: writer.runnerInstanceId } } }
  const original = { state, task: { sessionId: randomUUID(), userId: randomUUID(), actionId },
    executionRef: { kind: 'cloud', executionId }, writer: state === 'queued' ? null : writer,
    cancelRequested: false, prepared: state === 'queued' ? null : prepared,
    dispatch: state === 'dispatch-intent' ? { executionRef: { kind: 'cloud', executionId } } : null }
  const events = [], failures = {}, observation = { view: { state: 'completed' }, stopEvidence: { kind: 'cloud_uid_quiet' } }
  const store = {
    async claimNext() { events.push('claim'); return lease },
    async renew() { events.push('renew'); if (failures.renew) throw new Error('unavailable'); return lease },
    async snapshot() { events.push('snapshot'); if (failures.snapshot) throw new PlatformError(409, 'stdio_v2_lease_lost'); return structuredClone(original) },
    async beginPreparation() { events.push('begin'); original.state = 'preparing' },
    async attach(_lease, ready) { events.push('attach'); original.writer = ready },
    async defer(_lease, code) {
      events.push(['defer', code])
      if (code === 'stdio_v2_cancel_requested' || original.dispatch || !original.prepared || original.state !== 'approved') original.state = 'blocked'
    },
    async release() { events.push('release') },
    async capture(_lease, mode, operation) { events.push(['capture', mode]); return operation({}) },
  }
  const authorization = {
    async prepareLeased() {
      events.push('prepare'); if (failures.prepare) throw new Error('capture unavailable')
      original.prepared = prepared; original.state = 'pending'; return prepared
    },
    async authorizeLeased() {
      events.push('authorize'); if (failures.beforeAuthorization) throw new Error('unavailable before permit')
      original.dispatch = { executionRef: original.executionRef }; original.state = 'dispatch-intent'
      if (failures.authorization) throw new Error('lost commit acknowledgement')
      return { grantOnce: !failures.falseGrant, permit: {} }
    },
  }
  const sandboxes = {
    async ensureReady(_session, _user, assertLive) { events.push('ensure'); await assertLive(); return writer },
    async cancelCreation() { events.push('cancel-creation') },
  }
  const transport = {
    async startDetached(_dispatch, grant) {
      events.push(grant.grantOnce ? 'start' : 'query-false')
      if (failures.start) throw new Error('lost network reply')
      return failures.absent ? null : observation
    },
    async observeDetached() { events.push('observe'); return failures.absent ? null : observation },
    async cancelDetached() { events.push('cancel'); return failures.absent ? null : observation },
  }
  const results = { async record(_lease, received) { events.push('record'); assert.deepEqual(received, observation); return { finalized: true } } }
  const options = { workerId, pollMs: 5, renewMs: 100, leaseMs: 1000 }
  const create = () => new StdioCloudWorkerV2(store, authorization, sandboxes, transport, results, options)
  return { lease, original, events, failures, store, authorization, sandboxes, transport, results, options, create }
}

test('first preparation creates a ready writer and waits for independent approval without starting', async () => {
  const f = fixture()
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'pending')
  assert.deepEqual(f.events.filter(event => typeof event === 'string' && event !== 'snapshot'),
    ['begin', 'ensure', 'attach', 'prepare', 'release'])
})

test('only a confirmed true grant starts after its original dispatch is durable', async () => {
  const f = fixture('approved')
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert(f.events.indexOf('authorize') < f.events.indexOf('start'))
  assert(f.original.dispatch)
  assert(!f.events.includes('ensure'))
  assert.equal(f.events.filter(event => event === 'start').length, 1)
})

test('cold committed dispatch only queries the original runner, with no prepare, authorization or creation', async () => {
  const f = fixture('dispatch-intent')
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert(f.events.includes('observe'))
  for (const forbidden of ['begin', 'ensure', 'attach', 'prepare', 'authorize', 'start']) assert(!f.events.includes(forbidden))
})

test('an unavailable creation is retried through the same original reservation before any approval', async () => {
  const f = fixture(), create = f.sandboxes.ensureReady
  f.sandboxes.ensureReady = async () => { f.events.push('ensure-unavailable'); throw new Error('unavailable') }
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  assert.equal(f.original.writer, null); assert.equal(f.original.dispatch, null)
  f.sandboxes.ensureReady = create
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'pending')
  assert.equal(f.events.filter(event => event === 'attach').length, 1)
  assert(!f.events.includes('start'))
})

test('a failed preparation capture retains its writer and retries without provisioning a replacement', async () => {
  const f = fixture(); f.failures.prepare = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  assert(f.original.writer); assert.equal(f.original.prepared, null)
  f.failures.prepare = false
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'pending')
  assert.equal(f.events.filter(event => event === 'ensure').length, 1)
  assert.equal(f.events.filter(event => event === 'attach').length, 1)
  assert(!f.events.includes('authorize'))
})

test('lost authorization COMMIT reply recovers through original query without another grant', async () => {
  const f = fixture('approved'); f.failures.authorization = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  assert(f.original.dispatch)
  assert(!f.events.includes('start'))
  f.failures.authorization = false
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert.equal(f.events.filter(event => event === 'authorize').length, 1)
  assert.equal(f.events.filter(event => event === 'observe').length, 1)
})

test('capture failure before a start permit retains the exact approval for a later first grant', async () => {
  const f = fixture('approved'); f.failures.beforeAuthorization = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  assert.equal(f.original.state, 'approved'); assert.equal(f.original.dispatch, null)
  f.failures.beforeAuthorization = false
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert.equal(f.events.filter(event => event === 'start').length, 1)
  assert.equal(f.events.filter(event => event === 'ensure').length, 0)
})

test('lost first POST reply never repeats start, even after worker replacement', async () => {
  const f = fixture('approved'); f.failures.start = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  f.failures.start = false
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert.equal(f.events.filter(event => event === 'start').length, 1)
  assert.equal(f.events.filter(event => event === 'observe').length, 1)
})

test('absent original runner keeps a deferred reservation without provisioning or final result', async () => {
  const f = fixture('dispatch-intent'); f.failures.absent = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  assert(f.events.some(event => Array.isArray(event) && event[1] === 'stdio_v2_runner_absent'))
  assert(!f.events.includes('ensure')); assert(!f.events.includes('record'))
})

test('cancellation before creation invokes only original creation cleanup and retains unresolved state', async () => {
  const f = fixture(); f.original.cancelRequested = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  assert(f.events.includes('cancel-creation'))
  for (const forbidden of ['ensure', 'prepare', 'authorize', 'start', 'record']) assert(!f.events.includes(forbidden))
})

test('revoked dispatch is cancelled and recorded without obtaining fresh start permission', async () => {
  const f = fixture('dispatch-intent'); f.original.cancelRequested = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert(f.events.includes('cancel')); assert(!f.events.includes('authorize')); assert(!f.events.includes('start'))
})

test('renewal failure during slow creation prevents attach and permission issuance', async () => {
  const f = fixture(), entered = gate(), completed = gate(), renewed = gate()
  f.options.renewMs = 5
  f.store.renew = async () => { f.events.push('renew'); renewed.resolve(); throw new Error('unavailable') }
  f.sandboxes.ensureReady = async () => {
    // A provider can return after its last lease callback; the worker must guard attach independently.
    entered.resolve(); await completed.promise; return { name: 'original-ready' }
  }
  const attempt = f.create().step(f.lease, new AbortController().signal)
  await entered.promise
  await renewed.promise; completed.resolve()
  assert.equal(await attempt, 'lease-lost')
  for (const forbidden of ['attach', 'authorize', 'start', 'record']) assert(!f.events.includes(forbidden))
})

test('shutdown during creation waits for its exact identity to be persisted and skips preparation', async () => {
  const f = fixture(), entered = gate(), completed = gate()
  let first = true
  f.store.claimNext = async () => { if (!first) return null; first = false; return f.lease }
  f.sandboxes.ensureReady = async () => { entered.resolve(); await completed.promise; return { name: 'same' } }
  const worker = f.create(), run = worker.run(new AbortController().signal)
  await entered.promise
  let stopped = false
  const stop = worker.stop().then(() => { stopped = true })
  await Promise.resolve(); assert.equal(stopped, false)
  completed.resolve(); await stop; await run
  assert(f.events.includes('attach')); assert(!f.events.includes('prepare')); assert(!f.events.includes('start'))
})

test('shutdown waits for an in-flight true authorization and never uses its permission after stopping', async () => {
  const f = fixture('approved'), entered = gate(), completed = gate()
  let first = true
  f.store.claimNext = async () => { if (!first) return null; first = false; return f.lease }
  const originalAuthorize = f.authorization.authorizeLeased
  f.authorization.authorizeLeased = async () => { entered.resolve(); await completed.promise; return originalAuthorize() }
  const worker = f.create(), run = worker.run(new AbortController().signal)
  await entered.promise
  let stopped = false
  const stop = worker.stop().then(() => { stopped = true })
  await Promise.resolve(); assert.equal(stopped, false)
  completed.resolve(); await stop; await run
  assert(f.original.dispatch); assert(!f.events.includes('start'))
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert(f.events.includes('observe'))
})

test('one worker cannot process two concurrent actions or a different process generation', async () => {
  const f = fixture('dispatch-intent'), entered = gate(), completed = gate()
  f.transport.observeDetached = async () => { entered.resolve(); await completed.promise; return null }
  const worker = f.create(), attempt = worker.step(f.lease, new AbortController().signal)
  await entered.promise
  await assert.rejects(worker.step(f.lease, new AbortController().signal), /stdio_v2_worker_running/u)
  let stopped = false
  const stop = worker.stop().then(() => { stopped = true })
  await Promise.resolve(); assert.equal(stopped, false)
  completed.resolve(); await attempt; await stop
  await assert.rejects(worker.step({ ...f.lease, workerId: randomUUID() }, new AbortController().signal), /stdio_v2_worker_owner_changed/u)
})
