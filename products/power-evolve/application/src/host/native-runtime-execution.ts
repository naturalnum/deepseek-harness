/** Native consumers retain their maintained implementation above a captured per-Agent cloud execution world. */
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { installNativeExecutionProviders, nativeExecutionWorld, type NativeExecutionBinding } from '../native-execution/providers.ts'
import { createNativeExecutionHttpBinding } from '../native-execution/http-client.ts'
import { PlatformError, type Grant } from '../contracts.ts'

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
  static inject = ['powerEvolveRuntime', 'agents', 'sandboxPolicy']
  static Config = Config
  private readonly bindings = new WeakMap<Agent, { grant: Grant; binding: NativeExecutionBinding; owner: Context }>()

  constructor(private readonly ownerContext: Context, private readonly config: Config) {
    super(ownerContext, 'nativeRuntimeExecution')
    if (ownerContext.powerEvolveRuntime.config.runtimeUserId === '') throw new Error('Native runtime execution requires a fixed account')
    installNativeExecutionProviders(ownerContext, { defaultMode: ownerContext.sandboxPolicy.defaultMode,
      resolve: () => {
        const agent = ownerContext.agents.requireInitiator()
        const current = this.bindings.get(agent)
        if (!current) throw new PlatformError(403, 'native_execution_scope_missing')
        ownerContext.powerEvolveRuntime.assertGrant(current.grant)
        return current.binding
      } })
    ownerContext.on('tools/pre-execute', async (execution, next) => {
      if (execution.agent === undefined) throw new PlatformError(403, 'native_execution_scope_missing')
      await this.bind(execution.agent, ownerContext.powerEvolveRuntime.require(execution.agent.id))
      return next()
    })
  }

  /** Resolve the current storage and permission generation before a native consumer starts work.
   * @param agent Exact unpublished setup Agent or current live initiator.
   * @param grant Original operation whose account and Session must match.
   * @returns Completion after the same generation is captured; replacement disposes the former process clients.
   */
  async bind(agent: Agent, grant: Grant): Promise<void> {
    const runtime = this.ownerContext.powerEvolveRuntime
    runtime.assertGrant(grant)
    if (agent.id !== grant.sessionId) throw new PlatformError(403, 'native_execution_scope_missing')
    const world = nativeExecutionWorld.parse(await runtime.call('/runtime/native-world/open', grant.token, { agentId: agent.id }))
    runtime.assertGrant(grant)
    if (world.userId !== grant.userId || world.sessionId !== agent.id || world.agentId !== agent.id
      || world.operationId !== grant.operationId || world.operationEpoch !== grant.epoch) throw new PlatformError(502, 'native_execution_world_identity')
    const existing = this.bindings.get(agent)
    if (existing?.grant === grant && JSON.stringify(existing.binding.world) === JSON.stringify(world)) return
    const owner = new Context()
    const binding = createNativeExecutionHttpBinding(owner, world, grant.token,
      (path, token, input, signal) => runtime.call(path, token, input, signal), this.config)
    const current = { grant, binding, owner }
    this.bindings.set(agent, current)
    agent.ctx.effect(() => async () => {
      if (this.bindings.get(agent) === current) this.bindings.delete(agent)
      await owner.fiber.dispose()
    }, 'native runtime execution binding')
    if (existing) await existing.owner.fiber.dispose()
  }
}
