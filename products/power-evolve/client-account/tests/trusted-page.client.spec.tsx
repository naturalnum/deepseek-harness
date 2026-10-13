// @vitest-environment jsdom
import { deferredResult } from './deferred-result.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccountPage, type TrustedAccountPageClient, type TrustedAccountSessionView } from '../src/trusted/AccountPage.tsx'
import { AccountActionError } from '../src/trusted/view.ts'
import { en, zh } from '../src/client/locales.ts'

const session: TrustedAccountSessionView = {
  account: { userId: 'alice-id', username: 'alice', displayName: 'Alice', role: 'admin', enabled: true,
    revision: 1, passwordChangeRequired: true, createdAt: '2026-10-01T00:00:00Z' },
  canManage: true, models: [{ id: 'one', label: 'One', maxTokens: 8192 }],
  minPasswordBytes: 12, maxPasswordBytes: 256, productLoginUrl: 'https://platform.test/login',
}
function client(overrides: Partial<TrustedAccountPageClient> = {}): TrustedAccountPageClient {
  return { state: vi.fn(async () => session), login: vi.fn(async () => session), logout: vi.fn(async () => undefined),
    forget: vi.fn(), list: vi.fn(async () => ({ items: [], nextCursor: null })),
    mutate: vi.fn(async () => ({})), lookup: vi.fn(async () => null), changePassword: vi.fn(async () => undefined), ...overrides }
}
const t = (key: keyof typeof en) => en[key]
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks() })

it('shows only personal password actions while the account requires its first change', async () => {
  const actions = client()
  render(<AccountPage client={actions} initialView="admin" t={t} />)
  await screen.findByText(en.firstPasswordTitle)
  expect(screen.queryByRole('button', { name: en.managementNav })).toBeNull()
  expect(screen.queryByRole('link', { name: en.returnToProduct })).toBeNull()
  expect(actions.list).not.toHaveBeenCalled()
})

it.each([{ language: 'en', copy: en }, { language: 'zh', copy: zh }])('records the $language forced-change account experience', async ({ language, copy }) => {
  render(<AccountPage client={client()} initialView="admin" t={key => copy[key]} />)
  await screen.findByText(copy.firstPasswordTitle)
  const output = {
    headings: screen.getAllByRole('heading').map(element => element.textContent),
    actions: screen.getAllByRole('button').map(element => element.textContent),
    passwordFields: Array.from(document.querySelectorAll('input[type="password"]')).map(element => ({
      label: element.closest('label')?.textContent, autocomplete: element.getAttribute('autocomplete'),
    })),
    links: screen.queryAllByRole('link').map(element => element.textContent),
    firstChangeHint: screen.getByText(copy.firstPasswordHint).textContent,
  }
  await expect(`${JSON.stringify(output, null, 2)}\n`)
    .toMatchFileSnapshot(`./expected/trusted-account.${language}.json`)
})

it('offers account management only when permitted by the trusted personal state', async () => {
  const actions = client({ state: vi.fn(async () => ({ ...session, canManage: false,
    account: { ...session.account, passwordChangeRequired: false } })) })
  render(<AccountPage client={actions} initialView="admin" t={t} />)
  await screen.findByLabelText(en.currentPassword)
  expect(screen.queryByText(en.managementTitle)).toBeNull()
  expect(actions.list).not.toHaveBeenCalled()
})

it('keeps the trusted login password local and clears it after a refused sign-in', async () => {
  const actions = client({ state: vi.fn(async () => { throw new AccountActionError('permissionLost') }),
    login: vi.fn(async () => { throw new Error('denied') }) })
  render(<AccountPage client={actions} initialView="password" t={t} />)
  await screen.findByLabelText(en.password)
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'alice' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'temporary-secret' } })
  fireEvent.click(screen.getByRole('button', { name: en.login }))
  await screen.findByText(en.loginFailed)
  expect(screen.getByLabelText(en.password)).toHaveProperty('value', '')
  expect(actions.login).toHaveBeenCalledWith('alice', 'temporary-secret', expect.any(AbortSignal))
})

it('disposes management when a subsequent action is refused and asks for a new account sign-in', async () => {
  const active = { ...session, account: { ...session.account, passwordChangeRequired: false } }
  const actions = client({ state: vi.fn(async () => active),
    list: vi.fn(async () => { throw new AccountActionError('permissionLost') }) })
  render(<AccountPage client={actions} initialView="admin" t={t} />)
  await screen.findByText(en.permissionLost)
  await screen.findByLabelText(en.password)
  expect(screen.queryByText(en.managementTitle)).toBeNull()
  await waitFor(() => { expect(actions.forget).toHaveBeenCalled() })
})

const active = { ...session, initialSettings: { model: 'one', maxTokens: 512 }, account: { ...session.account, passwordChangeRequired: false } }
it('retries an unavailable personal read and exposes only the permitted navigation', async () => {
  const actions = client({ state: vi.fn<TrustedAccountPageClient['state']>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(active) })
  render(<AccountPage client={actions} initialView="password" t={t} />)
  await screen.findByText(en.trustedLoadFailed)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('link', { name: en.returnToProduct })
  fireEvent.click(screen.getByRole('button', { name: en.managementNav }))
  await screen.findByRole('heading', { name: en.managementTitle })
  expect(window.location.hash).toBe('#admin')
  fireEvent.click(screen.getByRole('button', { name: en.changePassword }))
  expect(window.location.hash).toBe('#password')
  expect(screen.getByLabelText(en.currentPassword)).toBeTruthy()
})

it.each([undefined, new AccountActionError('permissionLost'), new Error('offline')])('handles a trusted logout result without dropping an unconfirmed session: %s', async (failure) => {
  const actions = client({ state: async () => active, logout: async () => { if (failure) throw failure } })
  render(<AccountPage client={actions} initialView="password" t={t} />)
  await screen.findByLabelText(en.currentPassword)
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  if (failure instanceof Error && !(failure instanceof AccountActionError)) {
    await screen.findByText(en.signOutFailed)
    expect(screen.getByRole('link', { name: en.returnToProduct })).toBeTruthy()
  } else {
    await screen.findByLabelText(en.password)
    expect(actions.forget).toHaveBeenCalled()
    if (failure) expect(screen.getByText(en.permissionLost)).toBeTruthy()
  }
})

it.each(['state', 'logout'] as const)('fences a late %s refusal after the page closes', async (method) => {
  const pending = deferredResult<TrustedAccountSessionView>()
  const actions = client({ state: method === 'state' ? () => pending.promise : async () => active,
    logout: async () => { await pending.promise } })
  const root = render(<AccountPage client={actions} initialView="password" t={t} />)
  if (method === 'logout') {
    await screen.findByLabelText(en.currentPassword)
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  }
  root.unmount()
  await act(async () => { pending.reject(new AccountActionError('permissionLost')) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('aborts a previous personal read before rendering a replacement client account', async () => {
  const pending = deferredResult<TrustedAccountSessionView>()
  let signal: AbortSignal | undefined
  const old = client({ state: async (current) => { signal = current; return pending.promise } })
  const root = render(<AccountPage client={old} initialView="password" t={t} />)
  root.rerender(<AccountPage client={client({ state: async () => ({ ...active, account: { ...active.account, displayName: 'Bob' } }) })} initialView="password" t={t} />)
  await screen.findByText('Bob'); expect(signal?.aborted).toBe(true)
  await act(async () => { pending.resolve(active) })
  expect(screen.queryByText('Alice')).toBeNull()
})

it('accepts a trusted login and expires the session after a successful password change', async () => {
  const actions = client({ state: async () => { throw new AccountActionError('permissionLost') }, login: async () => active })
  render(<AccountPage client={actions} initialView="password" t={t} />)
  await screen.findByLabelText(en.password)
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'alice' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'legacy' } })
  fireEvent.click(screen.getByRole('button', { name: en.login }))
  await screen.findByLabelText(en.currentPassword)
  for (const [label, value] of [[en.currentPassword, 'legacy'], [en.newPassword, 'new-long-password'], [en.confirmPassword, 'new-long-password']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } })
  }
  fireEvent.click(screen.getByRole('button', { name: en.savePassword }))
  await screen.findByText(en.passwordChanged)
  expect(screen.getByLabelText(en.password)).toBeTruthy()
})

it.each(['success', 'failure'] as const)('ignores late trusted login %s after teardown', async (outcome) => {
  const pending = deferredResult<TrustedAccountSessionView>()
  let signal: AbortSignal | undefined
  const login = vi.fn<TrustedAccountPageClient['login']>(async (_username, _password, current) => { signal = current; return pending.promise })
  const actions = client({ state: async () => { throw new AccountActionError('permissionLost') }, login })
  const root = render(<AccountPage client={actions} initialView="password" t={t} />)
  await screen.findByLabelText(en.password)
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'alice' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'legacy' } })
  const form = screen.getByLabelText(en.password).closest('form')!
  act(() => { fireEvent.submit(form); fireEvent.submit(form) })
  expect(login).toHaveBeenCalledOnce()
  root.unmount(); expect(signal?.aborted).toBe(true)
  await act(async () => { if (outcome === 'success') pending.resolve(active); else pending.reject(new Error('refused')) })
  expect(screen.queryByText('Alice')).toBeNull()
})

it('withdraws the password page after a definitive credential refusal', async () => {
  const actions = client({ state: async () => active, changePassword: async () => { throw new AccountActionError('permissionLost') } })
  render(<AccountPage client={actions} initialView="password" t={t} />)
  await screen.findByLabelText(en.currentPassword)
  for (const [label, value] of [[en.currentPassword, 'legacy'], [en.newPassword, 'new-long-password'], [en.confirmPassword, 'new-long-password']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } })
  }
  fireEvent.click(screen.getByRole('button', { name: en.savePassword }))
  await screen.findByText(en.permissionLost)
  expect(screen.getByLabelText(en.password)).toBeTruthy()
  expect(screen.queryByLabelText(en.currentPassword)).toBeNull()
})

it('does not replace a closed document after a late successful logout', async () => {
  const result = deferredResult<undefined>()
  const actions = client({ state: async () => active, logout: () => result.promise })
  const root = render(<AccountPage client={actions} initialView="password" t={t} />)
  await screen.findByLabelText(en.currentPassword)
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  root.unmount()
  const forgotten = vi.mocked(actions.forget).mock.calls.length
  await act(async () => { result.resolve(undefined) })
  expect(actions.forget).toHaveBeenCalledTimes(forgotten)
})

it('discards a pending trusted login when a replacement client acquires another account', async () => {
  const pending = deferredResult<TrustedAccountSessionView>()
  let signal: AbortSignal | undefined
  const old = client({ state: async () => { throw new AccountActionError('permissionLost') },
    login: async (_username, _password, current) => { signal = current; return pending.promise } })
  const root = render(<AccountPage client={old} initialView="password" t={t} />)
  await screen.findByLabelText(en.password)
  fireEvent.change(screen.getByLabelText(en.username), { target: { value: 'alice' } })
  fireEvent.change(screen.getByLabelText(en.password), { target: { value: 'old-secret' } })
  fireEvent.click(screen.getByRole('button', { name: en.login }))
  const replacement = client({ state: async () => ({ ...active, account: { ...active.account, displayName: 'Bob' } }) })
  root.rerender(<AccountPage client={replacement} initialView="password" t={t} />)
  await screen.findByText('Bob')
  expect(signal?.aborted).toBe(true)
  await act(async () => { pending.resolve(active) })
  expect(screen.queryByText('Alice')).toBeNull()
  expect(screen.getByText('Bob')).toBeTruthy()
  expect(replacement.login).not.toHaveBeenCalled()
})
