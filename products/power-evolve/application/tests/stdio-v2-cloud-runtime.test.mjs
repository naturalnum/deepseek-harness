/** Private transport substitutes only: no PostgreSQL, Kubernetes, Runner process or user program is contacted. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { StdioCloudRunTransportV2 } from '../lib/platform/stdio-v2-cloud-runtime.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'
import { stdioDispatchV2, stdioPreparedV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCloudStopEvidenceV2, stdioRuntimeViewV2 } from '@power-evolve/contracts/stdio-runtime'
import { parseStdioStartV2 } from '@power-evolve/connector-runner/stdio-v2-dispatch'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'

const clone = value => structuredClone(value)
const limits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0, killGraceMs: 1000,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16384,
  maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
const options = { limits, maxReplyBytes: 32768, requestTimeoutMs: 3000, maxTrackedActions: 2 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const sha = (domain, value) => stdioSha256V2(domain, value, budget)
const refused = code => error => error.status === 409 && error.code === code
const changed = refused('stdio_v2_cloud_original_changed')
const unavailable = refused('stdio_v2_cloud_runner_unavailable')
const invalidReply = refused('stdio_v2_cloud_runner_reply_invalid')
const trackingFull = refused('stdio_v2_cloud_tracking_full')
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(phase = 'call', selectedOptions = options) {
  const userId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID(), actionId = randomUUID()
  const binding = { workspaceId, spaceId: randomUUID(), rootKey: randomUUID(), rootRelativePath: 'accepted-project', generation: 7 }
  const pin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
    imageReference: `registry.example/runner@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'c'.repeat(64)}`,
    runtimeImageIds: [`containerd://${'b'.repeat(64)}`, `containerd://${'d'.repeat(64)}`] }
  const image = { kind: 'cloud', platform: clone(pin.platform), imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }
  const scope = { kind: 'cloud', userId, workspaceId, bindingGeneration: 7,
    target: { spaceId: binding.spaceId, rootRelativePath: binding.rootRelativePath }, home: { kind: 'user', userId } }
  const catalog = [{ name: 'read_note', inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: true }, _meta: { complete: '保留\0😀' } },
  { name: 'write_note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { destructiveHint: true }, extension: { order: [3, 1] } }]
  const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, actionId, userId, sessionId,
    connectionId: randomUUID(), configRevision: 3, configDigest: 'e'.repeat(64), scopeBinding: scope, expectedDeploymentPin: pin,
    invocation: { program: 'python3', argv: ['-m', 'literal_process', '--flag=value'], cwd: '.' }, limits, phase,
    ...(phase === 'discover' ? { origin: { kind: 'stdio_discovery', requestId: randomUUID() } }
      : { origin: { kind: 'operation', operationId: randomUUID(), rootOperationId: randomUUID(), callKey: 'literal-call-key' },
        selection: { catalogId: randomUUID(), catalogDigest: stdioCatalogFingerprintV2(catalog, limits), rawCatalog: catalog,
          catalogImageExpectation: image, rawName: 'write_note', rawDescriptor: catalog[1], arguments: { '10': 'ten', '2': 'two', text: 'value\0kept' } } }) })
  const ref = { kind: 'cloud', executionId: randomUUID() }, name = `pe-sb-${userId.replaceAll('-', '')}`
  const podUid = randomUUID(), runnerInstanceId = randomUUID()
  const observed = { actualExecutorImage: image,
    capture: { kind: 'cloud', podUid, podName: name, namespace: 'synthetic', nodeName: 'synthetic-node', runnerInstanceId,
      containerId: `containerd://${'f'.repeat(64)}`, restartCount: 2, mountGeneration: '13',
      workspaceMount: { claimName: 'owned-pvc', subPath: `workspaces/${binding.rootKey}/accepted-project`, mountPath: '/workspace', readOnly: false },
      homeMount: { claimName: 'owned-pvc', subPath: `homes/${userId}`, mountPath: '/home/agent', readOnly: false } },
    spec: { containers: [{ name: 'runner', image: pin.imageReference, args: ['literal-first', 'literal-second'],
      securityContext: { runAsUser: 0, allowPrivilegeEscalation: false } }], volumes: [{ name: 'owned', persistentVolumeClaim: { claimName: 'owned-pvc' } }],
      raw: { '10': 'ten', '2': 'two', extension: 'whole\0spec' } } }
  const prepared = stdioPreparedV2.parse({ formatVersion: 2, actionId, executionRef: ref, taskDigest: sha('task', task), scopeBinding: scope,
    expectedDeploymentPin: pin, actualExecutorImage: image, capture: observed.capture, specDigest: sha('spec', observed.spec),
    fullScopeDigest: sha('scope', { scopeBinding: scope, workspaceMount: observed.capture.workspaceMount, homeMount: observed.capture.homeMount }) })
  const permit = { actionId, taskDigest: prepared.taskDigest, preparedDigest: sha('prepared', prepared), approvalEpoch: 1,
    expiresAt: new Date(Date.now() + 60000).toISOString(), issuedAt: new Date(Date.now() - 1000).toISOString(), permitId: randomUUID(),
    authorizationRequestId: randomUUID(), executionRef: ref, executorOwner: { kind: 'cloud', runnerInstanceId }, approvalFingerprint: '1'.repeat(64) }
  const dispatch = stdioDispatchV2(limits).parse({ formatVersion: 2, task, taskDigest: prepared.taskDigest,
    executionRef: ref, preparedDigest: permit.preparedDigest, permit })
  const authorization = { grantOnce: true, permit: clone(permit) }
  const privateReady = { name, podUid, runnerInstanceId, generation: '13', sessionId, userId, binding: clone(binding),
    token: 'synthetic-private-runner-token', restartCount: 0 }
  const facts = { programStartAttempted: true, toolsCallAttempted: phase === 'call', effectMayHaveOccurred: phase === 'call',
    childPid: 42, childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
    protocolBytes: 123, protocolMessages: 4, stderrBytes: 0, stderr: '' }
  const outcome = { state: 'completed', phase, catalog, pages: [{ tools: clone(catalog), extension: 'page\0raw' }],
    initializeResult: { protocolVersion: '2025-11-25', serverInfo: { name: 'synthetic', version: '1' }, capabilities: { tools: {} } }, facts,
    ...(phase === 'call' ? { result: { content: [{ type: 'text', text: 'returned\0😀' }], isError: true,
      structuredContent: { count: 1 }, _meta: { '10': 'ten', '2': 'two' }, extension: { order: [2, 1] } } } : {}) }
  const view = { formatVersion: 2, instanceId: runnerInstanceId, actionId, executionRef: ref,
    taskDigest: dispatch.taskDigest, dispatchDigest: sha('dispatch', dispatch), state: 'completed', writerStopConfirmed: true, outcome }
  const calls = [], captures = [], observations = []
  const client = { query() { throw new Error('Transport may not query or mutate durable rows itself') } }
  const manager = {
    async observeReady(originalSession, originalOwner, originalPod, originalRunner, suppliedClient, mode) {
      assert.deepEqual([originalSession, originalOwner, originalPod, originalRunner], [sessionId, userId, podUid, runnerInstanceId])
      assert.equal(suppliedClient, client); observations.push(mode)
      if (manager.observeHook) await manager.observeHook(mode, observations.length)
      if (manager.observeFailure) throw manager.observeFailure
      return clone(privateReady)
    },
    async captureStdioV2(writer, selectedScope, selectedPin, selectedLimits, suppliedClient, mode) {
      assert.equal(suppliedClient, client); assert.deepEqual(selectedScope, task.scopeBinding); assert.deepEqual(selectedPin, task.expectedDeploymentPin)
      assert.deepEqual(selectedLimits, limits); assert.deepEqual(writer, privateReady); captures.push(mode)
      if (manager.captureHook) await manager.captureHook(mode, captures.length)
      return clone(observed)
    },
    async runnerBounded(originalName, token, method, path, body, bounds) {
      assert.equal(originalName, name); assert.equal(token, privateReady.token)
      assert.deepEqual(bounds, { timeoutMs: selectedOptions.requestTimeoutMs, maxResponseBytes: selectedOptions.maxReplyBytes })
      calls.push({ method, path, body: clone(body), bounds: clone(bounds) })
      if (manager.httpHook) return manager.httpHook(method, path, body)
      return clone(view)
    },
    ensureReady() { throw new Error('No provisioning') }, runner() { throw new Error('Only explicit bounded transport is allowed') },
  }
  const transport = new StdioCloudRunTransportV2(manager, selectedOptions)
  const start = () => transport.start(client, dispatch, authorization, prepared)
  return { transport, start, manager, client, task, ref, dispatch, authorization, prepared, privateReady, observed, view, calls, captures, observations }
}

function anotherOriginal(f, expiresInMs = 60000) {
  const task = clone(f.task), executionRef = { kind: 'cloud', executionId: randomUUID() }
  task.actionId = randomUUID(); task.connectionId = randomUUID()
  const prepared = { ...clone(f.prepared), actionId: task.actionId, executionRef, taskDigest: sha('task', task) }
  const permit = { ...clone(f.dispatch.permit), actionId: task.actionId, executionRef,
    taskDigest: prepared.taskDigest, preparedDigest: sha('prepared', prepared), permitId: randomUUID(), authorizationRequestId: randomUUID(),
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + expiresInMs).toISOString() }
  const dispatch = stdioDispatchV2(limits).parse({ formatVersion: 2, task, taskDigest: prepared.taskDigest,
    executionRef, preparedDigest: permit.preparedDigest, permit })
  return { dispatch, authorization: { grantOnce: true, permit: clone(permit) }, prepared }
}

function replyFor(f, original) {
  return { ...clone(f.view), actionId: original.dispatch.task.actionId, executionRef: clone(original.dispatch.executionRef),
    taskDigest: original.dispatch.taskDigest, dispatchDigest: sha('dispatch', original.dispatch) }
}

function detachedFixture() {
  const f = fixture(), context = new AsyncLocalStorage(), events = []
  let transaction = 0, invocation = 0
  const capture = async (mode, operation) => {
    const current = context.getStore(); assert(current, 'Capture must belong to an original detached invocation')
    const id = ++transaction; current.inTransaction = true; events.push({ invocation: current.id, event: 'begin', mode, id })
    try {
      if (f.beforeTransaction) await f.beforeTransaction(mode, id)
      const writer = await operation(f.client)
      if (f.beforeCommit) await f.beforeCommit(mode, id)
      events.push({ invocation: current.id, event: 'commit', mode, id })
      return writer
    } finally {
      current.inTransaction = false; events.push({ invocation: current.id, event: 'release', mode, id })
    }
  }
  for (const name of ['observeReady', 'captureStdioV2']) {
    const original = f.manager[name]
    f.manager[name] = (...args) => {
      assert.equal(context.getStore()?.inTransaction, true, 'Complete private capture runs inside its short transaction')
      return original(...args)
    }
  }
  const originalHttp = f.manager.runnerBounded
  f.manager.runnerBounded = (...args) => {
    const current = context.getStore(); assert(current)
    assert.equal(current.inTransaction, false, 'Runner execution HTTP must follow transaction commit and release')
    events.push({ invocation: current.id, event: 'http', method: args[2] })
    return originalHttp(...args)
  }
  const invoke = operation => context.run({ id: ++invocation, inTransaction: false }, operation)
  const start = () => invoke(() => f.transport.startDetached(f.dispatch, f.authorization, f.prepared, capture))
  const observe = () => invoke(() => f.transport.observeDetached(f.dispatch, f.prepared, capture))
  const cancel = () => invoke(() => f.transport.cancelDetached(f.dispatch, f.prepared, capture))
  return Object.assign(f, { capture, invoke, start, observe, cancel, events })
}

test('first true start uses explicit bounded POST between dispatch/observe captures and preserves complete outcome/quiet evidence', async () => {
  const f = fixture(), result = await f.start()
  assert.deepEqual(f.observations, ['dispatch', 'observe']); assert.deepEqual(f.captures, ['dispatch', 'observe'])
  assert.deepEqual(f.calls, [{ method: 'POST', path: '/stdio/v2/executions', body: { dispatch: f.dispatch, authorization: f.authorization },
    bounds: { timeoutMs: options.requestTimeoutMs, maxResponseBytes: options.maxReplyBytes } }])
  assert.deepEqual(result.view, stdioRuntimeViewV2(limits, options.maxReplyBytes).parse(f.view))
  assert.deepEqual(stdioCloudStopEvidenceV2.parse(result.stopEvidence), { formatVersion: 2, kind: 'cloud_uid_quiet',
    actionId: f.task.actionId, executionRef: f.ref, taskDigest: f.dispatch.taskDigest, dispatchDigest: sha('dispatch', f.dispatch),
    preparedDigest: f.dispatch.preparedDigest, fullScopeDigest: f.prepared.fullScopeDigest, podUid: f.prepared.capture.podUid,
    runnerInstanceId: f.prepared.capture.runnerInstanceId, mountGeneration: f.prepared.capture.mountGeneration, observedAt: result.stopEvidence.observedAt })
  assert.equal(result.view.outcome.result.content[0].text, 'returned\0😀'); assert.equal(result.view.outcome.result.isError, true)
  assert.equal(result.view.outcome.catalog[0]._meta.complete, '保留\0😀'); assert(!JSON.stringify(result).includes(f.privateReady.token))
  result.view.outcome.result.extension.order.reverse(); assert.deepEqual(f.view.outcome.result.extension.order, [2, 1])
})

test('original false/expired and repeated true replies only query; observe/cancel use observe capture and no new start grant', async () => {
  const f = fixture('discover'); f.dispatch.permit.issuedAt = '2020-01-01T00:00:00.000Z'; f.dispatch.permit.expiresAt = '2020-01-02T00:00:00.000Z'
  f.authorization = { grantOnce: false, permit: clone(f.dispatch.permit) }; f.view.dispatchDigest = sha('dispatch', f.dispatch)
  await f.transport.start(f.client, f.dispatch, f.authorization, f.prepared)
  await f.transport.start(f.client, f.dispatch, { ...f.authorization, grantOnce: true }, f.prepared)
  await f.transport.observe(f.client, f.dispatch, f.prepared); await f.transport.cancel(f.client, f.dispatch, f.prepared)
  const path = `/stdio/v2/executions/${f.ref.executionId}`
  assert.deepEqual(f.calls.map(({ method, path: target, body }) => [method, target, body]),
    [['GET', path, undefined], ['GET', path, undefined], ['GET', path, undefined], ['POST', `${path}/cancel`, undefined]])
  assert(f.captures.every(mode => mode === 'observe')); assert(f.observations.every(mode => mode === 'observe'))
})

test('reservation before the first await prevents concurrent duplicate true starts, even when query has no result yet', async () => {
  const f = fixture(), entered = deferred(), release = deferred()
  f.manager.observeHook = async (mode, count) => { if (count === 1) { entered.resolve(); await release.promise } }
  f.manager.httpHook = async method => { if (method === 'GET') throw new KubernetesError(404, 'synthetic absent'); return clone(f.view) }
  const first = f.start(); await entered.promise
  assert.equal(await f.start(), null); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  release.resolve(); assert.equal((await first).view.state, 'completed')
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
})

test('lost first POST response retains reservation, performs after capture, redacts error and permits only an original GET retry', async () => {
  const f = fixture(); f.manager.httpHook = async method => {
    if (method === 'POST') throw new Error(`lost ${f.privateReady.token}`)
    return clone(f.view)
  }
  await assert.rejects(f.start(), error => unavailable(error) && !error.message.includes(f.privateReady.token))
  assert.deepEqual(f.captures, ['dispatch', 'observe']); assert.equal(f.calls.length, 1)
  const result = await f.start(); assert.equal(result.view.outcome.facts.effectMayHaveOccurred, true)
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET']); assert.equal(f.captures.length, 4)
})

test('early capture/start validation failures cannot retry a true start; cold false query never rebuilds permission', async () => {
  const f = fixture(); f.manager.observeFailure = new Error('synthetic unavailable')
  await assert.rejects(f.start()); delete f.manager.observeFailure
  assert.equal((await f.start()).view.state, 'completed'); assert.deepEqual(f.calls.map(call => call.method), ['GET'])
  const premature = fixture(); premature.dispatch.permit.issuedAt = new Date(Date.now() + 10000).toISOString()
  premature.authorization.permit = clone(premature.dispatch.permit); premature.view.dispatchDigest = sha('dispatch', premature.dispatch)
  await assert.rejects(premature.start(), refused('stdio_v2_cloud_start_denied')); assert.equal(premature.observations.length, 0)
  await premature.start(); assert.deepEqual(premature.calls.map(call => call.method), ['GET'])
  const cold = fixture(); await cold.transport.start(cold.client, cold.dispatch, { grantOnce: false, permit: cold.dispatch.permit }, cold.prepared)
  assert.deepEqual(cold.calls.map(call => call.method), ['GET'])
})

test('original full task/permit/Prepared budget and digests reject before private observation or HTTP', async t => {
  for (const [name, alter] of [
    ['task revision', f => { f.dispatch.task.configRevision++ }],
    ['raw argv', f => { f.dispatch.task.invocation.argv.push('changed') }],
    ['ordered catalog', f => { f.dispatch.task.selection.rawCatalog.reverse() }],
    ['permit changed', f => { f.authorization.permit.authorizationRequestId = randomUUID() }],
    ['prepared digest', f => { f.prepared.specDigest = '2'.repeat(64) }],
    ['scope changed', f => { f.prepared.scopeBinding.target.rootRelativePath = 'foreign' }],
    ['executor owner', f => { f.dispatch.permit.executorOwner.runnerInstanceId = randomUUID(); f.authorization.permit = clone(f.dispatch.permit) }],
    ['unknown wrapper field', f => { f.dispatch.extension = true }],
    ['whole input over budget', f => { f.dispatch.task.selection.arguments.extra = 'x'.repeat(limits.maxInputBytes) }],
  ]) await t.test(name, async () => {
    const f = fixture(); alter(f); await assert.rejects(f.start(), changed)
    assert.equal(f.observations.length, 0); assert.equal(f.calls.length, 0)
  })
  const whole = fixture()
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ dispatch: whole.dispatch, authorization: whole.authorization, prepared: whole.prepared }))
  whole.dispatch.task.selection.arguments.extra = 'x'.repeat(limits.maxInputBytes - envelopeBytes + 100)
  whole.dispatch.taskDigest = sha('task', whole.dispatch.task); whole.prepared.taskDigest = whole.dispatch.taskDigest
  whole.dispatch.preparedDigest = sha('prepared', whole.prepared); whole.dispatch.permit.taskDigest = whole.dispatch.taskDigest
  whole.dispatch.permit.preparedDigest = whole.dispatch.preparedDigest; whole.authorization.permit = clone(whole.dispatch.permit)
  assert.deepEqual(parseStdioStartV2({ dispatch: whole.dispatch, authorization: whole.authorization }, limits).dispatch, whole.dispatch)
  assert(Buffer.byteLength(JSON.stringify({ dispatch: whole.dispatch, authorization: whole.authorization, prepared: whole.prepared })) > limits.maxInputBytes)
  await assert.rejects(whole.start(), changed); assert.equal(whole.observations.length, 0)
})

test('same action changed full dispatch or same execution different action is a conflict without new HTTP', async () => {
  const f = fixture(); await f.start(); const before = f.calls.length
  f.dispatch.permit.authorizationRequestId = randomUUID(); f.authorization.permit = clone(f.dispatch.permit)
  await assert.rejects(f.start(), changed); assert.equal(f.calls.length, before)
  const other = fixture(); other.dispatch.executionRef = clone(f.ref); other.prepared.executionRef = clone(f.ref)
  other.dispatch.preparedDigest = sha('prepared', other.prepared); other.dispatch.permit.executionRef = clone(f.ref)
  other.dispatch.permit.preparedDigest = other.dispatch.preparedDigest; other.authorization.permit = clone(other.dispatch.permit)
  await assert.rejects(f.transport.start(f.client, other.dispatch, other.authorization, other.prepared), changed)
  assert.equal(f.calls.length, before)
})

test('actual image, full raw spec, Runner identity and mounts drift reject both before and after HTTP', async t => {
  for (const [name, alter] of [
    ['image even another pinned runtime', f => { f.observed.actualExecutorImage.runtimeImageId = f.task.expectedDeploymentPin.runtimeImageIds[1] }],
    ['raw security field', f => { f.observed.spec.containers[0].securityContext.runAsUser = 1000 }],
    ['raw argv order', f => { f.observed.spec.containers[0].args.reverse() }],
    ['unprojected extension', f => { f.observed.spec.raw.extension = 'changed\0field' }],
    ['Pod', f => { f.observed.capture.podUid = randomUUID() }],
    ['Runner', f => { f.observed.capture.runnerInstanceId = randomUUID() }],
    ['container', f => { f.observed.capture.containerId = `containerd://${'0'.repeat(64)}` }],
    ['restart', f => { f.observed.capture.restartCount++ }],
    ['mount generation', f => { f.observed.capture.mountGeneration = '14' }],
    ['workspace mount', f => { f.observed.capture.workspaceMount.subPath += '-changed' }],
    ['Home claim', f => { f.observed.capture.homeMount.claimName = 'foreign-pvc' }],
  ]) await t.test(name, async () => {
    const before = fixture(); alter(before); await assert.rejects(before.start(), changed); assert.equal(before.calls.length, 0)
    const after = fixture(); after.manager.httpHook = () => { alter(after); return clone(after.view) }
    await assert.rejects(after.start(), changed); assert.equal(after.calls.length, 1)
    assert.deepEqual(after.captures, ['dispatch', 'observe'])
  })
})

test('original Ready identity/binding mismatch rejects before capture; old Ready restart sentinel does not override actual capture', async t => {
  for (const [name, alter] of [
    ['Pod name', f => { f.privateReady.name = 'different' }],
    ['Pod ID', f => { f.privateReady.podUid = randomUUID() }],
    ['Runner', f => { f.privateReady.runnerInstanceId = randomUUID() }],
    ['Session', f => { f.privateReady.sessionId = randomUUID() }],
    ['owner', f => { f.privateReady.userId = randomUUID() }],
    ['generation', f => { f.privateReady.generation = '14' }],
    ['Workspace', f => { f.privateReady.binding.workspaceId = randomUUID() }],
    ['binding generation', f => { f.privateReady.binding.generation++ }],
    ['storage target', f => { f.privateReady.binding.spaceId = randomUUID() }],
    ['relative storage path', f => { f.privateReady.binding.rootRelativePath = 'foreign' }],
  ]) await t.test(name, async () => {
    const f = fixture(); alter(f); await assert.rejects(f.start(), changed); assert.equal(f.captures.length, 0); assert.equal(f.calls.length, 0)
  })
  const f = fixture(); assert.equal(f.privateReady.restartCount, 0); assert.equal(f.prepared.capture.restartCount, 2)
  assert.equal((await f.start()).stopEvidence.podUid, f.prepared.capture.podUid)
})

test('original input snapshot survives caller mutations while private observation is pending', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), original = clone(f.dispatch), prepared = clone(f.prepared)
  f.manager.observeHook = async (_mode, count) => { if (count === 1) { entered.resolve(); await release.promise } }
  const work = f.start(); await entered.promise
  f.dispatch.task.selection.arguments.text = 'caller changed'; f.authorization.permit.approvalFingerprint = '2'.repeat(64)
  f.prepared.capture.workspaceMount.subPath = 'caller changed'; release.resolve()
  assert.equal((await work).stopEvidence.preparedDigest, sha('prepared', prepared)); assert.deepEqual(f.calls[0].body.dispatch, original)
})

test('GET 404 is null only after same writer capture; POST/cancel 404 and message-shaped status reject without invented quiet', async () => {
  const f = fixture(); f.manager.httpHook = () => { throw new KubernetesError(404, 'synthetic absent') }
  assert.equal(await f.transport.observe(f.client, f.dispatch, f.prepared), null); assert.deepEqual(f.captures, ['observe', 'observe'])
  await assert.rejects(f.transport.cancel(f.client, f.dispatch, f.prepared), unavailable)
  const fresh = fixture(); fresh.manager.httpHook = f.manager.httpHook; await assert.rejects(fresh.start(), unavailable)
  const fake = fixture(); fake.manager.httpHook = () => { throw { status: 404, message: 'not typed Kubernetes response' } }
  await assert.rejects(fake.transport.observe(fake.client, fake.dispatch, fake.prepared), unavailable)
  const changedAfter = fixture(); changedAfter.manager.httpHook = () => {
    changedAfter.observed.capture.containerId += '-changed'; throw new KubernetesError(404, 'synthetic absent')
  }
  await assert.rejects(changedAfter.transport.observe(changedAfter.client, changedAfter.dispatch, changedAfter.prepared), changed)
})

test('terminal UID quiet proof requires exact response identity and phase, not direct-child cleanup or HTTP success', async t => {
  for (const [name, alter] of [
    ['instance', f => { f.view.instanceId = randomUUID() }], ['action', f => { f.view.actionId = randomUUID() }],
    ['execution', f => { f.view.executionRef.executionId = randomUUID() }], ['task digest', f => { f.view.taskDigest = '2'.repeat(64) }],
    ['dispatch digest', f => { f.view.dispatchDigest = '2'.repeat(64) }],
    ['phase', f => { f.view.outcome.phase = 'discover'; delete f.view.outcome.result }],
    ['completed call catalog', f => { f.view.outcome.catalog[0]._meta.complete = 'changed original directory' }],
  ]) await t.test(name, async () => { const f = fixture(); alter(f); await assert.rejects(f.start(), changed) })
  const unknown = fixture(); unknown.view.state = 'unknown'; unknown.view.writerStopConfirmed = false; unknown.view.errorCode = 'stdio_v2_uid_cleanup_unconfirmed'
  const result = await unknown.start(); assert.equal(result.view.outcome.facts.cleanupConfirmed, true)
  assert.equal(result.view.outcome.facts.effectMayHaveOccurred, true); assert.equal(result.stopEvidence, null)
  const running = fixture(); running.view.state = 'running'; running.view.writerStopConfirmed = false; delete running.view.outcome
  assert.equal((await running.transport.cancel(running.client, running.dispatch, running.prepared)).stopEvidence, null)
  for (const state of ['failed', 'cancelled']) {
    const terminal = fixture(); terminal.view.state = state
    terminal.view.outcome = { state: 'failed', errorCode: 'stdio_v2_call_interrupted', facts: clone(terminal.view.outcome.facts) }
    terminal.view.errorCode = 'stdio_v2_call_interrupted'
    const stopped = await terminal.transport.cancel(terminal.client, terminal.dispatch, terminal.prepared)
    assert.equal(stopped.stopEvidence.executionRef.executionId, terminal.ref.executionId)
    assert.equal(stopped.view.outcome.facts.effectMayHaveOccurred, true)
  }
})

test('whole reply byte/depth/node budgets and strict state reject without truncation or partial success', async t => {
  for (const [name, alter] of [
    ['whole bytes', f => { f.view.outcome.initializeResult.extension = 'x'.repeat(options.maxReplyBytes) }],
    ['result bytes', f => { f.view.outcome.result.extension = 'x'.repeat(limits.maxResultBytes) }],
    ['depth', f => { let nested = {}; for (let n = 0; n < limits.maxJsonDepth; n++) nested = { nested }; f.view.outcome.initializeResult.extension = nested }],
    ['node count', f => { f.view.outcome.initializeResult.extension = Array(limits.maxJsonNodes).fill(0) }],
    ['unknown response field', f => { f.view.token = 'synthetic-unexpected' }],
    ['terminal without UID stop', f => { f.view.writerStopConfirmed = false }],
    ['missing terminal outcome', f => { delete f.view.outcome }],
  ]) await t.test(name, async () => { const f = fixture(); alter(f); await assert.rejects(f.start(), invalidReply); assert.equal(f.calls.length, 1) })
})

test('revocation during HTTP still performs observe capture and retains exact original terminal evidence', async () => {
  const f = fixture(); let revoked = false
  f.manager.observeHook = mode => { if (revoked) assert.equal(mode, 'observe') }
  f.manager.captureHook = mode => { if (revoked) assert.equal(mode, 'observe') }
  f.manager.httpHook = () => { revoked = true; return clone(f.view) }
  assert.equal((await f.start()).stopEvidence.runnerInstanceId, f.prepared.capture.runnerInstanceId)
  await f.transport.observe(f.client, f.dispatch, f.prepared)
  assert.deepEqual(f.captures, ['dispatch', 'observe', 'observe', 'observe'])
})

test('options require explicit safe transport limits rather than fixed runner defaults', () => {
  const manager = fixture().manager
  for (const bad of [{ ...options, maxReplyBytes: 0 }, { ...options, maxReplyBytes: NaN },
    { ...options, requestTimeoutMs: 0 }, { ...options, requestTimeoutMs: 2_147_483_648 },
    { ...options, maxTrackedActions: undefined }, { ...options, maxTrackedActions: 0 }, { ...options, maxTrackedActions: 1.5 },
    { ...options, maxTrackedActions: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => new StdioCloudRunTransportV2(manager, bad), /stdio_v2_cloud_transport_options_invalid/u)
  }
})

test('capacity rejects untracked true without HTTP but tracked query/cancel and full-budget unknown cleanup remain available', async t => {
  let now = Date.parse('2026-10-08T00:00:00.000Z'); t.mock.method(Date, 'now', () => now)
  const f = fixture('call', { ...options, maxTrackedActions: 1 }); await f.start()
  const unknown = anotherOriginal(f, 90000), third = anotherOriginal(f, 100000)
  const before = f.calls.length
  await assert.rejects(f.transport.start(f.client, unknown.dispatch, unknown.authorization, unknown.prepared), trackingFull)
  assert.equal(f.calls.length, before)
  f.manager.httpHook = (_method, path) => path.includes(unknown.dispatch.executionRef.executionId) ? replyFor(f, unknown) : clone(f.view)
  await f.transport.cancel(f.client, unknown.dispatch, unknown.prepared)
  await f.transport.observe(f.client, unknown.dispatch, unknown.prepared)
  await f.transport.start(f.client, unknown.dispatch, { ...unknown.authorization, grantOnce: false }, unknown.prepared)
  assert.deepEqual(f.calls.slice(before).map(call => call.method), ['POST', 'GET', 'GET'])
  await assert.rejects(f.transport.start(f.client, unknown.dispatch, unknown.authorization, unknown.prepared), trackingFull)
  await f.start(); await f.transport.cancel(f.client, f.dispatch, f.prepared)
  assert.deepEqual(f.calls.slice(-2).map(call => call.method), ['GET', 'POST'])
  now += 61000
  await assert.rejects(f.transport.start(f.client, third.dispatch, third.authorization, third.prepared), trackingFull)
  assert.equal(f.transport.actions.size, 0); assert.equal(f.transport.executions.size, 0)
  now += 40000
  f.manager.httpHook = (_method, path) => path.includes(unknown.dispatch.executionRef.executionId) ? replyFor(f, unknown) : replyFor(f, third)
  await f.transport.start(f.client, unknown.dispatch, unknown.authorization, unknown.prepared)
  assert.equal(f.calls.at(-1).method, 'GET')
  const fresh = anotherOriginal(f); f.manager.httpHook = () => replyFor(f, fresh)
  await f.transport.start(f.client, fresh.dispatch, fresh.authorization, fresh.prepared)
  assert.equal(f.calls.at(-1).method, 'POST'); assert.equal(f.transport.actions.size, 1); assert.equal(f.transport.executions.size, 1)
})

test('a full-budget unknown false/cancel fences its stale true even after the tracked permit expires; clock rollback never revives old starts', async t => {
  let now = Date.parse('2026-10-08T01:00:00.000Z'); t.mock.method(Date, 'now', () => now)
  const f = fixture('call', { ...options, maxTrackedActions: 1 }); await f.start()
  const unknown = anotherOriginal(f, 90000)
  f.manager.httpHook = () => replyFor(f, unknown)
  await f.transport.start(f.client, unknown.dispatch, { ...unknown.authorization, grantOnce: false }, unknown.prepared)
  assert.equal(f.calls.at(-1).method, 'GET'); assert.equal(f.transport.actions.size, 1)
  now += 61000
  await assert.rejects(f.transport.start(f.client, unknown.dispatch, unknown.authorization, unknown.prepared), trackingFull)
  assert.equal(f.transport.actions.size, 0)
  now += 30000
  await f.transport.start(f.client, unknown.dispatch, unknown.authorization, unknown.prepared)
  assert.equal(f.calls.at(-1).method, 'GET'); assert.equal(f.transport.actions.size, 0)
  now -= 90000
  await f.transport.start(f.client, unknown.dispatch, unknown.authorization, unknown.prepared)
  assert.equal(f.calls.at(-1).method, 'GET'); assert.equal(f.transport.actions.size, 0)
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path === '/stdio/v2/executions').length, 1)
})

test('expired historical queries do not grow either index and expiry frees a slot without replaying a lost original POST', async t => {
  let now = Date.parse('2026-10-08T02:00:00.000Z'); t.mock.method(Date, 'now', () => now)
  const f = fixture('call', { ...options, maxTrackedActions: 1 })
  f.manager.httpHook = method => { if (method === 'POST') throw new Error('synthetic lost original reply'); return clone(f.view) }
  await assert.rejects(f.start(), unavailable)
  for (let n = 0; n < 20; n++) {
    const historical = anotherOriginal(f, -100)
    f.manager.httpHook = () => replyFor(f, historical)
    await f.transport.start(f.client, historical.dispatch, historical.authorization, historical.prepared)
    assert.equal(f.calls.at(-1).method, 'GET'); assert.equal(f.transport.actions.size, 1); assert.equal(f.transport.executions.size, 1)
  }
  f.manager.httpHook = () => clone(f.view); await f.start(); assert.equal(f.calls.at(-1).method, 'GET')
  now += 60001
  await f.start(); assert.equal(f.calls.at(-1).method, 'GET'); assert.equal(f.transport.actions.size, 0); assert.equal(f.transport.executions.size, 0)
  const fresh = anotherOriginal(f); f.manager.httpHook = () => replyFor(f, fresh)
  await f.transport.start(f.client, fresh.dispatch, fresh.authorization, fresh.prepared)
  assert.equal(f.calls.at(-1).method, 'POST'); assert.equal(f.transport.actions.size, 1); assert.equal(f.transport.executions.size, 1)
})

test('a reserved start still waiting for capture cannot POST after another call observes its expiry and the wall clock rolls back', async t => {
  let now = Date.parse('2026-10-08T03:00:00.000Z'); t.mock.method(Date, 'now', () => now)
  const f = fixture(), entered = deferred(), release = deferred()
  f.manager.observeHook = async (_mode, count) => { if (count === 1) { entered.resolve(); await release.promise } }
  f.manager.httpHook = () => { throw new KubernetesError(404, 'synthetic absent') }
  const original = f.start(); await entered.promise
  now += 60001
  assert.equal(await f.start(), null); assert.equal(f.transport.actions.size, 0)
  now -= 60000; release.resolve()
  assert.equal(await original, null); assert.deepEqual(f.calls.map(call => call.method), ['GET', 'GET'])
  assert(f.calls.every(call => call.body === undefined))
})

test('detached start/query/cancel bracket every Runner HTTP with committed/released capture transactions and retain full stop evidence', async () => {
  const f = detachedFixture(), result = await f.start()
  assert.deepEqual(f.events.map(event => event.event), ['begin', 'commit', 'release', 'http', 'begin', 'commit', 'release'])
  assert.deepEqual(f.events.filter(event => event.event === 'begin').map(event => event.mode), ['dispatch', 'observe'])
  assert.deepEqual(result.view, f.view); assert.equal(result.stopEvidence.preparedDigest, f.dispatch.preparedDigest)
  assert.equal(result.stopEvidence.fullScopeDigest, f.prepared.fullScopeDigest)
  await f.observe(); await f.cancel(); await f.start()
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET', 'POST', 'GET'])
  assert(f.events.filter(event => event.event === 'begin' && event.invocation > 1).every(event => event.mode === 'observe'))
  assert.equal(f.events.filter(event => event.event === 'commit').length, 8)
  assert.equal(f.events.filter(event => event.event === 'release').length, 8)
})

test('detached before-capture or commit failure preserves reservation; retry observes without another start POST', async t => {
  for (const position of ['beforeTransaction', 'beforeCommit']) await t.test(position, async () => {
    const f = detachedFixture(), failure = new Error('synthetic capture transaction failed')
    f[position] = (_mode, id) => { if (id === 1) throw failure }
    await assert.rejects(f.start(), error => error === failure); assert.equal(f.calls.length, 0)
    assert.equal(f.events.at(-1).event, 'release')
    delete f[position]
    assert.equal((await f.start()).view.state, 'completed'); assert.deepEqual(f.calls.map(call => call.method), ['GET'])
  })
})

test('detached after-capture lease/commit failure never returns cached quiet proof or re-POSTs the accepted action', async () => {
  const f = detachedFixture(), failure = new Error('synthetic original lease changed after HTTP')
  f.beforeCommit = (_mode, id) => { if (id === 2) throw failure }
  await assert.rejects(f.start(), error => error === failure)
  assert.deepEqual(f.calls.map(call => call.method), ['POST']); assert.equal(f.events.at(-1).event, 'release')
  delete f.beforeCommit
  const observed = await f.start(); assert.equal(observed.stopEvidence.runnerInstanceId, f.prepared.capture.runnerInstanceId)
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET'])
})

test('detached lost POST response still closes both capture transactions; retry is only GET and preserves original effect facts', async () => {
  const f = detachedFixture()
  f.manager.httpHook = method => { if (method === 'POST') throw new Error('synthetic lost reply'); return clone(f.view) }
  await assert.rejects(f.start(), unavailable)
  assert.deepEqual(f.events.map(event => event.event), ['begin', 'commit', 'release', 'http', 'begin', 'commit', 'release'])
  assert.equal((await f.start()).view.outcome.facts.effectMayHaveOccurred, true)
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET'])
})

test('detached concurrent duplicate reserves before capture and runs each HTTP outside its own transaction', async () => {
  const f = detachedFixture(), entered = deferred(), release = deferred()
  f.beforeTransaction = async (_mode, id) => { if (id === 1) { entered.resolve(); await release.promise } }
  f.manager.httpHook = method => { if (method === 'GET') throw new KubernetesError(404, 'synthetic no result yet'); return clone(f.view) }
  const original = f.start(); await entered.promise
  assert.equal(await f.start(), null); assert.deepEqual(f.calls.map(call => call.method), ['GET'])
  release.resolve(); assert.equal((await original).stopEvidence.executionRef.executionId, f.ref.executionId)
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST'])
})

test('legacy caller-client and detached methods share exactly the same reservation and full-capture checks', async () => {
  const f = fixture(); await f.start()
  let inTransaction = false
  const capture = async (_mode, operation) => {
    inTransaction = true
    try { return await operation(f.client) } finally { inTransaction = false }
  }
  f.manager.httpHook = () => { assert.equal(inTransaction, false); return clone(f.view) }
  await f.transport.startDetached(f.dispatch, f.authorization, f.prepared, capture)
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET'])
  f.observed.spec.raw.extension = 'actual complete spec drift'
  await assert.rejects(f.transport.observeDetached(f.dispatch, f.prepared, capture), changed)
  assert.equal(f.calls.length, 2)
})
