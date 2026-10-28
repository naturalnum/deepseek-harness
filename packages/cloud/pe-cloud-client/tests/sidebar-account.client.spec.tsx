// @vitest-environment jsdom
/** Account menu gestures with the actual native Menu and Settings panel. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { makeTranslate, bindSnapshotSelector, allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsRoot } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/SettingsRoot.tsx'
import { createSettingsShellStore } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/shell-store.ts'
import type { SettingsRootComponentProps } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/shell-contract.ts'
import { en as settingsCopy } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/locales.ts'
import { CloudAccountMenu, type CloudAccountMenuProps } from '../src/client/CloudAccountMenu.tsx'
import { accountDictionaries } from '../src/client/account-locales.ts'

afterEach(cleanup)
const defaults: CloudAccountMenuProps = {
  ...({} as GlobalStandardProps), wide: true, settingsOpen: false, openSettings: () => {}, openOnboarding: () => {},
  displayName: 'Cloud User', signOut: () => {}, t: makeTranslate(accountDictionaries.en),
}

it('shows the actual account name, only Settings/Sign out, and dismisses with Escape and outside click', async () => {
  render(<CloudAccountMenu {...defaults} displayName={'<Other Account>'} />)
  const trigger = screen.getByRole('button', { name: 'Account: <Other Account>' })
  expect(trigger.textContent).toBe('<Other Account>')
  fireEvent.click(trigger)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Settings', 'Sign out'])
  expect(screen.getByRole('menu').parentElement).toBe(document.body)
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
})

it('keeps the collapsed avatar named and prevents duplicate sign-out gestures', () => {
  const signOut = vi.fn()
  render(<CloudAccountMenu {...defaults} wide={false} signOut={signOut} t={makeTranslate(accountDictionaries.zh)} />)
  const trigger = screen.getByRole('button', { name: '账号：Cloud User' })
  expect(trigger.textContent).toBe('')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }))
  expect(signOut).toHaveBeenCalledOnce()
  expect((trigger as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(trigger)
  expect(screen.queryByRole('menu')).toBeNull()
})

it('reports an unavailable original sign-out action without inventing a successful logout', () => {
  render(<CloudAccountMenu {...defaults} signOut={() => { throw new Error('closed') }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Account: Cloud User' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
  expect(screen.getByText(accountDictionaries.en.unavailable)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Account: Cloud User' }).hasAttribute('disabled')).toBe(true)
})

it('opens the original Settings panel and preserves its focus and section owner through menu dismissal', async () => {
  const shell = createSettingsShellStore().create()
  const unused = (() => { throw new Error('unused hook') }) as never
  const props: SettingsRootComponentProps = {
    ...({} as GlobalStandardProps), ...allowAllAccess, wide: true,
    useStore: bindSnapshotSelector(shell), actions: shell.actions, reconnect: () => {}, openDesktopUpdate: () => {},
    useShortcuts: select => select([]), useConnectionState: select => select('connected'),
    useDesktopUpdate: select => select({ failed: false, opening: false }), useOnboardingSteps: select => select([]),
    useSections: select => select([{ id: 'general', order: 0, label: 'General' }]),
    useSessions: select => select({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    useSessionStatus: unused, useWorkspaces: unused,
    t: makeTranslate(settingsCopy),
    renderSlot: ((name: string, owner: unknown) => {
      if (name === 'settings.launcher') return <CloudAccountMenu {...defaults} {...owner as SettingsLauncherOwnerProps} />
      if (name === 'settings.header') return 'Settings'
      if (name === 'settings.close') return 'Close'
      if (name === 'settings.section') return <p>Original settings content</p>
      return null
    }) as SettingsRootComponentProps['renderSlot'],
  }
  render(<SettingsRoot {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Account: Cloud User' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
  await act(async () => { await Promise.resolve() })
  const dialog = screen.getByRole('dialog', { name: 'Settings' })
  expect(dialog.contains(document.activeElement)).toBe(true)
  expect(screen.getByText('Original settings content')).toBeTruthy()
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})
