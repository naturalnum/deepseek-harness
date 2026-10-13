// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { AccountPage, type TrustedAccountPageClient, type TrustedAccountSessionView } from '../src/trusted/AccountPage.tsx'
import { deferredResult } from './deferred-result.ts'
import { en } from '../src/client/locales.ts'
import { AccountActionError } from '../src/trusted/view.ts'

const alice: TrustedAccountSessionView = {
  account: { userId: 'alice-id', username: 'alice', displayName: 'Alice', role: 'user', enabled: true,
    revision: 1, passwordChangeRequired: false, createdAt: '2026-10-01T00:00:00Z' },
  canManage: false, models: [{ id: 'one', label: 'One', maxTokens: 8192 }],
  minPasswordBytes: 12, maxPasswordBytes: 256, productLoginUrl: 'https://platform.test/login',
}
function client(view: TrustedAccountSessionView, logout: TrustedAccountPageClient['logout']): TrustedAccountPageClient {
  return { state: async () => view, login: async () => view, logout, forget: vi.fn(),
    list: async () => ({ items: [], nextCursor: null }), mutate: async () => ({}), lookup: async () => null,
    changePassword: async () => undefined }
}
const t = (key: keyof typeof en) => en[key]
afterEach(cleanup)

it('admits one logout request for two native button gestures before React commits their state', async () => {
  const result = deferredResult<undefined>()
  const logout = vi.fn<TrustedAccountPageClient['logout']>(async () => result.promise)
  render(<AccountPage client={client(alice, logout)} initialView="password" t={t} />)
  const button = await screen.findByRole('button', { name: en.signOut })
  try {
    act(() => { button.click(); button.click() })
    expect(logout).toHaveBeenCalledOnce()
    expect(button).toHaveProperty('disabled', true)
  } finally { await act(async () => { result.resolve(undefined) }) }
})

it.each(['success', 'failure'] as const)('fences all obsolete logout %s replies while the replacement account logout is pending', async (outcome) => {
  const previous = deferredResult<undefined>(), fresh = deferredResult<undefined>()
  const oldLogout = vi.fn<TrustedAccountPageClient['logout']>(async () => previous.promise)
  const nextLogout = vi.fn<TrustedAccountPageClient['logout']>(async () => fresh.promise)
  const root = render(<AccountPage client={client(alice, oldLogout)} initialView="password" t={t} />)
  const oldButton = await screen.findByRole('button', { name: en.signOut })
  act(() => { oldButton.click(); oldButton.click() })
  const bob = { ...alice, account: { ...alice.account, userId: 'bob-id', username: 'bob', displayName: 'Bob' } }
  root.rerender(<AccountPage client={client(bob, nextLogout)} initialView="password" t={t} />)
  await screen.findByText('Bob')
  const newButton = screen.getByRole('button', { name: en.signOut })
  act(() => { newButton.click() })
  try {
    await act(async () => {
      if (outcome === 'success') previous.resolve(undefined)
      else previous.reject(new Error('Old reply failed'))
    })
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(newButton).toHaveProperty('disabled', true)
    expect(nextLogout).toHaveBeenCalledOnce()
  } finally { await act(async () => { fresh.resolve(undefined) }) }
})

it.each(['success', 'failure'] as const)('aborts pending logout before unmount and ignores late %s', async (outcome) => {
  const reply = deferredResult<undefined>()
  let signal: AbortSignal | undefined
  const forget = vi.fn()
  const logout = vi.fn<TrustedAccountPageClient['logout']>(async (current) => { signal = current; return reply.promise })
  const root = render(<AccountPage client={{ ...client(alice, logout), forget }} initialView="password" t={t} />)
  const button = await screen.findByRole('button', { name: en.signOut })
  act(() => { button.click() }); root.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => {
    if (outcome === 'success') reply.resolve(undefined)
    else reply.reject(new Error('Old reply failed'))
  })
  expect(forget).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('permits a fresh logout request after a definitive refusal', async () => {
  const signals: AbortSignal[] = []
  const logout = vi.fn<TrustedAccountPageClient['logout']>(async (signal) => {
    signals.push(signal)
    if (signals.length === 1) throw new AccountActionError('invalidAccount')
  })
  render(<AccountPage client={client(alice, logout)} initialView="password" t={t} />)
  const button = await screen.findByRole('button', { name: en.signOut })
  act(() => { button.click() })
  expect(await screen.findByText(en.signOutFailed)).toBeTruthy()
  expect(screen.getByText('Alice')).toBeTruthy()
  expect(button).toHaveProperty('disabled', false)
  act(() => { button.click() })
  expect(await screen.findByLabelText(en.password)).toBeTruthy()
  expect(logout).toHaveBeenCalledTimes(2)
  expect(signals[1]).not.toBe(signals[0])
})
