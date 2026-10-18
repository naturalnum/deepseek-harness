/** Live Session projection state with reconnect baselines. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type {
  Session, SessionId,
} from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionBaseline,
  SessionProjectionValues,
} from './types.ts'

/** Explicit optional native control-buffer budgets; omission preserves existing buffering and disposal draining. */
export interface SessionControlBufferLimits {
  readonly maxQueuedEvents: number
  readonly maxQueuedBytes: number
  readonly maxFrameBytes: number
}

function controlBufferLimits(input: SessionControlBufferLimits): Readonly<SessionControlBufferLimits> {
  for (const value of [input.maxQueuedEvents, input.maxQueuedBytes, input.maxFrameBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Session control limits must be positive finite safe integers')
  }
  return Object.freeze({ maxQueuedEvents: input.maxQueuedEvents, maxQueuedBytes: input.maxQueuedBytes,
    maxFrameBytes: input.maxFrameBytes })
}

/** Owns the Host-wide Session control stream. */
export class SessionControlController {
  private readonly streams = new Set<ControlQueue>()

  /** @param ctx - Host context carrying live Agent and projection services. */
  constructor(private readonly ctx: Context) {
    ctx.sessionProjections.onChanged((session, key, value, seq) => {
      this.broadcast({
        type: 'projection',
        sessionId: session.id,
        key,
        value: value as JsonValue,
        seq,
      })
    })
    ctx.effect(() => () => {
      for (const stream of this.streams) stream.end()
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @param limits - optional explicit per-generation native queue and complete-frame limits.
   * @returns one complete baseline followed by live replacement frames.
   */
  async *control(signal: AbortSignal, limits?: SessionControlBufferLimits): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted()
    const queue = new ControlQueue(limits === undefined ? undefined : controlBufferLimits(limits))
    this.streams.add(queue)
    try {
      const baseline = { type: 'baseline' as const, value: this.baseline() }
      queue.frameBytes(baseline)
      yield baseline
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.end()
    }
  }

  private baseline(): SessionControlBaseline {
    const sessions = this.ctx.sessions.list()
    return {
      projections: this.projectionBaseline(sessions),
    }
  }

  private projectionBaseline(
    sessions: readonly Session[],
  ): Readonly<Record<SessionId, SessionProjectionBaseline>> {
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    for (const session of sessions) {
      const snapshot = this.ctx.sessionProjections.snapshot(session)
      blocks[session.id] = {
        asOfSeq: snapshot.asOfSeq,
        // Every projection definition validates its value before snapshot publication.
        values: snapshot.values as SessionProjectionValues,
      }
    }
    return blocks
  }

  private broadcast(frame: SessionControlFrame): void {
    for (const stream of this.streams) if (!stream.push(frame)) this.streams.delete(stream)
  }
}

class ControlQueue {
  private readonly buffer = new Deque<{ readonly frame: SessionControlFrame; readonly bytes: number }>()
  private wake: (() => void) | undefined
  private done = false
  private bytes = 0
  private failure: { readonly error: unknown } | undefined

  constructor(private readonly limits?: Readonly<SessionControlBufferLimits>) {}

  frameBytes(frame: SessionControlFrame): number {
    if (this.limits === undefined) return 0
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    if (bytes > this.limits.maxFrameBytes) throw new RangeError('Session control frame exceeds its explicit byte limit')
    return bytes
  }

  push(frame: SessionControlFrame): boolean {
    if (this.done) return false
    try {
      if (this.limits !== undefined && this.buffer.size >= this.limits.maxQueuedEvents) {
        throw new RangeError('Session control stream exceeds its explicit queued-event limit')
      }
      const bytes = this.frameBytes(frame)
      if (this.limits !== undefined && bytes > this.limits.maxQueuedBytes - this.bytes) {
        throw new RangeError('Session control stream exceeds its explicit resident-byte limit')
      }
      this.buffer.pushBack({ frame, bytes })
      this.bytes += bytes
      this.notify()
      return true
    } catch (error) {
      this.failure ??= { error }
      this.end()
      return false
    }
  }

  private notify(): void { const wake = this.wake; this.wake = undefined; wake?.() }

  end(): void {
    if (this.done) return
    this.done = true
    if (this.limits !== undefined) { this.buffer.clear(); this.bytes = 0 }
    this.notify()
  }

  private assertAvailable(): void { if (this.failure !== undefined) throw this.failure.error }

  async *iterate(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        this.assertAvailable()
        const item = this.buffer.popFront()
        if (item !== undefined) {
          this.bytes -= item.bytes
          yield item.frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      this.assertAvailable()
      // Omitted budgets preserve the original buffered drain on native Context disposal.
      while (this.buffer.size > 0 && !signal.aborted) {
        const item = this.buffer.popFront()
        if (item === undefined) break
        this.bytes -= item.bytes
        yield item.frame
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }
}
