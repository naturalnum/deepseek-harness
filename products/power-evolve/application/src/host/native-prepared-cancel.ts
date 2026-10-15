/** Native maintenance retires one unconsumed prepared input without entering another turn. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { nativeModelAgentOptions } from './model.ts'
import { z } from 'zod'
import { PlatformError, type Grant } from '../contracts.ts'
import type { NativeExecutionFrame } from '../native-execution-frame-contracts.ts'
import type { NativeSessionStopIntent } from '../native-session-stop-contracts.ts'
import { nativePreparedCancelCommit } from '../native-prepared-cancel-contracts.ts'
import type { NativeWriterIdentity } from '../native-writer-contracts.ts'
import type { NativePublicationSeal } from './native-assistant-publisher.ts'
import type { NativeInputHttp } from './native-input-http.ts'
import { planPendingRemoval, retryNativeInputCommit, synchronizeRemovedInput } from './native-inbox-removal.ts'
import { cancelArchivePendingInputs } from './native-archive-input.ts'

/** Current Scheduler ownership and explicit deadlines for one native prepared cancellation. */
export interface NativePreparedCancellationRun {
  readonly ctx: Context
  readonly operation: Grant
  readonly frame: Extract<NativeExecutionFrame, { phase: 'prepared' }>
  readonly writer: NativeWriterIdentity
  readonly transport: NativeInputHttp
  readonly lifetime: AbortController
  readonly handles: Set<AgentHandle>
  readonly operationTimeoutMs: number
  readonly pollMs: number
  readonly archiveStop?: NativeSessionStopIntent
  /** Stop and await the original operation renewal before sending the retained retirement request. */
  readonly stopOperationRenewal: () => Promise<void>
}

async function removePrepared(input: NativePreparedCancellationRun, agent: Agent, seal: NativePublicationSeal): Promise<void> {
  const { operation, frame, writer, transport, lifetime } = input, runtime = input.ctx.powerEvolveRuntime
  const result = await agent.runMaintenance(async (maintenanceSignal) => {
    const signal = AbortSignal.any([maintenanceSignal, lifetime.signal])
    signal.throwIfAborted()
    const activity = agent.captureInboxActivity(maintenanceSignal)
    const plan = await planPendingRemoval(input.ctx, agent, activity, seal.eventCount, signal, () => frame.messageId)
    if (!plan) throw new PlatformError(409, 'native_input_not_found')
    return runtime.publication(operation).commitInput(activity.cursor, plan.events, false, async (position) => {
      if (position.publisherId !== seal.publisherId || position.firstOrdinal !== seal.lastOrdinal + 1
        || position.revision !== seal.revision || position.epoch !== operation.epoch) {
        throw new PlatformError(409, 'native_input_publication_conflict')
      }
      const request = nativePreparedCancelCommit.parse({ version: 1, writer, frame,
        command: { rpcNonce: randomUUID(), payload: { sessionId: operation.sessionId,
          itemId: frame.messageId, action: { kind: 'remove' } } }, expectedEventCount: activity.cursor,
        events: z.array(z.json()).parse(plan.events), seal, presentation: { epoch: position.epoch,
          publisherId: position.publisherId, firstOrdinal: position.firstOrdinal, batchId: randomUUID() } })
      await input.stopOperationRenewal()
      signal.throwIfAborted()
      const committed = await retryNativeInputCommit({
        attempt: () => transport.cancelPrepared(operation, request, signal),
        beforeAttempt: () => { signal.throwIfAborted(); activity.assertCurrent() },
        pollMs: input.pollMs, signal,
      })
      synchronizeRemovedInput({ agent, runtime, operation, activity, plan, committed, signal })
      return { receipt: committed.presentation, value: committed }
    })
  }, { scope: 'inbox' })
  const { epoch: _epoch, ...committedSeal } = result.presentation
  runtime.retirePublication(operation, committedSeal)
}

/** Resume native closers, cancel only the original pending input, and retire its acknowledged local publication.
 * @param input Current prepared scope, independent Writer, whole-operation deadline and awaited renewal shutdown.
 * @returns Completion after the atomic retirement receipt, exact local mirrors and native handle disposal.
 */
export async function cancelPreparedInput(input: NativePreparedCancellationRun): Promise<void> {
  const { ctx, operation, lifetime } = input, runtime = ctx.powerEvolveRuntime
  let handle: AgentHandle | undefined, failure: { error: unknown } | undefined
  const timeout = setTimeout(() => { lifetime.abort(new PlatformError(409, 'operation_timeout')) }, input.operationTimeoutMs)
  try {
    handle = await ctx.agents.resume({ resumeSessionId: operation.sessionId, signal: lifetime.signal,
      disposeOptions: { keepInbox: true },
      agentOptions: nativeModelAgentOptions(operation.settings),
      setup: (agentCtx, agent) => {
        const publisher = runtime.publication(operation)
        agentCtx.effect(() => publisher.onFailure((error) => { lifetime.abort(error) }))
        agentCtx.effect(() => agent.onBeforeTurn(() => { throw new PlatformError(409, 'native_input_cancellation_only') }))
        return { commit: () => { runtime.assertGrant(operation); publisher.assertOpen() } }
      },
    })
    input.handles.add(handle)
    if (input.archiveStop) await cancelArchivePendingInputs({ ...input, agent: handle.agent,
      stop: input.archiveStop, signal: lifetime.signal })
    await ctx.sessions.flush(handle.agent.session)
    lifetime.signal.throwIfAborted()
    const publisher = runtime.publication(operation)
    publisher.heartbeat()
    const seal = await publisher.seal()
    await removePrepared(input, handle.agent, seal)
  } catch (error) {
    const reason: unknown = lifetime.signal.reason
    failure = { error: reason instanceof PlatformError && reason.code === 'operation_timeout' ? reason : error }
  } finally {
    clearTimeout(timeout)
    if (handle) {
      try { await handle.dispose({ keepInbox: true }) }
      catch (error) { failure ??= { error } }
      finally { input.handles.delete(handle) }
    }
  }
  if (failure) throw failure.error
}
