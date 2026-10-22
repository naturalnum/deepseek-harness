/** Root Loader entry; managed execution additionally requires the original protected deployment capability. */
import type { Context } from '@deepseek-ai/cordis'
import { requireExecution } from './capabilities.ts'
import type { AccountBinding, AccountRuntimeService, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { rootExecutionSchema } from './config.ts'
import type { ExecutionRequirements } from './types.ts'
import { SandboxCoordinator } from './coordinator.ts'
import { ClosedExecutionOwner } from './closed-owner.ts'
import type { AccountExecutionPort } from './account-port.ts'
import { ExecutionStateError } from './errors.ts'
import { ManagedCoordinator, type ManagedExecutionDeployment } from './managed-coordinator.ts'
import { parseManagedCoordinatorConfig } from './managed-config.ts'
import type { RootDeploymentReference } from './bootstrap/deployment-reference.ts'
import type { RootExecutionAssembly } from './bootstrap/assembly.ts'

/** Loader identity for the root coordinator composition. */
export const name = 'pe-opensandbox/root'
/** Missing wiring is an explicit startup error rather than a pending injection warning. */
export const inject: string[] = []
/** Fixed recipe requirements; serialized input cannot provide the protected deployment capability. */
export interface Config extends ExecutionRequirements {
  /** Required finite registration capacity when mode is closed. */
  readonly maxBoundAccounts?: number
  /** Explicit finite managed limits, independently parsed before coordinator construction. */
  readonly managed?: unknown
  /** Explicit Root-owned protected deployment publication; its JSON is not itself an execution capability. */
  readonly rootDeployment?: RootDeploymentReference
  /** Explicit protected maintenance reference; only closed mode with a maintenance runtime may consume it. */
  readonly recovery?: unknown
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
 * Register the selected actual owner; managed startup awaits its original metadata and recovery work.
 * @param ctx - root plugin context carrying the real runtime registration service.
 * @param config - explicit execution requirements.
 * @param deployment - original Root-protected deployment owner supplied by trusted infrastructure assembly.
 * @throws for missing deployment authority, unsupported capabilities, missing runtime or duplicate registration.
 */
export async function apply(ctx: Context, config: Config, deployment?: ManagedExecutionDeployment): Promise<void> {
  if (config.recovery !== undefined) {
    if (config.mode !== 'closed' || config.requiredCapabilities.length !== 0 || config.rootDeployment !== undefined
      || deployment !== undefined || ctx.get('peAccount') !== undefined || ctx.root.get('peAccount') !== undefined) {
      throw new ExecutionStateError('cloud/invalid-config', 'Recovery requires closed execution in its original maintenance Root.')
    }
    const runtime = ctx.get('peAccountRuntime')
    if (runtime === undefined) throw new ExecutionStateError('cloud/invalid-config', 'Recovery requires its original maintenance runtime.')
    const recovery = await import('./root-recovery.ts')
    await recovery.mountRootRecovery(ctx, runtime, parseManagedCoordinatorConfig(config.managed), config.recovery)
    return
  }
  if (config.mode === 'session-collect') {
    const resolved = Config({ mode: config.mode, requiredCapabilities: [...config.requiredCapabilities], managed: config.managed,
      ...(config.rootDeployment === undefined ? {} : { rootDeployment: config.rootDeployment }) })
    if (resolved.requiredCapabilities.some(capability => capability !== 'argv-collect')) return requireExecution(resolved)
    const limits = parseManagedCoordinatorConfig(config.managed)
    if (ctx.get('peAccount') !== undefined || ctx.root.get('peAccount') !== undefined
      || deployment === undefined && config.rootDeployment === undefined
      || deployment !== undefined && config.rootDeployment !== undefined) {
      throw new ExecutionStateError('cloud/invalid-config', 'Managed execution requires its original protected Root deployment.')
    }
    const runtime: AccountRuntimeService | undefined = ctx.get('peAccountRuntime')
    if (runtime === undefined) throw new ExecutionStateError('cloud/invalid-config', 'Managed execution requires the root account runtime.')
    const work: { closed: boolean; assembly?: Promise<RootExecutionAssembly>; coordinator?: ManagedCoordinator } = { closed: false }
    if (deployment === undefined) {
      const reference = config.rootDeployment
      if (reference === undefined) throw new ExecutionStateError('cloud/invalid-config', 'A protected Root deployment reference is required.')
      // Own the original construction before import/I/O. Disposal waits for a late result instead of losing its capabilities.
      ctx.effect(() => () => {
        work.closed = true
        return closeAssembly(work)
      }, 'pe-opensandbox: retain original protected deployment through actual coordinator cleanup')
      work.assembly = import('./bootstrap/assembly.ts').then((module) => {
        if (work.closed || ctx.fiber.uid === null) throw new ExecutionStateError('cloud/execution-unavailable', 'Root deployment construction was cancelled.')
        return module.assembleRootExecutionDeployment(reference, limits)
      })
      const assembly = await work.assembly
      if (work.closed || ctx.fiber.uid === null) throw new ExecutionStateError('cloud/execution-unavailable', 'Root deployment construction was cancelled.')
      deployment = assembly.deployment
    }
    deployment.assertCurrent()
    const coordinator = new ManagedCoordinator(ctx, runtime, limits, deployment)
    work.coordinator = coordinator
    await coordinator.start()
    return
  }
  if (config.rootDeployment !== undefined) {
    throw new ExecutionStateError('cloud/invalid-config', 'A protected Root deployment reference requires managed execution mode.')
  }
  if (config.mode !== 'closed') return requireExecution(config)
  if (config.managed !== undefined) {
    throw new ExecutionStateError('cloud/invalid-config', 'Closed execution accepts managed limits only for explicit maintenance recovery.')
  }
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

/** Actual assembly cleanup joins the original coordinator even when Cordis starts sibling disposers concurrently. */
async function closeAssembly(work: { assembly?: Promise<RootExecutionAssembly>; coordinator?: ManagedCoordinator }): Promise<void> {
  if (work.assembly === undefined) return
  const assembly = await work.assembly
  let failed = false, failure: unknown
  try { await work.coordinator?.closeRoot() }
  catch (cause) { failed = true; failure = cause }
  try { await assembly.closeActual() }
  catch (cause) {
    if (failed) throw new AggregateError([failure, cause], 'Root execution cleanup remains unconfirmed.')
    throw cause
  }
  if (failed) throw failure
}
