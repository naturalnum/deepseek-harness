/** One cold interactive Agent owns a PG Writer without model input, while native commands and terminals retain their consumers. */
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Service, FiberState, type Fiber } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { grant as grantSchema, PlatformError, type Grant } from '../contracts.ts'
import { HostNativeWriterClient, type HostNativeWriterLease } from './native-writer-client.ts'
import type {} from './native-runtime-execution.ts'
import { flushNativeSession } from './native-session-flush.ts'

declare module '@deepseek-ai/cordis' { interface Context { nativeRuntimeSessions: NativeRuntimeSessions } }

/** Explicit maintenance bounds for cold native interactive occupancy. */
export const Config = schema.object({ renewMs: schema.number().step(1).min(1).default(8000),
  maxPendingOpens: schema.number().step(1).min(1).default(32) })
/** Validated interactive maintenance configuration. */
export type Config = ReturnType<typeof Config>
interface Owner { grant: Grant
  writer: HostNativeWriterLease
  handle: AgentHandle
  stop: AbortController
  renewal: Promise<void>
  closing?: Promise<void> }

/** Session identity is always fixed by PG ownership before the native Gateway resolves its Agent. */
export default class NativeRuntimeSessions extends Service {
  static inject = ['powerEvolveRuntime', 'agents', 'sessions', 'sessionProjections', 'agentPresets',
    'nativeRuntimeExecution', 'sandboxPolicy', 'sessionPersistence']
  static Config = Config
  private readonly ownerFiber: Fiber
  private closing = false
  private shutdownPromise: Promise<void> | undefined
  private readonly teardownFailures: unknown[] = []
  private readonly owners = new Map<SessionId, Owner>()
  private readonly requests = new Map<SessionId,
    { sessionId: SessionId; browserToken: string; requestId: string; candidateToken: string }>()
  private readonly openings = new Map<SessionId, Promise<Agent>>()
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'nativeRuntimeSessions')
    this.ownerFiber = ctx.fiber
    ctx.effect(() => () => this.shutdown())
  }

  /** Join this service's original occupancy and cleanup failures; Cordis itself logs disposer errors instead of rejecting.
   * @returns The same shutdown result on repeats; new opens refuse before any asynchronous join.
   */
  shutdown(): Promise<void> {
    this.closing = true
    return this.shutdownPromise ??= (async () => {
      await Promise.allSettled(this.openings.values())
      const results = await Promise.allSettled([...this.owners.keys()].map(id => this.close(id)))
      const failures = [...this.teardownFailures,
        ...results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])]
      if (failures.length) throw new AggregateError(failures, 'Native interactive shutdown failed')
    })()
  }

  /** Whether this exact service still admits new interactive ownership. */
  get available(): boolean { return !this.isClosing() }

  private isClosing(): boolean {
    return this.closing || this.ownerFiber.state === FiberState.UNLOADING || this.ownerFiber.state === FiberState.DISPOSED
  }

  /** Reuse a live native Agent or acquire one bounded interactive Writer for this Browser-authorized Session.
   * @param id Exact ordinary Session identity from the authenticated original Remote arguments.
   * @param browserToken Original Browser Agent bearer, separately fixed to this Runtime account.
   * @returns The native Agent after actual preset mounting; its before-turn hook forbids model work.
   */
  async ensure(id: SessionId, browserToken: string): Promise<Agent> {
    if (this.isClosing()) throw new PlatformError(409, 'native_interactive_closing')
    const current = this.ctx.agents.get(id)
    if (current) {
      this.ctx.powerEvolveRuntime.assertGrant(this.ctx.powerEvolveRuntime.require(id))
      await this.ctx.nativeRuntimeExecution.bind(current, this.ctx.powerEvolveRuntime.require(id))
      return current
    }
    let opening = this.openings.get(id)
    if (!opening) {
      if (this.openings.size >= this.config.maxPendingOpens
        || !this.requests.has(id) && this.requests.size >= this.config.maxPendingOpens) {
        throw new PlatformError(429, 'native_interactive_open_limit')
      }
      opening = this.open(id, browserToken).finally(() => { this.openings.delete(id) })
      this.openings.set(id, opening)
    }
    return opening
  }

  private async open(id: SessionId, browserToken: string): Promise<Agent> {
    const runtime = this.ctx.powerEvolveRuntime, writers = new HostNativeWriterClient(runtime)
    let original = this.requests.get(id)
    if (!original) {
      original = { sessionId: id, browserToken, requestId: randomUUID(), candidateToken: randomBytes(32).toString('base64url') }
      this.requests.set(id, original)
    }
    if (original.browserToken !== browserToken) throw new PlatformError(409, 'native_interactive_open_uncertain')
    const captured = grantSchema.parse(await runtime.callOwned('/runtime/user/interactive/open', original))
    if (captured.sessionId !== id || captured.userId !== runtime.config.runtimeUserId || captured.source !== 'native_interactive') {
      throw new PlatformError(502, 'native_interactive_identity')
    }
    this.requests.delete(id)
    runtime.grants.set(id, captured)
    let writer: HostNativeWriterLease | undefined
    let handle: AgentHandle | undefined
    let preparing: Agent | undefined
    try {
      writer = await writers.acquire(captured, randomBytes(32).toString('base64url'))
      handle = await this.ctx.agents.resume({ resumeSessionId: id, disposeOptions: { keepInbox: true },
        agentOptions: { provider: 'power-evolve', model: captured.settings.model, maxTokens: captured.settings.maxTokens },
        setup: async (agentCtx, agent) => {
          preparing = agent
          agentCtx.effect(() => agent.onBeforeTurn(() => { throw new PlatformError(403, 'native_interactive_model_forbidden') }))
          const initial: SessionEvent[] = []
          if (this.ctx.sandboxPolicy.overrideOf(agent.session) === undefined) {
            initial.push(agent.session.append('sandbox/mode', { mode: this.ctx.sandboxPolicy.defaultMode }))
          }
          await flushNativeSession(this.ctx, agent.session, initial)
          await this.ctx.nativeRuntimeExecution.bind(agent, captured)
          const selected = this.ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
          const preset = await this.ctx.agents.withInitiator(agent, () => this.ctx.agentPresets.mount(agentCtx, selected ?? undefined))
          const selection = selected === null ? [agent.session.append('agent-preset/selected', { agentPreset: preset.id })] : []
          await flushNativeSession(this.ctx, agent.session, selection)
          return { commit: () => { if (this.isClosing()) throw new PlatformError(409,
            'native_interactive_closing'); runtime.assertGrant(captured); runtime.publication(captured).assertOpen() } }
        } })
      if (this.isClosing()) throw new PlatformError(409, 'native_interactive_closing')
      const stop = new AbortController(), owner: Owner = { grant: captured, writer, handle, stop, renewal: Promise.resolve() }
      const stopped = () => stop.signal.aborted
      this.owners.set(id, owner)
      owner.renewal = (async () => {
        while (!stopped()) {
          try { await delay(this.config.renewMs, undefined, { signal: stop.signal }) }
          catch (error) { if (stopped()) return; throw error }
          const status = z.object({ pending: z.boolean(), cancelRequested: z.boolean() }).parse(
            await runtime.call('/runtime/interactive/status', captured.token, {}, stop.signal))
          if (status.pending || status.cancelRequested) { void this.close(id).catch((error: unknown) => {  this.ctx.logger.error('Native interactive cleanup failed', error) }); return }
          runtime.heartbeatPublication(captured)
          await writers.renew(owner.writer.identity, stop.signal)
        }
      })().catch((error: unknown) => {
        if (!stopped()) { stop.abort(error); void this.close(id).catch((failure: unknown) => {  this.ctx.logger.error('Native interactive cleanup failed', failure) }) }
      })
      return handle.agent
    } catch (error) {
      const failures: unknown[] = []
      try { await handle?.dispose({ keepInbox: true }) } catch (failure) { failures.push(failure) }
      if (preparing) {
        try { await this.ctx.nativeRuntimeExecution.drain(preparing) } catch (failure) { failures.push(failure) }
      }
      if (writer) {
        try { await runtime.call('/runtime/cleanup', captured.token, { operationId: captured.operationId, epoch: captured.epoch,
          writer: writer.identity, errorCode: 'native_interactive_setup_failed' }) }
        catch (failure) { failures.push(failure) }
      }
      if (runtime.grants.get(id) === captured) runtime.grants.delete(id)
      if (failures.length) {
        const failed = new AggregateError([error, ...failures], 'Native interactive setup cleanup failed')
        this.teardownFailures.push(failed)
        this.closing = true
        throw failed
      }
      throw error
    }
  }

  /** Drain the native Agent and exact execution clients before releasing its original interactive occupancy.
   * @param id Exact local interactive owner; ordinary Scheduler Agents are unaffected.
   * @returns Original local cleanup result; revocation uses only the narrow original cleanup proof.
   */
  close(id: SessionId): Promise<void> {
    const owner = this.owners.get(id)
    if (!owner) return Promise.resolve()
    return owner.closing ??= (async () => {
      const runtime = this.ctx.powerEvolveRuntime, failures: unknown[] = []
      owner.stop.abort()
      await owner.renewal
      try { await owner.handle.dispose({ keepInbox: true }) } catch (error) { failures.push(error) }
      try { await this.ctx.nativeRuntimeExecution.drain(owner.handle.agent) } catch (error) { failures.push(error) }
      try {
        if (failures.length) throw new PlatformError(409, 'native_interactive_close_failed')
        await new HostNativeWriterClient(runtime).release(owner.writer.identity)
        await runtime.call('/runtime/finish', owner.grant.token, { outcome: 'completed', errorCode: null })
      } catch (error) {
        try { await runtime.call('/runtime/cleanup', owner.grant.token, { operationId: owner.grant.operationId,
          epoch: owner.grant.epoch, writer: owner.writer.identity,
          errorCode: failures.length ? 'native_interactive_close_failed' : 'native_interactive_closed' }) }
        catch (cleanupError) { failures.push(error, cleanupError) }
      } finally {
        if (runtime.grants.get(id) === owner.grant) runtime.grants.delete(id)
        if (this.owners.get(id) === owner) this.owners.delete(id)
      }
      if (failures.length) {
        const failed = new AggregateError(failures, 'Native interactive owner cleanup failed')
        this.teardownFailures.push(failed)
        this.closing = true
        throw failed
      }
    })()
  }
}
