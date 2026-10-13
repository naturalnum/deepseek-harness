/** Ordered Host publication and bounded transport failure over actual PostgreSQL stores. */
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator, type LlmAttemptId, type MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, test } from 'vitest'
import { PlatformError, requestId } from '../src/contracts.ts'
import { NativeAssistantPublisher, type NativePublicationBudgetDiagnostic, type NativePublicationLimits } from '../src/host/native-assistant-publisher.ts'
import { nativeAssistantBatch, nativeAssistantBytes, nativeAssistantEntry, readNativeAssistantState } from '../src/native-assistant-records.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { releaseNativeAssistant } from '../src/platform/native-assistant-lifecycle.ts'
import { headerSchema } from '../src/session-records.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { transaction } from '../src/platform/database.ts'

const eventLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const limits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000,
  maxEventBytes: eventLimits.maxEventBytes }
const publicationLimits: NativePublicationLimits = { maxQueueItems: 256, maxQueueBytes: 4_194_304,
  maxBatchItems: limits.maxBatchItems, maxBatchBytes: limits.maxBatchBytes, maxItemBytes: limits.maxItemBytes }
type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]

test('byte pressure waits below the item watermark and retains the original single-item and complete-wire guards', async () => {
  await cloudFixture(async (f) => {
    const { grant, store } = await admitted(f)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let holding = false
    const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, async (token, input) => {
      if (holding) { entered.resolve(undefined); await release.promise }
      return store.apply(token, input)
    })
    const attemptId = brandString<LlmAttemptId>('byte-pressure:1')
    publisher.frame({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
    await publisher.flush()
    holding = true
    for (let index = 0; index < 4; index++) publisher.frame({ type: 'chunk', attemptId, revision: index + 2,
      index, time: 100 + index, chunk: { type: 'text-delta', index: 0, text: '界'.repeat(270_000) } })
    await entered.promise
    let resumed = false
    const waiting = publisher.backpressure().then(() => { resumed = true })
    try {
      await setImmediate()
      expect(resumed).toBe(false) // Four valid frames reach the byte watermark before the item watermark32.
      release.resolve(undefined); holding = false
      await waiting
      await publisher.backpressure(undefined, true)
      const state = readNativeAssistantState((await f.pool.query<{ state_json: string }>(
        'SELECT state_json FROM pe_native_presentations WHERE session_id=$1', [grant.sessionId])).rows[0]?.state_json, limits)
      expect(state).toMatchObject({ lastOrdinal: 5, revision: 5 })
    } finally { release.resolve(undefined); await waiting; await publisher.close() }
  })
  for (const oversized of ['item', 'wire', 'queue_bytes'] as const) await cloudFixture(async (f) => {
    const { grant, store } = await admitted(f)
    let calls = 0
    const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, (token, input) => {
      calls++; return store.apply(token, input)
    })
    const diagnostics: NativePublicationBudgetDiagnostic[] = []
    publisher.onFailure((_error, diagnostic) => { if (diagnostic) diagnostics.push(diagnostic) })
    const empty = { type: 'chunk' as const, attemptId: brandString<LlmAttemptId>(`oversized-${oversized}:1`),
      revision: 1, index: 0, time: 100, chunk: { type: 'text-delta' as const, index: 0, text: '' } }
    const textBytes = oversized === 'item' ? publicationLimits.maxItemBytes : oversized === 'queue_bytes' ? 810_000
      : publicationLimits.maxBatchBytes - 1 - nativeAssistantBytes({ type: 'assistant-stream', frame: empty })
    const frame = { ...empty, chunk: { ...empty.chunk, text: 'x'.repeat(textBytes) } }
    if (oversized === 'wire') expect(nativeAssistantBytes({ type: 'assistant-stream', frame })).toBe(publicationLimits.maxBatchBytes - 1)
    expect(() => {
      if (oversized === 'queue_bytes') for (let index = 0; index < 6; index++) publisher.frame({ ...frame, index, revision: index + 1 })
      else publisher.frame(frame)
    }).toThrow('native_publication_budget')
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ site: 'enqueue', reason: oversized === 'item' ? 'item_bytes' : oversized === 'wire' ? 'envelope_bytes' : 'queue_bytes',
      kind: 'chunk', bufferedItems: oversized === 'queue_bytes' ? 5 : 0, queueLength: oversized === 'queue_bytes' ? 5 : 0,
      pumping: oversized === 'queue_bytes', inputReservation: false,
      maxItemBytes: publicationLimits.maxItemBytes, maxQueueItems: publicationLimits.maxQueueItems,
      maxQueueBytes: publicationLimits.maxQueueBytes, maxBatchBytes: publicationLimits.maxBatchBytes })
    expect(Object.hasOwn(diagnostics[0] ?? {}, 'singleWireBytes')).toBe(oversized === 'wire')
    await expect(publisher.backpressure()).rejects.toMatchObject({ code: 'native_publication_budget' })
    await expect(publisher.close()).rejects.toMatchObject({ code: 'native_publication_budget' })
    expect(calls).toBe(0)
  })
})

test('item-tail acknowledgement wakes while a later heartbeat remains in flight', () => cloudFixture(async (f) => {
  const { grant, store } = await admitted(f)
  const itemEntered = Promise.withResolvers<undefined>(), itemRelease = Promise.withResolvers<undefined>()
  const heartbeatEntered = Promise.withResolvers<undefined>(), heartbeatRelease = Promise.withResolvers<undefined>()
  const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, async (token, input) => {
    const batch = nativeAssistantBatch.parse(input)
    const receipt = await store.apply(token, batch)
    if (batch.items.length) { itemEntered.resolve(undefined); await itemRelease.promise }
    else { heartbeatEntered.resolve(undefined); await heartbeatRelease.promise }
    return receipt
  })
  publisher.frame({ type: 'start', attemptId: brandString<LlmAttemptId>('tail-heartbeat:1'), revision: 1, turn: 1, step: 1 })
  await itemEntered.promise
  let tailDone = false, flushed = false
  const tail = publisher.backpressure(undefined, true).then(() => { tailDone = true })
  const flush = publisher.flush().then(() => { flushed = true })
  try {
    publisher.heartbeat()
    await setImmediate()
    expect(tailDone).toBe(false)
    itemRelease.resolve(undefined)
    await heartbeatEntered.promise
    await tail
    expect(tailDone).toBe(true)
    expect(flushed).toBe(false)
    heartbeatRelease.resolve(undefined)
    await flush
  } finally {
    itemRelease.resolve(undefined); heartbeatRelease.resolve(undefined)
    await Promise.all([tail, flush]); await publisher.close()
  }
}))

test('first failure and close wake capacity waiters while owned PG publication still drains', async () => {
  for (const outcome of ['failure', 'close'] as const) await cloudFixture(async (f) => {
    const { grant, store } = await admitted(f)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const publisher = new NativeAssistantPublisher(grant, 0, { ...publicationLimits, maxQueueItems: 1 }, async (token, input) => {
      entered.resolve(undefined); await release.promise
      return store.apply(token, input)
    })
    const attemptId = brandString<LlmAttemptId>(`capacity-${outcome}:1`)
    publisher.frame({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
    await entered.promise
    const waiter = publisher.backpressure().catch((error: unknown) => error)
    let original: unknown, closed = false
    if (outcome === 'failure') {
      const diagnostics: NativePublicationBudgetDiagnostic[] = []
      publisher.onFailure((_error, diagnostic) => { if (diagnostic) diagnostics.push(diagnostic) })
      try { publisher.frame({ type: 'chunk', attemptId, revision: 2, index: 0, time: 100,
        chunk: { type: 'text-delta', index: 0, text: 'over original item limit' } }) }
      catch (error) { original = error }
      expect(await waiter).toBe(original)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({ reason: 'queue_items', bufferedItems: 1, queueLength: 0, pumping: true })
      expect(Object.hasOwn(diagnostics[0] ?? {}, 'singleWireBytes')).toBe(false)
    }
    const closing = publisher.close().catch((error: unknown) => error).then((error: unknown) => { closed = true; return error })
    try {
      if (outcome === 'close') expect(await waiter).toMatchObject({ code: 'native_publication_closed' })
      await setImmediate()
      expect(closed).toBe(false)
      release.resolve(undefined)
      const result = await closing
      if (outcome === 'failure') expect(result).toBe(original)
      else expect(result).toBeUndefined()
    } finally { release.resolve(undefined); await closing }
  })
})

function deferred<T>() {
  let settle: (value: T) => void = () => { throw new Error('Deferred initializer did not run') }
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, resolve: settle }
}

async function admitted(f: Fixture) {
  const tasks = new TaskStore(f.pool, eventLimits), events = new EventStore(tasks, eventLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'publication fixture', f.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Expected the owned publication grant')
  const header = headerSchema.parse((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.header)
  return { tasks, grant, native: Session.create(header.id, undefined, header), store: new NativeAssistantStore(tasks, events, limits) }
}

test('synchronous event and frame observations remain interleaved across bounded real PG batches', () => cloudFixture(async (f) => {
  const { grant, native, store } = await admitted(f)
  let inFlight = 0, peak = 0
  const batches: number[] = []
  const publisher = new NativeAssistantPublisher(grant, 0, { ...publicationLimits, maxBatchItems: 2 }, async (token, input) => {
    inFlight++; peak = Math.max(peak, inFlight)
    try {
      const result = await store.apply(token, input)
      batches.push(result.lastOrdinal)
      return result
    } finally { inFlight-- }
  })
  const records: SessionEvent[] = []
  const append = (event: SessionEvent): Promise<void> => { records.push(event); return publisher.append([event]) }
  const work = [append(native.append('turn/start', { turn: 1 })), append(native.append('step/start', { turn: 1, step: 1 }))]
  const attemptId = brandString<LlmAttemptId>('publisher:1')
  publisher.frame({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
  const text = 'detached\u0000\ud800', raw: StreamChunk = { type: 'text-delta', index: 0, text }
  publisher.frame({ type: 'chunk', attemptId, revision: 2, index: 0, time: 100, chunk: raw })
  const accumulator = new AssistantStreamAccumulator()
  accumulator.push({ time: 100, chunk: raw })
  const message = native.append('assistant/message', { turn: 1, step: 1, stream: [...accumulator.snapshot()],
    message: { id: brandString<MessageId>(randomUUID()), role: 'assistant', content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' } } }, { surfaceOp: 'append' })
  work.push(append(message))
  publisher.frame({ type: 'end', attemptId, revision: 3, index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: message.seq } })
  work.push(append(native.append('step/end', { turn: 1, step: 1 })))
  work.push(append(native.append('turn/end', { turn: 1, reason: { kind: 'completed' } })))
  await Promise.all(work)
  await publisher.close()
  expect(peak).toBe(1)
  expect(batches).toEqual([2, 4, 6, 8])
  const entries = (await f.pool.query<{ item_json: string }>(
    'SELECT item_json FROM pe_native_presentation_entries WHERE session_id=$1 ORDER BY ordinal', [grant.sessionId])).rows
    .map(row => nativeAssistantEntry.parse(JSON.parse(row.item_json)))
  expect(entries.map(value => value.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(entries.map(value => value.item.type === 'event' ? value.item.eventType : value.item.frame.type))
    .toEqual(['turn/start', 'step/start', 'start', 'chunk', 'assistant/message', 'end', 'step/end', 'turn/end'])
  expect((await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
    [grant.sessionId])).rows.map(row => row.event)).toEqual(records)
}))

test('the in-flight item counts toward admission and poison retains the first failure after its actual PG commit', () => cloudFixture(async (f) => {
  const { grant, native, store } = await admitted(f), entered = deferred<undefined>(), release = deferred<undefined>()
  const errors: unknown[] = []
  let calls = 0
  const publisher = new NativeAssistantPublisher(grant, 0, { ...publicationLimits, maxQueueItems: 1 }, async (token, input) => {
    calls++; entered.resolve(undefined); await release.promise
    return store.apply(token, input)
  })
  publisher.onFailure((error) => { errors.push(error) })
  const pending = publisher.append([native.append('turn/start', { turn: 1 })])
  const observed = pending.catch((error: unknown) => error)
  await entered.promise
  let refused: unknown
  try { publisher.frame({ type: 'start', attemptId: brandString<LlmAttemptId>('overflow:1'), revision: 1, turn: 1, step: 1 }) }
  catch (error) { refused = error }
  expect(refused).toMatchObject({ code: 'native_publication_budget' })
  expect(errors).toEqual([refused])
  expect(() => { publisher.heartbeat() }).toThrow('native_publication_budget')
  let closeSettled = false
  const closing = publisher.close().catch((error: unknown) => { closeSettled = true; return error })
  await setImmediate()
  expect(closeSettled).toBe(false)
  release.resolve(undefined)
  expect(await observed).toBe(refused)
  expect(await closing).toBe(refused)
  expect(closeSettled).toBe(true)
  await expect(publisher.flush()).rejects.toBe(refused)
  await expect(publisher.close()).rejects.toBe(refused)
  expect(() => { publisher.heartbeat() }).not.toThrow()
  expect(calls).toBe(1)
  expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1',
    [grant.sessionId])).rows).toEqual([{ count: 1 }])
}))

test('heartbeats preserve the idle prefix, epoch and revision without manufacturing terminal frames', () => cloudFixture(async (f) => {
  const { grant, store } = await admitted(f)
  const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, (token, input) => store.apply(token, input))
  publisher.frame({ type: 'start', attemptId: brandString<LlmAttemptId>('heartbeat:1'), revision: 1, turn: 1, step: 1 })
  publisher.frame({ type: 'chunk', attemptId: brandString<LlmAttemptId>('heartbeat:1'), revision: 2, index: 0,
    time: 100, chunk: { type: 'text-delta', index: 0, text: 'original' } })
  await publisher.flush()
  const before = (await f.pool.query<{ state_json: string }>('SELECT state_json FROM pe_native_presentations WHERE session_id=$1',
    [grant.sessionId])).rows[0]?.state_json
  publisher.heartbeat(); await publisher.flush()
  const after = (await f.pool.query<{ state_json: string }>('SELECT state_json FROM pe_native_presentations WHERE session_id=$1',
    [grant.sessionId])).rows[0]?.state_json
  expect(readNativeAssistantState(after, limits)).toEqual(readNativeAssistantState(before, limits))
  expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_presentation_entries WHERE session_id=$1',
    [grant.sessionId])).rows).toEqual([{ count: 2 }])
  await publisher.close()
}))

test('poisoned frame-only close waits for the actual PG write before releasing its presentation', () => cloudFixture(async (f) => {
  const { tasks, grant, store } = await admitted(f), entered = deferred<undefined>(), release = deferred<undefined>()
  const transportDone = deferred<undefined>()
  const publisher = new NativeAssistantPublisher(grant, 0, { ...publicationLimits, maxQueueItems: 1 }, async (token, input) => {
    entered.resolve(undefined); await release.promise
    try { return await store.apply(token, input) }
    finally { transportDone.resolve(undefined) }
  })
  const attemptId = brandString<LlmAttemptId>('close:1')
  publisher.frame({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
  await entered.promise
  let refused: unknown
  try { publisher.frame({ type: 'chunk', attemptId, revision: 2, index: 0,
    time: 100, chunk: { type: 'text-delta', index: 0, text: 'overflow' } }) }
  catch (error) { refused = error }
  expect(refused).toMatchObject({ code: 'native_publication_budget' })
  let cleaned = false
  let releaseStarted = false
  const cleaning = publisher.close().then(() => { throw new Error('Expected the publication failure') }, async (error: unknown) => {
    expect(error).toBe(refused)
    releaseStarted = true
    await releaseNativeAssistant(tasks, grant.token, publisher.publisherId)
    cleaned = true
  })
  try {
    await setImmediate()
    expect(releaseStarted).toBe(false)
    expect(cleaned).toBe(false)
  } finally {
    release.resolve(undefined)
    await transportDone.promise
    await cleaning
  }
  expect(cleaned).toBe(true)
  expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_presentations WHERE session_id=$1',
    [grant.sessionId])).rows).toEqual([{ count: 0 }])
  expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_presentation_entries WHERE session_id=$1',
    [grant.sessionId])).rows).toEqual([{ count: 0 }])
}))

test('a mismatched receipt fails flush and prevents a later batch even though the first canonical write committed', () => cloudFixture(async (f) => {
  const { grant, native, store } = await admitted(f)
  let calls = 0
  const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, async (token, input) => {
    calls++; return { ...await store.apply(token, input), publisherId: randomUUID() }
  })
  await expect(publisher.append([native.append('turn/start', { turn: 1 })])).rejects.toMatchObject({ code: 'native_publication_receipt' })
  await expect(publisher.flush()).rejects.toMatchObject({ code: 'native_publication_receipt' })
  expect(() => { publisher.frame({ type: 'start', attemptId: brandString<LlmAttemptId>('refused:1'), revision: 1, turn: 1, step: 1 }) })
    .toThrow('native_publication_receipt')
  expect(calls).toBe(1)
}))

test('input commit reserves publication while later model chunks and close wait for the exact PG suffix', () => cloudFixture(async (f) => {
  const { tasks, grant, native, store } = await admitted(f)
  const events = new EventStore(tasks, eventLimits)
  let calls = 0
  const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, (token, input) => {
    calls++
    return store.apply(token, input)
  })
  await publisher.append([native.append('turn/start', { turn: 1 }), native.append('step/start', { turn: 1, step: 1 })])
  const attemptId = brandString<LlmAttemptId>('input-hold:1')
  publisher.frame({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
  await publisher.flush()
  const before = calls
  const insertion = native.append('agent/inbox/spliced', { target: 'next-turn', start: 0,
    inserted: [{ id: brandString<MessageId>(randomUUID()), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'B' }] }] })
  const entered = deferred<undefined>(), commit = deferred<undefined>()
  const writing = publisher.commitInput(2, [insertion], false, async (position) => {
    entered.resolve(undefined)
    await commit.promise
    const receipt = await transaction(f.pool, async (client) => {
      const authorized = await tasks.authorized(client, grant.token)
      await events.appendInTransaction(client, authorized, [insertion])
      return store.commitInputInTransaction(client, grant.token, 2, nativeAssistantBatch.parse({
        version: 1, publisherId: position.publisherId, epoch: position.epoch, firstOrdinal: position.firstOrdinal, batchId: randomUUID(), items: [{ type: 'event', event: insertion }],
      }))
    })
    return { receipt, value: 'committed' }
  })
  try {
    await entered.promise
    publisher.frame({ type: 'chunk', attemptId, revision: 2, index: 0, time: 100,
      chunk: { type: 'text-delta', index: 0, text: 'A continues streaming' } })
    let flushed = false, closed = false
    const flushing = publisher.flush().then(() => { flushed = true })
    const closing = publisher.close().then(() => { closed = true })
    await setImmediate()
    expect(calls).toBe(before)
    expect(flushed).toBe(false)
    expect(closed).toBe(false)
    commit.resolve(undefined)
    expect(await writing).toBe('committed')
    await Promise.all([flushing, closing])
    const state = readNativeAssistantState((await f.pool.query<{ state_json: string }>(
      'SELECT state_json FROM pe_native_presentations WHERE session_id=$1', [grant.sessionId])).rows[0]?.state_json, limits)
    expect(state).toMatchObject({ cursor: 2, lastOrdinal: 5, revision: 2 })
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1 AND seq=2',
      [grant.sessionId])).rows).toEqual([{ count: 1 }])
  } finally { commit.resolve(undefined); await writing; await publisher.close() }
}))

test('one complete staged claim replaces observer publication and keeps both original flushes behind commit', () => cloudFixture(async (f) => {
  const { tasks, grant, native, store } = await admitted(f)
  const events = new EventStore(tasks, eventLimits)
  const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, (token, input) => store.apply(token, input))
  for (const target of ['next-step', 'next-turn'] as const) {
    await publisher.append([native.append('agent/inbox/spliced', { target, start: 0,
      inserted: [{ id: brandString<MessageId>(randomUUID()), role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: target }] }] })])
  }
  const start = publisher.append([native.append('turn/start', { turn: 1 })])
  const removals = ['next-step', 'next-turn'].map(target => native.append('agent/inbox/spliced', {
    target: target === 'next-step' ? 'next-step' : 'next-turn', start: 0, removedCount: 1, inserted: [],
  }))
  const observations = removals.map(event => publisher.append([event]))
  const entered = deferred<undefined>(), commit = deferred<undefined>()
  const writing = publisher.commitInput(3, removals, true, async (position) => {
    entered.resolve(undefined)
    await commit.promise
    return { value: 'whole-claim', receipt: await transaction(f.pool, async (client) => {
      await events.appendInTransaction(client, await tasks.authorized(client, grant.token), removals)
      return store.commitInputInTransaction(client, grant.token, 3, nativeAssistantBatch.parse({
        version: 1, publisherId: position.publisherId, epoch: position.epoch, firstOrdinal: position.firstOrdinal, batchId: randomUUID(), items: removals.map(event => ({ type: 'event', event })),
      }))
    }) }
  })
  try {
    await entered.promise
    let observed = false
    const settled = Promise.all([start, ...observations]).then(() => { observed = true })
    await setImmediate()
    expect(observed).toBe(false)
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1',
      [grant.sessionId])).rows).toEqual([{ count: 3 }])
    commit.resolve(undefined)
    expect(await writing).toBe('whole-claim')
    await settled
    expect(await publisher.seal()).toEqual({ publisherId: publisher.publisherId,
      lastOrdinal: 5, eventCount: 5, revision: 0 })
    await publisher.close()
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1',
      [grant.sessionId])).rows).toEqual([{ count: 5 }])
  } finally { commit.resolve(undefined); await writing; await publisher.close() }
}))

test('wrong canonical suffix rolls back input and presentation together and stops the uncertain publisher', () => cloudFixture(async (f) => {
  const { tasks, grant, native, store } = await admitted(f)
  const events = new EventStore(tasks, eventLimits)
  const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, (token, input) => store.apply(token, input))
  await publisher.append([native.append('turn/start', { turn: 1 })])
  const insertion = native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })
  await expect(publisher.commitInput(1, [insertion], false, async position => ({ value: undefined,
    receipt: await transaction(f.pool, async (client) => {
      await events.appendInTransaction(client, await tasks.authorized(client, grant.token), [insertion])
      return store.commitInputInTransaction(client, grant.token, 1, nativeAssistantBatch.parse({
        version: 1, publisherId: position.publisherId, epoch: position.epoch, firstOrdinal: position.firstOrdinal, batchId: randomUUID(), items: [{ type: 'event', event: { ...insertion, time: insertion.time + 1 } }],
      }))
    }),
  }))).rejects.toMatchObject({ code: 'native_assistant_input_suffix' })
  await expect(publisher.flush()).rejects.toMatchObject({ code: 'native_assistant_input_suffix' })
  await expect(publisher.close()).rejects.toMatchObject({ code: 'native_assistant_input_suffix' })
  expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1',
    [grant.sessionId])).rows).toEqual([{ count: 1 }])
  const state = readNativeAssistantState((await f.pool.query<{ state_json: string }>(
    'SELECT state_json FROM pe_native_presentations WHERE session_id=$1', [grant.sessionId])).rows[0]?.state_json, limits)
  expect(state).toMatchObject({ cursor: 0, lastOrdinal: 1 })
}))

for (const committed of [true, false]) {
  test(`input reservation retains stream poison while its transaction committed=${committed}`, () => cloudFixture(async (f) => {
    const { tasks, grant, native, store } = await admitted(f)
    const events = new EventStore(tasks, eventLimits)
    const publisher = new NativeAssistantPublisher(grant, 0, { ...publicationLimits, maxQueueItems: 1 },
      (token, input) => store.apply(token, input))
    await publisher.append([native.append('turn/start', { turn: 1 })])
    const insertion = native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })
    const entered = deferred<undefined>(), release = deferred<undefined>(), failures: unknown[] = []
    publisher.onFailure((error) => { failures.push(error) })
    const writing = publisher.commitInput(1, [insertion], false, async (position) => {
      entered.resolve(undefined)
      await release.promise
      if (!committed) throw new Error('Later transaction refusal')
      return { value: 'committed', receipt: await transaction(f.pool, async (client) => {
        await events.appendInTransaction(client, await tasks.authorized(client, grant.token), [insertion])
        return store.commitInputInTransaction(client, grant.token, 1, nativeAssistantBatch.parse({
          version: 1, publisherId: position.publisherId, epoch: position.epoch, firstOrdinal: position.firstOrdinal, batchId: randomUUID(), items: [{ type: 'event', event: insertion }],
        }))
      }) }
    })
    const observed = writing.catch((error: unknown) => error)
    await entered.promise
    const frame = { type: 'start' as const, attemptId: brandString<LlmAttemptId>('input-poison:1'),
      revision: 1, turn: 1, step: 1 }
    publisher.frame(frame)
    let poison: unknown
    try { publisher.frame(frame) } catch (error) { poison = error }
    expect(poison).toMatchObject({ code: 'native_publication_budget' })
    expect(failures).toEqual([poison])
    const closing = publisher.close().catch((error: unknown) => error)
    release.resolve(undefined)
    expect(await observed).toBe(poison)
    expect(await closing).toBe(poison)
    await expect(publisher.flush()).rejects.toBe(poison)
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1',
      [grant.sessionId])).rows).toEqual([{ count: committed ? 2 : 1 }])
    const state = readNativeAssistantState((await f.pool.query<{ state_json: string }>(
      'SELECT state_json FROM pe_native_presentations WHERE session_id=$1', [grant.sessionId])).rows[0]?.state_json, limits)
    expect(state).toMatchObject({ cursor: committed ? 1 : 0, lastOrdinal: committed ? 2 : 1 })
  }))
}

test('a frame behind staged claims makes the entire publisher fail before ordinary claim publication', () => cloudFixture(async (f) => {
  const { grant, native, store } = await admitted(f)
  const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, (token, input) => store.apply(token, input))
  for (const target of ['next-step', 'next-turn'] as const) await publisher.append([
    native.append('agent/inbox/spliced', { target, start: 0, inserted: [{
      id: brandString<MessageId>(randomUUID()), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: target }],
    }] }),
  ])
  await publisher.append([native.append('turn/start', { turn: 1 })])
  const removals = (['next-step', 'next-turn'] as const).map(target => native.append('agent/inbox/spliced', {
    target, start: 0, removedCount: 1, inserted: [],
  }))
  const observations = removals.map(event => publisher.append([event]).catch((error: unknown) => error))
  publisher.frame({ type: 'start', attemptId: brandString<LlmAttemptId>('claim-suffix:1'), revision: 1, turn: 1, step: 1 })
  let called = false
  const refused = await publisher.commitInput(3, removals, true, () => {
    called = true
    throw new Error('Incomplete staged claims must not reach the transaction')
  }).catch((error: unknown) => error)
  expect(refused).toMatchObject({ code: 'native_publication_input_suffix' })
  expect(called).toBe(false)
  expect(await Promise.all(observations)).toEqual([refused, refused])
  await expect(publisher.flush()).rejects.toBe(refused)
  await expect(publisher.close()).rejects.toBe(refused)
  expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1',
    [grant.sessionId])).rows).toEqual([{ count: 3 }])
}))

for (const empty of [false, true]) {
  test(`a retained input batch replays after its actual PG commit without new ordinals, empty=${empty}`, () => cloudFixture(async (f) => {
    const { tasks, grant, native, store } = await admitted(f)
    const events = new EventStore(tasks, eventLimits)
    const publisher = new NativeAssistantPublisher(grant, 0, publicationLimits, (token, input) => store.apply(token, input))
    await publisher.append([native.append('turn/start', { turn: 1 })])
    const canonical = empty ? [] : [native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })]
    await publisher.commitInput(1, canonical, false, async (position) => {
      const batch = nativeAssistantBatch.parse({ version: 1, publisherId: position.publisherId, epoch: position.epoch,
        firstOrdinal: position.firstOrdinal, batchId: randomUUID(),
        items: canonical.map(event => ({ type: 'event', event })),
      })
      const receipt = await transaction(f.pool, async (client) => {
        await events.appendInTransaction(client, await tasks.authorized(client, grant.token), canonical)
        return store.commitInputInTransaction(client, grant.token, 1, batch)
      })
      const replayed = await transaction(f.pool, client => store.commitInputInTransaction(client, grant.token, 1, batch))
      expect(replayed).toEqual(receipt)
      await expect(transaction(f.pool, client => store.commitInputInTransaction(client, grant.token, 1,
        { ...batch, firstOrdinal: batch.firstOrdinal + 1 }))).rejects.toMatchObject({ code: 'native_assistant_batch_conflict' })
      return { receipt, value: undefined }
    })
    await publisher.close()
    const retained = await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_presentation_entries WHERE session_id=$1',
      [grant.sessionId])
    expect(retained.rows).toEqual([{ count: empty ? 1 : 2 }])
    expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_events WHERE session_id=$1',
      [grant.sessionId])).rows).toEqual([{ count: empty ? 1 : 2 }])
  }))
}

const inputRefusalCodes = ['native_session_archived', 'native_input_attempt_conflict'] as const

async function inputBoundary(f: Fixture, pendingInput = false,
  beforeApply?: (batch: ReturnType<typeof nativeAssistantBatch.parse>) => Promise<void>) {
  const owned = await admitted(f), { grant, native, store } = owned
  const batches: Array<ReturnType<typeof nativeAssistantBatch.parse>> = []
  const publisher = new NativeAssistantPublisher(grant, 0, { ...publicationLimits, maxBatchItems: 1 }, async (token, input) => {
    const batch = nativeAssistantBatch.parse(input)
    batches.push(batch)
    if (beforeApply) await beforeApply(batch)
    return store.apply(token, input)
  })
  const prefix: SessionEvent[] = []
  if (pendingInput) prefix.push(native.append('agent/inbox/spliced', { target: 'next-step', start: 0,
    inserted: [{ id: brandString<MessageId>(randomUUID()), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'existing pending input' }] }] }))
  prefix.push(native.append('turn/start', { turn: 1 }), native.append('step/start', { turn: 1, step: 1 }))
  await publisher.append(prefix)
  const attemptId = brandString<LlmAttemptId>(`input-boundary:${randomUUID()}`)
  publisher.frame({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })
  await publisher.flush()
  const state = async () => (await f.pool.query<{ state_json: string }>(
    'SELECT state_json FROM pe_native_presentations WHERE session_id=$1', [grant.sessionId])).rows[0]?.state_json
  const entries = async () => (await f.pool.query<{ item_json: string }>(
    'SELECT item_json FROM pe_native_presentation_entries WHERE session_id=$1 ORDER BY ordinal', [grant.sessionId])).rows
    .map(row => nativeAssistantEntry.parse(JSON.parse(row.item_json)))
  return { ...owned, publisher, batches, attemptId, state, entries, before: await publisher.seal() }
}

test('input boundary: unstaged definitive refusal preserves queued frames, ordered events and the original publisher', async () => {
  for (const code of inputRefusalCodes) await cloudFixture(async (f) => {
    let holdDrain = false
    const drainEntered = deferred<undefined>(), releaseDrain = deferred<undefined>()
    const n = await inputBoundary(f, false, async () => {
      if (holdDrain) { drainEntered.resolve(undefined); await releaseDrain.promise }
    })
    const { publisher, native, grant, before, attemptId } = n
    const stateBefore = await n.state(), entriesBefore = await n.entries(), callsBefore = n.batches.length
    const entered = deferred<undefined>(), release = deferred<undefined>(), failures: unknown[] = []
    publisher.onFailure((error) => { failures.push(error) })
    const refusal = new PlatformError(409, code)
    const proposed: SessionEvent = { seq: SessionSeq(before.eventCount), time: Date.now(), type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [] } }
    let commits = 0
    const writing = publisher.commitInput(before.eventCount, [proposed], false, async (position) => {
      commits++
      expect(position).toEqual({ publisherId: before.publisherId, epoch: grant.epoch,
        firstOrdinal: before.lastOrdinal + 1, revision: before.revision })
      entered.resolve(undefined); await release.promise
      throw refusal
    })
    const observed = writing.catch((error: unknown) => error)
    try {
      await entered.promise
      publisher.frame({ type: 'chunk', attemptId, revision: 2, index: 0, time: 100,
        chunk: { type: 'text-delta', index: 0, text: 'the original model still streams' } })
      const event = native.append('session/title', { title: 'existing ordered event', messageSeqs: [], source: { kind: 'user' } })
      const queued = publisher.append([event])
      await setImmediate()
      expect(n.batches).toHaveLength(callsBefore)
      holdDrain = true; release.resolve(undefined)
      expect(await observed).toBe(refusal)
      await drainEntered.promise
      expect(failures).toEqual([])
      expect(() => { publisher.assertOpen() }).not.toThrow()
      expect(await n.state()).toBe(stateBefore)
      expect(await n.entries()).toEqual(entriesBefore)
      let sealed = false
      const sealing = publisher.seal().then((value) => { sealed = true; return value })
      await setImmediate(); expect(sealed).toBe(false)
      holdDrain = false; releaseDrain.resolve(undefined)
      await queued
      expect(await sealing).toEqual({ publisherId: before.publisherId, lastOrdinal: before.lastOrdinal + 2,
        eventCount: before.eventCount + 1, revision: 2 })
      await publisher.flush()
      expect((await n.entries()).map(entry => entry.item.type === 'event' ? entry.item.eventType : entry.item.frame.type))
        .toEqual(['turn/start', 'step/start', 'start', 'chunk', 'session/title'])
      expect((await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
        [grant.sessionId])).rows.map(row => row.event)).toEqual(native.snapshotEvents())
      expect(commits).toBe(1)
      expect(failures).toEqual([])
    } finally {
      release.resolve(undefined); releaseDrain.resolve(undefined)
      await observed; await publisher.close()
    }
  })
})

test('input boundary: a staged claimed suffix stays failed after the same definitive refusal', async () => {
  for (const code of inputRefusalCodes) await cloudFixture(async (f) => {
    const n = await inputBoundary(f, true), { publisher, native, before, attemptId } = n
    const stateBefore = await n.state(), entriesBefore = await n.entries(), callsBefore = n.batches.length
    const removal = native.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
    const queued = publisher.append([removal]).catch((error: unknown) => error)
    const entered = deferred<undefined>(), release = deferred<undefined>(), failures: unknown[] = []
    publisher.onFailure((error) => { failures.push(error) })
    const refusal = new PlatformError(409, code)
    let commits = 0, retries = 0
    const writing = publisher.commitInput(before.eventCount, [removal], true, async () => {
      commits++; entered.resolve(undefined); await release.promise
      throw refusal
    })
    const observed = writing.catch((error: unknown) => error)
    try {
      await entered.promise
      publisher.frame({ type: 'chunk', attemptId, revision: 2, index: 0, time: 100,
        chunk: { type: 'text-delta', index: 0, text: 'queued behind the staged claim' } })
      release.resolve(undefined)
      expect(await observed).toBe(refusal)
      expect(await queued).toBe(refusal)
      expect(failures).toEqual([refusal])
      await expect(publisher.flush()).rejects.toBe(refusal)
      await expect(publisher.seal()).rejects.toBe(refusal)
      await expect(publisher.commitInput(before.eventCount, [], false, async () => {
        retries++; throw new PlatformError(409, code)
      })).rejects.toBe(refusal)
      expect(() => { publisher.heartbeat() }).toThrow(refusal)
      expect(commits).toBe(1); expect(retries).toBe(0)
      expect(n.batches).toHaveLength(callsBefore)
      expect(await n.state()).toBe(stateBefore)
      expect(await n.entries()).toEqual(entriesBefore)
      expect(failures).toEqual([refusal])
    } finally { release.resolve(undefined); await observed; await publisher.close().catch(() => undefined) }
  })
})

test('input boundary: ambiguous network or service failure remains sticky after a real commit and never resends', async () => {
  for (const ambiguous of [new Error('input acknowledgement lost'), new PlatformError(503, 'native_session_archived')]) {
    await cloudFixture(async (f) => {
      const n = await inputBoundary(f), { tasks, grant, publisher, native, store, before, attemptId } = n
      const events = new EventStore(tasks, eventLimits), callsBefore = n.batches.length
      const insertion = native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })
      const entered = deferred<undefined>(), release = deferred<undefined>(), failures: unknown[] = []
      publisher.onFailure((error) => { failures.push(error) })
      let commits = 0, retries = 0
      const writing = publisher.commitInput(before.eventCount, [insertion], false, async (position) => {
        commits++; entered.resolve(undefined); await release.promise
        await transaction(f.pool, async (client) => {
          await events.appendInTransaction(client, await tasks.authorized(client, grant.token), [insertion])
          return store.commitInputInTransaction(client, grant.token, before.eventCount, nativeAssistantBatch.parse({
            version: 1, publisherId: position.publisherId, epoch: position.epoch,
            firstOrdinal: position.firstOrdinal, batchId: randomUUID(), items: [{ type: 'event', event: insertion }],
          }))
        })
        throw ambiguous
      })
      const observed = writing.catch((error: unknown) => error)
      try {
        await entered.promise
        publisher.frame({ type: 'chunk', attemptId, revision: 2, index: 0, time: 100,
          chunk: { type: 'text-delta', index: 0, text: 'must not escape an ambiguous input commit' } })
        release.resolve(undefined)
        expect(await observed).toBe(ambiguous)
        expect(failures).toEqual([ambiguous])
        await expect(publisher.flush()).rejects.toBe(ambiguous)
        await expect(publisher.seal()).rejects.toBe(ambiguous)
        await expect(publisher.commitInput(before.eventCount, [], false, async () => {
          retries++; throw new PlatformError(409, 'native_session_archived')
        })).rejects.toBe(ambiguous)
        expect(commits).toBe(1); expect(retries).toBe(0)
        expect(n.batches).toHaveLength(callsBefore)
        expect(readNativeAssistantState(await n.state(), limits)).toMatchObject({ cursor: before.eventCount,
          lastOrdinal: before.lastOrdinal + 1 })
        expect((await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
          [grant.sessionId])).rows.map(row => row.event)).toEqual(native.snapshotEvents())
        expect(failures).toEqual([ambiguous])
      } finally { release.resolve(undefined); await observed; await publisher.close().catch(() => undefined) }
    })
  }
})
