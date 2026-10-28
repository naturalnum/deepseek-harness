/** Original question answers and timed-wait claims confined to one account Agent. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { NativeSessionGuards } from './native.ts'
import type { ExposurePolicy } from './exposure.ts'
import type { ExposureInventory } from './types.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'
import { CloudApiError } from './errors.ts'

/** Original question service and its exact account-bound Remote inventory. */
export interface NativeUserQuestions {
  readonly value: UserQuestions
  /** Inspect the original installation and selected method identities. */
  inspect(): ExposureInventory
}

/**
 * Install the native answer and timed-wait service under the original account admission.
 * Native question state, reply validation, claims and stream cancellation remain unchanged.
 * @param ctx Actual account Loader entry.
 * @param binding Original installed account generation.
 * @param assertCurrent Original business admission check.
 * @param policy Explicit account RPC and stream selection.
 * @param guards Shared active-Agent/project checks.
 * @param maximum Existing finite native inventory budget.
 * @returns The original service and its selected method inventory.
 */
export function createNativeUserQuestions(
  ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativeSessionGuards, maximum: number,
): NativeUserQuestions {
  const unavailable = (): never => { throw new CloudApiError('cloud/account-unavailable', 'The account question service is unavailable.') }
  const installation: { value?: UserQuestions } = {}
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding
      || policy.manifest.recipeVersion !== binding.recipeVersion) unavailable()
    if (installation.value !== undefined) {
      const current = ctx.get('userQuestions'), original: unknown = current === undefined ? undefined : Reflect.get(current, symbols.original) ?? current
      if (original !== installation.value) unavailable()
    }
  }
  const admit = (method: 'answer' | 'attachWait', agent: Agent): void => {
    installed()
    assertCurrent(binding)
    const endpoint = 'userQuestions/' + method
    const row = method === 'answer' ? policy.requireRpc(endpoint) : policy.requireStream(endpoint)
    if (row.handlerId !== 'native:userQuestions' || row.guard !== 'account-session') unavailable()
    agent.ctx.fiber.assertActive()
    if (agent.ctx.get('peAccount') !== binding || agent.ctx.root !== ctx.root || ctx.get('agents')?.get(agent.id) !== agent) {
      throw new CloudApiError('cloud/forbidden', 'Answers require the original Agent in this account.')
    }
    guards.assertActiveScope(agent)
    installed()
    assertCurrent(binding)
  }
  installed()
  class AccountUserQuestions extends UserQuestions {
    override answer(
      agent: Agent, callId: Parameters<UserQuestions['answer']>[1], answer: Parameters<UserQuestions['answer']>[2],
    ): boolean {
      admit('answer', agent)
      const value = super.answer(agent, callId, answer)
      admit('answer', agent)
      return value
    }

    override async *attachWait(
      agent: Agent, callId: Parameters<UserQuestions['attachWait']>[1], signal: AbortSignal,
    ): AsyncIterable<{ remainingMs: number }> {
      const control = AbortSignal.any([signal, binding.lifetime])
      control.throwIfAborted()
      admit('attachWait', agent)
      const source = super.attachWait(agent, callId, control)[Symbol.asyncIterator]()
      try {
        while (true) {
          control.throwIfAborted()
          admit('attachWait', agent)
          const next = await source.next()
          control.throwIfAborted()
          admit('attachWait', agent)
          if (next.done) return
          yield next.value
        }
      } finally { await source.return?.() }
    }
  }
  const value = new AccountUserQuestions(ctx)
  installation.value = value
  return { value, inspect() {
    installed()
    firstScreenNativeOwner(ctx, 'userQuestions', value, maximum)
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'userQuestions' || remote.namespace !== 'userQuestions') unavailable()
    const rpc: ExposureInventory['rpcEndpoints'][number][] = [], streams: ExposureInventory['streamEndpoints'][number][] = []
    for (const method of ['answer', 'attachWait'] as const) {
      const mode = method === 'answer' ? 'rpc' : 'stream', endpoint = 'userQuestions/' + method
      const marker = markers.find(row => row.method === method)
      if (marker === undefined || (marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== mode
        || Reflect.get(value, method) !== Reflect.get(AccountUserQuestions.prototype, method)) unavailable()
      const selected = mode === 'rpc' ? policy.manifest.rpcEndpoints : policy.manifest.streamEndpoints
      if (selected.some(row => row.endpoint === endpoint)) (mode === 'rpc' ? rpc : streams)
        .push({ endpoint, handlerId: 'native:userQuestions', guard: 'account-session' })
    }
    return { recipeVersion: binding.recipeVersion, rpcEndpoints: rpc, streamEndpoints: streams, exactFetchRoutes: [] }
  } }
}
