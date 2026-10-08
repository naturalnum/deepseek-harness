/** Real native card components with observable Session and Platform-port fixtures; not actual App/PG/Runner acceptance. */
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StdioV2Panel } from '../src/client/StdioV2Panel.tsx'
import { StdioMcpPage } from '../src/client/StdioMcpPage.tsx'
import { PluginsPage, type PluginsPageProps } from '../src/client/PluginsPage.tsx'
import { StdioV2State } from '../src/client/stdio-v2-state.ts'
import type { StdioV2Port } from '../src/client/stdio-v2-api.ts'
import type { PersonalMcpSessionListState, PersonalMcpSessionSource } from '../src/client/personal-mcp-session-view.ts'
import type { StdioMcpPort } from '../src/client/stdio-mcp-api.ts'
import { en, zh } from '../src/client/locales.ts'
import { id, available, connection, receipt, checkReceipt, summary, detail } from './stdio-v2-fixtures.ts'

afterEach(cleanup)
const t = (key: keyof typeof en) => en[key]
const approvalUrl = async () => 'https://platform.example.test/approval'
const emptyLegacy = { available: true, preset: { toolName: 'mcp__stdio__whoami' as const, description: 'Fixed process' }, items: [] }
function nativeSessions(ids = [id(3), id(23)]) {
  let snapshot: PersonalMcpSessionListState = { ids, byId: Object.fromEntries(ids.map((id, index) => [id, { displayTitle: `Session ${index + 1}` }])),
    current: ids[0], phase: 'ready' }
  const listeners = new Set<() => void>()
  const source: PersonalMcpSessionSource = { list: { getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } } }
  return { source, replace: (ids: string[]) => { snapshot = { ...snapshot, ids,
    byId: Object.fromEntries(ids.map(id => [id, { displayTitle: 'Other owner' }])), current: ids[0] }; listeners.forEach(l => { l() }) } }
}
function makePort(overrides: Partial<StdioV2Port> = {}): StdioV2Port {
  return { config: async () => available, list: async () => ({ items: [connection], next: null }),
    create: vi.fn(async (input: Parameters<StdioV2Port['create']>[0]) => ({ ...receipt, requestId: input.requestId })),
    update: vi.fn(), toggle: vi.fn(), remove: vi.fn(),
    receipt: vi.fn(async (input: Parameters<StdioV2Port['receipt']>[0]) => ({ ...receipt, requestId: input.requestId })),
    check: vi.fn(async (input: Parameters<StdioV2Port['check']>[0]) => ({ ...checkReceipt, requestId: input.requestId })),
    actions: async request => ({ items: request.sessionId === summary.sessionId ? [summary] : [], nextOffset: null }),
    detail: async () => detail, cancel: vi.fn(), ...overrides }
}
function select(sessionId = id(3)): void { fireEvent.change(screen.getByRole('combobox', { name: 'Existing Session' }), { target: { value: sessionId } }) }
async function ready(): Promise<void> { await waitFor(() => expect(screen.queryByRole('status')).toBeNull()) }

test('the native STDIO card uses generic management without mapping old whoami records and requires an explicit Session', async () => {
  const port = makePort(), sessions = nativeSessions(), legacyCalls = vi.fn(async () => ({ items: [] }))
  const legacy: StdioMcpPort = { list: vi.fn(), install: vi.fn(), toggle: vi.fn(), calls: legacyCalls, status: vi.fn() }
  const state = new StdioV2State(port)
  const page = render(<StdioMcpPage data={{ ...emptyLegacy, items: [{ connectionId: id(80), name: 'Old whoami', enabled: true,
    revision: 1, toolName: 'mcp__stdio__whoami', description: 'Original fixed connection' }] }} port={legacy} t={t} onChange={vi.fn()}
    generic={{ state, sessions: sessions.source, approvalUrl }} />)
  await ready()
  expect(screen.getByRole('heading', { name: 'Generic process MCP' })).toBeTruthy()
  expect(screen.queryByText('Old whoami')).toBeNull(); expect(legacyCalls).not.toHaveBeenCalled()
  expect(screen.getByRole('combobox').getAttribute('value')).toBeNull()
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('')
  expect(port.check).not.toHaveBeenCalled()
  expect(page.container.textContent).toMatchSnapshot('generic card before explicit Session selection')
  select(); await screen.findByText('Synthetic echo'); await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Check this Session' }))
  await waitFor(() => expect(port.check).toHaveBeenCalledOnce())
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
  await waitFor(() => expect(port.create).toHaveBeenCalledOnce())
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
  await waitFor(() => expect(port.receipt).toHaveBeenCalledOnce())
  expect(vi.mocked(port.receipt).mock.calls[0]![0]).toEqual({ requestId })
  expect(port.create).toHaveBeenCalledOnce()
})

test('Session/owner changes and card teardown abort reads and discard late original outcomes', async () => {
  const deferred = Promise.withResolvers<typeof detail>(), signals: (AbortSignal | undefined)[] = []
  const sessions = nativeSessions([id(3)])
  const port = makePort({ detail: async (_input, signal) => { signals.push(signal); return deferred.promise },
    list: async () => ({ items: sessions.source.list.getSnapshot().ids.includes(id(3)) ? [connection] : [], next: null }) })
  const state = new StdioV2State(port)
  const page = render(<StdioV2Panel state={state} sessions={sessions.source} approvalUrl={approvalUrl} t={t} />)
  select(); await screen.findByText('Synthetic echo'); await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Complete task and result' }))
  await waitFor(() => expect(signals.length).toBe(1))
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
  await waitFor(() => expect(alice.container.querySelector('[data-stdio-v2-detail]')?.textContent).toBe(JSON.stringify(detail, null, 2)))
  expect(bob.container.querySelector('[data-stdio-v2-detail]')).toBeNull(); expect(bobPort.check).not.toHaveBeenCalled()
})

test('full raw detail is displayed without truncation and unsafe independent approval addresses are refused', async () => {
  const port = makePort(), state = new StdioV2State(port)
  const page = render(<StdioV2Panel state={state} sessions={nativeSessions().source}
    approvalUrl={async () => 'javascript:alert(1)'} t={t} />)
  select(); await ready()
  fireEvent.click(screen.getByRole('button', { name: 'Complete task and result' }))
  await waitFor(() => expect(page.container.querySelector('[data-stdio-v2-detail]')?.textContent).toBe(JSON.stringify(detail, null, 2)))
  expect(screen.queryByRole('link')).toBeNull(); expect(await screen.findByText(en.approvalUnavailable)).toBeTruthy()
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
})

test('available false preserves the existing whoami native page; available true opens the same card without legacy calls', async () => {
  const legacy: StdioMcpPort = { list: vi.fn(async () => emptyLegacy), install: vi.fn(), toggle: vi.fn(),
    calls: vi.fn(async () => ({ items: [] })), status: vi.fn() }
  const generic = makePort({ config: async () => ({ formatVersion: 2, available: false }) })
  const props = { plugins: { list: async () => [], setEnabled: vi.fn() },
    mcp: { list: async () => ({ available: false, preset: { toolName: 'mcp__personal__whoami', description: 'fixed' }, items: [] }), install: vi.fn(), toggle: vi.fn(), check: vi.fn() },
    stdio: legacy, stdioV2: generic, mcpSessions: nativeSessions().source,
    ssh: { list: async () => ({ available: false, items: [] }), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(),
      check: vi.fn(), callList: async () => [], callStatus: vi.fn(), callCancel: vi.fn() }, approvalUrl, t } as PluginsPageProps
  const page = render(<PluginsPage {...props} />)
  fireEvent.click(screen.getByRole('tab', { name: 'All plugins' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Process MCP' }))
  expect(await screen.findByText(en.stdioMcpNotice)).toBeTruthy(); expect(legacy.list).toHaveBeenCalledOnce()
  page.unmount(); vi.mocked(legacy.list).mockClear(); vi.mocked(legacy.calls).mockClear()
  render(<PluginsPage {...props} stdioV2={makePort()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Generic process MCP' }))
  expect(await screen.findByText(en.stdioV2Notice)).toBeTruthy()
  expect(legacy.list).not.toHaveBeenCalled(); expect(legacy.calls).not.toHaveBeenCalled()
})
