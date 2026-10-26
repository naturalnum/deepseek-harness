/** Actual native provider/settings projection selected by finite Root binding data. */
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ApprovedModelKeyConfiguration, ModelKeyMetadata } from './types.ts'
import { CloudApiError } from './errors.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'

function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'The original approved model provider is unavailable or changed.') }
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function profileAt(value: unknown, path: readonly string[]): Record<string, unknown> {
  for (const key of path) {
    if (value === null || typeof value !== 'object') unavailable()
    value = Reflect.get(value, key)
  }
  if (!record(value)) unavailable()
  return value
}

/** Pinned native installations; owns no credentials, catalog, queue or lifecycle. */
export class ModelKeyProvider {
  private current: (() => void) | undefined
  /**
   * @param ctx Actual account Loader.
   * @param policy Root provider/reference selection and finite projection bounds.
   * @param maximum Original inventory budget.
   */
  constructor(private readonly ctx: Context, private readonly policy: ApprovedModelKeyConfiguration, private readonly maximum: number) {}
  /**
   * Pin actual Loader module/config/LLM/settings identities before readiness.
   * @returns Original module imports; missing or mismatched native facts reject.
   */
  async audit(): Promise<void> {
    if (this.current !== undefined) { this.metadata(); return }
    const entries = []
    for (const entry of this.ctx.loader.entries()) { if (entries.length >= this.maximum) unavailable(); entries.push(entry) }
    const llm = this.ctx.get('llm'), settings = this.ctx.get('settings'), checks: (() => void)[] = []
    if (!(llm instanceof LlmRuntime) || settings === undefined) unavailable()
    for (const binding of this.policy.bindings) {
      const matches = entries.filter(entry => entry.options.id === binding.providerEntryId), entry = matches[0]
      if (matches.length !== 1 || entry === undefined || entry.disabled || entry.fiber?.state !== FiberState.ACTIVE
        || entry.options.name !== binding.moduleName || entry.moduleNamespace === undefined) unavailable()
      const fiber = entry.fiber, namespace = entry.moduleNamespace, callback = fiber.runtime?.callback
      const plan = entry.prepareConfigUpdate(entry.options.config)
      if (plan.impact !== 'none' || callback === undefined) unavailable()
      const check = (): void => {
        this.ctx.fiber.assertActive()
        if (entry.disabled || entry.fiber !== fiber || fiber.state !== FiberState.ACTIVE || fiber.ctx.root !== this.ctx.root
          || entry.moduleNamespace !== namespace || entry.options.name !== binding.moduleName
          || entry.options.id !== binding.providerEntryId || fiber.runtime?.callback !== callback
          || original(this.ctx.get('llm') ?? {}) !== original(llm)
          || original(this.ctx.get('settings') ?? {}) !== original(settings)) unavailable()
        entry.assertConfigUpdatePlan(plan)
      }
      check()
      const imported: unknown = await entry.parent.tree.import(entry.options.name)
      check()
      for (const previous of checks) previous()
      if (imported !== namespace) unavailable()
      checks.push(check)
    }
    this.current = () => { for (const check of checks) check() }
    this.metadata()
  }
  /**
   * Read approved native providers and original redacted settings; schema/reference mappings must match.
   * @returns Bounded native metadata with settings writes closed; no secret values or replacement catalog.
   */
  metadata(): ModelKeyMetadata {
    if (this.current === undefined) unavailable()
    this.current()
    const llm = this.ctx.get('llm'), settings = this.ctx.get('settings')
    if (!(llm instanceof LlmRuntime) || settings === undefined) unavailable()
    const providers = llm.listProviders(), routes = llm.listConfigurableProviders(), rows = settings.describe({ redactSecrets: true })
    const entries = []
    for (const entry of this.ctx.loader.entries()) { if (entries.length >= this.maximum) unavailable(); entries.push(entry) }
    if (providers.length > this.maximum || routes.length > this.maximum || rows.length > this.maximum) unavailable()
    const metadata: ModelKeyMetadata = { providers: [], configurableProviders: [],
      settings: { writable: false, hasDocument: false, namespaces: [] } }
    for (const binding of this.policy.bindings) {
      const selected = providers.filter(row => row.id === binding.provider), provider = selected[0]
      const selectedRoutes = routes.filter(row => row.provider === binding.provider), route = selectedRoutes[0]
      if (selected.length !== 1 || provider === undefined || selectedRoutes.length !== 1 || route === undefined
        || route.settingsNs !== binding.providerEntryId || route.settingsPath.length > this.maximum) unavailable()
      const selectedRows = rows.filter(row => row.ns === route.settingsNs), row = selectedRows[0]
      const selectedEntries = entries.filter(value => value.options.id === binding.providerEntryId), entry = selectedEntries[0]
      if (selectedEntries.length !== 1) unavailable()
      const schema = entry?.fiber?.runtime?.Config
      if (selectedRows.length !== 1 || row === undefined || schema === undefined || !('toJSON' in schema)) unavailable()
      let node: z | undefined = schema as z
      for (const key of [...route.settingsPath, 'apiKeyEnv']) {
        if (node?.type === 'object') node = node.dict?.[key]
        else if (node?.type === 'dict' || node?.type === 'array') node = node.inner
        else unavailable()
      }
      if (node?.meta.role !== 'credential-ref' || profileAt(row.value, route.settingsPath).apiKeyEnv !== binding.ref) unavailable()
      firstScreenJsonBytes(row, this.policy.maxMetadataBytes)
      metadata.providers.push(provider)
      metadata.configurableProviders.push(route)
      if (!metadata.settings.namespaces.some(value => value.ns === row.ns)) metadata.settings.namespaces.push({
        autoGenerate: row.autoGenerate, ns: row.ns, schema: row.schema as JsonValue, value: row.value as JsonValue,
        ...row.base === undefined ? {} : { base: row.base as JsonValue },
        ...row.user === undefined ? {} : { user: row.user as JsonValue },
        applies: row.applies, secrets: row.secrets ?? [], revision: row.revision,
      })
    }
    firstScreenJsonBytes(metadata, this.policy.maxMetadataBytes)
    this.current()
    return metadata
  }
  /**
   * Check one approved bootstrap route without credential discovery.
   * @param provider Root provider.
   * @param model Root model.
   */
  assertProvisionable(provider: string, model: string): void {
    const metadata = this.metadata(), route = metadata.configurableProviders.find(row => row.provider === provider)
    const row = metadata.settings.namespaces.find(value => value.ns === route?.settingsNs)
    if (route === undefined || row === undefined) unavailable()
    const profile = profileAt(row.value, route.settingsPath)
    if (!Array.isArray(profile.models) || !profile.models.some(value => record(value) && value.id === model)) unavailable()
    this.current?.()
  }
}
