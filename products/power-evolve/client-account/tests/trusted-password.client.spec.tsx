// @vitest-environment jsdom
import { deferredResult } from './deferred-result.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  await waitFor(() => { expect(actions.onChanged).toHaveBeenCalledOnce() })
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
  await waitFor(() => { expect(change).toHaveBeenCalledTimes(2) })
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
  await waitFor(() => { expect(actions.onExpired).toHaveBeenCalledOnce() })
  for (const label of [en.currentPassword, en.newPassword, en.confirmPassword]) {
    expect(screen.getByLabelText(label)).toHaveProperty('value', '')
  }
})

it.each([
  { current: 'old-password', next: 'long-new-password', confirm: 'different', problem: 'passwordMismatch' },
  { current: '', next: 'long-new-password', confirm: 'long-new-password', problem: 'passwordLength' },
  { current: 'old-password', next: 'short', confirm: 'short', problem: 'passwordLength' },
  { current: 'old-password', next: '密'.repeat(100), confirm: '密'.repeat(100), problem: 'passwordLength' },
  { current: 'same-long-password', next: 'same-long-password', confirm: 'same-long-password', problem: 'passwordSame' },
] as const)('refuses $problem before issuing a password request', async (fields) => {
  const change = vi.fn<PasswordChangeProps['change']>()
  mount({ change, required: false })
  fireEvent.change(screen.getByLabelText(en.currentPassword), { target: { value: fields.current } })
  fireEvent.change(screen.getByLabelText(en.newPassword), { target: { value: fields.next } })
  fireEvent.change(screen.getByLabelText(en.confirmPassword), { target: { value: fields.confirm } })
  fireEvent.submit(screen.getByLabelText(en.currentPassword).closest('form')!)
  expect(await screen.findByText(en[fields.problem])).toBeTruthy()
  expect(change).not.toHaveBeenCalled()
})

it.each(['success', 'failure'] as const)('cancels a pending password change on teardown before late %s', async (outcome) => {
  const result = deferredResult<undefined>()
  let signal: AbortSignal | undefined
  const change = vi.fn<PasswordChangeProps['change']>(async (_intent, current) => { signal = current; return result.promise })
  const onChanged = vi.fn(), onExpired = vi.fn()
  const root = render(<PasswordChange required={false} minBytes={12} maxBytes={256} t={t}
    change={change} onChanged={onChanged} onExpired={onExpired} />)
  fill('long-new-password')
  const form = screen.getByLabelText(en.currentPassword).closest('form')!
  act(() => { fireEvent.submit(form); fireEvent.submit(form) })
  expect(change).toHaveBeenCalledOnce()
  root.unmount(); expect(signal?.aborted).toBe(true)
  await act(async () => { if (outcome === 'success') result.resolve(undefined); else result.reject(new AccountActionError('permissionLost')) })
  expect(onChanged).not.toHaveBeenCalled(); expect(onExpired).not.toHaveBeenCalled()
})

it.each([{ next: '密'.repeat(85) + 'a', bytes: 256, accepted: true }, { next: '密'.repeat(85) + 'ab', bytes: 257, accepted: false }])
('applies the UTF-8 maximum to a $bytes-byte password', async ({ next, accepted }) => {
  const change = vi.fn<PasswordChangeProps['change']>(async () => undefined)
  const actions = mount({ change }); fill(next)
  fireEvent.submit(screen.getByLabelText(en.currentPassword).closest('form')!)
  if (accepted) {
    await waitFor(() => { expect(actions.onChanged).toHaveBeenCalledOnce() })
    expect(change.mock.calls[0]?.[0].newPassword).toBe(next)
  } else {
    expect(await screen.findByText(en.passwordLength)).toBeTruthy()
    expect(change).not.toHaveBeenCalled()
  }
})

it('issues a new password gesture only after a definitive refusal permits corrected input', async () => {
  const change = vi.fn<PasswordChangeProps['change']>().mockRejectedValueOnce(new AccountActionError('passwordRejected'))
    .mockResolvedValueOnce(undefined)
  const actions = mount({ change }); fill('first-long-password')
  fireEvent.click(screen.getByRole('button', { name: en.savePassword }))
  await screen.findByText(en.passwordRejected)
  fill('corrected-long-password')
  fireEvent.click(screen.getByRole('button', { name: en.savePassword }))
  await waitFor(() => { expect(actions.onChanged).toHaveBeenCalledOnce() })
  expect(change.mock.calls[1]?.[0].requestId).not.toBe(change.mock.calls[0]?.[0].requestId)
  expect(change.mock.calls.map(([intent]) => intent.newPassword)).toEqual(['first-long-password', 'corrected-long-password'])
})
