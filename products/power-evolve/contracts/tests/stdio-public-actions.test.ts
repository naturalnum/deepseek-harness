/** Browser-safe public DTO regressions over synthetic task/outcome data; no Platform, approval or executor is invoked. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { stdioActionSchemasV2, stdioPublicConfigV2 } from '../src/stdio-management.ts'
import { stdioLimitsV2, stdioTaskSchemasV2 } from '../src/stdio-mcp.ts'
import { stdioCanonicalJsonV2 } from '../src/stdio-mcp-json.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const limits = stdioLimitsV2.parse({ runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0,
  killGraceMs: 1000, maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072,
  maxProtocolMessages: 100, maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20,
  maxCatalogBytes: 16384, maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 })
const management = { maxNameBytes: 100, pageItems: 2, maxConnections: 4 }, maxReplyBytes = 131072
const schemas = stdioActionSchemasV2(limits, maxReplyBytes, management.pageItems)
const pin = { kind: 'cloud', deploymentId: id(6), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
  imageReference: `synthetic.invalid/runner@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] }
const image = { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }
const rawCatalog = JSON.parse('[{"name":"echo","description":"literal\\u0000目录😀","inputSchema":{"type":"object","default":{"__proto__":{"original":true}}},"_meta":{"__proto__":{"raw":"完整\\u0000😀"}},"extension":{"10":10,"2":2}}]')
const facts = { programStartAttempted: true, toolsCallAttempted: true, effectMayHaveOccurred: true,
  childPid: 123, childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
  protocolBytes: 100, protocolMessages: 4, stderrBytes: 0, stderr: '' }
const rawResult = JSON.parse('{"content":[{"type":"text","text":"完成\\u0000😀","extension":{"__proto__":true}}],"isError":true,"_meta":{"__proto__":{"original":true}}}')

function original(phase: 'discover' | 'call') {
  const task = stdioTaskSchemasV2(limits).task.parse({ formatVersion: 2, phase, actionId: id(1), userId: id(2),
    sessionId: id(3), connectionId: id(4), configRevision: 1, configDigest: 'c'.repeat(64),
    scopeBinding: { kind: 'cloud', userId: id(2), workspaceId: id(5), bindingGeneration: 1,
      target: { spaceId: id(10), rootRelativePath: 'synthetic-project' }, home: { kind: 'user', userId: id(2) } },
    expectedDeploymentPin: pin, invocation: { program: 'node', argv: ['never-executed.mjs', 'literal;$(unused)'], cwd: '.' }, limits,
    ...(phase === 'discover' ? { origin: { kind: 'stdio_discovery', requestId: id(7) } }
      : { origin: { kind: 'operation', operationId: id(8), rootOperationId: id(8), callKey: 'original-call' },
        selection: { catalogId: id(9), catalogDigest: 'd'.repeat(64), rawCatalog, catalogImageExpectation: image,
          rawName: 'echo', rawDescriptor: rawCatalog[0], arguments: JSON.parse('{"__proto__":{"literal":"参数\\u0000😀"}}') } }) })
  const summary = { formatVersion: 2, actionId: task.actionId, executionRef: { kind: 'cloud', executionId: id(11) },
    sessionId: task.sessionId, connectionId: task.connectionId, configRevision: 1, phase, taskDigest: 'e'.repeat(64),
    state: 'succeeded', executionState: 'succeeded', cancelRequested: false,
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:01.000Z' }
  const outcome = { state: 'completed', phase, catalog: rawCatalog,
    pages: [JSON.parse('{"tools":[],"_meta":{"__proto__":{"page":"页\\u0000😀"}},"extension":true}')],
    initializeResult: JSON.parse('{"protocolVersion":"synthetic","_meta":{"__proto__":{"original":true}}}'), facts,
    ...(phase === 'call' ? { result: rawResult } : {}) }
  return { summary, detail: { ...summary, task, outcome, noStart: null } }
}

test('public availability uses exact variants and budgets without exposing private configuration', () => {
  const disabled = { formatVersion: 2, available: false }
  const enabled = { formatVersion: 2, available: true, limits, management, maxReplyBytes }
  assert.deepEqual(stdioPublicConfigV2.parse(disabled), disabled)
  assert.deepEqual(stdioPublicConfigV2.parse(enabled), enabled)
  for (const field of ['limits', 'management', 'maxReplyBytes']) {
    assert.equal(stdioPublicConfigV2.safeParse({ ...disabled, [field]: enabled[field as keyof typeof enabled] }).success, false)
    const partial = { ...enabled }; Reflect.deleteProperty(partial, field)
    assert.equal(stdioPublicConfigV2.safeParse(partial).success, false)
  }
  for (const field of ['metadata', 'approvalKey', 'pin', 'workerId', 'capture', 'nodeName']) {
    assert.equal(stdioPublicConfigV2.safeParse({ ...enabled, [field]: 'private' }).success, false)
  }
  assert.equal(stdioPublicConfigV2.safeParse({ ...enabled, limits: { ...limits, privateKey: 'private' } }).success, false)
  assert.equal(stdioPublicConfigV2.safeParse({ ...enabled, management: { ...management, privateField: true } }).success, false)
  for (const maxReplyBytes of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(stdioPublicConfigV2.safeParse({ ...enabled, maxReplyBytes }).success, false)
  }
  assert.equal(stdioPublicConfigV2.safeParse({ ...enabled, formatVersion: 1 }).success, false)
})

test('summary metadata is logical Cloud state and refuses unknown or private resource fields', () => {
  const { summary } = original('discover')
  assert.deepEqual(schemas.summary.parse(summary), summary)
  for (const field of ['metadata', 'userId', 'token', 'capture', 'podUid', 'workerId', 'permit', 'outcome']) {
    assert.equal(schemas.summary.safeParse({ ...summary, [field]: 'private' }).success, false)
  }
  for (const patch of [{ phase: 'operation' }, { state: 'completed' }, { executionState: 'unknown' },
    { taskDigest: 'F'.repeat(64) }, { configRevision: 0 }, { createdAt: 'not-a-date' },
    { executionRef: { ...summary.executionRef, kind: 'desktop' } },
    { executionRef: { ...summary.executionRef, podUid: id(12) } }]) {
    assert.equal(schemas.summary.safeParse({ ...summary, ...patch }).success, false)
  }
})

test('discovery and operation origins stay separate while complete raw task and outcome fields survive', () => {
  for (const phase of ['discover', 'call'] as const) {
    const { detail } = original(phase), parsed = schemas.detail.parse(detail)
    assert.deepEqual(parsed, detail)
    assert.equal(parsed.task.origin.kind, phase === 'discover' ? 'stdio_discovery' : 'operation')
    assert(Object.hasOwn(parsed.outcome!.initializeResult._meta as object, '__proto__'))
    if (parsed.task.phase === 'call') {
      assert(Object.hasOwn(parsed.task.selection.arguments, '__proto__'))
      assert.deepEqual(parsed.task.selection.rawCatalog, rawCatalog)
      assert.deepEqual(parsed.task.selection.rawDescriptor, rawCatalog[0])
      assert.equal(parsed.task.selection.rawDescriptor.description, 'literal\0目录😀')
      assert(parsed.outcome?.state === 'completed' && parsed.outcome.phase === 'call')
      assert.deepEqual(parsed.outcome.result, rawResult)
    }
    const wrongOrigin = phase === 'discover' ? { kind: 'operation', operationId: id(8), rootOperationId: id(8), callKey: 'wrong' }
      : { kind: 'stdio_discovery', requestId: id(7) }
    assert.equal(schemas.detail.safeParse({ ...detail, task: { ...detail.task, origin: wrongOrigin } }).success, false)
  }
})

test('public details check original logical identities and evidence without treating SDK outcome state as the action state', () => {
  const { detail } = original('call')
  const cancelled = { ...detail, state: 'cancelled', executionState: 'cancelled', cancelRequested: true }
  assert.deepEqual(schemas.detail.parse(cancelled), cancelled)
  assert.equal(schemas.detail.parse(cancelled).outcome?.state, 'completed')
  const failed = { ...detail, state: 'failed', executionState: 'failed', outcome: { state: 'failed', errorCode: 'synthetic', facts,
    result: rawResult } }
  assert.deepEqual(schemas.detail.parse(failed), failed)
  for (const patch of [{ actionId: id(12) }, { sessionId: id(12) }, { connectionId: id(12) }, { configRevision: 2 },
    { phase: 'discover' }, { executionState: 'running' }, { outcome: { ...detail.outcome, phase: 'discover' } },
    { state: 'running', executionState: 'running' }, { outcome: null }]) {
    assert.equal(schemas.detail.safeParse({ ...detail, ...patch }).success, false)
  }
  const active = { ...detail, state: 'pending', executionState: 'queued', outcome: null }
  assert.deepEqual(schemas.detail.parse(active), active)
  for (const field of ['capture', 'prepared', 'stopEvidence', 'approvalFingerprint', 'permit', 'metadata']) {
    assert.equal(schemas.detail.safeParse({ ...detail, [field]: {} }).success, false)
  }
})

test('no-start views disclose only disposition and never substitute for private stop evidence', () => {
  const { detail } = original('discover')
  for (const resourceDisposition of ['unallocated', 'ready_retained', 'creation_stopped']) {
    const closed = { ...detail, state: 'cancelled', executionState: 'cancelled', cancelRequested: true, outcome: null,
      noStart: { kind: 'unstarted_closed', startNeverAuthorized: true, resourceDisposition } }
    assert.deepEqual(schemas.detail.parse(closed), closed)
    for (const patch of [{ outcome: detail.outcome }, { state: 'succeeded' }, { cancelRequested: false },
      { noStart: { ...closed.noStart, podUid: id(12) } }, { noStart: { ...closed.noStart, startNeverAuthorized: false } }]) {
      assert.equal(schemas.detail.safeParse({ ...closed, ...patch }).success, false)
    }
  }
})

test('complete response budgets refuse one-byte overflow and retain original raw values at the limit', () => {
  const { detail } = original('call'), exact = new TextEncoder().encode(stdioCanonicalJsonV2(detail,
    { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: maxReplyBytes })).byteLength
  assert.deepEqual(stdioActionSchemasV2(limits, exact, 2).detail.parse(detail), detail)
  assert.equal(stdioActionSchemasV2(limits, exact - 1, 2).detail.safeParse(detail).success, false)
  assert.equal(stdioActionSchemasV2({ ...limits, maxJsonNodes: 30 }, maxReplyBytes, 2).detail.safeParse(detail).success, false)
  assert.equal(stdioActionSchemasV2({ ...limits, maxJsonDepth: 2 }, maxReplyBytes, 2).detail.safeParse(detail).success, false)
  const changed = { ...detail, outcome: { ...detail.outcome, initializeResult: { raw: 'x'.repeat(maxReplyBytes) } } }
  assert.equal(schemas.detail.safeParse(changed).success, false)
  assert.deepEqual(schemas.detail.parse(detail), detail)
})

test('action pages and explicit requests use the advertised page ceiling and safe arithmetic', () => {
  const { summary } = original('discover'), page = { items: [summary], nextOffset: 1 }
  assert.deepEqual(schemas.list.parse(page), page)
  assert.deepEqual(schemas.listRequest.parse({ offset: 0, limit: 2, sessionId: id(3) }), { offset: 0, limit: 2, sessionId: id(3) })
  for (const input of [{ offset: 0, limit: 3 }, { offset: -1, limit: 1 }, { offset: Number.MAX_SAFE_INTEGER, limit: 1 },
    { offset: 0, limit: 1, userId: id(2) }, { offset: 0, limit: 1, target: { kind: 'cloud' } }]) {
    assert.equal(schemas.listRequest.safeParse(input).success, false)
  }
  assert.equal(schemas.list.safeParse({ items: [summary, summary, summary], nextOffset: null }).success, false)
  assert.equal(schemas.list.safeParse({ ...page, nextOffset: Number.MAX_SAFE_INTEGER + 1 }).success, false)
  assert.equal(schemas.list.safeParse({ ...page, metadata: {} }).success, false)
  assert.equal(stdioActionSchemasV2(limits, 64, 2).list.safeParse(page).success, false)
  for (const pageItems of [0, -1, 0.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => stdioActionSchemasV2(limits, maxReplyBytes, pageItems))
  assert.doesNotThrow(() => stdioActionSchemasV2(limits, maxReplyBytes, Number.MAX_SAFE_INTEGER - 1))
})
