/** Retained archival removals of actual pending siblings before their original owner settles. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { PlatformError, type Grant } from '../contracts.ts'
import type { NativeExecutionFrame } from '../native-execution-frame-contracts.ts'
import type { NativeWriterIdentity } from '../native-writer-contracts.ts'
import type { NativeSessionStopIntent } from '../native-session-stop-contracts.ts'
import { nativeArchiveInputCancelCommit } from '../native-archive-input-contracts.ts'
import type { NativeInputHttp } from './native-input-http.ts'
import { planPendingRemoval, retryNativeInputCommit, synchronizeRemovedInput } from './native-inbox-removal.ts'

/** Remove actual unclaimed pending inputs one by one while retaining the original prepared or claimed owner.
 * The prepared owner is removed last by its separate retirement transaction. A cold claimed frame keeps its
 * original operation and Writer epochs while the caller publishes under its current storage Grant.
 * @param input Original Agent, frame, requested stop and current independent storage ownership.
 * @returns Completion only after the exact canonical pending siblings and their publications are acknowledged.
 */
export async function cancelArchivePendingInputs(input: {
  readonly ctx: Context
  readonly agent: Agent
  readonly operation: Grant
  readonly frame: Extract<NativeExecutionFrame, { phase: 'prepared' | 'claimed' }>
  readonly writer: NativeWriterIdentity
  readonly stop: NativeSessionStopIntent
  readonly transport: NativeInputHttp
  readonly signal: AbortSignal
  readonly pollMs: number
}): Promise<void> {
  const { ctx, agent, operation, frame, writer, stop, transport } = input
  if (stop.status !== 'requested' || stop.sessionId !== operation.sessionId || frame.sessionId !== operation.sessionId) {
    throw new PlatformError(409, 'native_session_stop_required')
  }
  const runtime = ctx.powerEvolveRuntime
  for (;;) {
    input.signal.throwIfAborted()
    await ctx.sessions.flush(agent.session)
    const publisher = runtime.publication(operation)
    publisher.heartbeat()
    const seal = await publisher.seal()
    const removed = await agent.runMaintenance(async (maintenanceSignal) => {
      const signal = AbortSignal.any([maintenanceSignal, input.signal])
      signal.throwIfAborted()
      const activity = agent.captureInboxActivity(maintenanceSignal)
      const plan = await planPendingRemoval(ctx, agent, activity, seal.eventCount, signal,
        pending => pending.find(id => frame.phase !== 'prepared' || id !== frame.messageId))
      if (!plan) return false
      return publisher.commitInput(activity.cursor, plan.events, false, async (position) => {
        if (position.publisherId !== seal.publisherId || position.firstOrdinal !== seal.lastOrdinal + 1
          || position.revision !== seal.revision || position.epoch !== operation.epoch) {
          throw new PlatformError(409, 'native_input_publication_conflict')
        }
        const request = nativeArchiveInputCancelCommit.parse({ version: 1, stopId: stop.stopId, writer, frame,
          command: { rpcNonce: randomUUID(), payload: { sessionId: operation.sessionId,
            itemId: plan.message.id, action: { kind: 'remove' } } }, expectedEventCount: activity.cursor,
          events: z.array(z.json()).parse(plan.events), seal, presentation: { epoch: position.epoch,
            publisherId: position.publisherId, firstOrdinal: position.firstOrdinal, batchId: randomUUID() } })
        const committed = await retryNativeInputCommit({
          attempt: () => transport.cancelArchiveInput(operation, request, signal),
          beforeAttempt: () => { signal.throwIfAborted(); activity.assertCurrent() },
          pollMs: input.pollMs, signal,
        })
        synchronizeRemovedInput({ agent, runtime, operation, activity, plan, committed, signal })
        return { receipt: committed.presentation, value: true }
      })
    }, { scope: 'inbox' })
    if (!removed) return
  }
}
