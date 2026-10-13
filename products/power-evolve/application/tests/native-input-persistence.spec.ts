/** Silent committed input remains visible to the real Host write handle without duplicate native publication. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { PlatformError, requestId } from '../src/contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import RuntimeScope from '../src/host/scope.ts'
import PlatformPersistence from '../src/host/persistence.ts'
import { nativeAssistantBatch } from '../src/native-assistant-records.ts'
import { NATIVE_RETAINED_ROUTES } from '../src/native-retained-intent-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { releaseNativeAssistant } from '../src/platform/native-assistant-lifecycle.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { retainedTestStore } from './native-retained-intent-fixture.ts'

const limits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('a committed B mirrors into the captured write handle while prior reads wait for their exact prefix', () => cloudFixture(async (f) => {
  const tasks = new TaskStore(f.pool, limits), events = new EventStore(tasks, limits)
  const presentation = { maxBatchItems: 32, maxBatchBytes: 1_048_576,
    maxItemBytes: 1_048_576, maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304,
    ttlMs: 20_000, maxEventBytes: limits.maxEventBytes }
  const store = new NativeAssistantStore(tasks, events, presentation)
  const writers = new NativeSessionWriter(tasks, { leaseMs: limits.leaseMs })
  const inputLimits = { maxEventBytes: limits.maxEventBytes, maxHistoryBytes: limits.maxHistoryBytes,
    maxHistoryEvents: limits.maxHistoryEvents, maxAcceptedAuditBytes: 2_097_152,
    maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
  const frames = new NativeExecutionFrames(tasks, writers, { maxHistoryEvents: limits.maxHistoryEvents,
    maxHistoryBytes: limits.maxHistoryBytes, maxFrameBytes: 2_097_152, maxCohortInputs: inputLimits.maxCohortInputs })
  const verifier: ConstructorParameters<typeof NativeInputLedger>[4] = (client, request) => frames.verifyInTransaction(client, request)
  const ledger = new NativeInputLedger(tasks, writers, events, inputLimits, verifier)
  const config = { input: inputLimits, presentation }
  const bridge = new NativeInputCommit(tasks, ledger, frames, store, writers, config)
  const turn = new NativeTurnContinuationV2(tasks, writers, verifier,
    { ...inputLimits, leaseMs: limits.leaseMs, maxActivePerUser: limits.maxActivePerUser, assistant: presentation }, frames)
  const retained = retainedTestStore({ tasks, writers, publisher: store, ledger, frames, bridge }, config, turn)()
  const workerToken = randomUUID()
  const host = new Context(), pending = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const work = (async () => {
      try {
        const token = bearer(request), input = await readJson(request, 1_048_576)
        switch (request.url) {
          case NATIVE_RETAINED_ROUTES.prepare: sendJson(response, await retained.prepare(token, input)); return
          case NATIVE_RETAINED_ROUTES.execute: sendJson(response, await retained.execute(token, input)); return
          case NATIVE_RETAINED_ROUTES.reconcile:
          case NATIVE_RETAINED_ROUTES.resolve: {
            if (token !== workerToken) throw new PlatformError(401, 'unauthenticated')
            sendJson(response, request.url === NATIVE_RETAINED_ROUTES.reconcile
              ? await retained.reconcile(input) : await retained.resolve(input)); return
          }
          case '/runtime/snapshot': sendJson(response, await events.runtimeSnapshot(token)); return
          case '/runtime/native-assistant': sendJson(response, await store.apply(token, input)); return
          case '/runtime/native-assistant/release': {
            const batch = nativeAssistantBatch.pick({ publisherId: true }).parse(input)
            await releaseNativeAssistant(tasks, token, batch.publisherId)
            sendJson(response, {}); return
          }
          default: throw new Error('Unexpected owned fixture route')
        }
      } catch (error) { sendFailure(response, error) }
    })()
    pending.add(work)
    void work.finally(() => { pending.delete(work) })
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected owned HTTP listener')
    const workerFile = join(f.root, 'input-worker-token')
    await writeFile(workerFile, workerToken, { mode: 0o600 })
    await host.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, workerTokenFile: workerFile,
      timeoutMs: 5000, maxResponseBytes: 8_388_608 })
    await host.plugin(PlatformPersistence)
    let runtime: RuntimeScope | undefined, persistence: PlatformPersistence | undefined
    await host.inject(['powerEvolveRuntime', 'sessionPersistence'], (ctx) => {
      runtime = ctx.powerEvolveRuntime
      if (!(ctx.sessionPersistence instanceof PlatformPersistence)) throw new Error('Expected actual Host persistence')
      persistence = ctx.sessionPersistence
    })
    if (!runtime || !persistence) throw new Error('Owned Host services did not activate')
    const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'A', f.alice.token)
    const grant = await tasks.claim(runtime.workerId)
    if (!grant) throw new Error('Expected original operation')
    runtime.grants.set(grant.sessionId, grant)
    const handle = await persistence.open(grant.sessionId, 'write')
    const header = headerSchema.parse(handle.header), live = Session.create(header.id, undefined, header)
    const start = live.append('turn/start', { turn: 1 })
    const firstWrite = handle.append([start])
    const prefixRead = handle.read()
    const clone = Session.forPlanning(live.id, [start], header, SessionLogOffset(0))
    const insertion = clone.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [
      createUserMessage({ content: [{ type: 'text', text: 'B' }], source: { kind: 'user' } }),
    ] })
    const capturedRuntime = runtime
    await runtime.publication(grant).commitInput(1, [insertion], false, async (position) => {
      const receipt = await transaction(f.pool, async (client) => {
        await events.appendInTransaction(client, await tasks.authorized(client, grant.token), [insertion])
        return store.commitInputInTransaction(client, grant.token, 1, nativeAssistantBatch.parse({
          version: 1, publisherId: position.publisherId, epoch: position.epoch,
          firstOrdinal: position.firstOrdinal, batchId: randomUUID(), items: [{ type: 'event', event: insertion }],
        }))
      })
      capturedRuntime.synchronizeCommitted(grant, 1, [insertion])
      live.synchronizeCommitted([insertion])
      return { receipt, value: undefined }
    })
    await firstWrite
    expect((await prefixRead).events).toEqual([start])
    expect((await handle.read()).events).toEqual([start, insertion])
    expect(() =>{  capturedRuntime.synchronizeCommitted(grant, 1, [insertion]) }).toThrow('native_persistence_input_prefix')
    const end = live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => { capturedRuntime.synchronizeCommitted(grant, 2, [end, insertion]) })
      .toThrow('native_persistence_input_suffix')
    expect((await handle.read()).events).toEqual([start, insertion])
    await handle.append([end])
    expect((await handle.read()).events).toEqual([start, insertion, end])
    expect(z.object({ events: z.array(z.json()) }).parse(await events.runtimeSnapshot(grant.token)).events).toEqual([start, insertion, end])
    expect((await f.pool.query<{ family: string; state: string; receipt_saved: boolean }>(
      `SELECT family,state,receipt_json IS NOT NULL AS receipt_saved FROM pe_native_retained_intents
        WHERE session_id=$1 AND operation_id=$2 AND operation_epoch=$3`,
      [grant.sessionId, grant.operationId, grant.epoch])).rows)
      .toEqual([{ family: 'publication', state: 'committed', receipt_saved: true },
        { family: 'publication', state: 'committed', receipt_saved: true }])
    await handle.close()
    expect(() =>{  capturedRuntime.synchronizeCommitted(grant, 3, []) }).toThrow('native_publication_missing')
  } finally {
    await host.fiber.dispose()
    await Promise.all(pending)
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  }
}))
