/** Controller lifecycle regressions with synthetic endpoints; no SDK, Platform or user programs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { StdioV2State } from '../src/client/stdio-v2-state.ts'
import { StdioV2HttpError, type StdioV2Port } from '../src/client/stdio-v2-api.ts'
import { id, available, connection, create, receipt, summary, detail } from './stdio-v2-fixtures.ts'

const unexpected = async (): Promise<never> => { throw new Error('Unexpected mutation') }
function port(overrides: Partial<StdioV2Port> = {}): StdioV2Port {
  return { config: async () => available, list: async () => ({ items: [connection], next: null }),
    actions: async () => ({ items: [summary], nextOffset: null }), detail: async () => detail,
    create: unexpected, update: unexpected, toggle: unexpected, remove: unexpected, check: unexpected,
    receipt: unexpected, cancel: unexpected, ...overrides }
}

test('explicit Session selection creates no Session and original lost request is recovered only by receipt', async () => {
  const sent: unknown[] = [], read: unknown[] = []
  const state = new StdioV2State(port({ create: async input => { sent.push(input); throw new Error('lost reply') },
    receipt: async input => { read.push(input); if (read.length === 1) throw new StdioV2HttpError(404, 'stdio_v2_request_not_found'); return receipt } }))
  await state.load(); await state.submit({ kind: 'create', input: create }); assert.equal(sent.length, 0)
  state.select(id(3), [id(3)]); await state.load()
  const proposed = structuredClone(create), original = structuredClone(proposed)
  await state.submit({ kind: 'create', input: proposed }); proposed.configuration.name = 'changed after submission'
  assert.equal(state.getSnapshot().error, 'uncertain'); assert.deepEqual(state.getSnapshot().pending?.input, original)
  await state.submit({ kind: 'create', input: proposed }); await state.reconcile()
  assert.equal(sent.length, 1); assert.equal(state.getSnapshot().backendCode, 'stdio_v2_request_not_found')
  assert(state.getSnapshot().pending)
  state.stop(); state.select(id(3), [id(3)]); await state.reconcile()
  assert.equal(sent.length, 1); assert.deepEqual(read, [{ requestId: create.requestId }, { requestId: create.requestId }])
  assert.equal(state.getSnapshot().pending, undefined); assert.deepEqual(state.getSnapshot().receipt, receipt)
})

test('old Session late replies abort and cannot populate a new owner; original uncertain request remains owner-local', async () => {
  const deferred = Promise.withResolvers<typeof receipt>(), signals: (AbortSignal | undefined)[] = []
  const state = new StdioV2State(port({ create: async (_input, signal) => { signals.push(signal); return deferred.promise }, receipt: async () => receipt }))
  state.select(id(3), [id(3)]); await state.load()
  const pending = state.submit({ kind: 'create', input: create })
  state.select(id(23), [id(23)]); assert.equal(signals[0]?.aborted, true)
  assert.equal(state.getSnapshot().connections, undefined); assert.equal(state.getSnapshot().pending, undefined)
  deferred.resolve(receipt); await pending
  assert.equal(state.getSnapshot().receipt, undefined); assert.equal(state.getSnapshot().sessionId, id(23))
  state.select(id(3), [id(3)]); assert.equal(state.getSnapshot().pending?.input.requestId, create.requestId)
  await state.reconcile(); assert.deepEqual(state.getSnapshot().receipt, receipt)
})

test('connection and action pages replace one another without merging owners or inventing latest-operation targets', async () => {
  const lists: unknown[] = [], actions: unknown[] = []
  const state = new StdioV2State(port({ list: async input => { lists.push(input); return { items: [], next: null } },
    actions: async input => { actions.push(input); return { items: [], nextOffset: null } } }))
  state.select(id(3), [id(3), id(23)]); await state.load(); await state.load(connection.connectionId, 2)
  state.select(id(23), [id(3), id(23)]); await state.load()
  assert.deepEqual(lists, [{}, { after: connection.connectionId }, {}])
  assert.deepEqual(actions, [{ sessionId: id(3), offset: 0, limit: 2 }, { sessionId: id(3), offset: 2, limit: 2 }, { sessionId: id(23), offset: 0, limit: 2 }])
  assert.deepEqual(state.getSnapshot().connections?.items, [])
})

test('full original detail is retained and wrong frozen task/ref replies are refused', async () => {
  const state = new StdioV2State(port())
  state.select(id(3), [id(3)]); await state.load(); await state.detail(summary.actionId)
  assert.deepEqual(state.getSnapshot().detail, detail)
  const bad = new StdioV2State(port({ detail: async () => ({ ...detail, taskDigest: summary.taskDigest.replace(/e/g, 'd') as typeof summary.taskDigest }) }))
  bad.select(id(3), [id(3)]); await bad.load(); await bad.detail(summary.actionId)
  assert.equal(bad.getSnapshot().detail, undefined); assert.equal(bad.getSnapshot().error, 'failed')
  const other = new StdioV2State(port({ list: async () => ({ items: [], next: null }), actions: async () => ({ items: [], nextOffset: null }) }))
  other.select(id(23), [id(23)]); await other.load()
  assert.equal(other.getSnapshot().detail, undefined); assert.deepEqual(state.getSnapshot().detail, detail)
})

test('unknown cancellation only permits readback and never claims cleanup or retries its POST', async () => {
  let cancels = 0, cancelled = false
  const running = { ...summary, state: 'running' as const, executionState: 'running' as const }
  const state = new StdioV2State(port({ actions: async () => ({ items: [{ ...running, cancelRequested: cancelled }], nextOffset: null }),
    cancel: async () => { cancels++; throw new Error('lost cancellation response') } }))
  state.select(id(3), [id(3)]); await state.load(); await state.cancel(summary.actionId); await state.cancel(summary.actionId)
  assert.equal(cancels, 1); assert.equal(state.getSnapshot().error, 'uncertain')
  await state.load(); assert.equal(state.getSnapshot().pendingCancel, summary.actionId)
  cancelled = true; await state.load(); assert.equal(state.getSnapshot().pendingCancel, undefined)
  assert.equal(state.getSnapshot().actions?.items[0]?.state, 'running'); assert.equal(cancels, 1)
})

test('definite HTTP refusal permits correcting input, while mismatched recovered receipts stay unresolved', async () => {
  const state = new StdioV2State(port({ create: async () => { throw new StdioV2HttpError(409, 'stdio_v2_revision_conflict') } }))
  state.select(id(3), [id(3)]); await state.load(); await state.submit({ kind: 'create', input: create })
  assert.equal(state.getSnapshot().pending, undefined); assert.equal(state.getSnapshot().backendCode, 'stdio_v2_revision_conflict')
  const uncertain = new StdioV2State(port({ create: async () => { throw new Error('lost') },
    receipt: async () => ({ ...receipt, revision: 2 }) }))
  uncertain.select(id(3), [id(3)]); await uncertain.load(); await uncertain.submit({ kind: 'create', input: create }); await uncertain.reconcile()
  assert(uncertain.getSnapshot().pending); assert.equal(uncertain.getSnapshot().receipt, undefined)
})
