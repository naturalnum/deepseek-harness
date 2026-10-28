/** Account-bound admission over the original same-Session goal domain. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import GoalService, { type CreateGoalRequest, type CreateGoalResult, type EditGoalRequest, type GoalRef, type GoalView } from '@deepseek-ai/dsh-goal'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExposurePolicy } from './exposure.ts'
import type { NativeSessionGuards } from './native.ts'
import type { ExposureInventory } from './types.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { CloudApiError } from './errors.ts'

/** Original native goal service and its exact guarded RPC inventory. */
export interface NativeGoals {
  readonly value: GoalService
  /** Check the original installation and method identities without granting readiness. */
  inspect(): ExposureInventory
}

const METHODS = ['get', 'edit', 'pause', 'resume', 'complete', 'clear', 'remoteExportCreate'] as const
type GoalMethod = typeof METHODS[number]

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original account goal service is unavailable.')
}

/**
 * Construct the native goal domain with the account's original active-Agent admission.
 * Goal folds, compare-and-set revisions, activation, command behavior and durable changes stay native.
 * Internal lifecycle disarming retains its native behavior after business admission closes.
 * @param ctx Original account Loader fiber.
 * @param binding Exact installed account generation.
 * @param assertCurrent Original synchronous business admission check.
 * @param policy Exact account exposure audited before dispatch.
 * @param guards Same native Session/project guards and existing result bounds.
 * @param maximum Existing native method-inventory bound.
 * @param config Original GoalService configuration, including its deployment round cap.
 * @returns Native service and its exact selected RPC inventory.
 */
export function createNativeGoals(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativeSessionGuards, maximum: number,
  config: ConstructorParameters<typeof GoalService>[1],
): NativeGoals {
  const candidate = guards.firstScreen
  if (candidate === undefined || !Number.isSafeInteger(maximum) || maximum < 1) unavailable()
  const reader = candidate
  const installation: { value?: GoalService } = {}
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) {
      throw new CloudApiError('cloud/stale-generation', 'The goal service belongs to an ended account generation.')
    }
    if (policy.manifest.recipeVersion !== binding.recipeVersion) unavailable()
    if (installation.value !== undefined) {
      const current = ctx.get('goals'), original: unknown = current === undefined ? undefined : Reflect.get(current, symbols.original) ?? current
      if (original !== installation.value) unavailable()
    }
  }
  const admit = (method: GoalMethod, agent: Agent): void => {
    installed()
    assertCurrent(binding)
    const name = method === 'remoteExportCreate' ? 'create' : method
    const row = policy.requireRpc('goals/' + name)
    if (row.handlerId !== 'native:goals' || row.guard !== 'account-session') unavailable()
    agent.ctx.fiber.assertActive()
    if (agent.ctx.get('peAccount') !== binding || agent.ctx.root !== ctx.root || ctx.get('agents')?.get(agent.id) !== agent) {
      throw new CloudApiError('cloud/forbidden', 'Goals require the original Agent in this account.')
    }
    guards.assertActiveScope(agent)
    installed()
    assertCurrent(binding)
  }
  const result = <T>(method: GoalMethod, agent: Agent, value: T): T => {
    admit(method, agent)
    if (value !== undefined) firstScreenJsonBytes(value, reader.maxFrameBytes)
    return value
  }
  installed()
  class AccountGoals extends GoalService {
    override get(agent: Agent): GoalView | undefined {
      admit('get', agent)
      return result('get', agent, super.get(agent))
    }

    override create(agent: Agent, request: CreateGoalRequest): GoalView {
      admit('remoteExportCreate', agent)
      firstScreenJsonBytes(request, reader.maxFrameBytes)
      return result('remoteExportCreate', agent, super.create(agent, request))
    }

    override remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
      admit('remoteExportCreate', agent)
      return result('remoteExportCreate', agent, super.remoteExportCreate(agent, request))
    }

    override edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView {
      admit('edit', agent)
      firstScreenJsonBytes(request, reader.maxFrameBytes)
      return result('edit', agent, super.edit(agent, ref, request))
    }

    override pause(agent: Agent, ref: GoalRef): GoalView {
      admit('pause', agent)
      return result('pause', agent, super.pause(agent, ref))
    }

    override resume(agent: Agent, ref: GoalRef): GoalView {
      admit('resume', agent)
      return result('resume', agent, super.resume(agent, ref))
    }

    override complete(agent: Agent, ref: GoalRef): GoalView {
      admit('complete', agent)
      return result('complete', agent, super.complete(agent, ref))
    }

    override clear(agent: Agent, ref: GoalRef): GoalRef {
      admit('clear', agent)
      return result('clear', agent, super.clear(agent, ref))
    }
  }
  const value = new AccountGoals(ctx, config)
  installation.value = value
  return { value, inspect() {
    installed()
    firstScreenNativeOwner(ctx, 'goals', value, maximum)
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'goals' || remote.namespace !== 'goals'
      || markers.length !== METHODS.length || markers.length > maximum) unavailable()
    for (const method of METHODS) {
      const marker = markers.find(row => row.method === method), exportName = method === 'remoteExportCreate' ? 'create' : method
      if (marker === undefined || (marker.exportName ?? method) !== exportName || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(value, method) !== Reflect.get(AccountGoals.prototype, method)) unavailable()
    }
    return { recipeVersion: binding.recipeVersion,
      rpcEndpoints: METHODS.map(method => method === 'remoteExportCreate' ? 'create' : method)
        .filter(method => policy.manifest.rpcEndpoints.some(row => row.endpoint === 'goals/' + method))
        .map(method => ({ endpoint: 'goals/' + method, handlerId: 'native:goals', guard: 'account-session' })),
      streamEndpoints: [], exactFetchRoutes: [] }
  } }
}
