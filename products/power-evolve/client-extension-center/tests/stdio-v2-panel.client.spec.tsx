// @vitest-environment jsdom
/** Real native card components with observable Session and Platform-port fixtures; not actual App/PG/Runner acceptance. */
import { deferredResult } from './deferred-result.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { stdioEnvironmentRef } from '@power-evolve/contracts/mcp-metadata'
import { StdioV2Panel } from '../src/client/StdioV2Panel.tsx'
import { StdioV2State } from '../src/client/stdio-v2-state.ts'
import { StdioV2HttpError, type StdioV2Port } from '../src/client/stdio-v2-api.ts'
import type { PersonalMcpSessionListState, PersonalMcpSessionSource } from '../src/client/personal-mcp-session-view.ts'
import { en, zh } from '../src/client/locales.ts'
import { id, available, connection, receipt, checkReceipt, summary, detail, actions, management } from './stdio-v2-fixtures.ts'

afterEach(cleanup)
const t = (key: keyof typeof en) => en[key]
const approvalUrl = async () => 'https://platform.example.test/approval'
function nativeSessions(ids = [id(3), id(23)]) {
  let snapshot: PersonalMcpSessionListState = { ids, byId: Object.fromEntries(ids.map((id, index) => [id, { displayTitle: `Session ${index + 1}` }])),
    current: ids[0], phase: 'ready' }
  const listeners = new Set<() => void>()
  const source: PersonalMcpSessionSource = { list: { getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } } }
  return { source, update: (patch: Partial<PersonalMcpSessionListState>) => {
    snapshot = { ...snapshot, ...patch }; listeners.forEach((listener) => { listener() })
  }, replace: (ids: string[]) => { snapshot = { ...snapshot, ids,
    byId: Object.fromEntries(ids.map(id => [id, { displayTitle: 'Other owner' }])), current: ids[0] }; listeners.forEach((l) => { l() }) } }
}
type FixtureStdioV2Port = {
  [Key in keyof StdioV2Port]: (...args: Parameters<StdioV2Port[Key]>) => ReturnType<StdioV2Port[Key]>
}

function makePort(overrides: Partial<StdioV2Port> = {}): FixtureStdioV2Port {
  return { config: async () => available, list: async () => ({ items: [connection], next: null }),
    create: vi.fn(async (input: Parameters<StdioV2Port['create']>[0]) => ({ ...receipt, requestId: input.requestId })),
    update: vi.fn(), toggle: vi.fn(), remove: vi.fn(),
    receipt: vi.fn(async (input: Parameters<StdioV2Port['receipt']>[0]) => ({ ...receipt, requestId: input.requestId })),
    check: vi.fn(async (input: Parameters<StdioV2Port['check']>[0]) => ({ ...checkReceipt, requestId: input.requestId })),
    actions: async request => ({ items: request.sessionId === summary.sessionId ? [summary] : [], nextOffset: null }),
    detail: async () => detail, cancel: vi.fn(), ...overrides }
}
function select(sessionId = id(3)): void { fireEvent.change(screen.getByRole('combobox', { name: 'Existing Session' }), { target: { value: sessionId } }) }
async function ready(): Promise<void> { await waitFor(() => { expect(screen.queryByRole('status')).toBeNull() }) }

test('the native generic STDIO configuration requires an explicit existing Session', async () => {
  const port = makePort(), sessions = nativeSessions()
  const state = new StdioV2State(port)
  const page = render(<StdioV2Panel state={state} sessions={sessions.source} approvalUrl={approvalUrl} t={t} />)
  await ready()
  expect(screen.getByRole('heading', { name: 'Generic process MCP' })).toBeTruthy()
  expect(screen.getByRole<HTMLSelectElement>('combobox').getAttribute('value')).toBeNull()
  expect((screen.getByRole<HTMLSelectElement>('combobox')).value).toBe('')
  expect(port.check).not.toHaveBeenCalled()
  expect(page.container.textContent).toMatchSnapshot('generic card before explicit Session selection')
  select(); await screen.findByText('Synthetic echo'); await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Check this Session' }))
  await waitFor(() => { expect(port.check).toHaveBeenCalledOnce() })
  expect(vi.mocked(port.check).mock.calls[0]![0]).toMatchObject({ connectionId: connection.connectionId,
    expectedRevision: 1, sessionId: id(3), target: { kind: 'cloud' } })
  expect(await screen.findByText(en.stdioV2ReceiptNotice)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Open approval page' }).getAttribute('href')).toBe('https://platform.example.test/approval')
})

test('literal configuration form preserves argv and rejects absolute cwd without posting', async () => {
  const port = makePort({ list: async () => ({ items: [], next: null }) })
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={nativeSessions().source} approvalUrl={approvalUrl} t={t} />)
  select(); await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Connection name' }), { target: { value: 'Literal' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Program' }), { target: { value: 'node' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Arguments JSON array' }), { target: { value: '["", "a b", "literal;$(unused)"]' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Project-relative working directory' }), { target: { value: '/workspace' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  expect(await screen.findByText(en.stdioV2Invalid)).toBeTruthy(); expect(port.create).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Project-relative working directory' }), { target: { value: '.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await waitFor(() => { expect(port.create).toHaveBeenCalledOnce() })
  expect(vi.mocked(port.create).mock.calls[0]![0].configuration.invocation).toEqual({ program: 'node', argv: ['', 'a b', 'literal;$(unused)'], cwd: '.' })
})

test('lost mutation reply survives closing the card and only the original receipt is queried', async () => {
  const port = makePort({ create: vi.fn(async () => { throw new Error('lost response') }) })
  const state = new StdioV2State(port), sessions = nativeSessions().source
  const element = <StdioV2Panel state={state} sessions={sessions} approvalUrl={approvalUrl} t={t} />
  const first = render(element); select(); await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Connection name' }), { target: { value: 'Literal' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Program' }), { target: { value: 'node' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await screen.findByText(en.stdioV2Uncertain)
  const requestId = vi.mocked(port.create).mock.calls[0]![0].requestId
  first.unmount(); render(element); select(); await ready()
  expect(screen.getByText(requestId)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Query original receipt' }))
  await waitFor(() => { expect(port.receipt).toHaveBeenCalledOnce() })
  expect(vi.mocked(port.receipt).mock.calls[0]![0]).toEqual({ requestId })
  expect(port.create).toHaveBeenCalledOnce()
})

test('Session/owner changes and card teardown abort reads and discard late original outcomes', async () => {
  const deferred = deferredResult<typeof detail>(), signals: (AbortSignal | undefined)[] = []
  const sessions = nativeSessions([id(3)])
  const port = makePort({ detail: async (_input, signal) => { signals.push(signal); return deferred.promise },
    list: async () => ({ items: sessions.source.list.getSnapshot().ids.includes(id(3)) ? [connection] : [], next: null }) })
  const state = new StdioV2State(port)
  const page = render(<StdioV2Panel state={state} sessions={sessions.source} approvalUrl={approvalUrl} t={t} />)
  select(); await screen.findByText('Synthetic echo'); await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Complete task and result' }))
  await waitFor(() => { expect(signals.length).toBe(1) })
  act(() => { sessions.replace([id(23)]) })
  expect(signals[0]?.aborted).toBe(true); expect(screen.queryByText('Synthetic echo')).toBeNull()
  await act(async () => { deferred.resolve(detail); await deferred.promise })
  expect(page.container.querySelector('[data-stdio-v2-detail]')).toBeNull()
  select(id(23)); await ready(); expect(state.getSnapshot().actions?.items).toEqual([])
  expect(screen.queryByText('Synthetic echo')).toBeNull()
  page.unmount(); expect(signals[0]?.aborted).toBe(true)
})

test('two independent native owner cards never share connection drafts, requests or original raw outcomes', async () => {
  const alicePort = makePort(), bobPort = makePort({ list: async () => ({ items: [{ ...connection,
    connectionId: connection.connectionId.replace(/4$/u, '5') as typeof connection.connectionId,
    configuration: { ...connection.configuration, name: 'Bob-only configuration' } }], next: null }),
  actions: async () => ({ items: [], nextOffset: null }) })
  const aliceState = new StdioV2State(alicePort), bobState = new StdioV2State(bobPort)
  const alice = render(<StdioV2Panel state={aliceState} sessions={nativeSessions([id(3)]).source} approvalUrl={approvalUrl} t={t} />)
  const bob = render(<StdioV2Panel state={bobState} sessions={nativeSessions([id(23)]).source} approvalUrl={approvalUrl} t={t} />)
  fireEvent.change(within(alice.container).getByRole('combobox'), { target: { value: id(3) } })
  fireEvent.change(within(bob.container).getByRole('combobox'), { target: { value: id(23) } })
  await within(alice.container).findByText('Synthetic echo'); await within(bob.container).findByText('Bob-only configuration')
  expect(within(bob.container).queryByText('Synthetic echo')).toBeNull()
  expect(within(alice.container).queryByText('Bob-only configuration')).toBeNull()
  fireEvent.click(within(alice.container).getByRole('button', { name: 'Complete task and result' }))
  await waitFor(() => { expect(alice.container.querySelector('[data-stdio-v2-detail]')?.textContent).toBe(JSON.stringify(detail, null, 2)) })
  expect(bob.container.querySelector('[data-stdio-v2-detail]')).toBeNull(); expect(bobPort.check).not.toHaveBeenCalled()
})

test('full raw detail is displayed without truncation and unsafe independent approval addresses are refused', async () => {
  const port = makePort(), state = new StdioV2State(port)
  const page = render(<StdioV2Panel state={state} sessions={nativeSessions().source}
    approvalUrl={async () => 'javascript:alert(1)'} t={t} />)
  select(); await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Complete task and result' }))
  await waitFor(() => { expect(page.container.querySelector('[data-stdio-v2-detail]')?.textContent).toBe(JSON.stringify(detail, null, 2)) })
  expect(screen.queryByRole('link')).toBeNull(); expect(await screen.findByText(en.approvalUnavailable)).toBeTruthy()
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
})

const metadataCases: { name: string; config: StdioV2Port['config']; message: string }[] = [
  { name: 'unavailable metadata', config: async () => ({ formatVersion: 2, available: false }), message: en.stdioV2Unavailable },
  { name: 'explicit unavailable service', config: async () => { throw new StdioV2HttpError(503, 'stdio_v2_unavailable') }, message: en.stdioLoadFailed },
  { name: 'unrelated service refusal', config: async () => { throw new StdioV2HttpError(503, 'platform_unavailable') }, message: en.stdioLoadFailed },
  { name: 'expired login', config: async () => { throw new StdioV2HttpError(401, 'stdio_v2_unavailable') }, message: en.sessionExpired },
  { name: 'lost metadata reply', config: async () => { throw new TypeError('Synthetic network failure') }, message: en.stdioLoadFailed },
]

test.each(metadataCases)('$name disables generic writes and preserves its actual failure', async ({ config, message }) => {
  const port = makePort({ config, list: vi.fn() })
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={nativeSessions().source} approvalUrl={approvalUrl} t={t} />)
  select()
  expect(await screen.findByText(message)).toBeTruthy()
  expect(port.list).not.toHaveBeenCalled(); expect(port.create).not.toHaveBeenCalled(); expect(port.check).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: en.stdioV2Save }).closest('fieldset')?.hasAttribute('disabled')).toBe(true)
})

test('edits, toggles and deletes the shown saved revision without starting discovery', async () => {
  let current = management.connection.parse({ ...connection, enabled: true, catalogId: id(9), catalogDigest: 'd'.repeat(64) })
  let removed = false
  const update = vi.fn<StdioV2Port['update']>(async (input) => {
    current = { ...current, configuration: input.configuration, revision: input.expectedRevision + 1, enabled: false }
    return { ...receipt, requestId: input.requestId, purpose: 'update', revision: current.revision }
  })
  const toggle = vi.fn<StdioV2Port['toggle']>(async (input) => {
    current = { ...current, enabled: input.enabled }
    return { ...receipt, requestId: input.requestId, purpose: 'toggle', enabled: input.enabled }
  })
  const remove = vi.fn<StdioV2Port['remove']>(async (input) => {
    removed = true
    return { ...receipt, requestId: input.requestId, purpose: 'delete', revision: input.expectedRevision, deleted: true }
  })
  const installed = vi.fn()
  const check = vi.fn<StdioV2Port['check']>()
  const port = makePort({ list: async () => ({ items: removed ? [] : [current], next: null }), update, toggle, remove, check })
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={nativeSessions().source}
    approvalUrl={approvalUrl} t={t} onInstalledChange={installed} />)
  select(); await screen.findByText(current.configuration.name); await ready()
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => { expect(toggle).toHaveBeenCalledOnce() }); await ready()
  expect(toggle.mock.calls[0]?.[0]).toMatchObject({ connectionId: connection.connectionId, expectedRevision: 1, enabled: false })
  fireEvent.click(screen.getByRole('button', { name: en.refreshList })); await ready()
  fireEvent.click(screen.getByRole('button', { name: en.stdioV2Edit }))
  expect(screen.getByRole('textbox', { name: en.stdioV2Argv })).toHaveProperty('value', JSON.stringify(connection.configuration.invocation.argv))
  fireEvent.change(screen.getByRole('textbox', { name: en.mcpConnectionName }), { target: { value: 'Edited literal' } })
  fireEvent.click(screen.getByRole('button', { name: en.stdioV2Save }))
  await waitFor(() => { expect(update).toHaveBeenCalledOnce() }); await ready()
  expect(update.mock.calls[0]?.[0]).toMatchObject({ connectionId: connection.connectionId, expectedRevision: 1,
    configuration: { name: 'Edited literal', invocation: connection.configuration.invocation } })
  fireEvent.click(screen.getByRole('button', { name: en.refreshList })); await screen.findByText('Edited literal'); await ready()
  fireEvent.click(screen.getByRole('button', { name: en.stdioV2New }))
  expect(screen.getByRole('textbox', { name: en.mcpConnectionName })).toHaveProperty('value', '')
  fireEvent.click(screen.getByRole('button', { name: en.stdioV2Delete }))
  await waitFor(() => { expect(remove).toHaveBeenCalledOnce() }); await ready()
  expect(remove.mock.calls[0]?.[0]).toMatchObject({ connectionId: connection.connectionId, expectedRevision: 2 })
  fireEvent.click(screen.getByRole('button', { name: en.refreshList })); await ready()
  expect(screen.queryByText('Edited literal')).toBeNull()
  expect(installed).toHaveBeenLastCalledWith(false)
  expect(check).not.toHaveBeenCalled()
})

test('connection cursors and action offsets replace complete pages for the explicitly selected Session', async () => {
  const second = management.connection.parse({ ...connection, connectionId: id(14), configuration: { ...connection.configuration, name: 'Second connection' } })
  const nextAction = actions.summary.parse({ ...summary, actionId: id(21), state: 'running', executionState: 'running' })
  const list = vi.fn<StdioV2Port['list']>(async input => ({ items: input.after ? [second] : [connection], next: input.after ? null : connection.connectionId }))
  const actionList = vi.fn<StdioV2Port['actions']>(async input => ({ items: input.offset ? [nextAction] : [summary], nextOffset: input.offset ? null : 2 }))
  const port = makePort({ list, actions: actionList })
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={nativeSessions().source} approvalUrl={approvalUrl} t={t} />)
  select(); await screen.findByText('Synthetic echo'); await ready()
  fireEvent.click(screen.getByRole('button', { name: en.stdioV2NextConnections }))
  await screen.findByText('Second connection'); await ready()
  expect(screen.queryByText('Synthetic echo')).toBeNull()
  expect(list).toHaveBeenLastCalledWith({ after: connection.connectionId }, expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button', { name: en.stdioV2NextActions })); await ready()
  expect(actionList).toHaveBeenLastCalledWith({ sessionId: summary.sessionId, offset: 2,
    limit: available.management.pageItems }, expect.any(AbortSignal))
  expect(screen.queryByRole('button', { name: en.stdioV2NextActions })).toBeNull()
  expect(screen.getByRole('combobox', { name: en.stdioV2Session })).toHaveProperty('value', summary.sessionId)
})

test('a cancellation acknowledges its original running action without claiming a terminal result', async () => {
  const running = actions.summary.parse({ ...summary, state: 'running', executionState: 'running' })
  const cancel = vi.fn<StdioV2Port['cancel']>(async () => ({ ...running, cancelRequested: true }))
  const port = makePort({ actions: async () => ({ items: [running], nextOffset: null }), cancel })
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={nativeSessions().source} approvalUrl={approvalUrl} t={t} />)
  select(); await ready()
  fireEvent.click(screen.getByRole('button', { name: en.stdioV2Cancel }))
  await waitFor(() => { expect(cancel).toHaveBeenCalledOnce() }); await ready()
  expect(cancel).toHaveBeenCalledWith({ actionId: summary.actionId }, expect.any(AbortSignal))
  expect(screen.getByRole('button', { name: en.stdioV2Cancel })).toHaveProperty('disabled', true)
  expect(screen.getByText('call: running / running')).toBeTruthy()
})

test('a refresh that observes unavailable composition reports it and withdraws saved write controls', async () => {
  let unavailable = false
  const onUnavailable = vi.fn()
  const create = vi.fn<StdioV2Port['create']>()
  const port = makePort({ config: async () => unavailable ? { formatVersion: 2, available: false } : available, create })
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={nativeSessions().source}
    approvalUrl={approvalUrl} t={t} onUnavailable={onUnavailable} />)
  select(); await screen.findByText('Synthetic echo'); await ready()
  unavailable = true
  fireEvent.click(screen.getByRole('button', { name: en.refreshList }))
  await screen.findByText(en.stdioV2Unavailable)
  await waitFor(() => { expect(onUnavailable).toHaveBeenCalledOnce() })
  expect(screen.queryByText('Synthetic echo')).toBeNull()
  expect(screen.getByRole('button', { name: en.stdioV2Save }).closest('fieldset')).toHaveProperty('disabled', true)
  expect(create).not.toHaveBeenCalled()
})

test('published unavailable metadata retains read-only connection identity while withdrawing its controls', async () => {
  let unavailable = false
  const port = makePort({ config: async () => unavailable ? { formatVersion: 2, available: false } : available })
  const state = new StdioV2State(port), sessions = nativeSessions().source
  const element = <StdioV2Panel state={state} sessions={sessions} approvalUrl={approvalUrl} t={t} />
  const page = render(element)
  select(); await screen.findByText(connection.configuration.name); await ready()
  const published: { label: boolean; controls: number }[] = []
  const unsubscribe = state.subscribe(() => {
    const view = state.getSnapshot()
    if (view.config?.available !== false || !view.connections) return
    page.rerender(element)
    published.push({ label: screen.queryByText(connection.configuration.name) !== null,
      controls: screen.queryAllByRole('switch').length + screen.queryAllByRole('button', { name: en.stdioV2Edit }).length
        + screen.queryAllByRole('button', { name: en.stdioV2Check }).length
        + screen.queryAllByRole('button', { name: en.stdioV2Delete }).length })
  })
  try {
    unavailable = true; fireEvent.click(screen.getByRole('button', { name: en.refreshList }))
    await screen.findByText(en.stdioV2Unavailable)
    await waitFor(() => { expect(state.getSnapshot().busy).toBe(false) })
    expect(published).toEqual([{ label: true, controls: 0 }])
    expect(port.create).not.toHaveBeenCalled(); expect(port.check).not.toHaveBeenCalled()
    expect(port.toggle).not.toHaveBeenCalled(); expect(port.remove).not.toHaveBeenCalled()
  } finally { unsubscribe() }
})

test('pending native Sessions keep writes disabled and a missing title still permits explicit selection', async () => {
  const sessions = nativeSessions([id(3)]), port = makePort()
  sessions.update({ phase: 'pending', byId: { [id(3)]: undefined } })
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={sessions.source} approvalUrl={approvalUrl} t={t} />)
  await ready()
  expect(screen.getByRole('combobox', { name: en.stdioV2Session })).toHaveProperty('disabled', true)
  const save = screen.getByRole('button', { name: en.stdioV2Save })
  expect(save.closest('fieldset')).toHaveProperty('disabled', true)
  fireEvent.click(save)
  expect(port.create).not.toHaveBeenCalled()
  act(() => { sessions.update({ phase: 'ready' }) })
  expect(screen.getByRole('option', { name: id(3) })).toBeTruthy()
  select(); await screen.findByText(connection.configuration.name); await ready()
  expect(screen.getByRole('combobox', { name: en.stdioV2Session })).toHaveProperty('value', id(3))
  expect(port.check).not.toHaveBeenCalled()
})

test.each(['http://127.0.0.1:19081/approval', 'http://localhost:19081/approval', 'http://[::1]:19081/approval'])(
  'uses the trusted local approval destination %s without passing credentials', async (destination) => {
    render(<StdioV2Panel state={new StdioV2State(makePort())} sessions={nativeSessions().source}
      approvalUrl={async () => destination} t={t} />)
    expect((await screen.findByRole('link', { name: en.openApproval })).getAttribute('href')).toBe(destination)
    expect(screen.queryByText(en.approvalUnavailable)).toBeNull()
  },
)

test.each([
  'https://operator@platform.example.test/approval', 'https://:secret@platform.example.test/approval',
  'https://platform.example.test/other', 'https://platform.example.test/approval?token=private',
  'https://platform.example.test/approval#private', 'http://platform.example.test/approval',
  'ftp://localhost/approval', 'not an absolute URL',
])('refuses the untrusted approval destination %s while retaining the read-only card', async (destination) => {
  const port = makePort()
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={nativeSessions().source}
    approvalUrl={async () => destination} t={t} />)
  expect(await screen.findByText(en.approvalUnavailable)).toBeTruthy()
  expect(screen.queryByRole('link', { name: en.openApproval })).toBeNull()
  expect(screen.getByRole('heading', { name: en.stdioV2Title })).toBeTruthy()
  expect(port.create).not.toHaveBeenCalled(); expect(port.check).not.toHaveBeenCalled()
})

test.each(['resolved', 'rejected'] as const)('obsolete approval lookup %s cannot replace the current destination', async (outcome) => {
  const obsolete = deferredResult<string>(), state = new StdioV2State(makePort()), sessions = nativeSessions().source
  const page = render(<StdioV2Panel state={state} sessions={sessions} approvalUrl={() => obsolete.promise} t={t} />)
  page.rerender(<StdioV2Panel state={state} sessions={sessions} approvalUrl={approvalUrl} t={t} />)
  await screen.findByRole('link', { name: en.openApproval })
  await act(async () => {
    if (outcome === 'resolved') obsolete.resolve('http://localhost:19082/approval')
    else obsolete.reject(new Error('Obsolete approval service refused'))
    await Promise.resolve()
  })
  expect(screen.getByRole('link', { name: en.openApproval }).getAttribute('href')).toBe('https://platform.example.test/approval')
  expect(screen.queryByText(en.approvalUnavailable)).toBeNull()
})

test('closing during refresh aborts the read and suppresses obsolete availability callbacks', async () => {
  const metadata = deferredResult<Awaited<ReturnType<StdioV2Port['config']>>>()
  let refreshing = false, signal: AbortSignal | undefined
  const list = vi.fn<StdioV2Port['list']>(async () => ({ items: [connection], next: null }))
  const port = makePort({ list, config: async (currentSignal) => {
    if (!refreshing) return available
    signal = currentSignal; return metadata.promise
  } })
  const unavailable = vi.fn(), installed = vi.fn(), state = new StdioV2State(port)
  const page = render(<StdioV2Panel state={state} sessions={nativeSessions().source} approvalUrl={approvalUrl} t={t}
    onUnavailable={unavailable} onInstalledChange={installed} />)
  select(); await screen.findByText(connection.configuration.name); await ready()
  expect(list).toHaveBeenCalledOnce(); expect(installed).toHaveBeenCalledOnce()
  refreshing = true; fireEvent.click(screen.getByRole('button', { name: en.refreshList }))
  await waitFor(() => { expect(signal).toBeDefined() })
  page.unmount(); expect(signal?.aborted).toBe(true)
  await act(async () => { metadata.resolve({ formatVersion: 2, available: false }); await metadata.promise })
  expect(unavailable).not.toHaveBeenCalled(); expect(installed).toHaveBeenCalledOnce()
  expect(list).toHaveBeenCalledOnce(); expect(state.getSnapshot().busy).toBe(false)
})

test('lost cancellation is read back without replay and a running outcome stays visible', async () => {
  let requested = false
  const running = actions.summary.parse({ ...summary, state: 'running', executionState: 'running' })
  const cancel = vi.fn<StdioV2Port['cancel']>(async () => { throw new TypeError('Cancellation response lost') })
  const port = makePort({ cancel, actions: async () => ({ items: [{ ...running, cancelRequested: requested }], nextOffset: null }) })
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={nativeSessions().source} approvalUrl={approvalUrl} t={t} />)
  select(); await ready()
  fireEvent.click(screen.getByRole('button', { name: en.stdioV2Cancel }))
  await screen.findByText(en.stdioV2Uncertain)
  expect(screen.getByRole('button', { name: en.stdioV2Cancel })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: en.refreshList })); await ready()
  expect(screen.getByText(en.stdioV2Uncertain)).toBeTruthy(); expect(cancel).toHaveBeenCalledOnce()
  requested = true
  fireEvent.click(screen.getByRole('button', { name: en.refreshList })); await ready()
  expect(screen.queryByText(en.stdioV2Uncertain)).toBeNull()
  expect(screen.getByText('call: running / running')).toBeTruthy()
  expect(screen.getByRole('button', { name: en.stdioV2Cancel })).toHaveProperty('disabled', true)
  expect(cancel).toHaveBeenCalledOnce()
})

test('native Session sources retain their method receiver when the card subscribes and reads', async () => {
  const snapshot: PersonalMcpSessionListState = { ids: [id(3)], byId: { [id(3)]: { displayTitle: 'Native method Session' } },
    current: id(3), phase: 'ready' }
  const list = {
    snapshot, listeners: new Set<() => void>(),
    getSnapshot() { return this.snapshot },
    subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
  }
  const sessions: PersonalMcpSessionSource = { list }
  const page = render(<StdioV2Panel state={new StdioV2State(makePort())} sessions={sessions} approvalUrl={approvalUrl} t={t} />)
  await ready(); expect(screen.getByRole('option', { name: 'Native method Session' })).toBeTruthy()
  select(); await screen.findByText(connection.configuration.name); await ready()
  act(() => {
    list.snapshot = { ...snapshot, ids: [], byId: {}, current: undefined }; list.listeners.forEach((listener) => { listener() })
  })
  expect(screen.queryByText(connection.configuration.name)).toBeNull()
  page.unmount(); expect(list.listeners.size).toBe(0)
})

test.each(['create', 'check', 'toggle', 'delete'] as const)(
  'plain HTTP browser crypto permits the explicit %s request through the native card', async (operation) => {
    const originalCrypto = globalThis.crypto, posted: unknown[] = []
    vi.stubGlobal('crypto', { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) })
    try {
      const installed = management.connection.parse({ ...connection, enabled: true, catalogId: id(9), catalogDigest: 'd'.repeat(64) })
      const port = makePort({ list: async () => ({ items: operation === 'create' ? [] : [installed], next: null }),
        create: vi.fn<StdioV2Port['create']>(async (input) => { posted.push(input); return { ...receipt, requestId: input.requestId } }),
        check: vi.fn<StdioV2Port['check']>(async (input) => { posted.push(input); return { ...checkReceipt, requestId: input.requestId } }),
        toggle: vi.fn<StdioV2Port['toggle']>(async (input) => { posted.push(input); return { ...receipt, requestId: input.requestId,
          purpose: 'toggle', enabled: input.enabled } }),
        remove: vi.fn<StdioV2Port['remove']>(async (input) => { posted.push(input); return { ...receipt, requestId: input.requestId,
          purpose: 'delete', revision: input.expectedRevision, deleted: true } }),
      })
      const state = new StdioV2State(port)
      render(<StdioV2Panel state={state} sessions={nativeSessions().source} approvalUrl={approvalUrl} t={t} />)
      select(); await ready()
      if (operation === 'create') {
        fireEvent.change(screen.getByRole('textbox', { name: en.mcpConnectionName }), { target: { value: 'Plain HTTP connection' } })
        fireEvent.change(screen.getByRole('textbox', { name: en.stdioV2Program }), { target: { value: 'node' } })
        fireEvent.click(screen.getByRole('button', { name: en.stdioV2Save }))
      } else if (operation === 'toggle') fireEvent.click(screen.getByRole('switch'))
      else fireEvent.click(screen.getByRole('button', { name: operation === 'check' ? en.stdioV2Check : en.stdioV2Delete }))
      await waitFor(() => { expect(posted).toHaveLength(1) }); await ready()
      const requestId = state.getSnapshot().receipt?.requestId
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
      expect(posted[0]).toMatchObject({ requestId })
      expect(state.getSnapshot().pending).toBeUndefined()
      expect(state.getSnapshot().receipt?.purpose).toBe(operation)
    } finally { vi.unstubAllGlobals() }
  },
)


test('the process form masks environment values and submits only their immutable version reference', async () => {
  const port = makePort({ list: async () => ({ items: [], next: null }) })
  const environment = { prepare: vi.fn(async () => stdioEnvironmentRef.parse({ credentialVersion: id(30), keys: ['API_TOKEN'] })) }
  render(<StdioV2Panel state={new StdioV2State(port)} sessions={nativeSessions().source}
    approvalUrl={approvalUrl} environment={environment} t={t} />)
  select(); await ready()
  fireEvent.change(screen.getByRole('textbox', { name: 'Connection name' }), { target: { value: 'Private process' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Program' }), { target: { value: 'node' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'My private service' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add environment variable' }))
  fireEvent.change(screen.getByLabelText('Variable name'), { target: { value: 'API_TOKEN' } })
  const secret = screen.getByLabelText<HTMLInputElement>('Variable value')
  expect(secret.type).toBe('password')
  fireEvent.change(secret, { target: { value: 'private-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
  await waitFor(() => { expect(port.create).toHaveBeenCalledOnce() })
  expect(environment.prepare).toHaveBeenCalledWith(expect.any(String), [{ name: 'API_TOKEN', value: 'private-secret' }], undefined)
  const input = vi.mocked(port.create).mock.calls[0]![0]
  expect(input.configuration).toMatchObject({ environment: { credentialVersion: id(30), keys: ['API_TOKEN'] },
    presentation: { note: 'My private service', icon: null } })
  expect(JSON.stringify(input)).not.toContain('private-secret')
})
