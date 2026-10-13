// @vitest-environment jsdom
import { deferredResult } from './deferred-result.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AccountManagementSection, type AccountManagementProps } from '../src/trusted/AccountManagementSection.tsx'
import { AccountActionError, type AccountMutationIntent, type ManagedAccountView } from '../src/trusted/view.ts'
import { en } from '../src/client/locales.ts'

const account: ManagedAccountView = { userId: '54f0f232-a068-4223-96e8-d0cff78d0f1c', username: 'alice',
  displayName: 'Alice', role: 'user', enabled: true, revision: 7, passwordChangeRequired: false, createdAt: '2026-10-01T00:00:00Z' }
const model = { id: 'model', label: 'Model', maxTokens: 8192 }
const t: AccountManagementProps['t'] = key => en[key]
function props(overrides: Partial<AccountManagementProps> = {}): AccountManagementProps {
  return { currentUserId: 'admin', displayName: 'Administrator', models: [model],
    list: vi.fn(async () => ({ items: [account], nextCursor: null })),
    mutate: vi.fn(async () => ({ account })), lookup: vi.fn(async () => null),
    onPermissionLost: vi.fn(), t, ...overrides }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('creates using the Platform initial settings and captures the granted model ceiling', async () => {
  const mutate = vi.fn(async (_intent: AccountMutationIntent) => ({ account }))
  render(<AccountManagementSection {...props({ mutate, models: [model, { id: 'second', label: 'Second', maxTokens: 4096 }],
    initialSettings: { model: 'second', maxTokens: 1024 } })} />)
  await screen.findByText('Alice')
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'new-user' } })
  fireEvent.change(screen.getByLabelText(en.displayName), { target: { value: 'New user' } })
  fireEvent.click(screen.getByRole('button', { name: en.add }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ kind: 'create', draft: { username: 'new-user',
    model: 'second', maxTokens: 1024, modelGrants: [{ id: 'second', maxTokens: 4096 }] } })
})

it('retains a reset request and its shown revision through receipt lookup and a retry', async () => {
  const mutate = vi.fn(async (_intent: AccountMutationIntent) => { throw new Error('connection lost') })
  const lookup = vi.fn(async () => null)
  render(<AccountManagementSection {...props({ mutate, lookup })} />)
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await screen.findByText(en.managementUncertain)
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ kind: 'reset', account: { revision: 7 } })
  fireEvent.click(screen.getByRole('button', { name: en.checkReceipt }))
  await screen.findByText(en.requestNotRecorded)
  fireEvent.click(screen.getByRole('button', { name: en.retryManagement }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
  expect(mutate.mock.calls[1]?.[0]).toBe(mutate.mock.calls[0]?.[0])
  expect(lookup).toHaveBeenCalledWith(mutate.mock.calls[0]?.[0], expect.any(AbortSignal))
})

it('shows a temporary password once and keeps a successful reset separate from a failed refresh', async () => {
  const list = vi.fn().mockResolvedValueOnce({ items: [account], nextCursor: null }).mockRejectedValue(new Error('offline'))
  const mutate = vi.fn(async () => ({ account, temporaryPassword: 'one-time-secret' }))
  render(<AccountManagementSection {...props({ list, mutate })} />)
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await screen.findByText('one-time-secret')
  await screen.findByText(en.managementLoadFailed)
  expect(screen.queryByRole('button', { name: en.checkReceipt })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.closeTemporary }))
  expect(screen.queryByText('one-time-secret')).toBeNull()
  expect(mutate).toHaveBeenCalledOnce()
})

it.each(['receipt', 'retry'])('reports an acknowledged reset through %s without retrieving a lost temporary password', async (recovery) => {
  const mutate = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ account })
  const lookup = vi.fn(async () => recovery === 'receipt' ? { account } : null)
  render(<AccountManagementSection {...props({ mutate, lookup })} />)
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await screen.findByText(en.managementUncertain)
  fireEvent.click(screen.getByRole('button', { name: en.checkReceipt }))
  if (recovery === 'retry') {
    await screen.findByText(en.requestNotRecorded)
    fireEvent.click(screen.getByRole('button', { name: en.retryManagement }))
  }
  await screen.findByText(en.temporaryUnavailable)
  expect(mutate).toHaveBeenCalledTimes(recovery === 'receipt' ? 1 : 2)
  expect(screen.queryByText(en.temporaryTitle)).toBeNull()
})

it('reloads a conflicting account and uses its new revision only for a new gesture', async () => {
  const updated = { ...account, revision: 8, displayName: 'Updated' }
  const list = vi.fn().mockResolvedValueOnce({ items: [account], nextCursor: null })
    .mockResolvedValue({ items: [updated], nextCursor: null })
  const mutate = vi.fn(async (_intent: AccountMutationIntent) => { throw new AccountActionError('revisionConflict') })
  render(<AccountManagementSection {...props({ list, mutate })} />)
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await screen.findByText('Updated')
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
  expect(mutate.mock.calls[1]?.[0]).toMatchObject({ account: { revision: 8 } })
  expect(mutate.mock.calls[1]?.[0].requestId).not.toBe(mutate.mock.calls[0]?.[0].requestId)
})

it('leaves no management data or secret visible after permission loss', async () => {
  const onPermissionLost = vi.fn()
  const mutate = vi.fn(async () => { throw new AccountActionError('permissionLost') })
  render(<AccountManagementSection {...props({ mutate, onPermissionLost })} />)
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await waitFor(() => { expect(onPermissionLost).toHaveBeenCalledOnce() })
  expect(screen.queryByText('Alice')).toBeNull()
  expect(screen.queryByRole('button', { name: en.checkReceipt })).toBeNull()
})

it('confirms removal and removes only the selected account while refreshing metadata', async () => {
  const bob = { ...account, userId: 'bob', username: 'bob', displayName: 'Bob', role: 'admin' as const,
    enabled: false, passwordChangeRequired: true }
  const refresh = deferredResult<{ items: ManagedAccountView[]; nextCursor: null }>()
  const list = vi.fn<AccountManagementProps['list']>().mockResolvedValueOnce({ items: [account, bob], nextCursor: null }).mockImplementationOnce(() => refresh.promise)
  const mutate = vi.fn<AccountManagementProps['mutate']>(async () => ({}))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
  render(<AccountManagementSection {...props({ list, mutate })} />)
  await screen.findByText('Alice')
  expect(screen.getByText(en.passwordChangeRequired)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: `${en.remove} alice` }))
  expect(mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: `${en.remove} alice` }))
  await waitFor(() => { expect(screen.queryByText('Alice')).toBeNull() })
  expect(screen.getByText('Bob')).toBeTruthy()
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ kind: 'remove', account: { userId: account.userId, revision: 7 } })
  expect(confirm).toHaveBeenCalledTimes(2)
  await act(async () => { refresh.resolve({ items: [bob], nextCursor: null }) })
})

it('loads the next complete management page using its cursor', async () => {
  const list = vi.fn<AccountManagementProps['list']>().mockResolvedValueOnce({ items: [account], nextCursor: 'cursor-2' })
    .mockResolvedValueOnce({ items: [{ ...account, username: 'bob', displayName: 'Bob' }], nextCursor: null })
  render(<AccountManagementSection {...props({ list })} />)
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: en.next }))
  await screen.findByText('Bob')
  expect(list).toHaveBeenLastCalledWith('cursor-2', expect.any(AbortSignal))
  expect(screen.queryByText('Alice')).toBeNull()
})

it('captures edited role, enablement and display name in distinct versioned gestures', async () => {
  let current = account
  const mutate = vi.fn<AccountManagementProps['mutate']>(async (intent) => {
    if (intent.kind !== 'update') throw new Error('Expected update')
    current = { ...current, displayName: intent.displayName, role: intent.role, enabled: intent.enabled, revision: current.revision + 1 }
    return { account: current }
  })
  render(<AccountManagementSection {...props({ list: async () => ({ items: [current, { ...account, userId: 'other', username: 'other', displayName: 'Other' }], nextCursor: null }), mutate })} />)
  await screen.findByText('Alice')
  fireEvent.change(screen.getByRole('combobox', { name: `${en.setRole} alice` }), { target: { value: 'admin' } })
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
  await waitFor(() => { expect(screen.getByRole('combobox', { name: `${en.setRole} alice` })).toHaveProperty('disabled', false) })
  fireEvent.change(screen.getByRole('combobox', { name: `${en.setRole} alice` }), { target: { value: 'user' } })
  await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
  await waitFor(() => { expect(screen.getByRole('switch', { name: `${en.disable} alice` })).toHaveProperty('disabled', false) })
  fireEvent.click(screen.getByRole('switch', { name: `${en.disable} alice` }))
  await waitFor(() => { expect(screen.getByRole('switch', { name: `${en.enable} alice` })).toHaveProperty('disabled', false) })
  fireEvent.change(screen.getByLabelText(`${en.displayName} alice`), { target: { value: 'Updated' } })
  const row = screen.getByLabelText(`${en.displayName} alice`).closest('article')!
  fireEvent.click(within(row).getByRole('button', { name: en.saveDisplayName }))
  await screen.findByText('Updated')
  expect(mutate.mock.calls.map(([intent]) => intent.kind === 'update' ? [intent.account.revision, intent.role, intent.enabled, intent.displayName] : undefined))
    .toEqual([[7, 'admin', true, 'Alice'], [8, 'user', true, 'Alice'], [9, 'user', false, 'Alice'], [10, 'user', false, 'Updated']])
  expect(screen.getByText('Other')).toBeTruthy()
})

it('selects authorized model grants and admin role before creating an account', async () => {
  const mutate = vi.fn<AccountManagementProps['mutate']>(async () => ({}))
  render(<AccountManagementSection {...props({ models: [model, { id: 'second', label: 'Second', maxTokens: 4096 }], mutate })} />)
  await screen.findByText('Alice')
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'new-user' } })
  fireEvent.change(screen.getByLabelText(en.displayName), { target: { value: 'New user' } })
  fireEvent.change(screen.getByRole('combobox', { name: en.role }), { target: { value: 'admin' } })
  fireEvent.change(screen.getByRole('combobox', { name: en.role }), { target: { value: 'user' } })
  fireEvent.change(screen.getByRole('combobox', { name: en.role }), { target: { value: 'admin' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Second' }))
  fireEvent.change(screen.getByLabelText(en.model), { target: { value: 'second' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Model' }))
  fireEvent.change(screen.getByLabelText(en.maxTokens), { target: { value: '1024' } })
  fireEvent.click(screen.getByRole('button', { name: en.add }))
  await waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ kind: 'create', draft: { role: 'admin', model: 'second', maxTokens: 1024,
    modelGrants: [{ id: 'second', maxTokens: 4096 }] } })
  expect(await screen.findByText(en.temporaryUnavailable)).toBeTruthy()
})

it('does not allow creating accounts when no authorized model is available', async () => {
  const mutate = vi.fn<AccountManagementProps['mutate']>()
  render(<AccountManagementSection {...props({ models: [], mutate })} />)
  await screen.findByText(en.noModels)
  expect(screen.getByRole('button', { name: en.add })).toHaveProperty('disabled', true)
  fireEvent.submit(screen.getByLabelText(en.username).closest('form')!)
  expect(mutate).not.toHaveBeenCalled()
})

it.each(['list-success', 'list-failure', 'write-success', 'write-failure'] as const)('cancels %s when the management page closes', async (stage) => {
  const read = deferredResult<Awaited<ReturnType<AccountManagementProps['list']>>>()
  const write = deferredResult<Awaited<ReturnType<AccountManagementProps['mutate']>>>()
  let signal: AbortSignal | undefined
  const input = props({ list: async (_cursor, current) => { if (stage.startsWith('list')) { signal = current; return read.promise } return { items: [account], nextCursor: null } },
    mutate: async (_intent, current) => { signal = current; return write.promise } })
  const root = render(<AccountManagementSection {...input} />)
  if (stage.startsWith('write')) { await screen.findByText('Alice'); fireEvent.click(screen.getByRole('button', { name: en.reset })) }
  root.unmount(); expect(signal?.aborted).toBe(true)
  await act(async () => {
    if (stage === 'list-success') read.resolve({ items: [account], nextCursor: null })
    if (stage === 'list-failure') read.reject(new AccountActionError('permissionLost'))
    if (stage === 'write-success') write.resolve({ account, temporaryPassword: 'secret' })
    if (stage === 'write-failure') write.reject(new AccountActionError('permissionLost'))
  })
  expect(input.onPermissionLost).not.toHaveBeenCalled()
  expect(screen.queryByText('secret')).toBeNull()
})

it('shows definitive management refusals without replaying the gesture', async () => {
  const mutate = vi.fn<AccountManagementProps['mutate']>(async () => { throw new AccountActionError('lastAdmin') })
  render(<AccountManagementSection {...props({ mutate })} />)
  await screen.findByText('Alice'); fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await screen.findByText(en.lastAdmin)
  expect(screen.queryByRole('button', { name: en.checkReceipt })).toBeNull()
  expect(mutate).toHaveBeenCalledOnce()
})

it('clears an unavailable-list alert on refresh and replaces the complete page without a mutation', async () => {
  const refresh = deferredResult<Awaited<ReturnType<AccountManagementProps['list']>>>()
  const list = vi.fn<AccountManagementProps['list']>().mockRejectedValueOnce(new Error('offline'))
    .mockImplementationOnce(() => refresh.promise)
  const input = props({ list })
  render(<AccountManagementSection {...input} />)
  await screen.findByText(en.managementLoadFailed)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: en.add })).toHaveProperty('disabled', true)
  await act(async () => { refresh.resolve({ items: [account], nextCursor: null }) })
  expect(screen.getByText('Alice')).toBeTruthy()
  expect(list).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
  expect(input.mutate).not.toHaveBeenCalled()
})

it('withdraws an already-shown temporary password when a refresh confirms lost management permission', async () => {
  const list = vi.fn<AccountManagementProps['list']>().mockResolvedValueOnce({ items: [account], nextCursor: null })
    .mockResolvedValueOnce({ items: [account], nextCursor: null }).mockRejectedValueOnce(new AccountActionError('permissionLost'))
  const input = props({ list, mutate: async () => ({ account, temporaryPassword: 'temporary-only' }) })
  render(<AccountManagementSection {...input} />)
  await screen.findByText('Alice'); fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await screen.findByText('temporary-only')
  await waitFor(() => { expect(screen.getByRole('button', { name: en.refresh })).toHaveProperty('disabled', false) })
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await waitFor(() => { expect(input.onPermissionLost).toHaveBeenCalledOnce() })
  expect(screen.queryByText('temporary-only')).toBeNull()
  expect(screen.queryByText('Alice')).toBeNull()
})

it('keeps one original creation and one receipt read for queued duplicate gestures', async () => {
  const create = deferredResult<Awaited<ReturnType<AccountManagementProps['mutate']>>>()
  const receipt = deferredResult<Awaited<ReturnType<AccountManagementProps['lookup']>>>()
  const mutate = vi.fn<AccountManagementProps['mutate']>(() => create.promise)
  const lookup = vi.fn<AccountManagementProps['lookup']>(() => receipt.promise)
  render(<AccountManagementSection {...props({ mutate, lookup })} />)
  await screen.findByText('Alice')
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'new-user' } })
  fireEvent.change(screen.getByLabelText(en.displayName), { target: { value: 'New user' } })
  const form = screen.getByLabelText(en.username).closest('form')!
  act(() => { fireEvent.submit(form); fireEvent.submit(form) })
  expect(mutate).toHaveBeenCalledOnce()
  await act(async () => { create.reject(new Error('response lost')) })
  const check = screen.getByRole('button', { name: en.checkReceipt })
  act(() => { fireEvent.click(check); fireEvent.click(check) })
  expect(lookup).toHaveBeenCalledOnce()
  expect(lookup).toHaveBeenCalledWith(mutate.mock.calls[0]?.[0], expect.any(AbortSignal))
  await act(async () => { receipt.resolve({ account }) })
  expect(screen.getByText(en.temporaryUnavailable)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.retryManagement })).toBeNull()
  expect(mutate).toHaveBeenCalledOnce()
})
