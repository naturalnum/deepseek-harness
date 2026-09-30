import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PasswordChange, type PasswordChangeProps, type PasswordChangeIntent } from '../src/trusted/PasswordChange.tsx'
import { AccountActionError } from '../src/trusted/view.ts'
import { en } from '../src/client/locales.ts'

const t: PasswordChangeProps['t'] = key => en[key]
const change = vi.fn(async (_intent: PasswordChangeIntent) => undefined)
function mount(overrides: Partial<PasswordChangeProps> = {}) {
  const onChanged = vi.fn(), onExpired = vi.fn()
  render(<PasswordChange required minBytes={12} maxBytes={256} change={change}
    onChanged={onChanged} onExpired={onExpired} t={t} {...overrides} />)
  return { onChanged, onExpired }
}
function fill(next = '新的密码123456') {
  fireEvent.change(screen.getByLabelText(en.currentPassword), { target: { value: 'old-password' } })
  fireEvent.change(screen.getByLabelText(en.newPassword), { target: { value: next } })
  fireEvent.change(screen.getByLabelText(en.confirmPassword), { target: { value: next } })
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('uses UTF-8 bytes, clears password fields on success and requires a new sign-in', async () => {
  const actions = mount()
  fill('密码密码')
  fireEvent.click(screen.getByRole('button', { name: en.savePassword }))
  await waitFor(() => expect(actions.onChanged).toHaveBeenCalledOnce())
  expect(screen.getByLabelText(en.currentPassword)).toHaveProperty('value', '')
  expect(screen.getByLabelText(en.newPassword)).toHaveProperty('value', '')
  expect(change.mock.calls[0]?.[0]).toMatchObject({ newPassword: '密码密码' })
})

it('retries an ambiguous change with its original request and frozen password values', async () => {
  const change = vi.fn(async (_intent: PasswordChangeIntent) => { throw new Error('response lost') })
  mount({ change }); fill()
  fireEvent.click(screen.getByRole('button', { name: en.savePassword }))
  await screen.findByText(en.passwordUncertain)
  expect(screen.getByLabelText(en.newPassword)).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: en.retryPassword }))
  await waitFor(() => expect(change).toHaveBeenCalledTimes(2))
  expect(change.mock.calls[1]?.[0]).toBe(change.mock.calls[0]?.[0])
})

it('allows corrected credentials after a definitive refusal', async () => {
  const change = vi.fn(async () => { throw new AccountActionError('passwordRejected') })
  mount({ change }); fill()
  fireEvent.click(screen.getByRole('button', { name: en.savePassword }))
  await screen.findByText(en.passwordRejected)
  expect(screen.getByLabelText(en.currentPassword)).toHaveProperty('disabled', false)
})

it('clears all password fields when the account credential expires', async () => {
  const change = vi.fn(async () => { throw new AccountActionError('permissionLost') })
  const actions = mount({ change }); fill()
  fireEvent.click(screen.getByRole('button', { name: en.savePassword }))
  await waitFor(() => expect(actions.onExpired).toHaveBeenCalledOnce())
  for (const label of [en.currentPassword, en.newPassword, en.confirmPassword]) {
    expect(screen.getByLabelText(label)).toHaveProperty('value', '')
  }
})
