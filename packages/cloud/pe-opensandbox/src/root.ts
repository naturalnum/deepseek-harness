/** Root Loader entry for explicitly closed execution; unverified execution still fails startup. */
import type { Context } from '@deepseek-ai/cordis'
import { requireExecution } from './capabilities.ts'
import type { AccountBinding, AccountRuntimeService, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { rootExecutionSchema } from './config.ts'
import type { ExecutionRequirements } from './types.ts'
import { SandboxCoordinator } from './coordinator.ts'
import { ClosedExecutionOwner } from './closed-owner.ts'
import type { AccountExecutionPort } from './account-port.ts'
import { ExecutionStateError } from './errors.ts'

/** Loader identity for the root coordinator composition. */
export const name = 'pe-opensandbox/root'
/** Missing wiring is an explicit startup error rather than a pending injection warning. */
export const inject: string[] = []
/** Fixed recipe requirements; no option turns unverified execution into ready. */
export interface Config extends ExecutionRequirements {
  /** Required finite registration capacity when mode is closed. */
  readonly maxBoundAccounts?: number
}
/** Required mode declaration; accepting it supplies no verification evidence. */
export const Config = rootExecutionSchema

class ClosedCoordinator extends SandboxCoordinator {
  static inject = ['peAccountRuntime']
  private readonly work: ClosedExecutionOwner

  constructor(ctx: Context, config: Config) {
    const runtime: AccountRuntimeService | undefined = ctx.get('peAccountRuntime')
    if (runtime === undefined) throw new ExecutionStateError('cloud/invalid-config', 'Closed execution requires the root account runtime.')
    if (config.maxBoundAccounts === undefined) {
      throw new ExecutionStateError('cloud/invalid-config', 'Closed execution requires an explicit maxBoundAccounts.')
    }
    const work = new ClosedExecutionOwner(ctx.root, config.maxBoundAccounts)
    super(ctx)
    this.work = work
    try { runtime.registerDrainParticipant(this) }
    catch (error) { work.close(); throw error }
    ctx.effect(() => () => { work.close() }, 'pe-opensandbox: close execution before participant withdrawal')
  }

  override assertReady(): void { this.work.assertOpen() }
  override bindAccount(ctx: Context, binding: AccountBinding, assertCurrent: () => void): AccountExecutionPort {
    return this.work.bind(ctx, binding, assertCurrent)
  }
  override stopEpoch(binding: AccountBinding, deadlineAtMs: number): Promise<ParticipantReceipt> {
    return this.work.stopEpoch(binding, deadlineAtMs)
  }
}

/**
 * Register the actual closed execution owner; missing or required execution remains a startup failure.
 * @param ctx - root plugin context carrying the real runtime registration service.
 * @param config - explicit execution requirements.
 * @throws for non-closed modes, required capabilities, missing runtime or duplicate registration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.mode !== 'closed') return requireExecution(config)
  const resolved = Config({ mode: 'closed', requiredCapabilities: [...config.requiredCapabilities],
    ...(config.maxBoundAccounts === undefined ? {} : { maxBoundAccounts: config.maxBoundAccounts }) })
  if (resolved.requiredCapabilities.length !== 0) return requireExecution(resolved)
  if (ctx.get('peAccount') !== undefined || ctx.root.get('peAccount') !== undefined) {
    throw new ExecutionStateError('cloud/invalid-config', 'The execution root cannot be mounted in an account graph.')
  }
  if (ctx.get('peAccountRuntime') === undefined) {
    throw new ExecutionStateError('cloud/invalid-config', 'Closed execution requires the root account runtime.')
  }
  await ctx.plugin(ClosedCoordinator, resolved)
}
