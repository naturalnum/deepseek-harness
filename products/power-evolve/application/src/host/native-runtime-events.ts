/** The native Remote Event dispatcher keeps its callbacks while PG owns cold and live Session membership. */
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'

interface Summary { sessionId: string; running: boolean }
type Read = () => Promise<readonly Summary[]>

async function* sessionEvents(read: Read, pollMs: number, signal: AbortSignal): AsyncGenerator {
  const stopped = () => signal.aborted
  let previous = new Map<string, Summary>()
  while (!stopped()) {
    const items = await read(), current = new Map(items.map(item => [item.sessionId, item]))
    for (const item of items) {
      const before = previous.get(item.sessionId)
      if (JSON.stringify(item) !== JSON.stringify(before)) yield { type: 'emit', event: 'api-session/added', args: [item] }
      if (item.running !== before?.running) yield { type: 'emit', event: 'api-session/status', args: [item.sessionId, item.running] }
    }
    for (const id of previous.keys()) if (!current.has(id)) yield { type: 'emit', event: 'api-session/removed', args: [id] }
    previous = current
    try { await delay(Math.max(pollMs, 1000), undefined, { signal }) }
    catch (error) { if (stopped()) return; throw error }
  }
}

function isTransientSession(frame: unknown): boolean {
  return typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'emit'
    && 'event' in frame && ['api-session/added', 'api-session/removed', 'api-session/status'].includes(String(frame.event))
}

/** Merge actual native notifications and waterfall calls with PG Session membership, draining both sources on close.
 * @param ctx Fixed-account native process with its maintained Remote Event source registered.
 * @param read Current owned PG Session roster; every poll rechecks browser authority.
 * @param pollMs Explicit membership observation interval.
 * @param signal Original multiplexed-stream lifetime.
 * @returns Native callback frames plus durable Session notifications; transient Agent disposal cannot delete PG history.
 */
export async function* nativeRuntimeEvents(ctx: Context, read: Read, pollMs: number,
  signal: AbortSignal): AsyncGenerator {
  const stop = new AbortController(), lifetime = AbortSignal.any([signal, stop.signal])
  const native = ctx.typertGateway.remoteEventStream(lifetime)[Symbol.asyncIterator]()
  const sessions = sessionEvents(read, pollMs, lifetime)[Symbol.asyncIterator]()
  let nativeNext = native.next().then(value => ({ source: 'native' as const, value }))
  let sessionNext = sessions.next().then(value => ({ source: 'sessions' as const, value }))
  try {
    while (!lifetime.aborted) {
      const next = await Promise.race([nativeNext, sessionNext])
      if (next.value.done) return
      if (next.source === 'native') {
        nativeNext = native.next().then(value => ({ source: 'native' as const, value }))
        if (!isTransientSession(next.value.value)) yield next.value.value
      } else {
        sessionNext = sessions.next().then(value => ({ source: 'sessions' as const, value }))
        yield next.value.value
      }
    }
  } finally {
    stop.abort()
    await Promise.allSettled([nativeNext, sessionNext])
    await Promise.allSettled([native.return?.(), sessions.return(undefined)])
  }
}
