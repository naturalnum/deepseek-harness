/** Native Host follow consumes coherent openings and original ordered frames from real PostgreSQL. */
import { randomUUID } from 'node:crypto'
import timers from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session } from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator, type LlmAttemptId, type MessageId } from '@deepseek-ai/dsh-llm'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { requestId, sessionId } from '../src/contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { nativeAssistantBytes } from '../src/native-assistant-records.ts'
import { NativeAssistantPublisher } from '../src/host/native-assistant-publisher.ts'
import { followNativeSession } from '../src/host/native-session-follow.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeAssistantRead, nativeAssistantPosition } from '../src/platform/native-assistant-read.ts'
import { NativeSessionRead, nativeFollowRequest } from '../src/platform/native-session-read.ts'
import { releaseNativeAssistant } from '../src/platform/native-assistant-lifecycle.ts'
import { EventStore } from '../src/platform/events.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

const eventLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const presentationLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000,
  maxEventBytes: eventLimits.maxEventBytes }
const readLimits = { maxOpeningBytes: 8_388_608, maxBaselineChunks: 8192, maxPacketItems: 256,
  maxPacketBytes: 2_097_152, maxCanonicalBytes: 8_388_608 }
const followLimits = { maxGenerationMs: 60_000, maxGenerationItems: 1024, maxGenerationBytes: 16_777_216 }
type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const afterRequest = z.object({ sessionId, cursor: z.number().int().min(-1), position: nativeAssistantPosition.nullable() }).strict()

async function admitted(f: Fixture) {
  const tasks = new TaskStore(f.pool, eventLimits), events = new EventStore(tasks, eventLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'native follow fixture', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Expected a live publication grant')
  const header = headerSchema.parse((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [grant.sessionId])).rows[0]?.header)
  const native = Session.create(header.id, undefined, header)
  const store = new NativeAssistantStore(tasks, events, presentationLimits)
  const publisher = new NativeAssistantPublisher(grant, 0, { maxQueueItems: 256, maxQueueBytes: 4_194_304,
    maxBatchItems: presentationLimits.maxBatchItems, maxBatchBytes: presentationLimits.maxBatchBytes,
    maxItemBytes: presentationLimits.maxItemBytes }, (token, input) => store.apply(token, input))
  return { tasks, grant, native, publisher, header }
}

function follower(f: Fixture, id: z.infer<typeof sessionId>, limits = followLimits) {
  // Independent reader instances model separate authorized Host polls over the same PG state.
  const sessions = new NativeSessionRead(f.pool), presentation = new NativeAssistantRead(presentationLimits, readLimits)
  let calls = 0
  const call: Parameters<typeof followNativeSession>[0] = async (path, input, signal) => {
    signal.throwIfAborted(); calls++
    if (path === '/native/sessions/open') return sessions.opening(f.alice.user, nativeFollowRequest.parse(input), presentation,
      readLimits.maxOpeningBytes)
    if (path === '/native/sessions/presentationAfter') {
      const parsed = afterRequest.parse(input)
      return sessions.presentationAfter(f.alice.user, parsed.sessionId, parsed.cursor, parsed.position, presentation)
    }
    throw new Error('Unexpected legacy path in opted-in presentation follow')
  }
  const stop = new AbortController()
  return { stream: followNativeSession(call, { address: { kind: 'session', sessionId: id }, assistantStream: true },
    10, stop.signal, limits), stop, calls: () => calls }
}

test('independent followers open the same active prefix and consume original canonical and terminal frame order', () => cloudFixture(async (f) => {
  const n = await admitted(f), attemptId = brandString<LlmAttemptId>('follow:1')
  await n.publisher.append([n.native.append('turn/start', { turn: 1 }), n.native.append('step/start', { turn: 1, step: 1 })])
  n.publisher.frame({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
  const chunk = { type: 'text-delta' as const, index: 0, text: 'native\u0000\ud800' }
  n.publisher.frame({ type: 'chunk', attemptId, revision: 2, index: 0, time: 100, chunk })
  await n.publisher.flush()
  const first = follower(f, n.grant.sessionId), second = follower(f, n.grant.sessionId)
  try {
    const opening = await first.stream.next()
    expect(opening.done).toBe(false)
    expect(opening.value).toMatchObject({ type: 'snapshot', cursor: 1, assistantStream: { revision: 2,
      activeAttempt: { attemptId, startedAfterSeq: 1, nextIndex: 1 } } })
    expect((await second.stream.next()).value).toEqual(opening.value)
    const accumulator = new AssistantStreamAccumulator()
    accumulator.push({ time: 100, chunk })
    const message = n.native.append('assistant/message', { turn: 1, step: 1, stream: [...accumulator.snapshot()],
      message: { id: brandString<MessageId>(randomUUID()), role: 'assistant', content: [{ type: 'text', text: chunk.text }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' } } }, { surfaceOp: 'append' })
    const committed = n.publisher.append([message])
    n.publisher.frame({ type: 'end', attemptId, revision: 3, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: message.seq } })
    const ended = n.publisher.append([n.native.append('step/end', { turn: 1, step: 1 }),
      n.native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })])
    await Promise.all([committed, ended])
    const frames = []
    for (let index = 0; index < 4; index++) frames.push((await first.stream.next()).value)
    expect(frames).toMatchObject([{ type: 'event', event: { seq: 2, type: 'assistant/message' } },
      { type: 'assistant-stream', frame: { type: 'end', revision: 3, outcome: { kind: 'committed', seq: 2 } } },
      { type: 'event', event: { seq: 3, type: 'step/end' } }, { type: 'event', event: { seq: 4, type: 'turn/end' } }])
    const otherFrames = []
    for (let index = 0; index < 4; index++) otherFrames.push((await second.stream.next()).value)
    expect(otherFrames).toEqual(frames)
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1',
      [n.grant.sessionId])).rows).toEqual([{ count: 5 }])
  } finally {
    first.stop.abort(); second.stop.abort()
    await first.stream.return(undefined); await second.stream.return(undefined); await n.publisher.close()
  }
}))

test('exact writer release ends a generation and a new opening contains durable history without a manufactured terminal frame', () => cloudFixture(async (f) => {
  const n = await admitted(f)
  await n.publisher.append([n.native.append('turn/start', { turn: 1 })])
  n.publisher.frame({ type: 'start', attemptId: brandString<LlmAttemptId>('released:1'), revision: 1, turn: 1, step: 1 })
  await n.publisher.flush()
  const running = follower(f, n.grant.sessionId)
  try {
    expect((await running.stream.next()).value).toMatchObject({ assistantStream: { revision: 1, activeAttempt: { nextIndex: 0 } } })
    await n.publisher.close()
    await releaseNativeAssistant(n.tasks, n.grant.token, n.publisher.publisherId)
    expect(await running.stream.next()).toEqual({ done: true, value: undefined })
    const reopened = await new NativeSessionRead(f.pool).opening(f.alice.user,
      { address: { kind: 'session', sessionId: n.grant.sessionId }, assistantStream: true },
      new NativeAssistantRead(presentationLimits, readLimits), readLimits.maxOpeningBytes)
    expect(reopened).toMatchObject({ position: null, snapshot: { cursor: 0, assistantStream: { revision: 0 },
      records: [{ type: 'event', event: { seq: 0, type: 'turn/start' } }] } })
  } finally { running.stop.abort(); await running.stream.return(undefined) }
}))

test('corrupt persisted presentation fails the original follow once instead of retrying its 503 indefinitely', () => cloudFixture(async (f) => {
  const n = await admitted(f)
  n.publisher.frame({ type: 'start', attemptId: brandString<LlmAttemptId>('corrupt:1'), revision: 1, turn: 1, step: 1 })
  await n.publisher.flush()
  const running = follower(f, n.grant.sessionId)
  try {
    await running.stream.next()
    await f.pool.query('UPDATE pe_native_presentations SET state_json=$2 WHERE session_id=$1', [n.grant.sessionId, '{'])
    await expect(running.stream.next()).rejects.toMatchObject({ status: 503, code: 'native_assistant_cache_invalid' })
    expect(running.calls()).toBe(2)
  } finally { running.stop.abort(); await running.stream.return(undefined); await n.publisher.close() }
}))

test('a generation item limit retires normally while a fresh opening keeps the complete committed history', () => cloudFixture(async (f) => {
  const n = await admitted(f)
  await n.publisher.append([n.native.append('turn/start', { turn: 1 })])
  const running = follower(f, n.grant.sessionId, { ...followLimits, maxGenerationItems: 2 })
  try {
    expect((await running.stream.next()).value).toMatchObject({ type: 'snapshot', cursor: 0 })
    await n.publisher.append([n.native.append('step/start', { turn: 1, step: 1 }), n.native.append('step/end', { turn: 1, step: 1 })])
    expect((await running.stream.next()).value).toMatchObject({ type: 'event', event: { seq: 1 } })
    expect(await running.stream.next()).toEqual({ done: true, value: undefined })
    const reopened = await new NativeSessionRead(f.pool).opening(f.alice.user,
      { address: { kind: 'session', sessionId: n.grant.sessionId }, assistantStream: true },
      new NativeAssistantRead(presentationLimits, readLimits), readLimits.maxOpeningBytes)
    expect(reopened.snapshot.cursor).toBe(2)
    expect(reopened.snapshot.records).toHaveLength(3)
  } finally { running.stop.abort(); await running.stream.return(undefined); await n.publisher.close() }
}))

test('the complete opening budget includes canonical history and still conceals the Session from another owner', () => cloudFixture(async (f) => {
  const n = await admitted(f)
  await n.publisher.append([n.native.append('session/title', { title: 'L'.repeat(700), messageSeqs: [], source: { kind: 'user' } })])
  const sessions = new NativeSessionRead(f.pool), presentation = new NativeAssistantRead(presentationLimits, readLimits)
  const request = { address: { kind: 'session' as const, sessionId: n.grant.sessionId }, assistantStream: true as const }
  await expect(sessions.opening(f.alice.user, request, presentation, 512)).rejects.toMatchObject({ status: 413,
    code: 'native_assistant_opening_budget' })
  await expect(sessions.opening(f.bob.user, request, presentation, readLimits.maxOpeningBytes)).rejects.toMatchObject({ status: 404,
    code: 'session_not_found' })
  expect((await sessions.opening(f.alice.user, request, presentation, readLimits.maxOpeningBytes)).snapshot.cursor).toBe(0)
  await n.publisher.close()
}))

test('a cumulative byte limit retires after opening without losing the next committed event', () => cloudFixture(async (f) => {
  const n = await admitted(f)
  await n.publisher.append([n.native.append('turn/start', { turn: 1 })])
  const sessions = new NativeSessionRead(f.pool), presentation = new NativeAssistantRead(presentationLimits, readLimits)
  const request = { address: { kind: 'session' as const, sessionId: n.grant.sessionId }, assistantStream: true as const }
  const opening = await sessions.opening(f.alice.user, request, presentation, readLimits.maxOpeningBytes)
  const limit = Math.max(1024, nativeAssistantBytes(opening.snapshot) + 10)
  const running = follower(f, n.grant.sessionId, { ...followLimits, maxGenerationBytes: limit })
  try {
    expect((await running.stream.next()).value).toEqual(opening.snapshot)
    const event = n.native.append('session/title', { title: 'L'.repeat(700), messageSeqs: [], source: { kind: 'user' } })
    expect(nativeAssistantBytes({ type: 'event', event })).toBeLessThan(limit)
    expect(nativeAssistantBytes(opening.snapshot) + nativeAssistantBytes({ type: 'event', event })).toBeGreaterThan(limit)
    await n.publisher.append([event])
    expect(await running.stream.next()).toEqual({ done: true, value: undefined })
    const reopened = await sessions.opening(f.alice.user, request, presentation, readLimits.maxOpeningBytes)
    expect(reopened.snapshot.cursor).toBe(1)
    expect(reopened.snapshot.records).toHaveLength(2)
  } finally { running.stop.abort(); await running.stream.return(undefined); await n.publisher.close() }
}))

test('an accepted opening retires normally when the configured generation lifetime expires', () => cloudFixture(async (f) => {
  const n = await admitted(f)
  const running = follower(f, n.grant.sessionId, { ...followLimits, maxGenerationMs: 1000 })
  try {
    expect((await running.stream.next()).value).toMatchObject({ type: 'snapshot', cursor: -1 })
    expect(await running.stream.next()).toEqual({ done: true, value: undefined })
    expect(running.calls()).toBeGreaterThan(1)
  } finally { running.stop.abort(); await running.stream.return(undefined); await n.publisher.close() }
}))

test('opening timeout aborts its in-flight read and reports a failure instead of an empty successful generation', () => cloudFixture(async (f) => {
  const n = await admitted(f)
  const sessions = new NativeSessionRead(f.pool), presentation = new NativeAssistantRead(presentationLimits, readLimits)
  const signals: AbortSignal[] = []
  const call: Parameters<typeof followNativeSession>[0] = async (path, input, signal) => {
    expect(path).toBe('/native/sessions/open')
    signals.push(signal)
    const opening = await sessions.opening(f.alice.user, nativeFollowRequest.parse(input), presentation, readLimits.maxOpeningBytes)
    await timers.setTimeout(10_000, undefined, { signal })
    return opening
  }
  const stop = new AbortController()
  const stream = followNativeSession(call, { address: { kind: 'session', sessionId: n.grant.sessionId }, assistantStream: true },
    10, stop.signal, { ...followLimits, maxGenerationMs: 1000 })
  try {
    await expect(stream.next()).rejects.toMatchObject({ status: 504, code: 'native_follow_opening_timeout' })
    expect(signals).toHaveLength(1)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(stop.signal.aborted).toBe(false)
  } finally { stop.abort(); await stream.return(undefined); await n.publisher.close() }
}))
