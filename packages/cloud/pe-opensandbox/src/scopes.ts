/** Internal scope issuance; binding and project authority remain with their owning adapters. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExecutionCapability } from './types.ts'

/** In-process execution ownership; ordinary processes do not become registered services. */
export type ExecutionPurpose = 'command' | 'consumer' | 'service'

/** An issuer-owned capability. Binding and project values retain their owners' actual types. */
export interface ExecutionScope<Project> {
  readonly binding: AccountBinding
  readonly agent: Agent
  readonly sessionId: SessionId
  readonly project: Project
  readonly consumerId: string
  readonly purpose: ExecutionPurpose
  readonly capabilities: readonly ExecutionCapability[]
  readonly lifetime: AbortSignal
}

/** Trusted adapter inputs, never parsed from HTTP, environment variables or command JSON. */
export interface ScopeAuthority<Project> {
  readonly binding: AccountBinding
  readonly maxScopes: number
  /** Exact account-native Agent lookup, not lookup by cwd or environment. */
  readonly getAgent: (id: SessionId) => Agent | undefined
  /** Validate the current account/epoch, project membership, consumer, purpose and modes. */
  readonly assertCurrent: (scope: ExecutionScope<Project>) => void
}

/** Scope refusal has no allocation, process, or stopping side effects. */
export class ExecutionScopeError extends Error {
  /**
   * @param code - existing cloud refusal classification.
   * @param message - secret-free diagnostic for the owning adapter.
   */
  constructor(readonly code: 'cloud/stale-generation' | 'cloud/capacity' | 'cloud/forbidden', message: string) {
    super(message)
    this.name = 'ExecutionScopeError'
  }
}

/**
 * Issues bounded, revocable capabilities without inspecting storage or allocating compute.
 * The account adapter must provide its real binding/project types and authorization check.
 * Closing this issuer revokes capabilities; it never constitutes a drain or stop receipt.
 */
export class ExecutionScopes<Project> {
  private accepting = true
  private readonly scopes = new Map<ExecutionScope<Project>, () => void>()

  /**
   * @param authority - fixed account-generation authority and finite scope capacity.
   * @throws when the configured capacity is not a positive safe integer.
   */
  constructor(private readonly authority: ScopeAuthority<Project>) {
    if (!Number.isSafeInteger(authority.maxScopes) || authority.maxScopes < 1) {
      throw new RangeError('execution maxScopes must be a positive safe integer')
    }
  }

  /**
   * Capture an exact Agent and an already resolved project from a trusted adapter.
   * @param input - native identity and purpose, with lifetime owned by the consumer.
   * @returns an issuer-owned capability; creating it performs no execution or lookup I/O.
   * @throws on stale authority, denied scope, pre-aborted ownership or exhausted capacity.
   */
  issue(input: Omit<ExecutionScope<Project>, 'binding' | 'sessionId'>): ExecutionScope<Project> {
    this.assertAccepting()
    input.lifetime.throwIfAborted()
    const scope = Object.freeze({
      binding: this.authority.binding,
      agent: input.agent,
      sessionId: input.agent.session.id,
      project: input.project,
      consumerId: input.consumerId,
      purpose: input.purpose,
      capabilities: Object.freeze([...input.capabilities]),
      lifetime: AbortSignal.any([this.authority.binding.lifetime, input.lifetime]),
    })
    this.assertNative(scope)
    this.authority.assertCurrent(scope)
    this.assertAccepting()
    scope.lifetime.throwIfAborted()
    if (this.scopes.size >= this.authority.maxScopes) {
      throw new ExecutionScopeError('cloud/capacity', 'execution scope capacity is exhausted')
    }
    const revoke = (): void => { this.release(scope) }
    scope.lifetime.addEventListener('abort', revoke, { once: true })
    this.scopes.set(scope, () => { scope.lifetime.removeEventListener('abort', revoke) })
    return scope
  }

  /**
   * Revalidate a capability before each allocation, start or user I/O operation.
   * @param scope - the exact object issued by this instance.
   * @throws when copied, foreign, revoked, stale or no longer authorized.
   */
  assertCurrent(scope: ExecutionScope<Project>): void {
    this.assertAccepting()
    if (!this.scopes.has(scope)) {
      throw new ExecutionScopeError('cloud/stale-generation', 'execution scope is not owned by this issuer')
    }
    scope.lifetime.throwIfAborted()
    this.assertNative(scope)
    this.authority.assertCurrent(scope)
  }

  /**
   * Revoke one capability without claiming any underlying process has stopped.
   * @param scope - issued capability; repeated or foreign release is a no-op.
   */
  release(scope: ExecutionScope<Project>): void {
    const detach = this.scopes.get(scope)
    this.scopes.delete(scope)
    detach?.()
  }

  /** Close user admission and revoke scopes; internal stop/observation ownership is separate. */
  close(): void {
    this.accepting = false
    for (const scope of this.scopes.keys()) this.release(scope)
  }

  private assertAccepting(): void {
    if (!this.accepting || this.authority.binding.lifetime.aborted) {
      throw new ExecutionScopeError('cloud/stale-generation', 'execution scope admission is closed')
    }
  }

  private assertNative(scope: ExecutionScope<Project>): void {
    if (this.authority.getAgent(scope.sessionId) !== scope.agent
      || scope.agent.id !== scope.sessionId) {
      throw new ExecutionScopeError('cloud/forbidden', 'execution requires the exact live account-native Agent')
    }
  }
}
