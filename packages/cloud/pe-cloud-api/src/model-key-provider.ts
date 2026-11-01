/** Actual native provider/settings projection selected by finite Root binding data. */
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ApprovedModelKeyConfiguration, ModelKeyMetadata } from './types.ts'
import { CloudApiError } from './errors.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { isDeepStrictEqual } from 'node:util'
import type { ProfileConfigUpdatePlan } from '@deepseek-ai/dsh-app-boot'

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
  private readonly updates = new Map<string, (ops: readonly SettingsPathOpView[]) => {
    check(): void
    approve(plan: ProfileConfigUpdatePlan): void
    finish(): void
  }>()
  /**
   * @param ctx Actual account Loader.
   * @param policy Root provider/reference selection and finite projection bounds.
   * @param maximum Original inventory budget.
   * @param webSearchSettings Whether the approved account also exposes native web provider settings.
   */
  constructor(private readonly ctx: Context, private readonly policy: ApprovedModelKeyConfiguration, private readonly maximum: number,
    private readonly webSearchSettings = false) {}
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
      let plan = entry.prepareConfigUpdate(entry.options.config)
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
      this.updates.set(binding.providerEntryId, (ops) => {
        check()
        const modelChange = ops.find(op => op.path.length === 1 && op.path[0] === 'models')
        const checkDefault = (): void => { if (modelChange !== undefined) {
          const current = this.ctx.get('agentDefaultModel')?.currentSelection()
          if (current === undefined) unavailable()
        } }
        checkDefault()
        const originalConfig: unknown = entry.options.config
        const before = structuredClone(originalConfig)
        if (!record(before) || ops.length === 0) unavailable()
        const names = new Set(ops.map(op => op.path[0]))
        let expected: unknown
        return { check: checkDefault, approve: (profile: ProfileConfigUpdatePlan) => {
          checkDefault()
          const matches = profile.entries.filter(candidate => candidate.entry === entry)
          if (matches.length !== 1 || matches[0] === undefined) unavailable()
          const candidate = entry.snapshotConfigUpdatePlan(matches[0])
          if (!record(candidate)) unavailable()
          const current = this.ctx.get('agentDefaultModel')?.currentSelection()
          if (modelChange !== undefined && current?.provider === binding.provider
            && (!Array.isArray(candidate.models) || !candidate.models.some(item => record(item) && item.id === current.model))) {
            throw new CloudApiError('cloud/forbidden', 'The current default model must remain in the provider catalog.')
          }
          expected = candidate
        }, finish: () => {
          const after: unknown = entry.options.config
          if (!record(after)) unavailable()
          const retained = (value: Record<string, unknown>): Record<string, unknown> =>
            Object.fromEntries(Object.entries(value).filter(([key]) => !names.has(key)))
          if (!isDeepStrictEqual(retained(before), retained(after))) unavailable()
          const next = entry.prepareConfigUpdate(after)
          if (next.impact !== 'none') unavailable()
          if (expected === undefined || !isDeepStrictEqual(entry.snapshotConfigUpdatePlan(next), expected)) unavailable()
          const current = this.ctx.get('agentDefaultModel')?.currentSelection()
          if (modelChange !== undefined && current?.provider === binding.provider
            && (!record(expected) || !Array.isArray(expected.models)
              || !expected.models.some(item => record(item) && item.id === current.model))) unavailable()
          const previous = plan
          plan = next
          try { check(); this.metadata() } catch (error) { plan = previous; throw error }
        } }
      })
    }
    if (this.webSearchSettings) checks.push(await this.auditWebSearch())
    this.current = () => { for (const check of checks) check() }
    this.metadata()
  }
  /** Pin the actual native search components and check their account-only credential binding. */
  private async auditWebSearch(): Promise<() => void> {
    if (!this.policy.bindings.some(binding => binding.provider === 'deepseek-official' && binding.ref === 'DEEPSEEK_API_KEY')) unavailable()
    const rows = []
    for (const entry of this.ctx.loader.entries()) { if (rows.length >= this.maximum) unavailable(); rows.push(entry) }
    const expected = [
      ['web', '@deepseek-ai/dsh-web'],
      ['web-search-deepseek', '@deepseek-ai/dsh-web-search-deepseek'],
      ['web-deepseek-api', '@deepseek-ai/dsh-web-deepseek-api'],
      ['web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'],
    ] as const
    const pinned: { entry: typeof rows[number]; fiber: NonNullable<typeof rows[number]['fiber']>; module: object; callback: unknown }[] = []
    for (const [id, name] of expected) {
      const matches = rows.filter(entry => entry.options.id === id), entry = matches[0], fiber = entry?.fiber
      if (matches.length !== 1 || entry === undefined || entry.options.name !== name || entry.disabled
        || fiber?.state !== FiberState.ACTIVE || entry.moduleNamespace === undefined) unavailable()
      const module = entry.moduleNamespace, imported: unknown = await entry.parent.tree.import(name)
      if (module !== imported || !record(module)) unavailable()
      const callback: unknown = id === 'web' ? module.default : module.apply
      if (typeof callback !== 'function' || fiber.runtime?.callback !== callback) unavailable()
      pinned.push({ entry, fiber, module, callback })
    }
    const webModule = pinned[0]?.module
    if (!record(webModule) || typeof webModule.default !== 'function') unavailable()
    const read = this.ctx.get.bind(this.ctx) as (key: string) => unknown
    const web = read('web')
    if (web === null || typeof web !== 'object' || !(original(web) instanceof (webModule.default as new (...args: never[]) => object))) unavailable()
    const settings = this.ctx.get('settings')
    if (settings === undefined) unavailable()
    return () => {
      this.ctx.fiber.assertActive()
      const currentWeb = read('web'), currentSettings = this.ctx.get('settings')
      if (currentWeb === null || typeof currentWeb !== 'object' || original(currentWeb) !== original(web)
        || currentSettings === undefined || original(currentSettings) !== original(settings)) unavailable()
      for (const row of pinned) if (row.entry.disabled || row.entry.fiber !== row.fiber || row.fiber.state !== FiberState.ACTIVE
        || row.entry.moduleNamespace !== row.module || row.fiber.runtime?.callback !== row.callback) unavailable()
      const views = settings.describe({ redactSecrets: true })
      if (views.length > this.maximum) unavailable()
      const section = (id: string) => {
        const matches = views.filter(row => row.ns === id), view = matches[0]
        if (matches.length !== 1 || view === undefined || !record(view.value)) unavailable()
        return view
      }
      const selection = section('web').value
      const messages = section('web-search-deepseek'), api = section('web-deepseek-api')
      if (!record(selection) || !record(messages.value) || !record(api.value)) unavailable()
      const selected = (selection.searchProvider === 'deepseek-official' && selection.fetchProvider === 'http')
        || (selection.searchProvider === 'deepseek-search-api' && selection.fetchProvider === 'deepseek-fetch-api')
      if (!selected || messages.value.apiKeyEnv !== 'DEEPSEEK_API_KEY' || api.value.apiKeyEnv !== 'DEEPSEEK_API_KEY'
        || messages.value.baseURL !== 'https://api.deepseek.com/anthropic/v1'
        || api.value.baseURL !== 'https://api.deepseek.com/v1/tools'
        || [messages, api].some(view => view.secrets?.some(secret => secret.path.length === 1
          && secret.path[0] === 'apiKey' && secret.set) !== false)) unavailable()
    }
  }

  /** Capture one approved native settings change before its original writer starts.
   * @param namespace Original provider settings namespace.
   * @param ops Approved native path operations.
   * @returns Checks retained through native planning and write settlement.
   */
  beginSettingsUpdate(namespace: string, ops: readonly SettingsPathOpView[]): {
    check(): void
    approve(plan: ProfileConfigUpdatePlan): void
    finish(): void
  } {
    return this.updates.get(namespace)?.(ops) ?? { check() {}, approve() {}, finish() {} }
  }
  /**
   * Read approved native providers and original redacted settings; schema/reference mappings must match.
   * @returns Bounded native metadata; settings authority is supplied separately by the account policy.
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
