/** Native Session history reads that resume after temporary Platform outages. */
import timers from 'node:timers/promises'
import type { SessionFollowRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { nativeAssistantBytes, nativeAssistantEntry } from '../native-assistant-records.ts'

type FollowRequest = {
  readonly address: Extract<SessionFollowRequest['address'], { readonly kind: 'session' }>
  readonly maxMessages?: SessionFollowRequest['maxMessages']
  readonly turnWindow?: SessionFollowRequest['turnWindow']
  readonly assistantStream?: SessionFollowRequest['assistantStream']
}
type ReadCall = (path: '/native/sessions/snapshot' | '/native/sessions/after'
  | '/native/sessions/open' | '/native/sessions/presentationAfter', input: unknown, signal: AbortSignal) => Promise<unknown>
const snapshotResult = z.object({ cursor: z.number().int().min(-1) }).loose()
const afterResult = z.object({ events: z.array(z.object({ seq: z.number().int().nonnegative() }).loose()) }).strict()
const index = z.number().int().nonnegative().refine(value => !Object.is(value, -0))
const position = z.object({ epoch: index.min(1).max(2_147_483_647), publisherId: z.uuid(), ordinal: index }).strict()
const baseline = z.object({ revision: index, activeAttempt: z.object({
  attemptId: z.string().min(1).max(256), startedAfterSeq: z.number().int().min(-1), turn: index, step: index,
  nextIndex: index, stream: z.array(z.json()),
}).strict().optional() }).strict()
const wireHeader = z.object({ cwd: z.string() }).loose().transform(({ cwd, ...header }) => ({ ...headerSchema.parse(header), cwd }))
const openingResult = z.object({ snapshot: snapshotResult.extend({ type: z.literal('snapshot'), header: wireHeader,
  records: z.array(z.object({ type: z.literal('event'), event: z.json() }).strict()), hasMore: z.boolean(),
  assistantStream: baseline }), position: position.nullable() }).strict()
const packetResult = z.discriminatedUnion('kind', [z.object({ kind: z.literal('reopen') }).strict(),
  z.object({ kind: z.literal('next'), position: position.nullable(), cursor: z.number().int().min(-1), frames: z.array(
    z.discriminatedUnion('type', [z.object({ type: z.literal('event'), event: z.json() }).strict(),
      z.object({ type: z.literal('assistant-stream'), frame: nativeAssistantEntry.shape.item.options[1].shape.frame }).strict()]),
  ) }).strict(),
])
const networkErrors = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

/** Limits retire one follow generation; the native Client opens a fresh coherent generation. */
export interface NativeFollowLimits {
  readonly maxGenerationMs: number
  readonly maxGenerationItems: number
  readonly maxGenerationBytes: number
}

/** Follow one owned Session without replacing its cursor after a temporary read failure.
 * Only transport failures and temporary 502/503/504 reads retry. Refusals,
 * invalid responses, response limits, and history gaps terminate the stream.
 * Cancellation releases the follower; an in-flight read keeps its RuntimeScope bounds.
 * @param call - tenant-authorized read using the configured Platform timeout and response limit.
 * @param request - validated root Session follow request.
 * @param pollMs - configured Host interval for idle polls and unavailable reads.
 * @param signal - native mux stream cancellation lifetime.
 * @param limits - explicit lifetime, item and serialized byte bounds for assistant generations.
 * @returns one opening followed by ordered history and original assistant frames; accepted generations retire normally at a limit.
 */
export async function* followNativeSession(call: ReadCall, request: FollowRequest,
  pollMs: number, signal: AbortSignal, limits: NativeFollowLimits): AsyncGenerator {
  if (request.assistantStream) {
    yield* followPresentation(call, request, pollMs, signal, limits)
    return
  }
  try {
    const snapshot = snapshotResult.parse(await read(() => call('/native/sessions/snapshot', request, signal), pollMs, signal))
    signal.throwIfAborted()
    yield snapshot
    let cursor = snapshot.cursor
    while (!signal.aborted) {
      const next = afterResult.parse(await read(() => call('/native/sessions/after',
        { sessionId: request.address.sessionId, cursor }, signal), pollMs, signal))
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

async function* followPresentation(call: ReadCall, request: FollowRequest,
  pollMs: number, signal: AbortSignal, limits: NativeFollowLimits): AsyncGenerator {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(limits.maxGenerationMs)])
  let items = 0, bytes = 0, opened = false
  const admit = (frame: unknown): boolean => {
    const size = nativeAssistantBytes(frame)
    if (size > limits.maxGenerationBytes) throw new PlatformError(413, 'native_follow_frame_budget')
    if (items + 1 > limits.maxGenerationItems || bytes + size > limits.maxGenerationBytes) return false
    items++; bytes += size
    return true
  }
  try {
    const opening = openingResult.parse(await read(() => call('/native/sessions/open', request, lifetime), pollMs, lifetime))
    lifetime.throwIfAborted()
    parseEvents(opening.snapshot.header, opening.snapshot.records.map(record => record.event))
    if (!admit(opening.snapshot)) return
    opened = true
    yield opening.snapshot
    let cursor = opening.snapshot.cursor, revision = opening.snapshot.assistantStream.revision
    let prior = opening.position
    while (!lifetime.aborted) {
      const next = packetResult.parse(await read(() => call('/native/sessions/presentationAfter',
        { sessionId: request.address.sessionId, cursor, position: prior }, lifetime), pollMs, lifetime))
      if (next.kind === 'reopen') return
      if ((prior === null) !== (next.position === null)
        || (prior && next.position && (prior.epoch !== next.position.epoch || prior.publisherId !== next.position.publisherId
          || next.position.ordinal < prior.ordinal))) throw new PlatformError(503, 'native_assistant_position_invalid')
      for (const frame of next.frames) {
        lifetime.throwIfAborted()
        if (!admit(frame)) return
        if (frame.type === 'event') {
          const [event] = parseEvents(opening.snapshot.header, [frame.event])
          if (!event || event.seq !== cursor + 1) throw new PlatformError(503, 'native_history_gap')
          cursor = event.seq
        } else {
          if (frame.frame.revision !== revision + 1) throw new PlatformError(503, 'native_assistant_revision_gap')
          if ((frame.frame.type === 'start' && frame.frame.startedAfterSeq !== cursor)
            || (frame.frame.type === 'end' && frame.frame.outcome.kind === 'committed' && frame.frame.outcome.seq > cursor)) {
            throw new PlatformError(503, 'native_assistant_frame_order')
          }
          revision = frame.frame.revision
        }
        yield frame
      }
      if (cursor !== next.cursor) throw new PlatformError(503, 'native_history_gap')
      prior = next.position
      if (next.frames.length) continue
      await timers.setTimeout(pollMs, undefined, { signal: lifetime })
    }
  } catch (error) {
    if (signal.aborted) return
    if (lifetime.aborted) {
      if (!opened) throw new PlatformError(504, 'native_follow_opening_timeout')
      return
    }
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
      && !error.code.startsWith('native_assistant_')
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  if (!(error instanceof TypeError) || typeof error.cause !== 'object' || error.cause === null
    || !('code' in error.cause)) return false
  return typeof error.cause.code === 'string' && networkErrors.has(error.cause.code)
}

function readUntilAbort(call: () => Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(readFailure(signal.reason)) }
    signal.addEventListener('abort', aborted, { once: true })
    void call().then((value) => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted)
      reject(readFailure(error))
    })
  })
}

function readFailure(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Native Session read failed', { cause: reason })
}
