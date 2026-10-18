/** One account's concrete project/model/Preset checks over original native services; this issues no ready state. */
import { createHash } from 'node:crypto'
import { FiberState, symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CloudApiError, type ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { AccountBinding } from './types.ts'
import { ACCOUNT_NATIVE_ENTRIES, type AccountNativeGuards } from './account-native-integration.ts'

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
type EntryFact = { readonly entry: Entry; readonly fiber: Fiber; readonly plan: ReturnType<Entry['prepareConfigUpdate']> }
type Agent = Parameters<AccountNativeGuards['agents']['assertPrepared']>[0]
type Selection = { readonly provider?: string; readonly model?: string }
type Header = Pick<SessionHeader, 'cwd' | 'origin' | 'parentSession' | 'delegationDepth'> & { readonly isSeeded?: boolean }

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

  constructor(
    private readonly ctx: Context, private readonly binding: AccountBinding, private readonly files: CloudAccountFiles,
    private readonly config: AccountPolicyConfig, private readonly exposure: ExposureService['policy'], private readonly maxEntries: number,
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
      if (fact.entry.fiber !== fact.fiber || fact.fiber.state !== FiberState.ACTIVE) unavailable()
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

  async directory(signal?: AbortSignal) {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    const project = this.project()
    await project.projectDirectory.prepare(project.workspace.path)
    control.throwIfAborted()
    if (this.project() !== project) refuse()
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
      return { entry, fiber, plan }
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
    const project = this.project()
    this.pin()
    const presets = this.provider('agentPresets')
    if (!(presets instanceof AgentPresets) || presets.defaultId !== this.config.presetId) refuse()
    const resolved = await presets.resolve(this.config.presetId)
    control.throwIfAborted()
    this.current()
    if (this.project() !== project || presets.defaultId !== this.config.presetId
      || resolved.id !== this.config.presetId || resolved.broken !== undefined) refuse()
    const inventory = await presets.compositionInventory()
    control.throwIfAborted()
    this.current()
    if (this.project() !== project || presets.defaultId !== this.config.presetId) refuse()
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
    const project = this.project()
    const resolved = await this.provider('llm').resolveModelInfo(provider, model, control)
    control.throwIfAborted()
    this.current()
    if (this.project() !== project) refuse()
    if (resolved.provider !== provider || resolved.id !== model || !this.allowedModel(provider, model)) modelDenied()
  }

  async assertBootstrapCurrent(signal?: AbortSignal): Promise<void> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    control.throwIfAborted()
    const project = this.project(), { provider, model } = this.defaultModel()
    if (provider === undefined || model === undefined) modelDenied()
    const selection = { provider, model }
    this.handlers('native:sessionController')
    await this.preset(this.config.presetId, control)
    await this.model(selection, control)
    control.throwIfAborted()
    this.current()
    const current = this.defaultModel()
    if (this.project() !== project || current.provider !== selection.provider || current.model !== selection.model) unavailable()
    this.handlers('native:sessionController')
  }

  header(header: Header, path: string): void {
    if (header.cwd !== path || header.origin !== undefined || header.parentSession !== undefined
      || (header.delegationDepth ?? 0) !== 0 || header.isSeeded) refuse()
  }

  async history(id: SessionId, signal?: AbortSignal): Promise<void> {
    const control = signal === undefined ? this.binding.lifetime : AbortSignal.any([signal, this.binding.lifetime])
    const project = await this.directory(control)
    const query = this.provider('sessionQuery')
    using observed = await query.observeSession(id, { projectionMode: 'all', signal: control })
    control.throwIfAborted()
    this.current()
    this.header(observed.header, project.workspace.path)
    if (observed.header.id !== id || !project.workspace.sessionIds.includes(id)
      || this.project() !== project || observed.projections?.values.workingDirectory !== project.workspace.path) refuse()
    const preset = observed.projections.values.agentPreset
    if (preset !== this.config.presetId) refuse()
    await this.preset(preset, control)
    this.current()
    if (this.project() !== project || !project.workspace.sessionIds.includes(id)) refuse()
  }

  prepared(agent: Agent, attached: boolean): void {
    this.current()
    const project = this.project()
    if (this.facts === undefined || this.modules === undefined || agent.ctx.root !== this.ctx.root
      || agent.ctx.get('peAccount') !== this.binding || agent.id !== agent.session.header.id) refuse()
    agent.ctx.fiber.assertActive()
    this.header(agent.session.header, project.workspace.path)
    if (!this.allowedModel(agent.options.provider ?? '', agent.options.model ?? '')
      || this.provider('workingDirectory').get(agent.session) !== project.workspace.path
      || this.provider('sessionProjections').stateOf(agent.session, 'agentPreset') !== this.config.presetId) refuse()
    const presets = this.provider('agentPresets')
    const composition = presets.inspectCompositions(agent.ctx), row = composition[0]
    if (presets.composedPreset(agent.ctx) !== this.config.presetId || composition.length !== 1 || row === undefined
      || row.id !== this.config.presetId || row.leakedServices.length !== 0 || row.modules.length !== this.modules.length
      || row.modules.some((module, index) => module.moduleName !== this.modules?.[index])) refuse()
    if (attached && (this.provider('agents').get(agent.id) !== agent || !project.workspace.sessionIds.includes(agent.id))) refuse()
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
 * @returns Shared concrete Controller/factory/LLM guards; no account, Session or ready identity is created here.
 */
export function createAccountPolicy(
  ctx: Context, binding: AccountBinding, files: CloudAccountFiles, config: AccountPolicyConfig,
  exposure: ExposureService['policy'], maxEntries: number,
): AccountNativeGuards {
  const policy = new AccountPolicy(ctx, binding, files, config, exposure, maxEntries)
  return {
    assertBootstrapCurrent: signal => policy.assertBootstrapCurrent(signal),
    sessions: {
      assertHandlerEnabled: (id) => { policy.handlers(id) },
      resolveCreate: async (request) => {
        const project = await policy.directory()
        if ((request.workspaceId !== undefined && request.cwd !== undefined)
          || (request.workspaceId !== undefined && request.workspaceId !== project.workspace.id)
          || (request.cwd !== undefined && request.cwd !== project.workspace.path)) refuse()
        await policy.preset(request.agentPreset)
        await policy.model(policy.defaultModel())
        if (request.sessionId !== undefined) {
          try { await policy.history(request.sessionId) }
          catch (error) {
            if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
          }
        }
        policy.current()
        if (policy.project() !== project) refuse()
        return { ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
          workspaceId: project.workspace.id, agentPreset: config.presetId }
      },
      assertSessionProject: id => policy.history(id),
      assertActiveScope: (agent) => { policy.prepared(agent, true) },
    },
    agents: {
      assertCreate: async (options, signal) => {
        const project = await policy.directory(signal)
        policy.header(options.meta ?? {}, project.workspace.path)
        if (options.meta?.cwd !== project.workspace.path || options.meta.agentPreset !== config.presetId) refuse()
        await policy.preset(options.meta.agentPreset, signal)
        await policy.model(options.agentOptions, signal)
        policy.current()
        if (policy.project() !== project) refuse()
      },
      assertResume: async (options, signal) => {
        await policy.history(options.resumeSessionId, signal)
        await policy.model(options.agentOptions, signal)
        policy.current()
      },
      assertPrepared: (agent) => { policy.prepared(agent, false) },
    },
    allowedModel: (provider, model) => policy.allowedModel(provider, model),
  }
}
