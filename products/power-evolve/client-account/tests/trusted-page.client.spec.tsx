import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
afterEach(() => { cleanup(); vi.restoreAllMocks() })

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
  await waitFor(() => expect(actions.forget).toHaveBeenCalled())
})
