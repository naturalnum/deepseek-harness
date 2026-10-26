/** Account approval, package files, Loader activation and control readiness remain independent. */
import { expect, it, vi } from 'vitest'
import type { BundleInfo, PluginInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { ApprovedConfigurationPlugin } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type { AccountPluginCatalog } from '../src/client/management/plugins/types.ts'
import { projectApprovedAccountPlugins, readOnlyAccountPluginInjection } from '../src/client/management/plugins/account-projection.ts'

const approved: ApprovedConfigurationPlugin = {
  id: 'reminder', entryId: 'include:reminder', moduleName: '@deepseek-ai/dsh-repeat-tool-reminder',
  packageName: '@deepseek-ai/dsh-repeat-tool-reminder', packageVersion: '0.2.1-rc.2', installable: false, toggleable: false,
}
const displayText = () => ({ title: 'Reminder', description: 'Test-owned localized metadata' })
function bundle(fields: Partial<BundleInfo> = {}): BundleInfo {
  return { name: approved.packageName, official: false, availability: 'installation', version: approved.packageVersion,
    installed: false, enabled: false, optional: false, removable: false, rows: [], overrides: [], ...fields }
}
function entry(fields: Partial<Pick<PluginInfo, 'entryId' | 'moduleName' | 'enabled' | 'fiberPhase'>> = {}): PluginInfo {
  return { entryId: approved.entryId as PluginInfo['entryId'], moduleName: approved.moduleName,
    enabled: true, fiberPhase: 'active', patchId: 'reminder', ...fields }
}

it('keeps approval-only and unconfirmed or mismatched native reads unknown', () => {
  const project = (bundles?: readonly BundleInfo[], plugins?: readonly PluginInfo[]) =>
    projectApprovedAccountPlugins([approved], bundles, plugins, displayText)[0]!
  expect(project()).toMatchObject({ approved: true, installed: null, enabled: null, version: null })
  expect(project([bundle()], undefined)).toMatchObject({ installed: null, enabled: null })
  expect(project([bundle({ availability: 'missing' })], undefined)).toMatchObject({ installed: null, enabled: null })
  expect(project([bundle()], [entry({ moduleName: '@example/other' })])).toMatchObject({ installed: null, enabled: null })
  expect(project([bundle({ version: 'different' })], [entry()])).toMatchObject({ installed: null, enabled: null, version: 'different' })
})

it('reads actual availability and Loader phase without importing Profile selection as applied state', () => {
  const project = (pkg: BundleInfo, native: PluginInfo) => projectApprovedAccountPlugins([approved], [pkg], [native], displayText)[0]!
  expect(project(bundle(), entry())).toMatchObject({ installed: true, enabled: true, toggle: 'not-connected', configuration: 'not-connected' })
  expect(project(bundle({ installed: true, availability: 'missing' }), entry({ enabled: false, fiberPhase: null }))).toMatchObject({ installed: false, enabled: null })
  expect(project(bundle(), entry({ enabled: false, fiberPhase: null }))).toMatchObject({ installed: true, enabled: false })
  expect(project(bundle(), entry({ fiberPhase: 'failed' }))).toMatchObject({ installed: true, enabled: null })
})

it('retains the original stable source and refresh callback without creating writers or automatic work', () => {
  const snapshot: AccountPluginCatalog = { phase: 'unavailable', plugins: [], refreshing: false }
  const source = { getSnapshot: () => snapshot, subscribe: vi.fn(() => () => {}) }, refresh = vi.fn()
  const injection = readOnlyAccountPluginInjection(source, refresh)
  expect(injection.hooks.accountPluginCatalog).toBe(source)
  expect(injection.refreshPluginCatalog).toBe(refresh)
  expect(injection.requestPluginEnabled).toBeUndefined(); expect(injection.openPluginConfiguration).toBeUndefined()
  expect(source.subscribe).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled()
})
