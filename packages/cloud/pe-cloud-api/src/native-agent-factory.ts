/** Private graph-bound admission around the public native AgentLoop factory transaction. */
import type { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { CloudApiError } from './errors.ts'

type CreateOptions = Parameters<AgentLoop['createAgent']>[1]
type ResumeOptions = Parameters<AgentLoop['resume']>[1]
type PreparedAgent = Awaited<ReturnType<AgentLoop['createAgent']>>['agent']
type Setup = NonNullable<CreateOptions['setup']>

/** Shared provider checks; these callbacks issue neither identities nor cached approval. */
export interface NativeAgentFactoryGuards {
  /**
   * Verify the supplied ordinary-root project, model and Preset before persistence creation.
   * @param options - original native create inputs, including the trusted composition callback.
   * @param signal - caller/graph cancellation; retain actual work until it settles.
   * @returns after all shared validation has actually settled; rejection prevents native delegation.
   */
  assertCreate(options: CreateOptions, signal: AbortSignal): Promise<void>
  /**
   * Read the account's native history and verify ordinary-root metadata, project,
   * model and Preset before native write ownership or crash repair. A path or id
   * alone cannot establish that approval.
   * @param options - original native resume inputs and trusted setup callback.
   * @param signal - caller/graph cancellation; retain actual read work until settlement.
   * @returns after shared validation settles; rejection prevents native write-open.
   */
  assertResume(options: ResumeOptions, signal: AbortSignal): Promise<void>
  /**
   * Verify the prepared native Agent's actual project, model and composed Preset
   * synchronously after setup and around the original publication commit.
   * @param agent - actual unpublished Agent in this exact installed graph.
   * @throws when existing approved evidence is missing, unknown or no longer current.
   */
  assertPrepared(agent: PreparedAgent): void
}

class FactoryAdmission {
  constructor(
    private readonly ctx: Context,
    private readonly binding: AccountBinding,
    private readonly assertCurrent: (binding: AccountBinding) => void,
    private readonly guards: NativeAgentFactoryGuards,
  ) {}

  admit(owner: Context): void {
    this.ctx.fiber.assertActive()
    owner.fiber.assertActive()
    if (this.binding.lifetime.aborted || this.ctx.get('peAccount') !== this.binding
      || this.ctx.root.get('peAccount') !== this.binding || owner.get('peAccount') !== this.binding
      || owner.root.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The native Agent factory and owner have different graph bindings.')
    }
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

  async create(owner: Context, options: CreateOptions, signal: AbortSignal): Promise<void> {
    this.admit(owner)
    signal.throwIfAborted()
    if (options.parentAgent !== undefined || options.seed !== undefined || (options.inheritedEventCount ?? 0) !== 0) {
      throw new CloudApiError('cloud/forbidden', 'Parent and seeded Agent creation is not admitted by this factory.')
    }
    this.root(options.meta ?? {})
    await this.guards.assertCreate(options, signal)
  }

  async resume(owner: Context, options: ResumeOptions, signal: AbortSignal): Promise<void> {
    this.admit(owner)
    signal.throwIfAborted()
    if (options.parentAgent !== undefined) {
      throw new CloudApiError('cloud/forbidden', 'Parent-owned Agent resume is not admitted by this factory.')
    }
    await this.guards.assertResume(options, signal)
  }

  setup(owner: Context, id: PreparedAgent['id'], original: CreateOptions['setup'], signal: AbortSignal): Setup {
    return async (scope, agent) => {
      this.prepared(owner, id, agent, signal)
      const originalCommit = await original?.(scope, agent)
      this.prepared(owner, id, agent, signal)
      this.guards.assertPrepared(agent)
      return { commit: () => {
        this.prepared(owner, id, agent, signal)
        this.guards.assertPrepared(agent)
        originalCommit?.commit()
        this.prepared(owner, id, agent, signal)
        this.guards.assertPrepared(agent)
        this.admit(owner)
        signal.throwIfAborted()
      } }
    }
  }

  private prepared(owner: Context, id: PreparedAgent['id'], agent: PreparedAgent, signal: AbortSignal): void {
    this.admit(owner)
    signal.throwIfAborted()
    agent.ctx.fiber.assertActive()
    if (agent.id !== id || agent.session.header.id !== id || agent.ctx.get('peAccount') !== this.binding
      || agent.ctx.root.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The prepared Agent does not belong to this native factory graph.')
    }
    this.root(agent.session.header)
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

  override async createAgent(owner: Context, options: CreateOptions): ReturnType<AgentLoop['createAgent']> {
    const signal = this.admission.signal(options.signal)
    await this.admission.create(owner, options, signal)
    this.admission.admit(owner)
    signal.throwIfAborted()
    return super.createAgent(owner, {
      ...options, signal, setup: this.admission.setup(owner, options.sessionId, options.setup, signal),
    })
  }

  override async resume(owner: Context, options: ResumeOptions): ReturnType<AgentLoop['resume']> {
    const signal = this.admission.signal(options.signal)
    await this.admission.resume(owner, options, signal)
    this.admission.admit(owner)
    signal.throwIfAborted()
    return super.resume(owner, {
      ...options, signal, setup: this.admission.setup(owner, options.resumeSessionId, options.setup, signal),
    })
  }
}

/**
 * Register the sole graph-bound native AgentLoop without enabling account entry.
 * The caller supplies native dependencies/configuration, excludes a second loop,
 * and retains its fiber through native teardown. Shared guards must approve all
 * project/model/Preset inputs; unknown composition is never an implicit approval.
 * Only ordinary root create/resume is admitted. Startup agents, parent/seeded
 * paths and direct AgentLoop.create stay closed. Original setup/commit, native
 * write ownership, repair, publication and rollback remain owned by super.
 * Native persistence append can await after setup commit; fused cancellation
 * still prevents later publication. Closing current admission without aborting
 * the graph does not drain already admitted work; runtime retains that work.
 * Caller cancellation remains creation-only after successful publication.
 * @param ctx - owning factory fiber in the independent installed account graph.
 * @param binding - exact runtime-owned graph binding, never an HTTP borrow.
 * @param assertCurrent - trusted current callback shared with Controller and LLM admission.
 * @param guards - the single provider's actual pre-write and prepared-Agent checks.
 * @param config - original parsed native configuration with agents=[]; no startup side effects are allowed.
 * @returns the native AgentLoop subclass registered as the graph's sole factory.
 * @throws CloudApiError for a mismatched graph or nonempty startup recipe; native construction failures retain identity.
 */
export function createNativeAgentLoop(
  ctx: Context,
  binding: AccountBinding,
  assertCurrent: (binding: AccountBinding) => void,
  guards: NativeAgentFactoryGuards,
  config: ConstructorParameters<typeof AgentLoop>[1],
): AgentLoop {
  const admission = new FactoryAdmission(ctx, binding, assertCurrent, guards)
  admission.admit(ctx)
  return new AccountAgentLoop(ctx, config, admission)
}
