/** Actual SDK2 against an owned synthetic MCP peer; packet fixtures grant no Platform or resource authority. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stdioDigestV2, stdioDispatchV2, stdioExecutorOwnerV2, stdioTaskSchemasV2,
  type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { catalog } from './stdio-v2-fixture.mjs'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '../src/stdio-v2-digest.ts'
import { parseStdioStartV2, runStdioDispatchV2, validateStdioStartV2,
  type StdioExecutionEnvironmentV2 } from '../src/stdio-v2-dispatch.ts'
import { readStdioPeerTrace } from './stdio-peer-trace.ts'

const fixture = fileURLToPath(new URL('./stdio-v2-fixture.mjs', import.meta.url))
const limits: StdioLimitsV2 = { runtimeMs: 3000, requestMs: 700, stdinGraceMs: 30, terminateGraceMs: 100,
  killGraceMs: 500, maxInputBytes: 65536, maxMessageBytes: 32768, maxProtocolBytes: 262144,
  maxProtocolMessages: 100, maxJsonDepth: 64, maxJsonNodes: 10000, maxPages: 8, maxTools: 32,
  maxCatalogBytes: 65536, maxToolBytes: 16384, maxResultBytes: 32768, maxStderrBytes: 4096 }
const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
const now = Date.parse('2026-10-07T12:00:00.000Z')
const clone = <T>(value: T): T => structuredClone(value)
const errorCode = (code: string) => (error: unknown) => error instanceof TypeError && error.message === code

function packet(phase: 'discover' | 'call' = 'call') {
  const userId = randomUUID(), actionId = randomUUID(), runtimeImageId = 'containerd://synthetic-original'
  const imageReference = `registry.example/runner@sha256:${'a'.repeat(64)}`, platform = { os: 'linux', architecture: 'arm64' }
  const expectedDeploymentPin = { kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2, platform,
    configImageId: `sha256:${'b'.repeat(64)}`, imageReference, runtimeImageIds: [runtimeImageId] }
  const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, phase, actionId, userId, sessionId: randomUUID(),
    connectionId: randomUUID(), configRevision: 1, configDigest: 'c'.repeat(64),
    scopeBinding: { kind: 'cloud', userId, workspaceId: randomUUID(), bindingGeneration: 1,
      target: { spaceId: randomUUID(), rootRelativePath: 'synthetic-project' }, home: { kind: 'user', userId } }, expectedDeploymentPin,
    invocation: { program: process.execPath, argv: [fixture, 'normal', 'trace.jsonl'], cwd: '.' }, limits,
    ...(phase === 'discover' ? { origin: { kind: 'stdio_discovery', requestId: randomUUID() } }
      : { origin: { kind: 'operation', operationId: randomUUID(), rootOperationId: randomUUID(), callKey: 'synthetic-call' },
        selection: { catalogId: randomUUID(), rawCatalog: clone(catalog), catalogDigest: stdioCatalogFingerprintV2(catalog, limits),
          catalogImageExpectation: { kind: 'cloud', platform, imageReference, runtimeImageId },
          rawName: 'echo', rawDescriptor: clone(catalog[1]), arguments: { text: 'literal\0😀', '10': 'ten', '2': 'two' } } }) })
  const taskDigest = stdioSha256V2('task', task, budget), preparedDigest = 'd'.repeat(64)
  const executionRef = { kind: 'cloud', executionId: randomUUID() }
  const executorOwner = stdioExecutorOwnerV2.parse({ kind: 'cloud', runnerInstanceId: randomUUID() })
  const permit = { actionId, taskDigest, preparedDigest, approvalEpoch: 1, approvalFingerprint: 'e'.repeat(64),
    expiresAt: new Date(now + 10000).toISOString(), issuedAt: new Date(now - 1000).toISOString(), permitId: randomUUID(),
    authorizationRequestId: randomUUID(), executionRef, executorOwner }
  return { dispatch: stdioDispatchV2(limits).parse({ formatVersion: 2, task, taskDigest, executionRef, preparedDigest, permit }),
    authorization: { grantOnce: true, permit: clone(permit) } }
}

function peer(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pe-stdio-dispatch-'))
  t.after(() =>{  rmSync(root, { recursive: true, force: true }) })
  const environment: StdioExecutionEnvironmentV2 = { workspaceRoot: root,
    env: { HOME: root, PATH: dirname(process.execPath), LANG: 'C.UTF-8' }, identity: { kind: 'current' } }
  const trace = (path = root) => readStdioPeerTrace(join(path, 'trace.jsonl'))
  return { root, environment, trace }
}

void test('parse preserves the entire raw JSON and returns independent dispatch/authorization snapshots including false receipts', () => {
  const input = packet(), before = clone(input), result = parseStdioStartV2(input, limits)
  assert.deepEqual(result, before); assert.notEqual(result.dispatch, input.dispatch)
  assert.notEqual(result.authorization.permit, result.dispatch.permit)
  if (input.dispatch.task.phase !== 'call' || result.dispatch.task.phase !== 'call') assert.fail('call required')
  input.dispatch.task.selection.arguments.text = 'after parser mutation'
  const first = input.dispatch.task.selection.rawCatalog[0]; assert.ok(first)
  first._meta = { changed: true }
  input.authorization.permit.approvalFingerprint = 'f'.repeat(64)
  assert.equal(result.dispatch.task.selection.arguments.text, 'literal\0😀')
  assert.deepEqual(result, before)
  const query = packet(); query.authorization.grantOnce = false
  const queried = parseStdioStartV2(query, limits)
  assert.equal(queried.authorization.grantOnce, false)
  assert.throws(() => validateStdioStartV2(query, limits, query.dispatch.permit.executorOwner, now), errorCode('stdio_v2_start_denied'))
})

void test('true replies require the exact Cloud owner and issued <= now < expires', () => {
  const input = packet('call'), owner = input.dispatch.permit.executorOwner
  assert.deepEqual(validateStdioStartV2(input, limits, owner, now), input)
  assert.deepEqual(validateStdioStartV2(input, limits, owner, Date.parse(input.dispatch.permit.issuedAt)), input)
  for (const time of [Date.parse(input.dispatch.permit.issuedAt) - 1, Date.parse(input.dispatch.permit.expiresAt), Number.NaN]) {
    assert.deepEqual(parseStdioStartV2(input, limits), input)
    assert.throws(() => validateStdioStartV2(input, limits, owner, time), errorCode('stdio_v2_start_expired'))
  }
  const foreign = stdioExecutorOwnerV2.parse({ ...owner, runnerInstanceId: randomUUID() })
  assert.throws(() => validateStdioStartV2(input, limits, foreign, now), errorCode('stdio_v2_executor_owner_mismatch'))
})

void test('a syntactically valid receipt must match every complete original permit field', () => {
  for (const field of ['permitId', 'authorizationRequestId', 'approvalFingerprint', 'issuedAt', 'expiresAt']) {
    const input = packet(), value = field.endsWith('At') ? new Date(now + (field === 'issuedAt' ? 1 : 20000)).toISOString()
      : field === 'approvalFingerprint' ? 'f'.repeat(64) : randomUUID()
    Reflect.set(input.authorization.permit, field, value)
    assert.throws(() => parseStdioStartV2(input, limits), errorCode('stdio_v2_start_permit_mismatch'))
  }
  const input = packet(); input.authorization.permit.executorOwner = stdioExecutorOwnerV2.parse({ kind: 'cloud', runnerInstanceId: randomUUID() })
  assert.throws(() => parseStdioStartV2(input, limits), errorCode('stdio_v2_start_permit_mismatch'))
  const extra = packet(); Reflect.set(extra.authorization.permit, 'extra', true)
  assert.throws(() => parseStdioStartV2(extra, limits))
})

void test('whole task/raw metadata/arguments and ordered complete catalog hashes are rechecked, never rebuilt', () => {
  const changed = packet()
  if (changed.dispatch.task.phase !== 'call') assert.fail('call required')
  changed.dispatch.task.selection.arguments.text = 'changed\0argument'
  assert.throws(() => parseStdioStartV2(changed, limits), errorCode('stdio_v2_task_digest_mismatch'))
  for (const change of ['metadata', 'order', 'digest']) {
    const input = packet(), task = input.dispatch.task
    if (task.phase !== 'call') assert.fail('call required')
    if (change === 'metadata') {
      const first = task.selection.rawCatalog[0]; assert.ok(first)
      first._meta = { literal: 'changed\0raw' }
    }
    else if (change === 'order') task.selection.rawCatalog.reverse()
    else task.selection.catalogDigest = stdioDigestV2.parse('1'.repeat(64))
    const nextDigest = stdioSha256V2('task', task, budget)
    input.dispatch.taskDigest = nextDigest; input.dispatch.permit.taskDigest = nextDigest
    input.authorization.permit.taskDigest = nextDigest
    assert.throws(() => parseStdioStartV2(input, limits), errorCode('stdio_v2_catalog_digest_mismatch'))
  }
})

void test('complete start JSON rejects extra fields, depth/nodes/bytes overflow and budget replacement', () => {
  for (const extra of ['top', 'dispatch', 'authorization'] as const) {
    const input = packet()
    Reflect.set(extra === 'top' ? input : input[extra], 'extra', true)
    assert.throws(() => parseStdioStartV2(input, limits))
  }
  const huge = packet()
  if (huge.dispatch.task.phase !== 'call') assert.fail('call required')
  huge.dispatch.task.selection.arguments.oversized = 'x'.repeat(limits.maxInputBytes)
  assert.throws(() => parseStdioStartV2(huge, limits))
  for (const replacements of [{ maxJsonDepth: 2 }, { maxJsonNodes: 10 }, { maxInputBytes: 256 }]) {
    assert.throws(() => parseStdioStartV2(packet(), { ...limits, ...replacements }))
  }
  const mismatch = packet(); mismatch.dispatch.task.limits.requestMs++
  assert.throws(() => parseStdioStartV2(mismatch, limits))
})

void test('dispatch executes one actual paginated SDK call with original raw selection, relative cwd, environment and snapshot', async (t) => {
  const p = peer(t), input = packet(), task = input.dispatch.task
  if (task.phase !== 'call') assert.fail('call required')
  const childRoot = join(p.root, 'nested', 'project'); mkdirSync(childRoot, { recursive: true })
  task.invocation.cwd = 'nested/project'
  task.invocation.argv.push('two words', '$(not-a-command)', '; not-a-command')
  input.dispatch.taskDigest = stdioSha256V2('task', task, budget)
  input.dispatch.permit.taskDigest = input.dispatch.taskDigest
  input.authorization.permit.taskDigest = input.dispatch.taskDigest
  const dispatch = validateStdioStartV2(input, limits, input.dispatch.permit.executorOwner, now).dispatch
  const running = runStdioDispatchV2(dispatch, p.environment, new AbortController().signal)
  if (dispatch.task.phase !== 'call') assert.fail('call required')
  dispatch.task.selection.arguments.text = 'after first await'
  dispatch.task.selection.rawCatalog.reverse(); dispatch.task.invocation.cwd = 'after-first-await'
  p.environment.env.LANG = 'after-first-await'
  Reflect.set(p.environment.identity, 'kind', 'unix')
  const result = await running
  if (result.state !== 'completed' || result.phase !== 'call') assert.fail('expected complete call')
  assert.deepEqual(result.catalog, catalog); assert.deepEqual(result.result.structuredContent, { echo: 'literal\0😀' })
  assert.equal(result.pages.length, 2); assert.equal(result.facts.cleanupConfirmed, true)
  assert.equal(p.trace().length, 0)
  const trace = p.trace(childRoot)
  assert.equal(trace.filter(row => row.event === 'spawn').length, 1)
  assert.equal(trace.filter(row => row.method === 'initialize').length, 1)
  assert.equal(trace.filter(row => row.method === 'tools/call').length, 1)
  assert.deepEqual(trace.find(row => row.method === 'tools/call')?.params,
    { name: 'echo', arguments: { text: 'literal\0😀', '10': 'ten', '2': 'two' } })
  assert.deepEqual(trace[0]?.env, { HOME: p.root, PATH: dirname(process.execPath), LANG: 'C.UTF-8' })
  assert.deepEqual(trace[0]?.argv, ['two words', '$(not-a-command)', '; not-a-command'])
})

void test('discovery executes the actual provider and exposes original raw catalog without a call', async (t) => {
  const p = peer(t), input = packet('discover')
  const result = await runStdioDispatchV2(input.dispatch, p.environment, new AbortController().signal)
  if (result.state !== 'completed' || result.phase !== 'discover') assert.fail('expected discovery')
  assert.deepEqual(result.catalog, catalog); assert.equal(result.facts.toolsCallAttempted, false)
  assert.equal(result.facts.cleanupConfirmed, true)
  assert.equal(p.trace().filter(row => row.method === 'initialize').length, 1)
  assert.equal(p.trace().filter(row => row.method === 'tools/call').length, 0)
})

void test('bad task/catalog digest, root and relative traversal throw before starting; cancellation starts nothing', async (t) => {
  const p = peer(t), input = packet()
  input.dispatch.taskDigest = stdioDigestV2.parse('f'.repeat(64)); input.dispatch.permit.taskDigest = input.dispatch.taskDigest
  assert.throws(() => runStdioDispatchV2(input.dispatch, p.environment, new AbortController().signal), errorCode('stdio_v2_task_digest_mismatch'))
  const staleCatalog = packet()
  if (staleCatalog.dispatch.task.phase !== 'call') assert.fail('call required')
  staleCatalog.dispatch.task.selection.catalogDigest = stdioDigestV2.parse('f'.repeat(64))
  staleCatalog.dispatch.taskDigest = stdioSha256V2('task', staleCatalog.dispatch.task, budget)
  staleCatalog.dispatch.permit.taskDigest = staleCatalog.dispatch.taskDigest
  assert.throws(() => runStdioDispatchV2(staleCatalog.dispatch, p.environment, new AbortController().signal), errorCode('stdio_v2_catalog_digest_mismatch'))
  for (const cwd of ['/workspace', '../outside', 'nested/../outside', 'nested//project', 'nested\\project', 'bad\0path']) {
    const unsafe = packet(); unsafe.dispatch.task.invocation.cwd = cwd
    assert.throws(() => runStdioDispatchV2(unsafe.dispatch, p.environment, new AbortController().signal))
  }
  assert.throws(() => runStdioDispatchV2(packet().dispatch, { ...p.environment, workspaceRoot: 'relative' }, new AbortController().signal),
    errorCode('stdio_v2_workspace_root_invalid'))
  const stopped = new AbortController(); stopped.abort()
  const result = await runStdioDispatchV2(packet().dispatch, p.environment, stopped.signal)
  if (result.state !== 'failed') assert.fail('expected abort')
  assert.equal(result.errorCode, 'aborted'); assert.equal(result.facts.programStartAttempted, false)
  assert.equal(p.trace().length, 0)
})

void test('changed actual peer catalog closes the child without calling and never silently refreshes selection', async (t) => {
  const p = peer(t), input = packet(); input.dispatch.task.invocation.argv[1] = 'changed'
  input.dispatch.taskDigest = stdioSha256V2('task', input.dispatch.task, budget)
  input.dispatch.permit.taskDigest = input.dispatch.taskDigest
  const result = await runStdioDispatchV2(input.dispatch, p.environment, new AbortController().signal)
  if (result.state !== 'failed') assert.fail('expected changed directory refusal')
  assert.equal(result.errorCode, 'catalog_changed'); assert.equal(result.facts.toolsCallAttempted, false)
  assert.equal(result.facts.cleanupConfirmed, true); assert.equal(p.trace().filter(row => row.method === 'tools/call').length, 0)
})
