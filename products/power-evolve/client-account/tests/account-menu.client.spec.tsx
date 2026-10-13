import type {} from '../../../../packages/client/ui-settings/src/client/contract/slots.ts'
// @vitest-environment jsdom
/** Menu gestures use an explicit primitive substitute; native registration has a separate Cordis test. */
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccountHttpClient, AccountHttpError } from '../src/client/account-api.ts'
import { AccountMenu, type AccountMenuProps } from '../src/client/AccountMenu.tsx'
import { en } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Menu: ({ anchor, open, children, onClose }: {
    anchor: ReactNode
    open: boolean
    children: ReactNode
    onClose: () => void
  }) => <div>{anchor}{open && <div>{children}
    <button onClick={onClose}>Close menu</button></div>}</div>,
  MenuItemButton: ({ children, disabled, onSelect }: {
    children: ReactNode
    disabled?: boolean
    onSelect: () => void
  }) => <button disabled={disabled} onClick={onSelect}>{children}</button>,
}))

const account = { userId: '54f0f232-a068-4223-96e8-d0cff78d0f1c', username: 'alice',
  settings: { model: 'one', maxTokens: 512, revision: 1 } }
const capability = { displayName: 'Alice Example', role: 'ADMIN' as const, canManage: true,
  accountUrl: 'https://platform.test/account' }
const t = (key: keyof typeof en) => en[key]
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function client(overrides: Partial<AccountHttpClient> = {}) {
  return Object.assign(new AccountHttpClient(), { me: vi.fn(async () => account),
    loginUrl: vi.fn(async () => 'https://platform.test/login'), logout: vi.fn(async () => undefined) }, overrides, {
    me: overrides.me ?? vi.fn(async () => account),
    loginUrl: overrides.loginUrl ?? vi.fn(async () => 'https://platform.test/login'),
    logout: overrides.logout ?? vi.fn(async () => undefined),
  })
}
function props(overrides: Partial<AccountMenuProps> = {}) {
  return { client: client(), navigate: vi.fn(), loadNavigation: vi.fn(async () => capability),
    wide: true, settingsOpen: false, openSettings: vi.fn(),
    usePanelInfo: (selector => selector({ activePanelId: null })) satisfies AccountMenuProps['usePanelInfo'],
    openOnboarding: vi.fn(), t, ...overrides }
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: /Alice Example|alice|Account/u }))
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('shows the display name and role, and keeps the three authorized launcher actions', async () => {
  const input = props({ settingsShortcut: { keys: ['⌘', ','] } })
  const loginUrl = vi.spyOn(input.client, 'loginUrl'), logout = vi.spyOn(input.client, 'logout')
  render(<AccountMenu {...input} />)
  await screen.findByText('Alice Example')
  expect(screen.getByText(en.admin)).toBeTruthy()
  expect(screen.getByText('AE')).toBeTruthy()
  await open()
  expect(screen.queryByRole('button', { name: en.managementNav })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.settings }))
  expect(input.openSettings).toHaveBeenCalledOnce()
  await open()
  fireEvent.click(screen.getByRole('button', { name: en.changePassword }))
  expect(input.navigate).toHaveBeenCalledWith('https://platform.test/account#password')
  await open()
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  await waitFor(() =>{  expect(input.navigate).toHaveBeenCalledWith('https://platform.test/login') })
  expect(loginUrl).toHaveBeenCalledBefore(vi.mocked(logout))
  expect(logout).toHaveBeenCalledWith(expect.any(AbortSignal))
})

it('keeps settings usable when identity and capability reads fail', async () => {
  const input = props({ wide: false,
    client: client({ me: vi.fn(async () => { throw new Error('offline') }) }),
    loadNavigation: vi.fn(async () => { throw new Error('offline') }) })
  render(<AccountMenu {...input} />)
  await open()
  expect(screen.getByText('?')).toBeTruthy()
  expect(screen.getByRole('button', { name: en.changePassword })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: en.settings }))
  expect(input.openSettings).toHaveBeenCalledOnce()
})

it('discards old identity and navigation reads when a different client is mounted', async () => {
  const me = deferred<typeof account>(), nav = deferred<typeof capability>()
  const input = props({ client: client({ me: vi.fn(() => me.promise) }), loadNavigation: vi.fn(() => nav.promise) })
  const root = render(<AccountMenu {...input} />)
  const next = props({ client: client({ me: vi.fn(async () => ({ ...account, username: 'bob' })) }),
    loadNavigation: vi.fn(async () => ({ ...capability, displayName: 'Bob', role: 'USER' as const })) })
  root.rerender(<AccountMenu {...next} />)
  await screen.findByText('Bob')
  await act(async () => { me.resolve(account); nav.resolve(capability) })
  expect(screen.queryByText('Alice Example')).toBeNull()
  expect(screen.queryByText('alice')).toBeNull()
  expect(screen.getByText(en.user)).toBeTruthy()
})

it.each(['login', 'logout'] as const)('fences a late %s response after a client change', async (stage) => {
  const pending = deferred<string>(), logout = deferred<undefined>()
  const old = client({ loginUrl: vi.fn(() => stage === 'login' ? pending.promise : Promise.resolve('https://platform.test/login')),
    logout: vi.fn(() => logout.promise) })
  const input = props({ client: old })
  const root = render(<AccountMenu {...input} />)
  await screen.findByText('Alice Example'); await open()
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  if (stage === 'logout') await waitFor(() =>{  expect(old.logout).toHaveBeenCalledOnce() })
  root.rerender(<AccountMenu {...props()} />)
  await act(async () => { pending.resolve('https://platform.test/login'); logout.resolve(undefined) })
  expect(input.navigate).not.toHaveBeenCalled()
  if (stage === 'login') expect(old.logout).not.toHaveBeenCalled()
})

it('aborts logout and ignores a late refusal after unmount', async () => {
  const result = deferred<undefined>()
  let signal: AbortSignal | undefined
  const input = props({ client: client({ logout: vi.fn(async (current: AbortSignal) => { signal = current; return result.promise }) }) })
  const root = render(<AccountMenu {...input} />)
  await screen.findByText('Alice Example'); await open()
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  await waitFor(() =>{  expect(signal).toBeDefined() })
  root.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { result.reject(new AccountHttpError(401)) })
  expect(input.navigate).not.toHaveBeenCalled()
})

it('shows a logout refusal and clears the local alert when the menu reopens', async () => {
  const input = props({ client: client({ logout: vi.fn(async () => { throw new AccountHttpError(401) }) }) })
  render(<AccountMenu {...input} />)
  await screen.findByText('Alice Example'); await open()
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.signOutFailed)
  await open()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close menu' }))
  expect(input.navigate).not.toHaveBeenCalled()
})

it('withdraws a malformed password destination instead of navigating it', async () => {
  const input = props({ loadNavigation: vi.fn(async () => ({ ...capability, accountUrl: 'https://platform.test/other' })) })
  render(<AccountMenu {...input} />)
  await screen.findByText('Alice Example'); await open()
  fireEvent.click(screen.getByRole('button', { name: en.changePassword }))
  expect(input.navigate).not.toHaveBeenCalled()
  await open()
  expect(screen.getByRole('button', { name: en.changePassword })).toHaveProperty('disabled', true)
})

it('ignores an obsolete capability refusal and retains the replacement role', async () => {
  const old = deferred<typeof capability>()
  const root = render(<AccountMenu {...props({ loadNavigation: () => old.promise })} />)
  root.rerender(<AccountMenu {...props({ loadNavigation: async () => ({ ...capability, displayName: 'Bob', role: 'USER' }) })} />)
  await screen.findByText('Bob')
  await act(async () => { old.reject(new Error('old transport refused')) })
  expect(screen.getByText('Bob')).toBeTruthy()
  expect(screen.getByText(en.user)).toBeTruthy()
})

it.each([new Error('offline'), new AccountHttpError(403)])('retains identity when sign out is unconfirmed: %s', async (error) => {
  const input = props({ client: client({ logout: async () => { throw error } }) })
  render(<AccountMenu {...input} />)
  await screen.findByText('Alice Example'); await open()
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  await screen.findByRole('alert')
  expect(screen.getByText('Alice Example')).toBeTruthy()
  expect(input.navigate).not.toHaveBeenCalled()
})

it('admits only one logout for queued duplicate menu selections', async () => {
  const result = deferred<string>()
  const input = props({ client: client({ loginUrl: vi.fn(() => result.promise) }) })
  const loginUrl = vi.spyOn(input.client, 'loginUrl'), logout = vi.spyOn(input.client, 'logout')
  render(<AccountMenu {...input} />)
  await screen.findByText('Alice Example'); await open()
  const button = screen.getByRole('button', { name: en.signOut })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(loginUrl).toHaveBeenCalledOnce()
  await open()
  expect(screen.getByRole('button', { name: en.signingOut })).toHaveProperty('disabled', true)
  await act(async () => { result.resolve('https://platform.test/login') })
  expect(logout).toHaveBeenCalledOnce()
})
