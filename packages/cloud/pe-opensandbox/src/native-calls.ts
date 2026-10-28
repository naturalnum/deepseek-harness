/** Per-account async propagation from the original native tool dispatch; no module-global current Session. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionToken, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ExecutionScopes, type ExecutionScope, type ScopeAuthority } from './scopes.ts'
import { assertInstalledExecutionBinding } from './account-port.ts'
import { ExecutionStateError } from './errors.ts'

interface NativeCall<Project> {
  readonly token: ToolExecutionToken
  readonly exec: ToolDispatchExecution
  readonly scope: ExecutionScope<Project>
  readonly lifetime: AbortController
  detachAgent: () => void | Promise<void>
  detachAbort: () => void
}

/** Trusted account-native inputs; ordinary command JSON supplies none of these callbacks. */
export interface NativeCallsAuthority<Project> extends ScopeAuthority<Project> {
  readonly allowedTools: readonly string[]
  readonly projectForAgent: (agent: Agent) => Project
  /** Revoke public handles and request owned cleanup; the execution owner retains actual work separately. */
  readonly released: (scope: ExecutionScope<Project>) => void
}

/** Original execution scope paired with its active invocation signal or retained service lifetime. */
export interface NativeCommandCall<Project> {
  readonly scope: ExecutionScope<Project>
  readonly signal: AbortSignal
}

/** Same issuer's original service capability; Root retains this lease on its existing work row. */
export interface RetainedNativeService<Project> {
  readonly scope: ExecutionScope<Project>
  readonly session: Agent['session']
  /** Revoke public use and request original retained cleanup; this is never a stop receipt. */
  release(): void
}

/**
 * Bind approved tool bodies to exact live Agent/Session/project capabilities. Invocation propagation
 * ends with its registry token; retained services stay with the original Agent/Session and epoch under Root work ownership.
 */
export class NativeExecutionCalls<Project> {
  private readonly calls = new Map<ToolExecutionToken, NativeCall<Project>>()
  private readonly current = new AsyncLocalStorage<NativeCall<Project>>()
  private readonly currentService = new AsyncLocalStorage<ExecutionScope<Project>>()
  private readonly scopes: ExecutionScopes<Project>
  private readonly admission = { open: true }
  private readonly allowed: ReadonlySet<string>

  /**
   * @param ctx Exact prepared account graph's execution entry effect scope.
   * @param authority Native project/Agent checks and finite scope capacity from the same Root-owned port.
   */
  constructor(private readonly ctx: Context, private readonly authority: NativeCallsAuthority<Project>) {
    assertInstalledExecutionBinding(ctx, authority.binding, ctx.root)
    this.allowed = new Set(authority.allowedTools)
    if (this.allowed.size === 0 || this.allowed.size !== authority.allowedTools.length) {
      throw new ExecutionStateError('cloud/invalid-config', 'Native execution consumers must be a nonempty unique fixed list.')
    }
    this.scopes = new ExecutionScopes(authority)
    ctx.on('tools/execute', (exec, next) => this.run(exec, next))
    ctx.on('tools/result', (exec) => { this.release(exec.token) })
    ctx.effect(() => () => { this.close() }, 'pe-opensandbox: revoke original native execution calls')
  }

  /**
   * Around-dispatch entry used only by the native tool event registration.
   * @param exec Original registry-minted pending execution, never HTTP or model-provided identity.
   * @param next Original waterfall continuation; unrelated tools delegate without an execution scope.
   * @returns The unchanged native result, with output retained until tools/result.
   */
  run(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    if (!this.allowed.has(exec.name)) return next()
    this.assertOpen()
    if (exec.agent === undefined || exec.parent !== undefined || this.calls.has(exec.token)) {
      throw new ExecutionStateError('cloud/stale-generation', 'Cloud commands require one original native foreground tool execution.')
    }
    exec.signal.throwIfAborted()
    if (this.calls.size >= this.authority.maxScopes) {
      throw new ExecutionStateError('cloud/capacity', 'Native execution call capacity is exhausted.')
    }
    const lifetime = new AbortController()
    const scope = this.scopes.issue({ agent: exec.agent, project: this.authority.projectForAgent(exec.agent),
      consumerId: exec.name, purpose: exec.name === 'dev_service' ? 'consumer' : 'command',
      capabilities: exec.name === 'dev_service' ? [] : ['argv-collect'], lifetime: lifetime.signal })
    const call: NativeCall<Project> = { token: exec.token, exec, scope, lifetime,
      detachAgent: () => {}, detachAbort: () => {} }
    this.calls.set(call.token, call)
    try {
      call.detachAgent = exec.agent.ctx.effect(() => () => { this.release(call.token) }, 'pe-opensandbox: native execution owner')
      const revoked = (): void => { this.release(call.token) }
      scope.lifetime.addEventListener('abort', revoked, { once: true })
      call.detachAbort = () => { scope.lifetime.removeEventListener('abort', revoked) }
      this.scopes.assertCurrent(scope)
      return this.current.run(call, next)
    } catch (cause) {
      this.release(call.token)
      throw cause
    }
  }

  /**
   * Capture the active native invocation for an actual account provider caller.
   * @param caller Cordis's real caller-scoped service Context.
   * @returns Original scope plus the operation signal currently fused by the native registry.
   */
  capture(caller: Context): NativeCommandCall<Project> {
    this.assertOpen()
    assertInstalledExecutionBinding(caller, this.authority.binding, this.ctx.root)
    const service = this.currentService.getStore()
    if (service !== undefined) {
      this.scopes.assertCurrent(service)
      return Object.freeze({ scope: service, signal: service.lifetime })
    }
    const call = this.current.getStore()
    if (call === undefined || this.calls.get(call.token) !== call) this.stale()
    this.scopes.assertCurrent(call.scope)
    return Object.freeze({ scope: call.scope, signal: call.exec.signal })
  }

  /**
   * Derive one service lifetime from the current original dev_service dispatch, never its result token.
   * @param caller Actual account-native consumer context.
   * @returns Original scope and revoker for the sole Root work row; caller must transfer or release it.
   */
  retainService(caller: Context): RetainedNativeService<Project> {
    const call = this.serviceCall(caller), lifetime = new AbortController()
    const scope = this.scopes.issue({ agent: call.scope.agent, project: call.scope.project,
      consumerId: 'dev_service', purpose: 'service', capabilities: ['argv-collect'], lifetime: lifetime.signal })
    const session = scope.agent.session
    let released = false, detachAgent: (() => void | Promise<void>) | undefined,
      detachAccount: (() => void | Promise<void>) | undefined
    const release = (): void => {
      if (released) return
      released = true
      scope.lifetime.removeEventListener('abort', release)
      this.scopes.release(scope)
      lifetime.abort(new ExecutionStateError('cloud/stale-generation', 'The original service owner was released.'))
      void detachAgent?.(); void detachAccount?.()
      this.authority.released(scope)
    }
    try {
      scope.lifetime.addEventListener('abort', release, { once: true })
      detachAgent = scope.agent.ctx.effect(() => release, 'pe-opensandbox: original native service Agent lifetime')
      detachAccount = this.ctx.effect(() => release, 'pe-opensandbox: original native service account lifetime')
      this.scopes.assertCurrent(scope)
      return Object.freeze({ scope, session, release })
    } catch (cause) { release(); throw cause }
  }

  /**
   * Use the same original scope for the public subprocess provider during one freshly authorized action.
   * @param caller Actual account-native consumer context.
   * @param held Root work row's original retained lease.
   * @param run Native subprocess or original work-row projection; no second process owner is created.
   * @returns The unchanged synchronous or asynchronous result.
   */
  withService<T>(caller: Context, held: RetainedNativeService<Project>, run: () => T): T {
    const call = this.serviceCall(caller), service = held.scope
    this.scopes.assertCurrent(service)
    if (service.purpose !== 'service' || service.consumerId !== 'dev_service'
      || service.binding !== call.scope.binding || service.agent !== call.scope.agent
      || service.project !== call.scope.project || service.sessionId !== call.scope.sessionId
      || held.session !== call.scope.agent.session) this.stale()
    return this.currentService.run(service, run)
  }

  private serviceCall(caller: Context): NativeCall<Project> {
    this.assertOpen()
    assertInstalledExecutionBinding(caller, this.authority.binding, this.ctx.root)
    const call = this.current.getStore()
    if (call === undefined || this.calls.get(call.token) !== call || call.exec.name !== 'dev_service'
      || call.scope.purpose !== 'consumer' || this.currentService.getStore() !== undefined) this.stale()
    this.scopes.assertCurrent(call.scope)
    return call
  }

  /**
   * Recheck an issued capability for a retained handle; no async-local lookup is needed by observers.
   * @param scope Exact issued native call scope.
   */
  assertCurrent(scope: ExecutionScope<Project>): void { this.scopes.assertCurrent(scope) }

  /**
   * Revoke after native final output projection or owner disposal; this is not a stop receipt.
   * @param token Registry's original token; duplicate or unrelated releases are harmless.
   */
  release(token: ToolExecutionToken): void {
    const call = this.calls.get(token)
    if (call === undefined) return
    this.calls.delete(token)
    call.detachAbort()
    this.scopes.release(call.scope)
    call.lifetime.abort(new ExecutionStateError('cloud/stale-generation', 'The original native execution owner was released.'))
    void call.detachAgent()
    this.authority.released(call.scope)
  }

  /** Close user admission while the separate Root process owner continues actual cleanup. */
  close(): void {
    if (!this.admission.open) return
    this.admission.open = false
    for (const token of this.calls.keys()) this.release(token)
    this.scopes.close()
    this.current.disable()
    this.currentService.disable()
  }

  /**
   * Snapshot public native invocation ownership without observing retained process cleanup.
   * @returns The number of issued native invocations, excluding actual cleanup retained by Root.
   */
  inspect(): number { return this.calls.size }

  /**
   * Observe original invocations without acquiring or revoking execution authority.
   * @param sessionId Session whose pending native dispatches are observed.
   * @returns Whether this issuer retains a call for that exact Session.
   */
  hasSessionCall(sessionId: SessionId): boolean {
    for (const call of this.calls.values()) if (call.scope.sessionId === sessionId) return true
    return false
  }

  /** Observe this original invocation issuer without acquiring business admission.
   * @returns True only while its admission is open and every issued invocation has released.
   */
  isIdle(): boolean { return this.admission.open && !this.authority.binding.lifetime.aborted && this.calls.size === 0 }

  private assertOpen(): void {
    if (!this.admission.open) this.stale()
    this.ctx.fiber.assertActive()
  }

  private stale(): never {
    throw new ExecutionStateError('cloud/stale-generation', 'Cloud execution requires the original live native invocation.')
  }
}
