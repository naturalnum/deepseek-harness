/** Bounded operation dispatch into the native Agent loop; no execution environment is loaded. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'
import type { Grant } from '../contracts.ts'

/** Limits apply to active Agents, while inactive history remains in PG. */
export interface SchedulerConfig {
  concurrency: number
  pollMs: number
  renewMs: number
  operationTimeoutMs: number
}

/** Dispatches only platform-issued grants and disposes each completed Agent. */
export class Scheduler {
  private readonly stop = new AbortController()
  private readonly active = new Map<string, Promise<void>>()
  private readonly handles = new Set<AgentHandle>()
  private polling: Promise<void> | undefined

  constructor(private readonly ctx: Context, private readonly config: SchedulerConfig) {}

  /** Begin polling after the profile services are ready. */
  start(): void { this.polling = this.poll() }

  /** Stop admission and drain active Agents before service teardown. */
  async close(): Promise<void> {
    this.stop.abort()
    for (const handle of this.handles) handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    await this.polling
    await Promise.allSettled(this.active.values())
  }

  private async poll(): Promise<void> {
    while (!this.stop.signal.aborted) {
      try {
        if (this.active.size < this.config.concurrency) {
          const grant = await this.ctx.powerEvolveRuntime.claim()
          if (grant) {
            const running = this.run(grant).catch(error => {
              this.ctx.logger.warn('Operation processing failed (%s)', error instanceof Error ? error.name : 'unknown')
            }).finally(() => { this.active.delete(grant.operationId) })
            this.active.set(grant.operationId, running)
            continue
          }
        }
      } catch (error) {
        this.ctx.logger.warn('Task claim failed (%s)', error instanceof Error ? error.name : 'unknown')
      }
      try { await delay(this.config.pollMs, undefined, { signal: this.stop.signal }) }
      catch (error) { if (!this.stop.signal.aborted) throw error }
    }
  }

  private async run(grant: Grant): Promise<void> {
    const runtime = this.ctx.powerEvolveRuntime
    runtime.grants.set(grant.sessionId, grant)
    const lifetime = new AbortController()
    let handle: AgentHandle | undefined
    let failure: string | null = null
    const timeout = setTimeout(() => {
      failure = 'operation_timeout'
      lifetime.abort()
      handle?.agent.cancel({ kind: 'disposed' })
    }, this.config.operationTimeoutMs)
    const renew = (async () => {
      while (!lifetime.signal.aborted) {
        try { await delay(this.config.renewMs, undefined, { signal: lifetime.signal }) }
        catch (error) { if (lifetime.signal.aborted) return; throw error }
        try { await runtime.call('/runtime/renew', grant.token, {}) }
        catch (_renewalFailed) {
          failure = 'lease_lost'
          lifetime.abort()
          handle?.agent.cancel({ kind: 'disposed' })
        }
      }
    })()
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: grant.sessionId, signal: lifetime.signal,
        agentOptions: { provider: 'power-evolve', model: grant.settings.model, maxTokens: grant.settings.maxTokens },
      })
      this.handles.add(handle)
      const { agent } = handle
      const history = agent.session.snapshotEvents()
      const consumedAt = history.findIndex(event => event.type === 'user/message' && event.data.id === MessageId(grant.requestId))
      if (consumedAt < 0 && !this.stop.signal.aborted) {
        // A restored pending input has not reached the model. Replace that pending entry
        // under the same durable request id before explicitly waking the native driver.
        agent.inbox.remove(MessageId(grant.requestId))
        agent.followup({ id: MessageId(grant.requestId), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: grant.text }] })
        await agent.whenIdle()
      }
      await this.ctx.sessions.flush(agent.session)
      const events = agent.session.snapshotEvents()
      const index = events.findIndex(event => event.type === 'user/message' && event.data.id === MessageId(grant.requestId))
      // Include the turn start preceding the consumed message when classifying its outcome.
      let start = Math.max(0, index)
      while (start > 0 && events[start]?.type !== 'turn/start') start--
      const outcome = foldConsumedWork(events.slice(start)).end?.data.reason.kind
      if (failure === null && outcome !== 'completed') failure = outcome === undefined ? 'not_completed' : `turn_${outcome}`
      await handle.dispose()
      this.handles.delete(handle)
      handle = undefined
      if (!(this.stop.signal.aborted && index < 0)) {
        await runtime.call('/runtime/finish', grant.token, { outcome: failure === null ? 'completed' : 'failed', errorCode: failure })
      }
    } catch (error) {
      if (handle) {
        try { await handle.dispose() }
        finally { this.handles.delete(handle); handle = undefined }
      }
      if (!this.stop.signal.aborted) {
        try { await runtime.call('/runtime/finish', grant.token, { outcome: 'failed', errorCode: failure ?? 'runtime_error' }) }
        catch (_settlementUnavailable) { /* An expired grant is reconciled by the next claimant. */ }
      }
      throw error
    } finally {
      clearTimeout(timeout)
      lifetime.abort()
      await renew
      try { if (handle) await handle.dispose() }
      finally {
        if (handle) this.handles.delete(handle)
        runtime.grants.delete(grant.sessionId)
      }
    }
  }
}
