/** Actual Loader/package inventory for the closed deployment catalog; approval alone never means installed. */
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { CloudApiError, type ApprovedConfigurationCatalog } from '@deepseek-ai/dsh-pe-cloud-api'
import type { BootstrapConfiguration } from './types.ts'

function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'The actual approved plugin inventory could not be confirmed.') }
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && (typeof target === 'object' || typeof target === 'function') ? target : value
}

/**
 * Match each approved public control to its actual account Loader installation and original package resolver.
 * Infrastructure omitted from this control catalog remains subject to the original API/files/execution assertions.
 * @param ctx Original account consumer scope, not a Root Loader.
 * @param catalog Original API-owned approved catalog.
 * @param current Original request/login/Root/account admission, invoked around every module await.
 * @param resolvePackages Read the original Root package provider; this specific private read also detects its withdrawal.
 * @returns Redacted configuration and a synchronous recheck of all pinned actual installations.
 */
export async function inspectBootstrapConfiguration(
  ctx: Context, catalog: ApprovedConfigurationCatalog, current: () => void, resolvePackages: () => PluginPackages | undefined,
): Promise<{ readonly configuration: BootstrapConfiguration; readonly assertCurrent: () => void }> {
  current()
  const loader = ctx.get('loader'), packages = resolvePackages()
  if (loader === undefined || !(packages instanceof PluginPackages)) unavailable()
  const resolution = packages.resolution
  const entries: Entry[] = []
  for (const entry of loader.entries()) {
    if (entries.length >= catalog.maxEntries) unavailable()
    entries.push(entry)
  }
  const leaves = entries.filter(entry => !entry.options.group)
  const facts: Array<() => void> = []
  const seen = new Set<Entry>()
  const sameOwners = (): void => {
    current()
    const currentLoader = ctx.get('loader'), currentPackages = resolvePackages()
    if (currentLoader === undefined || original(currentLoader) !== original(loader)
      || currentPackages === undefined || original(currentPackages) !== original(packages)
      || packages.resolution !== resolution) unavailable()
    let count = 0
    for (const entry of loader.entries()) {
      if (count >= entries.length || entry !== entries[count++]) unavailable()
    }
    if (count !== entries.length) unavailable()
  }
  for (const approved of catalog.plugins) {
    sameOwners()
    const matching = leaves.filter(entry => entry.id === approved.entryId), entry = matching[0]
    if (matching.length !== 1 || entry === undefined || seen.has(entry) || entry.disabled
      || entry.options.name !== approved.moduleName || entry.fiber?.state !== FiberState.ACTIVE) unavailable()
    seen.add(entry)
    const fiber = entry.fiber, namespace = entry.moduleNamespace, baseUrl = entry.parent.tree.ctx.baseUrl
    if (baseUrl === undefined || namespace === undefined || fiber.ctx.root !== ctx.root) unavailable()
    const plan = entry.prepareConfigUpdate(entry.options.config)
    if (plan.impact !== 'none') unavailable()
    const metadata = packages.packageOf(entry.options.name, baseUrl)
    if (metadata?.name !== approved.packageName || metadata.version !== approved.packageVersion) unavailable()
    const check = (): void => {
      sameOwners()
      if (entry.disabled || entry.fiber !== fiber || fiber.state !== FiberState.ACTIVE
        || entry.moduleNamespace !== namespace || entry.options.name !== approved.moduleName
        || entry.id !== approved.entryId || entry.parent.tree.ctx.baseUrl !== baseUrl
        || packages.packageOf(entry.options.name, baseUrl) !== metadata) unavailable()
      entry.assertConfigUpdatePlan(plan)
    }
    check()
    const imported: unknown = await entry.parent.tree.import(entry.options.name)
    check()
    if (imported !== namespace) unavailable()
    facts.push(check)
  }
  const assertCurrent = (): void => { sameOwners(); for (const check of facts) check() }
  assertCurrent()
  return {
    configuration: Object.freeze({ catalogVersion: catalog.catalogVersion,
      plugins: Object.freeze(catalog.plugins.map(plugin => Object.freeze({ id: plugin.id,
        installable: plugin.installable, toggleable: plugin.toggleable }))),
      skills: Object.freeze({ manage: false }), credentials: Object.freeze({ write: false }), fields: Object.freeze([]),
    }), assertCurrent,
  }
}
