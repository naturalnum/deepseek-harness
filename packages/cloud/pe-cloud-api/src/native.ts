/** Private account-graph admission and native Session Controller assembly. */
import type { Context } from '@deepseek-ai/cordis'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type {
  SessionCreateRequest, SessionCreateValue, SessionPromptRequest, SessionPromptValue,
  SessionCancelRequest, SessionCancelValue, SessionForkRequest, SessionForkValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { CloudApiError } from './errors.ts'
import type { ExposurePolicy } from './exposure.ts'

/**
 * Shared guards supplied by trusted account assembly, using the files-owned
 * project resolver and approved native Preset/model configuration. These
 * callbacks neither issue account identity nor establish a second Session store.
 */
export interface NativeSessionGuards {
  /** Require a handler in this account's actual enabled native composition. */
  assertHandlerEnabled(handlerId: string): void
  /** Resolve and verify the project's location and approved Preset without creating a Session. */
  resolveCreate(request: SessionCreateRequest): Promise<SessionCreateRequest>
  /** Check the native Session's project before prompt/resume or fork. */
  assertSessionProject(sessionId: SessionId): Promise<void>
  /**
   * Check the attached Agent's existing approved project/directory evidence
   * synchronously. Reuse the shared provider; do not read, resume or cache approval.
   * @param agent - actual attached native Agent, after graph-binding validation.
   */
  assertActiveScope(agent: NonNullable<ReturnType<Context['agents']['get']>>): void
}

class NativeSessionAdmission {
  constructor(
    private readonly ctx: Context,
    private readonly binding: AccountBinding,
    private readonly assertCurrent: (binding: AccountBinding) => void,
    private readonly policy: ExposurePolicy,
    private readonly guards: NativeSessionGuards,
  ) {}

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

  async session(endpoint: 'session/prompt' | 'session/fork', sessionId: SessionId): Promise<void> {
    this.admit(endpoint, 'account-session')
    await this.guards.assertSessionProject(sessionId)
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

  admit(endpoint: string, guard: 'account-project' | 'account-session'): void {
    this.assertBinding()
    this.ctx.fiber.assertActive()
    this.assertCurrent(this.binding)
    const declared = this.policy.requireRpc(endpoint)
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
}

/**
 * Construct the sole native Session Controller in its owning account fiber.
 * The caller declares the native Controller's dependencies and excludes a second
 * base Controller from the recipe. Native Remote markers, Config and business
 * implementation remain inherited. Installation validates the binding; runtime
 * readiness is checked on each call, after shared asynchronous validation too.
 * @param ctx - owning fiber in the independent, runtime-bound account graph.
 * @param binding - installed graph lifetime, never a request borrow or signal.
 * @param assertCurrent - trusted graph admission shared with the actual LLM guard;
 * never AccountUse.assertCurrent bound to an HTTP/Peer borrow.
 * @param policy - deployment policy audited against this graph's native inventory.
 * @param guards - shared project/Preset/active-Agent checks; not fixture policy.
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
