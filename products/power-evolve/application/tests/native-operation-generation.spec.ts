/** Generation coordination with real publishers; network replies are scripted, and PG publication is checked separately. */
import { randomBytes, randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, test, onTestFinished } from 'vitest'
import { grant as grantSchema, requestId, type Grant } from '../src/contracts.ts'
import { nativeAssistantBatch } from '../src/native-assistant-records.ts'
import { nativeTurnFrame, nativeTurnResponse, nativeTurnTransition,
  type NativeTurnFrame, type NativeTurnResponse, type NativeTurnTransition } from '../src/native-turn-contracts.ts'
import { nativeWriterIdentity } from '../src/native-writer-contracts.ts'
import { NativeOperationPublication, NativeSessionGenerations, type NativeGenerationCommit,
  type NativeGenerationInstaller, type NativeOperationGeneration } from '../src/host/native-operation-generation.ts'
import { HostNativeWriterClient } from '../src/host/native-writer-client.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { headerSchema } from '../src/session-records.ts'
import { cloudFixture } from './cloud-fixture.ts'

const token = () => randomBytes(32).toString('base64url')
const limits = { maxQueueItems: 32, maxQueueBytes: 1_048_576, maxBatchItems: 4,
  maxBatchBytes: 1_048_576, maxItemBytes: 600_000 }

function operation(sessionId: string = randomUUID(), epoch = 1): Grant {
  return grantSchema.parse({ sessionId, operationId: randomUUID(), userId: randomUUID(), requestId: randomUUID(),
    text: 'original input', token: token(), epoch, settings: { model: 'fixture', maxTokens: 100, revision: 1 } })
}

function frame(grant: Grant, phase: 'prepared' | 'claimed' | 'settled' | 'retired' = 'settled'): NativeTurnFrame {
  return nativeTurnFrame.parse({ operationId: grant.operationId, operationEpoch: grant.epoch,
    writerEpoch: 1, requestId: grant.requestId, messageId: randomUUID(), inputRevision: 1, phase,
    ...(phase === 'claimed' || phase === 'settled' ? { claim: { turn: 1, turnStartSeq: 0, claimSeq: 1,
      turnEndSeq: phase === 'settled' ? 2 : null } } : {}),
    ...(phase === 'settled' ? { outcome: 'completed', errorCode: null } : {}),
    ...(phase === 'retired' ? { reason: 'preparation_failed', eventCount: 3, requeued: false } : {}) })
}

function withoutToken(grant: Grant) { const { token: _token, ...saved } = grant; return saved }

function scripted() {
  const a = operation(), workerId = randomUUID(), writer = nativeWriterIdentity.parse({ sessionId: a.sessionId,
    workerId, token: token(), epoch: 1 })
  const published: Array<NativeOperationGeneration | undefined> = []
  const cancelled: NativeOperationGeneration[] = []
  const calls: NativeTurnTransition[] = []
  const writes: Array<{ token: string; input: unknown }> = []
  const maintenance: string[] = []
  const replies = new Map<string, NativeTurnResponse>()
  let failPublish = false, failResource = false
  let customResources: NativeGenerationInstaller['resources'] | undefined
  let transport: (input: NativeTurnTransition) => Promise<unknown> = async input => replies.get(input.transitionId)
  const writerClient = new HostNativeWriterClient({ workerId, assertGrant: () => {},
    call: async (path, bearer) => {
      expect(bearer).toBe(writer.token); maintenance.push(path)
      const { token: _token, ...identity } = writer
      return path.endsWith('/renew') ? { ...identity, expiresAt: 1000 } : { ...identity, released: true }
    } })
  const installer: NativeGenerationInstaller = {
    resources: (grant, count) => {
      if (failResource) throw new Error('resource preparation failed')
      if (customResources) return customResources(grant, count)
      let eventCount = count, revision = 0
      return { flushPersistence: async () => {}, publication: new NativeOperationPublication(grant, count, limits,
        async (bearer, input) => {
          writes.push({ token: bearer, input })
          const batch = nativeAssistantBatch.parse(input)
          for (const item of batch.items) {
            if (item.type === 'event') eventCount = Math.max(eventCount, item.event.seq + 1)
            else revision = item.frame.revision
          }
          return { publisherId: batch.publisherId, epoch: batch.epoch,
            lastOrdinal: batch.firstOrdinal + batch.items.length - 1, eventCount, revision }
        }) }
    },
    publish: (_previous, next) => { if (failPublish) throw new Error('installation failed'); published.push(next) },
    cancel: (expected) => { cancelled.push(expected) },
    transition: async (input) => { calls.push(structuredClone(input)); return transport(input) },
  }
  const owner = new NativeSessionGenerations(writer, writerClient, installer)
  return { a, writer, owner, installer, published, cancelled, calls, writes, maintenance, replies,
    failPublish: (value: boolean) => { failPublish = value }, failResource: (value: boolean) => { failResource = value },
    resources: (value: NativeGenerationInstaller['resources']) => { customResources = value },
    transport: (value: typeof transport) => { transport = value } }
}

async function intent(f: ReturnType<typeof scripted>, current: NativeOperationGeneration,
  kind: 'advance' | 'park' = 'advance'): Promise<NativeTurnTransition> {
  const seal = await current.seal(), b = operation(f.a.sessionId, current.grant.epoch + 1)
  const request = nativeTurnTransition.parse({ writer: f.writer, transitionId: randomUUID(), candidateToken: b.token,
    expectedEventCount: seal.eventCount, expectedQueueRevision: 4,
    expectedNext: kind === 'advance' ? { operationId: b.operationId, messageId: randomUUID(), inputRevision: 1 } : null,
    kind, from: kind === 'advance' ? { kind: 'turn', operationId: current.grant.operationId,
      operationEpoch: current.grant.epoch, operationToken: current.grant.token, turn: 1,
      turnStartSeq: 0, turnEndSeq: 2, claimedMessageIds: [current.frame.messageId] }
      : { kind: 'prepared', operationId: current.grant.operationId, operationEpoch: current.grant.epoch,
        operationToken: current.grant.token },
    ...(kind === 'advance' ? { seal: { publisherId: seal.publisherId, lastOrdinal: seal.lastOrdinal,
      revision: seal.revision } } : { reason: 'preparation_failed' }) })
  return request
}

function response(f: ReturnType<typeof scripted>, request: NativeTurnTransition,
  current: 'prepared' | 'claimed' | 'settled' | 'retired' | 'parked' | 'expired' = 'prepared'): NativeTurnResponse {
  const b = operation(f.a.sessionId, f.a.epoch + 1)
  b.token = request.candidateToken
  const next = request.expectedNext
  if (next) b.operationId = next.operationId
  const state = frame(b, current === 'parked' || current === 'expired' ? 'prepared' : current)
  if (next) state.messageId = next.messageId
  const { phase: _phase, ...preparedIdentity } = frame(b, 'prepared')
  const id = { ...preparedIdentity, messageId: state.messageId }
  const from = request.from.kind === 'parked' ? request.from : (() => {
    const { operationToken: _token, ...source } = request.from; return source
  })()
  return nativeTurnResponse.parse({ receipt: { version: 1, sessionId: f.a.sessionId, writerEpoch: 1,
    transitionId: request.transitionId, eventCount: request.expectedEventCount, queueRevision: request.expectedQueueRevision, from,
    result: current === 'parked' ? { kind: 'parked', reason: request.kind === 'park' ? request.reason : 'empty' }
      : { kind: 'prepared', frame: id, grant: withoutToken(b), expiresAt: 1000 } }, replayed: false,
  current: current === 'parked' || current === 'expired' ? { kind: current } : { kind: 'live', frame: state, grant: b } })
}

function installed(result: NativeGenerationCommit): NativeOperationGeneration {
  expect(result.kind).toBe('installed')
  if (result.kind !== 'installed') throw new Error('Expected installed generation')
  return result.generation
}

test('prepared native records can persist, but execution begins only after an authoritative unchanged claim', async () => {
  const f = scripted(), prepared = frame(f.a, 'prepared'), a = f.owner.installInitial(f.a, prepared, 0)
  expect(() =>{  a.assertExecution() }).toThrow('native_generation_not_executable')
  await expect(a.execute(async () => 'forbidden')).rejects.toThrow('native_generation_not_executable')
  const native = Session.create(SessionId(f.a.sessionId)), event = native.append('turn/start', { turn: 1 })
  await f.owner.writes.append(a, [event])
  const claimed = nativeTurnFrame.parse({ ...prepared, phase: 'claimed', claim: { turn: 1, turnStartSeq: 0, claimSeq: 1, turnEndSeq: null } })
  if (claimed.phase !== 'claimed') throw new Error('Expected claimed fixture')
  a.reconcile(claimed)
  expect(await a.execute(async (signal) => { expect(signal).toBe(a.signal); return 'allowed' })).toBe('allowed')
  expect(await a.maintain(async () => 'renewed')).toBe('renewed')
  expect(a.frame).toEqual(claimed)
  a.reconcile({ ...claimed, claim: { ...claimed.claim, turnEndSeq: 2 } })
  expect(() =>{  a.assertExecution() }).toThrow('native_generation_not_executable')
  await f.owner.close()
})

test('sealing blocks new calls, drains started callbacks and effects, and retains the same writer slot across A to B', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a, 'claimed'), 3), slot = f.owner.writes
  const release = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>(), order: string[] = []
  onTestFinished(() => { release.resolve(undefined) })
  a.own(() => { order.push('effects') })
  const callback = a.execute(async () => { entered.resolve(undefined); await release.promise; order.push('callback'); return 1 })
  const observed = callback.catch((error: unknown) => error)
  await entered.promise
  const seal = a.seal(), same = a.seal()
  expect(same).toBe(seal)
  expect(a.signal.aborted).toBe(true)
  expect(() =>{  a.own(() => {}) }).toThrow('native_generation_sealed')
  await expect(a.maintain(async () => 1)).rejects.toThrow('native_generation_sealed')
  expect(order).toEqual([])
  release.resolve(undefined)
  expect(await observed).toMatchObject({ code: 'native_generation_not_executable' })
  await seal
  expect(order).toEqual(['callback', 'effects'])
  const request = await intent(f, a), reply = response(f, request)
  f.replies.set(request.transitionId, reply)
  const b = installed(await f.owner.commitTransition(a, request))
  expect(f.owner.writes).toBe(slot)
  expect(b.grant.token).toBe(request.candidateToken)
  expect(() =>{  a.assertExecution() }).toThrow('native_generation_lost')
  expect(() => slot.append(a, [])).toThrow('native_generation_write_owner')
  expect(f.owner.cancelIfCurrent(a, new Error('late A timeout'))).toBe(false)
  expect(f.owner.cancelIfCurrent(b, new Error('B timeout'))).toBe(true)
  expect(f.owner.cancelIfCurrent(b, new Error('duplicate timeout'))).toBe(false)
  expect(f.cancelled).toEqual([b])
  await expect(b.maintain(async () => 1)).rejects.toThrow('B timeout')
  await f.owner.close()
})

test('event/frame observations use only B token after explicit replacement and old publication stays sealed', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  f.replies.set(request.transitionId, response(f, request))
  const b = installed(await f.owner.commitTransition(a, request))
  b.reconcile({ ...b.frame, phase: 'claimed', claim: { turn: 2, turnStartSeq: 3, claimSeq: 4, turnEndSeq: null } })
  const native = Session.create(SessionId(f.a.sessionId)), record = native.append('turn/start', { turn: 2 })
  await f.owner.writes.append(b, [record])
  f.owner.writes.frame(b, { type: 'start', revision: 1, attemptId: brandString<LlmAttemptId>('B'), turn: 2, step: 1 })
  await f.owner.writes.flush()
  expect(f.writes.slice(1).every(value => value.token === b.grant.token)).toBe(true)
  expect(() =>{  f.owner.writes.frame(a, { type: 'start', revision: 1,
    attemptId: brandString<LlmAttemptId>('late A'), turn: 1, step: 1 }) }).toThrow('native_generation_write_owner')
  expect(() =>{  a.resources.publication.publisher.assertOpen() }).toThrow('native_publication_closed')
  expect(await b.execute(async () => 2)).toBe(2)
  await f.owner.close()
})

test('lost responses and concurrent retries reuse one intent and never publish B before a receipt', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  f.transport(async () => { entered.resolve(undefined); await release.promise; throw new Error('response lost') })
  const first = f.owner.commitTransition(a, request), retry = f.owner.commitTransition(a, structuredClone(request))
  expect(retry).toBe(first)
  const observed = first.catch((error: unknown) => error)
  await entered.promise
  expect(f.published).toEqual([a]); release.resolve(undefined)
  expect(await observed).toEqual(new Error('response lost'))
  f.transport(async () => ({ ...response(f, request), replayed: true }))
  const result = await f.owner.commitTransition(a, request)
  expect(f.calls).toEqual([request, request])
  expect(await f.owner.commitTransition(a, request)).toBe(result)
  expect(() => f.owner.commitTransition(a, { ...request, candidateToken: token() })).toThrow('native_generation_transition_conflict')
  await f.owner.close()
})

test.each(['claimed'] as const)('replay current %s preserves consumption rather than preparing or reinserting it', async (phase) => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  const reply = response(f, request, phase); f.replies.set(request.transitionId, { ...reply, replayed: true })
  const result = await f.owner.commitTransition(a, request)
  expect(result).toEqual({ kind: 'reconcile', response: { ...reply, replayed: true } })
  expect(f.owner.generation).toBe(a)
  expect(f.published).toEqual([a])
  expect(f.owner.retainedReceipt).toEqual(reply.receipt)
  expect(f.writes).toHaveLength(1)
  await expect(f.owner.close()).rejects.toThrow('native_generation_unreconciled')
  expect(f.maintenance).toEqual([])
  f.replies.set(request.transitionId, response(f, request, 'expired'))
  expect((await f.owner.commitTransition(a, request)).kind).toBe('expired')
  await f.owner.close()
})

test.each(['settled', 'retired'] as const)('a live wire response cannot restore terminal %s authority', async (phase) => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  const reply = response(f, request)
  if (reply.current.kind !== 'live') throw new Error('Expected live response fixture')
  const current = reply.current
  f.transport(async () => ({ ...reply, current: { ...current, frame: frame(current.grant, phase) } }))
  await expect(f.owner.commitTransition(a, request)).rejects.toThrow()
  expect(f.published).toEqual([a])
})

test.each(['resources', 'publish'] as const)('a committed response followed by failed %s installation is re-inspected before retry', async (boundary) => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  f.replies.set(request.transitionId, response(f, request))
  if (boundary === 'resources') f.failResource(true); else f.failPublish(true)
  await expect(f.owner.commitTransition(a, request)).rejects.toThrow()
  expect(f.owner.retainedReceipt?.transitionId).toBe(request.transitionId)
  expect(f.owner.generation).toBe(a)
  await expect(f.owner.close()).rejects.toThrow('native_generation_unreconciled')
  expect(f.maintenance).toEqual([])
  f.failResource(false); f.failPublish(false)
  f.replies.set(request.transitionId, { ...response(f, request, 'expired'), replayed: true })
  expect((await f.owner.commitTransition(a, request)).kind).toBe('expired')
  expect(f.owner.generation).toBeUndefined()
  expect(f.published).toEqual([a, undefined])
  expect(f.owner.retainedReceipt).toBeUndefined()
  await f.owner.close()
})

test('healthy parked retains writer renewal and activates through a new parked transition identity', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  f.replies.set(request.transitionId, response(f, request, 'parked'))
  expect((await f.owner.commitTransition(a, request)).kind).toBe('parked')
  expect(f.owner.generation).toBeUndefined()
  await f.owner.writes.flush()
  await expect(f.owner.renewWriter()).resolves.toMatchObject({ epoch: 1 })
  const activation = nativeTurnTransition.parse({ writer: request.writer, candidateToken: token(),
    expectedEventCount: request.expectedEventCount, expectedQueueRevision: request.expectedQueueRevision, expectedNext: request.expectedNext, kind: 'activate',
    from: { kind: 'parked', transitionId: request.transitionId }, transitionId: randomUUID() })
  f.replies.set(activation.transitionId, response(f, activation))
  const b = installed(await f.owner.commitTransition(undefined, activation))
  expect(b.frame.phase).toBe('prepared')
  expect(f.maintenance).toEqual(['/runtime/native-writer/renew'])
  await f.owner.close()
  expect(f.maintenance).toEqual(['/runtime/native-writer/renew', '/runtime/native-writer/release'])
})

test('unclaimed preparation failure parks without reconstructing its original message', async () => {
  const f = scripted(), prepared = frame(f.a, 'prepared'), a = f.owner.installInitial(f.a, prepared, 0)
  const request = await intent(f, a, 'park'), reply = response(f, request, 'parked')
  if (reply.receipt.result.kind === 'parked') reply.receipt.result.unclaimed = {
    operationId: f.a.operationId, messageId: prepared.messageId, action: 'retain' }
  f.replies.set(request.transitionId, reply)
  expect((await f.owner.commitTransition(a, request)).kind).toBe('parked')
  expect(f.writes).toHaveLength(1)
  await f.owner.close()
})

test.each(['identity', 'rollback', 'terminal', 'retire_claim', 'claim_coordinates', 'end_coordinates'] as const)(
  'native consumption reconciliation rejects %s and retains the original state', async (change) => {
    const f = scripted(), initial = frame(f.a, change === 'terminal' ? 'retired' : 'claimed')
    const a = f.owner.installInitial(f.a, initial, 3)
    let next: unknown = initial
    if (change === 'identity') next = { ...initial, messageId: randomUUID() }
    if (change === 'rollback') next = { ...identityOnly(initial), phase: 'prepared' }
    if (change === 'terminal') next = { ...initial, requeued: true }
    if (change === 'retire_claim') next = { ...identityOnly(initial), phase: 'retired', reason: 'user_cancel', eventCount: 3, requeued: false }
    if (initial.phase === 'claimed' && change === 'claim_coordinates') next = { ...initial, claim: { ...initial.claim, claimSeq: 2 } }
    if (initial.phase === 'claimed' && change === 'end_coordinates') {
      a.reconcile({ ...initial, claim: { ...initial.claim, turnEndSeq: 2 } })
      next = { ...initial, claim: { ...initial.claim, turnEndSeq: 3 } }
    }
    expect(() =>{  a.reconcile(next) }).toThrow('native_generation_consumption')
    await f.owner.close()
  })

function identityOnly(value: NativeTurnFrame) {
  const { operationId, operationEpoch, writerEpoch, requestId, messageId, inputRevision } = value
  return { operationId, operationEpoch, writerEpoch, requestId, messageId, inputRevision }
}

test('settled inspection is stable, and failed effects drain all peers before refusing publication', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a, 'claimed'), 3), before = a.frame
  if (before.phase !== 'claimed') throw new Error('Expected claimed fixture')
  const settled = { ...before, phase: 'settled', claim: { ...before.claim, turnEndSeq: 2 }, outcome: 'failed', errorCode: 'blocked' }
  a.reconcile(settled); a.reconcile(settled)
  const failure = new Error('disposer failed'), peer = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  a.own(async () => { throw failure })
  a.own(async () => { peer.resolve(undefined); await release.promise })
  const observed = a.seal().catch((error: unknown) => error)
  await peer.promise; expect(f.writes).toEqual([]); release.resolve(undefined)
  expect(await observed).toBe(failure)
  await expect(a.seal()).rejects.toBe(failure)
  expect(() =>{  a.reconcile(settled) }).toThrow('native_generation_sealed')
  await expect(f.owner.close()).rejects.toBe(failure)
})

test('publisher transport failure cancels only its exact current generation and retains first failure', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a, 'claimed'), 3)
  expect(() =>{  f.owner.writes.frame(a, { type: 'start', revision: 1, attemptId: brandString<LlmAttemptId>('large'),
    turn: 1, step: 1 }) }).not.toThrow()
  await f.owner.writes.flush()
  const original = new Error('publisher transport failed')
  const g = scripted()
  g.resources(grant => ({ publication: new NativeOperationPublication(grant, 0, limits, async () => { throw original }),
    flushPersistence: async () => {} }))
  const b = g.owner.installInitial(g.a, frame(g.a, 'claimed'), 0)
  b.resources.publication.publisher.heartbeat()
  await expect(g.owner.writes.flush()).rejects.toBe(original)
  expect(g.cancelled).toEqual([b])
  expect(g.owner.cancelIfCurrent(b, original)).toBe(false)
  await expect(g.owner.close()).rejects.toBe(original)
  await f.owner.close()
})

test('closing an in-flight committed transition drains B and releases writer once outside the driver', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  f.transport(async () => { entered.resolve(undefined); await release.promise; return response(f, request) })
  const commit = f.owner.commitTransition(a, request)
  await entered.promise
  const close = f.owner.close()
  expect(f.owner.close()).toBe(close)
  await setImmediate(); expect(f.maintenance).toEqual([])
  release.resolve(undefined); await commit; await close
  expect(f.maintenance).toEqual(['/runtime/native-writer/release'])
  expect(f.owner.cancelIfCurrent(a, new Error('late'))).toBe(false)
  expect(() => f.owner.renewWriter()).toThrow('native_generation_closed')
  expect(() => f.owner.installInitial(f.a, frame(f.a), 0)).toThrow('native_generation_closed')
})

test('a publication closed before an authenticated opening cannot manufacture a seal', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 0)
  await a.resources.publication.publisher.close()
  await expect(a.seal()).rejects.toThrow('native_publication_missing_receipt')
})

test.each(['operation', 'epoch', 'request', 'writer', 'session', 'publisher'] as const)(
  'initial installation refuses a mismatched %s owner before publishing authority', async (mismatch) => {
    const f = scripted(), state = frame(f.a)
    if (mismatch === 'operation') state.operationId = operation().operationId
    if (mismatch === 'epoch') state.operationEpoch++
    if (mismatch === 'request') state.requestId = operation().requestId
    if (mismatch === 'writer') state.writerEpoch++
    if (mismatch === 'session') f.a.sessionId = operation().sessionId
    if (mismatch === 'publisher') f.resources(() => ({ publication: new NativeOperationPublication(operation(), 0, limits,
      async () => { throw new Error('Wrong publication must never open') }), flushPersistence: async () => {} }))
    expect(() => f.owner.installInitial(f.a, state, 0)).toThrow()
    expect(f.published).toHaveLength(0)
    await f.owner.close()
  })

test('a second admission or wrong write-slot owner cannot replace the active generation', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3)
  expect(() => f.owner.installInitial(f.a, frame(f.a), 3)).toThrow('native_generation_already_started')
  expect(() =>{  f.owner.writes.replace(undefined, a) }).toThrow('native_generation_write_owner')
  await f.owner.close()
})

test('pending transition intent conflicts cannot change its retained candidate token', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  f.transport(async () => { throw new Error('uncertain response') })
  await expect(f.owner.commitTransition(a, request)).rejects.toThrow('uncertain response')
  expect(() => f.owner.commitTransition(a, { ...request, candidateToken: token() })).toThrow('native_generation_transition_conflict')
  expect(() => f.owner.commitTransition(undefined, request)).toThrow('native_generation_transition_conflict')
  expect(f.calls).toHaveLength(1)
})

test.each(['stale', 'writer', 'operation', 'epoch', 'token', 'activation'] as const)(
  'transition admission refuses %s ownership before an HTTP call', async (mismatch) => {
    const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
    if (request.kind !== 'advance') throw new Error('Expected advance fixture')
    let next: NativeTurnTransition = request
    if (mismatch === 'writer') next = { ...request, writer: { ...request.writer, epoch: 2 } }
    if (mismatch === 'operation') next = { ...request, from: { ...request.from, operationId: operation().operationId } }
    if (mismatch === 'epoch') next = { ...request, from: { ...request.from, operationEpoch: 2 } }
    if (mismatch === 'token') next = { ...request, from: { ...request.from, operationToken: token() } }
    if (mismatch === 'activation') next = { writer: request.writer, transitionId: request.transitionId, candidateToken: request.candidateToken,
      expectedEventCount: 3, expectedQueueRevision: 4, expectedNext: null, kind: 'activate', from: { kind: 'parked', transitionId: request.transitionId } }
    expect(() => f.owner.commitTransition(mismatch === 'stale' ? undefined : a, next)).toThrow('native_generation_transition_owner')
    expect(f.calls).toHaveLength(0)
    await f.owner.close()
  })

test.each(['prefix', 'publisher', 'ordinal', 'revision'] as const)('seal refuses mismatched %s before sending a transition', async (mismatch) => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  if (request.kind !== 'advance') throw new Error('Expected advance fixture')
  if (mismatch === 'prefix') request.expectedEventCount++
  if (mismatch === 'publisher') request.seal.publisherId = randomUUID()
  if (mismatch === 'ordinal') request.seal.lastOrdinal++
  if (mismatch === 'revision') request.seal.revision++
  await expect(f.owner.commitTransition(a, request)).rejects.toThrow('native_generation_seal')
  expect(f.calls).toHaveLength(0)
})

test.each(['session', 'writer', 'transition', 'prefix', 'queue', 'source', 'token', 'grant', 'frame', 'parked', 'result',
  'unexpected_operation', 'unexpected_message', 'nonmonotone_epoch'] as const)(
  'a wire receipt with inconsistent %s cannot publish its bearer', async (mismatch) => {
    const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
    const reply = response(f, request)
    if (reply.current.kind !== 'live') throw new Error('Expected live fixture')
    const live = reply.current
    if (mismatch === 'session') reply.receipt.sessionId = operation().sessionId
    if (mismatch === 'writer') reply.receipt.writerEpoch++
    if (mismatch === 'transition') reply.receipt.transitionId = nativeTurnTransition.parse({ ...request, transitionId: randomUUID() }).transitionId
    if (mismatch === 'prefix') reply.receipt.eventCount++
    if (mismatch === 'queue') reply.receipt.queueRevision++
    if (mismatch === 'source' && reply.receipt.from.kind === 'turn') reply.receipt.from.turnEndSeq++
    if (mismatch === 'token') reply.current.grant.token = token()
    if (mismatch === 'grant') reply.current.grant.text = 'changed accepted input'
    if (mismatch === 'frame') reply.current.frame.messageId = frame(f.a).messageId
    if (mismatch === 'parked') reply.current = { kind: 'parked' }
    if (mismatch === 'result') reply.receipt.result = { kind: 'parked', reason: 'empty' }
    if (reply.receipt.result.kind === 'prepared') {
      if (mismatch === 'unexpected_operation') {
        const other = operation().operationId
        reply.receipt.result.frame.operationId = other; reply.receipt.result.grant.operationId = other
        live.grant.operationId = other; live.frame.operationId = other
      }
      if (mismatch === 'unexpected_message') {
        const other = frame(f.a).messageId
        reply.receipt.result.frame.messageId = other; live.frame.messageId = other
      }
      if (mismatch === 'nonmonotone_epoch') {
        reply.receipt.result.frame.operationEpoch = f.a.epoch; reply.receipt.result.grant.epoch = f.a.epoch
        live.grant.epoch = f.a.epoch; live.frame.operationEpoch = f.a.epoch
      }
    }
    f.replies.set(request.transitionId, reply)
    await expect(f.owner.commitTransition(a, request)).rejects.toThrow('native_generation_receipt')
    expect(f.published).toEqual([a])
    expect(f.owner.retainedReceipt).toBeUndefined()
  })

test('an unissued wrong seal can be corrected, while an unexpected successor for an empty next cohort is refused', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a), 3), request = await intent(f, a)
  await expect(f.owner.commitTransition(a, { ...request, expectedEventCount: 4 })).rejects.toThrow('native_generation_seal')
  const empty = { ...request, expectedNext: null }, reply = response(f, request)
  f.replies.set(request.transitionId, reply)
  await expect(f.owner.commitTransition(a, empty)).rejects.toThrow('native_generation_receipt')
  expect(f.calls).toEqual([empty])
})

test('publication seal matches actual PG event and presentation counters after the persistence barrier', () => cloudFixture(async (db) => {
  const eventLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
    leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
  const tasks = new TaskStore(db.pool, eventLimits), events = new EventStore(tasks, eventLimits)
  const created = await tasks.create(db.alice.user, requestId.parse(randomUUID()), db.alice.token)
  await tasks.accept(db.alice.user, created.sessionId, requestId.parse(randomUUID()), 'real publication', db.alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Expected owned PG grant')
  const header = headerSchema.parse((await db.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1',
    [created.sessionId])).rows[0]?.header)
  const store = new NativeAssistantStore(tasks, events, { maxBatchItems: 4, maxBatchBytes: 1_048_576, maxItemBytes: 600_000,
    maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000, maxEventBytes: 524_288 })
  const publication = new NativeOperationPublication(grant, 0, limits, (bearer, input) => store.apply(bearer, input))
  const native = Session.create(header.id, undefined, header)
  await publication.publisher.append([native.append('turn/start', { turn: 1 })])
  const seal = await publication.seal()
  expect(seal).toEqual({ publisherId: publication.publisher.publisherId, lastOrdinal: 1, eventCount: 1, revision: 0 })
  expect((await db.pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1', [created.sessionId])).rows)
    .toEqual([{ event_count: seal.eventCount }])
  expect((await db.pool.query<{ last_ordinal: string }>('SELECT last_ordinal FROM pe_native_presentations WHERE session_id=$1',
    [created.sessionId])).rows).toEqual([{ last_ordinal: String(seal.lastOrdinal) }])
  expect((await db.pool.query('SELECT * FROM pe_events WHERE session_id=$1', [created.sessionId])).rows).toHaveLength(1)
}))

test('model streams retain the captured generation for every value and close normally before sealing', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a, 'claimed'), 3), values: string[] = []
  let cleaned = false
  const source = async function* (signal: AbortSignal) {
    expect(signal).toBe(a.signal)
    try { yield 'first'; await setImmediate(); yield 'second' }
    finally { cleaned = true }
  }
  for await (const value of a.stream(source)) values.push(value)
  expect(values).toEqual(['first', 'second']); expect(cleaned).toBe(true)
  await f.owner.close()
})

test('prepared model streams are refused before the external producer starts', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a, 'prepared'), 0)
  let started = false
  const source = async function* () { started = true; yield 'forbidden' }
  await expect(a.stream(source).next()).rejects.toThrow('native_generation_not_executable')
  expect(started).toBe(false)
  await f.owner.close()
})

test('sealing waits for a pending model chunk, refuses its late yield and waits for upstream cleanup', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a, 'claimed'), 3)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>(), cleaned: string[] = []
  onTestFinished(() => { release.resolve(undefined) })
  const source = async function* () {
    try { entered.resolve(undefined); await release.promise; yield 'late A chunk' }
    finally { cleaned.push('closed') }
  }
  const next = a.stream(source).next().catch((error: unknown) => error)
  await entered.promise
  let sealed = false
  const seal = a.seal().then(() => { sealed = true })
  await setImmediate(); expect(sealed).toBe(false)
  release.resolve(undefined)
  expect(await next).toMatchObject({ code: 'native_generation_not_executable' })
  await seal
  expect(cleaned).toEqual(['closed'])
  expect(sealed).toBe(true)
  await f.owner.close()
})

test('an abandoned model iterator explicitly closes and releases its generation drain reservation', async () => {
  const f = scripted(), a = f.owner.installInitial(f.a, frame(f.a, 'claimed'), 3)
  let cleaned = false, sealed = false
  const source = async function* () { try { yield 'observed'; yield 'unread' } finally { cleaned = true } }
  const stream = a.stream(source)
  expect(await stream.next()).toEqual({ value: 'observed', done: false })
  const seal = a.seal().then(() => { sealed = true })
  await setImmediate(); expect(sealed).toBe(false)
  await stream.return(undefined)
  await seal
  expect(cleaned).toBe(true)
  await f.owner.close()
})
