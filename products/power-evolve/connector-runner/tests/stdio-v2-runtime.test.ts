/** Pure runtime lifecycle fixtures; no user process, UID cleanup, Docker, database or application runs. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { stdioDispatchV2, stdioExecutorOwnerV2, stdioStartAuthorizationV2, stdioTaskSchemasV2,
  type StdioDispatchV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '../src/stdio-v2-digest.ts'
import { parseStdioStartV2, type runStdioDispatchV2 } from '../src/stdio-v2-dispatch.ts'
import { StdioCloudRuntimeV2, StdioRuntimeErrorV2, type StdioCloudRuntimeOptionsV2 } from '../src/stdio-v2-runtime.ts'
import type { StdioV2Object, StdioV2Outcome, StdioV2Tool } from '../src/stdio-v2.ts'

const limits: StdioLimitsV2 = { runtimeMs: 3000, requestMs: 700, stdinGraceMs: 30, terminateGraceMs: 100,
  killGraceMs: 500, maxInputBytes: 65536, maxMessageBytes: 32768, maxProtocolBytes: 262144,
  maxProtocolMessages: 100, maxJsonDepth: 64, maxJsonNodes: 10000, maxPages: 8, maxTools: 32,
  maxCatalogBytes: 65536, maxToolBytes: 16384, maxResultBytes: 32768, maxStderrBytes: 4096 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const tools: StdioV2Tool[] = [{ name: 'read_note', inputSchema: { type: 'object' }, _meta: { literal: 'raw\0😀' } },
  { name: 'write_note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, extension: [3, 1] }]
const owner = () => stdioExecutorOwnerV2.options[0].parse({ kind: 'cloud', runnerInstanceId: randomUUID() })
const error = (code: string) => (value: unknown) => value instanceof StdioRuntimeErrorV2 && value.code === code
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function packet(executorOwner = owner(), phase: 'discover' | 'call' = 'call') {
  const userId = randomUUID(), actionId = randomUUID(), platform = { os: 'linux', architecture: 'arm64' }
  const runtimeImageId = 'containerd://synthetic-image', imageReference = `registry.example/runner@sha256:${'a'.repeat(64)}`
  const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, phase, actionId, userId, sessionId: randomUUID(),
    connectionId: randomUUID(), configRevision: 1, configDigest: 'c'.repeat(64),
    scopeBinding: { kind: 'cloud', userId, workspaceId: randomUUID(), bindingGeneration: 1,
      target: { spaceId: randomUUID(), rootRelativePath: 'synthetic-project' }, home: { kind: 'user', userId } },
    expectedDeploymentPin: { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform,
      configImageId: `sha256:${'b'.repeat(64)}`, imageReference, runtimeImageIds: [runtimeImageId] },
    invocation: { program: '/synthetic/node', argv: ['server.mjs', 'literal argument'], cwd: 'notes' }, limits,
    ...(phase === 'discover' ? { origin: { kind: 'stdio_discovery', requestId: randomUUID() } }
      : { origin: { kind: 'operation', operationId: randomUUID(), rootOperationId: randomUUID(), callKey: 'synthetic-call' },
        selection: { catalogId: randomUUID(), rawCatalog: structuredClone(tools), catalogDigest: stdioCatalogFingerprintV2(tools, limits),
          catalogImageExpectation: { kind: 'cloud', platform, runtimeImageId, imageReference },
          rawName: 'write_note', rawDescriptor: structuredClone(tools[1]), arguments: { text: 'original\0😀', order: [3, 1] } } }) })
  const taskDigest = stdioSha256V2('task', task, budget), preparedDigest = 'd'.repeat(64)
  const executionRef = { kind: 'cloud', executionId: randomUUID() }, now = Date.now()
  const permit = { actionId, taskDigest, preparedDigest, executionRef, executorOwner, approvalEpoch: 1,
    approvalFingerprint: 'e'.repeat(64), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    permitId: randomUUID(), authorizationRequestId: randomUUID() }
  return parseStdioStartV2({ dispatch: stdioDispatchV2(limits).parse({ formatVersion: 2, task, taskDigest,
    executionRef, preparedDigest, permit }), authorization: stdioStartAuthorizationV2.parse({ grantOnce: true, permit }) }, limits)
}

function completed(phase: 'discover' | 'call' = 'call'): StdioV2Outcome {
  const facts = { programStartAttempted: true, toolsCallAttempted: phase === 'call', effectMayHaveOccurred: true,
    childPid: 123, childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null,
    cleanupConfirmed: true, protocolBytes: 200, protocolMessages: 4, stderrBytes: 0, stderr: '' }
  const common = { catalog: structuredClone(tools), pages: [{ tools: structuredClone(tools), extension: 'full' }],
    initializeResult: { protocolVersion: 'synthetic', _meta: { retained: true } }, facts }
  return phase === 'discover' ? { state: 'completed', phase, ...common }
    : { state: 'completed', phase, ...common, result: { content: [{ type: 'text', text: 'full\0😀' }],
      structuredContent: { order: [3, 1] }, isError: false, extension: { retained: 'original' } } }
}

function fixture(overrides: Partial<StdioCloudRuntimeOptionsV2> = {}, driver?: typeof runStdioDispatchV2) {
  const input = packet(), trace = { drivers: 0, cwd: [] as string[], cleanups: 0 }
  const options: StdioCloudRuntimeOptionsV2 = { limits: structuredClone(limits), maxReplyBytes: 16384,
    environment: { workspaceRoot: '/workspace', env: { HOME: '/home/agent', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      identity: { kind: 'unix', uid: 1000, gid: 1000 } },
    executorOwner: input.dispatch.permit.executorOwner.kind === 'cloud' ? input.dispatch.permit.executorOwner : owner(),
    async authorizeCwd(cwd) { trace.cwd.push(cwd); return true }, async cleanup() { trace.cleanups++; return true }, ...overrides }
  const runtime = new StdioCloudRuntimeV2(options, driver ?? (async () => { trace.drivers++; return completed() }))
  return { input, options, runtime, trace, id: input.dispatch.executionRef.executionId }
}

async function settled(runtime: StdioCloudRuntimeV2, id: string) {
  for (let turn = 0; turn < 30; turn++) {
    const view = runtime.get(id)
    if (view && view.state !== 'running') return view
    await tick()
  }
  assert.fail('synthetic runtime must settle')
}

void test('cloud options require explicit Unix 1000/1000 and canonical absolute roots, budgets and a complete failure reply', () => {
  const f = fixture()
  for (const environment of [{ ...f.options.environment, workspaceRoot: 'relative' },
    { ...f.options.environment, workspaceRoot: '/workspace/../outside' },
    { ...f.options.environment, env: { ...f.options.environment.env, HOME: 'relative' } },
    { ...f.options.environment, identity: { kind: 'current' } },
    { ...f.options.environment, identity: { kind: 'unix', uid: 0, gid: 1000 } },
    { ...f.options.environment, identity: { kind: 'unix', uid: 1000, gid: 0 } }] satisfies Array<typeof f.options.environment>) {
    assert.throws(() => new StdioCloudRuntimeV2({ ...f.options, environment }), error('stdio_v2_runtime_configuration_invalid'))
  }
  for (const maxReplyBytes of [0, 1, -1, 1.5, Number.NaN]) {
    assert.throws(() => new StdioCloudRuntimeV2({ ...f.options, maxReplyBytes }), error('stdio_v2_runtime_configuration_invalid'))
  }
})

void test('start reserves the exact original before awaiting cwd; direct-child close does not publish completion or release writer', async () => {
  const cleanup = deferred<boolean>(), f = fixture({ cleanup: () => cleanup.promise })
  const view = await f.runtime.start(f.input)
  assert.equal(view.state, 'running'); assert.equal(view.writerStopConfirmed, false)
  assert.equal(view.instanceId, f.options.executorOwner.runnerInstanceId); assert.equal(view.taskDigest, f.input.dispatch.taskDigest)
  assert.equal(view.dispatchDigest, stdioSha256V2('dispatch', f.input.dispatch, budget))
  await tick()
  assert.deepEqual(f.trace.cwd, ['notes']); assert.equal(f.trace.drivers, 1)
  assert.equal(f.runtime.busy(), true); assert.equal(f.runtime.get(f.id)?.state, 'running')
  assert.equal(f.runtime.get(f.id)?.outcome, undefined)
  cleanup.resolve(true)
  const result = await settled(f.runtime, f.id)
  assert.equal(result.state, 'completed'); assert.equal(result.writerStopConfirmed, true)
  assert.deepEqual(result.outcome, completed()); assert.equal(f.runtime.busy(), false)
})

void test('concurrent duplicate starts query once; another original execution is busy before the first await', async () => {
  const cwd = deferred<boolean>(), f = fixture({ authorizeCwd: () => cwd.promise })
  const first = f.runtime.start(f.input), same = f.runtime.start(structuredClone(f.input))
  const other = packet(f.options.executorOwner)
  await assert.rejects(f.runtime.start(other), error('stdio_v2_runtime_busy'))
  assert.deepEqual(await same, await first); assert.equal(f.trace.drivers, 0)
  cwd.resolve(true)
  assert.equal((await settled(f.runtime, f.id)).state, 'completed'); assert.equal(f.trace.drivers, 1)
})

void test('lost reply and false or expired query receipts never restart the original, including after close', async (t) => {
  const f = fixture()
  await f.runtime.start(f.input); await settled(f.runtime, f.id)
  const query = structuredClone(f.input); query.authorization.grantOnce = false
  t.mock.method(Date, 'now', () => Date.parse(f.input.dispatch.permit.expiresAt) + 1)
  assert.deepEqual(await f.runtime.start(query), f.runtime.get(f.id))
  assert.deepEqual(await f.runtime.start(f.input), f.runtime.get(f.id))
  assert.equal(await f.runtime.close(), true)
  assert.deepEqual(await f.runtime.start(query), f.runtime.get(f.id)); assert.equal(f.trace.drivers, 1)
})

void test('a matching execution ID with any different complete dispatch conflicts instead of adopting a changed action', async () => {
  const f = fixture(); await f.runtime.start(f.input); await settled(f.runtime, f.id)
  for (const field of ['permitId', 'authorizationRequestId', 'approvalFingerprint'] as const) {
    const changed = structuredClone(f.input), value = field === 'approvalFingerprint' ? 'f'.repeat(64) : randomUUID()
    Reflect.set(changed.dispatch.permit, field, value); Reflect.set(changed.authorization.permit, field, value)
    await assert.rejects(f.runtime.start(changed), error('stdio_v2_dispatch_conflict'))
  }
  const changed = structuredClone(f.input); changed.dispatch.task.configRevision++
  const digest = stdioSha256V2('task', changed.dispatch.task, budget)
  changed.dispatch.taskDigest = digest; changed.dispatch.permit.taskDigest = digest; changed.authorization.permit.taskDigest = digest
  await assert.rejects(f.runtime.start(changed), error('stdio_v2_dispatch_conflict')); assert.equal(f.trace.drivers, 1)
})

void test('fresh false, expired, changed digest and cold-owner inputs create no entry or helper invocation', async (t) => {
  const f = fixture(), query = structuredClone(f.input); query.authorization.grantOnce = false
  await assert.rejects(f.runtime.start(query), error('stdio_v2_start_denied'))
  const changed = structuredClone(f.input); changed.dispatch.task.invocation.argv.push('unapproved')
  await assert.rejects(f.runtime.start(changed), error('stdio_v2_task_digest_mismatch'))
  const cold = fixture({ executorOwner: owner() })
  await assert.rejects(cold.runtime.start(f.input), error('stdio_v2_executor_owner_mismatch'))
  t.mock.method(Date, 'now', () => Date.parse(f.input.dispatch.permit.expiresAt))
  await assert.rejects(f.runtime.start(f.input), error('stdio_v2_start_expired'))
  assert.equal(f.runtime.get(f.id), undefined); assert.equal(f.runtime.busy(), false)
  assert.deepEqual(f.trace, { drivers: 0, cwd: [], cleanups: 0 })
})

void test('cancel before the job or during cwd authorization cannot start user code and still confirms independent cleanup', async () => {
  const early = fixture(), response = early.runtime.start(early.input)
  early.runtime.cancel(early.id); await response
  const first = await settled(early.runtime, early.id)
  assert.equal(first.state, 'cancelled'); assert.equal(first.outcome?.facts.effectMayHaveOccurred, false)
  assert.deepEqual(early.trace, { drivers: 0, cwd: [], cleanups: 1 })
  const cwd = deferred<boolean>(), f = fixture({ authorizeCwd: (_path, signal) => {
    assert.equal(signal.aborted, false); return cwd.promise
  } })
  await f.runtime.start(f.input); await tick(); assert.equal(f.runtime.cancel(f.id)?.state, 'running')
  cwd.resolve(true)
  assert.equal((await settled(f.runtime, f.id)).state, 'cancelled'); assert.equal(f.trace.drivers, 0)
  assert.equal(f.trace.cleanups, 1); assert.equal(f.runtime.cancel('unowned'), undefined)
})

void test('denied or rejected cwd does not run a program; its reservation still requires independent quiet', async () => {
  for (const authorizeCwd of [async () => false, async () => { throw new Error('private helper path') }]) {
    const f = fixture({ authorizeCwd }); await f.runtime.start(f.input)
    const view = await settled(f.runtime, f.id)
    assert.equal(view.state, 'failed'); assert.equal(view.writerStopConfirmed, true)
    assert.equal(view.outcome?.facts.programStartAttempted, false); assert.equal(view.outcome?.facts.effectMayHaveOccurred, false)
    assert.equal(f.trace.drivers, 0); assert.equal(f.trace.cleanups, 1)
    assert.equal(JSON.stringify(view).includes('private helper path'), false)
  }
})

void test('expiry while checking cwd cannot carry a true original reply into a later program start', async (t) => {
  const cwd = deferred<boolean>(), f = fixture({ authorizeCwd: () => cwd.promise })
  await f.runtime.start(f.input); await tick()
  t.mock.method(Date, 'now', () => Date.parse(f.input.dispatch.permit.expiresAt))
  cwd.resolve(true)
  const view = await settled(f.runtime, f.id)
  assert.equal(view.state, 'failed'); assert.equal(view.errorCode, 'stdio_v2_start_expired')
  assert.equal(f.trace.drivers, 0); assert.equal(view.outcome?.facts.effectMayHaveOccurred, false)
})

void test('false or rejected independent cleanup yields unknown and retains busy regardless of direct-child completion', async () => {
  for (const cleanup of [async () => false, async () => { throw new Error('private cleanup detail') }]) {
    const f = fixture({ cleanup }); await f.runtime.start(f.input)
    const view = await settled(f.runtime, f.id)
    assert.equal(view.state, 'unknown'); assert.equal(view.writerStopConfirmed, false); assert.equal(f.runtime.busy(), true)
    assert.equal(view.outcome?.state, 'completed'); assert.equal(view.outcome?.facts.cleanupConfirmed, true)
    assert.equal(view.outcome?.facts.effectMayHaveOccurred, true)
    await assert.rejects(f.runtime.start(packet(f.options.executorOwner)), error('stdio_v2_runtime_busy'))
    const query = structuredClone(f.input); query.authorization.grantOnce = false
    assert.deepEqual(await f.runtime.start(query), view); assert.equal(await f.runtime.close(), false)
    assert.equal(f.trace.drivers, 1); assert.equal(JSON.stringify(view).includes('private cleanup detail'), false)
  }
})

void test('thrown driver or lost result records conservative effects and cleanup, without exposing the thrown message', async () => {
  const f = fixture({}, async () => { throw new Error('private program result') })
  await f.runtime.start(f.input)
  const view = await settled(f.runtime, f.id)
  assert.equal(view.state, 'failed'); assert.equal(view.errorCode, 'stdio_v2_driver_failed')
  assert.equal(view.outcome?.facts.programStartAttempted, true); assert.equal(view.outcome?.facts.effectMayHaveOccurred, true)
  assert.equal(view.outcome?.facts.childCloseObserved, false); assert.equal(view.writerStopConfirmed, true)
  assert.equal(JSON.stringify(view).includes('private program result'), false); assert.equal(f.trace.cleanups, 1)
})

void test('discovery and failed provider facts remain complete, including failure with an observed zero exit', async () => {
  const discover = fixture({}, async dispatch => completed(dispatch.task.phase)), input = packet(discover.options.executorOwner, 'discover')
  await discover.runtime.start(input)
  assert.deepEqual((await settled(discover.runtime, input.dispatch.executionRef.executionId)).outcome, completed('discover'))
  const outcome: StdioV2Outcome = { state: 'failed', errorCode: 'request_timeout', facts: completed().facts,
    result: { content: [{ type: 'text', text: 'partial\0result' }], isError: true } }
  const failure = fixture({}, async () => outcome)
  await failure.runtime.start(failure.input)
  const view = await settled(failure.runtime, failure.id)
  assert.equal(view.state, 'failed'); assert.equal(view.errorCode, 'request_timeout')
  assert.deepEqual(view.outcome, outcome); assert.equal(view.outcome?.facts.exitCode, 0)
  assert.equal(view.writerStopConfirmed, true)
})

void test('whole reply cap includes the wrapper; oversized raw result is failed without truncating success or losing effects', async () => {
  const outcome = completed()
  if (outcome.state !== 'completed' || outcome.phase !== 'call') assert.fail('call required')
  outcome.result.extra = 'x'.repeat(1200)
  const maxReplyBytes = Buffer.byteLength(JSON.stringify(outcome)) + 1
  const f = fixture({ maxReplyBytes }, async () => outcome)
  await f.runtime.start(f.input)
  const view = await settled(f.runtime, f.id)
  assert.equal(view.state, 'failed'); assert.equal(view.errorCode, 'stdio_v2_reply_limit')
  assert.equal(view.outcome?.state, 'failed'); assert.equal(view.outcome?.facts.effectMayHaveOccurred, true)
  assert.equal(view.outcome?.facts.childCloseObserved, true); assert.equal(view.writerStopConfirmed, true)
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= maxReplyBytes)
  assert.equal('result' in (view.outcome ?? {}), false); assert.equal(outcome.result.extra.length, 1200)
})

void test('whole reply depth/nodes and stderr overflow cannot turn an unrepresentable provider result into success', async () => {
  for (const kind of ['stderr', 'depth', 'nodes']) {
    const outcome = completed()
    if (outcome.state !== 'completed' || outcome.phase !== 'call') assert.fail('call required')
    if (kind === 'stderr') { outcome.facts.stderr = 'x'.repeat(20000); outcome.facts.stderrBytes = 20000 }
    else if (kind === 'depth') {
      let nested: StdioV2Object = {}
      for (let depth = 0; depth <= limits.maxJsonDepth; depth++) nested = { next: nested }
      outcome.result.nested = nested
    } else outcome.result.nodes = Array.from({ length: limits.maxJsonNodes }, () => null)
    const maxReplyBytes = kind === 'stderr' ? 2048 : 131072, f = fixture({ maxReplyBytes }, async () => outcome)
    await f.runtime.start(f.input)
    const view = await settled(f.runtime, f.id)
    assert.equal(view.state, 'failed'); assert.equal(view.errorCode, 'stdio_v2_reply_limit')
    assert.equal(view.outcome?.facts.effectMayHaveOccurred, true); assert.equal(view.outcome?.facts.stderrBytes, outcome.facts.stderrBytes)
    assert.equal(view.outcome?.facts.stderr, ''); assert.ok(Buffer.byteLength(JSON.stringify(view)) <= maxReplyBytes)
  }
})

void test('start and query snapshots cannot mutate original input, options, retained results or future admission', async () => {
  const cwd = deferred<boolean>(), seen = deferred<StdioDispatchV2>()
  const f = fixture({ authorizeCwd: () => cwd.promise }, async (dispatch, environment) => {
      assert.equal(environment.env.LANG, 'C.UTF-8'); assert.equal(environment.identity.kind, 'unix')
      seen.resolve(dispatch); return completed()
    }), original = structuredClone(f.input)
  const response = await f.runtime.start(f.input)
  f.input.dispatch.task.invocation.argv.push('after-admission'); f.options.environment.env.LANG = 'mutated'
  response.state = 'completed'; response.writerStopConfirmed = true
  assert.equal(f.runtime.get(f.id)?.state, 'running')
  cwd.resolve(true)
  assert.deepEqual(await seen.promise, original.dispatch)
  const terminal = await settled(f.runtime, f.id)
  if (terminal.outcome) terminal.outcome.facts.effectMayHaveOccurred = false
  assert.equal(f.runtime.get(f.id)?.outcome?.facts.effectMayHaveOccurred, true)
  assert.deepEqual(await f.runtime.start(original), f.runtime.get(f.id))
})

void test('close during cwd wait closes admission, waits cleanup and never starts a user program', async () => {
  const cwd = deferred<boolean>(), cleanup = deferred<boolean>()
  const f = fixture({ authorizeCwd: () => cwd.promise, cleanup: () => cleanup.promise })
  await f.runtime.start(f.input); await tick()
  const close = f.runtime.close(); assert.equal(f.runtime.close(), close)
  await assert.rejects(f.runtime.start(packet(f.options.executorOwner)), error('stdio_v2_runtime_closed'))
  assert.equal(f.runtime.busy(), true); cwd.resolve(true); await tick()
  assert.equal(f.trace.drivers, 0); assert.equal(f.runtime.get(f.id)?.state, 'running')
  cleanup.resolve(true); assert.equal(await close, true)
  assert.equal(f.runtime.get(f.id)?.state, 'cancelled'); assert.equal(f.runtime.busy(), false)
})

void test('close aborts a running SDK job but waits independent cleanup; its false result retains unknown writer facts', async () => {
  const started = deferred<AbortSignal>(), stopped = deferred<StdioV2Outcome>(), cleanup = deferred<boolean>()
  const f = fixture({ cleanup: () => cleanup.promise }, async (_dispatch, _environment, signal) => {
    started.resolve(signal); return stopped.promise
  })
  await f.runtime.start(f.input); const signal = await started.promise
  const close = f.runtime.close(); assert.equal(signal.aborted, true)
  stopped.resolve(completed()); await tick()
  assert.equal(f.runtime.get(f.id)?.state, 'running'); assert.equal(f.runtime.busy(), true)
  cleanup.resolve(false); assert.equal(await close, false)
  assert.equal(f.runtime.get(f.id)?.state, 'unknown'); assert.equal(f.runtime.busy(), true)
  assert.equal(f.runtime.get(f.id)?.outcome?.facts.effectMayHaveOccurred, true)
})

void test('an empty shutdown also requires quiet confirmation, stays closed and cannot claim unknown UID quiescence', async () => {
  const f = fixture({ cleanup: async () => false })
  assert.equal(await f.runtime.close(), false); assert.equal(f.runtime.busy(), true)
  await assert.rejects(f.runtime.start(f.input), error('stdio_v2_runtime_closed'))
  assert.equal(f.runtime.get(f.id), undefined); assert.equal(f.trace.drivers, 0)
})

void test('close installs its tracked promise before a synchronous cleanup callback can reenter', async () => {
  let reentered: Promise<boolean> | undefined, calls = 0
  const f = fixture({ cleanup: async () => { calls++; reentered = runtime.close(); return true } })
  const runtime = f.runtime
  const close = runtime.close()
  assert.equal(await close, true); assert.equal(reentered, close); assert.equal(calls, 1)
})
