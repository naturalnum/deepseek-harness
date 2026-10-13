/** Actual authenticated Host management consumers; Platform metadata and replies are explicit loopback JSON substitutes. */
import { expect, test } from 'vitest'
import { ids, limits, management, configuration, managementHost, wireDetail, tools,
  type ManagementWireFixture } from './employee1-stdio-consumer-fixture.ts'

const mutation = { requestId: ids.request, purpose: 'create', connectionId: ids.connection,
  revision: 1, enabled: false, deleted: false }
const check = { requestId: ids.request, purpose: 'check', connectionId: ids.connection, revision: 1,
  actionId: ids.action, executionRef: { kind: 'cloud', executionId: ids.execution } }
const connection = { connectionId: ids.connection, revision: 1, enabled: false, configuration,
  catalogId: null, catalogDigest: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }
const select = { requestId: ids.request, connectionId: ids.connection, expectedRevision: 1 }
const checkInput = { ...select, sessionId: ids.session, target: { kind: 'cloud' } }
const endpointCalls = (f: ManagementWireFixture) => f.calls.filter(call => call.url.startsWith('/stdio-v2/') && call.url !== '/stdio-v2/config')
const facts = { programStartAttempted: true, toolsCallAttempted: true, effectMayHaveOccurred: true,
  childPid: 123, childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null,
  cleanupConfirmed: true, protocolBytes: 200, protocolMessages: 4, stderrBytes: 0, stderr: '' }
function completed(phase: 'discover' | 'call' = 'call') {
  const common = { state: 'completed', phase, catalog: tools, pages: [{ tools, extension: 'retained' }],
    initializeResult: { protocolVersion: 'unit', extension: { original: true } }, facts }
  return phase === 'call' ? { ...common, result: { content: [{ type: 'text', text: '完整\0😀' }], isError: true,
    extension: { original: [3, 1] } } } : common
}

for (const [method, input, reply] of [
  ['stdioV2ConnectionsCreate', { requestId: ids.request, configuration }, mutation],
  ['stdioV2ConnectionsUpdate', { ...select, configuration }, { ...mutation, purpose: 'update', revision: 2 }],
  ['stdioV2ConnectionsToggle', { ...select, enabled: true }, { ...mutation, purpose: 'toggle', enabled: true }],
  ['stdioV2ConnectionsDelete', select, { ...mutation, purpose: 'delete', deleted: true }],
  ['stdioV2ConnectionsReceipt', { requestId: ids.request }, check],
  ['stdioV2ConnectionsCheck', checkInput, check],
  ['stdioV2ConnectionsList', { after: ids.connection }, { items: [connection, { ...connection, connectionId: ids.other }], next: ids.other }],
  ['stdioV2ActionsList', { offset: 0, limit: 2, sessionId: ids.session }, { items: [(() => {
    const { task: _task, outcome: _outcome, noStart: _noStart, ...summary } = wireDetail()
    return summary
  })()], nextOffset: 1 }],
  ['stdioV2ActionsDetail', { actionId: ids.action }, wireDetail()],
  ['stdioV2ActionsCancel', { actionId: ids.action }, (() => {
    const { task: _task, outcome: _outcome, noStart: _noStart, ...summary } = wireDetail()
    return { ...summary, cancelRequested: true }
  })()],
] as const) {
  test('native ' + method + ' retains literal wire data and forwards the same authenticated browser bearer once', () => managementHost(async (f) => {
    f.reply = reply
    expect(await f.request(method, input)).toEqual({ status: 200, value: reply })
    expect(endpointCalls(f)).toHaveLength(1)
    expect(endpointCalls(f)[0]?.input).toEqual(input)
    expect(f.calls.every(call => call.authorization === f.calls[0]?.authorization)).toBe(true)
    expect(f.calls.filter(call => call.url === '/stdio-v2/config')).toHaveLength(1)
  }))
}

for (const [name, input] of [
  ['one UTF8 byte over name', { requestId: ids.request, configuration: { ...configuration, name: '中文abc' } }],
  ['NUL label', { requestId: ids.request, configuration: { ...configuration, name: 'a\0' } }],
  ['private execution authority', { requestId: ids.request, configuration, permit: {} }],
  ['NUL argv', { requestId: ids.request, configuration: { ...configuration, invocation: { ...configuration.invocation, argv: ['bad\0'] } } }],
  ['traversal cwd', { requestId: ids.request, configuration: { ...configuration, invocation: { ...configuration.invocation, cwd: '../outside' } } }],
] as const) {
  test('native create rejects ' + name + ' before Platform mutation', () => managementHost(async (f) => {
    const result = await f.request('stdioV2ConnectionsCreate', input)
    expect(result.status).not.toBe(200); expect(result.value).toHaveProperty('error')
    expect(endpointCalls(f)).toEqual([])
  }))
}

for (const [name, input] of [
  ['over page count', { offset: 0, limit: 3 }],
  ['unsafe offset sum', { offset: Number.MAX_SAFE_INTEGER, limit: 1 }],
  ['private owner selection', { offset: 0, limit: 1, userId: ids.user }],
] as const) {
  test('native actions list rejects ' + name + ' before action query', () => managementHost(async (f) => {
    expect((await f.request('stdioV2ActionsList', input)).status).not.toBe(200)
    expect(endpointCalls(f)).toEqual([])
  }))
}

test('native action pagination accepts the greatest safe offset sum and an empty page', () => managementHost(async (f) => {
  f.reply = { items: [], nextOffset: null }
  expect(await f.request('stdioV2ActionsList', { offset: Number.MAX_SAFE_INTEGER - 2, limit: 2 }))
    .toEqual({ status: 200, value: f.reply })
}))

for (const [name, config, status] of [
  ['unavailable', { formatVersion: 2, available: false }, 503],
  ['unavailable with private fields', { formatVersion: 2, available: false, deploymentId: ids.other }, 502],
  ['incomplete limits', { formatVersion: 2, available: true, limits: {}, management, maxReplyBytes: 131072 }, 502],
  ['zero reply budget', { formatVersion: 2, available: true, limits, management, maxReplyBytes: 0 }, 502],
] as const) {
  test('native create refuses ' + name + ' metadata and never submits a mutation', () => managementHost(async (f) => {
    f.config = config
    expect((await f.request('stdioV2ConnectionsCreate', { requestId: ids.request, configuration })).status).toBe(status)
    expect(endpointCalls(f)).toEqual([])
  }))
}

test('public config exposes unavailable literally and never adds executor metadata', () => managementHost(async (f) => {
  f.config = { formatVersion: 2, available: false }
  expect(await f.request('stdioV2Config', {})).toEqual({ status: 200, value: f.config })
  expect(endpointCalls(f)).toEqual([])
}))

for (const [method, input, reply] of [
  ['stdioV2ConnectionsCreate', { requestId: ids.request, configuration }, { ...mutation, requestId: ids.other }],
  ['stdioV2ConnectionsUpdate', { ...select, configuration }, { ...mutation, purpose: 'update', connectionId: ids.other }],
  ['stdioV2ConnectionsToggle', { ...select, enabled: true }, { ...mutation, purpose: 'toggle', enabled: false }],
  ['stdioV2ConnectionsDelete', select, { ...mutation, purpose: 'delete', deleted: false }],
  ['stdioV2ConnectionsReceipt', { requestId: ids.request }, { ...check, requestId: ids.other }],
  ['stdioV2ConnectionsCheck', checkInput, { ...check, revision: 2 }],
] as const) {
  test('native ' + method + ' rejects a different original receipt without resubmission', () => managementHost(async (f) => {
    f.reply = reply
    expect((await f.request(method, input)).status).toBe(502)
    expect(endpointCalls(f)).toHaveLength(1)
  }))
}

test('native receipt returns the original mutation rather than rebuilding a new configuration', () => managementHost(async (f) => {
  f.reply = mutation
  expect(await f.request('stdioV2ConnectionsReceipt', { requestId: ids.request })).toEqual({ status: 200, value: mutation })
  expect(endpointCalls(f).map(call => call.url)).toEqual(['/stdio-v2/connections/receipt'])
}))

test('native lists enforce page ceiling and reject private executor reply fields', () => managementHost(async (f) => {
  for (const reply of [{ items: [connection, connection, connection], next: null },
    { items: [{ ...connection, workerToken: 'unit-private' }], next: null }]) {
    f.reply = reply
    expect((await f.request('stdioV2ConnectionsList', {})).status).toBe(502)
  }
  expect(endpointCalls(f)).toHaveLength(2)
}))

test('native request and reply budgets reject complete JSON without truncating or retrying', () => managementHost(async (f) => {
  f.config = { formatVersion: 2, available: true, limits: { ...limits, maxInputBytes: 256 }, management, maxReplyBytes: 1024 }
  const request = { requestId: ids.request, configuration: { ...configuration,
    invocation: { ...configuration.invocation, argv: ['x'.repeat(300)] } } }
  expect((await f.request('stdioV2ConnectionsCreate', request)).status).not.toBe(200)
  expect(endpointCalls(f)).toEqual([])
  f.config = { formatVersion: 2, available: true, limits, management, maxReplyBytes: 1024 }
  f.reply = { ...wireDetail(), task: { ...wireDetail().task, invocation: { ...configuration.invocation, argv: ['x'.repeat(2048)] } } }
  expect((await f.request('stdioV2ActionsDetail', { actionId: ids.action })).status).toBe(413)
  expect(endpointCalls(f)).toHaveLength(1)
}))

test('native complete request byte ceiling accepts the exact UTF8 JSON and refuses one byte less before mutation', () => managementHost(async (f) => {
  const input = { requestId: ids.request, configuration }, size = new TextEncoder().encode(JSON.stringify(input)).byteLength
  f.reply = mutation
  f.config = { formatVersion: 2, available: true, limits: { ...limits, maxInputBytes: size }, management, maxReplyBytes: 131072 }
  expect(await f.request('stdioV2ConnectionsCreate', input)).toEqual({ status: 200, value: mutation })
  f.config = { formatVersion: 2, available: true, limits: { ...limits, maxInputBytes: size - 1 }, management, maxReplyBytes: 131072 }
  expect((await f.request('stdioV2ConnectionsCreate', input)).status).not.toBe(200)
  expect(endpointCalls(f)).toHaveLength(1)
}))

test('native complete reply byte ceiling preserves the exact original task and refuses one byte less without partial output', () => managementHost(async (f) => {
  const detail = wireDetail(), size = new TextEncoder().encode(JSON.stringify(detail)).byteLength
  f.reply = detail
  f.config = { formatVersion: 2, available: true, limits, management, maxReplyBytes: size }
  expect(await f.request('stdioV2ActionsDetail', { actionId: ids.action })).toEqual({ status: 200, value: detail })
  f.config = { formatVersion: 2, available: true, limits, management, maxReplyBytes: size - 1 }
  const rejected = await f.request('stdioV2ActionsDetail', { actionId: ids.action })
  expect(rejected.status).toBe(413); expect(rejected.value).not.toHaveProperty('task')
  expect(endpointCalls(f)).toHaveLength(2)
}))

test('native failed detail retains complete failure result fields without requiring a no-start claim', () => managementHost(async (f) => {
  f.reply = { ...wireDetail(), state: 'failed', executionState: 'failed', outcome: { state: 'failed',
    errorCode: 'unit_rpc_failed', result: { isError: true, content: [{ type: 'text', text: '原始失败\0😀' }] }, facts } }
  expect(await f.request('stdioV2ActionsDetail', { actionId: ids.action })).toEqual({ status: 200, value: f.reply })
}))

for (const [name, patch] of [
  ['action', { actionId: ids.other }], ['session', { sessionId: ids.other }], ['connection', { connectionId: ids.other }],
  ['revision', { configRevision: 2 }], ['phase', { phase: 'discover' }], ['private permit', { permit: {} }],
] as const) {
  test('native detail rejects ' + name + ' substitution against the original task', () => managementHost(async (f) => {
    f.reply = { ...wireDetail(), ...patch }
    expect((await f.request('stdioV2ActionsDetail', { actionId: ids.action })).status).toBe(502)
    expect(endpointCalls(f)).toHaveLength(1)
  }))
}

for (const phase of ['discover', 'call'] as const) {
  test('native detail preserves complete ' + phase + ' result and separately accepts cancelled no-start disposition', () => managementHost(async (f) => {
    const detail = wireDetail(phase)
    f.reply = { ...detail, state: 'succeeded', executionState: 'succeeded', outcome: completed(phase) }
    expect(await f.request('stdioV2ActionsDetail', { actionId: ids.action })).toEqual({ status: 200, value: f.reply })
    for (const resourceDisposition of ['unallocated', 'ready_retained', 'creation_stopped']) {
      f.reply = { ...detail, state: 'cancelled', executionState: 'cancelled', cancelRequested: true,
        noStart: { kind: 'unstarted_closed', startNeverAuthorized: true, resourceDisposition } }
      expect(await f.request('stdioV2ActionsDetail', { actionId: ids.action })).toEqual({ status: 200, value: f.reply })
    }
  }))
}

for (const [name, patch] of [
  ['missing terminal evidence', { state: 'succeeded', executionState: 'succeeded' }],
  ['outcome before terminal', { outcome: completed() }],
  ['different execution state', { state: 'succeeded', outcome: completed() }],
  ['different outcome phase', { state: 'succeeded', executionState: 'succeeded', outcome: completed('discover') }],
  ['outcome and noStart', { state: 'cancelled', executionState: 'cancelled', cancelRequested: true, outcome: completed(),
    noStart: { kind: 'unstarted_closed', startNeverAuthorized: true, resourceDisposition: 'unallocated' } }],
  ['noStart without cancellation', { state: 'cancelled', executionState: 'cancelled',
    noStart: { kind: 'unstarted_closed', startNeverAuthorized: true, resourceDisposition: 'unallocated' } }],
  ['noStart with running execution', { state: 'cancelled', cancelRequested: true,
    noStart: { kind: 'unstarted_closed', startNeverAuthorized: true, resourceDisposition: 'unallocated' } }],
  ['noStart on running action', { cancelRequested: true,
    noStart: { kind: 'unstarted_closed', startNeverAuthorized: true, resourceDisposition: 'unallocated' } }],
] as const) {
  test('native detail rejects ' + name + ' without inferring stopped writers or emitting partial task data', () => managementHost(async (f) => {
    f.reply = { ...wireDetail(), ...patch }
    const reply = await f.request('stdioV2ActionsDetail', { actionId: ids.action })
    expect(reply.status).toBe(502); expect(reply.value).not.toHaveProperty('task')
  }))
}
