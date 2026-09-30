import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PersonalMcpPage } from '../src/client/PersonalMcpPage.tsx'
import { en } from '../src/client/locales.ts'
import { PersonalMcpConnectionRequestError, type PersonalMcpConnection,
  type PersonalMcpConnectionCheck, type PersonalMcpConnectionPort } from '../src/client/personal-mcp-client.ts'
import { personalMcpSessionSource, type PersonalMcpSessionSource,
  type PersonalMcpNativeSessionSource } from '../src/client/personal-mcp-session-view.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const t = (key: keyof typeof en): string => en[key]
const sessionSnapshot = { ids: ['session-1'], byId: { 'session-1': { displayTitle: 'Current task' } },
  current: 'session-1', phase: 'ready' as const }
const sessions: PersonalMcpSessionSource = { list: {
  getSnapshot: () => sessionSnapshot, subscribe: () => () => {},
} }

function connection(index = 1): PersonalMcpConnection {
  return { connection_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    revision: 1, display_name: index === 1 ? 'Knowledge' : 'Database', server_name: `mcp_${index}`,
    server_url: `https://mcp${index}.example.test/mcp`, authentication: { kind: 'none', secret_configured: false },
    enabled: false, latest_check: null, created_at: '2026-09-30T00:00:00.000Z', updated_at: '2026-09-30T00:00:00.000Z' }
}

function check(state: PersonalMcpConnectionCheck['state'], connectionId: string | null = null): PersonalMcpConnectionCheck {
  return { check_id: 'check-1', connection_id: connectionId, configuration_revision: 1, state,
    error_code: null, discovered_tools: state === 'succeeded' ? 0 : null, started_at: null, finished_at: null }
}

/** Port substitute: these tests exercise the migrated UI, without claiming backend integration. */
function fixture(initial: readonly PersonalMcpConnection[] = [connection(), connection(2)]) {
  let items = initial
  const port = {
    list: vi.fn<PersonalMcpConnectionPort['list']>(async () => ({ items })),
    create: vi.fn<PersonalMcpConnectionPort['create']>(async input => {
      const created = { ...connection(3), display_name: input.display_name, server_url: input.server_url,
        enabled: input.enabled }
      items = [...items, created]
      return created
    }),
    update: vi.fn<PersonalMcpConnectionPort['update']>(async (id, input) => {
      const current = items.find(item => item.connection_id === id)
      if (current === undefined) throw new Error('Fixture connection is absent')
      const updated = { ...current, revision: current.revision + 1, display_name: input.display_name,
        server_url: input.server_url, enabled: input.enabled }
      items = items.map(item => item.connection_id === id ? updated : item)
      return updated
    }),
    toggle: vi.fn<PersonalMcpConnectionPort['toggle']>(async (id, _revision, enabled) => {
      const current = items.find(item => item.connection_id === id)
      if (current === undefined) throw new Error('Fixture connection is absent')
      const updated = { ...current, revision: current.revision + 1, enabled }
      items = items.map(item => item.connection_id === id ? updated : item)
      return updated
    }),
    remove: vi.fn<PersonalMcpConnectionPort['remove']>(async id => {
      items = items.filter(item => item.connection_id !== id)
    }),
    createCheck: vi.fn<PersonalMcpConnectionPort['createCheck']>(async id => check('queued', id)),
    getCheck: vi.fn<PersonalMcpConnectionPort['getCheck']>(async id => check('succeeded', id)),
    cancelCheck: vi.fn<PersonalMcpConnectionPort['cancelCheck']>(async id => check('canceled', id)),
    createDraftCheck: vi.fn<PersonalMcpConnectionPort['createDraftCheck']>(async () => check('queued')),
    getDraftCheck: vi.fn<PersonalMcpConnectionPort['getDraftCheck']>(async () => check('succeeded')),
    cancelDraftCheck: vi.fn<PersonalMcpConnectionPort['cancelDraftCheck']>(async () => check('canceled')),
  } satisfies PersonalMcpConnectionPort
  return port
}

async function openCreate(port = fixture([])) {
  render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
  await screen.findByText('This account has no MCP connections')
  fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Draft MCP' } })
  fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://draft.example.test/mcp' } })
  return port
}

describe('Migrated personal MCP page with an explicit Port substitute', () => {
  it('keeps the original multi-connection layout and searches actual metadata', async () => {
    const port = fixture()
    const view = render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    await screen.findByRole('button', { name: 'View MCP connection Knowledge' })
    expect(screen.getByRole('button', { name: 'View MCP connection Database' })).toBeTruthy()
    expect(view.container.querySelector('[data-power-evolve-mcp-page]')).toMatchSnapshot()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'MCP2.EXAMPLE' } })
    expect(screen.queryByRole('button', { name: 'View MCP connection Knowledge' })).toBeNull()
    expect(screen.getByRole('button', { name: 'View MCP connection Database' })).toBeTruthy()
    expect(port.create).not.toHaveBeenCalled()
  })

  it('creates, edits, toggles and deletes through the Port with revisions and request IDs', async () => {
    const port = await openCreate()
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await screen.findByRole('button', { name: 'View MCP connection Draft MCP' })
    expect(port.create.mock.calls[0]?.[0]).toMatchObject({ authentication: { kind: 'none' }, enabled: false })
    expect(port.create.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/u)
    fireEvent.click(screen.getByRole('button', { name: 'View MCP connection Draft MCP' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Updated MCP' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await screen.findByRole('heading', { name: 'Updated MCP' })
    expect(port.update.mock.calls[0]?.[1].expected_revision).toBe(1)
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(port.toggle).toHaveBeenCalledTimes(1))
    expect(port.toggle.mock.calls[0]?.slice(1, 3)).toEqual([2, true])
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    await screen.findByText('This account has no MCP connections')
    expect(port.remove.mock.calls[0]?.[1]).toBe(3)
    expect(port.remove.mock.calls[0]?.[2]).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('freezes an uncertain create and explicitly retries the same input and request ID', async () => {
    const port = fixture([])
    port.create.mockRejectedValueOnce(new Error('response lost with secret data'))
    await openCreate(port)
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await screen.findAllByText(en.personalMcpMutationUncertain)
    expect(screen.queryByText(/secret data/u)).toBeNull()
    expect(screen.getByLabelText('Display name').closest('fieldset')?.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry this change' }))
    await screen.findByRole('button', { name: 'View MCP connection Draft MCP' })
    expect(port.create.mock.calls[0]).toEqual(port.create.mock.calls[1])
    expect(port.create).toHaveBeenCalledTimes(2)
  })

  it('allows editing after a definite revision conflict without retrying automatically', async () => {
    const port = fixture()
    port.update.mockRejectedValueOnce(new PersonalMcpConnectionRequestError(409, 'mcpRevisionConflict'))
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: 'View MCP connection Knowledge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await screen.findAllByText(en.mcpRevisionConflict)
    expect(screen.getByLabelText('Display name').closest('fieldset')?.disabled).toBe(false)
    expect(port.update).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Retry this change' })).toBeNull()
  })

  it('never fills saved credential values and lets edits retain, replace or clear bearer values', async () => {
    const current: PersonalMcpConnection = { ...connection(), authentication: { kind: 'bearer', secret_configured: true } }
    const port = fixture([current])
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: 'View MCP connection Knowledge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }))
    const bearer = screen.getByLabelText('Bearer token (write only)')
    expect(bearer.getAttribute('value')).toBe('')
    expect(bearer.getAttribute('placeholder')).toBe('Leave blank to preserve the saved secret')
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(port.update.mock.calls[0]?.[1]).not.toHaveProperty('secrets')
    fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }))
    fireEvent.change(screen.getByLabelText('Bearer token (write only)'), { target: { value: 'replacement-fixture-only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(port.update.mock.calls[1]?.[1].secrets?.bearer_token).toBe('replacement-fixture-only')
    fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }))
    fireEvent.click(screen.getByText('Stored securely and never displayed here'))
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(port.update.mock.calls[2]?.[1].clear_secret_keys).toEqual(['bearer_token'])
  })

  it('checks the saved connection through saved-check operations and restores zero-tool success', async () => {
    const port = fixture()
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: 'View MCP connection Knowledge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Waiting for a connection check')
    await screen.findByText('Check succeeded; the service validly returned 0 tools', {}, { timeout: 3000 })
    expect(port.createCheck.mock.calls[0]?.[1]).toMatchObject({ session_id: 'session-1', expected_revision: 1 })
    expect(port.createDraftCheck).not.toHaveBeenCalled()
    expect(port.getCheck).toHaveBeenCalledTimes(1)
  })

  it('resumes the saved-check poll after an explicit refresh following a status failure', async () => {
    const saved = { ...connection(), latest_check: check('running', connection().connection_id) }
    const port = fixture([saved])
    port.getCheck.mockRejectedValueOnce(new Error('fixture status loss'))
      .mockResolvedValueOnce(check('succeeded', saved.connection_id))
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    const open = await screen.findByRole('button', { name: 'View MCP connection Knowledge' })
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(open) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(port.getCheck).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.mcpRefreshCheck })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(port.getCheck).toHaveBeenCalledTimes(2)
    expect(screen.getByText(en.mcpCheckSucceededZero)).toBeTruthy()
    expect(port.createCheck).not.toHaveBeenCalled()
  })

  it('invalidates a late draft check after the form changes without saving a connection', async () => {
    const port = fixture([])
    let resolve!: (value: PersonalMcpConnectionCheck) => void
    port.createDraftCheck.mockImplementationOnce(() => new Promise(land => { resolve = land }))
    await openCreate(port)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(port.createDraftCheck).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://edited.example.test/mcp' } })
    await act(async () => { resolve(check('succeeded')) })
    expect(screen.queryByText('Check succeeded; the service validly returned 0 tools')).toBeNull()
    port.createDraftCheck.mockResolvedValueOnce(check('succeeded'))
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Check succeeded; the service validly returned 0 tools')
    expect(port.createDraftCheck.mock.calls[0]?.[0].configuration.server_url).toBe('https://draft.example.test/mcp')
    expect(port.createDraftCheck.mock.calls[1]?.[0].configuration.server_url).toBe('https://edited.example.test/mcp')
    expect(port.createDraftCheck.mock.calls[0]?.[1]).not.toBe(port.createDraftCheck.mock.calls[1]?.[1])
    expect(port.create).not.toHaveBeenCalled()
  })

  it('does not overwrite canceled draft state with a late in-flight poll', async () => {
    const port = await openCreate()
    let resolve!: (value: PersonalMcpConnectionCheck) => void
    port.getDraftCheck.mockImplementationOnce(() => new Promise(land => { resolve = land }))
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test connection' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(port.getDraftCheck).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel check' })) })
    await act(async () => { resolve(check('succeeded')) })
    expect(screen.getByText('Check canceled')).toBeTruthy()
    expect(screen.queryByText('Check succeeded; the service validly returned 0 tools')).toBeNull()
    expect(port.getDraftCheck.mock.calls[0]?.[1]?.aborted).toBe(true)
    expect(port.cancelDraftCheck.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('offers a stable explicit retry for an uncertain draft submission', async () => {
    const port = fixture([])
    port.createDraftCheck.mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce(check('succeeded'))
    await openCreate(port)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(en.personalMcpCheckUncertain)
    fireEvent.click(screen.getByRole('button', { name: 'Retry this request' }))
    await screen.findByText('Check succeeded; the service validly returned 0 tools')
    expect(port.createDraftCheck.mock.calls[0]).toEqual(port.createDraftCheck.mock.calls[1])
    expect(port.create).not.toHaveBeenCalled()
  })

  it('keeps custom-header input inside the original scrolling dialog structure', async () => {
    await openCreate()
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'headers' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }))
    const dialog = screen.getByRole('dialog', { name: 'Create connection' })
    expect(dialog.className).toContain('pext-connection-modal')
    expect(dialog.querySelector('.pext-connection-modal-content')).not.toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Header name', { exact: true }), { target: { value: 'X-API-Key' } })
    fireEvent.change(within(dialog).getByLabelText('X-API-Key Header value'), { target: { value: 'fixture-only' } })
    expect(dialog.querySelector('.pext-mcp-header-row input[type=password]')).not.toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Save connection' })).toBeTruthy()
  })

  it('requires a real existing Session when the native controller has no current selection', async () => {
    const port = fixture([])
    const snapshot = { ...sessionSnapshot, current: undefined }
    const source: PersonalMcpSessionSource = { list: { getSnapshot: () => snapshot,
      subscribe: () => () => {},
    } }
    render(<PersonalMcpPage personalMcp={port} sessions={source} t={t} />)
    await screen.findByText('This account has no MCP connections')
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Draft MCP' } })
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://draft.example.test/mcp' } })
    expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Session used for check'), { target: { value: 'session-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(port.createDraftCheck).toHaveBeenCalledTimes(1))
    expect(port.createDraftCheck.mock.calls[0]?.[0].session_id).toBe('session-1')
  })

  it('keeps a pending draft pinned when native selection switches, then ignores its result after deletion', async () => {
    type NativeSnapshot = ReturnType<PersonalMcpNativeSessionSource['list']['getSnapshot']>
    let state: NativeSnapshot = { ids: ['session-1', 'session-2'], byId: {
      'session-1': { displayTitle: 'First', retainedBy: { mainView: 1 } },
      'session-2': { displayTitle: 'Second', retainedBy: {} },
    }, phase: 'ready' }
    const listeners = new Set<() => void>()
    const source = personalMcpSessionSource({ list: { getSnapshot: () => state,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } })
    const port = fixture([])
    let resolve!: (value: PersonalMcpConnectionCheck) => void
    port.createDraftCheck.mockImplementationOnce(() => new Promise(land => { resolve = land }))
    const view = render(<PersonalMcpPage personalMcp={port} sessions={source} t={t} />)
    await screen.findByText('This account has no MCP connections')
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Draft MCP' } })
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://draft.example.test/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(port.createDraftCheck).toHaveBeenCalledTimes(1))
    act(() => {
      state = { ...state, byId: { 'session-1': { displayTitle: 'First', retainedBy: {} },
        'session-2': { displayTitle: 'Second', retainedBy: { mainView: 1 } } } }
      listeners.forEach(listener => listener())
    })
    expect(screen.getByLabelText('Session used for check')).toHaveProperty('value', 'session-1')
    expect(port.createDraftCheck.mock.calls[0]?.[0].session_id).toBe('session-1')
    act(() => {
      state = { ids: ['session-2'], byId: { 'session-2': { displayTitle: 'Second', retainedBy: { mainView: 1 } } }, phase: 'ready' }
      listeners.forEach(listener => listener())
    })
    expect(screen.getByLabelText('Session used for check')).toHaveProperty('value', 'session-2')
    await act(async () => { resolve(check('succeeded')) })
    expect(screen.queryByText('Check succeeded; the service validly returned 0 tools')).toBeNull()
    port.createDraftCheck.mockResolvedValueOnce({ ...check('succeeded'), check_id: 'check-2' })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Check succeeded; the service validly returned 0 tools')
    expect(port.createDraftCheck.mock.calls[1]?.[0].session_id).toBe('session-2')
    expect(port.createDraftCheck.mock.calls[0]?.[1]).not.toBe(port.createDraftCheck.mock.calls[1]?.[1])
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('keeps refresh available while management is unavailable and blocks configuration writes', async () => {
    const port = fixture([])
    port.list.mockResolvedValue({ available: false, items: [] })
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    await screen.findByText(en.personalMcpUnavailable)
    expect(screen.getByRole('button', { name: 'Add connection' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.refreshList })).toHaveProperty('disabled', false)
    expect(port.create).not.toHaveBeenCalled()
  })
})
