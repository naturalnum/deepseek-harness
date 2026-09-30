/** Native Session history reads that resume after temporary Platform outages. */
import timers from 'node:timers/promises'
import type { SessionFollowRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'

type FollowRequest = {
  readonly address: Extract<SessionFollowRequest['address'], { readonly kind: 'session' }>
  readonly maxMessages?: SessionFollowRequest['maxMessages']
  readonly turnWindow?: SessionFollowRequest['turnWindow']
  readonly assistantStream?: SessionFollowRequest['assistantStream']
}
type ReadCall = (path: '/native/sessions/snapshot' | '/native/sessions/after', input: unknown) => Promise<unknown>
const snapshotResult = z.object({ cursor: z.number().int().min(-1) }).passthrough()
const afterResult = z.object({ events: z.array(z.object({ seq: z.number().int().nonnegative() }).passthrough()) }).strict()
const networkErrors = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

/** Follow one owned Session without replacing its cursor after a temporary read failure.
 * Only transport failures and temporary 502/503/504 reads retry. Refusals,
 * invalid responses, response limits, and history gaps terminate the stream.
 * Cancellation releases the follower; an in-flight read keeps its RuntimeScope bounds.
 * @param call - tenant-authorized read using the configured Platform timeout and response limit.
 * @param request - validated root Session follow request.
 * @param pollMs - configured Host interval for idle polls and unavailable reads.
 * @param signal - native mux stream cancellation lifetime.
 * @returns one opening snapshot followed by contiguous durable events until cancellation.
 */
export async function* followNativeSession(call: ReadCall, request: FollowRequest,
  pollMs: number, signal: AbortSignal): AsyncGenerator<unknown> {
  try {
    const snapshot = snapshotResult.parse(await read(() => call('/native/sessions/snapshot', request), pollMs, signal))
    signal.throwIfAborted()
    yield snapshot
    let cursor = snapshot.cursor
    while (!signal.aborted) {
      const next = afterResult.parse(await read(() => call('/native/sessions/after',
        { sessionId: request.address.sessionId, cursor }), pollMs, signal))
      for (const event of next.events) {
        signal.throwIfAborted()
        if (event.seq !== cursor + 1) throw new PlatformError(503, 'native_history_gap')
        cursor = event.seq
        yield { type: 'event', event }
      }
      if (next.events.length) continue
      await timers.setTimeout(pollMs, undefined, { signal })
    }
  } catch (error) {
    if (signal.aborted) return
    throw error
  }
}

async function read(call: () => Promise<unknown>, pollMs: number, signal: AbortSignal): Promise<unknown> {
  while (true) {
    signal.throwIfAborted()
    try { return await readUntilAbort(call, signal) }
    catch (error) {
      signal.throwIfAborted()
      if (!temporaryReadFailure(error)) throw error
      await timers.setTimeout(pollMs, undefined, { signal })
    }
  }
}

function temporaryReadFailure(error: unknown): boolean {
  if (error instanceof PlatformError) {
    return [502, 503, 504].includes(error.status)
      && error.code !== 'platform_response_limit' && error.code !== 'native_history_gap'
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  if (!(error instanceof TypeError) || typeof error.cause !== 'object' || error.cause === null
    || !('code' in error.cause)) return false
  return typeof error.cause.code === 'string' && networkErrors.has(error.cause.code)
}

function readUntilAbort(call: () => Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    void call().then(value => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
  })
}
