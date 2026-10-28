/** One account's concrete project/model/Preset checks over original native services; this issues no ready state. */
import { createHash } from 'node:crypto'
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-agent-default-model'
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
import type { AccountBinding } from './types.ts'
import { ACCOUNT_NATIVE_ENTRIES, type AccountNativeGuards } from './account-native-integration.ts'
import { createAccountFileMutationGuard } from './account-permissions.ts'

/** Explicit deployment selection for one fixed native preset and finite exact model routes. */
export interface AccountPolicyConfig {
  readonly maxModelRoutes: number
  readonly maxPolicyStringBytes: number
  readonly models: { readonly provider: string; readonly model: string }[]
  readonly presetId: string
  readonly presetEntryId: string
  readonly presetConfigSha256: string
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

function refuse(): never { throw new CloudApiError('cloud/forbidden', 'The account project or fixed Preset is not approved.') }
function unavailable(): never { throw new CloudApiError('cloud/account-unavailable', 'The account policy requires its original native providers.') }
function modelDenied(): never { throw new CloudApiError('cloud/model-not-allowed', 'The model route is not approved and available for this account.') }
function object(value: unknown): value is object { return value !== null && typeof value === 'object' }
function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return object(target) ? target : value
}

/**
 * Hash a finite plain JSON preset declaration with sorted object keys; expressions and aliases reject.
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
      if (seen.has(value) || isJsExpr(value)) refuse()
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

class AccountPolicy {
  private facts: readonly EntryFact[] | undefined
  private modules: readonly string[] | undefined
  private readonly providers = new Map<string, object>()
  private readonly childPreparations = new Map<object, ChildPreparation>()

  constructor(
    private readonly ctx: Context, private readonly binding: AccountBinding, private readonly files: CloudAccountFiles,
    private readonly config: AccountPolicyConfig, private readonly exposure: ExposureService['policy'], private readonly maxEntries: number,
    private readonly provisionableModel?: (provider: string, model: string) => void,
    private readonly assertBusinessCurrent?: (binding: AccountBinding) => void,
  ) {}

  current(): void {
    this.ctx.fiber.assertActive()
    if (this.binding.lifetime.aborted || this.ctx.get('peAccount') !== this.binding || this.ctx.root.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The account policy belongs to an ended graph.')
    }
    this.files.assertInstalled(this.ctx)
    for (const [key, expected] of this.providers) {
      const actual: unknown = this.ctx.get(key)
      if (!object(actual) || original(actual) !== expected) unavailable()
      if (key === 'agentPresets' && actual instanceof AgentPresets && actual.defaultId !== this.config.presetId) refuse()
      if (key === 'agentLoop' && actual instanceof AgentLoop && actual.config.agents.length !== 0) refuse()
    }
    for (const fact of this.facts ?? []) {
      if (fact.entry.fiber !== fact.fiber || fact.fiber.state !== FiberState.ACTIVE
        || fact.entry.moduleNamespace !== fact.module) unavailable()
      try { fact.entry.assertConfigUpdatePlan(fact.plan) }
      catch (_cause) { unavailable() }
    }
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
    if (this.provider('workspaceRegistry').get(workspace.id) !== workspace) refuse()
  }

  workspaceAt(cwd: string | undefined): Workspace {
    this.current()
    if (cwd === undefined) refuse()
    const matches = this.provider('workspaceRegistry').list().filter(workspace => workspace.path === cwd)
    const workspace = matches[0]
    if (matches.length !== 1 || workspace === undefined) refuse()
    this.assertWorkspace(workspace)
    return workspace
  }

  private member(id: SessionId): Workspace | undefined {
    this.current()
    const matches = this.provider('workspaceRegistry').list().filter(workspace => workspace.sessionIds.includes(id))
    if (matches.length > 1) refuse()
    const workspace = matches[0]
    if (workspace !== undefined) this.assertWorkspace(workspace)
    return workspace
  }

  observedProject(id: SessionId, header: SessionHeader): Workspace {
    this.current()
    const workspace = this.member(id)
    if (workspace === undefined || header.id !== id || header.agentPreset !== this.config.presetId) refuse()
    this.sessionHeader(header, workspace.path)
    if (header.origin === 'subagent') { this.spawn(); if (header.parentSession === id) refuse() }
    this.pin()
    this.assertWorkspace(workspace)
    return workspace
  }

  private sessionProject(session: Session, attached: boolean): Workspace {
    this.current()
    const workspace = this.workspaceAt(session.header.cwd)
    if (session.id !== session.header.id || session.header.agentPreset !== this.config.presetId) refuse()
    this.sessionHeader(session.header, workspace.path)
    if (this.provider('workingDirectory').get(session) !== workspace.path
      || this.provider('sessionProjections').stateOf(session, 'agentPreset') !== this.config.presetId) refuse()
    if (attached && (this.provider('sessions').get(session.id) !== session || this.member(session.id) !== workspace)) refuse()
    return workspace
  }

  liveSessionProject(session: Session): Workspace {
    const workspace = this.sessionProject(session, true)
    const agent = this.provider('agents').get(session.id)
    if (agent !== undefined && (agent.session !== session || this.prepared(agent, true) !== workspace)) refuse()
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
    const preset = fact(this.config.presetEntryId), loop = fact(this.config.agentLoopEntryId)
    if (preset.fiber.runtime?.callback !== AgentPreset || !object(preset.fiber.config)
      || Reflect.get(preset.fiber.config, 'id') !== this.config.presetId
      || accountPresetConfigDigest(preset.fiber.config, this.config.maxPresetConfigBytes) !== this.config.presetConfigSha256) refuse()
    const nativeLoop = this.provider('agentLoop')
    if (!(nativeLoop instanceof AgentLoop) || nativeLoop.config.agents.length !== 0
      || loop.entry.options.name !== 'cordis:' + ACCOUNT_NATIVE_ENTRIES.agentLoop
      || loop.fiber.store?.agentLoop?.fiber !== loop.fiber
      || !object(loop.fiber.store.agentLoop.value) || original(loop.fiber.store.agentLoop.value) !== original(nativeLoop)) unavailable()
    this.facts = [preset, loop]
  }

  async preset(id: string | undefined, signal?: AbortSignal): Promise<void> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    if (id !== undefined && id !== this.config.presetId) refuse()
    this.pin()
    const presets = this.provider('agentPresets')
    if (!(presets instanceof AgentPresets) || presets.defaultId !== this.config.presetId) refuse()
    const resolved = await presets.resolve(this.config.presetId)
    control.throwIfAborted()
    this.current()
    if (presets.defaultId !== this.config.presetId
      || resolved.id !== this.config.presetId || resolved.broken !== undefined) refuse()
    const inventory = await presets.compositionInventory()
    control.throwIfAborted()
    this.current()
    if (presets.defaultId !== this.config.presetId) refuse()
    const row = inventory[0]
    if (inventory.length !== 1 || row === undefined || row.id !== this.config.presetId || row.broken !== undefined
      || !row.isDefault || row.rows.length > this.maxEntries
      || row.rows.some(child => child.enabled !== true || child.fiberState !== FiberState.ACTIVE)) refuse()
    const modules = row.rows.map(child => child.moduleName)
    if (this.modules !== undefined
      && (modules.length !== this.modules.length || modules.some((name, i) => this.modules?.[i] !== name))) refuse()
    this.modules ??= Object.freeze(modules)
  }

  allowedModel(provider: string, model: string): boolean {
    this.current()
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
      || !['read-only', 'workspace-write'].includes(inherited.mode)
      || !['read-only', 'workspace-write'].includes(selected.mode)
      || inherited.mode === 'read-only' && selected.mode !== 'read-only') {
      throw new CloudApiError('cloud/forbidden', 'A child Agent cannot widen its parent\'s current file permissions.')
    }
  }

  async assertBootstrapCurrent(signal?: AbortSignal): Promise<void> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    const project = this.project(), { provider, model } = this.defaultModel()
    if (provider === undefined || model === undefined) modelDenied()
    const selection = { provider, model }
    const filesSelected = this.exposure.manifest.rpcEndpoints.some(row => row.endpoint.startsWith('workspaceFiles/'))
      || this.exposure.manifest.streamEndpoints.some(row => row.endpoint.startsWith('workspaceFiles/'))
    if (filesSelected) this.files.assertContentAvailable()
    this.handlers('native:sessionController')
    await this.preset(this.config.presetId, control)
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
      if (header.cwd !== path || header.isSeeded || header.parentSession === undefined
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
      || observed.projections?.values.workingDirectory !== workspace.path
      || observed.projections.values.agentPreset !== this.config.presetId) refuse()
    await this.preset(this.config.presetId, control)
    control.throwIfAborted()
    this.assertWorkspace(workspace)
    if (!workspace.sessionIds.includes(id)) refuse()
    return workspace
  }

  readSession(id: SessionId, summary?: SessionSummary): void {
    this.current()
    this.pin()
    if (this.modules === undefined) unavailable()
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
      if ((values?.workingDirectory !== undefined && values.workingDirectory !== workspace.path)
        || (values?.agentPreset !== undefined && values.agentPreset !== this.config.presetId)) refuse()
    }
    this.assertWorkspace(workspace)
  }

  prepared(agent: Agent, attached: boolean, parent?: Agent): Workspace {
    this.current()
    const workspace = this.sessionProject(agent.session, false)
    if (this.facts === undefined || this.modules === undefined || agent.ctx.root !== this.ctx.root
      || agent.ctx.get('peAccount') !== this.binding || agent.id !== agent.session.header.id) refuse()
    agent.ctx.fiber.assertActive()
    if (!this.allowedModel(agent.options.provider ?? '', agent.options.model ?? '')) refuse()
    const presets = this.provider('agentPresets')
    const composition = presets.inspectCompositions(agent.ctx), row = composition[0]
    if (presets.composedPreset(agent.ctx) !== this.config.presetId || composition.length !== 1 || row === undefined
      || row.id !== this.config.presetId || row.leakedServices.length !== 0 || row.modules.length !== this.modules.length
      || row.modules.some((module, index) => module.moduleName !== this.modules?.[index])) refuse()
    if (agent.session.header.origin === 'subagent') {
      this.spawn()
      const parentId = agent.session.header.parentSession
      if (parentId === undefined) refuse()
      const actualParent = parent ?? this.provider('agents').get(parentId)
      if (actualParent === undefined || agent.id === actualParent.id) refuse()
      this.parentCurrentForChild(agent.ctx, actualParent, workspace)
      const childScope = scopeOf(agent.ctx), parentScope = scopeOf(actualParent.ctx)
      if (childScope === undefined || parentScope === undefined || agent.session.header.parentSession !== actualParent.id
        || (agent.session.header.delegationDepth ?? 0) < delegationDepthOf(actualParent) + 1
        || scopeParentOf(childScope) !== scopeParentOf(parentScope)) refuse()
      if (attached && !this.provider('agents').isOwnedBy(agent.id, actualParent)) refuse()
    } else if (parent !== undefined) refuse()
    for (const key of ['fs', 'shell', 'subprocess', 'shellEnv', 'llm', 'subagents', 'workingDirectory'] as const) {
      const root: unknown = this.ctx.root.get(key), child: unknown = agent.ctx.get(key)
      if (root === undefined ? child !== undefined : !object(root) || !object(child) || original(root) !== original(child)) refuse()
    }
    if (attached && (this.provider('agents').get(agent.id) !== agent || this.provider('sessions').get(agent.id) !== agent.session
      || this.member(agent.id) !== workspace)) refuse()
    this.assertWorkspace(workspace)
    return workspace
  }

  parentCurrentForChild(owner: Context, parent: Agent, expected?: Workspace): Workspace {
    if (this.assertBusinessCurrent === undefined) unavailable()
    this.assertBusinessCurrent(this.binding)
    this.current()
    owner.fiber.assertActive()
    parent.ctx.fiber.assertActive()
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
    const workspace = this.sessionProject(parent.session, true)
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
    let found = 0
    for (const fiber of this.ctx.registry.get(Spawn)?.fibers ?? []) {
      if (++found > 1 || fiber.state !== FiberState.ACTIVE || fiber.runtime?.callback !== Spawn.apply
        || fiber.entry?.moduleNamespace !== Spawn || !object(fiber.config)
        || fiber.ctx.root !== this.ctx.root || fiber.ctx.get('peAccount') !== this.binding) refuse()
      const name: unknown = Reflect.get(fiber.config, 'providerName')
      if (typeof name !== 'string' || runtime.getProvider(name) === undefined
        || provider !== undefined && runtime.getProvider(name) !== provider) refuse()
    }
    if (found !== 1) unavailable()
  }

  private async auditGeneration(parent: Agent, signal: AbortSignal): Promise<void> {
    const scope = scopeOf(parent.ctx)
    if (scope === undefined) refuse()
    const generation = scopeParentOf(scope)
    if (generation === undefined) refuse()
    const inspection = this.provider('agentPresets').inspectCompositions(parent.ctx)
    if (inspection.length !== 1 || inspection[0]?.id !== this.config.presetId) refuse()
    const entries: Entry[] = []
    for (const runtime of this.ctx.registry.values()) for (const fiber of runtime.fibers) {
      if (scopeOf(fiber.ctx) !== generation || fiber.entry === undefined || fiber.entry.options.group) continue
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
    if (request.kind === 'start' && (request.provider.prepareContinuable === undefined || request.provider.inheritsParentContext
      || request.cwd !== workspace.path
      || request.spec.request.agentPreset !== undefined && request.spec.request.agentPreset !== this.config.presetId)) refuse()
    await this.directory(workspace, signal)
    this.parentCurrentForChild(request.owner, parent, workspace)
    await this.preset(request.kind === 'start' ? request.spec.request.agentPreset : request.agentPreset, signal)
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
      || header.agentPreset !== this.config.presetId || history.projections?.values.workingDirectory !== workspace.path
      || history.projections.values.agentPreset !== this.config.presetId) refuse()
    return Math.max(header.delegationDepth ?? 0, delegationDepthOf(parent) + 1)
  }

  async childCreate(options: Parameters<AccountNativeGuards['agents']['assertCreate']>[0], signal: AbortSignal): Promise<number> {
    const parent = options.parentAgent
    if (parent === undefined) refuse()
    const workspace = this.parentCurrentForChild(this.ctx, parent)
    this.prepared(parent, true)
    this.spawn()
    if (options.meta?.cwd !== workspace.path || options.meta.agentPreset !== this.config.presetId
      || options.meta.origin !== 'subagent' || options.meta.parentSession !== parent.id || options.meta.isSeeded
      || options.meta.delegationDepth !== delegationDepthOf(parent) + 1 || options.seed !== undefined) refuse()
    const runtimeDepth = options.agentOptions?.subagentDepth
    if (runtimeDepth !== undefined && (!Number.isSafeInteger(runtimeDepth)
      || runtimeDepth < 0 || runtimeDepth > options.meta.delegationDepth)) refuse()
    await this.directory(workspace, signal)
    this.parentCurrentForChild(this.ctx, parent, workspace)
    await this.preset(options.meta.agentPreset, signal)
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
    await this.preset(this.config.presetId, signal)
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
      || this.prepared(parent, true) !== workspace || scopeParentOf(parentScope) !== generation) refuse()
    const childGeneration = scopeParentOf(child)
    if (childGeneration !== undefined && childGeneration !== generation) refuse()
    const header = session.header
    this.sessionHeader(header, workspace.path)
    if (header.origin !== 'subagent' || header.parentSession !== parent.id || header.agentPreset !== this.config.presetId
      || (header.delegationDepth ?? 0) < delegationDepthOf(parent) + 1 || child.id === parent.id
      || this.provider('agents').get(child.id) !== undefined || this.provider('sessions').get(child.id) !== undefined
      || !this.allowedModel(child.options.provider ?? '', child.options.model ?? '')) refuse()
    for (const key of ['fs', 'shell', 'subprocess', 'shellEnv', 'llm', 'subagents', 'workingDirectory'] as const) {
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
        this.current()
        assertCaller()
        if (this.prepared(agent, true) !== workspace) refuse()
      }
      return { workspace, assertCurrent,
        ...this.provider('peAccountExecution').enforcesSessionFilePolicy !== true ? {} : {
          assertMutationPolicy: createAccountFileMutationGuard(this.ctx, agent.session, workspace.path, assertCurrent),
        } }
    }
    const invocation = caller.invocation
    if (invocation?.service !== 'workspaceFiles' || invocation.request.namespace !== 'workspaceFiles') refuse()
    const raw = invocation.request.args['workspaceFileScopeId']
    if (typeof raw !== 'string') refuse()
    const id = SessionId(raw), session = this.provider('sessions').get(id)
    if (session !== undefined) {
      const workspace = this.liveSessionProject(session)
      return { workspace, assertCurrent: () => {
        this.current()
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
    await this.preset(this.config.presetId, control)
    control.throwIfAborted()
    this.assertWorkspace(workspace)
    return { workspace, assertCurrent: () => {
      this.current()
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
 * @param config Explicit immutable deployment policy for exact models and one fixed native preset.
 * @param exposure Actual Root exposure policy, whose declarations must match enabled native handlers.
 * @param maxEntries Existing deployment bound on native Loader and preset inventory rows.
 * @param provisionableModel Optional original audited provider check for first-key bootstrap; actual model dispatch is unchanged.
 * @param assertBusinessCurrent Original business admission check; required for children and rechecked after awaits.
 * @returns Shared concrete Controller/factory/LLM guards; no account, Session or ready identity is created here.
 */
export function createAccountPolicy(
  ctx: Context, binding: AccountBinding, files: CloudAccountFiles, config: AccountPolicyConfig,
  exposure: ExposureService['policy'], maxEntries: number,
  provisionableModel?: (provider: string, model: string) => void,
  assertBusinessCurrent?: (binding: AccountBinding) => void,
): AccountNativeGuards {
  const policy = new AccountPolicy(ctx, binding, files, config, exposure, maxEntries, provisionableModel, assertBusinessCurrent)
  return {
    assertWorkspace: (workspace) => { policy.assertWorkspace(workspace) },
    projectForAgent: agent => policy.prepared(agent, true),
    projectForSession: session => policy.liveSessionProject(session),
    projectForObservedHeader: (id, header) => policy.observedProject(id, header),
    projectForDirectory: cwd => policy.workspaceAt(cwd),
    getFileProject: (caller, signal) => policy.fileProject(caller, signal),
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
        await policy.preset(request.agentPreset)
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
          workspaceId: workspace.id, agentPreset: config.presetId }
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
        if (options.meta?.agentPreset !== config.presetId) refuse()
        await policy.preset(options.meta.agentPreset, signal)
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
