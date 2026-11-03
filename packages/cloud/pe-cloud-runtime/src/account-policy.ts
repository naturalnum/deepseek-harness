/** One account's concrete project/model/Preset checks over original native services; this issues no ready state. */
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-terminal'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentLoop, { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CloudApiError, type ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import { CloudAccountFiles, type AccountFileSelection } from '@deepseek-ai/dsh-pe-cloud-files'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { scopeChainOf, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { SessionId, type Session, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-working-directory'
import SubagentRuntime, { delegationDepthOf, resolveChildAgentOptions, resolveChildDepth, type SubagentAdmissionRequest } from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import type { AccountBinding } from './types.ts'
import { ACCOUNT_NATIVE_ENTRIES, type AccountNativeGuards } from './account-native-integration.ts'
import { createAccountFileMutationGuard } from './account-permissions.ts'
import type { FileReadTiming } from './file-read-timing.ts'

/** One Root-approved native declaration; nonselectable rows retain historical Session recovery only. */
export interface AccountPresetPolicy {
  readonly id: string
  readonly entryId: string
  readonly configSha256: string
  readonly selectable: boolean
}

/** Explicit deployment declarations and finite exact model routes. */
export interface AccountPolicyConfig {
  readonly maxModelRoutes: number
  readonly maxPolicyStringBytes: number
  readonly models: { readonly provider: string; readonly model: string }[]
  readonly defaultPresetId: string
  readonly presets: AccountPresetPolicy[]
  readonly maxPresetConfigBytes: number
  readonly agentLoopEntryId: string
}

type Entry = NonNullable<Fiber['entry']>
type EntryFact = { readonly entry: Entry; readonly fiber: Fiber; readonly plan: ReturnType<Entry['prepareConfigUpdate']>; readonly module: unknown }
type Agent = Parameters<AccountNativeGuards['agents']['assertPrepared']>[0]
type Selection = { readonly provider?: string; readonly model?: string }
type Header = Pick<SessionHeader, 'cwd' | 'origin' | 'parentSession' | 'delegationDepth'> & { readonly isSeeded?: boolean }
type ChildPreparation = {
  readonly child: Agent
  readonly session: Session
  readonly fiber: Fiber
  readonly parent: Agent
  readonly generation: object
  readonly workspace: Workspace
  readonly signal: AbortSignal
  readonly directoryPreparation: Readonly<{ assertCaller(caller: Context): void }>
  active: boolean
}

function refuse(): never { throw new CloudApiError('cloud/forbidden', 'The account project or Agent preset is not approved.') }
function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'The account policy requires its original native providers.') }
function modelDenied(): never { throw new CloudApiError('cloud/model-not-allowed', 'The model route is not approved and available for this account.') }
function object(value: unknown): value is object { return value !== null && typeof value === 'object' }
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return object(target) ? target : value
}

/**
 * Hash a finite native declaration with sorted object keys; Native expression source is retained without evaluation.
 * @param input Actual resolved native declaration, or the same trusted deployment JSON when computing its expectation.
 * @param maxBytes Explicit upper bound on the canonical UTF-8 input; traversal retains at most that finite input.
 * @returns Lowercase SHA-256; this expectation alone is never an installation or readiness certificate.
 */
export function accountPresetConfigDigest(input: unknown, maxBytes: number): string {
  const hash = createHash('sha256')
  const seen = new WeakSet<object>()
  const stack: ({ kind: 'value'; value: unknown } | { kind: 'text'; value: string })[] = [{ kind: 'value', value: input }]
  let bytes = 0
  while (stack.length !== 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    if (frame.kind === 'text') {
      bytes += Buffer.byteLength(frame.value)
      if (bytes > maxBytes) refuse()
      hash.update(frame.value)
      continue
    }
    const value = frame.value
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      stack.push({ kind: 'text', value: JSON.stringify(value) })
    } else if (typeof value === 'string') {
      if (value.length > maxBytes) refuse()
      stack.push({ kind: 'text', value: JSON.stringify(value) })
    } else if (object(value)) {
      if (seen.has(value)) refuse()
      if (isJsExpr(value) && (Object.keys(value).length !== 1 || typeof value.__jsExpr !== 'string')) refuse()
      seen.add(value)
      if (Array.isArray(value)) {
        if (value.length > maxBytes) refuse()
        stack.push({ kind: 'text', value: ']' })
        for (let index = value.length - 1; index >= 0; index--) {
          stack.push({ kind: 'value', value: value[index] })
          if (index !== 0) stack.push({ kind: 'text', value: ',' })
        }
        stack.push({ kind: 'text', value: '[' })
      } else {
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) refuse()
        const keys: string[] = []
        for (const key in value) {
          if (!Object.hasOwn(value, key) || Reflect.get(value, key) === undefined) continue
          if (keys.length >= maxBytes || key.length > maxBytes) refuse()
          keys.push(key)
        }
        keys.sort()
        stack.push({ kind: 'text', value: '}' })
        for (let index = keys.length - 1; index >= 0; index--) {
          const key = keys[index]
          if (key === undefined || key.length > maxBytes) refuse()
          stack.push({ kind: 'value', value: Reflect.get(value, key) })
          stack.push({ kind: 'text', value: ':' }, { kind: 'text', value: JSON.stringify(key) })
          if (index !== 0) stack.push({ kind: 'text', value: ',' })
        }
        stack.push({ kind: 'text', value: '{' })
      }
    } else refuse()
    if (stack.length > maxBytes) refuse()
  }
  return hash.digest('hex')
}

/**
 * Check one native Web provider change against the two complete supported pairs.
 * @param view Actual current and inherited native provider selections.
 * @param ops Original native settings operations proposed for this selection.
 * @returns Whether the complete effective selection is an approved provider pair.
 */
export function webSearchSelectionAllowed(view: { readonly value: unknown; readonly base?: unknown },
  ops: readonly SettingsPathOpView[]): boolean {
  if (!object(view.value) || !object(view.base)) return false
  const selected: Record<string, unknown> = { searchProvider: Reflect.get(view.value, 'searchProvider'),
    fetchProvider: Reflect.get(view.value, 'fetchProvider') }
  for (const op of ops) {
    const field = op.path[0]
    if (op.path.length !== 1 || (field !== 'searchProvider' && field !== 'fetchProvider')) return false
    selected[field] = op.op === 'set' ? op.value : Reflect.get(view.base, field)
  }
  return (selected.searchProvider === 'deepseek-official' && selected.fetchProvider === 'http')
    || (selected.searchProvider === 'deepseek-search-api' && selected.fetchProvider === 'deepseek-fetch-api')
}

/**
 * Compare a reset with the actual inherited native value and its finite approved domain.
 * @param settings Original account settings registry.
 * @param namespace Approved native settings namespace.
 * @param field Field whose override is being cleared.
 * @param values Root-approved finite values for the field.
 * @returns Whether the inherited native value remains in the approved domain.
 */
export function webSearchResetAllowed(settings: Context['settings'], namespace: string, field: string,
  values: readonly (string | number | boolean | null)[]): boolean {
  const matches = settings.describe({ redactSecrets: true }).filter(row => row.ns === namespace), base = matches[0]?.base
  if (matches.length !== 1 || !object(base)) return false
  return values.some(value => Object.is(value, Reflect.get(base, field)))
}

class AccountPolicy {
  private facts: readonly EntryFact[] | undefined
  private readonly modules = new Map<string, readonly string[]>()
  private readonly providers = new Map<string, object>()
  private readonly childPreparations = new Map<object, ChildPreparation>()
  private readonly settingsUpdates = new AsyncLocalStorage<{ readonly fact: EntryFact; refresh(): EntryFact }>()
  private activeSettingsUpdate: object | undefined
  private unknownSettingsUpdate = false

  constructor(
    private readonly ctx: Context, private readonly binding: AccountBinding, private readonly files: CloudAccountFiles,
    private readonly config: AccountPolicyConfig, private readonly exposure: ExposureService['policy'], private readonly maxEntries: number,
    private readonly provisionableModel?: (provider: string, model: string) => void,
    private readonly assertBusinessCurrent?: (binding: AccountBinding) => void,
    private readonly fileReadTiming?: FileReadTiming,
  ) {
    if (config.presets.length === 0 || config.presets.length > maxEntries) refuse()
  }

  current(): void {
    if (this.fileReadTiming !== undefined) {
      this.fileReadTiming.measure('account-current', () => { this.currentActual() })
      return
    }
    this.currentActual()
  }

  private currentActual(): void {
    this.ctx.fiber.assertActive()
    if (this.binding.lifetime.aborted || this.ctx.get('peAccount') !== this.binding || this.ctx.root.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The account policy belongs to an ended graph.')
    }
    if (this.unknownSettingsUpdate || (this.activeSettingsUpdate !== undefined
      && this.settingsUpdates.getStore() !== this.activeSettingsUpdate)) unavailable()
    this.files.assertInstalled(this.ctx)
    for (const [key, expected] of this.providers) {
      const actual: unknown = this.ctx.get(key)
      if (!object(actual) || original(actual) !== expected) unavailable()
      if (key === 'agentPresets' && actual instanceof AgentPresets
        && (actual.config.default !== this.config.defaultPresetId || !this.approvedPreset(actual.defaultId).selectable)) refuse()
      if (key === 'agentLoop' && actual instanceof AgentLoop && actual.config.agents.length !== 0) refuse()
    }
    for (const fact of this.facts ?? []) {
      if (fact.entry.fiber !== fact.fiber || fact.fiber.state !== FiberState.ACTIVE
        || fact.entry.moduleNamespace !== fact.module) unavailable()
      try {
        this.assertPlanCurrent(fact)
      }
      catch (_cause) {
        const update = this.settingsUpdates.getStore()
        if (update?.fact !== fact) unavailable()
        const next = update.refresh()
        try {
          this.assertPlanCurrent(next)
        } catch (_invalid) { unavailable() }
      }
    }
  }

  private assertPlanCurrent(fact: EntryFact): void {
    const check = (): void => { if (!fact.entry.isConfigPlanVersionCurrent(fact.plan)) unavailable() }
    if (this.fileReadTiming === undefined) check()
    else this.fileReadTiming.measure('account-plan', check)
  }

  private provider<K extends string & keyof Context>(key: K): NonNullable<Context[K]> {
    const value = this.ctx.get(key)
    if (!object(value)) unavailable()
    const expected = this.providers.get(key)
    if (expected !== undefined && original(value) !== expected) unavailable()
    this.providers.set(key, original(value))
    return value
  }

  project() {
    this.current()
    const project = this.files.project()
    const registry = this.provider('workspaceRegistry')
    if (project.binding !== this.binding || project.projectDirectory.binding !== this.binding
      || registry.get(project.workspace.id) !== project.workspace) refuse()
    return project
  }

  assertWorkspace(workspace: Workspace): void {
    this.current()
    this.assertWorkspaceIdentity(workspace)
  }

  private assertWorkspaceIdentity(workspace: Workspace): void {
    if (this.provider('workspaceRegistry').get(workspace.id) !== workspace) refuse()
  }

  workspaceAt(cwd: string | undefined): Workspace {
    this.current()
    return this.workspaceAtCurrent(cwd)
  }

  /** The caller has checked account current in this synchronous operation. */
  private workspaceAtCurrent(cwd: string | undefined): Workspace {
    if (cwd === undefined) refuse()
    const matches = this.provider('workspaceRegistry').list().filter(workspace => workspace.path === cwd)
    const workspace = matches[0]
    if (matches.length !== 1 || workspace === undefined) refuse()
    this.assertWorkspaceIdentity(workspace)
    return workspace
  }

  private member(id: SessionId): Workspace | undefined {
    this.current()
    const workspace = this.memberCurrent(id)
    if (workspace !== undefined) this.assertWorkspace(workspace)
    return workspace
  }

  /** Resolve membership after the same synchronous admission; the public caller rechecks before returning. */
  private memberCurrent(id: SessionId): Workspace | undefined {
    const matches = this.provider('workspaceRegistry').list().filter(workspace => workspace.sessionIds.includes(id))
    if (matches.length > 1) refuse()
    const workspace = matches[0]
    if (workspace !== undefined) this.assertWorkspaceIdentity(workspace)
    return workspace
  }

  private approvedPreset(id: string | null | undefined, selectable = false): AccountPresetPolicy {
    const selected = this.config.presets.find(row => row.id === id)
    if (selected === undefined || selectable && !selected.selectable) refuse()
    return selected
  }

  selectablePreset(id: string): boolean {
    this.current()
    return this.config.presets.some(row => row.id === id && row.selectable)
  }

  private sessionPreset(session: Session): string {
    this.approvedPreset(session.header.agentPreset)
    return this.approvedPreset(this.provider('sessionProjections').stateOf(session, 'agentPreset')).id
  }

  observedProject(id: SessionId, header: SessionHeader): Workspace {
    this.current()
    const workspace = this.memberCurrent(id)
    if (workspace === undefined || header.id !== id) refuse()
    this.approvedPreset(header.agentPreset)
    this.sessionHeader(header, workspace.path)
    const needsFinalAudit = header.origin === 'subagent' || this.facts === undefined
    if (header.origin === 'subagent') { this.spawn(); if (header.parentSession === id) refuse() }
    if (this.facts === undefined) this.pin()
    if (needsFinalAudit) this.assertWorkspace(workspace)
    else this.assertWorkspaceIdentity(workspace)
    return workspace
  }

  private sessionProject(session: Session, attached: boolean): Workspace {
    this.current()
    return this.sessionProjectCurrent(session, attached)
  }

  /** The caller has checked account current in this synchronous operation. */
  private sessionProjectCurrent(session: Session, attached: boolean): Workspace {
    const workspace = this.workspaceAtCurrent(session.header.cwd)
    if (session.id !== session.header.id) refuse()
    this.sessionPreset(session)
    this.sessionHeader(session.header, workspace.path)
    if (this.provider('workingDirectory').get(session) !== workspace.path) refuse()
    if (attached && (this.provider('sessions').get(session.id) !== session || this.memberCurrent(session.id) !== workspace)) refuse()
    return workspace
  }

  liveSessionProject(session: Session): Workspace {
    this.current()
    const workspace = this.sessionProjectCurrent(session, true)
    const agent = this.provider('agents').get(session.id)
    if (agent !== undefined && (agent.session !== session || this.preparedCurrent(agent, true) !== workspace)) refuse()
    return workspace
  }

  async directory(workspace: Workspace, signal?: AbortSignal) {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    this.assertWorkspace(workspace)
    const project = await this.files.projectFor(workspace, control)
    await project.projectDirectory.prepare(workspace.path)
    control.throwIfAborted()
    this.assertWorkspace(workspace)
    if (project.binding !== this.binding || project.workspace !== workspace || project.projectDirectory.binding !== this.binding) refuse()
    return project
  }

  private pin(): void {
    this.current()
    if (this.facts !== undefined) return
    const entries: Entry[] = []
    for (const row of this.ctx.loader.entries()) {
      if (entries.length >= this.maxEntries) refuse()
      entries.push(row)
    }
    const fact = (id: string): EntryFact => {
      const matches = entries.filter(row => row.options.id === id), entry = matches[0], fiber = entry?.fiber
      if (matches.length !== 1 || entry === undefined || fiber?.state !== FiberState.ACTIVE) unavailable()
      const plan = entry.prepareConfigUpdate(entry.options.config)
      if (plan.impact !== 'none') unavailable()
      return { entry, fiber, plan, module: entry.moduleNamespace }
    }
    const declarations = this.config.presets.map((selected) => {
      const preset = fact(selected.entryId)
      if (preset.fiber.runtime?.callback !== AgentPreset || !object(preset.fiber.config)
        || Reflect.get(preset.fiber.config, 'id') !== selected.id
        || accountPresetConfigDigest(preset.fiber.config, this.config.maxPresetConfigBytes) !== selected.configSha256) refuse()
      return preset
    })
    const loop = fact(this.config.agentLoopEntryId)
    const nativeLoop = this.provider('agentLoop')
    if (!(nativeLoop instanceof AgentLoop) || nativeLoop.config.agents.length !== 0
      || loop.entry.options.name !== 'cordis:' + ACCOUNT_NATIVE_ENTRIES.agentLoop
      || loop.fiber.store?.agentLoop?.fiber !== loop.fiber
      || !object(loop.fiber.store.agentLoop.value) || original(loop.fiber.store.agentLoop.value) !== original(nativeLoop)) unavailable()
    const nativePresets = this.provider('agentPresets')
    const registryEntries = entries.filter(entry => entry.fiber?.store?.agentPresets?.fiber === entry.fiber
      && object(entry.fiber?.store?.agentPresets?.value)
      && original(entry.fiber.store.agentPresets.value) === original(nativePresets))
    const registryEntry = registryEntries[0]
    if (!(nativePresets instanceof AgentPresets) || registryEntries.length !== 1 || registryEntry === undefined
      || registryEntry.options.id !== 'agent-preset-registry') unavailable()
    const registry = fact(registryEntry.options.id)
    const facts = [...declarations, loop, registry]
    try { for (const fact of facts) {
      if (fact.entry.fiber !== fact.fiber || fact.fiber.state !== FiberState.ACTIVE
        || fact.entry.moduleNamespace !== fact.module || !fact.entry.isConfigPlanVersionCurrent(fact.plan)) unavailable()
      fact.entry.assertConfigUpdatePlan(fact.plan)
    } }
    catch (_invalid) { unavailable() }
    this.current()
    // The last full validation can reenter native code; finish without invoking callbacks.
    for (const fact of facts) {
      if (fact.entry.fiber !== fact.fiber || fact.fiber.state !== FiberState.ACTIVE
        || fact.entry.moduleNamespace !== fact.module || !fact.entry.isConfigPlanVersionCurrent(fact.plan)) unavailable()
    }
    this.facts = facts
  }

  /** Read the actual native inherited setting; the registry's absent override resolves through its approved default. */
  private inheritedSetting(namespace: string, field: string): unknown {
    const settings = this.ctx.get('settings')
    if (settings === undefined) unavailable()
    const matches = settings.describe({ redactSecrets: true }).filter(row => row.ns === namespace), base = matches[0]?.base
    if (matches.length !== 1 || !object(base)) unavailable()
    return Reflect.get(base, field)
  }

  private approvedSetting(namespace: string, value: unknown): string | number {
    if (namespace === 'agent-preset-registry') {
      if (value !== undefined && typeof value !== 'string') refuse()
      return this.approvedPreset(value ?? this.config.defaultPresetId, true).id
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1
      || value > DEFAULT_MAX_PARALLEL_TOOL_CALLS) refuse()
    return value
  }

  allowSettingsUnset(namespace: string, field: string, values: readonly (string | number | boolean | null)[]): boolean {
    const webFields: Record<string, readonly string[]> = { web: ['searchProvider', 'fetchProvider'],
      'web-search-deepseek': ['baseURL'], 'web-deepseek-api': ['baseURL'] }
    if (webFields[namespace]?.includes(field) === true
      && this.exposure.manifest.allowedSettings.some(row => row.namespace === 'web-search-deepseek')) {
      this.pin()
      if (!this.exposure.manifest.allowedSettings.some(row => row.namespace === namespace && row.fields.includes(field))) return false
      const settings = this.ctx.get('settings')
      if (settings === undefined) unavailable()
      return webSearchResetAllowed(settings, namespace, field, values)
    }
    if (!(namespace === this.config.agentLoopEntryId && field === 'maxParallelToolCalls')
      && !(namespace === 'agent-preset-registry' && field === 'selectedDefault')) return false
    this.pin()
    if (!this.exposure.manifest.allowedSettings.some(row => row.namespace === namespace && row.fields.includes(field))) return false
    const inherited = this.approvedSetting(namespace, this.inheritedSetting(namespace, field))
    return values.some(value => Object.is(value, inherited))
  }

  beginSettingsUpdate(
    namespace: string, ops: Parameters<NonNullable<AccountNativeGuards['beginSettingsUpdate']>>[1],
    fields: Parameters<NonNullable<AccountNativeGuards['beginSettingsUpdate']>>[2],
  ): ReturnType<NonNullable<AccountNativeGuards['beginSettingsUpdate']>> {
    if (this.activeSettingsUpdate !== undefined) refuse()
    if (namespace === 'web' && this.exposure.manifest.allowedSettings.some(row => row.namespace === 'web-search-deepseek')) {
      this.current()
      const settings = this.ctx.get('settings')
      if (settings === undefined) unavailable()
      const matches = settings.describe({ redactSecrets: true }).filter(row => row.ns === 'web'), view = matches[0]
      if (matches.length !== 1 || view === undefined) unavailable()
      if (!webSearchSelectionAllowed(view, ops)) refuse()
    }
    if (namespace !== this.config.agentLoopEntryId && namespace !== 'agent-preset-registry') {
      return { check() {}, approve() {}, finish() {}, publish: (audit) => { audit() }, abort() {}, run: operation => operation() }
    }
    this.pin()
    const fieldName = namespace === 'agent-preset-registry' ? 'selectedDefault' : 'maxParallelToolCalls'
    const serviceKey = namespace === 'agent-preset-registry' ? 'agentPresets' : 'agentLoop'
    if (!this.exposure.manifest.allowedSettings.some(row => row.namespace === namespace
      && row.fields.includes(fieldName))) refuse()
    const op = ops[0]
    if (ops.length !== 1 || op === undefined || op.path.length !== 1 || op.path[0] !== fieldName) refuse()
    const rawValue = op.op === 'unset' ? this.inheritedSetting(namespace, fieldName) : op.value
    const value = this.approvedSetting(namespace, rawValue)
    const approved = fields.filter(field => field.namespace === namespace && field.field === fieldName)
    if (approved.length !== 1 || approved[0]?.values === undefined
      || !approved[0].values.some(candidate => Object.is(candidate, value))) refuse()
    const facts = this.facts, setting = facts?.find(fact => serviceKey === 'agentLoop'
      ? fact.entry.options.id === this.config.agentLoopEntryId
      : fact.fiber.store?.agentPresets?.fiber === fact.fiber)
    if (facts === undefined || setting === undefined || !object(setting.entry.options.config)) unavailable()
    const runtime = setting.fiber.runtime, schema = runtime?.Config, service = this.provider(serviceKey)
    if (schema === undefined || !(service instanceof AgentLoop || service instanceof AgentPresets)) unavailable()
    const serialize: unknown = Reflect.get(schema, 'toJSON')
    if (typeof serialize !== 'function') unavailable()
    const schemaBefore: unknown = structuredClone(Reflect.apply(serialize, schema, [])), serviceBefore = original(service)
    const before = structuredClone(setting.entry.options.config) as Record<string, unknown>
    const retained = (config: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(config).filter(([key]) => key !== fieldName))
    let expected: unknown, updated: EntryFact | undefined, publishedFacts: readonly EntryFact[] | undefined
    let active = false, used = false, prepared = false, published = false
    const check = (): void => {
      if (this.facts !== facts && this.facts !== publishedFacts) unavailable()
      this.current()
    }
    const refresh = (): EntryFact => {
      if (!active || this.settingsUpdates.getStore()?.fact !== setting) unavailable()
      this.ctx.fiber.assertActive()
      if (this.binding.lifetime.aborted || this.facts !== facts || this.activeSettingsUpdate !== token || this.ctx.get('peAccount') !== this.binding
        || this.ctx.root.get('peAccount') !== this.binding || setting.entry.fiber !== setting.fiber
        || setting.fiber.state !== FiberState.ACTIVE || setting.entry.moduleNamespace !== setting.module
        || setting.fiber.runtime !== runtime || runtime?.Config !== schema || Reflect.get(schema, 'toJSON') !== serialize
        || !isDeepStrictEqual(Reflect.apply(serialize, schema, []), schemaBefore)) unavailable()
      const after: unknown = setting.entry.options.config
      if (!object(after) || !isDeepStrictEqual(retained(before), retained(after as Record<string, unknown>))
        || expected === undefined) unavailable()
      const next = setting.entry.prepareConfigUpdate(after)
      if (next.impact !== 'none' || !isDeepStrictEqual(setting.entry.snapshotConfigUpdatePlan(next), expected)) unavailable()
      const actual = this.ctx.get(serviceKey), installed = setting.fiber.store?.[serviceKey]
      if (!(actual instanceof AgentLoop || actual instanceof AgentPresets) || original(actual) !== serviceBefore
        || installed?.fiber !== setting.fiber || !object(installed.value) || original(installed.value) !== serviceBefore
        || (actual instanceof AgentLoop ? actual.config.maxParallelToolCalls.get() : actual.defaultId) !== value) unavailable()
      if (updated !== undefined) {
        try { updated.entry.assertConfigUpdatePlan(updated.plan) } catch (_invalid) { unavailable() }
      } else updated = { ...setting, plan: next }
      return updated
    }
    const token = { fact: setting, refresh }
    return {
      check,
      approve: (profile) => {
        check()
        const matches = profile.entries.filter(plan => plan.entry === setting.entry)
        const plan = matches[0]
        if (matches.length !== 1 || plan === undefined || (plan.impact !== 'live' && plan.impact !== 'none')) unavailable()
        const candidate = setting.entry.snapshotConfigUpdatePlan(plan)
        if (!object(candidate) || !Object.is(Reflect.get(candidate, fieldName), rawValue)) unavailable()
        expected = candidate
      },
      finish: () => {
        if (prepared || published) unavailable()
        refresh(); this.current()
        if (this.facts !== facts) unavailable()
        prepared = true
      },
      publish: (audit) => { this.settingsUpdates.run(token, () => {
        try {
          if (!prepared || published || !active || this.activeSettingsUpdate !== token || this.facts !== facts) unavailable()
          refresh(); this.current(); audit()
          const next = refresh()
          this.current()
          if (this.facts !== facts || this.activeSettingsUpdate !== token) unavailable()
          publishedFacts = facts.map(fact => fact === setting ? next : fact)
          this.facts = publishedFacts
          published = true
        } catch (error) { this.unknownSettingsUpdate = true; throw error }
        finally { active = false; if (this.activeSettingsUpdate === token) this.activeSettingsUpdate = undefined }
      }) },
      abort: (uncertain = false) => {
        if (uncertain) this.unknownSettingsUpdate = true
        active = false
        if (this.activeSettingsUpdate === token) this.activeSettingsUpdate = undefined
      },
      run: async (operation) => {
        if (active || used || this.activeSettingsUpdate !== undefined) unavailable()
        used = true; active = true; this.activeSettingsUpdate = token
        try { return await this.settingsUpdates.run(token, operation) }
        catch (error) { this.unknownSettingsUpdate = true; throw error }
        finally {
          if (!prepared) {
            active = false
            if (this.activeSettingsUpdate === token) this.activeSettingsUpdate = undefined
          }
        }
      },
    }
  }

  async preset(id: string | undefined, signal?: AbortSignal, selectable = false): Promise<string> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    this.pin()
    const presets = this.provider('agentPresets')
    if (!(presets instanceof AgentPresets) || presets.config.default !== this.config.defaultPresetId) refuse()
    const selected = this.approvedPreset(id ?? presets.defaultId, selectable || id === undefined)
    this.approvedPreset(presets.defaultId, true)
    const resolved = await presets.resolve(selected.id)
    control.throwIfAborted()
    this.current()
    if (resolved.id !== selected.id || resolved.broken !== undefined) refuse()
    const inventory = await presets.compositionInventory()
    control.throwIfAborted()
    this.current()
    if (inventory.length !== this.config.presets.length) refuse()
    const nextModules = new Map<string, readonly string[]>()
    for (const row of inventory) {
      this.approvedPreset(row.id)
      if (nextModules.has(row.id) || row.broken !== undefined
        || row.isDefault !== (row.id === presets.defaultId) || row.rows.length > this.maxEntries
        || row.rows.some(child => child.enabled === 'conditional'
          || child.enabled && child.fiberState !== FiberState.ACTIVE)) refuse()
      const modules = row.rows.filter(child => child.enabled).map(child => child.moduleName)
      const previous = this.modules.get(row.id)
      if (previous !== undefined && (modules.length !== previous.length
        || modules.some((name, i) => previous[i] !== name))) refuse()
      nextModules.set(row.id, previous ?? Object.freeze(modules))
    }
    for (const [key, modules] of nextModules) this.modules.set(key, modules)
    return selected.id
  }

  allowedModel(provider: string, model: string): boolean {
    this.current()
    return this.allowedModelCurrent(provider, model)
  }

  /** The caller has checked account current in this synchronous operation. */
  private allowedModelCurrent(provider: string, model: string): boolean {
    if (!this.config.models.some(row => row.provider === provider && row.model === model)) return false
    const llm = this.provider('llm')
    return llm instanceof LlmRuntime && llm.listProviders().some(row => row.id === provider)
  }

  defaultModel(): Selection {
    this.current()
    return this.provider('agentDefaultModel').currentSelection()
  }

  async model(selection: Selection | undefined, signal?: AbortSignal): Promise<void> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    const { provider, model } = selection ?? {}
    if (provider === undefined || model === undefined || !this.allowedModel(provider, model)) modelDenied()
    const resolved = await this.provider('llm').resolveModelInfo(provider, model, control)
    control.throwIfAborted()
    this.current()
    if (resolved.provider !== provider || resolved.id !== model || !this.allowedModel(provider, model)) modelDenied()
  }

  delegatedFilePolicy(child: Agent, parent: Agent): void {
    this.current()
    if (this.provider('peAccountExecution').enforcesSessionFilePolicy !== true) return
    const policy = this.provider('sandboxPolicy')
    const inherited = policy.resolve({ session: parent.session }), selected = policy.resolve({ session: child.session })
    if (inherited.sessionId !== parent.id || selected.sessionId !== child.id
      || inherited.workspaceRoot !== selected.workspaceRoot
      || !['read-only', 'workspace-write', 'danger-full-access'].includes(inherited.mode)
      || !['read-only', 'workspace-write', 'danger-full-access'].includes(selected.mode)
      || ['read-only', 'workspace-write', 'danger-full-access'].indexOf(selected.mode)
        > ['read-only', 'workspace-write', 'danger-full-access'].indexOf(inherited.mode)) {
      throw new CloudApiError('cloud/forbidden', 'A child Agent cannot widen its parent\'s current file permissions.')
    }
  }

  async assertBootstrapCurrent(signal?: AbortSignal): Promise<void> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    const project = this.project(), { provider, model } = this.defaultModel()
    if (provider === undefined || model === undefined) modelDenied()
    const selection = { provider, model }
    const filesSelected = this.exposure.manifest.rpcEndpoints.some(row => row.endpoint.startsWith('workspaceFiles/')
      || row.endpoint === 'officeToPdf/render')
      || this.exposure.manifest.streamEndpoints.some(row => row.endpoint.startsWith('workspaceFiles/'))
    if (filesSelected) this.files.assertContentAvailable()
    this.handlers('native:sessionController')
    await this.preset(undefined, control)
    if (this.provisionableModel === undefined) await this.model(selection, control)
    else {
      if (!this.allowedModel(provider, model)) modelDenied()
      this.provisionableModel(provider, model)
    }
    control.throwIfAborted()
    this.current()
    const current = this.defaultModel()
    if (this.project() !== project || current.provider !== selection.provider || current.model !== selection.model) unavailable()
    if (filesSelected) this.files.assertContentAvailable()
    this.handlers('native:sessionController')
  }

  private sessionHeader(header: Header, path: string): void {
    if (header.origin === 'subagent') {
      if (header.cwd !== path || header.parentSession === undefined
        || !Number.isSafeInteger(header.delegationDepth) || (header.delegationDepth ?? 0) < 1) refuse()
    } else this.header(header, path)
  }

  header(header: Header, path: string): void {
    if (header.cwd !== path || header.origin !== undefined || header.parentSession !== undefined
      || (header.delegationDepth ?? 0) !== 0 || header.isSeeded) refuse()
  }

  async history(
    id: SessionId, signal?: AbortSignal, mode: 'member' | 'create-probe' = 'member', expected?: Workspace,
  ): Promise<Workspace> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    const member = this.member(id)
    if ((mode === 'member' && member === undefined) || (member !== undefined && expected !== undefined && member !== expected)) refuse()
    const workspace = member ?? expected
    if (workspace === undefined) refuse()
    await this.directory(workspace, control)
    const query = this.provider('sessionQuery')
    using observed = await query.observeSession(id, { projectionMode: 'all', signal: control })
    control.throwIfAborted()
    this.current()
    this.header(observed.header, workspace.path)
    if (this.observedProject(id, observed.header) !== workspace
      || observed.projections?.values.workingDirectory !== workspace.path) refuse()
    const presetId = this.approvedPreset(observed.projections.values.agentPreset).id
    await this.preset(presetId, control)
    control.throwIfAborted()
    this.assertWorkspace(workspace)
    if (!workspace.sessionIds.includes(id)) refuse()
    return workspace
  }

  readSession(id: SessionId, summary?: SessionSummary): void {
    this.current()
    this.pin()
    if (this.modules.size === 0) unavailable()
    const sessions = this.provider('sessions'), agents = this.provider('agents')
    const session = sessions.get(id), agent = agents.get(id)
    let workspace: Workspace | undefined
    if (agent !== undefined) {
      if (agent.session !== session) refuse()
      workspace = this.prepared(agent, false)
    } else if (session !== undefined) {
      // Native publication precedes Agent and Workspace attachment; readonly metadata does not authorize file operations.
      workspace = this.sessionProject(session, false)
    } else workspace = this.member(id)
    if (workspace === undefined) refuse()
    if (summary !== undefined) {
      if (summary.sessionId !== id || summary.cwd !== workspace.path
        || (session !== undefined
          ? summary.origin !== session.header.origin || summary.parentSessionId !== session.header.parentSession
          : summary.origin === 'subagent'
            ? summary.parentSessionId === undefined || summary.parentSessionId === id
            : summary.parentSessionId !== undefined)) refuse()
      const values = summary.projections?.values
      if (values?.workingDirectory !== undefined && values.workingDirectory !== workspace.path) refuse()
      if (values?.agentPreset !== undefined) this.approvedPreset(values.agentPreset)
    }
    this.assertWorkspace(workspace)
  }

  prepared(agent: Agent, attached: boolean, parent?: Agent): Workspace {
    this.current()
    return this.preparedCurrent(agent, attached, parent)
  }

  /** The caller has checked account current in this synchronous operation. */
  selectCurrent(agent: Agent, id: string): void {
    this.current()
    this.approvedPreset(id, true)
    this.preparedCurrent(agent, true, undefined, id)
  }

  private preparedCurrent(agent: Agent, attached: boolean, parent?: Agent, selecting?: string, retainedExecution = false): Workspace {
    const workspace = this.sessionProjectCurrent(agent.session, false)
    const sessionPreset = this.sessionPreset(agent.session)
    const composed = this.provider('agentPresets').composedPreset(agent.ctx)
    if (selecting !== undefined && composed !== sessionPreset && composed !== selecting) refuse()
    const presetId = selecting === undefined ? sessionPreset : this.approvedPreset(composed).id
    const modules = this.modules.get(presetId)
    if (this.facts === undefined || modules === undefined || agent.ctx.root !== this.ctx.root
      || agent.ctx.get('peAccount') !== this.binding || agent.id !== agent.session.header.id) refuse()
    if (retainedExecution) this.retainedAgentState(agent)
    else agent.ctx.fiber.assertActive()
    if (!this.allowedModelCurrent(agent.options.provider ?? '', agent.options.model ?? '')) refuse()
    const presets = this.provider('agentPresets')
    const composition = presets.inspectCompositions(agent.ctx), row = composition[0]
    if (presets.composedPreset(agent.ctx) !== presetId || composition.length !== 1 || row === undefined
      || row.id !== presetId || row.leakedServices.length !== 0 || row.modules.length !== modules.length
      || row.modules.some((module, index) => module.moduleName !== modules[index])) refuse()
    if (agent.session.header.origin === 'subagent') {
      this.spawn()
      const parentId = agent.session.header.parentSession
      if (parentId === undefined) refuse()
      const actualParent = parent ?? this.provider('agents').get(parentId)
      if (actualParent === undefined || agent.id === actualParent.id) refuse()
      this.parentCurrentForChild(agent.ctx, actualParent, workspace, retainedExecution)
      const childScope = scopeOf(agent.ctx), parentScope = scopeOf(actualParent.ctx)
      if (childScope === undefined || parentScope === undefined || agent.session.header.parentSession !== actualParent.id
        || (agent.session.header.delegationDepth ?? 0) < delegationDepthOf(actualParent) + 1
        || (presetId === this.sessionPreset(actualParent.session)
          && scopeParentOf(childScope) !== scopeParentOf(parentScope))) refuse()
      if (attached && !this.provider('agents').isOwnedBy(agent.id, actualParent)) refuse()
    } else if (parent !== undefined) refuse()
    for (const key of ['fs', 'shell', 'subprocess', 'shellEnv', 'sandbox', 'ptcRuntime', 'terminals', 'llm', 'subagents', 'workingDirectory'] as const) {
      const root: unknown = this.ctx.root.get(key), child: unknown = agent.ctx.get(key)
      if (root === undefined ? child !== undefined : !object(root) || !object(child) || original(root) !== original(child)) refuse()
    }
    if (attached && (this.provider('agents').get(agent.id) !== agent || this.provider('sessions').get(agent.id) !== agent.session
      || this.memberCurrent(agent.id) !== workspace)) refuse()
    if (agent.session.header.origin === 'subagent') this.assertWorkspace(workspace)
    else this.assertWorkspaceIdentity(workspace)
    return workspace
  }

  assertRetainedExecutionOwner(agent: Agent, workspace: Workspace): void {
    this.current()
    if (this.preparedCurrent(agent, true, undefined, undefined, true) !== workspace) refuse()
  }

  private retainedAgentState(agent: Agent): void {
    if (agent.ctx.fiber.state !== FiberState.ACTIVE && agent.ctx.fiber.state !== FiberState.UNLOADING) refuse()
  }

  parentCurrentForChild(owner: Context, parent: Agent, expected?: Workspace, retainedExecution = false): Workspace {
    if (this.assertBusinessCurrent === undefined) unavailable()
    this.assertBusinessCurrent(this.binding)
    this.current()
    if (retainedExecution) {
      if (owner.fiber.state !== FiberState.ACTIVE && owner.fiber.state !== FiberState.UNLOADING) refuse()
      this.retainedAgentState(parent)
    } else {
      owner.fiber.assertActive()
      parent.ctx.fiber.assertActive()
    }
    const agents = this.provider('agents'), sessions = this.provider('sessions')
    if (owner.root !== this.ctx.root || owner.get('peAccount') !== this.binding
      || parent.ctx.root !== this.ctx.root || parent.ctx.get('peAccount') !== this.binding
      || parent.ctx.root.get('peAccount') !== this.binding || parent.id !== parent.session.id
      || parent.session.header.id !== parent.id || agents.get(parent.id) !== parent
      || sessions.get(parent.id) !== parent.session) refuse()
    for (const [key, installed] of [['agents', agents], ['sessions', sessions]] as const) {
      for (const context of [owner, parent.ctx, this.ctx.root]) {
        const actual: unknown = context.get(key)
        if (!object(actual) || original(actual) !== original(installed)) refuse()
      }
    }
    const workspace = this.sessionProjectCurrent(parent.session, true)
    if (expected !== undefined && workspace !== expected) refuse()
    if (this.provider('workingDirectory').get(parent.session) !== workspace.path) refuse()
    return workspace
  }

  spawn(provider?: import('@deepseek-ai/dsh-subagent').SubagentProvider): void {
    this.current()
    const runtime = this.provider('subagents')
    if (!(runtime instanceof SubagentRuntime)) unavailable()
    let native = 0
    for (const fiber of this.ctx.registry.get(SubagentRuntime)?.fibers ?? []) {
      const installed: unknown = fiber.store?.subagents?.value
      if (++native > 1 || fiber.state !== FiberState.ACTIVE || fiber.runtime?.callback !== SubagentRuntime
        || !object(installed) || original(installed) !== original(runtime)
        || fiber.ctx.root !== this.ctx.root || fiber.ctx.get('peAccount') !== this.binding) refuse()
    }
    if (native !== 1) unavailable()
    let selected = provider === undefined
    for (const namespace of [Spawn, Fork]) {
      let found = 0
      for (const fiber of this.ctx.registry.get(namespace)?.fibers ?? []) {
        if (++found > 1 || fiber.state !== FiberState.ACTIVE || fiber.runtime?.callback !== namespace.apply
          || fiber.entry?.moduleNamespace !== namespace || !object(fiber.config)
          || fiber.ctx.root !== this.ctx.root || fiber.ctx.get('peAccount') !== this.binding) refuse()
        const name: unknown = Reflect.get(fiber.config, 'providerName')
        if (typeof name !== 'string' || runtime.getProvider(name) === undefined) refuse()
        if (runtime.getProvider(name) === provider) selected = true
      }
      if (namespace === Spawn && found !== 1) unavailable()
    }
    if (!selected) refuse()
  }

  private async auditGeneration(parent: Agent, signal: AbortSignal): Promise<void> {
    const scope = scopeOf(parent.ctx)
    if (scope === undefined) refuse()
    const generation = scopeParentOf(scope)
    if (generation === undefined) refuse()
    const inspection = this.provider('agentPresets').inspectCompositions(parent.ctx)
    if (inspection.length !== 1 || inspection[0]?.id !== this.sessionPreset(parent.session)) refuse()
    const entries: Entry[] = []
    for (const runtime of this.ctx.registry.values()) for (const fiber of runtime.fibers) {
      if (scopeOf(fiber.ctx) !== generation || fiber.entry === undefined || fiber.entry.options.group || fiber.entry.disabled) continue
      // The Loader assigns the same Entry to its owned plugin/inject fibers.
      if (fiber.parent.fiber.entry === fiber.entry) continue
      if (entries.length >= this.maxEntries || fiber.state !== FiberState.ACTIVE || fiber.entry.fiber !== fiber) refuse()
      entries.push(fiber.entry)
    }
    const modules = inspection[0].modules
    if (entries.length !== modules.length) refuse()
    const facts: EntryFact[] = []
    for (const entry of entries) {
      signal.throwIfAborted()
      const namespace: unknown = await entry.parent.tree.import(entry.options.name)
      signal.throwIfAborted()
      this.current()
      const fiber = entry.fiber
      let plugin: unknown = namespace
      if (object(plugin) && Reflect.get(plugin, 'default') !== undefined) plugin = Reflect.get(plugin, 'default')
      const callback: unknown = typeof plugin === 'function' ? plugin : object(plugin) ? Reflect.get(plugin, 'apply') : undefined
      if (fiber?.state !== FiberState.ACTIVE || entry.moduleNamespace !== namespace || fiber.runtime?.callback !== callback
        || scopeOf(fiber.ctx) !== generation
        || !modules.some(row => row.moduleName === entry.options.name && row.baseUrl === entry.parent.tree.ctx.baseUrl)) refuse()
      const plan = entry.prepareConfigUpdate(entry.options.config)
      if (plan.impact !== 'none') refuse()
      facts.push({ entry, fiber, plan, module: namespace })
    }
    const prior = this.facts ?? []
    this.facts = [...prior, ...facts.filter(fact => !prior.some(existing => existing.entry === fact.entry))]
    if (this.facts.length > this.maxEntries) refuse()
    this.current()
  }

  async admitSubagent(request: SubagentAdmissionRequest): Promise<void> {
    const parent = request.kind === 'start' ? request.spec.request.parent : request.parent
    const signal = request.kind === 'start' ? request.spec.signal : request.signal
    const workspace = this.parentCurrentForChild(request.owner, parent)
    this.prepared(parent, true)
    this.spawn(request.provider)
    if (request.provider === undefined) refuse()
    if (request.kind === 'start' && (request.provider.prepareContinuable === undefined
      || request.cwd !== workspace.path)) refuse()
    await this.directory(workspace, signal)
    this.parentCurrentForChild(request.owner, parent, workspace)
    const requested = request.kind === 'start' ? request.spec.request.agentPreset : request.agentPreset
    await this.preset(requested ?? this.sessionPreset(parent.session), signal, request.kind === 'start')
    this.parentCurrentForChild(request.owner, parent, workspace)
    await this.auditGeneration(parent, signal)
    this.parentCurrentForChild(request.owner, parent, workspace)
    if (request.kind === 'start') {
      const route = resolveChildAgentOptions(
        parent, request.spec.request.agentOptions, resolveChildDepth(parent, request.spec.request.maxDepth),
      )
      await this.model(route, signal)
    } else {
      await this.childHistory(request.owner, parent, request.childId, signal)
      await this.model(request.agentOptions, signal)
    }
    this.parentCurrentForChild(request.owner, parent, workspace)
    this.prepared(parent, true)
    this.spawn(request.provider)
  }

  private async childHistory(owner: Context, parent: Agent, id: SessionId, signal: AbortSignal): Promise<number> {
    const workspace = this.parentCurrentForChild(owner, parent)
    if (id === parent.id || this.member(id) !== workspace) refuse()
    using history = await this.provider('sessionQuery').observeSession(id, { projectionMode: 'all', signal })
    this.parentCurrentForChild(owner, parent, workspace)
    const header = history.header
    this.sessionHeader(header, workspace.path)
    if (header.id !== id || header.origin !== 'subagent' || header.parentSession !== parent.id
      || (header.delegationDepth ?? 0) < delegationDepthOf(parent) + 1
      || history.projections?.values.workingDirectory !== workspace.path) refuse()
    await this.preset(this.approvedPreset(history.projections.values.agentPreset).id, signal)
    return Math.max(header.delegationDepth ?? 0, delegationDepthOf(parent) + 1)
  }

  async childCreate(options: Parameters<AccountNativeGuards['agents']['assertCreate']>[0], signal: AbortSignal): Promise<number> {
    const parent = options.parentAgent
    if (parent === undefined) refuse()
    const workspace = this.parentCurrentForChild(this.ctx, parent)
    this.prepared(parent, true)
    this.spawn()
    if (options.meta?.cwd !== workspace.path
      || options.meta.agentPreset === undefined || options.meta.origin !== 'subagent' || options.meta.parentSession !== parent.id
      || options.meta.delegationDepth !== delegationDepthOf(parent) + 1) refuse()
    const runtimeDepth = options.agentOptions?.subagentDepth
    if (runtimeDepth !== undefined && (!Number.isSafeInteger(runtimeDepth)
      || runtimeDepth < 0 || runtimeDepth > options.meta.delegationDepth)) refuse()
    await this.directory(workspace, signal)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    await this.preset(options.meta.agentPreset, signal, true)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    await this.auditGeneration(parent, signal)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    await this.model(options.agentOptions, signal)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    this.prepared(parent, true)
    this.spawn()
    return delegationDepthOf(parent) + 1
  }

  async childResume(options: Parameters<AccountNativeGuards['agents']['assertResume']>[0], signal: AbortSignal): Promise<number> {
    const parent = options.parentAgent
    if (parent === undefined) refuse()
    const workspace = this.parentCurrentForChild(this.ctx, parent)
    this.prepared(parent, true)
    this.spawn()
    const depth = await this.childHistory(this.ctx, parent, options.resumeSessionId, signal)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    await this.directory(workspace, signal)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    await this.preset(this.sessionPreset(parent.session), signal)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    await this.auditGeneration(parent, signal)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    await this.model(options.agentOptions, signal)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    this.prepared(parent, true)
    this.spawn()
    const runtimeDepth = options.agentOptions?.subagentDepth
    if (runtimeDepth !== undefined && (!Number.isSafeInteger(runtimeDepth) || runtimeDepth < 0)) refuse()
    return Math.max(depth, runtimeDepth ?? 0)
  }

  private preparationCurrent(record: ChildPreparation): void {
    const { child, parent, session, fiber, workspace, signal, generation } = record
    signal.throwIfAborted()
    fiber.assertActive()
    if (!record.active || this.childPreparations.get(child) !== record
      || scopeOf(child.ctx) !== child || child.ctx.fiber !== fiber
      || fiber.state !== FiberState.LOADING && fiber.state !== FiberState.ACTIVE
      || child.session !== session || child.id !== session.id || session.header.id !== child.id) refuse()
    const parentScope = scopeOf(parent.ctx)
    if (parentScope === undefined || this.parentCurrentForChild(child.ctx, parent, workspace) !== workspace
      || this.preparedCurrent(parent, true) !== workspace || scopeParentOf(parentScope) !== generation) refuse()
    const childGeneration = scopeParentOf(child)
    if (childGeneration !== undefined) {
      const registry = this.provider('agentPresets'), id = this.approvedPreset(registry.composedPreset(child.ctx)).id
      const rows = registry.inspectCompositions(child.ctx), row = rows[0], modules = this.modules.get(id)
      if (id === this.sessionPreset(parent.session) && childGeneration !== generation
        || rows.length !== 1 || row === undefined || row.id !== id || row.leakedServices.length !== 0
        || modules === undefined || row.modules.length !== modules.length
        || row.modules.some((entry, index) => entry.moduleName !== modules[index])) refuse()
    }
    const header = session.header
    this.sessionHeader(header, workspace.path)
    this.approvedPreset(header.agentPreset)
    if (header.origin !== 'subagent' || header.parentSession !== parent.id
      || (header.delegationDepth ?? 0) < delegationDepthOf(parent) + 1 || child.id === parent.id
      || this.provider('agents').get(child.id) !== undefined || this.provider('sessions').get(child.id) !== undefined
      || !this.allowedModelCurrent(child.options.provider ?? '', child.options.model ?? '')) refuse()
    for (const key of ['fs', 'shell', 'subprocess', 'shellEnv', 'sandbox', 'ptcRuntime', 'terminals', 'llm', 'subagents', 'workingDirectory'] as const) {
      const root: unknown = this.ctx.root.get(key), selected: unknown = child.ctx.get(key)
      if (root === undefined ? selected !== undefined
        : !object(root) || !object(selected) || original(root) !== original(selected)) refuse()
    }
  }

  async withChildPreparation<T>(child: Agent, parent: Agent, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const workspace = this.parentCurrentForChild(child.ctx, parent)
    this.prepared(parent, true)
    const parentScope = scopeOf(parent.ctx), scope = scopeOf(child.ctx)
    const generation = parentScope === undefined ? undefined : scopeParentOf(parentScope)
    // The original native factory mints the Agent itself as its opaque scope key. A copied Agent cannot enter.
    if (scope !== child || generation === undefined || this.childPreparations.has(scope)) refuse()
    const directoryPreparation = Object.freeze({ assertCaller: (caller: Context): void => {
      caller.fiber.assertActive()
      if (caller.root !== this.ctx.root || caller.get('peAccount') !== this.binding || scopeOf(caller) !== scope) refuse()
      this.preparationCurrent(record)
    } })
    const record: ChildPreparation = { child, session: child.session, fiber: child.ctx.fiber, parent, generation,
      workspace, signal, directoryPreparation, active: true }
    this.childPreparations.set(scope, record)
    const revoke = (): void => { record.active = false }
    let remove: (() => void | Promise<void>) | undefined
    try {
      signal.addEventListener('abort', revoke, { once: true })
      remove = child.ctx.effect(() => revoke, 'account-policy.child-directory-preparation')
      this.preparationCurrent(record)
      const result = await operation()
      await this.auditGeneration(child, signal)
      this.preparationCurrent(record)
      return result
    } finally {
      revoke()
      signal.removeEventListener('abort', revoke)
      if (this.childPreparations.get(scope) === record) this.childPreparations.delete(scope)
      await remove?.()
    }
  }

  async fileProject(caller: Context, signal?: AbortSignal): Promise<AccountFileSelection> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    this.current()
    caller.fiber.assertActive()
    if (caller.root !== this.ctx.root || caller.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The file caller belongs to another account graph.')
    }
    const callerScope = scopeOf(caller)
    const preparing = callerScope === undefined ? undefined : this.childPreparations.get(callerScope)
    if (preparing !== undefined) {
      const assertCurrent = (): void => { this.preparationCurrent(preparing) }
      preparing.directoryPreparation.assertCaller(caller)
      return { workspace: preparing.workspace, assertCurrent, directoryPreparation: preparing.directoryPreparation }
    }
    const agent = this.provider('agents').currentInitiator()
    if (agent !== undefined) {
      // Shared account services may be untagged; a tagged child cannot borrow its causal parent's file authority.
      const assertCaller = (): void => {
        if (callerScope !== undefined && !scopeChainOf(scopeOf(agent.ctx)).includes(callerScope)) refuse()
      }
      assertCaller()
      const workspace = this.prepared(agent, true)
      const assertCurrent = (): void => {
        const current = this.prepared(agent, true)
        assertCaller()
        if (current !== workspace) refuse()
      }
      return { workspace, assertCurrent,
        ...this.provider('peAccountExecution').enforcesSessionFilePolicy !== true ? {} : {
          assertMutationPolicy: createAccountFileMutationGuard(this.ctx, agent.session, workspace.path, assertCurrent),
        } }
    }
    const invocation = caller.invocation
    const workspaceFiles = invocation?.service === 'workspaceFiles' && invocation.request.namespace === 'workspaceFiles'
    const officeRender = invocation?.service === 'officeToPdf' && invocation.request.namespace === 'officeToPdf'
      && invocation.request.method === 'render'
    if (!workspaceFiles && !officeRender) refuse()
    const raw = invocation.request.args['workspaceFileScopeId']
    if (typeof raw !== 'string') refuse()
    return this.fileSession(SessionId(raw), control)
  }

  /**
   * Select the original account member Session for HTTP file operations.
   * @param id Original member Session.
   * @param signal Request lifetime.
   * @returns Registered project with current membership checks.
   */
  fileTransfer(id: SessionId, signal: AbortSignal): Promise<AccountFileSelection> { return this.fileSession(id, signal) }

  async fileScope(id: SessionId): Promise<{ sessionId: SessionId; workspaceRoot: string }> {
    const selected = await this.fileSession(id, this.binding.lifetime)
    selected.assertCurrent()
    return { sessionId: id, workspaceRoot: selected.workspace.path }
  }

  private async fileSession(id: SessionId, control: AbortSignal): Promise<AccountFileSelection> {
    control.throwIfAborted()
    const session = this.provider('sessions').get(id)
    if (session !== undefined) {
      const workspace = this.liveSessionProject(session)
      return { workspace, assertCurrent: () => {
        if (this.liveSessionProject(session) !== workspace) refuse()
      } }
    }
    // Observe only after original membership admission; a wire id cannot trigger a foreign private-log read.
    const workspace = this.member(id)
    if (workspace === undefined) refuse()
    const observed = await this.provider('sessionPersistence').stat(id, { signal: control })
    control.throwIfAborted()
    if (observed === undefined) refuse()
    const header = observed.header
    if (this.observedProject(id, header) !== workspace) refuse()
    await this.preset(header.agentPreset, control)
    control.throwIfAborted()
    this.assertWorkspace(workspace)
    return { workspace, assertCurrent: () => {
      // Both branches perform the full current check for their selected Session.
      const live = this.provider('sessions').get(id)
      if ((live === undefined ? this.observedProject(id, header) : this.liveSessionProject(live)) !== workspace) refuse()
    } }
  }

  handlers(handlerId: string): void {
    this.current()
    const controller = this.provider('sessionController')
    if (!(controller instanceof SessionController)) unavailable()
    const native = controller.typertRemote
    if (handlerId !== `native:${native.serviceKey}` || native.serviceKey !== 'sessionController'
      || original(native.service) !== original(controller)) refuse()
    const manifest = this.exposure.manifest
    if (manifest.recipeVersion !== this.binding.recipeVersion) refuse()
    const markers = remoteMethods(controller)
    const rpc = manifest.rpcEndpoints.filter(row => row.handlerId === handlerId)
    const stream = manifest.streamEndpoints.filter(row => row.handlerId === handlerId)
    if (rpc.length + stream.length === 0) refuse()
    for (const [rows, mode] of [[rpc, 'rpc'], [stream, 'stream']] as const) for (const row of rows) {
      if (!markers.some(marker => `${native.namespace}/${marker.exportName ?? marker.method}` === row.endpoint
        && (marker.mode ?? 'rpc') === mode && typeof Reflect.get(native.service, marker.method) === 'function')) refuse()
    }
  }
}

/**
 * Construct lazy guards from original native owners; construction never reads a partial files project.
 * @param ctx Independent installed account graph.
 * @param binding Exact runtime binding, not a browser identity or a readiness assertion.
 * @param files Original prepared files owner, retained by native integration.
 * @param config Explicit immutable deployment policy for exact models and approved native preset declarations.
 * @param exposure Actual Root exposure policy, whose declarations must match enabled native handlers.
 * @param maxEntries Existing deployment bound on native Loader and preset inventory rows.
 * @param provisionableModel Optional original audited provider check for first-key bootstrap; actual model dispatch is unchanged.
 * @param assertBusinessCurrent Original business admission check; required for children and rechecked after awaits.
 * @param fileReadTiming Optional original Root's numerical guard observations.
 * @returns Shared concrete Controller/factory/LLM guards; no account, Session or ready identity is created here.
 */
export function createAccountPolicy(
  ctx: Context, binding: AccountBinding, files: CloudAccountFiles, config: AccountPolicyConfig,
  exposure: ExposureService['policy'], maxEntries: number,
  provisionableModel?: (provider: string, model: string) => void,
  assertBusinessCurrent?: (binding: AccountBinding) => void,
  fileReadTiming?: FileReadTiming,
): AccountNativeGuards {
  const policy = new AccountPolicy(ctx, binding, files, config, exposure, maxEntries,
    provisionableModel, assertBusinessCurrent, fileReadTiming)
  return {
    presets: {
      assertCurrent: () => { policy.current() },
      assertPreset: (id, signal, selectable) => policy.preset(id, signal, selectable),
      assertSession: (agent) => { policy.prepared(agent, true) },
      assertSelectCurrent: (agent, id) => { policy.selectCurrent(agent, id) },
      isSelectable: id => policy.selectablePreset(id),
    },
    beginSettingsUpdate: (namespace, ops, fields) => policy.beginSettingsUpdate(namespace, ops, fields),
    allowSettingsUnset: (namespace, field, values) => policy.allowSettingsUnset(namespace, field, values),
    assertWorkspace: (workspace) => { policy.assertWorkspace(workspace) },
    projectForAgent: agent => policy.prepared(agent, true),
    assertRetainedExecutionOwner: (agent, workspace) => { policy.assertRetainedExecutionOwner(agent, workspace) },
    projectForSession: session => policy.liveSessionProject(session),
    projectForObservedHeader: (id, header) => policy.observedProject(id, header),
    projectForDirectory: cwd => policy.workspaceAt(cwd),
    getFileProject: (caller, signal) => policy.fileProject(caller, signal),
    resolveFileScope: id => policy.fileScope(id),
    resolveFileTransfer: (id, signal) => policy.fileTransfer(id, signal),
    assertBootstrapCurrent: signal => policy.assertBootstrapCurrent(signal),
    assertSessionRead: (id, summary) => { policy.readSession(id, summary) },
    sessions: {
      modelSelection: {
        allowedModel: (provider, model) => policy.allowedModel(provider, model),
        allowedProvider: (provider) => {
          policy.current()
          return config.models.some(row => row.provider === provider)
        },
      },
      assertHandlerEnabled: (id) => { policy.handlers(id) },
      resolveCreate: async (request) => {
        if (request.workspaceId !== undefined && request.cwd !== undefined) refuse()
        const workspace = request.workspaceId === undefined
          ? request.cwd === undefined ? policy.project().workspace : policy.workspaceAt(request.cwd)
          : ctx.get('workspaceRegistry')?.get(request.workspaceId)
        if (workspace === undefined) refuse()
        policy.assertWorkspace(workspace)
        await policy.directory(workspace)
        const presetId = await policy.preset(request.agentPreset, undefined, true)
        await policy.model(policy.defaultModel())
        if (request.sessionId !== undefined) {
          const member = workspace.sessionIds.includes(request.sessionId)
          try { await policy.history(request.sessionId, undefined, 'create-probe', workspace) }
          catch (error) {
            if (member || workspace.sessionIds.includes(request.sessionId)
              || !(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
          }
        }
        policy.current()
        policy.assertWorkspace(workspace)
        return { ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
          workspaceId: workspace.id, agentPreset: presetId }
      },
      assertSessionProject: async (id) => { await policy.history(id) },
      assertActiveScope: (agent) => { policy.prepared(agent, true) },
    },
    admitSubagent: request => policy.admitSubagent(request),
    assertSubagentsInstalled: () => { policy.spawn() },
    agents: {
      withChildPreparation: (child, parent, signal, operation) => policy.withChildPreparation(child, parent, signal, operation),
      assertCreate: async (options, signal) => {
        if (options.parentAgent !== undefined) return policy.childCreate(options, signal)
        const workspace = policy.workspaceAt(options.meta?.cwd)
        await policy.directory(workspace, signal)
        policy.header(options.meta ?? {}, workspace.path)
        if (options.meta?.agentPreset === undefined) refuse()
        await policy.preset(options.meta.agentPreset, signal, true)
        await policy.model(options.agentOptions, signal)
        policy.current()
        policy.assertWorkspace(workspace)
      },
      assertResume: async (options, signal) => {
        if (options.parentAgent !== undefined) return policy.childResume(options, signal)
        const workspace = await policy.history(options.resumeSessionId, signal)
        await policy.model(options.agentOptions, signal)
        policy.current()
        policy.assertWorkspace(workspace)
        if (!workspace.sessionIds.includes(options.resumeSessionId)) refuse()
      },
      prepareChild: async (agent, parent, signal) => {
        const workspace = policy.prepared(agent, false, parent)
        policy.parentCurrentForChild(agent.ctx, parent, workspace)
        await workspace.attachSession(agent.id)
        signal.throwIfAborted()
        policy.parentCurrentForChild(agent.ctx, parent, workspace)
        if (policy.prepared(agent, false, parent) !== workspace || !workspace.sessionIds.includes(agent.id)) refuse()
      },
      assertPrepared: (agent, parent) => {
        const workspace = policy.prepared(agent, false, parent)
        if (parent !== undefined && !workspace.sessionIds.includes(agent.id)) refuse()
        if (parent !== undefined) policy.delegatedFilePolicy(agent, parent)
      },
    },
    allowedModel: (provider, model) => policy.allowedModel(provider, model),
  }
}
