// @vitest-environment jsdom
/** Configuration stays inside the actual native detail slot and original edit owner. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime/src/translate.ts'
import { NativePluginConfigurationSection, type NativePluginConfigurationProps } from '../src/client/management/plugins/NativePluginConfigurationSection.tsx'
import { pluginManagementDictionaries } from '../src/client/management/plugins/locales.ts'
import type { AccountPluginCatalog, AccountPluginId } from '../src/client/management/plugins/types.ts'

afterEach(cleanup)
it('opens the approved configuration only for the exact native detail subject', () => {
  const id = 'approved' as AccountPluginId, open = vi.fn(), unavailable = (): never => { throw new Error('unused') }
  const catalog: AccountPluginCatalog = { phase: 'ready', refreshing: false, plugins: [{ id, title: 'Example', description: '',
    packageName: '@example/test', moduleName: '@example/test', version: '1.0.0', category: 'other', approved: true, installed: true, enabled: true,
    toggle: 'available', configuration: 'available' }] }
  const props: NativePluginConfigurationProps = { ...allowAllAccess, useSessions: unavailable, useSessionStatus: unavailable,
    useSessionRetainInfo: unavailable, usePanelInfo: unavailable, useWorkspaces: unavailable, useResource: unavailable,
    subject: { kind: 'item', id: 'test' }, t: makeTranslate(pluginManagementDictionaries.en),
    useAccountPluginCatalog: selector => selector(catalog), configurationId: () => id, openPluginConfiguration: open }
  render(<NativePluginConfigurationSection {...props}/>)
  fireEvent.click(screen.getByRole('button', { name: pluginManagementDictionaries.en.configure }))
  expect(open).toHaveBeenCalledExactlyOnceWith(id)
})
