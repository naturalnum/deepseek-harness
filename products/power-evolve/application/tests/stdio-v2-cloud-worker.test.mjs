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
  const taskDigest = 'a'.repeat(64), preparedDigest = 'b'.repeat(64)
  const prepared = { taskDigest, preparedDigest, prepared: { capture: { kind: 'cloud', runnerInstanceId: writer.runnerInstanceId } } }
  const original = { state, taskDigest, task: { sessionId: randomUUID(), userId: randomUUID(), actionId, phase: 'discover' },
    executionRef: { kind: 'cloud', executionId }, writer: state === 'queued' ? null : writer,
    cancelRequested: false, prepared: state === 'queued' ? null : prepared,
    dispatch: state === 'dispatch-intent' ? { executionRef: { kind: 'cloud', executionId } } : null }
  const events = [], failures = {}, observation = { view: { state: 'completed' }, stopEvidence: { kind: 'cloud_uid_quiet' } }
  const bindingSnapshot = { spaceId: randomUUID(), rootRelativePath: '', workspaceId: randomUUID(), rootKey: randomUUID(), generation: 1 }
  let noStart = null, creationStopped = false
  const closure = () => ({ formatVersion: 2, kind: 'unstarted_closed', actionId,
    executionRef: original.executionRef, taskDigest, userId: original.task.userId, sessionId: original.task.sessionId,
    phase: 'discover', state: 'cancelled', startNeverAuthorized: true, preparedDigest: original.prepared?.preparedDigest ?? null,
    resource: original.writer ? { kind: 'ready_retained', ...original.writer, mountGeneration: '1', bindingSnapshot }
      : creationStopped ? { kind: 'creation_stopped', name: writer.name, mountGeneration: '1', bindingSnapshot,
        stopEvidence: { status: 'KUBELET_STOPPED', podUid: writer.podUid, sandboxUid: randomUUID(), generation: '1',
          sessionId: original.task.sessionId, runnerInstanceId: null, bindingSnapshot, observedAt: new Date().toISOString() } }
        : { kind: 'unallocated' } })
  const store = {
    async claimNext() { events.push('claim'); return lease },
    async renew() { events.push('renew'); if (failures.renew) throw new Error('unavailable'); return lease },
    async snapshot() { events.push('snapshot'); if (failures.snapshot) throw new PlatformError(409, 'stdio_v2_lease_lost'); return structuredClone(original) },
    async beginPreparation() { events.push('begin'); original.state = 'preparing' },
    async attach(_lease, ready) { events.push('attach'); original.writer = ready },
    async defer(_lease, code) {
      events.push(['defer', code])
      if (code === 'stdio_v2_cancel_requested') original.cancelRequested = true
      if (code === 'stdio_v2_cancel_requested' || original.dispatch || !original.prepared || original.state !== 'approved') original.state = 'blocked'
    },
    async release() { events.push('release') },
    async capture(_lease, mode, operation) { events.push(['capture', mode]); return operation({}) },
    async assertProvisioning(client, receivedLease, session, user, mode) {
      events.push(['provision', mode])
      assert.deepEqual(receivedLease, lease); assert.equal(session, original.task.sessionId); assert.equal(user, original.task.userId)
      assert.equal(client, provisioningClient)
    },
    async closeUnstarted(receivedLease) {
      events.push('close-unstarted'); assert.deepEqual(receivedLease, lease)
      if (original.task.phase !== 'discover') throw new PlatformError(409, 'stdio_v2_no_start_call_unavailable')
      if (failures.closureProof) throw new PlatformError(409, 'stdio_v2_no_start_resources_unavailable')
      noStart = closure(); original.state = 'cancelled'
      if (failures.closureReply) throw new Error('unknown COMMIT acknowledgement')
      return structuredClone(noStart)
    },
    async readNoStart(receivedAction) { events.push('read-no-start'); assert.equal(receivedAction, actionId); return structuredClone(noStart) },
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
  const provisioningClient = {}
  const sandboxes = {
    async ensureReady(_session, _user, assertLive, fence) {
      events.push('ensure'); await assertLive()
      for (const mode of ['acquire', 'mutation', 'record']) await fence(provisioningClient, mode)
      return writer
    },
    async cancelCreation(receivedExecution, session, user, owner, assertLive) {
      events.push('cancel-creation')
      assert.equal(receivedExecution, executionId); assert.equal(session, original.task.sessionId)
      assert.equal(user, original.task.userId); assert.equal(owner, workerId)
      await assertLive(); failures.closureProof = false; creationStopped = true
    },
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
  return { lease, original, events, failures, store, authorization, sandboxes, transport, results, options, create,
    closure, provisioningClient }
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

test('cancellation without resources finalizes only through the original no-start closure', async () => {
  const f = fixture(); f.original.cancelRequested = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert(f.events.includes('close-unstarted')); assert(!f.events.includes('cancel-creation'))
  for (const forbidden of ['ensure', 'prepare', 'authorize', 'start', 'cancel', 'record']) assert(!f.events.includes(forbidden))
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

test('provisioning uses the supplied transaction client and original action lease in every mode', async () => {
  const f = fixture()
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'pending')
  assert.deepEqual(f.events.filter(event => Array.isArray(event) && event[0] === 'provision'),
    [['provision', 'acquire'], ['provision', 'mutation'], ['provision', 'record']])
})

test('a provisioning fence rejects stale creation before attach or permission issuance', async () => {
  const f = fixture()
  f.store.assertProvisioning = async () => { f.events.push('fence-lost'); throw new PlatformError(409, 'stdio_v2_lease_lost') }
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'lease-lost')
  for (const forbidden of ['attach', 'prepare', 'authorize', 'start', 'release']) assert(!f.events.includes(forbidden))
})

test('renewal loss during a provisioning transaction rejects its late acknowledgement', async () => {
  const f = fixture(), entered = gate(), renewed = gate(), completed = gate()
  f.options.renewMs = 5
  f.store.renew = async () => { renewed.resolve(); throw new Error('unavailable') }
  f.store.assertProvisioning = async () => { entered.resolve(); await completed.promise }
  const attempt = f.create().step(f.lease, new AbortController().signal)
  await entered.promise; await renewed.promise; completed.resolve()
  assert.equal(await attempt, 'lease-lost')
  for (const forbidden of ['attach', 'prepare', 'authorize', 'start', 'release']) assert(!f.events.includes(forbidden))
})

test('a creation finishing during shutdown can record its original identity without starting', async () => {
  const f = fixture(), entered = gate(), completed = gate()
  let first = true
  f.store.claimNext = async () => { if (!first) return null; first = false; return f.lease }
  f.sandboxes.ensureReady = async (_session, _user, _assertLive, fence) => {
    entered.resolve(); await completed.promise
    await fence(f.provisioningClient, 'record')
    return { name: 'original', podUid: randomUUID(), runnerInstanceId: randomUUID() }
  }
  const worker = f.create(), run = worker.run(new AbortController().signal)
  await entered.promise
  const stop = worker.stop()
  completed.resolve(); await stop; await run
  assert(f.events.includes('attach'))
  assert(f.events.some(event => Array.isArray(event) && event[0] === 'provision' && event[1] === 'record'))
  for (const forbidden of ['prepare', 'authorize', 'start', 'record']) assert(!f.events.includes(forbidden))
})

test('only missing original resource proof permits creation cleanup before a second closure attempt', async () => {
  const f = fixture(); f.original.cancelRequested = true; f.failures.closureProof = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert.deepEqual(f.events.filter(event => ['close-unstarted', 'cancel-creation'].includes(event)),
    ['close-unstarted', 'cancel-creation', 'close-unstarted'])
  for (const forbidden of ['ensure', 'prepare', 'authorize', 'start', 'cancel', 'record', 'read-no-start']) assert(!f.events.includes(forbidden))
})

test('an undispatched ready writer retains its mounts and finalizes through ready-retained closure', async () => {
  const f = fixture('pending'); f.original.cancelRequested = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert(f.original.writer)
  for (const forbidden of ['cancel-creation', 'ensure', 'prepare', 'authorize', 'start', 'cancel', 'record']) assert(!f.events.includes(forbidden))
})

test('missing proof on a ready writer remains deferred without deleting its mounts', async () => {
  const f = fixture('pending'); f.original.cancelRequested = true; f.failures.closureProof = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  assert(f.original.writer); assert.equal(f.events.filter(event => event === 'close-unstarted').length, 1)
  for (const forbidden of ['cancel-creation', 'start', 'cancel', 'record', 'read-no-start']) assert(!f.events.includes(forbidden))
})

test('unknown creation cleanup cannot produce a final result or retry closure without stop proof', async () => {
  const f = fixture(); f.original.cancelRequested = true; f.failures.closureProof = true
  f.sandboxes.cancelCreation = async () => { f.events.push('cancel-creation'); throw new Error('stop evidence unavailable') }
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  assert.equal(f.events.filter(event => event === 'close-unstarted').length, 1)
  assert.equal(f.original.cancelRequested, true); assert.equal(f.original.dispatch, null)
  for (const forbidden of ['start', 'cancel', 'record', 'read-no-start']) assert(!f.events.includes(forbidden))
})

test('lost closure COMMIT reply reads the matching original receipt without another closure write', async () => {
  const f = fixture(); f.original.cancelRequested = true; f.failures.closureReply = true
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'finalized')
  assert.equal(f.events.filter(event => event === 'close-unstarted').length, 1)
  assert.equal(f.events.filter(event => event === 'read-no-start').length, 1)
  for (const forbidden of ['cancel-creation', 'authorize', 'start', 'cancel', 'record']) assert(!f.events.includes(forbidden))
})

test('an absent closure readback remains deferred and never repeats the uncertain transaction', async () => {
  const f = fixture(); f.original.cancelRequested = true
  f.store.closeUnstarted = async () => { f.events.push('close-unstarted'); throw new Error('unknown COMMIT acknowledgement') }
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  assert.equal(f.events.filter(event => event === 'close-unstarted').length, 1)
  assert.equal(f.events.filter(event => event === 'read-no-start').length, 1)
  for (const forbidden of ['cancel-creation', 'start', 'cancel', 'record']) assert(!f.events.includes(forbidden))
})

test('a closure receipt must match every original identity and prepared writer', async t => {
  for (const [field, change] of [
    ['action', receipt => { receipt.actionId = randomUUID() }],
    ['execution', receipt => { receipt.executionRef.executionId = randomUUID() }],
    ['task', receipt => { receipt.taskDigest = 'c'.repeat(64) }],
    ['user', receipt => { receipt.userId = randomUUID() }],
    ['session', receipt => { receipt.sessionId = randomUUID() }],
    ['prepared', receipt => { receipt.preparedDigest = 'c'.repeat(64) }],
    ['writer-name', receipt => { receipt.resource.name = 'replacement' }],
    ['writer-pod', receipt => { receipt.resource.podUid = randomUUID() }],
    ['writer-runner', receipt => { receipt.resource.runnerInstanceId = randomUUID() }],
  ]) await t.test(field, async () => {
    const f = fixture('pending'); f.original.cancelRequested = true
    f.store.closeUnstarted = async () => { f.events.push('close-unstarted'); throw new Error('unknown COMMIT acknowledgement') }
    f.store.readNoStart = async () => { f.events.push('read-no-start'); const receipt = f.closure(); change(receipt); return receipt }
    assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
    assert.equal(f.events.filter(event => event === 'close-unstarted').length, 1)
    assert(!f.events.includes('record')); assert(!f.events.includes('cancel-creation')); assert(!f.events.includes('start'))
  })
})

test('formal lease loss at closure prevents both readback and further lease writes', async () => {
  const f = fixture(); f.original.cancelRequested = true
  f.store.closeUnstarted = async () => { f.events.push('close-unstarted'); throw new PlatformError(409, 'stdio_v2_lease_lost') }
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'lease-lost')
  for (const forbidden of ['read-no-start', 'cancel-creation', 'record', 'release']) assert(!f.events.includes(forbidden))
})

test('renewal loss during closure suppresses readback after its unknown acknowledgement', async () => {
  const f = fixture(), entered = gate(), renewed = gate(), completed = gate()
  f.original.cancelRequested = true; f.options.renewMs = 5
  f.store.renew = async () => { renewed.resolve(); throw new Error('unavailable') }
  f.store.closeUnstarted = async () => { f.events.push('close-unstarted'); entered.resolve(); await completed.promise; throw new Error('unknown COMMIT acknowledgement') }
  const attempt = f.create().step(f.lease, new AbortController().signal)
  await entered.promise; await renewed.promise; completed.resolve()
  assert.equal(await attempt, 'lease-lost')
  for (const forbidden of ['read-no-start', 'cancel-creation', 'record', 'release']) assert(!f.events.includes(forbidden))
})

test('call no-start cancellation remains deferred until its distinct continuation protocol exists', async () => {
  const f = fixture(); f.original.cancelRequested = true; f.original.task.phase = 'call'
  assert.equal(await f.create().step(f.lease, new AbortController().signal), 'deferred')
  for (const forbidden of ['read-no-start', 'cancel-creation', 'authorize', 'start', 'cancel', 'record']) assert(!f.events.includes(forbidden))
})

test('concurrent stop waits for the original no-start closure and never authorizes a writer', async () => {
  const f = fixture(), entered = gate(), completed = gate()
  f.original.cancelRequested = true
  let first = true
  f.store.claimNext = async () => { if (!first) return null; first = false; return f.lease }
  const close = f.store.closeUnstarted
  f.store.closeUnstarted = async received => { entered.resolve(); await completed.promise; return close(received) }
  const worker = f.create(), run = worker.run(new AbortController().signal)
  await entered.promise
  let stopped = 0
  const stops = [worker.stop().then(() => { stopped++ }), worker.stop().then(() => { stopped++ })]
  await Promise.resolve(); assert.equal(stopped, 0)
  completed.resolve(); await Promise.all(stops); await run
  assert.equal(stopped, 2); assert.equal(f.events.filter(event => event === 'close-unstarted').length, 1)
  for (const forbidden of ['ensure', 'prepare', 'authorize', 'start', 'cancel', 'record']) assert(!f.events.includes(forbidden))
})
