/** Account-scoped Native plugin metadata and approved control source owned by Cloud. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PluginManagerSnapshot } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type { PreparedCloudPage } from '../../prepared-page.ts'
import { ClientFailure } from '../../errors.ts'
import { preparePagePluginEdit } from './page-plugin-edit.ts'
import type { AccountPluginId } from './types.ts'

/** Plugin source plus the exact approved configuration lookup for native detail slots. */
export interface CloudNativePluginIntegration {
  /** Whether package installation controls are available. */
  readonly install: boolean
  /** Read the current account catalog and refresh its admitted controls.
   * @returns Original Native bundle and plugin metadata selected by the account API.
   */
  read(): Promise<Pick<PluginManagerSnapshot, 'bundles' | 'plugins'>>
  /** Check current bundle selection permission.
   * @param name Original Native bundle name.
   * @returns Whether the current account may change its selection.
   */
  canSetBundle(name: string): boolean
  /** Check current entry activation permission.
   * @param id Original Native entry id.
   * @returns Whether the current account may change its activation.
   */
  canSetEntry(id: string): boolean
  /** Submit an admitted bundle selection.
   * @param name Original Native bundle name.
   * @param enabled Requested selection.
   */
  setBundle(name: string, enabled: boolean): Promise<void>
  /** Submit an admitted entry activation.
   * @param id Original Native entry id.
   * @param enabled Requested activation.
   */
  setEntry(id: string, enabled: boolean): Promise<void>
  /** Resolve a displayed native subject only when one approved configuration target matches. */
  configurationId(subject: PluginsSubject): AccountPluginId | undefined
}

declare module '@deepseek-ai/cordis' { interface Context { pluginManagerIntegration: CloudNativePluginIntegration } }

/** Connect native display to the guarded Cloud manager without exposing native manager RPCs.
 * @param owner Original account page fiber.
 * @param page Original page and transport lifetime.
 * @param onTerminal Withdraw or replace the original managed Shell card's actual read-only values.
 * @returns Source bound to that account and its exact approved controls.
 */
export function createNativePluginManagerIntegration(owner: Context, page: PreparedCloudPage,
  onTerminal: (limits: PluginManagerSnapshot['terminal']) => void = () => {}): CloudNativePluginIntegration {
  let controls: PluginManagerSnapshot['controls'] = []
  let bundles: PluginManagerSnapshot['bundles'] = []
  const current = (): void => { page.assertAccountManagementCurrent(owner) }
  const approved = (id: string, kind: 'entry' | 'bundle'): boolean => page.bootstrap.capabilities.configuration.plugins
    .some(item => item.id === id && (kind === 'entry' ? item.toggleable : item.installable))
  const find = (kind: 'entry' | 'bundle', target: string) => {
    try { current() } catch (_withdrawn) { return undefined }
    const matches = controls.filter(control => approved(control.id, kind)
      && control.selectionTarget.kind === kind && (control.selectionTarget.kind === 'entry'
      ? control.selectionTarget.id === target && control.operations.includes('enabled')
      : control.selectionTarget.name === target && control.operations.includes('selected')))
    return matches.length === 1 ? matches[0] : undefined
  }
  const change = async (kind: 'entry' | 'bundle', target: string, enabled: boolean): Promise<void> => {
    current()
    const control = find(kind, target)
    if (control === undefined) throw new ClientFailure('closed')
    const edit = await preparePagePluginEdit(owner, page, brandString<AccountPluginId>(control.id), page.lifetime.transport.signal)
    current()
    const operation = kind === 'entry' ? { kind: 'enabled' as const, enabled } : { kind: 'selected' as const, selected: enabled }
    const outcome = await edit.submit(operation, 'if-idle', page.lifetime.transport.signal)
    current()
    if (outcome.kind !== 'applied') throw new ClientFailure('closed')
  }
  return Object.freeze({
    install: false,
    configurationId(subject: PluginsSubject) {
      try { current() } catch (_withdrawn) { return undefined }
      if (subject.kind === 'item') return undefined
      const bundle = bundles.find(item => item.name === subject.pkg.name)
      if (bundle === undefined) return undefined
      const rows = subject.kind === 'row' ? bundle.rows.filter(row => row.rowId === subject.row.rowId
        && row.moduleName === subject.row.moduleName && row.entryId !== undefined) : []
      if (subject.kind === 'row' && rows.length !== 1) return undefined
      const matches = controls.filter(control => page.bootstrap.capabilities.configuration.plugins.some(item => item.id === control.id)
        && control.operations.includes('configure') && (subject.kind === 'bundle'
        ? control.selectionTarget.kind === 'bundle' && control.selectionTarget.name === bundle.name
        : control.selectionTarget.kind === 'entry' && control.selectionTarget.id === rows[0]?.entryId))
      return matches.length === 1 && matches[0] !== undefined ? brandString<AccountPluginId>(matches[0].id) : undefined
    },
    async read() {
      current()
      controls = []; bundles = []; onTerminal(undefined)
      const result = await owner.remote.cloudPlugins.list(page.lifetime.transport.signal)
      current()
      if (!result.ok) throw new ClientFailure('closed')
      const limits = result.value.terminal
      if (limits !== undefined && (![limits.timeoutMs, limits.maxTimeoutMs, limits.maxOutputBytes]
        .every(value => Number.isSafeInteger(value) && value > 0)
        || limits.timeoutMs > limits.maxTimeoutMs)) throw new ClientFailure('closed')
      onTerminal(limits)
      controls = result.value.controls; bundles = result.value.bundles
      return { bundles: result.value.bundles, plugins: result.value.plugins }
    },
    canSetBundle(name: string) { return find('bundle', name) !== undefined },
    canSetEntry(id: string) { return find('entry', id) !== undefined },
    setBundle(name: string, enabled: boolean) { return change('bundle', name, enabled) },
    setEntry(id: string, enabled: boolean) { return change('entry', id, enabled) },
  })
}
