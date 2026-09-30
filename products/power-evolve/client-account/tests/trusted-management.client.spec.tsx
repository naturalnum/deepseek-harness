import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
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
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
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

it.each(['receipt', 'retry'])('reports an acknowledged reset through %s without retrieving a lost temporary password', async recovery => {
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
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
  expect(mutate.mock.calls[1]?.[0]).toMatchObject({ account: { revision: 8 } })
  expect(mutate.mock.calls[1]?.[0].requestId).not.toBe(mutate.mock.calls[0]?.[0].requestId)
})

it('leaves no management data or secret visible after permission loss', async () => {
  const onPermissionLost = vi.fn()
  const mutate = vi.fn(async () => { throw new AccountActionError('permissionLost') })
  render(<AccountManagementSection {...props({ mutate, onPermissionLost })} />)
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: en.reset }))
  await waitFor(() => expect(onPermissionLost).toHaveBeenCalledOnce())
  expect(screen.queryByText('Alice')).toBeNull()
  expect(screen.queryByRole('button', { name: en.checkReceipt })).toBeNull()
})
