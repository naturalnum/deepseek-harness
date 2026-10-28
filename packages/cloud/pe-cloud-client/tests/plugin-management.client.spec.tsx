// @vitest-environment jsdom
/** Account display controls never substitute approval for actual installed state or write through a missing port. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime/src/access.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime/src/translate.ts'
import { PluginManagementPage, type PluginManagementPageProps } from '../src/client/management/plugins/PluginManagementPage.tsx'
import { pluginManagementDictionaries } from '../src/client/management/plugins/locales.ts'
import { pluginCategory } from '../src/client/management/plugins/catalog.ts'
import type { AccountPluginCard, AccountPluginCatalog, AccountPluginId } from '../src/client/management/plugins/types.ts'

afterEach(cleanup)
const en = pluginManagementDictionaries.en
function plugin(id: string, options: Partial<AccountPluginCard> = {}): AccountPluginCard {
  return { id: id as AccountPluginId, title: id, description: `${id} tools`, packageName: `@example/${id}`,
    moduleName: `@example/${id}`, version: '1.0.0', category: pluginCategory(id), approved: true,
    installed: true, enabled: false, toggle: 'available', configuration: 'available', ...options }
}
function fixture(plugins = [plugin('shell'), plugin('agent'), plugin('browser', { installed: null, enabled: null })]) {
  let catalog: AccountPluginCatalog = { phase: 'ready', plugins, refreshing: false }
  const unused = (): never => { throw new Error('This account page reads no session/global model') }
  const requestPluginEnabled = vi.fn(), requestPluginSelected = vi.fn(), openPluginConfiguration = vi.fn(), refreshPluginCatalog = vi.fn()
  const props: PluginManagementPageProps = {
    ...allowAllAccess, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
    usePanelInfo: unused, useWorkspaces: unused, useResource: unused,
    t: makeTranslate(en), useAccountPluginCatalog: selector => selector(catalog),
    requestPluginEnabled, requestPluginSelected, openPluginConfiguration, refreshPluginCatalog,
  }
  return { props, requestPluginEnabled, requestPluginSelected, openPluginConfiguration, refreshPluginCatalog,
    update: (next: AccountPluginCatalog) => { catalog = next } }
}

it('combines translated search, purpose and known-installed filters, retaining filters after visiting details', () => {
  const f = fixture(); render(<PluginManagementPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.execution }))
  expect(screen.getByRole('button', { name: 'View shell' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'View agent' })).toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'SHELL' } })
  fireEvent.click(screen.getByRole('button', { name: 'View shell' }))
  expect(screen.getByRole('heading', { name: 'shell' })).toBeTruthy()
  expect(screen.getAllByText('@example/shell', { selector: 'code' })).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: en.back }))
  expect(screen.getByRole('searchbox')).toHaveProperty('value', 'SHELL')
  fireEvent.click(screen.getByRole('button', { name: en.all }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('switch', { name: en.installedOnly }))
  expect(screen.queryByRole('button', { name: 'View browser' })).toBeNull()
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
})

it('requests a toggle once through the injected port and waits for the authoritative projection', () => {
  const f = fixture([plugin('shell')]), view = render(<PluginManagementPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: 'View shell' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Enable shell' }))
  expect(f.requestPluginEnabled).toHaveBeenCalledExactlyOnceWith('shell', true)
  expect(screen.getByRole('switch', { name: 'Enable shell' }).getAttribute('aria-checked')).toBe('false')
  f.update({ phase: 'ready', plugins: [plugin('shell', { enabled: true })], refreshing: false })
  view.rerender(<PluginManagementPage {...f.props}/>)
  expect(screen.getByRole('switch', { name: 'Enable shell' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Configure shell' }))
  expect(f.openPluginConfiguration).toHaveBeenCalledExactlyOnceWith('shell')
})

it.each([
  { approved: false }, { installed: false }, { installed: null },
  { toggle: 'pending' as const, configuration: 'pending' as const },
  { toggle: 'unknown' as const, configuration: 'unknown' as const },
  { toggle: 'busy' as const, configuration: 'busy' as const },
  { toggle: 'read-only' as const, configuration: 'read-only' as const },
])('keeps account mutations closed for unavailable row state %j', (options) => {
  const f = fixture([plugin('shell', options)]); render(<PluginManagementPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: 'View shell' }))
  expect(screen.getByRole('switch', { name: 'Enable shell' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('switch', { name: 'Enable shell' }))
  expect(screen.getByRole('button', { name: 'Configure shell' })).toHaveProperty('disabled', true)
  expect(f.requestPluginEnabled).not.toHaveBeenCalled(); expect(f.openPluginConfiguration).not.toHaveBeenCalled()
})

it('closes controls when callbacks are absent, despite an available row, and exposes no install editor', () => {
  const f = fixture([plugin('shell')])
  const { requestPluginEnabled: _toggle, openPluginConfiguration: _configure, ...closed } = f.props
  render(<PluginManagementPage {...closed}/>)
  expect(screen.getByRole('button', { name: en.add })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View shell' }))
  expect(screen.getByRole('switch', { name: 'Enable shell' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Configure shell' })).toHaveProperty('disabled', true)
  expect(screen.getByText(en.notConnected)).toBeTruthy()
})

it('retains the last readable rows after a refresh failure, closes mutations and offers the owner retry', () => {
  const f = fixture([plugin('shell')]); f.update({ phase: 'error', plugins: [plugin('shell')], refreshing: false })
  render(<PluginManagementPage {...f.props}/>)
  expect(screen.getByRole('alert').textContent).toContain(en.error)
  expect(screen.getByRole('button', { name: 'View shell' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'View shell' }))
  expect(screen.getByRole('switch', { name: 'Enable shell' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('alert').querySelector('button')!)
  expect(f.refreshPluginCatalog).toHaveBeenCalledOnce()
})

it('renders the closed-account state without manufacturing sample rows and owns bilingual page copy', () => {
  const f = fixture([]); f.update({ phase: 'unavailable', plugins: [], refreshing: false })
  render(<PluginManagementPage {...f.props}/>)
  expect(screen.getByRole('status').textContent).toMatchInlineSnapshot('"The account plugin catalog is not connected yet."')
  expect(screen.queryByRole('listitem')).toBeNull()
  expect(f.requestPluginEnabled).not.toHaveBeenCalled()
  expect(Object.keys(pluginManagementDictionaries.zh).sort()).toEqual(Object.keys(en).sort())
})

it('shows busy control feedback while retaining the last read enabled state and keeping mutations closed', () => {
  const f = fixture([plugin('shell', { toggle: 'busy', configuration: 'busy' })])
  render(<PluginManagementPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: 'View shell' }))
  expect(screen.getByRole('switch', { name: 'Enable shell' }).getAttribute('title')).toBe(en.busy)
  expect(screen.getByRole('switch', { name: 'Enable shell' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('switch', { name: 'Enable shell' }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getAllByText(en.busy).length).toBeGreaterThan(0)
  expect(screen.getByRole('button', { name: 'Configure shell' })).toHaveProperty('disabled', true)
  expect(f.requestPluginEnabled).not.toHaveBeenCalled(); expect(f.refreshPluginCatalog).not.toHaveBeenCalled()
})

it('keeps bundle selection closed when native selection or availability is unknown', () => {
  const f = fixture([plugin('bundle', { enabled: null, moduleName: null, selected: null, toggle: 'unknown', configuration: 'read-only', installable: true,
    selectionTarget: { kind: 'bundle', name: '@example/bundle' }, operations: ['selected'], maxImpact: 'graph' })])
  render(<PluginManagementPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: 'View bundle' }))
  expect(screen.getByRole('switch', { name: 'Select bundle' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('switch', { name: 'Select bundle' }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('button', { name: 'Configure bundle' })).toHaveProperty('disabled', true)
  expect(screen.getByText(en.selection)).toBeTruthy()
  expect(f.requestPluginEnabled).not.toHaveBeenCalled(); expect(f.requestPluginSelected).not.toHaveBeenCalled()
})
it('does not require entry activation facts for an independently approved ordinary configuration', () => {
  const f = fixture([plugin('config-only', { enabled: null, toggle: 'read-only', operations: ['configure'] })])
  render(<PluginManagementPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: 'View config-only' }))
  expect(screen.getByRole('switch', { name: 'Enable config-only' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'Configure config-only' }))
  expect(f.openPluginConfiguration).toHaveBeenCalledExactlyOnceWith('config-only')
})

it.each([false, true])('requests the original bundle selection port from selected=%s without an enable or installation action', (selected) => {
  const f = fixture([plugin('native-bundle', { moduleName: null, enabled: null, installed: false, selected, installable: true,
    availability: 'installation', selectionTarget: { kind: 'bundle', name: '@example/bundle' },
    operations: ['selected'], toggle: 'available', configuration: 'read-only', version: '2.3.4' })])
  render(<PluginManagementPage {...f.props}/>)
  expect(screen.getByRole('button', { name: en.add })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'View native-bundle' }))
  const toggle = screen.getByRole('switch', { name: 'Select native-bundle' })
  expect(toggle).toHaveProperty('disabled', false)
  expect(toggle.getAttribute('aria-checked')).toBe(String(selected))
  fireEvent.click(toggle)
  expect(f.requestPluginSelected).toHaveBeenCalledExactlyOnceWith('native-bundle', !selected)
  expect(f.requestPluginEnabled).not.toHaveBeenCalled()
  expect(screen.getByText(en.filesInstallation)).toBeTruthy()
  expect(screen.getByText(en.dependencyNotDeclared)).toBeTruthy()
  expect(screen.getByText('2.3.4')).toBeTruthy()
  expect(screen.queryByText(en.activation)).toBeNull()
  expect(screen.queryByText(en.moduleName)).toBeNull()
  expect(screen.getByRole('button', { name: 'Configure native-bundle' })).toHaveProperty('disabled', true)
})


it('shows one compact list with installation marks and leaves activation to the plugin detail', () => {
  const f = fixture([plugin('shell'), plugin('agent', { installed: false, enabled: null }), plugin('browser', { installed: null })])
  render(<PluginManagementPage {...f.props}/>)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en.title)
  expect(screen.queryByText(en.intro)).toBeNull()
  expect(screen.getAllByRole('list')).toHaveLength(1)
  expect(screen.queryByRole('heading', { name: en.available })).toBeNull()
  expect(screen.getByRole('button', { name: en.refresh }).textContent).toBe(en.refresh)
  expect(screen.getAllByRole('switch')).toHaveLength(1)
  expect(screen.getAllByRole('img').map(image => image.getAttribute('aria-label'))).toMatchInlineSnapshot(`
    [
      "Installed",
      "View agent",
      "State not confirmed",
    ]
  `)
  expect(screen.getByRole('button', { name: 'View shell' }).textContent).toBe('shellshell tools')
  fireEvent.click(screen.getByRole('button', { name: 'View agent' }))
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('agent')
  expect(f.requestPluginEnabled).not.toHaveBeenCalled()
  expect(f.requestPluginSelected).not.toHaveBeenCalled()
  expect(f.openPluginConfiguration).not.toHaveBeenCalled()
})
