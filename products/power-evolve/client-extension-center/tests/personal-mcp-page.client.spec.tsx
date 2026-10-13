// @vitest-environment jsdom
import { deferredResult } from './deferred-result.ts'
import type {} from '../src/client/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PersonalMcpPage } from '../src/client/PersonalMcpPage.tsx'
import { en, zh } from '../src/client/locales.ts'
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
    revision: 1, configuration_revision: 1, credential_revision: null,
    display_name: index === 1 ? 'Knowledge' : 'Database', server_name: `mcp_${index}`,
    server_url: `https://mcp${index}.example.test/mcp`, authentication: { kind: 'none', secret_configured: false },
    enabled: false, latest_check: null, created_at: '2026-09-30T00:00:00.000Z', updated_at: '2026-09-30T00:00:00.000Z' }
}

function check(state: PersonalMcpConnectionCheck['state'], connectionId: string | null = null): PersonalMcpConnectionCheck {
  return { check_id: 'check-1', connection_id: connectionId, configuration_revision: 1, state,
    error_code: null, discovered_tools: state === 'succeeded' ? 0 : null, started_at: null, finished_at: null }
}

/** Port substitute: these tests exercise the migrated UI, without claiming backend integration. */
function fixture(initial: readonly PersonalMcpConnection[] = [connection(), connection(2)], savedCheckResult?: PersonalMcpConnectionCheck) {
  let items = initial
  const port = {
    list: vi.fn<PersonalMcpConnectionPort['list']>(async () => ({ items })),
    create: vi.fn<PersonalMcpConnectionPort['create']>(async (input) => {
      const created = { ...connection(3), display_name: input.display_name, server_url: input.server_url,
        enabled: input.enabled }
      items = [...items, created]
      return created
    }),
    update: vi.fn<PersonalMcpConnectionPort['update']>(async (id, input) => {
      const current = items.find(item => item.connection_id === id)
      if (current === undefined) throw new Error('Fixture connection is absent')
      const configurationRevision = (current.configuration_revision ?? current.revision) + 1
      const updated = { ...current, revision: current.revision + 1, display_name: input.display_name,
        configuration_revision: configurationRevision,
        credential_revision: current.authentication.secret_configured ? configurationRevision : null,
        server_url: input.server_url, enabled: input.enabled }
      items = items.map(item => item.connection_id === id ? updated : item)
      return { ...updated, latest_check: null }
    }),
    toggle: vi.fn<PersonalMcpConnectionPort['toggle']>(async (id, _revision, enabled) => {
      const current = items.find(item => item.connection_id === id)
      if (current === undefined) throw new Error('Fixture connection is absent')
      const updated = { ...current, revision: current.revision + 1, enabled }
      items = items.map(item => item.connection_id === id ? updated : item)
      return updated
    }),
    remove: vi.fn<PersonalMcpConnectionPort['remove']>(async (id) => {
      items = items.filter(item => item.connection_id !== id)
    }),
    createCheck: vi.fn<PersonalMcpConnectionPort['createCheck']>(async (id) => {
      const result = savedCheckResult ?? check('queued', id)
      items = items.map(item => item.connection_id === id ? { ...item, latest_check: result } : item)
      return result
    }),
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
  it('adds write-only header rows on plain HTTP without crypto.randomUUID', async () => {
    const originalCrypto = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) })
    try {
      const port = await openCreate()
      fireEvent.change(screen.getByLabelText(en.mcpAuthentication), { target: { value: 'headers' } })
      fireEvent.click(screen.getByRole('button', { name: en.mcpAddHeader }))
      expect(screen.getAllByLabelText(en.mcpHeaderName)).toHaveLength(1)
      expect(screen.getAllByLabelText(`${en.mcpHeaderName} ${en.mcpHeaderValue}`)).toHaveLength(1)
      expect(port.create).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('refreshes an empty search result without dropping the saved connection', async () => {
    const port = fixture([connection()])
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` })
    fireEvent.change(screen.getByRole('searchbox', { name: en.personalMcpSearch }), { target: { value: 'absent fixture' } })
    expect(screen.getByText(en.personalMcpNoMatch)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.refreshList }))
    await waitFor(() => { expect(port.list).toHaveBeenCalledTimes(2) })
    fireEvent.change(screen.getByRole('searchbox', { name: en.personalMcpSearch }), { target: { value: '' } })
    await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` })
    expect(port.remove).not.toHaveBeenCalled()
  })

  it('keeps a refused create draft editable and clears an abandoned authentication selection', async () => {
    const port = await openCreate()
    port.create.mockRejectedValueOnce(new PersonalMcpConnectionRequestError(401))
    fireEvent.change(screen.getByLabelText(en.mcpAuthentication), { target: { value: 'bearer' } })
    fireEvent.change(screen.getByLabelText(en.mcpAuthentication), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveMcpConnection }))
    await within(screen.getByRole('dialog')).findByText(en.sessionExpired)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText(en.mcpDisplayName)).toHaveProperty('disabled', false)
    expect(port.create.mock.calls[0]?.[0].authentication.kind).toBe('none')
    expect(port.create).toHaveBeenCalledOnce()
  })

  it('recovers an uncertain edit with the original immutable request', async () => {
    const port = fixture([connection()])
    port.update.mockRejectedValueOnce(new TypeError('edit response lost'))
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` }))
    fireEvent.click(screen.getByRole('button', { name: en.editMcpConnection }))
    fireEvent.change(screen.getByLabelText(en.mcpDisplayName), { target: { value: 'Updated knowledge' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveMcpConnection }))
    await within(screen.getByRole('dialog')).findByText(en.personalMcpMutationUncertain)
    expect(screen.getByLabelText(en.mcpDisplayName).closest('fieldset')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: en.personalMcpRetryMutation }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(port.update.mock.calls[0]).toEqual(port.update.mock.calls[1])
    expect(screen.getByRole('heading', { name: 'Updated knowledge' })).toBeTruthy()
  })

  it.each(['pending', 'ready'] as const)('blocks checks while the native Session list is %s and empty', async (phase) => {
    const port = fixture([])
    const snapshot = { ids: [], byId: {}, current: undefined, phase }
    const source: PersonalMcpSessionSource = { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } }
    render(<PersonalMcpPage personalMcp={port} sessions={source} t={t} />)
    await screen.findByText(en.personalMcpEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.addMcpConnection }))
    expect(screen.getByRole('combobox', { name: en.mcpCheckSession })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.mcpStartCheck })).toHaveProperty('disabled', true)
    if (phase === 'pending') expect(screen.getByRole('option', { name: en.mcpSessionsLoading })).toBeTruthy()
    else expect(screen.getByText(en.mcpNoSession)).toBeTruthy()
    expect(port.createDraftCheck).not.toHaveBeenCalled()
  })

  it('permits a new explicit draft check after a definite refusal without repeating the refused request', async () => {
    const port = await openCreate()
    port.createDraftCheck.mockRejectedValueOnce(new PersonalMcpConnectionRequestError(401))
      .mockResolvedValueOnce({ ...check('succeeded'), discovered_tools: null })
    fireEvent.click(screen.getByRole('button', { name: en.mcpStartCheck }))
    await screen.findByText(en.sessionExpired)
    expect(screen.queryByRole('button', { name: en.mcpRetryCheckRequest })).toBeNull()
    expect(port.createDraftCheck).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: en.mcpStartCheck }))
    await screen.findByText(en.mcpCheckSucceededUnknown)
    expect(port.createDraftCheck.mock.calls[0]?.[0]).toEqual(port.createDraftCheck.mock.calls[1]?.[0])
    expect(port.createDraftCheck.mock.calls[0]?.[1]).not.toBe(port.createDraftCheck.mock.calls[1]?.[1])
  })

  it('ignores a late draft submission refusal after the configuration changes', async () => {
    const port = await openCreate()
    const reply = deferredResult<PersonalMcpConnectionCheck>()
    port.createDraftCheck.mockImplementationOnce(() => reply.promise)
    fireEvent.click(screen.getByRole('button', { name: en.mcpStartCheck }))
    fireEvent.change(screen.getByLabelText(en.mcpServerUrl), { target: { value: 'https://new-draft.example.test/mcp' } })
    await act(async () => { reply.reject(new PersonalMcpConnectionRequestError(401)) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: en.mcpStartCheck })).toHaveProperty('disabled', false)
    expect(port.createDraftCheck).toHaveBeenCalledOnce()
  })

  it('ignores a late draft status refusal after changing the form and aborts the old status read', async () => {
    const port = await openCreate()
    const reply = deferredResult<PersonalMcpConnectionCheck>()
    port.getDraftCheck.mockImplementationOnce(() => reply.promise)
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.mcpStartCheck })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    fireEvent.change(screen.getByLabelText(en.mcpServerUrl), { target: { value: 'https://changed.example.test/mcp' } })
    await act(async () => { reply.reject(new PersonalMcpConnectionRequestError(401)) })
    expect(port.getDraftCheck.mock.calls[0]?.[1]?.aborted).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(en.mcpCheckNever)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.mcpRefreshCheck })).toBeNull()
  })

  it.each(['success', 'refusal'] as const)('ignores a late draft cancellation %s after changing the form', async (outcome) => {
    const port = await openCreate()
    const reply = deferredResult<PersonalMcpConnectionCheck>()
    port.cancelDraftCheck.mockImplementationOnce(() => reply.promise)
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.mcpStartCheck })) })
    fireEvent.click(screen.getByRole('button', { name: en.mcpCancelCheck }))
    fireEvent.change(screen.getByLabelText(en.mcpServerUrl), { target: { value: 'https://changed.example.test/mcp' } })
    await act(async () => {
      if (outcome === 'success') reply.resolve(check('canceled'))
      else reply.reject(new PersonalMcpConnectionRequestError(401))
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(en.mcpCheckNever)).toBeTruthy()
    expect(screen.queryByText(en.mcpCheckCanceled)).toBeNull()
    expect(screen.getByRole('button', { name: en.mcpStartCheck })).toHaveProperty('disabled', false)
  })

  it('admits one draft check and cancellation when duplicate click events arrive in the same batch', async () => {
    const port = await openCreate()
    const startReply = deferredResult<PersonalMcpConnectionCheck>()
    const cancelReply = deferredResult<PersonalMcpConnectionCheck>()
    port.createDraftCheck.mockImplementationOnce(() => startReply.promise)
    port.cancelDraftCheck.mockImplementationOnce(() => cancelReply.promise)
    const start = screen.getByRole('button', { name: en.mcpStartCheck })
    act(() => { start.dispatchEvent(new MouseEvent('click', { bubbles: true })); start.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(port.createDraftCheck).toHaveBeenCalledOnce()
    vi.useFakeTimers()
    await act(async () => { startReply.resolve(check('queued')) })
    const cancel = screen.getByRole('button', { name: en.mcpCancelCheck })
    act(() => { cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })); cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(port.cancelDraftCheck).toHaveBeenCalledOnce()
    await act(async () => { cancelReply.resolve(check('canceled')) })
    expect(screen.getByText(en.mcpCheckCanceled)).toBeTruthy()
  })

  it('returns from details and closes abandoned create and edit dialogs without saving', async () => {
    const port = fixture([connection()])
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` }))
    fireEvent.click(screen.getByRole('button', { name: en.editMcpConnection }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.deleteMcpConnection }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.queryByText(en.mcpDeleteWarning)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.backToMcpConnections }))
    fireEvent.click(screen.getByRole('button', { name: en.addMcpConnection }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(port.create).not.toHaveBeenCalled()
    expect(port.update).not.toHaveBeenCalled()
    expect(port.remove).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: `${en.openMcpConnection} Knowledge` })).toBeTruthy()
  })

  it.each(['list', 'details'] as const)('recovers an uncertain toggle from the %s view using the original request', async (location) => {
    const port = fixture([connection()])
    port.toggle.mockRejectedValueOnce(new TypeError('toggle reply lost'))
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    const row = await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` })
    if (location === 'details') fireEvent.click(row)
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByText(en.personalMcpMutationUncertain)
    fireEvent.click(screen.getByRole('button', { name: en.personalMcpRetryMutation }))
    await waitFor(() => { expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true') })
    expect(port.toggle).toHaveBeenCalledTimes(2)
    expect(port.toggle.mock.calls[1]).toEqual(port.toggle.mock.calls[0])
    expect(screen.queryByText(en.personalMcpMutationUncertain)).toBeNull()
  })

  it('keeps the selected connection after deletion is refused', async () => {
    const port = fixture([connection()])
    port.remove.mockRejectedValueOnce(new PersonalMcpConnectionRequestError(401))
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` }))
    fireEvent.click(screen.getByRole('button', { name: en.deleteMcpConnection }))
    fireEvent.click(screen.getByRole('button', { name: en.confirmDeleteMcpConnection }))
    await screen.findByText(en.sessionExpired)
    expect(screen.getByRole('button', { name: en.backToMcpConnections })).toBeTruthy()
    expect(screen.getByText(en.mcpDeleteWarning)).toBeTruthy()
    expect(port.remove).toHaveBeenCalledOnce()
  })

  it('edits two saved header rows without displaying their secrets and removes an unwanted row', async () => {
    const saved: PersonalMcpConnection = { ...connection(), authentication: { kind: 'headers', secret_configured: true },
      headers: [{ name: 'X-First', value_configured: true }, { name: 'X-Second', value_configured: true }] }
    const port = fixture([saved])
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` }))
    expect(screen.getByText(en.mcpAuthenticationHeaders)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.editMcpConnection }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByLabelText(`X-First ${en.mcpHeaderValue}`).getAttribute('value')).toBe('')
    const firstHeader = dialog.getAllByLabelText(en.mcpHeaderName, { exact: true })[0]
    if (firstHeader === undefined) throw new Error('The first saved header row is absent')
    fireEvent.change(firstHeader, { target: { value: 'X-Renamed' } })
    fireEvent.change(dialog.getByLabelText(`X-Renamed ${en.mcpHeaderValue}`), { target: { value: 'replacement-fixture' } })
    fireEvent.click(dialog.getByRole('button', { name: `${en.mcpRemoveHeader} X-Second` }))
    fireEvent.click(dialog.getByRole('button', { name: en.saveMcpConnection }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(port.update.mock.calls[0]?.[1].headers).toEqual([{ name: 'X-Renamed', value: 'replacement-fixture' }])
  })

  it.each(['name', 'url', 'bearer', 'header-name', 'header-value', 'header-duplicate'] as const)(
    'shows a localized %s validation error before submitting a connection', async (invalidField) => {
      const port = await openCreate()
      let error: string
      if (invalidField === 'name') {
        fireEvent.change(screen.getByLabelText(en.mcpDisplayName), { target: { value: '' } })
        error = en.mcpNameInvalid
      } else if (invalidField === 'url') {
        fireEvent.change(screen.getByLabelText(en.mcpServerUrl), { target: { value: 'file:///mcp' } })
        error = en.mcpUrlInvalid
      } else if (invalidField === 'bearer') {
        fireEvent.change(screen.getByLabelText(en.mcpAuthentication), { target: { value: 'bearer' } })
        fireEvent.click(screen.getByLabelText(en.mcpEnabledOnCreate))
        error = en.mcpBearerInvalid
      } else {
        fireEvent.change(screen.getByLabelText(en.mcpAuthentication), { target: { value: 'headers' } })
        fireEvent.click(screen.getByRole('button', { name: en.mcpAddHeader }))
        fireEvent.change(screen.getByLabelText(en.mcpHeaderName, { exact: true }),
          { target: { value: invalidField === 'header-name' ? 'invalid name' : 'X-Key' } })
        if (invalidField !== 'header-value') {
          fireEvent.change(screen.getByLabelText(`${invalidField === 'header-name' ? 'invalid name' : 'X-Key'} ${en.mcpHeaderValue}`),
            { target: { value: 'fixture-value' } })
        }
        if (invalidField === 'header-duplicate') {
          fireEvent.click(screen.getByRole('button', { name: en.mcpAddHeader }))
          const secondHeader = screen.getAllByLabelText(en.mcpHeaderName, { exact: true })[1]
          if (secondHeader === undefined) throw new Error('The second entered header row is absent')
          fireEvent.change(secondHeader, { target: { value: 'x-key' } })
          fireEvent.change(screen.getByLabelText(`x-key ${en.mcpHeaderValue}`), { target: { value: 'another-fixture' } })
        }
        error = invalidField === 'header-name' ? en.mcpHeaderNameInvalid
          : invalidField === 'header-value' ? en.mcpHeaderValueInvalid : en.mcpHeaderDuplicate
      }
      fireEvent.click(screen.getByRole('button', { name: en.saveMcpConnection }))
      expect(screen.getByRole('alert').textContent).toBe(error)
      expect(port.create).not.toHaveBeenCalled()
      expect(port.createDraftCheck).not.toHaveBeenCalled()
    },
  )

  it.each([['English', en], ['Chinese', zh]] as const)('limits saved-check cancellation progress to pending states in %s', async (_language, dictionary) => {
    const states = [
      ['queued', 'mcpCheckQueued'], ['running', 'mcpCheckRunning'],
      ['canceled', 'mcpCheckCanceled'], ['failed', 'personalMcpCheckFailed'],
      ['succeeded', 'mcpCheckSucceededZero'], ['timed_out', 'mcpCheckTimedOut'], ['expired', 'mcpCheckExpired'],
    ] as const
    const translate = (key: keyof typeof en): string => dictionary[key]
    for (const [state, label] of states) for (const cancelRequested of [false, true]) {
      const saved = { ...connection(), latest_check: { ...check(state, connection().connection_id),
        cancel_requested: cancelRequested } }
      const port = fixture([saved])
      const view = render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={translate} />)
      fireEvent.click(await screen.findByRole('button', { name: `${dictionary.openMcpConnection} Knowledge` }))
      const pending = state === 'queued' || state === 'running'
      expect(view.container.querySelector('.pext-mcp-check-result strong')?.textContent).toBe(dictionary[label])
      expect(screen.queryByText(dictionary.mcpCancelingCheck) !== null).toBe(pending && cancelRequested)
      expect(screen.queryByRole('button', { name: dictionary.mcpCancelCheck }) !== null).toBe(pending)
      expect(port.cancelCheck).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it.each([['English', en], ['Chinese', zh]] as const)('separates an old saved success from the edited configuration in %s', async (_language, dictionary) => {
    const saved: PersonalMcpConnection = { ...connection(), enabled: true, credential_revision: 1,
      authentication: { kind: 'bearer', secret_configured: true },
      latest_check: { ...check('succeeded', connection().connection_id), credential_revision: 1, discovered_tools: 2 } }
    const port = fixture([saved], { ...check('succeeded', saved.connection_id), check_id: 'check-2',
      configuration_revision: 2, credential_revision: 2, discovered_tools: 2 })
    port.createDraftCheck.mockResolvedValueOnce({ ...check('succeeded'), credential_revision: 1, discovered_tools: 2 })
    const translate = (key: keyof typeof en): string => dictionary[key]
    const view = render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={translate} />)
    fireEvent.click(await screen.findByRole('button', { name: `${dictionary.openMcpConnection} Knowledge` }))
    const success = dictionary.personalMcpCheckSucceeded.replace('{count}', '2')
    expect(screen.getByText(success)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: dictionary.editMcpConnection }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.change(dialog.getByLabelText(dictionary.mcpDisplayName), { target: { value: 'Knowledge v2' } })
    expect(dialog.getByLabelText(dictionary.mcpBearerToken).getAttribute('value')).toBe('')
    fireEvent.click(dialog.getByRole('button', { name: dictionary.mcpStartCheck }))
    await dialog.findByText(success)
    expect(port.createCheck).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: dictionary.saveMcpConnection }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.getByRole('heading', { name: 'Knowledge v2' })).toBeTruthy()
    expect(port.update.mock.calls[0]?.[1]).not.toHaveProperty('secrets')
    expect(screen.getByText(dictionary.mcpCheckCurrentNotChecked)).toBeTruthy()
    expect(screen.getByText(dictionary.mcpCheckPreviousResult.replace('{result}', success))).toBeTruthy()
    expect(screen.queryByText(success)).toBeNull()
    expect(view.container.querySelector('.pext-mcp-check-result')).toMatchSnapshot()
    fireEvent.click(screen.getByRole('button', { name: dictionary.mcpStartCheck }))
    await screen.findByText(success)
    expect(port.createCheck.mock.calls[0]?.[1].expected_revision).toBe(2)
    expect(screen.queryByText(dictionary.mcpCheckCurrentNotChecked)).toBeNull()
    expect(view.container.querySelector('.pext-mcp-check-result')?.getAttribute('data-state')).toBe('succeeded')
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => { expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false') })
    expect(screen.getByText(`mcp_1 · ${dictionary.mcpRevision} 3`)).toBeTruthy()
    expect(screen.getByText(success)).toBeTruthy()
    expect(screen.queryByText(dictionary.mcpCheckCurrentNotChecked)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: dictionary.backToMcpConnections }))
    expect(screen.getByText(`mcp_1 · ${dictionary.mcpRevision} 3`)).toBeTruthy()
  })

  it('compares an edit draft to its form instead of the saved configuration version', async () => {
    const saved = { ...connection(), revision: 3, configuration_revision: 2, credential_revision: null }
    const port = fixture([saved])
    port.createDraftCheck.mockResolvedValueOnce(check('succeeded'))
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` }))
    fireEvent.click(screen.getByRole('button', { name: en.editMcpConnection }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: en.mcpStartCheck }))
    await dialog.findByText(en.mcpCheckSucceededZero)
    expect(dialog.queryByText(en.mcpCheckCurrentNotChecked)).toBeNull()
    expect(dialog.queryByText(en.mcpCheckStale)).toBeNull()
    expect(port.update).not.toHaveBeenCalled()
  })

  it.each([['English', en], ['Chinese', zh]] as const)('renders a saved unsupported-schema check in %s', async (_language, dictionary) => {
    const saved = { ...connection(), latest_check: { ...check('failed', connection().connection_id),
      error_code: 'MCP_SCHEMA_UNSUPPORTED' as const } }
    const port = fixture([saved])
    const translate = (key: keyof typeof en): string => dictionary[key]
    const view = render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={translate} />)
    fireEvent.click(await screen.findByRole('button', { name: `${dictionary.openMcpConnection} Knowledge` }))
    expect(screen.getByText(dictionary.mcpCheckErrorSchemaUnsupported)).toBeTruthy()
    expect(screen.queryByText(dictionary.mcpCheckErrorGeneric)).toBeNull()
    expect(view.container.querySelector('.pext-mcp-check-result')).toMatchSnapshot()
    expect(port.createCheck).not.toHaveBeenCalled()
  })

  it.each([['English', en], ['Chinese', zh]] as const)('renders a draft requiring unsupported MCP Tasks in %s', async (_language, dictionary) => {
    const port = fixture([])
    port.createDraftCheck.mockResolvedValueOnce({ ...check('failed'), error_code: 'MCP_TASKS_UNSUPPORTED' })
    const translate = (key: keyof typeof en): string => dictionary[key]
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={translate} />)
    await screen.findByText(dictionary.personalMcpEmpty)
    fireEvent.click(screen.getByRole('button', { name: dictionary.addMcpConnection }))
    fireEvent.change(screen.getByLabelText(dictionary.mcpDisplayName), { target: { value: 'Draft MCP' } })
    fireEvent.change(screen.getByLabelText(dictionary.mcpServerUrl), { target: { value: 'https://draft.example.test/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: dictionary.mcpStartCheck }))
    await screen.findByText(dictionary.mcpCheckErrorTasksUnsupported)
    expect(screen.queryByText(dictionary.mcpCheckErrorGeneric)).toBeNull()
    expect(port.create).not.toHaveBeenCalled()
  })

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
    await waitFor(() => { expect(port.toggle).toHaveBeenCalledTimes(1) })
    expect(port.toggle.mock.calls[0]?.slice(1, 3)).toEqual([2, true])
    await waitFor(() => { expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true') })
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
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(port.update.mock.calls[0]?.[1]).not.toHaveProperty('secrets')
    fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }))
    fireEvent.change(screen.getByLabelText('Bearer token (write only)'), { target: { value: 'replacement-fixture-only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(port.update.mock.calls[1]?.[1].secrets?.bearer_token).toBe('replacement-fixture-only')
    fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }))
    fireEvent.click(screen.getByText('Stored securely and never displayed here'))
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
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

  it.each(['canceled', 'failed', 'succeeded'] as const)('clears saved-check cancellation progress when polling reports %s', async (state) => {
    const saved = { ...connection(), latest_check: check('running', connection().connection_id) }
    const port = fixture([saved])
    port.cancelCheck.mockResolvedValueOnce({ ...check('running', saved.connection_id), cancel_requested: true })
    port.getCheck.mockResolvedValueOnce({ ...check(state, saved.connection_id), cancel_requested: true })
    const view = render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    const open = await screen.findByRole('button', { name: 'View MCP connection Knowledge' })
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(open) })
    expect(screen.queryByText(en.mcpCancelingCheck)).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.mcpCancelCheck })) })
    expect(screen.getByText(en.mcpCancelingCheck)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const label = state === 'canceled' ? en.mcpCheckCanceled
      : state === 'failed' ? en.personalMcpCheckFailed : en.mcpCheckSucceededZero
    expect(view.container.querySelector('.pext-mcp-check-result strong')?.textContent).toBe(label)
    expect(screen.queryByText(en.mcpCancelingCheck)).toBeNull()
    expect(screen.queryByRole('button', { name: en.mcpCancelCheck })).toBeNull()
    expect(port.list).toHaveBeenCalledTimes(1)
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
    port.createDraftCheck.mockImplementationOnce(() => new Promise((land) => { resolve = land }))
    await openCreate(port)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => { expect(port.createDraftCheck).toHaveBeenCalledTimes(1) })
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
    port.cancelDraftCheck.mockResolvedValueOnce({ ...check('canceled'), cancel_requested: true })
    let resolve!: (value: PersonalMcpConnectionCheck) => void
    port.getDraftCheck.mockImplementationOnce(() => new Promise((land) => { resolve = land }))
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test connection' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(port.getDraftCheck).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel check' })) })
    await act(async () => { resolve(check('succeeded')) })
    expect(screen.getByText('Check canceled')).toBeTruthy()
    expect(screen.queryByText(en.mcpCancelingCheck)).toBeNull()
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
    await waitFor(() => { expect(port.createDraftCheck).toHaveBeenCalledTimes(1) })
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
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } })
    const port = fixture([])
    let resolve!: (value: PersonalMcpConnectionCheck) => void
    port.createDraftCheck.mockImplementationOnce(() => new Promise((land) => { resolve = land }))
    const view = render(<PersonalMcpPage personalMcp={port} sessions={source} t={t} />)
    await screen.findByText('This account has no MCP connections')
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Draft MCP' } })
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://draft.example.test/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => { expect(port.createDraftCheck).toHaveBeenCalledTimes(1) })
    act(() => {
      state = { ...state, byId: { 'session-1': { displayTitle: 'First', retainedBy: {} },
        'session-2': { displayTitle: 'Second', retainedBy: { mainView: 1 } } } }
      listeners.forEach((listener) => { listener() })
    })
    expect(screen.getByLabelText('Session used for check')).toHaveProperty('value', 'session-1')
    expect(port.createDraftCheck.mock.calls[0]?.[0].session_id).toBe('session-1')
    act(() => {
      state = { ids: ['session-2'], byId: { 'session-2': { displayTitle: 'Second', retainedBy: { mainView: 1 } } }, phase: 'ready' }
      listeners.forEach((listener) => { listener() })
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

  it('loads a cursor page once and rejects repeated connection identities before a corrected explicit retry', async () => {
    const port = fixture([connection()])
    port.list.mockResolvedValueOnce({ items: [connection()], nextCursor: 'next-page' })
      .mockResolvedValueOnce({ items: [connection()] }).mockResolvedValueOnce({ items: [connection(2)] })
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` })
    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    await screen.findByText(en.mcpLoadFailed)
    expect(screen.getAllByRole('button', { name: `${en.openMcpConnection} Knowledge` })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    await screen.findByRole('button', { name: `${en.openMcpConnection} Database` })
    expect(port.list.mock.calls.slice(1).map(([query]) => query)).toEqual([
      { limit: 50, cursor: 'next-page' }, { limit: 50, cursor: 'next-page' },
    ])
    expect(screen.queryByRole('button', { name: en.loadMore })).toBeNull()
    expect(port.create).not.toHaveBeenCalled()
  })

  it('retains the current page after a cursor network failure and appends the subsequent complete page', async () => {
    const port = fixture([connection()])
    port.list.mockResolvedValueOnce({ items: [connection()], nextCursor: 'next-page' })
      .mockRejectedValueOnce(new TypeError('lost list response')).mockResolvedValueOnce({ items: [connection(2)] })
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` })
    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    await screen.findByText(en.mcpLoadFailed)
    expect(screen.getByRole('button', { name: `${en.openMcpConnection} Knowledge` })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    await screen.findByRole('button', { name: `${en.openMcpConnection} Database` })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['success', 'failure'] as const)('discards a late cursor %s after the account Port changes', async (outcome) => {
    const pending = deferredResult<Awaited<ReturnType<PersonalMcpConnectionPort['list']>>>()
    let signal: AbortSignal | undefined
    const old = fixture([connection()])
    old.list.mockResolvedValueOnce({ items: [connection()], nextCursor: 'next-page' })
      .mockImplementationOnce(async (_query, current) => { signal = current; return pending.promise })
    const page = render(<PersonalMcpPage personalMcp={old} sessions={sessions} t={t} />)
    await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` })
    fireEvent.click(screen.getByRole('button', { name: en.loadMore }))
    const replacement = { ...connection(3), display_name: 'Other account' }
    const next = fixture([replacement])
    page.rerender(<PersonalMcpPage personalMcp={next} sessions={sessions} t={t} />)
    await screen.findByRole('button', { name: `${en.openMcpConnection} Other account` })
    expect(signal?.aborted).toBe(true)
    await act(async () => { if (outcome === 'success') pending.resolve({ items: [connection(2)] }); else pending.reject(new PersonalMcpConnectionRequestError(401, 'sessionExpired')) })
    expect(screen.queryByRole('button', { name: `${en.openMcpConnection} Database` })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('pauses a failed draft poll until explicit refresh without creating a second check', async () => {
    const port = await openCreate()
    port.getDraftCheck.mockRejectedValueOnce(new TypeError('status response lost')).mockResolvedValueOnce(check('succeeded'))
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.mcpStartCheck })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText(en.mcpLoadFailed)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(port.getDraftCheck).toHaveBeenCalledOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.mcpRefreshCheck })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText(en.mcpCheckSucceededZero)).toBeTruthy()
    expect(port.getDraftCheck).toHaveBeenCalledTimes(2)
    expect(port.createDraftCheck).toHaveBeenCalledOnce()
  })

  it('retries a refused draft cancellation with its original check and request identity', async () => {
    const port = await openCreate()
    port.cancelDraftCheck.mockRejectedValueOnce(new TypeError('cancel response lost')).mockResolvedValueOnce(check('canceled'))
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.mcpStartCheck })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.mcpCancelCheck })) })
    expect(screen.getByText(en.mcpLoadFailed)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.mcpCancelCheck })) })
    expect(screen.getByText(en.mcpCheckCanceled)).toBeTruthy()
    expect(port.cancelDraftCheck.mock.calls[0]).toEqual(port.cancelDraftCheck.mock.calls[1])
    expect(port.createDraftCheck).toHaveBeenCalledOnce()
  })

  it.each(['success', 'definitive-refusal'] as const)('recovers an uncertain saved check through its original request before %s', async (outcome) => {
    const port = fixture([connection()])
    port.createCheck.mockRejectedValueOnce(new TypeError('admission response lost'))
    if (outcome === 'success') port.createCheck.mockResolvedValueOnce(check('succeeded', connection().connection_id))
    else port.createCheck.mockRejectedValueOnce(new PersonalMcpConnectionRequestError(409, 'mcpRevisionConflict'))
    render(<PersonalMcpPage personalMcp={port} sessions={sessions} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: `${en.openMcpConnection} Knowledge` }))
    fireEvent.click(screen.getByRole('button', { name: en.mcpStartCheck }))
    const retry = await screen.findByRole('button', { name: en.mcpRetryCheckRequest })
    expect(screen.getByRole('combobox', { name: en.mcpCheckSession })).toHaveProperty('disabled', true)
    fireEvent.click(retry)
    await screen.findByText(outcome === 'success' ? en.mcpCheckSucceededZero : en.mcpRevisionConflict)
    expect(port.createCheck.mock.calls[0]).toEqual(port.createCheck.mock.calls[1])
    expect(screen.queryByRole('button', { name: en.mcpRetryCheckRequest })).toBeNull()
    expect(screen.getByRole('combobox', { name: en.mcpCheckSession })).toHaveProperty('disabled', false)
  })
})
