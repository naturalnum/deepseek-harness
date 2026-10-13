/** Detached native removal planning and transport retries under their original lifetimes. */
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { planInboxCommand } from '@deepseek-ai/dsh-agent-loop'
import { Session } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { PlatformError, type Grant } from '../contracts.ts'
import { foldInputHistory, nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import type { NativeArchiveInputCancelReceipt } from '../native-archive-input-contracts.ts'
import type { NativePreparedCancelReceipt } from '../native-prepared-cancel-contracts.ts'
import type RuntimeScope from './scope.ts'

/** Retry only the unchanged original commit after an uncertain transport response.
 * @param input Original attempt, polling lifetime and optional maintenance observation checks.
 * @returns The original acknowledged commit; an explicit client refusal remains terminal.
 */
export async function retryNativeInputCommit<T>(input: {
  readonly attempt: () => Promise<T>
  readonly beforeAttempt?: () => void
  readonly pollMs: number
  readonly signal: AbortSignal
}): Promise<T> {
  for (;;) {
    input.beforeAttempt?.()
    try { return await input.attempt() }
    catch (error) {
      if (error instanceof PlatformError && error.status < 500) throw error
      await delay(input.pollMs, undefined, { signal: input.signal })
    }
  }
}

/** Acknowledge one exact removal in both local mirrors under the original current maintenance activity.
 * @param input Original Agent, runtime, planned removal, canonical receipt and maintenance lifetime.
 */
export function synchronizeRemovedInput(input: {
  readonly agent: Agent
  readonly runtime: Pick<RuntimeScope, 'synchronizeCommitted'>
  readonly operation: Grant
  readonly activity: ReturnType<Agent['captureInboxActivity']>
  readonly plan: NonNullable<Awaited<ReturnType<typeof planPendingRemoval>>>
  readonly committed: NativeArchiveInputCancelReceipt | NativePreparedCancelReceipt
  readonly signal: AbortSignal
}): void {
  const { agent, runtime, operation, activity, plan, committed, signal } = input
  signal.throwIfAborted()
  activity.assertCurrent()
  if (committed.input.result.kind !== 'removed'
    || committed.input.result.inputDigest !== nativeInputRecordDigest(plan.message)) {
    throw new PlatformError(502, 'native_input_cancellation_receipt')
  }
  activity.synchronize(() => {
    runtime.synchronizeCommitted(operation, activity.cursor, plan.events)
    agent.session.synchronizeCommitted(plan.events)
  })
}

/** Select and plan one actual pending message under a still-current native maintenance observation.
 * @param ctx Host persistence provider enforcing the deployment's bounded canonical prefix.
 * @param agent Original live native Agent in inbox maintenance.
 * @param activity Observation captured with that maintenance invocation's original signal.
 * @param eventCount Acknowledged publisher prefix protected by the caller.
 * @param signal Combined maintenance and whole-operation lifetime for asynchronous reads.
 * @param select Select an existing pending message identity, or return absence when cleanup is complete.
 * @returns One native removal and its original input, or absence without inventing an empty canonical suffix.
 */
export async function planPendingRemoval(ctx: Context, agent: Agent,
  activity: ReturnType<Agent['captureInboxActivity']>, eventCount: number, signal: AbortSignal,
  select: (pending: readonly MessageId[]) => MessageId | undefined) {
  const reader = await ctx.sessionPersistence.open(agent.session.id, 'read', { signal })
  const history = await (async () => {
    try { return (await reader.read(0, activity.cursor, { signal })).events }
    finally { await reader.close() }
  })()
  signal.throwIfAborted()
  activity.assertCurrent()
  if (activity.cursor !== history.length || activity.cursor !== eventCount) {
    throw new PlatformError(409, 'native_input_observation_prefix')
  }
  const folded = foldInputHistory(agent.session.header, history)
  const pending = [...folded.inbox['next-step'], ...folded.inbox['next-turn']]
  const id = select(pending.map(item => item.id))
  if (id === undefined) return undefined
  const message = pending.find(item => item.id === id)
  if (!message) throw new PlatformError(409, 'native_input_not_found')
  const detached = Session.forPlanning(agent.session.id, history, agent.session.header, agent.session.inheritedEventCount,
    agent.ctx.sessions.messageProjections)
  const plan = planInboxCommand(detached, agent.ctx.sessionProjections, { kind: 'remove', messageId: id }, activity)
  const removal = plan.events[0]
  if (!plan.found || plan.events.length !== 1 || removal?.type !== 'agent/inbox/spliced'
    || removal.data.removedCount !== 1 || removal.data.inserted.length !== 0 || removal.data.outcome !== 'canceled') {
    throw new PlatformError(409, 'native_input_cancellation_batch')
  }
  activity.assertCurrent()
  return { message, events: plan.events }
}
