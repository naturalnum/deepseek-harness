/** Actual native Agent input consumer over Host persistence, HTTP and the PG transaction providers. */
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import type { SessionAccess, SessionHandle, SessionPersistenceOpenOptions } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { MockAdapter, textResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { requestId, PlatformError } from '../src/contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import { NativeInputCoordinator } from '../src/host/native-input-coordinator.ts'
import { NativeInputHttp } from '../src/host/native-input-http.ts'
import PlatformPersistence from '../src/host/persistence.ts'
import RuntimeScope from '../src/host/scope.ts'
import { nativeAssistantBatch, nativeAssistantEntry, readNativeAssistantState } from '../src/native-assistant-records.ts'
import { nativeInputClaimCommit, type NativeInputClaimCommit } from '../src/native-input-commit-contracts.ts'
import { nativeInputAdmissionCommand, nativeInputQueueCommand, originInputId, type NativeInputLedgerLimits,
  type InputCommandReceipt } from '../src/native-input-ledger-contracts.ts'
import { nativeInputRecordDigest, readInputReceipt } from '../src/native-input-ledger-records.ts'
import { NATIVE_RETAINED_ROUTES, nativeRetainedExecute, nativeRetainedExecutionResult, nativeRetainedPrepare,
  type NativeRetainedMutation } from '../src/native-retained-intent-contracts.ts'
import { nativeTurnReceiptV2, nativeTurnTransitionV2 } from '../src/native-turn-continuation-v2-contracts.ts'
import { nativeTransitionId } from '../src/native-turn-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema, parseEvents } from '../src/session-records.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { digest } from '../src/platform/identity.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { releaseNativeAssistant } from '../src/platform/native-assistant-lifecycle.ts'
import { NativeExecutionAuthority } from '../src/platform/native-execution-authority.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeTurnAdvanceIntentV2 } from '../src/platform/native-turn-advance-intent-v2.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { retainedTestStore } from './native-retained-intent-fixture.ts'
import { prepareNativeImageOffloadHistory } from './native-image-offload-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 16, maxActivePerUser: 2 }
const historyLimits = { maxHistoryEvents: 1000, maxHistoryBytes: 8_388_608 }
const ledgerLimits: NativeInputLedgerLimits = { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes,
  maxAcceptedAuditBytes: 2_097_152, maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
const presentationLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000, maxEventBytes: taskLimits.maxEventBytes }

function first<T>(values: readonly T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error('Owned native consumer fixture returned no value')
  return value
}

async function schema(f: Fixture): Promise<void> {
  if (Object.keys(process.env).some(key => key.startsWith('PE_NATIVE_') && key.endsWith('_DDL_FILE'))) {
    throw new Error('Formal native consumer tests refuse private DDL overrides')
  }
  const versions = (await f.pool.query<{ family: string; version: number }>('SELECT family,version FROM pe_schema')).rows
  if (versions.length !== 1 || versions[0]?.family !== 'cloud-native' || versions[0].version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Native consumer requires formal cloud-native schema${CURRENT_SCHEMA_VERSION}`)
  }
  const tables = ['pe_native_turn_frames', 'pe_native_input_origins', 'pe_native_input_commands', 'pe_native_input_revisions',
    'pe_native_input_cohorts', 'pe_native_input_claims', 'pe_native_turn_transitions_v2']
  const present = first((await f.pool.query<{ count: number }>(`SELECT count(*)::integer AS count
    FROM unnest($1::text[]) AS expected(name) WHERE to_regclass('public.'||name) IS NOT NULL`, [tables])).rows).count
  if (present !== tables.length) throw new Error('Native consumer requires all seven formal native tables')
}

/** Observe the actual returned write handle without replacing any persistence operation. */
class ObservedPersistence extends PlatformPersistence {
  writeHandle: SessionHandle | undefined
  override async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    const handle = await super.open(id, access, options)
    if (access === 'write') this.writeHandle = handle
    return handle
  }
}

/** Script only the external model; actual PG execution authorization must succeed before entry. */
class AuthorizedModel extends MockAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  readonly complete = Promise.withResolvers<undefined>()
  constructor(private readonly tasks: TaskStore, private readonly operationToken: string) { super([]) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await transaction(this.tasks.pool, client => this.tasks.executionAuthorized(client, this.operationToken))
    this.entered.resolve(undefined)
    const abort = (): void => { this.complete.resolve(undefined) }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.complete.promise
      options.signal?.throwIfAborted()
      yield* textResponse('A model response')
    } finally { options.signal?.removeEventListener('abort', abort) }
  }
}

async function coordinatorCase(imageOffload = false): Promise<void> {
  await cloudFixture(async (f) => {
    await schema(f)
    const tasks = new TaskStore(f.pool, taskLimits), writers = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
    const events = new EventStore(tasks, { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes })
    const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
    const ledger = new NativeInputLedger(tasks, writers, events, ledgerLimits,
      (client, request) => frames.verifyInTransaction(client, request))
    const publisher = new NativeAssistantStore(tasks, events, presentationLimits)
    const bridge = new NativeInputCommit(tasks, ledger, frames, publisher, writers,
      { input: ledgerLimits, presentation: presentationLimits })
    const advanceIntent = new NativeTurnAdvanceIntentV2(tasks, writers,
      (client, request) => frames.verifyInTransaction(client, request),
      { ...historyLimits, maxAcceptedAuditBytes: ledgerLimits.maxAcceptedAuditBytes, maxRevisionBytes: ledgerLimits.maxRevisionBytes,
        maxCohortInputs: ledgerLimits.maxCohortInputs, maxCommandBytes: ledgerLimits.maxCommandBytes, assistant: presentationLimits })
    const continuation = new NativeTurnContinuationV2(tasks, writers,
      (client, request) => frames.verifyInTransaction(client, request),
      { ...ledgerLimits, leaseMs: taskLimits.leaseMs, maxActivePerUser: taskLimits.maxActivePerUser, assistant: presentationLimits })
    const retainedStore = retainedTestStore({ tasks, writers, publisher, ledger, frames, bridge },
      { input: ledgerLimits, presentation: presentationLimits }, continuation)()
    const execution = new NativeExecutionAuthority((client, session, token) => frames.readExecutionInTransaction(client, session, token),
      { ...historyLimits, maxCohortInputs: 128, maxFactBytes: 2_097_152 })
    const businessTasks = new TaskStore(f.pool, taskLimits,
      (client, session, token) => execution.assertExecutionInTransaction(client, session, token))
    const host = new Context(), requests = new Set<Promise<void>>()
    const claims: { request: NativeInputClaimCommit; receipt: InputCommandReceipt }[] = []
    const retainedMutations = new Map<string, NativeRetainedMutation>(), retainedRoutes: string[] = []
    const workerToken = randomBytes(32).toString('base64url')
    let releaseCalls = 0
    const server = createServer((request, response) => {
      const work = (async () => {
        try {
          const token = bearer(request), input = await readJson(request, ledgerLimits.maxCommandBytes)
          switch (request.url) {
            case NATIVE_RETAINED_ROUTES.prepare: {
              const parsed = nativeRetainedPrepare.parse(input), result = await retainedStore.prepare(token, parsed)
              retainedMutations.set(result.intentId, parsed.mutation)
              retainedRoutes.push(request.url)
              sendJson(response, result); return
            }
            case NATIVE_RETAINED_ROUTES.execute: {
              const parsed = nativeRetainedExecute.parse(input), mutation = retainedMutations.get(parsed.intentId)
              if (!mutation) throw new Error('Owned journal observer did not see the original prepare')
              const result = nativeRetainedExecutionResult.parse(await retainedStore.execute(token, parsed))
              if (result.family !== mutation.family) throw new Error('Actual journal returned another mutation family')
              if (mutation.family === 'claim' && result.family === 'claim') {
                if (result.result.kind !== 'claim') throw new Error('Actual journal returned another claim kind')
                claims.push({ request: mutation.request, receipt: result.result.input })
              }
              retainedRoutes.push(request.url)
              sendJson(response, result); return
            }
            case NATIVE_RETAINED_ROUTES.reconcile:
            case NATIVE_RETAINED_ROUTES.resolve: {
              if (token !== workerToken) throw new PlatformError(401, 'unauthorized_worker')
              retainedRoutes.push(request.url)
              sendJson(response, await (request.url === NATIVE_RETAINED_ROUTES.reconcile
                ? retainedStore.reconcile(input) : retainedStore.resolve(input))); return
            }
            case '/runtime/snapshot': sendJson(response, await events.runtimeSnapshot(token)); return
            case '/runtime/native-assistant': sendJson(response, await publisher.apply(token, input)); return
            case '/runtime/native-assistant/release': {
              releaseCalls++
              await releaseNativeAssistant(tasks, token, nativeAssistantBatch.pick({ publisherId: true }).parse(input).publisherId)
              sendJson(response, {}); return
            }
            case '/runtime/native-input/admit': sendJson(response, await bridge.commitAccepted(token, input)); return
            case '/runtime/native-input/claim': {
              const decoded = nativeInputClaimCommit.parse(input), result = await bridge.commitClaim(token, input)
              if (result.kind !== 'claim') throw new Error('Actual bridge returned another result kind')
              claims.push({ request: decoded, receipt: result.input })
              sendJson(response, result); return
            }
            case '/runtime/native-input/step': sendJson(response, await bridge.bindStep(token, input)); return
            case '/runtime/native-input/queue': {
              const value = z.object({ credential: z.string(), request: z.json() }).strict().parse(input)
              sendJson(response, await bridge.commitQueue(value.credential, token, value.request)); return
            }
            case '/native/input/queue-receipt': sendJson(response, await bridge.readQueueReceipt(token, input)); return
            case '/runtime/native-turn/prepare': sendJson(response, await advanceIntent.prepare(token, input)); return
            case '/runtime/native-turn/transition': {
              const value = nativeTurnTransitionV2.parse(input)
              if (value.from.operationToken !== token) throw new PlatformError(401, 'unauthorized')
              sendJson(response, await continuation.transition(value)); return
            }
            default: throw new PlatformError(404, 'unexpected_owned_fixture_route')
          }
        } catch (error) { sendFailure(response, error) }
      })()
      requests.add(work)
      void work.finally(() => { requests.delete(work) })
    })
    let handle: AgentHandle | undefined, model: AuthorizedModel | undefined
    let preserved: Awaited<ReturnType<typeof prepareNativeImageOffloadHistory>> | undefined
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected owned HTTP listener')
      const workerFile = join(f.root, 'native-consumer-worker-token')
      await writeFile(workerFile, workerToken, { mode: 0o600 })
      await host.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, workerTokenFile: workerFile,
        timeoutMs: 5000, maxResponseBytes: historyLimits.maxHistoryBytes })
      await host.plugin(ObservedPersistence)
      for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
        await host.plugin(plugin)
      }
      host.sessions.registerMessageProjection(imageOffloadProjection)
      await host.plugin(AgentLoop, { agents: [] })
      let runtime: RuntimeScope | undefined, persistence: ObservedPersistence | undefined
      await host.inject(['powerEvolveRuntime', 'sessionPersistence'], (ctx) => {
        runtime = ctx.powerEvolveRuntime
        if (!(ctx.sessionPersistence instanceof ObservedPersistence)) throw new Error('Expected actual observed Platform persistence')
        persistence = ctx.sessionPersistence
      })
      if (!runtime || !persistence) throw new Error('Actual Host providers did not activate')
      const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
      await tasks.accept(f.alice.user, created.sessionId, requestId.parse(randomUUID()), 'A original accepted input', f.alice.token)
      const grant = await tasks.claim(runtime.workerId)
      if (!grant) throw new Error('Actual original operation was not claimed')
      runtime.grants.set(grant.sessionId, grant)
      const acquire = { sessionId: grant.sessionId, workerId: nativeWriterWorkerId.parse(runtime.workerId),
        token: randomBytes(32).toString('base64url') }
      const lease = await writers.acquire(grant.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: lease.epoch })
      const authority = { writer, operationToken: grant.token }, actualRuntime = runtime
      if (imageOffload) {
        const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
          'SELECT header FROM pe_sessions WHERE id=$1', [grant.sessionId])).rows).header)
        preserved = await prepareNativeImageOffloadHistory(host, header, join(f.root, 'planner-original-image'))
        expect((await preserved.readOriginal()).data).toEqual(preserved.bytes)
        expect(host.sessions.messageProjections).toContain(imageOffloadProjection)
        const original = preserved
        expect(() => Session.forPlanning(header.id, original.prefix, header, original.session.inheritedEventCount))
          .toThrow('requires a message projection')
        await events.append(grant.token, preserved.prefix)
      }
      model = new AuthorizedModel(businessTasks, grant.token)
      const actualModel = model
      void actualModel.entered.promise.catch((_retainedAgentFailure: unknown) => { /* Awaited model entry reports the native failure. */ })
      host.llm.registerAdapter(['mock'], actualModel)
      const agentErrors: unknown[] = []
      host.on('agent/error', ({ error }) => { agentErrors.push(error); actualModel.entered.reject(error) })
      handle = await host.agents.resume({ resumeSessionId: grant.sessionId, agentOptions: { provider: 'mock', model: 'mock' },
        setup: (agentCtx, agent) => {
          const publication = actualRuntime.publication(grant)
          agentCtx.on('agent/assistant-stream', ({ agent: source, frame }) => { if (source === agent) publication.frame(frame) })
          return { commit: () => { actualRuntime.assertGrant(grant); publication.assertOpen() } }
        } })
      if (!persistence.writeHandle) throw new Error('Actual write handle was not installed')
      const agent = handle.agent, cache = persistence.writeHandle
      const transport = new NativeInputHttp(actualRuntime)
      const loaded = z.object({ header: headerSchema, events: z.array(z.json()), eventCount: z.number().int() })
        .parse(await actualRuntime.call('/runtime/snapshot', grant.token, {}))
      if (preserved) {
        expect(parseEvents(loaded.header, loaded.events).slice(0, preserved.prefix.length)).toEqual(preserved.prefix)
        expect(agent.session.deriveMessages().find(message => message.id === preserved?.message.id)?.content)
          .toEqual([{ type: 'image', attachment: preserved.ref, offloaded: true }])
      }
      const actualCoordinator = new NativeInputCoordinator(agent, actualRuntime, grant, writer,
        parseEvents(loaded.header, loaded.events), transport)
      const admitted = first((await transaction(f.pool, client => ledger.readAcceptedPendingInTransaction(client, authority, 16))).items)
      const command = nativeInputAdmissionCommand.parse({ rpcNonce: `accepted:${admitted.originOperationId}`, sessionId: grant.sessionId,
        originInputId: originInputId.parse(admitted.originOperationId), originOperationId: admitted.originOperationId,
        messageId: admitted.message.id, target: 'next-turn' })
      await actualCoordinator.admit(command, admitted.message, true)
      await actualModel.entered.promise
      expect(actualModel.requests).toHaveLength(1)
      expect(actualModel.requests[0]?.messages.some(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text === 'A original accepted input'))).toBe(true)
      const initial = first(claims)
      expect(initial.request.command.boundaryKind).toBe('initial-turn-step')
      expect(initial.receipt.committedSpliceSeqs).toHaveLength(1)
      expect(initial.receipt.payloadDigest).toBe(nativeInputRecordDigest({ command: initial.request.command,
        batch: { expectedEventCount: initial.request.expectedEventCount, events: initial.request.events },
        operationDigest: digest(grant.token) }))
      const bound = first((await f.pool.query<{ step: number | null; count: number }>(
        'SELECT step_start_seq AS step,claim_count AS count FROM pe_native_input_cohorts WHERE cohort_id=$1',
        [initial.request.command.cohortId])).rows)
      expect(bound.step).not.toBeNull(); expect(bound.count).toBe(1)
      await tasks.accept(f.alice.user, grant.sessionId, requestId.parse(randomUUID()), 'B streaming input', f.alice.token)
      const b = first((await transaction(f.pool, client => ledger.readAcceptedPendingInTransaction(client, authority, 16))).items)
      await actualCoordinator.admit(nativeInputAdmissionCommand.parse({ rpcNonce: `accepted:${b.originOperationId}`, sessionId: grant.sessionId,
        originInputId: originInputId.parse(b.originOperationId), originOperationId: b.originOperationId,
        messageId: b.message.id, target: 'next-turn' }), b.message)
      const edit = nativeInputQueueCommand.parse({ rpcNonce: `edit:${b.originOperationId}`, payload: { sessionId: grant.sessionId,
        itemId: b.message.id, action: { kind: 'edit', content: [{ type: 'text', text: 'B edited during A' }] } } })
      const edited = await actualCoordinator.queue(f.alice.token, edit), afterEdit = agent.session.seq
      expect(await actualCoordinator.queue(f.alice.token, edit)).toEqual(edited)
      expect(agent.session.seq).toBe(afterEdit)
      const remove = nativeInputQueueCommand.parse({ rpcNonce: `remove:${b.originOperationId}`, payload: { sessionId: grant.sessionId,
        itemId: b.message.id, action: { kind: 'remove' } } })
      const removed = await actualCoordinator.queue(f.alice.token, remove), afterRemove = agent.session.seq
      expect(await actualCoordinator.queue(f.alice.token, remove)).toEqual(removed)
      expect(agent.session.seq).toBe(afterRemove)
      expect(agent.inbox.nextTurn).toEqual([])
      actualModel.complete.resolve(undefined)
      await agent.whenIdle(); await host.sessions.flush(agent.session)
      const current = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [grant.sessionId])).rows).header)
      const records = parseEvents(current, (await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
        [grant.sessionId])).rows.map(row => row.event))
      expect(records.map(event => event.seq)).toEqual(records.map((_event, index) => index))
      expect((await cache.read()).events).toEqual(records)
      expect(agent.session.seq).toBe(records.length)
      const start = records.find(event => event.seq >= loaded.eventCount && event.type === 'turn/start')
      expect(start).toBeDefined(); expect(initial.receipt.committedSpliceSeqs).not.toContain(start?.seq)
      expect(records.filter(event => event.type === 'user/message').map(event => event.data.id))
        .toEqual(preserved ? [preserved.message.id, admitted.message.id] : [admitted.message.id])
      if (preserved) {
        expect(records.slice(0, preserved.prefix.length)).toEqual(preserved.prefix)
        expect(agent.session.deriveMessages().find(message => message.id === preserved?.message.id)?.content)
          .toEqual([{ type: 'image', attachment: preserved.ref, offloaded: true }])
        expect((await preserved.readOriginal()).data).toEqual(preserved.bytes)
      }
      expect(actualModel.requests).toHaveLength(1)
      expect(agentErrors).toEqual([])
      expect(retainedRoutes).toContain(NATIVE_RETAINED_ROUTES.prepare)
      expect(retainedRoutes).toContain(NATIVE_RETAINED_ROUTES.execute)
      expect(records.filter(event => event.type === 'assistant/message')).toHaveLength(1)
      expect(records.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
      expect(claims).toHaveLength(1)
      expect(start?.seq).toBe(initial.request.expectedEventCount - 1)
      const canonicalClaim = parseEvents(loaded.header, initial.request.events)
      expect(canonicalClaim.map(event => event.type)).toEqual(['agent/inbox/spliced'])
      expect(initial.receipt.committedSpliceSeqs).toEqual(canonicalClaim.map(event => event.seq))
      const entries = (await f.pool.query<{ item_json: string }>('SELECT item_json FROM pe_native_presentation_entries WHERE session_id=$1 ORDER BY ordinal',
        [grant.sessionId])).rows.map(row => nativeAssistantEntry.parse(JSON.parse(row.item_json)))
      expect(entries.map(entry => entry.ordinal)).toEqual(entries.map((_entry, index) => index + 1))
      expect(entries.filter(entry => entry.item.type === 'event').map(entry => entry.item.type === 'event' ? entry.item.seq : -1))
        .toEqual(records.slice(preserved?.prefix.length ?? 0).map(event => event.seq))
      const presentation = readNativeAssistantState(first((await f.pool.query<{ state: string }>(
        'SELECT state_json AS state FROM pe_native_presentations WHERE session_id=$1', [grant.sessionId])).rows).state, presentationLimits)
      expect(presentation.cursor).toBe(records.length - 1); expect(presentation.lastOrdinal).toBe(entries.length)
      expect(presentation.revision).toBeGreaterThan(0)
      const receipts = (await f.pool.query<{ receipt: unknown }>('SELECT receipt_json AS receipt FROM pe_native_input_commands WHERE session_id=$1',
        [grant.sessionId])).rows.map(row => readInputReceipt(row.receipt))
      expect(receipts).toHaveLength(5)
      expect(receipts.filter(receipt => receipt.kind === 'claim')).toHaveLength(1)
      expect((await f.pool.query('SELECT input_revision FROM pe_native_input_revisions WHERE origin_input_id=$1 ORDER BY input_revision',
        [b.originOperationId])).rows).toEqual([{ input_revision: 1 }, { input_revision: 2 }])
      const permanentClaims = (await f.pool.query<{ origin_input_id: string }>(
        'SELECT origin_input_id FROM pe_native_input_claims WHERE session_id=$1 ORDER BY origin_input_id', [grant.sessionId])).rows
      expect(permanentClaims).toEqual([{ origin_input_id: admitted.originOperationId }])
      const writerBefore = (await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_writers WHERE session_id=$1',
        [grant.sessionId])).rows
      const seal = await actualRuntime.publication(grant).seal()
      const retained = { transitionId: nativeTransitionId.parse(randomUUID()), candidateToken: randomBytes(32).toString('base64url') }
      const intent = await transport.prepareAdvance(grant, writer, seal, retained)
      expect(intent.expectedNext).toBeNull()
      expect(intent.expectedEventCount).toBe(records.length)
      expect(intent.from.cohortIds).toEqual([initial.request.command.cohortId])
      expect(intent.from.claimedOriginInputIds).toEqual([admitted.originOperationId])
      const advanced = await transport.advance(grant, intent)
      expect(advanced.replayed).toBe(false)
      expect(advanced.current).toEqual({ kind: 'parked' })
      expect(advanced.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
      expect(advanced.receipt.settled).toEqual([{ originInputId: admitted.originOperationId, operationId: grant.operationId,
        outcome: 'completed', errorCode: null }])
      await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, grant.token)))
        .rejects.toMatchObject({ code: 'lease_lost' })
      const replay = await transport.advance(grant, intent)
      expect(replay.replayed).toBe(true)
      expect(replay.receipt).toEqual(advanced.receipt)
      expect(replay.current).toEqual(advanced.current)
      const transitions = (await f.pool.query<{ receipt: unknown }>(
        'SELECT receipt_json AS receipt FROM pe_native_turn_transitions_v2 WHERE session_id=$1', [grant.sessionId])).rows
      expect(transitions.map(row => nativeTurnReceiptV2.parse(row.receipt))).toEqual([advanced.receipt])
      expect(first((await f.pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM pe_attempts a JOIN pe_operations o ON o.id=a.operation_id
          WHERE o.session_id=$1`, [grant.sessionId])).rows).count).toBe(1)
      actualRuntime.retirePublication(grant, seal)
      await handle.dispose(); handle = undefined
      await actualRuntime.reconcileNativeIntents()
      expect(retainedRoutes).toContain(NATIVE_RETAINED_ROUTES.reconcile)
      expect(retainedRoutes).toContain(NATIVE_RETAINED_ROUTES.resolve)
      expect(releaseCalls).toBe(0)
      expect((await f.pool.query<Record<string, unknown>>('SELECT * FROM pe_native_writers WHERE session_id=$1',
        [grant.sessionId])).rows).toEqual(writerBefore)
      expect(await transaction(f.pool, client => writers.requireInTransaction(client, writer)))
        .toMatchObject({ sessionId: grant.sessionId, workerId: writer.workerId, epoch: writer.epoch, userId: grant.userId })
      expect(parseEvents(current, (await f.pool.query<{ event: unknown }>(
        'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [grant.sessionId])).rows.map(row => row.event))).toEqual(records)
      expect((await f.pool.query<{ origin_input_id: string }>(
        'SELECT origin_input_id FROM pe_native_input_claims WHERE session_id=$1 ORDER BY origin_input_id', [grant.sessionId])).rows)
        .toEqual(permanentClaims)
      expect(await writers.release(writer)).toMatchObject({ sessionId: grant.sessionId, epoch: writer.epoch, released: true })
    } finally {
      model?.complete.resolve(undefined)
      try {
        try { await handle?.dispose() } finally {
          try { await host.fiber.dispose() } finally { await preserved?.dispose() }
        }
      } finally {
        await Promise.all(requests)
        if (server.listening) await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve() })
        })
      }
    }
  })
}

test('actual Coordinator and HTTP commit A, mirror streaming B edits and removal, then park and retire A after exact v2 replay',
  () => coordinatorCase())

test('actual Coordinator restores preserved image/offload through SessionStore and commits A plus streaming B edits/removal without rewriting its original history',
  () => coordinatorCase(true))
