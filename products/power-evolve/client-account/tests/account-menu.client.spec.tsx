import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccountHttpClient } from '../src/client/account-api.ts'
import { AccountMenu, type AccountMenuProps } from '../src/client/AccountMenu.tsx'
import { apply } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Menu: ({ anchor, open, items, onSelect }: {
    anchor: ReactNode; open: boolean; items: Array<{ id: string; label?: string; disabled?: boolean }>;
    onSelect: (id: string) => void
  }) => <div>{anchor}{open && items.filter(item => item.label).map(item =>
    <button key={item.id} type="button" disabled={item.disabled} onClick={() => onSelect(item.id)}>{item.label}</button>)}</div>,
}))

const userId = '54f0f232-a068-4223-96e8-d0cff78d0f1c'
const t: AccountMenuProps['t'] = key => key in en ? en[key as keyof typeof en] : String(key)
const me = vi.fn(async () => ({ userId, username: 'alice', settings: { model: 'one', maxTokens: 512, revision: 1 } }))

function mount(client: AccountHttpClient, navigate = vi.fn(), openSettings = vi.fn(),
  loadNavigation: AccountMenuProps['loadNavigation'] = async () => ({ displayName: 'Alice', canManage: false, accountUrl: 'https://platform.example.test/account' })) {
  render(<AccountMenu client={client} navigate={navigate} openSettings={openSettings}
    loadNavigation={loadNavigation}
    openOnboarding={() => undefined} settingsOpen={false} wide t={t} />)
  return { navigate, openSettings }
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('opens password change on the trusted Platform and hides account management from ordinary users', async () => {
  const navigate = vi.fn()
  mount(Object.assign(new AccountHttpClient(), { me }), navigate)
  await screen.findByText('alice')
  fireEvent.click(screen.getByRole('button', { name: 'alice' }))
  await screen.findByRole('button', { name: en.changePassword })
  expect(screen.queryByRole('button', { name: en.managementNav })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.changePassword }))
  expect(navigate).toHaveBeenCalledWith('https://platform.example.test/account#password')
})

it('opens the trusted administrator view only after the readonly capability permits it', async () => {
  const navigate = vi.fn()
  mount(Object.assign(new AccountHttpClient(), { me }), navigate, vi.fn(), async () =>
    ({ displayName: 'Alice', canManage: true, accountUrl: 'https://platform.example.test/account' }))
  await screen.findByText('alice')
  fireEvent.click(screen.getByRole('button', { name: 'alice' }))
  fireEvent.click(await screen.findByRole('button', { name: en.managementNav }))
  expect(navigate).toHaveBeenCalledWith('https://platform.example.test/account#admin')
})

it('keeps trusted actions unavailable if capability loading fails', async () => {
  const navigate = vi.fn()
  mount(Object.assign(new AccountHttpClient(), { me }), navigate, vi.fn(), async () => { throw new Error('unavailable') })
  await screen.findByText('alice')
  fireEvent.click(screen.getByRole('button', { name: 'alice' }))
  const password = screen.getByRole('button', { name: en.changePassword })
  expect(password).toHaveProperty('disabled', true)
  expect(screen.queryByRole('button', { name: en.managementNav })).toBeNull()
  fireEvent.click(password)
  expect(navigate).not.toHaveBeenCalled()
})

it('uses the native launcher seat to open native Settings and sign out through product RPC', async () => {
  const logout = vi.fn(async () => undefined)
  const loginUrl = vi.fn(async () => 'https://login.example.test/login')
  const actions = mount(Object.assign(new AccountHttpClient(), { me, logout, loginUrl }))
  await screen.findByText('alice')
  fireEvent.click(screen.getByRole('button', { name: 'alice' }))
  fireEvent.click(screen.getByRole('button', { name: en.settings }))
  expect(actions.openSettings).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'alice' }))
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  await waitFor(() => expect(actions.navigate).toHaveBeenCalledWith('https://login.example.test/login'))
  expect(loginUrl).toHaveBeenCalledBefore(logout)
  expect(logout).toHaveBeenCalledOnce()
})

it('retains the launcher and shows a local failure when logout is refused', async () => {
  const actions = mount(Object.assign(new AccountHttpClient(), { me, loginUrl: vi.fn(async () => 'https://login.example.test/login'),
    logout: vi.fn(async () => { throw new Error('unavailable') }) }))
  await screen.findByText('alice')
  fireEvent.click(screen.getByRole('button', { name: 'alice' }))
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en.signOutFailed)
  expect(actions.navigate).not.toHaveBeenCalled()
})

it('registers the native account seats and owns the independent identity listener through disposal', async () => {
  const entries: Array<{ name: string; id?: string; label?: () => string; inject?: () => unknown }> = []
  const disposers: Array<() => void> = []
  const listeners = new Set<() => void>()
  const connection = { state: { getSnapshot: () => 'connected', subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }, stop: vi.fn() }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/config')
    ? Response.json({ loginUrl: 'https://platform.example.test/login' })
    : Response.json(await me())))
  const ctx = {
    get: (name: string) => { expect(name).toBe('connection'); return connection },
    effect: (setup: () => unknown) => { const dispose = setup(); if (typeof dispose === 'function') disposers.push(() => { dispose() }) },
    locale: { register: () => () => undefined, bind: () => t },
    slots: {
      inject: (_slot: string, register: () => unknown) => register(),
      register: (entry: typeof entries[number]) => { entries.push(entry); return () => undefined },
    },
  }
  try {
    apply(ctx as Context)
    expect(entries.map(entry => entry.name)).toEqual(['settings.launcher', 'settings.section', 'shell.overlay'])
    expect(entries[1]).toMatchObject({ id: 'account' })
    expect(entries[1]?.label?.()).toBe(en.account)
    expect(entries[0]?.inject?.()).toHaveProperty('client')
    expect(entries[2]?.inject?.()).toHaveProperty('hooks.accountExpiry')
    expect(listeners.size).toBe(1)
    await waitFor(() => { expect(connection.stop).not.toHaveBeenCalled() })
  } finally {
    for (const dispose of disposers.reverse()) dispose()
    vi.unstubAllGlobals()
  }
  expect(listeners.size).toBe(0)
})
