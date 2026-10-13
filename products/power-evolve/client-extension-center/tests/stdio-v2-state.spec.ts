/** Controller lifecycle regressions with synthetic endpoints; no SDK, Platform or user programs. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { StdioV2State, type StdioV2Submission } from '../src/client/stdio-v2-state.ts'
import { StdioV2HttpError, type StdioV2Port } from '../src/client/stdio-v2-api.ts'
import { id, available, connection, create, receipt, summary, detail, check, checkReceipt, management, configuration, actions } from './stdio-v2-fixtures.ts'

const unexpected = async (): Promise<never> => { throw new Error('Unexpected mutation') }
function port(overrides: Partial<StdioV2Port> = {}): StdioV2Port {
  return { config: async () => available, list: async () => ({ items: [connection], next: null }),
    actions: async () => ({ items: [summary], nextOffset: null }), detail: async () => detail,
    create: unexpected, update: unexpected, toggle: unexpected, remove: unexpected, check: unexpected,
    receipt: unexpected, cancel: unexpected, ...overrides }
}

test('explicit Session selection creates no Session and original lost request is recovered only by receipt', async () => {
  const sent: unknown[] = [], read: unknown[] = []
  const state = new StdioV2State(port({ create: async (input) => { sent.push(input); throw new Error('lost reply') },
    receipt: async (input) => { read.push(input); if (read.length === 1) throw new StdioV2HttpError(404, 'stdio_v2_request_not_found'); return receipt } }))
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
  const state = new StdioV2State(port({ create: async (_input, signal) => { signals.push(signal); return deferred.promise },
    receipt: async () => receipt }))
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
  const state = new StdioV2State(port({ list: async (input) => { lists.push(input); return { items: [], next: null } },
    actions: async (input) => { actions.push(input); return { items: [], nextOffset: null } } }))
  state.select(id(3), [id(3), id(23)]); await state.load(); await state.load(connection.connectionId, 2)
  state.select(id(23), [id(3), id(23)]); await state.load()
  assert.deepEqual(lists, [{}, { after: connection.connectionId }, {}])
  assert.deepEqual(actions, [{ sessionId: id(3), offset: 0, limit: 2 },
    { sessionId: id(3), offset: 2, limit: 2 }, { sessionId: id(23), offset: 0, limit: 2 }])
  assert.deepEqual(state.getSnapshot().connections?.items, [])
})

test('full original detail is retained and wrong frozen task/ref replies are refused', async () => {
  const state = new StdioV2State(port())
  state.select(id(3), [id(3)]); await state.load(); await state.detail(summary.actionId)
  assert.deepEqual(state.getSnapshot().detail, detail)
  const bad = new StdioV2State(port({ detail: async () => ({ ...detail, taskDigest: summary.taskDigest.replace(/e/g, 'd') as typeof summary.taskDigest }) }))
  bad.select(id(3), [id(3)]); await bad.load(); await bad.detail(summary.actionId)
  assert.equal(bad.getSnapshot().detail, undefined); assert.equal(bad.getSnapshot().error, 'failed')
  const other = new StdioV2State(port({ list: async () => ({ items: [], next: null }),
    actions: async () => ({ items: [], nextOffset: null }) }))
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

test('stopping a late connection read prevents a subsequent action request', async () => {
  const list = Promise.withResolvers<{ items: typeof connection[]; next: null }>()
  let started!: () => void
  const reading = new Promise<void>((resolve) => { started = resolve })
  let actions = 0
  const state = new StdioV2State(port({ list: async () => { started(); return list.promise },
    actions: async () => { actions++; return { items: [], nextOffset: null } } }))
  state.select(id(3), [id(3)])
  const loading = state.load()
  await reading
  state.stop(); list.resolve({ items: [connection], next: null }); assert.equal(await loading, undefined)
  assert.equal(actions, 0)
  assert.equal(state.getSnapshot().connections, undefined)
  assert.equal(state.getSnapshot().busy, false)
})

const update = management.update.parse({ requestId: id(7), connectionId: id(4), expectedRevision: 1, configuration })
const toggle = management.toggle.parse({ requestId: id(7), connectionId: id(4), expectedRevision: 1, enabled: true })
const remove = management.remove.parse({ requestId: id(7), connectionId: id(4), expectedRevision: 1 })
const submissions: readonly StdioV2Submission[] = [{ kind: 'create', input: create }, { kind: 'update', input: update },
  { kind: 'toggle', input: toggle }, { kind: 'delete', input: remove }, { kind: 'check', input: check }]

test.each(submissions)('accepts only the original $kind submission and not a mismatched receipt', async (submission) => {
  const result = submission.kind === 'check' ? checkReceipt : { ...receipt, purpose: submission.kind,
    revision: submission.kind === 'update' ? 2 : 1, enabled: submission.kind === 'toggle', deleted: submission.kind === 'delete' }
  const endpoint = submission.kind === 'delete' ? 'remove' : submission.kind
  const state = new StdioV2State(port({ [endpoint]: async () => result }))
  let notifications = 0
  const dispose = state.subscribe(() => { notifications++ })
  state.select(id(3), [id(3)]); await state.load(); await state.submit(submission)
  assert.deepEqual(state.getSnapshot().receipt, result); assert.equal(state.getSnapshot().pending, undefined)
  assert(notifications > 0); dispose(); const prior = notifications
  state.stop(); assert.equal(notifications, prior)
  const wrong = new StdioV2State(port({ [endpoint]: async () => ({ ...result, requestId: id(99) }) }))
  wrong.select(id(3), [id(3)]); await wrong.load(); await wrong.submit(submission)
  assert.equal(wrong.getSnapshot().receipt, undefined); assert.equal(wrong.getSnapshot().error, 'uncertain')
})

test('unavailable, busy and empty selections cannot issue mutations or concurrent reads', async () => {
  const waiting = Promise.withResolvers<typeof available>()
  let configurations = 0
  const state = new StdioV2State(port({ config: async () => { configurations++; return waiting.promise } }))
  state.select('not-owned', [id(3)]); assert.equal(state.getSnapshot().sessionId, '')
  const loading = state.load()
  assert.equal(await state.load(), undefined)
  await state.submit({ kind: 'create', input: create }); await state.reconcile(); await state.detail(id(1)); await state.cancel(id(1))
  assert.equal(configurations, 1); assert.equal(state.getSnapshot().pending, undefined)
  state.stop(); waiting.resolve(available); assert.equal(await loading, undefined)
  const unavailable = new StdioV2State(port({ config: async () => ({ formatVersion: 2, available: false }) }))
  unavailable.select(id(3), [id(3)]); assert.equal(await unavailable.load(), false)
  await unavailable.submit({ kind: 'create', input: create }); assert.equal(unavailable.getSnapshot().pending, undefined)
})

test('successful cancellation updates only the original action and clears its selected detail', async () => {
  const second = actions.summary.parse({ ...summary, actionId: id(22) })
  const result = { ...summary, cancelRequested: true }
  const state = new StdioV2State(port({ actions: async () => ({ items: [summary, second], nextOffset: null }),
    cancel: async () => result }))
  state.select(id(3), [id(3)]); await state.load(); await state.detail(summary.actionId); await state.cancel(summary.actionId)
  assert.deepEqual(state.getSnapshot().actions?.items, [result, second])
  assert.equal(state.getSnapshot().detail, undefined); assert.equal(state.getSnapshot().pendingCancel, undefined)
})

test('definite cancellation refusal reports expiry and a changed action remains uncertain', async () => {
  const refused = new StdioV2State(port({ cancel: async () => { throw new StdioV2HttpError(401) } }))
  refused.select(id(3), [id(3)]); await refused.load(); await refused.cancel(summary.actionId)
  assert.equal(refused.getSnapshot().pendingCancel, undefined); assert.equal(refused.getSnapshot().error, 'expired')
  const changed = new StdioV2State(port({ cancel: async () => actions.summary.parse({ ...summary, sessionId: id(99) }) }))
  changed.select(id(3), [id(3)]); await changed.load(); await changed.cancel(summary.actionId)
  assert.equal(changed.getSnapshot().pendingCancel, summary.actionId); assert.equal(changed.getSnapshot().error, 'uncertain')
})

test('late detail and cancellation cannot replace a different Session generation', async () => {
  for (const operation of ['detail', 'cancel'] as const) {
    const result = Promise.withResolvers<typeof detail>()
    const state = new StdioV2State(port({ [operation]: async () => result.promise }))
    state.select(id(3), [id(3)]); await state.load()
    const reading = state[operation](summary.actionId)
    state.select(id(23), [id(23)]); result.resolve(detail); await reading
    assert.equal(state.getSnapshot().detail, undefined); assert.equal(state.getSnapshot().actions, undefined)
    assert.equal(state.getSnapshot().sessionId, id(23))
  }
})

test('late action pages and receipt recovery cannot repopulate a stopped Session', async () => {
  const page = Promise.withResolvers<{ items: typeof summary[]; nextOffset: null }>()
  const started = Promise.withResolvers<undefined>()
  const state = new StdioV2State(port({ actions: async () => { started.resolve(undefined); return page.promise } }))
  state.select(id(3), [id(3)])
  const loading = state.load(); await started.promise
  state.stop(); page.resolve({ items: [summary], nextOffset: null })
  assert.equal(await loading, undefined); assert.equal(state.getSnapshot().actions, undefined)

  const found = Promise.withResolvers<typeof receipt>()
  const recovering = new StdioV2State(port({ create: async () => { throw new Error('lost reply') }, receipt: () => found.promise }))
  recovering.select(id(3), [id(3)]); await recovering.load(); await recovering.submit({ kind: 'create', input: create })
  const lookup = recovering.reconcile()
  recovering.select(id(23), [id(23)])
  found.resolve(receipt); await lookup
  assert.equal(recovering.getSnapshot().receipt, undefined)
  recovering.select(id(3), [id(3)])
  assert.equal(recovering.getSnapshot().pending?.input.requestId, create.requestId)
})

test('recovering one owner request preserves a second owner original request', async () => {
  const second = management.create.parse({ ...create, requestId: id(27) })
  const state = new StdioV2State(port({ create: async () => { throw new Error('lost reply') }, receipt: async () => receipt }))
  state.select(id(3), [id(3)]); await state.load(); await state.submit({ kind: 'create', input: create })
  state.select(id(23), [id(23)]); await state.load(); await state.submit({ kind: 'create', input: second })
  state.select(id(3), [id(3)]); await state.reconcile()
  assert.equal(state.getSnapshot().receipt?.requestId, create.requestId)
  state.select(id(23), [id(23)])
  assert.equal(state.getSnapshot().pending?.input.requestId, second.requestId)
})
