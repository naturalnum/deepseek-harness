/** Native publication hooks and Scheduler barriers over real PostgreSQL and HTTP module adapters. */
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Pool } from 'pg'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { PlatformError, requestId, type Grant } from '../src/contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import PlatformPersistence from '../src/host/persistence.ts'
import { Scheduler } from '../src/host/scheduler.ts'
import { LegacyMigrationHostImages } from '../src/platform/legacy-migration-v2-host-images.ts'
import RuntimeScope from '../src/host/scope.ts'
import { EventStore } from '../src/platform/events.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { headerSchema } from '../src/session-records.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { nativeAssistantEntry, type NativeAssistantEntry } from '../src/native-assistant-records.ts'
import { releaseNativeAssistant } from '../src/platform/native-assistant-lifecycle.ts'
import { nativeExecutionFrame } from '../src/native-execution-frame-contracts.ts'
import { nativeInputFrameRequest, nativeInputPendingRequest } from '../src/native-input-commit-contracts.ts'
import { nativeInputAdmissionCommand, nativeInputClaimCommand } from '../src/native-input-ledger-contracts.ts'
import { NATIVE_RETAINED_ROUTES } from '../src/native-retained-intent-contracts.ts'
import { nativeWriterIdentity } from '../src/native-writer-contracts.ts'
import { transaction } from '../src/platform/database.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeTurnAdvanceIntentV2 } from '../src/platform/native-turn-advance-intent-v2.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { routeNativeWriter } from '../src/platform/native-writer-routes.ts'
import { retainedTestStore } from './native-retained-intent-fixture.ts'
import { MockAdapter, textResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 1_048_576, maxHistoryEvents: 100,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const poll = { timeout: 10_000, interval: 10 }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
type NativeStores = {
  tasks: TaskStore
  writers: NativeSessionWriter
  frames: NativeExecutionFrames
  ledger: NativeInputLedger
  bridge: NativeInputCommit
  presentation: NativeAssistantStore
}

function observe<T>(work: Promise<T>): Promise<Outcome<T>> {
  return work.then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))
}

/** The transport adapter calls production stores; it does not emulate Platform state or a full profile. */
async function withNativeHost<T>(pool: Pool, root: string, run: (fixture: {
  ctx: Context
  tasks: TaskStore
  events: EventStore
  applicationName: string
  finishes: { outcome: 'completed' | 'failed'; errorCode: string | null }[]
  publicationCuts: NativeAssistantEntry[][]
  native: NativeStores
}) => Promise<T>): Promise<T> {
  const applicationName = `employee5_barrier_${randomUUID()}`
  const workerPool = new Pool({ connectionString: pool.options.connectionString, max: 4, application_name: applicationName })
  const tasks: TaskStore = new TaskStore(workerPool, limits, undefined,
    (client, sessionId, fallback) => frames.selectClaimInTransaction(client, sessionId, fallback))
  const events = new EventStore(tasks, limits)
  const presentationLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576,
    maxItemBytes: 1_048_576, maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304,
    ttlMs: 20_000, maxEventBytes: limits.maxEventBytes }
  const presentation = new NativeAssistantStore(tasks, events, presentationLimits)
  const writers = new NativeSessionWriter(tasks, { leaseMs: limits.leaseMs })
  const historyLimits = { maxHistoryBytes: limits.maxHistoryBytes, maxHistoryEvents: limits.maxHistoryEvents }
  const inputLimits = { ...historyLimits, maxEventBytes: limits.maxEventBytes,
    maxAcceptedAuditBytes: 2_097_152, maxRevisionBytes: 262_144,
    maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
  const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  const verifier: ConstructorParameters<typeof NativeInputLedger>[4] = (client, request) => frames.verifyInTransaction(client, request)
  const ledger = new NativeInputLedger(tasks, writers, events, inputLimits, verifier)
  const config = { input: inputLimits, presentation: presentationLimits }
  const bridge = new NativeInputCommit(tasks, ledger, frames, presentation, writers, config)
  const turn = new NativeTurnContinuationV2(tasks, writers, verifier,
    { ...inputLimits, leaseMs: limits.leaseMs, maxActivePerUser: limits.maxActivePerUser, assistant: presentationLimits }, frames)
  const advance = new NativeTurnAdvanceIntentV2(tasks, writers, verifier,
    { ...historyLimits, maxAcceptedAuditBytes: inputLimits.maxAcceptedAuditBytes, maxRevisionBytes: inputLimits.maxRevisionBytes,
      maxCohortInputs: inputLimits.maxCohortInputs, maxCommandBytes: inputLimits.maxCommandBytes, assistant: presentationLimits }, frames)
  const retained = retainedTestStore({ tasks, writers, publisher: presentation, ledger, frames, bridge }, config, turn)()
  const workerToken = randomBytes(32).toString('base64url')
  const tokenFile = join(root, 'employee5-worker-token')
  await writeFile(tokenFile, workerToken, { mode: 0o600, flag: 'wx' })
  const finishes: { outcome: 'completed' | 'failed'; errorCode: string | null }[] = []
  const publicationCuts: NativeAssistantEntry[][] = []
  const pending = new Set<Promise<void>>()
  const server = createServer((req, res) => {
    const processing = (async () => {
      try {
        const token = bearer(req), input = await readJson(req, 1_048_576)
        switch (req.url) {
          case NATIVE_RETAINED_ROUTES.prepare: sendJson(res, await retained.prepare(token, input)); return
          case NATIVE_RETAINED_ROUTES.execute: {
            const result = await retained.execute(token, input)
            if (result.family === 'publication') {
              const rows = await workerPool.query<{ item_json: string }>(`SELECT e.item_json FROM pe_native_presentation_entries e
                JOIN pe_native_presentations p ON p.session_id=e.session_id WHERE p.publisher_id=$1 ORDER BY e.ordinal`,
              [result.result.publisherId])
              publicationCuts.push(rows.rows.map(row => nativeAssistantEntry.parse(JSON.parse(row.item_json))))
            }
            if (result.family === 'turn-transition') {
              finishes.push(...result.result.receipt.settled.map(({ outcome, errorCode }) => ({ outcome, errorCode })))
            }
            sendJson(res, result); return
          }
          case NATIVE_RETAINED_ROUTES.reconcile:
          case NATIVE_RETAINED_ROUTES.resolve: {
            if (token !== workerToken) throw new PlatformError(401, 'unauthorized_worker')
            sendJson(res, req.url === NATIVE_RETAINED_ROUTES.reconcile
              ? await retained.reconcile(input) : await retained.resolve(input)); return
          }
          case '/runtime/claim-archive-stop': {
            if (token !== workerToken) throw new PlatformError(401, 'unauthorized_worker')
            const value = z.object({ workerId: z.uuid() }).strict().parse(input)
            sendJson(res, await tasks.claimArchiveStop(value.workerId)); return
          }
          case '/runtime/native-writer/acquire':
          case '/runtime/native-writer/renew':
          case '/runtime/native-writer/release': sendJson(res, await routeNativeWriter(writers, req.url, token, input)); return
          case '/runtime/native-input/recover-prepared': {
            const value = nativeInputFrameRequest.parse(input)
            sendJson(res, await transaction(workerPool, client =>
              frames.recoverPreparedInTransaction(client, { writer: value.writer, operationToken: token }))); return
          }
          case '/runtime/native-input/recover-consumed': {
            const value = nativeInputFrameRequest.parse(input)
            const result = await transaction(workerPool, client =>
              frames.readConsumedInTransaction(client, { writer: value.writer, operationToken: token }))
            sendJson(res, { version: 1, kind: 'claimed', frame: result.operationFrame, grant: result.storageGrant }); return
          }
          case '/runtime/native-input/pending': {
            const value = nativeInputPendingRequest.parse(input)
            sendJson(res, await transaction(workerPool, client => ledger.readAcceptedPendingInTransaction(client,
              { writer: value.writer, operationToken: token }, value.limit))); return
          }
          case '/runtime/native-input/frame': {
            const value = nativeInputFrameRequest.parse(input)
            const result = await transaction(workerPool, async (client) => {
              const verified = await frames.verifyInTransaction(client,
                { kind: 'read', expected: null, authority: { writer: value.writer, operationToken: token } })
              const row = (await client.query<{ frame: unknown }>(
                'SELECT frame_json AS frame FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
                [verified.operationId, verified.operationEpoch])).rows[0]
              if (!row) throw new Error('Owned actual frame was not stored')
              return nativeExecutionFrame.parse(row.frame)
            })
            sendJson(res, result); return
          }
          case '/runtime/native-turn/prepare': sendJson(res, await advance.prepare(token, input)); return
          case '/runtime/claim': {
            if (token !== workerToken) throw new PlatformError(401, 'unauthorized_worker')
            const value = z.object({ workerId: z.uuid() }).strict().parse(input)
            sendJson(res, await tasks.claim(value.workerId)); return
          }
          case '/runtime/renew': z.object({}).strict().parse(input); sendJson(res, await tasks.renew(token)); return
          case '/runtime/snapshot': z.object({}).strict().parse(input); sendJson(res, await events.runtimeSnapshot(token)); return
          case '/runtime/append': {
            const value = z.object({ events: z.array(z.json()).max(256) }).strict().parse(input)
            sendJson(res, await events.append(token, value.events)); return
          }
          case '/runtime/native-assistant': {
            const receipt = await presentation.apply(token, input)
            const rows = await workerPool.query<{ item_json: string }>(`SELECT e.item_json FROM pe_native_presentation_entries e
              JOIN pe_native_presentations p ON p.session_id=e.session_id WHERE p.publisher_id=$1 ORDER BY e.ordinal`, [receipt.publisherId])
            publicationCuts.push(rows.rows.map(row => nativeAssistantEntry.parse(JSON.parse(row.item_json))))
            sendJson(res, receipt); return
          }
          case '/runtime/native-assistant/release': {
            const value = z.object({ publisherId: z.uuid() }).strict().parse(input)
            sendJson(res, await releaseNativeAssistant(tasks, token, value.publisherId)); return
          }
          case '/runtime/finish': {
            const value = z.object({ outcome: z.enum(['completed', 'failed']), errorCode: z.string().max(80).nullable() }).strict().parse(input)
            finishes.push(value)
            await tasks.finish(token, value.outcome, value.errorCode)
            sendJson(res, { ok: true }); return
          }
          default: throw new PlatformError(404, 'not_found')
        }
      } catch (error) { sendFailure(res, error) }
    })().finally(() => { pending.delete(processing) })
    pending.add(processing)
  })
  const context = new Context()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an owned loopback TCP listener')
    await context.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, workerTokenFile: tokenFile,
      timeoutMs: 20_000, maxResponseBytes: 1_048_576 })
    await context.plugin(LlmRuntime); await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry); await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime); await context.plugin(AgentRegistry)
    await context.plugin(SkillRegistry); await context.plugin(PlatformPersistence)
    await context.plugin(AgentLoop, { agents: [] })
    await context.inject(['powerEvolveRuntime'], (imageCtx) => {
      new LegacyMigrationHostImages(imageCtx, imageCtx.powerEvolveRuntime, { cacheRoot: join(root, 'image-cache'), imageLimits: {
        maxImageBytes: 65536, maxImagePixels: 4096, maxImageDimension: 64, maxImagesPerMessage: 4,
        maxMessageImageBytes: 262144, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      } })
    })
    let ctx = context
    await context.inject(['powerEvolveRuntime', 'sessions', 'sessionPersistence', 'sessionProjections', 'llm', 'agents', 'agentLoop', 'tools', 'attachments'],
      (value) => { ctx = value })
    return await run({ ctx, tasks, events, applicationName, finishes, publicationCuts,
      native: { tasks, writers, frames, ledger, bridge, presentation } })
  } finally {
    try { await context.fiber.dispose() }
    finally {
      await Promise.allSettled(pending)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
        server.closeIdleConnections()
      })
      await workerPool.end()
    }
  }
}

/** Reject deprecated in-memory reads only after native restoration has published the Session. */
function forbidPublishedSnapshot(session: Session): () => string[] {
  const reads: string[] = []
  Object.defineProperty(session, 'snapshotEvents', { configurable: true, value: () => {
    const error = new Error('Published Session must be read through its persistence handle')
    reads.push(error.stack ?? error.message)
    throw error
  } })
  return () => reads
}

async function waitForAppendLock(pool: Pool, applicationName: string, blockerPid: number): Promise<void> {
  await expect.poll(async () => (await pool.query<{ waiting: boolean }>(`SELECT EXISTS(
    SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
      AND $2=ANY(pg_blocking_pids(pid)) AND strpos(query,'FOR UPDATE OF s')>0) AS waiting`,
  [applicationName, blockerPid])).rows[0]?.waiting, poll).toBe(true)
}

async function committedTitles(pool: Pool, id: SessionId): Promise<string[]> {
  return (await pool.query<{ title: string }>(`SELECT event->'data'->>'title' AS title FROM pe_events
    WHERE session_id=$1 AND event->>'type'='session/title' ORDER BY seq`, [id])).rows.map(row => row.title)
}

/** Persist original consumed authority through the actual admission, claim and step providers before Host recovery. */
async function seedConsumedTurn(pool: Pool, native: NativeStores, original: Grant, workerId: string): Promise<void> {
  const acquire = { sessionId: original.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const lease = await native.writers.acquire(original.token, acquire)
  const writer = nativeWriterIdentity.parse({ ...acquire, epoch: lease.epoch })
  const authority = { writer, operationToken: original.token }
  const header = headerSchema.parse((await pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [original.sessionId])).rows[0]?.header)
  const seed = Session.create(header.id, undefined, header), publisherId = randomUUID()
  let ordinal = 1
  const position = () => ({ epoch: original.epoch, publisherId, firstOrdinal: ordinal, batchId: randomUUID() })
  const publish = async (events: SessionEvent[]) => {
    const result = await native.presentation.apply(original.token,
      { version: 1, ...position(), items: events.map(event => ({ type: 'event', event })) })
    ordinal = result.lastOrdinal + 1
    return result
  }
  try {
    await publish([])
    const pending = await transaction(pool, client => native.ledger.readAcceptedPendingInTransaction(client, authority, 1))
    expect(pending.items).toHaveLength(1)
    const item = pending.items[0]
    if (!item) throw new Error('Expected original accepted native input')
    const accepted = await native.bridge.commitAccepted(original.token, { version: 1, writer,
      command: nativeInputAdmissionCommand.parse({ rpcNonce: `accepted:${original.operationId}`,
        sessionId: original.sessionId, originInputId: original.operationId, originOperationId: original.operationId,
        messageId: item.message.id, target: 'next-turn' }), expectedEventCount: seed.seq,
      events: [seed.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [item.message] })],
      presentation: position(), prepareFrame: true })
    if (accepted.kind !== 'admission' || !accepted.frame) throw new Error('Expected actual prepared bootstrap frame')
    ordinal = accepted.presentation.lastOrdinal + 1
    expect((await pool.query<{ phase: string }>(`SELECT frame_json->>'phase' AS phase FROM pe_native_turn_frames
      WHERE operation_id=$1 AND operation_epoch=$2`, [original.operationId, original.epoch])).rows).toEqual([{ phase: 'prepared' }])
    const frame = { sessionId: accepted.frame.sessionId, operationId: accepted.frame.operationId,
      operationEpoch: accepted.frame.operationEpoch, writerEpoch: writer.epoch, frozenSnapshotDigest: accepted.frame.frozenSnapshotDigest }
    const command = nativeInputClaimCommand.parse({ rpcNonce: 'owned-consumed-turn', cohortId: randomUUID(),
      boundaryKind: 'initial-turn-step', frame })
    const expectedEventCount = seed.seq
    const claimed = await native.bridge.commitClaim(original.token, { version: 1, writer, command, expectedEventCount,
      events: [seed.append('turn/start', { turn: 1 }),
        seed.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })],
      presentation: position() })
    ordinal = claimed.presentation.lastOrdinal + 1
    const message = seed.append('user/message', item.message, { surfaceOp: 'append' })
    const start = seed.append('step/start', { turn: 1, step: 1 }), published = await publish([message, start])
    const bound = await native.bridge.bindStep(original.token, { version: 1, writer,
      command: { cohortId: command.cohortId, frame, stepStartSeq: start.seq }, seal: { publisherId,
        lastOrdinal: published.lastOrdinal, revision: published.revision, eventCount: published.eventCount } })
    expect(bound.kind).toBe('step')
    await publish([seed.append('step/end', { turn: 1, step: 1 }), seed.append('turn/end', { turn: 1, reason: { kind: 'completed' } })])
    expect((await pool.query<{ phase: string }>(`SELECT frame_json->>'phase' AS phase FROM pe_native_turn_frames
      WHERE operation_id=$1 AND operation_epoch=$2`, [original.operationId, original.epoch])).rows).toEqual([{ phase: 'claimed' }])
    await releaseNativeAssistant(native.tasks, original.token, publisherId)
  } finally { await native.writers.release(writer) }
}

test('a reader opened under the old actual PG grant refuses a replacement operation before reading its snapshot', () =>
  cloudFixture(async ({ pool, root, alice }) => withNativeHost(pool, root, async ({ ctx, tasks }) => {
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'read under one grant', alice.token)
    const first = await tasks.claim(randomUUID())
    if (!first) throw new Error('Expected the initial reader grant')
    ctx.powerEvolveRuntime.grants.set(created.sessionId, first)
    await using reader = await ctx.sessionPersistence.open(created.sessionId, 'read')
    expect((await reader.read()).events).toEqual([])
    await pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [created.sessionId])
    const replacement = await tasks.claim(randomUUID())
    if (!replacement) throw new Error('Expected the recovered reader grant')
    expect(replacement.operationId).toBe(first.operationId)
    expect(replacement.epoch).toBe(first.epoch + 1)
    ctx.powerEvolveRuntime.grants.set(created.sessionId, replacement)
    await expect(reader.read()).rejects.toMatchObject({ code: 'lease_lost' })
  })))

test('the real Scheduler installs the exact Agent stream listener before driving and commits its ordered terminal frames', () =>
  cloudFixture(async ({ pool, root, alice }) => withNativeHost(pool, root, async ({ ctx, tasks, finishes, publicationCuts }) => {
    const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'stream through native Agent', alice.token)
    const adapter = new MockAdapter([textResponse('actual native stream')])
    ctx.llm.registerAdapter(['power-evolve'], adapter)
    const scheduler = new Scheduler(ctx, { platformOrigin: 'http://owned-module-adapter.invalid', concurrency: 1,
      pollMs: 50, renewMs: 100, operationTimeoutMs: 30_000, nativeInputPollMs: 100, nativeInputBatchSize: 16 })
    scheduler.start()
    try {
      await expect.poll(async () => (await pool.query<{ state: string }>(
        'SELECT state FROM pe_operations WHERE session_id=$1', [created.sessionId])).rows[0]?.state, poll).toBe('completed')
      expect(adapter.requests).toHaveLength(1)
      expect(finishes).toEqual([{ outcome: 'completed', errorCode: null }])
      const entries = publicationCuts.at(-1)
      if (!entries) throw new Error('Expected an actual committed presentation cut before writer release')
      const order = entries.map(entry => entry.item.type === 'event' ? entry.item.eventType : entry.item.frame.type)
      const start = order.indexOf('start'), chunk = order.indexOf('chunk'), committed = order.indexOf('assistant/message')
      expect(start).toBeGreaterThan(order.indexOf('step/start'))
      expect(chunk).toBeGreaterThan(start)
      expect(committed).toBeGreaterThan(chunk)
      expect(order.indexOf('end')).toBeGreaterThan(committed)
      expect(order.indexOf('step/end')).toBeGreaterThan(order.indexOf('end'))
      expect(order.indexOf('turn/end')).toBeGreaterThan(order.indexOf('step/end'))
      expect(entries.filter(entry => entry.item.type === 'assistant-stream' && entry.item.frame.type === 'end'))
        .toMatchObject([{ item: { frame: { outcome: { kind: 'committed', eventType: 'assistant/message' } } } }])
      // Platform commit precedes Host disposal; drain the original Agent before checking teardown.
      await scheduler.close()
      expect(ctx.agents.list()).toHaveLength(0)
      expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_presentations')).rows)
        .toEqual([{ count: 0 }])
      expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_presentation_entries')).rows)
        .toEqual([{ count: 0 }])
    } finally { await scheduler.close() }
  })))

for (const losesGrant of [false, true]) {
  test(`native session/flush ${losesGrant ? 'retains lease loss as a persistence failure' : 'awaits the PostgreSQL append commit'}`, () =>
    cloudFixture(async ({ pool, root, alice }) => withNativeHost(pool, root, async ({ ctx, tasks, applicationName }) => {
      const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
      await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'native barrier input', alice.token)
      const grant = await tasks.claim(ctx.powerEvolveRuntime.workerId)
      if (!grant) throw new Error('Expected an admitted operation')
      ctx.powerEvolveRuntime.grants.set(grant.sessionId, grant)
      const writer = await ctx.sessionPersistence.open(grant.sessionId, 'write')
      const stored = await writer.read()
      const session = ctx.sessions.prepare(grant.sessionId, { seed: [...stored.events], meta: writer.header,
        inheritedEventCount: writer.inheritedEventCount, eventState: stored.eventState })
      // The native factory persists constructor seed events before publication as well.
      await writer.append(session.snapshotEvents().slice(stored.events.length))
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      // Native projections legitimately build their own cells from the restored in-memory log.
      ctx.sessionProjections.snapshot(session)
      const snapshotReads = forbidPublishedSnapshot(session)
      const blocker = await pool.connect()
      let flushing: Promise<Outcome<boolean>> | undefined
      let settled = false
      try {
        const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
        if (pid === undefined) throw new Error('Expected a PostgreSQL blocker backend')
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM pe_sessions WHERE id=$1 FOR SHARE', [grant.sessionId])
        session.append('session/title', { title: 'committed after barrier', messageSeqs: [], source: { kind: 'user' } })
        flushing = observe(ctx.sessions.flush(session)).then((value) => { settled = true; return value })
        await waitForAppendLock(pool, applicationName, pid)
        expect(settled).toBe(false)
        expect(await committedTitles(pool, grant.sessionId)).toEqual([])
        if (losesGrant) {
          await blocker.query('UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL WHERE id=$1', [grant.sessionId])
        }
        await blocker.query('COMMIT')
        const outcome = await flushing
        expect(outcome.ok).toBe(!losesGrant)
        if (outcome.ok) {
          expect(outcome.value).toBe(true)
          expect(await committedTitles(pool, grant.sessionId)).toEqual(['committed after barrier'])
          const reader = await ctx.sessionPersistence.open(grant.sessionId, 'read')
          try { expect((await reader.read()).events.at(-1)?.type).toBe('session/title') }
          finally { await reader.close() }
          await writer.close()
        } else {
          expect(outcome.error).toMatchObject({ status: 409, code: 'lease_lost' })
          await expect(ctx.sessions.flush(session)).rejects.toMatchObject({ status: 409, code: 'lease_lost' })
          await expect(writer.close()).rejects.toMatchObject({ status: 409, code: 'lease_lost' })
          expect(await committedTitles(pool, grant.sessionId)).toEqual([])
        }
        expect(snapshotReads()).toEqual([])
        expect((await pool.query<{ state: string }>('SELECT state FROM pe_operations WHERE id=$1', [grant.operationId])).rows[0]?.state).toBe('running')
      } finally {
        await blocker.query('ROLLBACK'); blocker.release()
        if (flushing) await flushing
        detach()
        await observe(writer.close())
        ctx.powerEvolveRuntime.grants.delete(grant.sessionId)
      }
    })))
}

for (const losesGrant of [false, true]) {
  test(`native Scheduler ${losesGrant ? 'keeps grant loss failed through writer disposal and original settlement' : 'settles a recovered consumed turn only after its published event commits'}`, () =>
    cloudFixture(async ({ pool, root, alice }) => withNativeHost(pool, root, async ({ ctx, tasks, native, applicationName, finishes }) => {
      const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
      const request = requestId.parse(randomUUID())
      await tasks.accept(alice.user, created.sessionId, request, 'already consumed durable input', alice.token)
      const workerId = randomUUID(), original = await tasks.claim(workerId)
      if (!original) throw new Error('Expected an original operation')
      await seedConsumedTurn(pool, native, original, workerId)
      // This is an expired Host fixture; native recovery and the replacement claim remain production code.
      await pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [created.sessionId])
      const blocker = await pool.connect()
      let published = false
      let snapshotReads = (): string[] => ['Session has not been published']
      const off = ctx.on('agent/created', async ({ agent }) => {
        if (agent.session.id !== created.sessionId) throw new Error('Unexpected native Session')
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM pe_sessions WHERE id=$1 FOR SHARE', [created.sessionId])
        ctx.sessionProjections.snapshot(agent.session)
        snapshotReads = forbidPublishedSnapshot(agent.session)
        agent.session.append('session/title', { title: 'scheduler barrier committed', messageSeqs: [], source: { kind: 'user' } })
        published = true
      })
      const scheduler = new Scheduler(ctx, { platformOrigin: 'http://owned-module-adapter.invalid', concurrency: 1,
        pollMs: 20_000, renewMs: 8_000, operationTimeoutMs: 20_000, nativeInputPollMs: 100, nativeInputBatchSize: 16 })
      const failures: unknown[] = []
      ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export(message) {
        if (message.args[0] === 'Operation processing failed (%s)') failures.push(message.args[1])
      } })
      try {
        const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
        if (pid === undefined) throw new Error('Expected a PostgreSQL blocker backend')
        scheduler.start()
        await expect.poll(() => published, poll).toBe(true)
        await waitForAppendLock(pool, applicationName, pid)
        expect(finishes).toEqual([])
        expect(await committedTitles(pool, created.sessionId)).toEqual([])
        expect((await pool.query<{ state: string }>('SELECT state FROM pe_operations WHERE id=$1', [original.operationId])).rows[0]?.state).toBe('running')
        // The original attempt expires under the held Session lock; replacement polling starts after this barrier window.
        if (losesGrant) await blocker.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [created.sessionId])
        await blocker.query('COMMIT')
        await expect.poll(() => losesGrant ? failures.length : finishes.length, poll).toBe(1)
        await scheduler.close()
        expect(failures).toEqual(losesGrant ? ['lease_lost'] : [])
        expect(finishes).toEqual(losesGrant ? [] : [{ outcome: 'completed', errorCode: null }])
        expect(await committedTitles(pool, created.sessionId)).toEqual(losesGrant ? [] : ['scheduler barrier committed'])
        expect(snapshotReads()).toEqual([])
        expect((await pool.query<{ state: string }>('SELECT state FROM pe_operations WHERE id=$1', [original.operationId])).rows[0]?.state)
          .toBe(losesGrant ? 'running' : 'completed')
        expect(ctx.agents.list()).toEqual([])
        expect(ctx.sessions.get(created.sessionId)).toBeUndefined()
        expect(ctx.powerEvolveRuntime.grants.size).toBe(0)
        expect((await pool.query<{ messages: number }>("SELECT count(*)::integer AS messages FROM pe_events WHERE session_id=$1 AND event->>'type'='user/message'", [created.sessionId])).rows[0]?.messages).toBe(1)
        expect((await pool.query<{ epoch: string }>('SELECT lease_epoch::text AS epoch FROM pe_sessions WHERE id=$1', [created.sessionId])).rows[0]?.epoch).toBe('2')
      } finally {
        await blocker.query('ROLLBACK'); blocker.release()
        await scheduler.close()
        off()
      }
    })))
}
