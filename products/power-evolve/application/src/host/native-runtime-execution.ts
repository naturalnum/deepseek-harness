/** Native consumers retain their maintained implementation above a captured per-Agent cloud execution world. */
import { Context, Service, FiberState, type Fiber } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { installNativeExecutionProviders, nativeExecutionWorld } from '../native-execution/providers.ts'
import { createNativeExecutionHttpBinding } from '../native-execution/http-client.ts'
import { PlatformError, type Grant } from '../contracts.ts'
import { flushNativeSession } from './native-session-flush.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { nativeRuntimeExecution: NativeRuntimeExecution }
}

/** Polling and collected output limits for native cloud execution consumers. */
export const Config = schema.object({ pollMs: schema.number().step(1).min(1).default(250),
  maxOutputBytes: schema.number().step(1).min(1).default(65_536) })
/** Validated cloud execution consumer bounds. */
export type Config = ReturnType<typeof Config>

/** One private process mounts global providers whose resolver requires the exact initiating native Agent. */
export default class NativeRuntimeExecution extends Service {
  static inject = ['powerEvolveRuntime', 'agents', 'sessions', 'sessionPersistence', 'sandboxPolicy']
  static Config = Config
  private shutdownPromise: Promise<void> | undefined
  private closing = false
  private readonly ownerFiber: Fiber
  private readonly bindings = new Map<Agent, { grant: Grant
    binding: ReturnType<typeof createNativeExecutionHttpBinding>
    owner: Context }>()

  constructor(private readonly ownerContext: Context, private readonly config: Config) {
    super(ownerContext, 'nativeRuntimeExecution')
    this.ownerFiber = ownerContext.fiber
    ownerContext.effect(() => () => this.shutdown())
    if (ownerContext.powerEvolveRuntime.config.runtimeUserId === '') throw new Error('Native runtime execution requires a fixed account')
    installNativeExecutionProviders(ownerContext, { defaultMode: ownerContext.sandboxPolicy.defaultMode,
      resolve: () => {
        const agent = ownerContext.agents.requireInitiator()
        const current = this.bindings.get(agent)
        if (!current || current.owner.fiber.state === FiberState.UNLOADING || current.owner.fiber.state === FiberState.DISPOSED) throw new PlatformError(403, 'native_execution_scope_missing')
        ownerContext.powerEvolveRuntime.assertGrant(current.grant)
        return current.binding
      } })
    ownerContext.on('tools/pre-execute', async (execution, next) => {
      if (execution.agent === undefined) throw new PlatformError(403, 'native_execution_scope_missing')
      await this.bind(execution.agent, ownerContext.powerEvolveRuntime.require(execution.agent.id))
      return next()
    })
  }

  /** Explicitly join every original binding and retain cleanup rejection outside Cordis's logging-only teardown.
   * @returns One cached result; failures preserve their exact binding identities for diagnosis and repeated drain.
   */
  shutdown(): Promise<void> {
    this.closing = true
    return this.shutdownPromise ??= (async () => {
      const closed = await Promise.allSettled([...this.bindings.keys()].map(agent => this.drain(agent)))
      const failures = closed.flatMap(item => item.status === 'rejected' ? [item.reason as unknown] : [])
      if (failures.length) throw new AggregateError(failures, 'Native execution shutdown failed')
    })()
  }

  private isClosing(): boolean {
    return this.closing || this.ownerFiber.state === FiberState.UNLOADING || this.ownerFiber.state === FiberState.DISPOSED
  }

  /** Resolve the current storage and permission generation before a native consumer starts work.
   * @param agent Exact unpublished setup Agent or current live initiator.
   * @param grant Original operation whose account and Session must match.
   * @returns Completion after the same generation is captured; replacement disposes the former process clients.
   */
  async bind(agent: Agent, grant: Grant): Promise<void> {
    const runtime = this.ownerContext.powerEvolveRuntime
    if (this.isClosing()) throw new PlatformError(409, 'native_execution_closing')
    runtime.assertGrant(grant)
    if (agent.id !== grant.sessionId) throw new PlatformError(403, 'native_execution_scope_missing')
    const world = nativeExecutionWorld.parse(await runtime.call('/runtime/native-world/open', grant.token, { agentId: agent.id }))
    runtime.assertGrant(grant)
    if (world.userId !== grant.userId || world.sessionId !== agent.id || world.agentId !== agent.id
      || world.operationId !== grant.operationId || world.operationEpoch !== grant.epoch) throw new PlatformError(502, 'native_execution_world_identity')
    const modes = ['read-only', 'workspace-write', 'danger-full-access'] as const
    const localMode = this.ownerContext.sandboxPolicy.resolve({ session: agent.session }).mode
    if (agent.session.header.origin === 'subagent' && modes.indexOf(localMode) > modes.indexOf(world.mode)) {
      const narrowed = agent.session.append('sandbox/mode', { mode: world.mode, source: 'delegation' })
      await flushNativeSession(this.ownerContext, agent.session, [narrowed])
      runtime.assertGrant(grant)
      return this.bind(agent, grant)
    }
    const existing = this.bindings.get(agent)
    if (existing?.grant === grant && JSON.stringify(existing.binding.world) === JSON.stringify(world)) return
    if (existing) { await existing.binding.close(); await existing.owner.fiber.dispose() }
    runtime.assertGrant(grant)
    if (this.isClosing()) throw new PlatformError(409, 'native_execution_closing')
    const owner = new Context()
    try {
      const binding = createNativeExecutionHttpBinding(owner, world, grant.token,
        (path, token, input, signal) => runtime.call(path, token, input, signal), this.config)
      const current = { grant, binding, owner }
      agent.ctx.effect(() => async () => {
        await binding.close()
        await owner.fiber.dispose()
        if (this.bindings.get(agent) === current) this.bindings.delete(agent)
      }, 'native runtime execution binding')
      this.bindings.set(agent, current)
    } catch (error) {
      try { await owner.fiber.dispose() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native execution binding cleanup failed') }
      throw error
    }
  }

  /** Join only this Agent's captured execution clients, including after its business authority is revoked.
   * @param agent Exact local Agent whose immutable world and process identities remain retained.
   * @returns Completion after the provider's original cleanup; failures remain owned and propagate to Runtime shutdown.
   */
  async drain(agent: Agent): Promise<void> {
    const current = this.bindings.get(agent)
    if (!current) return
    await current.binding.close()
    await current.owner.fiber.dispose()
    if (this.bindings.get(agent) === current) this.bindings.delete(agent)
  }
}
