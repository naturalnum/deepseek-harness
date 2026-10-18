/** Private account-graph admission and native Session Controller assembly. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SessionController, { type SessionControlBufferLimits } from '@deepseek-ai/dsh-api-session-controller'
import type {
  SessionCreateRequest, SessionCreateValue, SessionPromptRequest, SessionPromptValue,
  SessionCancelRequest, SessionCancelValue, SessionForkRequest, SessionForkValue,
  SessionAddress, SessionPageRequest, SessionPage, SessionFollowRequest, SessionFollowFrame,
  SessionListRequest, SessionListValue, SessionControlFrame, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { CloudApiError } from './errors.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import type { ExposurePolicy } from './exposure.ts'
import type { ExposureInventory } from './types.ts'

/** Fixed files-owned directory capability for one installed account graph; not a path-derived grant. */
export interface NativeSessionDirectory {
  /** Exact installed graph binding used when the trusted files capability was issued. */
  readonly binding: AccountBinding
  /**
   * Prepare an already approved project through the existing bounded files lane.
   * Existing S2 projects may use directory validation after registration closes.
   * New directories still require the files provider's original approval/window.
   * @param cwd - native resolved project path, which does not itself confer authority.
   * @returns actual directory preparation/validation completion; failures retain native meaning.
   */
  prepare(cwd: string): Promise<void>
}

/** Explicit readonly limits and original shared metadata check; absent means list/control stay closed. */
export interface NativeSessionReadGuards {
  readonly maxCollectionItems: number
  readonly maxFrameBytes: number
  readonly maxQueuedEvents: number
  readonly maxQueuedBytes: number
  /**
   * Check original Session/Workspace metadata without creating a project grant or requiring post-attach Agent state.
   * @param id - identity read from the actual native result or notification.
   * @param summary - actual original list row when a cold header-derived view is available.
   */
  readonly assertSessionRead: (id: SessionId, summary?: SessionSummary) => void
}

/**
 * Shared guards supplied by trusted account assembly, using the files-owned
 * project resolver and approved native Preset/model configuration. These
 * callbacks neither issue account identity nor establish a second Session store.
 */
export interface NativeSessionGuards {
  /** Fixed graph-owned directory capability; never an HTTP/Peer AccountUse borrow. */
  readonly projectDirectory: NativeSessionDirectory
  /** Optional actual first-screen reader; its omission keeps inherited list/control unavailable. */
  readonly firstScreen?: NativeSessionReadGuards
  /** Require a handler in this account's actual enabled native composition. */
  assertHandlerEnabled(handlerId: string): void
  /** Resolve and verify the project's location and approved Preset without creating a Session. */
  resolveCreate(request: SessionCreateRequest): Promise<SessionCreateRequest>
  /** Check the native Session's project before commands or ordinary history reads. */
  assertSessionProject(sessionId: SessionId): Promise<void>
  /**
   * Check the attached Agent's existing approved project/directory evidence
   * synchronously. Reuse the shared provider; do not read, resume or cache approval.
   * @param agent - actual attached native Agent, after graph-binding validation.
   */
  assertActiveScope(agent: NonNullable<ReturnType<Context['agents']['get']>>): void
}

class NativeSessionAdmission {
  private readonly directory: NativeSessionDirectory
  private readonly prepareDirectory: NativeSessionDirectory['prepare']
  private readonly reader: NativeSessionReadGuards | undefined

  constructor(
    private readonly ctx: Context,
    private readonly binding: AccountBinding,
    private readonly assertCurrent: (binding: AccountBinding) => void,
    private readonly policy: ExposurePolicy,
    private readonly guards: NativeSessionGuards,
  ) {
    this.directory = guards.projectDirectory
    this.prepareDirectory = this.directory.prepare.bind(this.directory)
    const reader = guards.firstScreen
    if (reader !== undefined) {
      for (const maximum of [reader.maxCollectionItems, reader.maxFrameBytes, reader.maxQueuedEvents, reader.maxQueuedBytes]) {
        if (!Number.isSafeInteger(maximum) || maximum < 1) {
          throw new CloudApiError('cloud/invalid-config', 'Native first-screen reads require explicit finite limits.')
        }
      }
      this.reader = Object.freeze({ maxCollectionItems: reader.maxCollectionItems, maxFrameBytes: reader.maxFrameBytes,
        maxQueuedEvents: reader.maxQueuedEvents, maxQueuedBytes: reader.maxQueuedBytes,
        assertSessionRead: reader.assertSessionRead.bind(reader) })
    }
  }

  assertBinding(): void {
    if (this.binding.lifetime.aborted || this.ctx.get('peAccount') !== this.binding || this.ctx.root.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The native Controller and account graph have different bindings.')
    }
    if (this.binding.recipeVersion !== this.policy.manifest.recipeVersion) {
      throw new CloudApiError('cloud/invalid-config', 'Account and exposure recipe versions differ.')
    }
  }

  async create(request: SessionCreateRequest): Promise<SessionCreateRequest> {
    this.admit('session/create', 'account-project')
    const resolved = await this.guards.resolveCreate(request)
    if (resolved.workspaceId === undefined && resolved.cwd === undefined) {
      throw new CloudApiError('cloud/account-unavailable', 'A verified project location is required before native creation.')
    }
    return resolved
  }

  async ensureProjectDirectory(cwd: string): Promise<void> {
    this.admit('session/create', 'account-project')
    this.assertDirectoryBinding()
    await this.prepareDirectory(cwd)
    this.admit('session/create', 'account-project')
    this.assertDirectoryBinding()
  }

  private assertDirectoryBinding(): void {
    this.assertBinding()
    if (this.directory.binding !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The Session directory capability belongs to another account graph.')
    }
  }

  async session(endpoint: 'session/prompt' | 'session/fork', sessionId: SessionId): Promise<void> {
    this.admit(endpoint, 'account-session')
    await this.guards.assertSessionProject(sessionId)
  }

  async history(endpoint: 'session/page' | 'session/follow', address: SessionAddress): Promise<void> {
    this.admitHistory(endpoint)
    // Subagent history has separate parent/mode authority; this slice admits only ordinary Sessions.
    if (address.kind !== 'session') {
      throw new CloudApiError('cloud/forbidden', 'Subagent history is not admitted by this account adapter.')
    }
    await this.guards.assertSessionProject(address.sessionId)
  }

  historySignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.binding.lifetime])
  }

  admitHistory(endpoint: 'session/page' | 'session/follow'): void {
    this.admit(endpoint, 'account-session', endpoint === 'session/follow' ? 'stream' : 'rpc')
  }

  hasReader(): boolean { return this.reader !== undefined }

  controlBufferLimits(): SessionControlBufferLimits | undefined { return this.reader }

  admitRead(endpoint: 'session/list' | 'session/control'): void {
    if (this.reader === undefined) {
      throw new CloudApiError('cloud/account-unavailable', 'The original first-screen Session reader is absent.')
    }
    this.admit(endpoint, 'account-session', endpoint === 'session/control' ? 'stream' : 'rpc')
  }

  read(endpoint: 'session/list' | 'session/control', value: SessionListValue | SessionControlFrame): void {
    this.admitRead(endpoint)
    const reader = this.reader
    if (reader === undefined) throw new CloudApiError('cloud/account-unavailable', 'The original Session reader is absent.')
    firstScreenJsonBytes(value, reader.maxFrameBytes)
    const ids = 'items' in value ? value.items.map(row => row.sessionId)
      : value.type === 'baseline' ? Object.keys(value.value.projections).map(SessionId) : [value.sessionId]
    if (ids.length > reader.maxCollectionItems) {
      throw new CloudApiError('cloud/account-unavailable', 'The native first-screen collection exceeds its explicit limit.')
    }
    if ('items' in value) {
      for (const row of value.items) reader.assertSessionRead(row.sessionId, row)
    } else for (const id of ids) reader.assertSessionRead(id)
    this.admitRead(endpoint)
  }

  cancel(sessionId: SessionId): void {
    this.admit('session/cancel', 'account-session')
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return
    if (agent.ctx.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The attached Agent belongs to another account graph.')
    }
    agent.ctx.fiber.assertActive()
    this.guards.assertActiveScope(agent)
    this.admit('session/cancel', 'account-session')
    if (this.ctx.agents.get(sessionId) !== agent) {
      throw new CloudApiError('cloud/account-unavailable', 'The attached Agent changed during scope validation.')
    }
  }

  admit(endpoint: string, guard: 'account-project' | 'account-session', mode: 'rpc' | 'stream' = 'rpc'): void {
    this.assertBinding()
    this.ctx.fiber.assertActive()
    this.assertCurrent(this.binding)
    const declared = mode === 'stream' ? this.policy.requireStream(endpoint) : this.policy.requireRpc(endpoint)
    if (declared.guard !== guard) {
      throw new CloudApiError('cloud/invalid-config', 'Native Session operation requires its reviewed resource guard.')
    }
    this.guards.assertHandlerEnabled(declared.handlerId)
  }

}

class AccountSessionController extends SessionController {
  constructor(
    ctx: Context,
    config: ConstructorParameters<typeof SessionController>[1],
    private readonly admission: NativeSessionAdmission,
  ) { super(ctx, config) }

  protected override ensureProjectDirectory(cwd: string): Promise<void> {
    return this.admission.ensureProjectDirectory(cwd)
  }

  protected override controlBufferLimits(): SessionControlBufferLimits | undefined {
    return this.admission.controlBufferLimits()
  }

  override async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    const resolved = await this.admission.create(request)
    this.admission.admit('session/create', 'account-project')
    return super.create(resolved)
  }

  override async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    await this.admission.session('session/prompt', request.sessionId)
    this.admission.admit('session/prompt', 'account-session')
    return super.prompt(request, signal)
  }

  override async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    await this.admission.session('session/fork', request.sessionId)
    this.admission.admit('session/fork', 'account-session')
    return super.fork(request)
  }

  override cancel(request: SessionCancelRequest): SessionCancelValue {
    this.admission.cancel(request.sessionId)
    return super.cancel(request)
  }

  /** Actual optional reader installation, used only by native inventory inspection. */
  hasFirstScreenReader(): boolean { return this.admission.hasReader() }

  override async list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
    const control = this.admission.historySignal(signal)
    control.throwIfAborted()
    this.admission.admitRead('session/list')
    const value = await super.list(_request, control)
    control.throwIfAborted()
    this.admission.read('session/list', value)
    return value
  }

  override async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const control = this.admission.historySignal(signal)
    control.throwIfAborted()
    this.admission.admitRead('session/control')
    const source = super.control(control)[Symbol.asyncIterator]()
    try {
      while (true) {
        this.admission.admitRead('session/control')
        const next = await source.next()
        control.throwIfAborted()
        this.admission.admitRead('session/control')
        if (next.done) return
        this.admission.read('session/control', next.value)
        yield next.value
      }
    } finally { await source.return?.() }
  }

  override async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    const nativeSignal = this.admission.historySignal(signal)
    nativeSignal.throwIfAborted()
    await this.admission.history('session/page', request.address)
    this.admission.admitHistory('session/page')
    nativeSignal.throwIfAborted()
    const page = await super.page(request, nativeSignal)
    this.admission.admitHistory('session/page')
    nativeSignal.throwIfAborted()
    return page
  }

  override async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const nativeSignal = this.admission.historySignal(signal)
    nativeSignal.throwIfAborted()
    await this.admission.history('session/follow', request.address)
    this.admission.admitHistory('session/follow')
    nativeSignal.throwIfAborted()
    const source = super.follow(request, nativeSignal)[Symbol.asyncIterator]()
    try {
      while (true) {
        // Native cold promotion resumes after the snapshot yield, inside the next advance.
        this.admission.admitHistory('session/follow')
        nativeSignal.throwIfAborted()
        const next = await source.next()
        this.admission.admitHistory('session/follow')
        nativeSignal.throwIfAborted()
        if (next.done) return
        yield next.value
      }
    } finally {
      await source.return?.()
    }
  }
}

/**
 * Construct the sole native Session Controller in its owning account fiber.
 * The caller declares the native Controller's dependencies and excludes a second
 * base Controller from the recipe. Native Remote markers, Config and business
 * implementation remain inherited. Installation validates the binding; runtime
 * readiness is checked on each call, after shared asynchronous validation too.
 * Ordinary history reads retain native behavior; follow rechecks each advance
 * and frame delivery and passes caller/graph cancellation to the native iterator.
 * Subagent history addresses remain denied pending their separate scope review.
 * @param ctx - owning fiber in the independent, runtime-bound account graph.
 * @param binding - installed graph lifetime, never a request borrow or signal.
 * @param assertCurrent - trusted graph admission shared with the actual LLM guard;
 * never AccountUse.assertCurrent bound to an HTTP/Peer borrow.
 * @param policy - deployment policy audited against this graph's native inventory.
 * @param guards - shared project/Preset/active-Agent checks and the fixed files directory capability.
 * @param config - original native Controller configuration.
 * @returns the registered native Controller, owned by ctx's fiber.
 * @throws CloudApiError for a mismatched installation binding; native construction errors retain identity.
 */
export function createNativeController(
  ctx: Context,
  binding: AccountBinding,
  assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy,
  guards: NativeSessionGuards,
  config: ConstructorParameters<typeof SessionController>[1],
): SessionController {
  const admission = new NativeSessionAdmission(ctx, binding, assertCurrent, policy, guards)
  admission.assertBinding()
  return new AccountSessionController(ctx, config, admission)
}

/**
 * Read only the actual cloud subclass's guarded native Remote implementations.
 * @param controller Original API-created Controller, never a manifest or a caller descriptor.
 * @param recipeVersion Current installed graph recipe.
 * @param maximum Explicit upper bound on native method metadata.
 * @returns Native RPC/stream declarations backed by the original guarded methods; no Fetch adapter exists here.
 * @throws CloudApiError for foreign bindings, replaced implementations or excessive native metadata.
 */
export function inspectNativeController(
  controller: SessionController, recipeVersion: string, maximum: number,
): ExposureInventory {
  const target: unknown = Reflect.get(controller, symbols.original)
  const actual = target instanceof AccountSessionController ? target : controller
  if (!(actual instanceof AccountSessionController)) {
    throw new CloudApiError('cloud/account-unavailable', 'Prepared inventory requires the original guarded Controller.')
  }
  const binding = actual.typertRemote
  if (binding.service !== actual || binding.serviceKey !== 'sessionController' || binding.namespace !== 'session') {
    throw new CloudApiError('cloud/stale-generation', 'Native Controller dispatch binding changed.')
  }
  const methods = remoteMethods(actual)
  if (!Number.isSafeInteger(maximum) || maximum < 1 || methods.length > maximum) {
    throw new CloudApiError('cloud/account-unavailable', 'Native method inventory exceeds its explicit limit.')
  }
  const rpc: ExposureInventory['rpcEndpoints'][number][] = [], stream: ExposureInventory['streamEndpoints'][number][] = []
  for (const marker of methods) {
    const method = marker.method
    if (!['create', 'prompt', 'fork', 'cancel', 'page', 'follow'].includes(method)
      && !(actual.hasFirstScreenReader() && ['list', 'control'].includes(method))) continue
    const streaming = method === 'follow' || method === 'control'
    if ((marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== (streaming ? 'stream' : 'rpc')
      || Reflect.get(actual, method) !== Reflect.get(AccountSessionController.prototype, method)) {
      throw new CloudApiError('cloud/account-unavailable', 'The original native guarded method changed.')
    }
    const row = Object.freeze({ endpoint: `${binding.namespace}/${method}`, handlerId: `native:${binding.serviceKey}`,
      guard: method === 'create' ? 'account-project' as const : 'account-session' as const })
    if (streaming) stream.push(row)
    else rpc.push(row)
  }
  return Object.freeze({ recipeVersion, rpcEndpoints: Object.freeze(rpc), streamEndpoints: Object.freeze(stream),
    exactFetchRoutes: Object.freeze([]) })
}
