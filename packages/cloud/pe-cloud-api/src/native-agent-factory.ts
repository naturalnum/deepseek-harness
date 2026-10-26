/** Private graph-bound admission around the public native AgentLoop factory transaction. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { AgentDisposalObserver, AgentDisposalStatus, AgentHandle } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { SubagentCapacityReservation, AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { CloudApiError } from './errors.ts'

type CreateOptions = Parameters<AgentLoop['createAgent']>[1]
type ResumeOptions = Parameters<AgentLoop['resume']>[1]
type PreparedAgent = Awaited<ReturnType<AgentLoop['createAgent']>>['agent']
type Setup = NonNullable<CreateOptions['setup']>

/** Shared provider checks; these callbacks issue neither identities nor cached approval. */
export interface NativeAgentFactoryGuards {
  /**
   * Verify the actual project, model and Preset before persistence creation.
   * Child approval also requires the exact live parent and original graph; return its actual depth.
   * @param options - original native create inputs, including the trusted composition callback.
   * @param signal - caller/graph cancellation; retain actual work until it settles.
   * @returns the actual child depth, or void for an ordinary root; rejection prevents native delegation.
   */
  assertCreate(options: CreateOptions, signal: AbortSignal): Promise<void | number>
  /**
   * Read the account's native history and verify root or child metadata, project,
   * model and Preset before native write ownership or crash repair. A path or id
   * alone cannot establish that approval.
   * @param options - original native resume inputs and trusted setup callback.
   * @param signal - caller/graph cancellation; retain actual read work until settlement.
   * @returns the actual child depth including runtime options, or void for a root; rejection prevents write-open.
   */
  assertResume(options: ResumeOptions, signal: AbortSignal): Promise<void | number>
  /**
   * Verify the actual Agent's project, model and composed Preset after setup,
   * around commit, at native publication checkpoints and before returning its handle.
   * @param agent - actual prepared or published Agent in this exact installed graph.
   * @param parent - exact live parent for a child; omitted for an ordinary root.
   * @throws when existing approved evidence is missing, unknown or no longer current.
   */
  assertPrepared(agent: PreparedAgent, parent?: CreateOptions['parentAgent']): void
  /** Attach the actual prepared child through its original Workspace owner before publication.
   * @param agent Original unpublished child after native setup.
   * @param parent Exact live parent already checked by the shared policy.
   * @param signal Actual factory cancellation; metadata work remains with its original owner.
   * @returns after original membership persistence and current checks settle.
   */
  prepareChild?(agent: PreparedAgent, parent: NonNullable<CreateOptions['parentAgent']>, signal: AbortSignal): Promise<void>
  /** Run original child setup with preparation-only directory admission owned by the shared policy.
   * @param child Exact unpublished Agent received from the original native setup callback.
   * @param parent Original live parent already checked by the factory.
   * @param signal Same creation cancellation; actual setup and I/O remain with their original owners.
   * @param operation Invoke original setup once; it neither publishes nor transfers preparation authority.
   * @returns Original setup result after preparation admission has been revoked, without claiming I/O settlement.
   */
  withChildPreparation?<T>(
    this: void, child: PreparedAgent, parent: NonNullable<CreateOptions['parentAgent']>, signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T>
}

class FactoryAdmission {
  constructor(
    private readonly ctx: Context,
    private readonly binding: AccountBinding,
    private readonly assertCurrent: (binding: AccountBinding) => void,
    private readonly guards: NativeAgentFactoryGuards,
    private readonly reserveSubagent: ((depth: number) => SubagentCapacityReservation) | undefined,
  ) {}

  installed(owner: Context): void {
    this.ctx.fiber.assertActive()
    owner.fiber.assertActive()
    if (this.binding.lifetime.aborted || this.ctx.get('peAccount') !== this.binding
      || this.ctx.root.get('peAccount') !== this.binding || owner.get('peAccount') !== this.binding
      || owner.root.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The native Agent factory and owner have different graph bindings.')
    }
  }

  admit(owner: Context): void {
    this.installed(owner)
    this.assertCurrent(this.binding)
  }

  signal(caller: AbortSignal | undefined): AbortSignal {
    return AbortSignal.any(caller === undefined ? [this.binding.lifetime] : [caller, this.binding.lifetime])
  }

  root(meta: NonNullable<CreateOptions['meta']>): void {
    if (meta.origin !== undefined || meta.parentSession !== undefined || (meta.delegationDepth ?? 0) !== 0 || meta.isSeeded === true) {
      throw new CloudApiError('cloud/forbidden', 'Parent, subagent and seeded Session activation is not admitted by this factory.')
    }
    if (meta.cwd === undefined || meta.cwd.length === 0) {
      throw new CloudApiError('cloud/account-unavailable', 'A verified ordinary Session project is required before activation.')
    }
  }

  parent(owner: Context, parent: NonNullable<CreateOptions['parentAgent']>): void {
    this.admit(owner)
    parent.ctx.fiber.assertActive()
    const same = (left: object | undefined, right: object | undefined): boolean =>
      left !== undefined && right !== undefined
      && (Reflect.get(left, symbols.original) ?? left) === (Reflect.get(right, symbols.original) ?? right)
    const agents = this.ctx.get('agents'), sessions = this.ctx.get('sessions')
    if (parent.ctx.root !== this.ctx.root || parent.ctx.get('peAccount') !== this.binding
      || parent.ctx.root.get('peAccount') !== this.binding || agents?.get(parent.id) !== parent
      || sessions?.get(parent.id) !== parent.session || parent.session.id !== parent.id
      || parent.session.header.id !== parent.id
      || !same(agents, owner.get('agents')) || !same(agents, parent.ctx.get('agents'))
      || !same(agents, this.ctx.root.get('agents')) || !same(sessions, owner.get('sessions'))
      || !same(sessions, parent.ctx.get('sessions')) || !same(sessions, this.ctx.root.get('sessions'))) {
      throw new CloudApiError('cloud/stale-generation', 'Child activation requires the original live parent and registries in this graph.')
    }
  }

  private child(owner: Context, parent: NonNullable<CreateOptions['parentAgent']>): void {
    if (this.reserveSubagent === undefined || this.guards.prepareChild === undefined
      || this.guards.withChildPreparation === undefined) {
      throw new CloudApiError('cloud/forbidden', 'Child activation requires the original Root resource settlement callback.')
    }
    this.parent(owner, parent)
  }

  returned(owner: Context, agent: PreparedAgent, signal: AbortSignal, parent: CreateOptions['parentAgent'], depth: number | void): void {
    this.prepared(owner, agent.id, agent, signal, parent, depth)
    this.guards.assertPrepared(agent, parent)
    if (this.ctx.get('agents')?.get(agent.id) !== agent || this.ctx.get('sessions')?.get(agent.id) !== agent.session
      || parent !== undefined && this.ctx.get('agents')?.isOwnedBy(agent.id, parent) !== true) {
      throw new CloudApiError('cloud/stale-generation', 'The returned Agent is not the original published factory result.')
    }
  }

  reserve(depth: number): SubagentCapacityReservation {
    if (this.reserveSubagent === undefined) throw new CloudApiError('cloud/forbidden', 'Child capacity is unavailable.')
    return this.reserveSubagent(depth)
  }

  async create(owner: Context, options: CreateOptions, signal: AbortSignal): Promise<void | number> {
    this.admit(owner)
    signal.throwIfAborted()
    const parent = options.parentAgent
    if (parent !== undefined) {
      this.child(owner, parent)
      if (options.observeDisposal !== undefined || options.seed !== undefined || (options.inheritedEventCount ?? 0) !== 0
        || options.meta?.origin !== 'subagent' || options.meta.parentSession !== parent.id
        || options.meta.isSeeded === true || options.sessionId === parent.id
        || options.meta.delegationDepth !== delegationDepthOf(parent) + 1) {
        throw new CloudApiError('cloud/forbidden', 'The native child creation inputs are not approved.')
      }
      const depth = await this.guards.assertCreate(options, signal)
      this.parent(owner, parent)
      signal.throwIfAborted()
      if (depth !== options.meta.delegationDepth) throw new CloudApiError('cloud/forbidden', 'Actual child depth was not verified.')
      return depth
    }
    if (options.seed !== undefined || (options.inheritedEventCount ?? 0) !== 0) {
      throw new CloudApiError('cloud/forbidden', 'Seeded Agent creation is not admitted by this factory.')
    }
    this.root(options.meta ?? {})
    await this.guards.assertCreate(options, signal)
  }

  async resume(owner: Context, options: ResumeOptions, signal: AbortSignal): Promise<void | number> {
    this.admit(owner)
    signal.throwIfAborted()
    const parent = options.parentAgent
    if (parent !== undefined) {
      this.child(owner, parent)
      if (options.observeDisposal !== undefined || options.resumeSessionId === parent.id) {
        throw new CloudApiError('cloud/forbidden', 'The native child resume inputs are not approved.')
      }
      const depth = await this.guards.assertResume(options, signal)
      this.parent(owner, parent)
      signal.throwIfAborted()
      if (depth === undefined || !Number.isSafeInteger(depth) || depth < delegationDepthOf(parent) + 1) {
        throw new CloudApiError('cloud/forbidden', 'Actual cold-child depth was not verified.')
      }
      return depth
    }
    await this.guards.assertResume(options, signal)
  }

  setup(owner: Context, id: PreparedAgent['id'], original: CreateOptions['setup'], signal: AbortSignal, parent?: CreateOptions['parentAgent'], depth?: number | void, uncertain?: () => void): Setup {
    return async (scope, agent) => {
      this.prepared(owner, id, agent, signal, parent, depth)
      let originalCommit: Awaited<ReturnType<Setup>>
      if (parent === undefined) originalCommit = await original?.(scope, agent)
      else {
        const preparing = this.guards.withChildPreparation
        if (preparing === undefined) throw new CloudApiError('cloud/forbidden', 'Original child preparation admission is unavailable.')
        originalCommit = await preparing(agent, parent, signal, () => Promise.resolve(original?.(scope, agent)))
      }
      this.prepared(owner, id, agent, signal, parent, depth)
      if (parent !== undefined) {
        if (this.guards.prepareChild === undefined) throw new CloudApiError('cloud/forbidden', 'Original child Workspace publication is unavailable.')
        try { await this.guards.prepareChild(agent, parent, signal) }
        catch (error: unknown) { uncertain?.(); throw error }
        this.prepared(owner, id, agent, signal, parent, depth)
      }
      this.guards.assertPrepared(agent, parent)
      const assertCurrent = (): void => {
        this.prepared(owner, id, agent, signal, parent, depth)
        this.guards.assertPrepared(agent, parent)
        originalCommit?.assertCurrent?.()
        this.prepared(owner, id, agent, signal, parent, depth)
        this.guards.assertPrepared(agent, parent)
      }
      return { assertCurrent, commit: () => {
        this.prepared(owner, id, agent, signal, parent, depth)
        this.guards.assertPrepared(agent, parent)
        originalCommit?.commit()
        this.prepared(owner, id, agent, signal, parent, depth)
        this.guards.assertPrepared(agent, parent)
        this.admit(owner)
        signal.throwIfAborted()
      } }
    }
  }

  private prepared(owner: Context, id: PreparedAgent['id'], agent: PreparedAgent, signal: AbortSignal, parent?: CreateOptions['parentAgent'], depth?: number | void): void {
    this.admit(owner)
    signal.throwIfAborted()
    agent.ctx.fiber.assertActive()
    if (agent.id !== id || agent.session.header.id !== id || agent.ctx.get('peAccount') !== this.binding
      || agent.ctx.root.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The prepared Agent does not belong to this native factory graph.')
    }
    if (parent === undefined) this.root(agent.session.header)
    else {
      this.parent(owner, parent)
      const header = agent.session.header
      if (header.origin !== 'subagent' || header.parentSession !== parent.id || header.isSeeded
        || (header.delegationDepth ?? 0) < delegationDepthOf(parent) + 1 || id === parent.id
        || depth === undefined || delegationDepthOf(agent) !== depth) {
        throw new CloudApiError('cloud/forbidden', 'The prepared child lineage is not approved.')
      }
    }
  }
}

class AccountAgentLoop extends AgentLoop {
  constructor(
    ctx: Context,
    config: ConstructorParameters<typeof AgentLoop>[1],
    private readonly admission: FactoryAdmission,
  ) {
    // The native constructor's configured restore/resume path bypasses public factory methods.
    if (config.agents.length !== 0) {
      throw new CloudApiError('cloud/invalid-config', 'The account AgentLoop recipe must have an empty startup agents list.')
    }
    super(ctx, config)
  }

  override create(..._args: Parameters<AgentLoop['create']>): ReturnType<AgentLoop['create']> {
    return Promise.reject(new CloudApiError(
      'cloud/forbidden', 'Direct AgentLoop creation is not admitted; use the guarded AgentRegistry factory.',
    ))
  }

  private async checkedReturn(owner: Context, actual: Promise<AgentHandle>, signal: AbortSignal,
    parent: CreateOptions['parentAgent'], depth: number | void): Promise<AgentHandle> {
    const handle = await actual
    try {
      this.admission.returned(owner, handle.agent, signal, parent, depth)
      return handle
    } catch (error: unknown) {
      try { await handle.dispose() }
      catch (_cleanup) { /* The native owner and disposal observer retain cleanup failure; preserve the admission failure. */ }
      throw error
    }
  }

  private async withReservation<T>(
    depth: number | void, operation: (observe?: AgentDisposalObserver, uncertain?: () => void) => Promise<T>,
  ): Promise<T> {
    if (depth === undefined) return operation()
    const reservation = this.admission.reserve(depth)
    let settlement: AgentDisposalStatus | 'pending' = 'pending'
    const settle = (status: AgentDisposalStatus): void => {
      if (settlement !== 'pending') return
      settlement = status
      reservation.settle(status)
    }
    try { return await operation(settle, () => { settle('unknown') }) }
    catch (error: unknown) { settle('unknown'); throw error }
  }

  override async createAgent(owner: Context, options: CreateOptions): ReturnType<AgentLoop['createAgent']> {
    const signal = this.admission.signal(options.signal)
    const depth = await this.admission.create(owner, options, signal)
    this.admission.admit(owner)
    signal.throwIfAborted()
    return this.withReservation(depth, (observeDisposal, uncertain) => this.checkedReturn(owner, super.createAgent(owner, {
      ...options, signal, ...observeDisposal === undefined ? {} : { observeDisposal },
      setup: this.admission.setup(owner, options.sessionId, options.setup, signal, options.parentAgent, depth, uncertain),
    }), signal, options.parentAgent, depth))
  }

  override async resume(owner: Context, options: ResumeOptions): ReturnType<AgentLoop['resume']> {
    const signal = this.admission.signal(options.signal)
    const depth = await this.admission.resume(owner, options, signal)
    this.admission.admit(owner)
    signal.throwIfAborted()
    return this.withReservation(depth, (observeDisposal, uncertain) => this.checkedReturn(owner, super.resume(owner, {
      ...options, signal, ...observeDisposal === undefined ? {} : { observeDisposal },
      setup: this.admission.setup(owner, options.resumeSessionId, options.setup, signal, options.parentAgent, depth, uncertain),
    }), signal, options.parentAgent, depth))
  }
}

/**
 * Register the sole graph-bound native AgentLoop without enabling account entry.
 * The caller supplies native dependencies/configuration, excludes a second loop,
 * verifies mount authority, and retains its fiber through native teardown.
 * Installation checks the installed graph identity while business may remain closed;
 * every create/resume and publication still requires assertCurrent. Shared guards must approve all
 * project/model/Preset inputs; unknown composition is never an implicit approval.
 * Child create/resume additionally requires the original Root capacity reservation
 * and native Workspace preparation. Omission keeps child entry closed. Startup
 * agents, seeded paths and direct AgentLoop.create remain closed. Native ownership,
 * repair, publication and rollback remain owned by super. Original setup commits
 * once; current checks run again after persistence and publication awaits.
 * Unknown metadata or native cleanup retains the reservation. The reservation owner
 * must close business admission synchronously and retain original teardown ownership;
 * it must not abort or dispose this in-flight callback while reporting settlement.
 * Caller cancellation remains creation-only after successful publication.
 * @param ctx - owning factory fiber in the independent installed account graph.
 * @param binding - exact runtime-owned graph binding, never an HTTP borrow.
 * @param assertCurrent - trusted current callback shared with Controller and LLM admission.
 * @param guards - the single provider's actual pre-write and prepared-Agent checks.
 * @param config - original parsed native configuration with agents=[]; no startup side effects are allowed.
 * @param reserveSubagent - original Root reservation from the same RuntimeCapacity; omission keeps children closed.
 * @returns the native AgentLoop subclass registered as the graph's sole factory.
 * @throws CloudApiError for a mismatched graph or nonempty startup recipe; native construction failures retain identity.
 */
export function createNativeAgentLoop(
  ctx: Context,
  binding: AccountBinding,
  assertCurrent: (binding: AccountBinding) => void,
  guards: NativeAgentFactoryGuards,
  config: ConstructorParameters<typeof AgentLoop>[1],
  reserveSubagent?: (depth: number) => SubagentCapacityReservation,
): AgentLoop {
  const admission = new FactoryAdmission(ctx, binding, assertCurrent, guards, reserveSubagent)
  admission.installed(ctx)
  return new AccountAgentLoop(ctx, config, admission)
}
