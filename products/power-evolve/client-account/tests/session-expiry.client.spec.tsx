import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionExpiredNotice, type SessionExpiredNoticeProps } from '../src/client/SessionExpiredNotice.tsx'
import { en, zh } from '../src/client/locales.ts'

function props(overrides: Partial<SessionExpiredNoticeProps> = {}): SessionExpiredNoticeProps {
  return { useAccountExpiry: selector => selector({ findingLogin: false, loginUnavailable: true }),
    returnToLogin: vi.fn(async () => undefined), t: key => en[key], ...overrides }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('renders no sign-in warning while the independent identity check remains valid or unavailable', () => {
  render(<SessionExpiredNotice {...props({ useAccountExpiry: selector => selector(undefined) })} />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([{ language: 'en', copy: en }, { language: 'zh', copy: zh }])('records the $language explicit sign-in recovery when the configured URL is unavailable', async ({ language, copy }) => {
  const returnToLogin = vi.fn(async () => undefined)
  render(<SessionExpiredNotice {...props({ returnToLogin, t: key => copy[key] })} />)
  const dialog = screen.getByRole('dialog')
  await expect(`${JSON.stringify({ title: dialog.getAttribute('aria-label'),
    hint: screen.getByText(copy.nativeSignInHint).textContent, problem: screen.getByRole('alert').textContent,
    action: screen.getByRole('button', { name: copy.signInAgain }).textContent }, null, 2)}\n`)
    .toMatchFileSnapshot(`./expected/session-expiry.${language}.json`)
  fireEvent.click(screen.getByRole('button', { name: copy.signInAgain }))
  expect(returnToLogin).toHaveBeenCalledOnce()
})

it('disables another login attempt while configured navigation is pending and keeps stale native views covered', () => {
  const returnToLogin = vi.fn(async () => undefined)
  render(<SessionExpiredNotice {...props({ returnToLogin, useAccountExpiry: selector => selector({ findingLogin: true, loginUnavailable: false }) })} />)
  const action = screen.getByRole('button', { name: en.openingLogin })
  expect(action).toHaveProperty('disabled', true)
  fireEvent.click(action)
  expect(returnToLogin).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toHaveProperty('ariaModal', 'true')
})
