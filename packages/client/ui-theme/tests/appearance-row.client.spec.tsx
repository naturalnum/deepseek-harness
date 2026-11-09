// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AppearanceRow } from '../src/client/AppearanceRow.tsx'
import type { AppearanceRowComponentProps } from '../src/client/AppearanceRow.tsx'
import { createAppearanceRowStore } from '../src/client/settings-store.ts'
import { en } from '../src/client/locales.ts'
import type { ThemeSaveState } from '../src/theme-settings.ts'
import type { ThemePreference } from '../src/client/index.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = { ...en }

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<AppearanceRowComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: AppearanceRowComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount(preference: ThemePreference = 'system', saveState: ThemeSaveState = 'idle') {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createAppearanceRowStore().create()
  store.actions.sync(preference, saveState, 0)
  const setTheme = vi.fn()
  const props: AppearanceRowComponentProps = {
    useSessions: emptySessions(),
    useSessionStatus,
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: emptyWorkspaces(),
    ...allowAllAccess,
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setTheme,
  }
  render(<AppearanceRow {...props} />)
  return { store, setTheme }
}

const pressed = (name: RegExp): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('AppearanceRow', () => {
  it('renders the title and three cubes with the preference cube selected', () => {
    mount('dark')
    expect(screen.getByText('Appearance')).toBeDefined()
    expect(pressed(/Dark/)).toBe('true')
    expect(pressed(/Light/)).toBe('false')
    expect(pressed(/System/)).toBe('false')
  })

  it('click drives setTheme; selection follows the store mirror, not the click echo', () => {
    const b = mount('dark')
    fireEvent.click(screen.getByRole('button', { name: /Light/ }))
    expect(b.setTheme).toHaveBeenCalledWith('light')
    // No store write yet: selection is unchanged.
    expect(pressed(/Dark/)).toBe('true')
    act(() => { b.store.actions.sync('light', 'idle', 1) })
    expect(pressed(/Light/)).toBe('true')
    expect(pressed(/Dark/)).toBe('false')
  })

  it.each(['loading', 'readonly', 'saving'] as const)('disables theme choices while %s and explains the state', (state) => {
    const b = mount('system', state)
    const button = screen.getByRole('button', { name: 'Dark' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(b.setTheme).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(en[`save.${state}`])
  })

  it('keeps a pending preview distinct from Host-confirmed success', () => {
    const b = mount('dark')
    act(() => { b.store.actions.sync('system', 'saving', 1) })
    expect(pressed(/System/)).toBe('true')
    expect(screen.getByRole('status').textContent).toBe(en['save.saving'])
    expect(screen.queryByText(en['save.saved'])).toBeNull()
    act(() => { b.store.actions.sync('system', 'saved', 2) })
    expect(screen.getByRole('status').textContent).toBe(en['save.saved'])
    expect(screen.getByRole('button', { name: 'Dark' }).hasAttribute('disabled')).toBe(false)
  })

  it.each(['refused', 'unknown'] as const)('reports %s without claiming that the write was saved', (state) => {
    mount('dark', state)
    expect(screen.getByRole('alert').textContent).toBe(en[`save.${state}`])
    expect(screen.queryByText(en['save.saved'])).toBeNull()
    expect(screen.getByRole('button', { name: 'System' }).hasAttribute('disabled')).toBe(state === 'unknown')
  })

})
