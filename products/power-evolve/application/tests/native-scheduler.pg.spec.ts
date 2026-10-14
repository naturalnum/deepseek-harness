/** Actual Scheduler generation transfer over official Agents, Host HTTP and isolated PostgreSQL. */
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Context, Logger, type Exporter, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import LlmRuntime, { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { MockAdapter, textResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { PlatformError, requestId, skillSelection, type Grant } from '../src/contracts.ts'
import { digest } from '../src/platform/identity.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import type { NativeInputCoordinator } from '../src/host/native-input-coordinator.ts'
import type { NativePublicationBudgetDiagnostic, NativePublicationSeal } from '../src/host/native-assistant-publisher.ts'
import PlatformPersistence from '../src/host/persistence.ts'
import { Scheduler } from '../src/host/scheduler.ts'
import RuntimeScope from '../src/host/scope.ts'
import { nativeAssistantBatch, nativeAssistantEntry, type NativeAssistantEntry } from '../src/native-assistant-records.ts'
import { type NativeArchiveInputCancelCommit,
  type NativeArchiveInputCancelReceipt } from '../src/native-archive-input-contracts.ts'
import { nativeConsumedInputRecovery, type NativeConsumedInputRecovery } from '../src/native-consumed-input-recovery-contracts.ts'
import { nativeExecutionFrame } from '../src/native-execution-frame-contracts.ts'
import { nativeInputFrameRequest, nativeInputPendingRequest,
  nativeInputPendingResponse, type NativeInputClaimCommit } from '../src/native-input-commit-contracts.ts'
import { nativePreparedInputRecovery, type NativePreparedInputRecovery } from '../src/native-prepared-input-recovery-contracts.ts'
import { type NativePreparedCancelCommit,
  type NativePreparedCancelReceipt } from '../src/native-prepared-cancel-contracts.ts'
import { nativeSessionStopIntent } from '../src/native-session-stop-contracts.ts'
import { acceptedInputAudit, nativeInputQueueCommand, type InputCommandReceipt } from '../src/native-input-ledger-contracts.ts'
import { foldInputHistory, readInputReceipt } from '../src/native-input-ledger-records.ts'
import { nativeTurnReceiptV2, type NativeTurnResponseV2,
  type NativeTurnTransitionV2 } from '../src/native-turn-continuation-v2-contracts.ts'
import { headerSchema, parseEvents } from '../src/session-records.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { LegacyMigrationHostImages } from '../src/platform/legacy-migration-v2-host-images.ts'
import { releaseNativeAssistant } from '../src/platform/native-assistant-lifecycle.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeArchiveInputCancel } from '../src/platform/native-archive-input.ts'
import { NativeExecutionAuthority } from '../src/platform/native-execution-authority.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativePreparedCancel } from '../src/platform/native-prepared-cancel.ts'
import { NativeRetainedIntentStore } from '../src/platform/native-retained-intent-store.ts'
import { NATIVE_RETAINED_ROUTES, nativeRetainedExecute, nativeRetainedExecutionResult, nativeRetainedPrepare,
  type NativeRetainedMutation } from '../src/native-retained-intent-contracts.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeTurnAdvanceIntentV2 } from '../src/platform/native-turn-advance-intent-v2.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { NativeWorkspaceRead } from '../src/platform/native-workspace-read.ts'
import { routeNativeWriter } from '../src/platform/native-writer-routes.ts'
import { readRuntimeSkill } from '../src/platform/runtime-skills.ts'
import { SkillService } from '../src/platform/skills.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { prepareSchedulerArchiveSource } from './native-scheduler-archive-fixture.ts'
import { prepareNativeImageOffloadHistory } from './native-image-offload-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const historyLimits = { maxHistoryEvents: 1000, maxHistoryBytes: 8_388_608 }
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 16, maxActivePerUser: 2,
  archiveStopHistory: historyLimits }
const ledgerLimits = { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes, maxAcceptedAuditBytes: 2_097_152,
  maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
const presentationLimits = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000, maxEventBytes: taskLimits.maxEventBytes }
const poll = { timeout: 10_000, interval: 10 }

function first<T>(values: readonly T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error('Owned native Scheduler fixture returned no value')
  return value
}

async function schema(f: Fixture): Promise<void> {
  if (Object.keys(process.env).some(key => key.startsWith('PE_NATIVE_') && key.endsWith('_DDL_FILE'))) {
    throw new Error('Formal native Scheduler tests refuse private DDL overrides')
  }
  const versions = (await f.pool.query<{ family: string; version: number }>('SELECT family,version FROM pe_schema')).rows
  if (versions.length !== 1 || versions[0]?.family !== 'cloud-native' || versions[0].version !== CURRENT_SCHEMA_VERSION) {
    throw new Error('Native Scheduler requires the current formal cloud-native schema')
  }
  const tables = ['pe_native_turn_frames', 'pe_native_input_origins', 'pe_native_input_commands', 'pe_native_input_revisions',
    'pe_native_input_cohorts', 'pe_native_input_claims', 'pe_native_turn_transitions_v2', 'pe_native_retained_intents']
  const present = first((await f.pool.query<{ count: number }>(`SELECT count(*)::integer AS count
    FROM unnest($1::text[]) AS expected(name) WHERE to_regclass('public.'||name) IS NOT NULL`, [tables])).rows).count
  if (present !== tables.length) throw new Error('Native Scheduler requires all eight formal native and journal tables')
}

/** Record only successful real Router registrations and their original real disposers. */
class ObservedRuntime extends RuntimeScope {
  readonly observedOwners = new Map<SessionId, Grant>()
  readonly ownerEvents: { kind: 'register' | 'release'; operationId: Grant['operationId'] }[] = []
  readonly transitionSignals = new Set<AbortSignal>()
  afterRetire: ((operation: Grant, seal: NativePublicationSeal) => void) | undefined
  override async commitNativeMutation(token: string, mutation: NativeRetainedMutation, signal?: AbortSignal): Promise<unknown> {
    if (mutation.family === 'turn-transition' && signal) this.transitionSignals.add(signal)
    return super.commitNativeMutation(token, mutation, signal)
  }
  override retirePublication(expected: Grant, seal: NativePublicationSeal): void {
    super.retirePublication(expected, seal)
    this.afterRetire?.(expected, seal)
  }
  override registerInputOwner(expected: Grant, coordinator: NativeInputCoordinator): () => void {
    const dispose = super.registerInputOwner(expected, coordinator)
    this.observedOwners.set(expected.sessionId, expected)
    this.ownerEvents.push({ kind: 'register', operationId: expected.operationId })
    return () => {
      dispose()
      if (this.observedOwners.get(expected.sessionId) === expected) {
        this.observedOwners.delete(expected.sessionId)
        this.ownerEvents.push({ kind: 'release', operationId: expected.operationId })
      }
    }
  }
}

const failureLogSentinel = 'owned-model-log-sensitive-sentinel'
const budgetMaxItemBytes = 16_384
const budgetModelText = failureLogSentinel + 'x'.repeat(budgetMaxItemBytes)

/** Only the external model is scripted; each actual generation must pass real PG execution authorization. */
class GenerationModel extends MockAdapter {
  readonly calls: { operation: Grant; agent: Agent }[] = []
  readonly gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  constructor(private readonly ctx: Context, private readonly tasks: TaskStore, private readonly sessionId: SessionId,
    private readonly failFirstModel = false, private readonly nativeBudgetOrigin?: string) { super([]) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.length, gate = this.gates[index]
    this.requests.push(options)
    if (!gate) throw new Error('A Scheduler generation entered the model more than once')
    const operation = this.ctx.powerEvolveRuntime.require(this.sessionId)
    const agents = this.ctx.agents.list().filter(agent => agent.session.id === this.sessionId)
    if (agents.length !== 1) throw new Error('Model entry requires one actual registered Agent')
    await transaction(this.tasks.pool, client => this.tasks.executionAuthorized(client, operation.token))
    this.calls.push({ operation, agent: first(agents) })
    const abort = (): void => { gate.resolve(undefined) }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      await gate.promise
      options.signal?.throwIfAborted()
      if (index === 0 && this.failFirstModel) throw new Error(`Owned external model stream failure ${failureLogSentinel}`)
      if (index === 0 && this.nativeBudgetOrigin) {
        const codec = new DeepSeekAdapter({
          options: () => resolveAdapterOptions({ baseURL: `${this.nativeBudgetOrigin}/model`, thinking: 'disabled', streamIdleTimeoutMs: 5000 }),
          resolveAuth: () => Promise.resolve({ headers: { authorization: `Bearer ${operation.token}` } }),
          resolveUserId: () => brandString<AnonymousUserId>('owned-native-budget-user'),
          prepareExtensions: () => Promise.resolve({ fields: {}, accept: async () => {} }),
        })
        yield* codec.stream(options)
        return
      }
      yield* textResponse(index === 0 ? 'A completed response' : 'B completed response')
    } finally { options.signal?.removeEventListener('abort', abort) }
  }
}

/** Build an independent actual Host so restart recovery obtains a separately issued worker identity. */
async function prepareHost(host: Context, origin: string, workerFile: string, imageCache: string, budgetFirstChunk = false): Promise<{
  ctx: Context
  runtime: ObservedRuntime
}> {
  await host.plugin(ObservedRuntime, { platformUrl: origin, workerTokenFile: workerFile,
    timeoutMs: 5000, maxResponseBytes: historyLimits.maxHistoryBytes,
    ...budgetFirstChunk ? { nativePublicationMaxItemBytes: budgetMaxItemBytes } : {} })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry,
    SkillRegistry, PlatformPersistence]) await host.plugin(plugin)
  host.sessions.registerMessageProjection(imageOffloadProjection)
  await host.plugin(AgentLoop, { agents: [] })
  await host.inject(['powerEvolveRuntime'], (ctx) => {
    new LegacyMigrationHostImages(ctx, ctx.powerEvolveRuntime, { cacheRoot: imageCache, imageLimits: {
      maxImageBytes: 65536, maxImagePixels: 4096, maxImageDimension: 64, maxImagesPerMessage: 4,
      maxMessageImageBytes: 262144, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    } })
  })
  let active: { ctx: Context; runtime: ObservedRuntime } | undefined
  await host.inject(['powerEvolveRuntime', 'sessions', 'sessionPersistence', 'sessionProjections', 'llm', 'agents',
    'agentLoop', 'tools', 'skills', 'attachments'], (ctx) => {
    if (!(ctx.powerEvolveRuntime instanceof ObservedRuntime)) throw new Error('Expected actual observed RuntimeScope')
    active = { ctx, runtime: ctx.powerEvolveRuntime }
  })
  if (!active) throw new Error('Actual Host runtime did not activate')
  return active
}

async function schedulerCase(ownerFirst: boolean, failFirstModel = false, loseStepReply = false,
  recoverPrepared = false, capacityPark = false, loseClaimBeforeCommit = false,
  recoverConsumed: 'none' | 'complete' | 'timeout' | 'prepared-cancel' | 'archive-prepared' | 'archive-claimed'
    | 'archive-parked' | 'archive-warm-pending' | 'archive-warm-admission' = 'none', loggerThrows = false,
  budgetFirstChunk = false, imageOffload = false): Promise<void> {
  const archiveRecovery = recoverConsumed === 'archive-prepared' ? 'prepared' : recoverConsumed === 'archive-claimed' ? 'claimed' : undefined
  const warmArchive = recoverConsumed === 'archive-warm-pending' ? 'pending'
    : recoverConsumed === 'archive-warm-admission' ? 'admission' : undefined
  await cloudFixture(async (f) => {
    await schema(f)
    const tasks: TaskStore = new TaskStore(f.pool, taskLimits, undefined,
      (client, sessionId, fallback) => frames.selectClaimInTransaction(client, sessionId, fallback))
    const writers = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
    const events = new EventStore(tasks, { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes })
    const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
    const ledger = new NativeInputLedger(tasks, writers, events, ledgerLimits,
      (client, request) => frames.verifyInTransaction(client, request))
    const publisher = new NativeAssistantStore(tasks, events, presentationLimits)
    const bridge = new NativeInputCommit(tasks, ledger, frames, publisher, writers,
      { input: ledgerLimits, presentation: presentationLimits })
    const preparedCancel = new NativePreparedCancel(tasks, ledger, frames, publisher, writers,
      { input: ledgerLimits, presentation: presentationLimits })
    const archiveCancel = new NativeArchiveInputCancel(tasks, ledger, frames, publisher, writers,
      { input: ledgerLimits, presentation: presentationLimits })
    const advanceIntent = new NativeTurnAdvanceIntentV2(tasks, writers,
      (client, request) => frames.verifyInTransaction(client, request),
      { ...historyLimits, maxAcceptedAuditBytes: ledgerLimits.maxAcceptedAuditBytes, maxRevisionBytes: ledgerLimits.maxRevisionBytes,
        maxCohortInputs: ledgerLimits.maxCohortInputs, maxCommandBytes: ledgerLimits.maxCommandBytes,
        assistant: presentationLimits }, frames)
    const continuation = new NativeTurnContinuationV2(tasks, writers,
      (client, request) => frames.verifyInTransaction(client, request),
      { ...ledgerLimits, leaseMs: taskLimits.leaseMs,
        maxActivePerUser: capacityPark ? 1 : taskLimits.maxActivePerUser, assistant: presentationLimits }, frames)
    const retained = new NativeRetainedIntentStore(tasks, writers, { publication: publisher, input: bridge,
      preparedCancel, archiveCancel, turn: continuation }, randomBytes(32).toString('base64url'),
    { maxRequestBytes: ledgerLimits.maxCommandBytes, maxPendingPerSession: 64,
      maxRecordsPerSession: 65536, maxRetainedBytesPerSession: 268_435_456 })
    const retainedMutations = new Map<string, NativeRetainedMutation>(), retainedRoutes: string[] = []
    const execution = new NativeExecutionAuthority((client, session, token) => frames.readExecutionInTransaction(client, session, token),
      { ...historyLimits, maxCohortInputs: 128, maxFactBytes: 2_097_152 })
    const businessTasks = new TaskStore(f.pool, taskLimits,
      (client, session, token) => execution.assertExecutionInTransaction(client, session, token))
    const skills = new SkillService(f.pool, join(f.root, 'skills')); await skills.init()
    const host = new Context(), requests = new Set<Promise<void>>()
    const claims: { request: NativeInputClaimCommit; receipt: InputCommandReceipt }[] = []
    const transitions: {
      request: NativeTurnTransitionV2
      response: NativeTurnResponseV2
      writerBefore: Record<string, unknown>[]
      writerAfter: Record<string, unknown>[]
      entries: NativeAssistantEntry[]
    }[] = []
    const writerRoutes: string[] = [], finishes: string[] = [], routeFailures: string[] = []
    const recoveries: NativePreparedInputRecovery[] = []
    const consumedRecoveries: NativeConsumedInputRecovery[] = []
    const preparedCancellations: { request: NativePreparedCancelCommit; receipt: NativePreparedCancelReceipt }[] = []
    const archiveCancellations: { request: NativeArchiveInputCancelCommit; receipt: NativeArchiveInputCancelReceipt }[] = []
    const archiveClaims: Grant[] = []
    const archiveClaimStates: { id: string; state: string; error_code: string | null; attempts: number }[] = []
    const refusedReconciles: NativeTurnTransitionV2[] = []
    const gatedClaims: NativeInputClaimCommit[] = []
    let admissionCalls = 0, releaseCalls = 0, prepareCalls = 0, transitionCalls = 0, stepCommitted = false, droppedStepReplies = 0
    let failedHeartbeatPublisher: string | undefined, failedHeartbeats = 0, storageExecutionDenied = false
    let refusedReconcileWorker: string | undefined
    let droppedCancelReplies = 0
    let droppedArchiveReplies = 0
    const stepReplyGate = Promise.withResolvers<undefined>()
    const claimReplyGate = Promise.withResolvers<undefined>()
    const warmPendingGate = Promise.withResolvers<undefined>()
    const warmTimeline: string[] = []
    let warmPendingPhase: 'before-read' | 'after-read' | undefined
    let warmPendingHeld = false
    let warmBatch: z.infer<typeof nativeInputPendingResponse> | undefined
    const workerToken = randomBytes(32).toString('base64url')
    let nativeCodecRequests = 0, nativeCodecClosures = 0
    const server = createServer((request, response) => {
      const work = (async () => {
        let mutationRoute = request.url
        try {
          const token = bearer(request), input = await readJson(request, ledgerLimits.maxCommandBytes)
          switch (request.url) {
            case '/model/v1/messages': {
              if (!budgetFirstChunk) throw new PlatformError(404, 'unexpected_owned_scheduler_route')
              await transaction(f.pool, client => businessTasks.executionAuthorized(client, token))
              expect(z.looseObject({ model: z.string() }).parse(input).model).toBe('trial-model')
              nativeCodecRequests++
              response.setHeader('content-type', 'text/event-stream')
              for (const event of [
                { type: 'message_start', message: { id: 'owned-budget-message', model: 'trial-model', usage: { input_tokens: 1, output_tokens: 0 } } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: budgetModelText } },
              ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              await once(response, 'close')
              nativeCodecClosures++
              return
            }
            case NATIVE_RETAINED_ROUTES.prepare: {
              const parsed = nativeRetainedPrepare.parse(input)
              const result = await retained.prepare(token, parsed)
              retainedMutations.set(result.intentId, parsed.mutation)
              retainedRoutes.push(request.url)
              sendJson(response, result); return
            }
            case NATIVE_RETAINED_ROUTES.reconcile:
            case NATIVE_RETAINED_ROUTES.resolve: {
              if (token !== workerToken) throw new PlatformError(401, 'unauthorized_worker')
              retainedRoutes.push(request.url)
              sendJson(response, await (request.url === NATIVE_RETAINED_ROUTES.reconcile
                ? retained.reconcile(input) : retained.resolve(input))); return
            }
            case NATIVE_RETAINED_ROUTES.execute: {
              const parsed = nativeRetainedExecute.parse(input), mutation = retainedMutations.get(parsed.intentId)
              if (!mutation) throw new Error('Owned journal observer did not see the original prepare')
              retainedRoutes.push(request.url)
              let transitionObservation: { writerBefore: Record<string, unknown>[]; entries: NativeAssistantEntry[] } | undefined
              switch (mutation.family) {
                case 'publication':
                  mutationRoute = '/runtime/native-assistant'
                  if (failedHeartbeatPublisher && failedHeartbeats === 0
                    && mutation.request.publisherId === failedHeartbeatPublisher && mutation.request.items.length === 0) {
                    failedHeartbeats++
                    throw new PlatformError(503, 'owned_claimed_publisher_unavailable')
                  }
                  break
                case 'admission': mutationRoute = '/runtime/native-input/admit'; admissionCalls++; break
                case 'claim':
                  mutationRoute = '/runtime/native-input/claim'
                  if (loseClaimBeforeCommit && gatedClaims.length === 0) {
                    gatedClaims.push(mutation.request)
                    await claimReplyGate.promise
                    throw new PlatformError(503, 'owned_claim_unavailable')
                  }
                  break
                case 'queue': mutationRoute = '/runtime/native-input/queue'; break
                case 'step': mutationRoute = '/runtime/native-input/step'; break
                case 'prepared-cancel': mutationRoute = '/runtime/native-input/cancel-prepared'; break
                case 'archive-cancel': mutationRoute = '/runtime/native-input/cancel-archive'; break
                case 'turn-transition': {
                  mutationRoute = '/runtime/native-turn/transition'; transitionCalls++
                  const value = mutation.request
                  if (value.from.operationToken !== token) throw new PlatformError(401, 'unauthorized')
                  if (value.kind === 'reconcile' && value.writer.workerId === refusedReconcileWorker) {
                    refusedReconciles.push(value)
                    throw new PlatformError(503, 'owned_reconcile_unavailable')
                  }
                  const writerBefore = (await f.pool.query<Record<string, unknown>>(
                    'SELECT * FROM pe_native_writers WHERE session_id=$1', [value.writer.sessionId])).rows
                  const entries = (await f.pool.query<{ item_json: string }>(
                    'SELECT item_json FROM pe_native_presentation_entries WHERE session_id=$1 ORDER BY ordinal', [value.writer.sessionId])).rows
                    .map(row => nativeAssistantEntry.parse(JSON.parse(row.item_json)))
                  transitionObservation = { writerBefore, entries }
                  break
                }
              }
              const result = nativeRetainedExecutionResult.parse(await retained.execute(token, parsed))
              if (result.family !== mutation.family) throw new Error('Actual journal returned another mutation family')
              if (mutation.family === 'claim' && result.family === 'claim') {
                if (result.result.kind !== 'claim') throw new Error('Actual journal returned another claim kind')
                claims.push({ request: mutation.request, receipt: result.result.input })
              } else if (mutation.family === 'step' && loseStepReply && droppedStepReplies === 0) {
                stepCommitted = true
                await stepReplyGate.promise
                droppedStepReplies++
                response.destroy(); return
              } else if (mutation.family === 'prepared-cancel' && result.family === 'prepared-cancel') {
                preparedCancellations.push({ request: mutation.request, receipt: result.result })
                if (recoverConsumed === 'prepared-cancel' && droppedCancelReplies === 0) {
                  droppedCancelReplies++
                  response.destroy(); return
                }
              } else if (mutation.family === 'archive-cancel' && result.family === 'archive-cancel') {
                archiveCancellations.push({ request: mutation.request, receipt: result.result })
                if (archiveRecovery === 'prepared' && droppedArchiveReplies === 0) {
                  droppedArchiveReplies++
                  response.destroy(); return
                }
              } else if (mutation.family === 'turn-transition' && result.family === 'turn-transition') {
                if (!transitionObservation) throw new Error('Owned transition observer was not captured')
                const writerAfter = (await f.pool.query<Record<string, unknown>>(
                  'SELECT * FROM pe_native_writers WHERE session_id=$1', [mutation.request.writer.sessionId])).rows
                transitions.push({ request: mutation.request, response: result.result, ...transitionObservation, writerAfter })
              }
              sendJson(response, result); return
            }
            case '/runtime/native-assistant':
            case '/runtime/native-input/admit':
            case '/runtime/native-input/claim':
            case '/runtime/native-input/queue':
            case '/runtime/native-input/step':
            case '/runtime/native-input/cancel-prepared':
            case '/runtime/native-input/cancel-archive':
            case '/runtime/native-turn/transition':
              throw new PlatformError(410, 'native_retained_protocol_required')

            case '/runtime/claim': {
              if (token !== workerToken) throw new PlatformError(401, 'unauthorized_worker')
              const value = z.object({ workerId: z.uuid() }).strict().parse(input)
              sendJson(response, await tasks.claim(value.workerId)); return
            }
            case '/runtime/claim-archive-stop': {
              if (token !== workerToken) throw new PlatformError(401, 'unauthorized_worker')
              const value = z.object({ workerId: z.uuid() }).strict().parse(input)
              const grant = await tasks.claimArchiveStop(value.workerId)
              if (grant) archiveClaims.push(grant)
              if (grant && recoverConsumed === 'archive-parked') archiveClaimStates.push(first((await f.pool.query<{
                id: string
                state: string
                error_code: string | null
                attempts: number
              }>('SELECT id,state,error_code,attempts FROM pe_operations WHERE id=$1', [grant.operationId])).rows))
              sendJson(response, grant); return
            }
            case '/runtime/renew': {
              const result = await tasks.renew(token)
              if (warmArchive) warmTimeline.push(result.archiveStop ? 'renew-archive' : 'renew-ordinary')
              sendJson(response, result); return
            }
            case '/runtime/finish': {
              const value = z.object({ outcome: z.enum(['completed', 'failed']), errorCode: z.string().nullable() }).strict().parse(input)
              finishes.push(value.outcome)
              await tasks.finish(token, value.outcome, value.errorCode); sendJson(response, {}); return
            }
            case '/runtime/snapshot': sendJson(response, await events.runtimeSnapshot(token)); return
            case '/runtime/native-assistant/release': {
              releaseCalls++
              await releaseNativeAssistant(tasks, token, nativeAssistantBatch.pick({ publisherId: true }).parse(input).publisherId)
              sendJson(response, {}); return
            }
            case '/runtime/native-writer/acquire':
            case '/runtime/native-writer/renew':
            case '/runtime/native-writer/release': {
              writerRoutes.push(request.url)
              sendJson(response, await routeNativeWriter(writers, request.url, token, input)); return
            }
            case '/runtime/native-input/recover-prepared': {
              const value = nativeInputFrameRequest.parse(input)
              const result = nativePreparedInputRecovery.parse(await transaction(f.pool, client =>
                frames.recoverPreparedInTransaction(client, { writer: value.writer, operationToken: token })))
              recoveries.push(result)
              sendJson(response, result); return
            }
            case '/runtime/native-input/recover-consumed': {
              const value = nativeInputFrameRequest.parse(input)
              const result = await transaction(f.pool, client =>
                frames.readConsumedInTransaction(client, { writer: value.writer, operationToken: token }))
              const recovery = nativeConsumedInputRecovery.parse({ version: 1, kind: 'claimed',
                frame: result.operationFrame, grant: result.storageGrant })
              if (recoverConsumed !== 'none') {
                await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, recovery.grant.token)))
                  .rejects.toMatchObject({ code: archiveRecovery ? 'native_session_archived' : 'native_execution_frame_missing' })
                storageExecutionDenied = true
              }
              consumedRecoveries.push(recovery)
              sendJson(response, recovery); return
            }
            case '/runtime/native-input/pending': {
              const value = nativeInputPendingRequest.parse(input)
              if (warmPendingPhase === 'before-read') {
                warmPendingPhase = undefined
                warmPendingHeld = true
                warmTimeline.push('pending-held')
                await warmPendingGate.promise
              }
              const result = await transaction(f.pool, client => ledger.readAcceptedPendingInTransaction(client,
                { writer: value.writer, operationToken: token }, value.limit))
              if (warmPendingPhase === 'after-read' && result.items.length > 0) {
                warmPendingPhase = undefined
                warmPendingHeld = true
                warmBatch = nativeInputPendingResponse.parse(result)
                warmTimeline.push('pending-held')
                await warmPendingGate.promise
              }
              sendJson(response, nativeInputPendingResponse.parse(result)); return
            }
            case '/runtime/native-input/frame': {
              const value = nativeInputFrameRequest.parse(input)
              const frame = await transaction(f.pool, async (client) => {
                const verified = await frames.verifyInTransaction(client,
                  { kind: 'read', expected: null, authority: { writer: value.writer, operationToken: token } })
                const row = first((await client.query<{ frame: unknown }>(
                  'SELECT frame_json AS frame FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
                  [verified.operationId, verified.operationEpoch])).rows)
                const result = nativeExecutionFrame.parse(row.frame)
                await frames.verifyInTransaction(client, { kind: 'read', expected: {
                  sessionId: result.sessionId, operationId: result.operationId, operationEpoch: result.operationEpoch,
                  writerEpoch: result.writerEpoch, frozenSnapshotDigest: result.frozenSnapshotDigest },
                authority: { writer: value.writer, operationToken: token } })
                return result
              })
              sendJson(response, frame); return
            }
            case '/runtime/native-turn/prepare': {
              prepareCalls++
              sendJson(response, await advanceIntent.prepare(token, input)); return
            }
            case '/runtime/skills/read': {
              const value = z.object({ skillId: z.string() }).strict().parse(input)
              sendJson(response, await readRuntimeSkill(tasks, skills, token, value.skillId)); return
            }
            default: throw new PlatformError(404, 'unexpected_owned_scheduler_route')
          }
        } catch (error) {
          if (warmArchive && error instanceof PlatformError && error.code === 'native_session_archived'
            && (mutationRoute === '/runtime/native-input/pending' || mutationRoute === '/runtime/native-input/admit')) {
            warmTimeline.push(mutationRoute.endsWith('/pending') ? 'pending-refused' : 'admission-refused')
          }
          routeFailures.push(`${mutationRoute}:${error instanceof PlatformError ? error.code : error instanceof Error ? error.name : 'unknown'}`)
          sendFailure(response, error)
        }
      })()
      requests.add(work)
      void work.finally(() => { requests.delete(work) })
    })
    let scheduler: Scheduler | undefined, model: GenerationModel | undefined, owner: Fiber | undefined
    let recoveryHost: Context | undefined, recoveryModel: GenerationModel | undefined
    let preserved: Awaited<ReturnType<typeof prepareNativeImageOffloadHistory>> | undefined
    const consoleRecords: string[] = []
    let restoreConsole: (() => void) | undefined
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected owned HTTP listener')
      const origin = `http://127.0.0.1:${address.port}`, workerFile = join(f.root, 'native-scheduler-worker-token')
      await writeFile(workerFile, workerToken, { mode: 0o600 })
      const { ctx, runtime: actualRuntime } = await prepareHost(host, origin, workerFile, join(f.root, 'image-cache'), budgetFirstChunk)
      if (failFirstModel || budgetFirstChunk) {
        const capture = vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
          if (typeof message !== 'string') throw new Error('Expected the actual console exporter text')
          consoleRecords.push(message)
          if (loggerThrows && message.includes(budgetFirstChunk ? 'operation_publication_budget' : 'operation_first_failure')) {
            throw new Error(failureLogSentinel)
          }
        })
        restoreConsole = () => { capture.mockRestore() }
        await host.plugin((loggerCtx: Context) => {
          const exporter: Exporter = {
            colors: false, maxLength: 1200,
            ...budgetFirstChunk ? { levels: { default: 2 } } : {},
            export(message) {
              console.log(`[${message.type === 'error' ? 'E' : message.type}] ${message.name} ${Logger.format(exporter, message)}`)
            },
          }
          loggerCtx.logger.exporter(exporter)
        })
      }
      const created: Agent[] = [], disposed: Agent[] = [], agentErrors: string[] = []
      host.on('agent/created', ({ agent }) => { created.push(agent) })
      host.on('agent/disposed', ({ agent }) => { disposed.push(agent) })
      host.on('agent/error', ({ error }) => { agentErrors.push(error instanceof Error ? error.name : 'unknown') })
      const skillA = randomUUID(), skillB = randomUUID()
      await skills.install(f.alice.user, skillA, 'scheduler-skill-a', 'A accepted selection', 'A original instructions')
      const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
      await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'A original input', f.alice.token)
      model = new GenerationModel(ctx, businessTasks, session.sessionId, failFirstModel, budgetFirstChunk ? origin : undefined)
      const actualModel = model
      ctx.llm.registerAdapter(['power-evolve'], actualModel)
      const schedulerConfig = { platformOrigin: origin, concurrency: 1, pollMs: 20,
        renewMs: recoverConsumed === 'complete' || recoverConsumed === 'timeout' || archiveRecovery ? 50 : 10_000,
        operationTimeoutMs: 30_000, nativeInputPollMs: 10, nativeInputBatchSize: 8 }
      if (archiveRecovery) {
        if (imageOffload) {
          const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
            'SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows).header)
          preserved = await prepareNativeImageOffloadHistory(ctx, header, join(f.root, 'archival-original-image'))
          expect((await preserved.readOriginal()).data).toEqual(preserved.bytes)
          expect(ctx.sessions.messageProjections).toContain(imageOffloadProjection)
          const original = preserved
          expect(() => Session.forPlanning(header.id, original.prefix, header, original.session.inheritedEventCount))
            .toThrow('requires a message projection')
        }
        const source = await prepareSchedulerArchiveSource(f, { tasks, writers, ledger, bridge, publisher, history: historyLimits },
          session.sessionId, actualRuntime.workerId, archiveRecovery, preserved)
        expect(source.prefix.filter(event => event.type === 'turn/start')).toHaveLength(preserved ? 2 : 1)
        expect(source.prefix.filter(event => event.type === 'step/start')).toHaveLength(archiveRecovery === 'claimed' ? 1 : 0)
        expect(source.original.map(rows => rows.length)).toEqual([3, 3, archiveRecovery === 'claimed' ? 1 : 0,
          archiveRecovery === 'claimed' ? 1 : 0, 1])
        expect(source.grant.selection.map(item => item.skillId)).toEqual([skillA])
        await skills.toggle(f.alice.user, skillA, false)
        expect(await tasks.claim(randomUUID())).toBeNull()
        recoveryHost = new Context()
        const recovered = await prepareHost(recoveryHost, origin, workerFile, join(f.root, `archive-${archiveRecovery}-image-cache`))
        expect(recovered.runtime.workerId).not.toBe(actualRuntime.workerId)
        recoveryHost.on('agent/created', ({ agent }) => {
          created.push(agent)
          if (preserved) {
            expect(agent.session.deriveMessages().find(message => message.id === preserved?.message.id)?.content)
              .toEqual([{ type: 'image', attachment: preserved.ref, offloaded: true }])
          }
        })
        recoveryHost.on('agent/disposed', ({ agent }) => { disposed.push(agent) })
        recoveryHost.on('agent/error', ({ error }) => { agentErrors.push(error instanceof Error ? error.name : 'unknown') })
        recoveryModel = new GenerationModel(recovered.ctx, businessTasks, session.sessionId)
        const resumedModel = recoveryModel
        recovered.ctx.llm.registerAdapter(['power-evolve'], resumedModel)
        const archivalScheduler = new Scheduler(recovered.ctx, schedulerConfig)
        scheduler = archivalScheduler
        let retired: { operation: Grant; seal: NativePublicationSeal } | undefined, unloading: Promise<void> | undefined
        recovered.runtime.afterRetire = (operation, seal) => {
          retired = { operation, seal }
          recovered.runtime.afterRetire = undefined
          unloading = archivalScheduler.close()
          void unloading.catch((_retainedOwnerFailure: unknown) => { /* Awaited after actual publication retirement. */ })
        }
        archivalScheduler.start()
        await expect.poll(() => ({ archive: archiveCancellations.length, prepared: preparedCancellations.length,
          transitions: transitions.length, disposed: disposed.length, grants: recovered.runtime.grants.size,
          releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }), poll)
          .toEqual({ archive: archiveRecovery === 'prepared' ? 3 : 2, prepared: archiveRecovery === 'prepared' ? 1 : 0,
            transitions: archiveRecovery === 'claimed' ? 1 : 0, disposed: 1, grants: 0, releases: 1 })
        if (!retired || !unloading) throw new Error('Actual archival Scheduler did not retire its acknowledged publisher')
        await unloading; scheduler = undefined
        expect(archiveClaims).toHaveLength(1)
        const current = first(archiveClaims)
        expect(retired.operation).toEqual(current)
        expect(current.operationId).toBe(source.grant.operationId)
        expect(current.epoch).toBe(source.grant.epoch + 1)
        expect(current.token).not.toBe(source.grant.token)
        const { token: _oldToken, epoch: _oldEpoch, ...originalFrozen } = source.grant
        const { token: _newToken, epoch: _newEpoch, ...currentFrozen } = current
        expect(currentFrozen).toEqual(originalFrozen)
        expect(current.selection.map(item => item.skillId)).toEqual([skillA])
        expect(actualModel.calls).toEqual([]); expect(actualModel.requests).toEqual([])
        expect(resumedModel.calls).toEqual([]); expect(resumedModel.requests).toEqual([])
        expect(created).toHaveLength(1); expect(disposed).toHaveLength(1)
        expect(recovered.runtime.ownerEvents).toEqual([]); expect(recovered.ctx.agents.list()).toEqual([])
        expect(claims).toEqual([]); expect(admissionCalls).toBe(0); expect(finishes).toEqual([]); expect(agentErrors).toEqual([])
        const suffix = parseEvents(source.header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
        expect(suffix.slice(0, source.prefix.length)).toEqual(source.prefix)
        if (preserved) {
          expect(suffix.slice(0, preserved.prefix.length)).toEqual(preserved.prefix)
          expect((await preserved.readOriginal()).data).toEqual(preserved.bytes)
        }
        expect(suffix.slice(source.prefix.length).map(event => event.type)).toEqual(archiveRecovery === 'prepared'
          ? ['turn/end', 'session/end-seed', 'agent/inbox/spliced', 'agent/inbox/spliced', 'agent/inbox/spliced']
          : ['step/end', 'turn/end', 'session/end-seed', 'agent/inbox/spliced', 'agent/inbox/spliced'])
        expect(suffix.map(event => event.seq)).toEqual(suffix.map((_event, index) => index))
        const folded = foldInputHistory(source.header, suffix)
        expect(folded.inbox).toEqual({ 'next-turn': [], 'next-step': [] })
        expect(folded.claims.map(item => item.message.id)).toEqual(archiveRecovery === 'claimed' ? [source.grant.operationId] : [])
        const uniqueRemovals = archiveRecovery === 'prepared' ? [first(archiveCancellations), first(archiveCancellations.slice(2))]
          : archiveCancellations
        expect(uniqueRemovals.map(item => item.request.command.payload.itemId)).toEqual(source.items.slice(1).map(item => item.message.id))
        expect(uniqueRemovals.every(item => item.request.stopId === source.stop.stopId
          && item.request.writer.workerId === recovered.runtime.workerId && item.request.writer.epoch === source.writer.epoch + 1
          && item.request.presentation.epoch === current.epoch)).toBe(true)
        for (const item of uniqueRemovals) {
          expect(item.receipt.input.committedSpliceSeqs).toEqual([item.request.expectedEventCount])
          expect(item.request.events).toEqual([suffix[item.request.expectedEventCount]])
          expect(item.receipt.input.result).toMatchObject({ kind: 'removed', archive: { purpose: 'archive', stopId: source.stop.stopId } })
        }
        if (archiveRecovery === 'prepared') {
          expect(droppedArchiveReplies).toBe(1)
          expect(first(archiveCancellations.slice(1))).toEqual(first(archiveCancellations))
          expect(consumedRecoveries).toEqual([]); expect(transitions).toEqual([])
          expect(recoveries).toHaveLength(1)
          const restored = first(recoveries)
          if (restored.kind !== 'prepared') throw new Error('Actual archived owner did not recover its original prepared frame')
          const canceled = first(preparedCancellations)
          expect(canceled.request.frame).toEqual(restored.frame)
          expect(uniqueRemovals.every(item => JSON.stringify(item.request.frame) === JSON.stringify(restored.frame))).toBe(true)
          expect(canceled.request.expectedEventCount).toBe(suffix.length - 1)
          expect(canceled.request.events).toEqual([suffix.at(-1)])
          expect(canceled.receipt.frame).toEqual({ ...restored.frame, phase: 'retired', reason: 'user_cancel', requeued: false,
            eventCount: suffix.length })
          const { epoch: _ackEpoch, ...acknowledged } = canceled.receipt.presentation
          expect(retired.seal).toEqual(acknowledged)
          expect(prepareCalls).toBe(0); expect(transitionCalls).toBe(0)
          expect(routeFailures).toEqual([])
        } else {
          expect(droppedArchiveReplies).toBe(0); expect(preparedCancellations).toEqual([])
          expect(consumedRecoveries).toHaveLength(1)
          expect(first(consumedRecoveries).frame).toEqual(source.frame)
          expect(uniqueRemovals.every(item => JSON.stringify(item.request.frame) === JSON.stringify(source.frame))).toBe(true)
          expect(storageExecutionDenied).toBe(true)
          const reconciled = first(transitions)
          expect(reconciled.request.kind).toBe('reconcile')
          if (reconciled.request.kind !== 'reconcile') throw new Error('Actual archive claimed recovery did not use reconciliation')
          expect(reconciled.request.from.claimedOriginInputIds).toEqual([source.grant.operationId])
          expect(reconciled.response.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
          expect(reconciled.response.current).toEqual({ kind: 'parked' })
          expect(reconciled.request.seal.eventCount).toBe(suffix.length)
          expect(retired.seal).toEqual(reconciled.request.seal)
          expect(prepareCalls).toBe(1); expect(transitionCalls).toBe(1)
          expect(routeFailures).toEqual(['/runtime/native-input/recover-prepared:native_input_recovery_required'])
        }
        const final = await Promise.all(source.tables.map(async table => (await f.pool.query<Record<string, unknown>>(
          `SELECT * FROM ${table} WHERE session_id=$1 ORDER BY to_jsonb(${table})::text`, [session.sessionId])).rows))
        expect(final.slice(0, 4)).toEqual(source.original.slice(0, 4))
        if (archiveRecovery === 'prepared') {
          expect((final[4] ?? []).filter(row => Number(row.operation_epoch) === source.grant.epoch)).toEqual(source.original[4])
        } else {
          const { frame_json: _frame, ...originalRow } = first(source.original[4] ?? [])
          const { frame_json: settled, ...settledRow } = first(final[4] ?? [])
          expect(settledRow).toEqual(originalRow)
          const end = suffix.findLast(event => event.type === 'turn/end')
          expect(nativeExecutionFrame.parse(settled)).toEqual({ ...source.frame, phase: 'settled', turnEndSeq: end?.seq,
            outcome: 'failed', errorCode: 'turn_interrupted' })
        }
        expect((await f.pool.query<{ state: string; attempts: number }>(
          'SELECT state,attempts FROM pe_operations WHERE session_id=$1 ORDER BY created_at,id', [session.sessionId])).rows)
          .toEqual([{ state: 'failed', attempts: 2 }, { state: 'failed', attempts: 0 }, { state: 'failed', attempts: 0 }])
        expect((await f.pool.query<{ worker_id: string; ended: boolean }>(
          'SELECT worker_id,ended_at IS NOT NULL AS ended FROM pe_attempts WHERE operation_id=$1 ORDER BY epoch', [current.operationId])).rows)
          .toEqual([{ worker_id: actualRuntime.workerId, ended: true }, { worker_id: recovered.runtime.workerId, ended: true }])
        expect(first((await f.pool.query<{ released: boolean; epoch: string; worker_id: string }>(
          'SELECT expires_at IS NULL AS released,epoch,worker_id FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows))
          .toEqual({ released: true, epoch: String(source.writer.epoch + 1), worker_id: recovered.runtime.workerId })
        expect(first((await f.pool.query<{ grant_digest: null; lease_until: null; event_count: number }>(
          'SELECT grant_digest,lease_until,event_count FROM pe_sessions WHERE id=$1', [session.sessionId])).rows))
          .toEqual({ grant_digest: null, lease_until: null, event_count: suffix.length })
        expect(nativeSessionStopIntent.parse(first((await f.pool.query<{ value: unknown }>(
          'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
          [f.alice.user.userId, `session-archive-stop:${session.sessionId}`])).rows).value))
          .toEqual({ ...source.stop, status: 'complete' })
        return
      }
      if (ownerFirst) {
        owner = await ctx.plugin(Object.assign((ownerCtx: Context) => {
          const ownedScheduler = new Scheduler(ownerCtx, schedulerConfig)
          scheduler = ownedScheduler
          ownedScheduler.start()
          ownerCtx.effect(() => () => ownedScheduler.close())
        }, { inject: ['powerEvolveRuntime', 'sessions', 'sessionPersistence', 'sessionProjections', 'llm', 'agents',
          'agentLoop', 'tools', 'skills', 'attachments'] }))
      } else {
        scheduler = new Scheduler(ctx, schedulerConfig)
        scheduler.start()
      }
      const actualScheduler = scheduler
      if (!actualScheduler) throw new Error('Actual Scheduler creator did not activate')
      if (recoverConsumed === 'complete' || recoverConsumed === 'timeout') {
        await expect.poll(() => actualModel.calls.length, poll).toBe(1)
        const original = first(actualModel.calls), operation = original.operation
        const originalPublisher = actualRuntime.publication(operation)
        await originalPublisher.flush()
        expect(actualModel.requests).toHaveLength(1)
        expect(claims).toHaveLength(1)
        expect(recoveries).toEqual([{ version: 1, kind: 'fresh' }])
        expect(operation.selection.map(item => item.skillId)).toEqual([skillA])
        const originalFrames = (await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_native_turn_frames WHERE session_id=$1', [session.sessionId])).rows
        expect(originalFrames).toHaveLength(1)
        const originalFrame = nativeExecutionFrame.parse(first(originalFrames).frame_json)
        if (originalFrame.phase !== 'claimed') throw new Error('Expected original permanent claimed frame')
        expect(originalFrame.operationEpoch).toBe(operation.epoch)
        expect(originalFrame.writerEpoch).toBe(first(claims).request.writer.epoch)
        expect(originalFrame.owner.originInputId).toBe(operation.operationId)
        expect(first(claims).receipt.committedSpliceSeqs).toEqual([originalFrame.owner.claimSpliceSeq])
        const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
          'SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows).header)
        const prefix = parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
        expect(prefix.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1])
        expect(prefix.filter(event => event.type === 'step/start')).toHaveLength(1)
        expect(prefix.at(-1)?.type).toBe('request/context')
        expect(prefix.filter(event => event.type === 'step/end' || event.type === 'turn/end'
          || event.type === 'assistant/message' || event.type === 'assistant/attempt'
          || event.type === 'tool/call' || event.type === 'tool/result')).toEqual([])
        expect(foldInputHistory(header, prefix).claims.map(item => item.message.id)).toEqual([operation.operationId])
        const immutableTables = ['pe_native_input_origins', 'pe_native_input_revisions', 'pe_native_input_cohorts',
          'pe_native_input_claims', 'pe_native_input_commands']
        const originalInputs = await Promise.all(immutableTables.map(async table => (await f.pool.query<Record<string, unknown>>(
          `SELECT * FROM ${table} WHERE session_id=$1 ORDER BY to_jsonb(${table})::text`, [session.sessionId])).rows))
        expect(originalInputs.map(rows => rows.length)).toEqual([1, 1, 1, 1, 2])
        expect(first(originalInputs[2] ?? [])).toMatchObject({ step_start_seq: prefix.find(event => event.type === 'step/start')?.seq, claim_count: 1,
          operation_epoch: String(operation.epoch), writer_epoch: String(originalFrame.writerEpoch),
          frozen_snapshot_digest: originalFrame.frozenSnapshotDigest })
        process.stdout.write('Owned claimed-tail actual PG gate: original claim and bound step committed; turn and step open; model paused.\n')
        failedHeartbeatPublisher = originalPublisher.publisherId
        await expect.poll(() => ({ failedHeartbeats, disposed: disposed.length, owners: actualRuntime.observedOwners.size,
          grants: actualRuntime.grants.size, releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }), poll)
          .toEqual({ failedHeartbeats: 1, disposed: 1, owners: 0, grants: 0, releases: 1 })
        await actualScheduler.close(); scheduler = undefined
        await host.fiber.dispose()
        expect(() => { originalPublisher.assertOpen() }).toThrow('owned_claimed_publisher_unavailable')
        expect(parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))).toEqual(prefix)
        expect((await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_native_turn_frames WHERE session_id=$1', [session.sessionId])).rows).toEqual(originalFrames)
        expect(prepareCalls).toBe(0); expect(transitionCalls).toBe(0); expect(transitions).toEqual([])
        expect(actualModel.calls).toHaveLength(1); expect(claims).toHaveLength(1)
        expect(routeFailures).toEqual(['/runtime/native-assistant:owned_claimed_publisher_unavailable'])
        expect(first((await f.pool.query<{ released: boolean }>(
          'SELECT expires_at IS NULL AS released FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows).released).toBe(true)
        const originalAttempts = (await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_attempts WHERE operation_id=$1 ORDER BY epoch', [operation.operationId])).rows
        expect(originalAttempts).toHaveLength(1)
        expect(first(originalAttempts)).toMatchObject({ worker_id: actualRuntime.workerId, epoch: operation.epoch, ended_at: null })
        await skills.toggle(f.alice.user, skillA, false)
        await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [session.sessionId])
        recoveryHost = new Context()
        let recovered = await prepareHost(recoveryHost, origin, workerFile, join(f.root, 'claimed-tail-image-cache'))
        expect(recovered.runtime.workerId).not.toBe(actualRuntime.workerId)
        recoveryHost.on('agent/created', ({ agent }) => { created.push(agent) })
        recoveryHost.on('agent/disposed', ({ agent }) => { disposed.push(agent) })
        recoveryHost.on('agent/error', ({ error }) => { agentErrors.push(error instanceof Error ? error.name : 'unknown') })
        recoveryModel = new GenerationModel(recovered.ctx, businessTasks, session.sessionId)
        let resumedModel = recoveryModel
        recovered.ctx.llm.registerAdapter(['power-evolve'], resumedModel)
        const timeoutMs = 1500
        let timeoutAttempts: Record<string, unknown>[] | undefined
        let closedPrefix: SessionEvent[] | undefined
        if (recoverConsumed === 'timeout') refusedReconcileWorker = recovered.runtime.workerId
        scheduler = new Scheduler(recovered.ctx, recoverConsumed === 'timeout'
          ? { ...schedulerConfig, operationTimeoutMs: timeoutMs } : schedulerConfig)
        const recoveryStarted = performance.now(), renewalsBefore = writerRoutes.filter(path => path === '/runtime/native-writer/renew').length
        scheduler.start()
        if (recoverConsumed === 'timeout') {
          await expect.poll(() => ({ disposed: disposed.length, owners: recovered.runtime.observedOwners.size,
            grants: recovered.runtime.grants.size, releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }),
          { ...poll, timeout: 5000 }).toEqual({ disposed: 2, owners: 0, grants: 0, releases: 2 })
          const elapsed = performance.now() - recoveryStarted
          expect(elapsed).toBeGreaterThanOrEqual(timeoutMs)
          expect(elapsed).toBeLessThan(5000)
          expect(refusedReconciles.length).toBeGreaterThan(1)
          expect(refusedReconciles.every(value => JSON.stringify(value) === JSON.stringify(first(refusedReconciles)))).toBe(true)
          const signal = first([...recovered.runtime.transitionSignals])
          expect(signal.aborted).toBe(true)
          expect(signal.reason).toMatchObject({ code: 'operation_timeout' })
          expect(writerRoutes.filter(path => path === '/runtime/native-writer/renew').length).toBeGreaterThan(renewalsBefore)
          expect(transitions).toEqual([]); expect(finishes).toEqual([])
          expect(prepareCalls).toBe(1); expect(transitionCalls).toBe(refusedReconciles.length)
          expect(consumedRecoveries).toHaveLength(1)
          expect(first(consumedRecoveries).frame).toEqual(originalFrame)
          expect(resumedModel.requests).toEqual([]); expect(resumedModel.calls).toEqual([])
          expect(recovered.runtime.ownerEvents).toEqual([])
          expect((await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_native_turn_frames WHERE session_id=$1', [session.sessionId])).rows).toEqual(originalFrames)
          expect((await f.pool.query<{ state: string; error_code: string | null }>(
            'SELECT state,error_code FROM pe_operations WHERE session_id=$1', [session.sessionId])).rows)
            .toEqual([{ state: 'running', error_code: null }])
          closedPrefix = parseEvents(header, (await f.pool.query<{ event: unknown }>(
            'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
          expect(closedPrefix.slice(0, prefix.length)).toEqual(prefix)
          expect(closedPrefix.slice(prefix.length).map(event => event.type)).toEqual(['step/end', 'turn/end', 'session/end-seed'])
          expect(closedPrefix.find(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'interrupted' })
          expect(first((await f.pool.query<{ released: boolean; epoch: string; worker_id: string }>(
            'SELECT expires_at IS NULL AS released,epoch,worker_id FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows))
            .toEqual({ released: true, epoch: '2', worker_id: recovered.runtime.workerId })
          timeoutAttempts = (await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_attempts WHERE operation_id=$1 ORDER BY epoch', [operation.operationId])).rows
          expect(timeoutAttempts).toHaveLength(2)
          expect(first(timeoutAttempts)).toEqual(first(originalAttempts))
          expect(first(timeoutAttempts.slice(1))).toMatchObject({ epoch: operation.epoch + 1,
            worker_id: recovered.runtime.workerId, ended_at: null })
          expect((await f.pool.query('SELECT 1 FROM pe_native_turn_transitions_v2 WHERE session_id=$1', [session.sessionId])).rowCount).toBe(0)
          process.stdout.write(`Owned reconcile overall timeout: ${Math.round(elapsed)}ms; repeated immediate 503; Writer renewed and released; original frame still claimed.\n`)
          await scheduler.close(); scheduler = undefined
          await recoveryHost.fiber.dispose()
          const timedOutWorker = recovered.runtime.workerId, timedOutToken = first(consumedRecoveries).grant.token
          await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [session.sessionId])
          refusedReconcileWorker = undefined
          recoveryHost = new Context()
          recovered = await prepareHost(recoveryHost, origin, workerFile, join(f.root, 'closed-claimed-tail-image-cache'))
          expect(recovered.runtime.workerId).not.toBe(actualRuntime.workerId)
          expect(recovered.runtime.workerId).not.toBe(timedOutWorker)
          recoveryHost.on('agent/created', ({ agent }) => { created.push(agent) })
          recoveryHost.on('agent/disposed', ({ agent }) => { disposed.push(agent) })
          recoveryHost.on('agent/error', ({ error }) => { agentErrors.push(error instanceof Error ? error.name : 'unknown') })
          recoveryModel = new GenerationModel(recovered.ctx, businessTasks, session.sessionId)
          resumedModel = recoveryModel
          recovered.ctx.llm.registerAdapter(['power-evolve'], resumedModel)
          await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, timedOutToken)))
            .rejects.toMatchObject({ code: 'lease_lost' })
          scheduler = new Scheduler(recovered.ctx, schedulerConfig)
          scheduler.start()
        }
        await expect.poll(() => ({ transitions: transitions.length, disposed: disposed.length,
          owners: recovered.runtime.observedOwners.size, grants: recovered.runtime.grants.size,
          releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length,
          failures: routeFailures.filter(value => value !== '/runtime/native-turn/transition:owned_reconcile_unavailable') }), poll)
          .toEqual({ transitions: 1, disposed: recoverConsumed === 'timeout' ? 3 : 2, owners: 0, grants: 0,
            releases: recoverConsumed === 'timeout' ? 3 : 2,
            failures: ['/runtime/native-assistant:owned_claimed_publisher_unavailable',
              ...(recoverConsumed === 'timeout' ? ['/runtime/native-input/recover-prepared:native_input_recovery_required'] : []),
              '/runtime/native-input/recover-prepared:native_input_recovery_required'] })
        await scheduler.close(); scheduler = undefined
        const recoveryCount = recoverConsumed === 'timeout' ? 2 : 1
        expect(consumedRecoveries).toHaveLength(recoveryCount)
        const recovery = first(consumedRecoveries.slice(recoveryCount - 1))
        const invalidConsumed = nativeConsumedInputRecovery.safeParse({ ...recovery,
          grant: { ...recovery.grant, epoch: recovery.frame.operationEpoch } })
        expect(invalidConsumed.success).toBe(false)
        expect(invalidConsumed.error?.issues).toContainEqual({ code: 'custom', path: [],
          message: 'Recovery must preserve original claimed ownership with a later storage-only Grant' })
        expect(nativeConsumedInputRecovery.parse(recovery)).toEqual(recovery)
        expect(recovery.frame).toEqual(originalFrame)
        expect(recovery.grant.epoch).toBe(operation.epoch + recoveryCount)
        expect(recovery.grant.token).not.toBe(operation.token)
        const { token: _oldToken, epoch: _oldEpoch, ...originalFrozen } = operation
        const { token: _newToken, epoch: _newEpoch, ...currentFrozen } = recovery.grant
        expect(currentFrozen).toEqual(originalFrozen)
        expect(recovery.grant.selection.map(item => item.skillId)).toEqual([skillA])
        expect(storageExecutionDenied).toBe(true)
        expect(resumedModel.requests).toEqual([]); expect(resumedModel.calls).toEqual([])
        expect(recovered.runtime.ownerEvents).toEqual([])
        expect(recovered.ctx.agents.list()).toEqual([])
        expect(created).toHaveLength(recoveryCount + 1); expect(disposed).toHaveLength(recoveryCount + 1)
        expect(first(created.slice(1)) === original.agent).toBe(false)
        expect(recoveries).toEqual([{ version: 1, kind: 'fresh' }])
        expect(prepareCalls).toBe(recoveryCount); expect(transitionCalls).toBe(refusedReconciles.length + 1)
        expect(claims).toHaveLength(1); expect(admissionCalls).toBe(1)
        const finalRecords = parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
        expect(finalRecords.slice(0, prefix.length)).toEqual(prefix)
        if (closedPrefix) expect(finalRecords).toEqual(closedPrefix)
        expect(finalRecords.slice(prefix.length).map(event => event.type)).toEqual(['step/end', 'turn/end', 'session/end-seed'])
        expect(finalRecords.map(event => event.seq)).toEqual(finalRecords.map((_event, index) => index))
        const end = finalRecords.slice(prefix.length).find(event => event.type === 'turn/end')
        if (end?.type !== 'turn/end') throw new Error('Expected actual native interrupted turn closure')
        expect(end.data.reason).toEqual({ kind: 'interrupted' })
        expect(foldInputHistory(header, finalRecords).claims.map(item => item.message.id)).toEqual([operation.operationId])
        const reconciled = first(transitions)
        expect(reconciled.request.kind).toBe('reconcile')
        if (reconciled.request.kind !== 'reconcile') throw new Error('Expected actual historical reconcile intent')
        expect(reconciled.request.storageOperationEpoch).toBe(recovery.grant.epoch)
        expect(reconciled.request.from.frame).toEqual(first(claims).request.command.frame)
        expect(reconciled.request.from.operationToken).toBe(recovery.grant.token)
        expect(reconciled.request.from.cohortIds).toEqual([originalFrame.owner.cohortId])
        expect(reconciled.request.from.claimedOriginInputIds).toEqual([operation.operationId])
        expect(reconciled.request.from.turnStartSeq).toBe(originalFrame.owner.turnStartSeq)
        expect(reconciled.request.from.turnEndSeq).toBe(end.seq)
        expect(reconciled.request.writer.workerId).toBe(recovered.runtime.workerId)
        expect(reconciled.request.writer.epoch).toBe(originalFrame.writerEpoch + recoveryCount)
        expect(reconciled.request.seal.publisherId).not.toBe(originalPublisher.publisherId)
        expect(reconciled.request.seal.eventCount).toBe(finalRecords.length)
        expect(reconciled.entries.filter(entry => entry.item.type === 'event')
          .map(entry => entry.item.type === 'event' ? entry.item.seq : -1))
          .toEqual(recoverConsumed === 'timeout' ? [] : finalRecords.slice(prefix.length).map(event => event.seq))
        const { operationToken: _storageToken, ...receiptFrom } = reconciled.request.from
        expect(reconciled.response.receipt.from).toEqual(receiptFrom)
        expect(reconciled.response.receipt.writerEpoch).toBe(reconciled.request.writer.epoch)
        expect(reconciled.response.receipt.settled).toEqual([{ originInputId: operation.operationId,
          operationId: operation.operationId, outcome: 'failed', errorCode: 'turn_interrupted' }])
        expect(reconciled.response.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
        expect(reconciled.response.current).toEqual({ kind: 'parked' })
        expect(reconciled.writerAfter.map(({ expires_at: _expiry, ...identity }) => identity))
          .toEqual(reconciled.writerBefore.map(({ expires_at: _expiry, ...identity }) => identity))
        const settledFrames = (await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_native_turn_frames WHERE session_id=$1', [session.sessionId])).rows
        expect(settledFrames).toHaveLength(1)
        const { frame_json: _beforeFrame, ...beforeFrameRow } = first(originalFrames)
        const { frame_json: settledFrame, ...afterFrameRow } = first(settledFrames)
        expect(afterFrameRow).toEqual(beforeFrameRow)
        expect(nativeExecutionFrame.parse(settledFrame)).toEqual({ ...originalFrame, phase: 'settled',
          turnEndSeq: end.seq, outcome: 'failed', errorCode: 'turn_interrupted' })
        const finalInputs = await Promise.all(immutableTables.map(async table => (await f.pool.query<Record<string, unknown>>(
          `SELECT * FROM ${table} WHERE session_id=$1 ORDER BY to_jsonb(${table})::text`, [session.sessionId])).rows))
        expect(finalInputs).toEqual(originalInputs)
        expect((await f.pool.query<{ state: string; error_code: string | null }>(
          'SELECT state,error_code FROM pe_operations WHERE session_id=$1', [session.sessionId])).rows)
          .toEqual([{ state: 'failed', error_code: 'turn_interrupted' }])
        const finalAttempts = (await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_attempts WHERE operation_id=$1 ORDER BY epoch', [operation.operationId])).rows
        expect(finalAttempts).toHaveLength(recoveryCount + 1)
        const { ended_at: _beforeEnd, ...beforeAttempt } = first(originalAttempts)
        const { ended_at: priorEnd, ...afterAttempt } = first(finalAttempts)
        expect(afterAttempt).toEqual(beforeAttempt)
        expect(priorEnd).not.toBeNull()
        expect(first(finalAttempts.slice(recoveryCount)))
          .toMatchObject({ epoch: recovery.grant.epoch, worker_id: recovered.runtime.workerId })
        expect(finalAttempts.every(attempt => attempt.ended_at !== null)).toBe(true)
        if (timeoutAttempts) expect(finalAttempts.slice(0, 2).map(({ ended_at: _end, ...identity }) => identity))
          .toEqual(timeoutAttempts.map(({ ended_at: _end, ...identity }) => identity))
        const durableTransitions = (await f.pool.query<{ receipt: unknown; writer_epoch: string }>(
          'SELECT receipt_json AS receipt,writer_epoch FROM pe_native_turn_transitions_v2 WHERE session_id=$1', [session.sessionId])).rows
        expect(durableTransitions).toHaveLength(1)
        expect(nativeTurnReceiptV2.parse(first(durableTransitions).receipt)).toEqual(reconciled.response.receipt)
        expect(first(durableTransitions).writer_epoch).toBe(String(originalFrame.writerEpoch))
        await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, operation.token)))
          .rejects.toMatchObject({ code: 'lease_lost' })
        expect(first((await f.pool.query<{ released: boolean; epoch: string; worker_id: string }>(
          'SELECT expires_at IS NULL AS released,epoch,worker_id FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows))
          .toEqual({ released: true, epoch: String(originalFrame.writerEpoch + recoveryCount), worker_id: recovered.runtime.workerId })
        expect(writerRoutes.filter(path => path !== '/runtime/native-writer/renew'))
          .toEqual(['/runtime/native-writer/acquire', '/runtime/native-writer/release',
            '/runtime/native-writer/acquire', '/runtime/native-writer/release',
            ...(recoverConsumed === 'timeout' ? ['/runtime/native-writer/acquire', '/runtime/native-writer/release'] : [])])
        expect(routeFailures.filter(value => value !== '/runtime/native-turn/transition:owned_reconcile_unavailable'))
          .toEqual(['/runtime/native-assistant:owned_claimed_publisher_unavailable',
            ...(recoverConsumed === 'timeout' ? ['/runtime/native-input/recover-prepared:native_input_recovery_required'] : []),
            '/runtime/native-input/recover-prepared:native_input_recovery_required'])
        expect(finishes).toEqual([]); expect(agentErrors).toEqual([])
        return
      }
      if (loseClaimBeforeCommit) {
        await expect.poll(() => gatedClaims.length, poll).toBe(1)
        const operation = actualRuntime.require(session.sessionId), request = first(gatedClaims)
        const originalPublisher = actualRuntime.publication(operation)
        expect(request.writer.workerId).toBe(actualRuntime.workerId)
        expect(request.command.frame.operationId).toBe(operation.operationId)
        expect(request.command.frame.operationEpoch).toBe(operation.epoch)
        expect(request.command.frame.writerEpoch).toBe(request.writer.epoch)
        expect(operation.selection.map(item => item.skillId)).toEqual([skillA])
        expect(actualModel.requests).toEqual([]); expect(actualModel.calls).toEqual([]); expect(claims).toEqual([])
        const originalFrames = (await f.pool.query<Record<string, unknown>>(`SELECT * FROM pe_native_turn_frames
          WHERE operation_id=$1 AND operation_epoch=$2`, [operation.operationId, operation.epoch])).rows
        expect(originalFrames).toHaveLength(1)
        const originalFrame = nativeExecutionFrame.parse(first(originalFrames).frame_json)
        expect(originalFrame.phase).toBe('prepared')
        expect(originalFrame.frozenSnapshotDigest).toBe(request.command.frame.frozenSnapshotDigest)
        const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
          'SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows).header)
        const prefix = parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
        expect(prefix.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1])
        expect(prefix.at(-1)?.type).toBe('turn/start')
        expect(prefix.filter(event => event.type === 'turn/end' || event.type === 'step/start'
          || event.type === 'step/end' || event.type === 'user/message' || event.type === 'assistant/message')).toEqual([])
        expect(foldInputHistory(header, prefix).claims).toEqual([])
        expect(foldInputHistory(header, prefix).inbox['next-turn'].map(item => item.id)).toEqual([operation.operationId])
        expect((await f.pool.query('SELECT 1 FROM pe_native_input_claims WHERE session_id=$1', [session.sessionId])).rowCount).toBe(0)
        const originalOrigins = (await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_native_input_origins WHERE session_id=$1', [session.sessionId])).rows
        const originalRevisions = (await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_native_input_revisions WHERE session_id=$1', [session.sessionId])).rows
        expect(originalOrigins).toHaveLength(1); expect(originalRevisions).toHaveLength(1); expect(admissionCalls).toBe(1)
        process.stdout.write('Owned empty-tail actual PG gate: open turn/start is last; prepared A; claims 0; model 0.\n')
        claimReplyGate.resolve(undefined)
        await expect.poll(() => ({ disposed: disposed.length, owners: actualRuntime.observedOwners.size,
          grants: actualRuntime.grants.size, releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }), poll)
          .toEqual({ disposed: 1, owners: 0, grants: 0, releases: 1 })
        await actualScheduler.close(); scheduler = undefined
        await host.fiber.dispose()
        expect(() => { originalPublisher.assertOpen() }).toThrow('owned_claim_unavailable')
        expect(parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))).toEqual(prefix)
        expect(prepareCalls).toBe(0); expect(transitionCalls).toBe(0); expect(transitions).toEqual([])
        expect(claims).toEqual([]); expect(actualModel.requests).toEqual([]); expect(actualModel.calls).toEqual([])
        expect(routeFailures).toEqual(['/runtime/native-input/claim:owned_claim_unavailable'])
        expect(writerRoutes).toEqual(['/runtime/native-writer/acquire', '/runtime/native-writer/release'])
        expect(first((await f.pool.query<{ released: boolean }>(
          'SELECT expires_at IS NULL AS released FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows).released).toBe(true)
        if (recoverConsumed === 'prepared-cancel') {
          // This sibling is actually accepted and queued; native admission belongs to a later Scheduler run.
          const siblingRequest = requestId.parse(randomUUID())
          await tasks.accept(f.alice.user, session.sessionId, siblingRequest,
            'B independent original pending input', f.alice.token)
          const sibling = first((await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_operations WHERE session_id=$1 AND request_id=$2', [session.sessionId, siblingRequest])).rows)
          expect(sibling.state).toBe('queued')
          const originalAttempts = (await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_attempts WHERE operation_id=$1 ORDER BY epoch', [operation.operationId])).rows
          expect(originalAttempts).toHaveLength(1)
          expect(first(originalAttempts)).toMatchObject({ epoch: operation.epoch, worker_id: actualRuntime.workerId, ended_at: null })
          expect(await tasks.cancelActive(f.alice.user, session.sessionId, f.alice.token)).toEqual({ accepted: true })
          expect(first((await f.pool.query<{ state: string; error_code: string }>(
            'SELECT state,error_code FROM pe_operations WHERE id=$1', [operation.operationId])).rows))
            .toEqual({ state: 'running', error_code: 'cancel_requested' })
          await skills.toggle(f.alice.user, skillA, false)
          await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [session.sessionId])
          recoveryHost = new Context()
          const recovered = await prepareHost(recoveryHost, origin, workerFile, join(f.root, 'prepared-cancel-image-cache'))
          expect(recovered.runtime.workerId).not.toBe(actualRuntime.workerId)
          recoveryHost.on('agent/created', ({ agent }) => { created.push(agent) })
          recoveryHost.on('agent/disposed', ({ agent }) => { disposed.push(agent) })
          recoveryHost.on('agent/error', ({ error }) => { agentErrors.push(error instanceof Error ? error.name : 'unknown') })
          recoveryModel = new GenerationModel(recovered.ctx, businessTasks, session.sessionId)
          const resumedModel = recoveryModel
          recovered.ctx.llm.registerAdapter(['power-evolve'], resumedModel)
          const cancelScheduler = new Scheduler(recovered.ctx, schedulerConfig)
          scheduler = cancelScheduler
          let retired: { operation: Grant; seal: NativePublicationSeal } | undefined, unloading: Promise<void> | undefined
          recovered.runtime.afterRetire = (current, seal) => {
            retired = { operation: current, seal }
            recovered.runtime.afterRetire = undefined
            unloading = cancelScheduler.close()
            void unloading.catch((_retainedOwnerFailure: unknown) => { /* Awaited below after the actual retirement. */ })
          }
          cancelScheduler.start()
          await expect.poll(() => ({ cancellations: preparedCancellations.length, disposed: disposed.length,
            owners: recovered.runtime.observedOwners.size, grants: recovered.runtime.grants.size,
            releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length, routeFailures }), poll)
            .toEqual({ cancellations: 2, disposed: 2, owners: 0, grants: 0, releases: 2,
              routeFailures: ['/runtime/native-input/claim:owned_claim_unavailable'] })
          if (!retired || !unloading) throw new Error('Expected actual prepared cancellation publication retirement')
          await unloading; scheduler = undefined
          const canceled = first(preparedCancellations), replay = first(preparedCancellations.slice(1))
          expect(droppedCancelReplies).toBe(1)
          expect(replay).toEqual(canceled)
          expect(recoveries).toHaveLength(2)
          const restored = first(recoveries.slice(1))
          if (restored.kind !== 'prepared') throw new Error('Expected actual prepared user-cancel recovery')
          expect(canceled.request.frame).toEqual(restored.frame)
          expect(restored.grant.epoch).toBe(operation.epoch + 1)
          expect(restored.grant.token).not.toBe(operation.token)
          expect(restored.frame.writerEpoch).toBe(2)
          expect(restored.frame.preparedEventCount).toBe(prefix.length)
          const { token: _oldToken, epoch: _oldEpoch, ...originalFrozen } = operation
          const { token: _newToken, epoch: _newEpoch, ...currentFrozen } = restored.grant
          expect(currentFrozen).toEqual(originalFrozen)
          expect(currentFrozen.selection.map(item => item.skillId)).toEqual([skillA])
          expect(retired.operation).toEqual(restored.grant)
          const { epoch: _publicationEpoch, ...committedSeal } = canceled.receipt.presentation
          expect(retired.seal).toEqual(committedSeal)
          expect(resumedModel.calls).toEqual([]); expect(resumedModel.requests).toEqual([])
          expect(actualModel.calls).toEqual([]); expect(actualModel.requests).toEqual([])
          expect(claims).toEqual([]); expect(consumedRecoveries).toEqual([]); expect(transitions).toEqual([])
          expect(prepareCalls).toBe(0); expect(transitionCalls).toBe(0); expect(finishes).toEqual([])
          expect(created).toHaveLength(2); expect(disposed).toHaveLength(2)
          expect(recovered.runtime.ownerEvents).toEqual([]); expect(recovered.ctx.agents.list()).toEqual([])
          expect(agentErrors).toEqual([]); expect(admissionCalls).toBe(1)
          const finalRecords = parseEvents(header, (await f.pool.query<{ event: unknown }>(
            'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
          expect(finalRecords.slice(0, prefix.length)).toEqual(prefix)
          expect(finalRecords.slice(prefix.length).map(event => event.type))
            .toEqual(['turn/end', 'session/end-seed', 'agent/inbox/spliced'])
          expect(finalRecords.map(event => event.seq)).toEqual(finalRecords.map((_event, index) => index))
          expect(finalRecords.find(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'interrupted' })
          const removal = finalRecords.at(-1)
          if (removal?.type !== 'agent/inbox/spliced') throw new Error('Expected actual native prepared cancellation splice')
          expect(removal.data).toMatchObject({ target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
          expect(canceled.request.events).toEqual([removal])
          expect(canceled.request.expectedEventCount).toBe(removal.seq)
          expect(canceled.receipt.input.committedSpliceSeqs).toEqual([removal.seq])
          expect(canceled.receipt.frame).toEqual({ ...restored.frame, phase: 'retired', reason: 'user_cancel',
            eventCount: finalRecords.length, requeued: false })
          expect(foldInputHistory(header, finalRecords).claims).toEqual([])
          expect(foldInputHistory(header, finalRecords).inbox).toEqual({ 'next-turn': [], 'next-step': [] })
          expect((await f.pool.query<Record<string, unknown>>(`SELECT * FROM pe_native_turn_frames
            WHERE operation_id=$1 AND operation_epoch=$2`, [operation.operationId, operation.epoch])).rows).toEqual(originalFrames)
          const currentFrames = (await f.pool.query<Record<string, unknown>>(`SELECT * FROM pe_native_turn_frames
            WHERE operation_id=$1 AND operation_epoch=$2`, [operation.operationId, restored.grant.epoch])).rows
          expect(currentFrames).toHaveLength(1)
          expect(nativeExecutionFrame.parse(first(currentFrames).frame_json)).toEqual(canceled.receipt.frame)
          expect(first(currentFrames).grant_json).toEqual({ ...currentFrozen, epoch: restored.grant.epoch })
          expect((await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_native_input_origins WHERE session_id=$1', [session.sessionId])).rows).toEqual(originalOrigins)
          expect((await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_native_input_revisions WHERE session_id=$1', [session.sessionId])).rows).toEqual(originalRevisions)
          expect((await f.pool.query('SELECT 1 FROM pe_native_input_claims WHERE session_id=$1', [session.sessionId])).rowCount).toBe(0)
          expect((await f.pool.query('SELECT 1 FROM pe_native_input_cohorts WHERE session_id=$1', [session.sessionId])).rowCount).toBe(0)
          expect((await f.pool.query<{ receipt: unknown; kind: string }>(
            'SELECT receipt_json AS receipt,kind FROM pe_native_input_commands WHERE session_id=$1 ORDER BY kind', [session.sessionId])).rows
            .map(row => row.kind)).toEqual(['admission', 'remove'])
          const removedReceipt = first((await f.pool.query<{ receipt: unknown }>(
            "SELECT receipt_json AS receipt FROM pe_native_input_commands WHERE session_id=$1 AND kind='remove'", [session.sessionId])).rows)
          expect(readInputReceipt(removedReceipt.receipt)).toEqual(canceled.receipt.input)
          expect(first((await f.pool.query<{ state: string; error_code: string }>(
            'SELECT state,error_code FROM pe_operations WHERE id=$1', [operation.operationId])).rows))
            .toEqual({ state: 'failed', error_code: 'turn_user' })
          expect((await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_operations WHERE session_id=$1 AND request_id=$2', [session.sessionId, siblingRequest])).rows).toEqual([sibling])
          expect((await f.pool.query('SELECT 1 FROM pe_attempts WHERE operation_id=$1', [sibling.id])).rowCount).toBe(0)
          const finalAttempts = (await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_attempts WHERE operation_id=$1 ORDER BY epoch', [operation.operationId])).rows
          expect(finalAttempts).toHaveLength(2)
          const { ended_at: _beforeEnd, ...beforeAttempt } = first(originalAttempts)
          const { ended_at: _afterEnd, ...afterAttempt } = first(finalAttempts)
          expect(afterAttempt).toEqual(beforeAttempt)
          expect(first(finalAttempts.slice(1))).toMatchObject({ epoch: restored.grant.epoch, worker_id: recovered.runtime.workerId })
          expect(finalAttempts.every(attempt => attempt.ended_at !== null)).toBe(true)
          expect(first((await f.pool.query<{ grant_digest: null; lease_until: null; event_count: number }>(
            'SELECT grant_digest,lease_until,event_count FROM pe_sessions WHERE id=$1', [session.sessionId])).rows))
            .toEqual({ grant_digest: null, lease_until: null, event_count: finalRecords.length })
          expect(first((await f.pool.query<{ released: boolean; epoch: string; worker_id: string }>(
            'SELECT expires_at IS NULL AS released,epoch,worker_id FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows))
            .toEqual({ released: true, epoch: '2', worker_id: recovered.runtime.workerId })
          expect(writerRoutes).toEqual(['/runtime/native-writer/acquire', '/runtime/native-writer/release',
            '/runtime/native-writer/acquire', '/runtime/native-writer/release'])
          await expect(recovered.runtime.call('/runtime/native-input/cancel-prepared', operation.token, canceled.request))
            .rejects.toMatchObject({ status: 410, code: 'native_retained_protocol_required' })
          await expect(preparedCancel.commit(operation.token, canceled.request))
            .rejects.toMatchObject({ code: 'native_input_nonce_conflict' })
          expect(preparedCancellations).toHaveLength(2)
          expect(routeFailures).toEqual(['/runtime/native-input/claim:owned_claim_unavailable',
            '/runtime/native-input/cancel-prepared:native_retained_protocol_required'])
          return
        }
        await skills.toggle(f.alice.user, skillA, false)
        await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [session.sessionId])
        recoveryHost = new Context()
        const recovered = await prepareHost(recoveryHost, origin, workerFile, join(f.root, 'empty-tail-image-cache'))
        expect(recovered.runtime.workerId).not.toBe(actualRuntime.workerId)
        recoveryHost.on('agent/created', ({ agent }) => { created.push(agent) })
        recoveryHost.on('agent/disposed', ({ agent }) => { disposed.push(agent) })
        recoveryHost.on('agent/error', ({ error }) => { agentErrors.push(error instanceof Error ? error.name : 'unknown') })
        recoveryModel = new GenerationModel(recovered.ctx, businessTasks, session.sessionId)
        const resumedModel = recoveryModel
        recovered.ctx.llm.registerAdapter(['power-evolve'], resumedModel)
        scheduler = new Scheduler(recovered.ctx, schedulerConfig)
        scheduler.start()
        await expect.poll(() => resumedModel.calls.length, poll).toBe(1)
        const resumed = first(resumedModel.calls)
        expect(resumed.operation.operationId).toBe(operation.operationId)
        expect(resumed.operation.epoch).toBe(operation.epoch + 1)
        expect(resumed.operation.token).not.toBe(operation.token)
        const { token: _oldToken, epoch: _oldEpoch, ...original } = operation
        const { token: _newToken, epoch: _newEpoch, ...current } = resumed.operation
        expect(current).toEqual(original)
        expect(current.selection.map(item => item.skillId)).toEqual([skillA])
        expect(first(resumedModel.requests).model).toBe(current.settings.model)
        expect(first(resumedModel.requests).maxTokens).toBe(current.settings.maxTokens)
        expect(first(resumedModel.requests).tools?.map(tool => tool.name)).toContain('skill_resource')
        expect(recoveries).toHaveLength(2)
        const recoveredPrepared = first(recoveries.slice(1))
        if (recoveredPrepared.kind !== 'prepared') throw new Error('Expected actual empty-tail prepared recovery')
        const invalidPrepared = nativePreparedInputRecovery.safeParse({ ...recoveredPrepared,
          grant: { ...recoveredPrepared.grant, requestId: requestId.parse(randomUUID()) } })
        expect(invalidPrepared.success).toBe(false)
        expect(invalidPrepared.error?.issues).toContainEqual({ code: 'custom', path: [],
          message: 'Recovery must return an exact unclaimed frame and current frozen Grant' })
        expect(nativePreparedInputRecovery.parse(recoveredPrepared)).toEqual(recoveredPrepared)
        expect(recoveredPrepared.grant).toEqual(resumed.operation)
        expect(recoveredPrepared.frame.writerEpoch).toBe(2)
        expect(recoveredPrepared.frame.operationEpoch).toBe(resumed.operation.epoch)
        expect(recoveredPrepared.frame.preparedEventCount).toBe(prefix.length)
        expect((await f.pool.query<Record<string, unknown>>(`SELECT * FROM pe_native_turn_frames
          WHERE operation_id=$1 AND operation_epoch=$2`, [operation.operationId, operation.epoch])).rows).toEqual(originalFrames)
        await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, operation.token)))
          .rejects.toMatchObject({ code: 'lease_lost' })
        expect(claims).toHaveLength(1)
        expect(first(claims).request.command.frame.operationEpoch).toBe(resumed.operation.epoch)
        expect(first(claims).request.command.frame.writerEpoch).toBe(2)
        expect(first(claims).request.command.frame.operationId).toBe(operation.operationId)
        first(resumedModel.gates).resolve(undefined)
        await expect.poll(() => ({ transitions: transitions.length, disposed: disposed.length,
          owners: recovered.runtime.observedOwners.size, grants: recovered.runtime.grants.size,
          releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }), poll)
          .toEqual({ transitions: 1, disposed: 2, owners: 0, grants: 0, releases: 2 })
        await scheduler.close(); scheduler = undefined
        expect(resumedModel.requests).toHaveLength(1); expect(resumedModel.calls).toHaveLength(1)
        expect(actualModel.requests).toEqual([]); expect(actualModel.calls).toEqual([])
        expect(gatedClaims).toHaveLength(1); expect(admissionCalls).toBe(1)
        const finalRecords = parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
        expect(finalRecords.slice(0, prefix.length)).toEqual(prefix)
        expect(finalRecords.map(event => event.seq)).toEqual(finalRecords.map((_event, index) => index))
        expect(finalRecords.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
        expect(finalRecords.filter(event => event.type === 'turn/end').map(event => event.data.reason))
          .toEqual([{ kind: 'interrupted' }, { kind: 'completed' }])
        expect(finalRecords.filter(event => event.type === 'user/message').map(event => event.data.id)).toEqual([operation.operationId])
        expect(finalRecords.filter(event => event.type === 'step/start')).toHaveLength(1)
        expect(finalRecords.filter(event => event.type === 'step/end')).toHaveLength(1)
        expect(finalRecords.filter(event => event.type === 'assistant/message')).toHaveLength(1)
        expect(foldInputHistory(header, finalRecords).claims.map(item => item.message.id)).toEqual([operation.operationId])
        expect((await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_native_input_origins WHERE session_id=$1', [session.sessionId])).rows).toEqual(originalOrigins)
        expect((await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_native_input_revisions WHERE session_id=$1', [session.sessionId])).rows).toEqual(originalRevisions)
        expect(first(transitions).response.current.kind).toBe('parked')
        expect(first(transitions).response.receipt.settled).toEqual([{ originInputId: operation.operationId,
          operationId: operation.operationId, outcome: 'completed', errorCode: null }])
        expect((await f.pool.query<{ state: string; error_code: string | null }>(
          'SELECT state,error_code FROM pe_operations WHERE session_id=$1', [session.sessionId])).rows)
          .toEqual([{ state: 'completed', error_code: null }])
        expect((await f.pool.query<{ origin_input_id: string }>(
          'SELECT origin_input_id FROM pe_native_input_claims WHERE session_id=$1', [session.sessionId])).rows)
          .toEqual([{ origin_input_id: operation.operationId }])
        expect(writerRoutes).toEqual(['/runtime/native-writer/acquire', '/runtime/native-writer/release',
          '/runtime/native-writer/acquire', '/runtime/native-writer/release'])
        expect(routeFailures).toEqual(['/runtime/native-input/claim:owned_claim_unavailable'])
        expect(finishes).toEqual([]); expect(recovered.ctx.agents.list()).toEqual([]); expect(agentErrors).toEqual([])
        return
      }
      if (loseStepReply) {
        await expect.poll(() => stepCommitted, poll).toBe(true)
        const a = actualRuntime.require(session.sessionId)
        expect(a.selection.map(item => item.skillId)).toEqual([skillA])
        expect(actualModel.requests).toEqual([])
        expect(claims).toHaveLength(1)
        const initial = first(claims), cohortId = initial.request.command.cohortId
        const bound = first((await f.pool.query<{ step: number | null; count: number }>(
          'SELECT step_start_seq AS step,claim_count AS count FROM pe_native_input_cohorts WHERE cohort_id=$1', [cohortId])).rows)
        expect(bound.step).not.toBeNull(); expect(bound.count).toBe(1)
        await transaction(f.pool, client => businessTasks.executionAuthorized(client, a.token))
        await skills.toggle(f.alice.user, skillA, false)
        await skills.install(f.alice.user, skillB, 'scheduler-skill-b', 'B accepted selection', 'B original instructions')
        const bRequest = requestId.parse(randomUUID())
        await tasks.accept(f.alice.user, session.sessionId, bRequest, 'B original pending input', f.alice.token)
        await skills.toggle(f.alice.user, skillB, false)
        const b = first((await f.pool.query<{ id: string; selection: unknown }>(
          'SELECT id,skill_selection AS selection FROM pe_operations WHERE session_id=$1 AND request_id=$2',
          [session.sessionId, bRequest])).rows)
        expect(z.array(skillSelection).parse(b.selection).map(item => item.skillId)).toEqual([skillB])
        stepReplyGate.resolve(undefined)
        await expect.poll(() => ({ disposed: disposed.length, owners: actualRuntime.observedOwners.size,
          grants: actualRuntime.grants.size, writerReleased: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }), poll)
          .toEqual({ disposed: 1, owners: 0, grants: 0, writerReleased: 1 })
        await actualScheduler.close(); scheduler = undefined
        expect(droppedStepReplies).toBe(1)
        expect(prepareCalls).toBe(0); expect(transitionCalls).toBe(0); expect(transitions).toEqual([])
        expect(actualModel.requests).toEqual([]); expect(actualModel.calls).toEqual([])
        expect(created).toHaveLength(1); expect(ctx.agents.list()).toEqual([])
        expect(claims).toHaveLength(1)
        expect(first((await f.pool.query<{ step: number | null; count: number }>(
          'SELECT step_start_seq AS step,claim_count AS count FROM pe_native_input_cohorts WHERE cohort_id=$1', [cohortId])).rows))
          .toEqual(bound)
        const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
          'SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows).header)
        const records = parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
        expect(records.map(event => event.seq)).toEqual(records.map((_event, index) => index))
        expect(records.filter(event => event.type === 'user/message')).toEqual([])
        expect(foldInputHistory(header, records).claims.map(item => item.message.id)).toEqual([a.operationId])
        expect(records.filter(event => event.type === 'step/start').map(event => event.seq)).toEqual([bound.step])
        expect(records.filter(event => event.type === 'step/end')).toHaveLength(1)
        expect(records.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['aborted'])
        expect(records.filter(event => event.type === 'assistant/message')).toEqual([])
        expect((await f.pool.query<{ origin_input_id: string }>(
          'SELECT origin_input_id FROM pe_native_input_claims WHERE session_id=$1', [session.sessionId])).rows)
          .toEqual([{ origin_input_id: a.operationId }])
        const commands = (await f.pool.query<{ receipt: unknown }>(
          'SELECT receipt_json AS receipt FROM pe_native_input_commands WHERE session_id=$1', [session.sessionId])).rows
          .map(row => readInputReceipt(row.receipt))
        expect(commands).toHaveLength(2)
        expect(commands.filter(item => item.kind === 'claim')).toHaveLength(1)
        expect((await f.pool.query('SELECT 1 FROM pe_native_turn_transitions_v2 WHERE session_id=$1', [session.sessionId])).rowCount).toBe(0)
        expect((await f.pool.query<{ id: string; state: string; error_code: string | null }>(
          'SELECT id,state,error_code FROM pe_operations WHERE session_id=$1 ORDER BY created_at', [session.sessionId])).rows)
          .toEqual([{ id: a.operationId, state: 'running', error_code: null }, { id: b.id, state: 'queued', error_code: null }])
        expect(first((await f.pool.query<{ count: number; open: number }>(`SELECT count(*)::integer AS count,
          count(*) FILTER (WHERE ended_at IS NULL)::integer AS open FROM pe_attempts WHERE operation_id=$1`, [a.operationId])).rows))
          .toEqual({ count: 1, open: 1 })
        expect(await transaction(f.pool, client => tasks.authorized(client, a.token))).toMatchObject({ operation_id: a.operationId })
        await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, a.token)))
          .rejects.toMatchObject({ code: 'native_execution_frame_lease_lost' })
        expect(await tasks.claim(randomUUID())).toBeNull()
        expect(writerRoutes).toEqual(['/runtime/native-writer/acquire', '/runtime/native-writer/release'])
        expect(releaseCalls).toBe(1); expect(finishes).toEqual([]); expect(routeFailures).toEqual([])
        return
      }
      if (warmArchive) {
        await expect.poll(() => actualModel.calls.length, poll).toBe(1)
        const original = first(actualModel.calls), operation = original.operation
        await actualRuntime.publication(operation).flush()
        expect(claims).toHaveLength(1)
        expect(recoveries).toEqual([{ version: 1, kind: 'fresh' }])
        const requestIds = Array.from({ length: warmArchive === 'pending' ? 2 : 1 }, () => requestId.parse(randomUUID()))
        if (warmArchive === 'admission') warmPendingPhase = 'after-read'
        for (const [index, id] of requestIds.entries()) {
          await tasks.accept(f.alice.user, session.sessionId, id, `Warm archival sibling ${index}`, f.alice.token)
        }
        const siblings = (await f.pool.query<{ id: string }>(`SELECT id FROM pe_operations
          WHERE session_id=$1 AND request_id=ANY($2::uuid[]) ORDER BY created_at,id`, [session.sessionId, requestIds])).rows
        expect(siblings).toHaveLength(requestIds.length)
        if (warmArchive === 'pending') {
          await expect.poll(async () => (await f.pool.query(`SELECT 1 FROM pe_native_input_origins
            WHERE session_id=$1 AND original_request_id=ANY($2::uuid[])`, [session.sessionId, requestIds])).rowCount, poll).toBe(2)
          await expect.poll(() => original.agent.inbox.nextTurn.map(item => item.id), poll).toEqual(siblings.map(item => item.id))
          warmPendingPhase = 'before-read'
        }
        await expect.poll(() => warmPendingHeld, poll).toBe(true)
        await actualRuntime.publication(operation).flush()
        if (warmArchive === 'admission') {
          if (!warmBatch) throw new Error('Expected B from the actual pending PG read')
          expect(warmBatch.items.map(item => item.originOperationId)).toEqual(siblings.map(item => item.id))
          expect(original.agent.inbox.nextTurn).toEqual([])
        }
        const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
          'SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows).header)
        const prefix = parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
        expect(prefix.filter(event => event.type === 'step/end' || event.type === 'turn/end')).toEqual([])
        const immutableTables = ['pe_native_input_origins', 'pe_native_input_revisions',
          'pe_native_input_cohorts', 'pe_native_input_claims']
        const originalInputs = await Promise.all(immutableTables.map(async table => (await f.pool.query<Record<string, unknown>>(
          `SELECT * FROM ${table} WHERE session_id=$1 ORDER BY to_jsonb(${table})::text`, [session.sessionId])).rows))
        expect(originalInputs.map(rows => rows.length)).toEqual(warmArchive === 'pending' ? [3, 3, 1, 1] : [1, 1, 1, 1])
        const originalFrames = (await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_native_turn_frames WHERE session_id=$1', [session.sessionId])).rows
        expect(originalFrames).toHaveLength(1)
        const originalFrame = nativeExecutionFrame.parse(first(originalFrames).frame_json)
        if (originalFrame.phase !== 'claimed') throw new Error('Expected original warm claimed owner')
        expect(originalFrame.operationEpoch).toBe(operation.epoch)
        expect(originalFrame.writerEpoch).toBe(1)
        let unloading: Promise<void> | undefined
        actualRuntime.afterRetire = (retired) => {
          expect(retired).toEqual(operation)
          actualRuntime.afterRetire = undefined
          unloading = actualScheduler.close()
          void unloading.catch((_retainedOwnerFailure: unknown) => { /* Awaited after original warm publication retirement. */ })
        }
        const beforeArchive = warmTimeline.length
        await new NativeWorkspaceRead(f.pool, f.files, 8, 256)
          .archiveAndStop(f.alice.user, f.alice.token, session.sessionId, tasks, historyLimits)
        expect(warmTimeline).toHaveLength(beforeArchive)
        warmTimeline.push('archive-requested')
        const stop = nativeSessionStopIntent.parse(first((await f.pool.query<{ value: unknown }>(
          'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
          [f.alice.user.userId, `session-archive-stop:${session.sessionId}`])).rows).value)
        expect(stop.status).toBe('requested')
        expect((await f.pool.query<{ id: string; state: string; error_code: string | null; attempts: number }>(
          'SELECT id,state,error_code,attempts FROM pe_operations WHERE session_id=$1 ORDER BY created_at,id', [session.sessionId])).rows)
          .toEqual([{ id: operation.operationId, state: 'running', error_code: 'cancel_requested', attempts: 1 },
            ...siblings.map(item => ({ id: item.id, state: warmArchive === 'pending' ? 'queued' : 'failed',
              error_code: warmArchive === 'pending' ? null : 'turn_user', attempts: 0 }))])
        expect(actualModel.calls).toHaveLength(1)
        warmPendingGate.resolve(undefined)
        await expect.poll(() => ({ transitions: transitions.length, disposed: disposed.length,
          grants: actualRuntime.grants.size, releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }), poll)
          .toEqual({ transitions: 1, disposed: 1, grants: 0, releases: 1 })
        if (!unloading) throw new Error('Original warm A did not retire its publisher')
        await unloading; scheduler = undefined
        expect(warmTimeline.slice(beforeArchive - 1, beforeArchive + 3))
          .toEqual(['pending-held', 'archive-requested', warmArchive === 'pending' ? 'pending-refused' : 'admission-refused', 'renew-archive'])
        expect(routeFailures).toEqual([`/runtime/native-input/${warmArchive === 'pending' ? 'pending' : 'admit'}:native_session_archived`])
        expect(actualModel.requests).toHaveLength(1); expect(actualModel.calls).toHaveLength(1)
        expect(actualModel.calls.map(item => item.operation.operationId)).toEqual([operation.operationId])
        expect(created).toHaveLength(1); expect(agentErrors).toEqual([])
        expect(archiveClaims).toEqual([]); expect(consumedRecoveries).toEqual([]); expect(preparedCancellations).toEqual([])
        expect(claims).toHaveLength(1); expect(admissionCalls).toBe(warmArchive === 'pending' ? 3 : 2)
        expect(finishes).toEqual([]); expect(releaseCalls).toBe(0)
        expect(writerRoutes).toEqual(['/runtime/native-writer/acquire', '/runtime/native-writer/release'])
        const transfer = first(transitions)
        expect(transfer.request.kind).toBe('advance')
        expect(transfer.request.from.operationToken).toBe(operation.token)
        expect(transfer.request.from.frame.operationEpoch).toBe(operation.epoch)
        expect(transfer.request.from.frame.writerEpoch).toBe(originalFrame.writerEpoch)
        expect(transfer.response.receipt.settled).toEqual([{ originInputId: operation.operationId,
          operationId: operation.operationId, outcome: 'failed', errorCode: 'turn_user' }])
        expect(transfer.response.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
        expect(transfer.response.current).toEqual({ kind: 'parked' })
        const records = parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
        expect(records.slice(0, prefix.length)).toEqual(prefix)
        expect(records.map(event => event.seq)).toEqual(records.map((_event, index) => index))
        const end = records.findLast(event => event.type === 'turn/end')
        if (end?.type !== 'turn/end') throw new Error('Expected original warm user-cancel closure')
        expect(end.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
        expect(records.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1])
        expect(records.filter(event => event.type === 'step/start')).toHaveLength(1)
        expect(records.filter(event => event.type === 'step/end')).toHaveLength(1)
        expect(records.filter(event => event.type === 'assistant/message')).toEqual([])
        const folded = foldInputHistory(header, records)
        expect(folded.inbox).toEqual({ 'next-turn': [], 'next-step': [] })
        expect(folded.claims.map(item => item.message.id)).toEqual([operation.operationId])
        expect(archiveCancellations.map(item => item.request.command.payload.itemId))
          .toEqual(warmArchive === 'pending' ? siblings.map(item => item.id) : [])
        expect(archiveCancellations.every(item => item.request.stopId === stop.stopId
          && item.request.frame.operationEpoch === operation.epoch && item.request.writer.epoch === 1)).toBe(true)
        const settledInputs = await Promise.all(immutableTables.map(async table => (await f.pool.query<Record<string, unknown>>(
          `SELECT * FROM ${table} WHERE session_id=$1 ORDER BY to_jsonb(${table})::text`, [session.sessionId])).rows))
        expect(settledInputs).toEqual(originalInputs)
        const finalFrames = (await f.pool.query<Record<string, unknown>>(
          'SELECT * FROM pe_native_turn_frames WHERE session_id=$1', [session.sessionId])).rows
        expect(finalFrames).toHaveLength(1)
        const { frame_json: _originalFrameJson, ...originalFrameRow } = first(originalFrames)
        const { frame_json: finalFrameJson, ...finalFrameRow } = first(finalFrames)
        expect(finalFrameRow).toEqual(originalFrameRow)
        expect(nativeExecutionFrame.parse(finalFrameJson)).toEqual({ ...originalFrame, phase: 'settled',
          turnEndSeq: end.seq, outcome: 'failed', errorCode: 'turn_user' })
        expect((await f.pool.query<{ state: string; error_code: string; attempts: number }>(
          'SELECT state,error_code,attempts FROM pe_operations WHERE session_id=$1 ORDER BY created_at,id', [session.sessionId])).rows)
          .toEqual([{ state: 'failed', error_code: 'turn_user', attempts: 1 },
            ...siblings.map(() => ({ state: 'failed', error_code: 'turn_user', attempts: 0 }))])
        expect((await f.pool.query<{ epoch: number; worker_id: string; ended: boolean }>(`SELECT epoch,worker_id,
          ended_at IS NOT NULL AS ended FROM pe_attempts WHERE operation_id=$1`, [operation.operationId])).rows)
          .toEqual([{ epoch: operation.epoch, worker_id: actualRuntime.workerId, ended: true }])
        expect(first((await f.pool.query<{ released: boolean; epoch: string; worker_id: string }>(
          'SELECT expires_at IS NULL AS released,epoch,worker_id FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows))
          .toEqual({ released: true, epoch: '1', worker_id: actualRuntime.workerId })
        expect(first((await f.pool.query<{ grant_digest: null; lease_until: null }>(
          'SELECT grant_digest,lease_until FROM pe_sessions WHERE id=$1', [session.sessionId])).rows))
          .toEqual({ grant_digest: null, lease_until: null })
        expect(nativeSessionStopIntent.parse(first((await f.pool.query<{ value: unknown }>(
          'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
          [f.alice.user.userId, `session-archive-stop:${session.sessionId}`])).rows).value)).toEqual({ ...stop, status: 'complete' })
        expect(transfer.entries.filter(entry => entry.item.type === 'event')
          .map(entry => entry.item.type === 'event' ? entry.item.seq : -1)).toEqual(records.map(event => event.seq))
        expect(actualRuntime.ownerEvents).toEqual([
          { kind: 'register', operationId: operation.operationId }, { kind: 'release', operationId: operation.operationId },
        ])
        return
      }
      await expect.poll(() => ({ calls: actualModel.calls.length, routeFailures }), poll).toEqual({ calls: 1, routeFailures: [] })
      const a = first(actualModel.calls)
      expect(a.operation.selection.map(item => item.skillId)).toEqual([skillA])
      await skills.toggle(f.alice.user, skillA, false)
      await skills.install(f.alice.user, skillB, 'scheduler-skill-b', 'B accepted selection', 'B original instructions')
      const bRequest = requestId.parse(randomUUID())
      await tasks.accept(f.alice.user, session.sessionId, bRequest, 'B original pending input', f.alice.token)
      await skills.toggle(f.alice.user, skillB, false)
      await expect.poll(async () => {
        const origins = await f.pool.query<{ audit: unknown }>(`SELECT accepted_audit_json AS audit FROM pe_native_input_origins
          WHERE session_id=$1 AND original_request_id=$2`, [session.sessionId, bRequest])
        const origin = origins.rows[0]
        if (!origin) return origins.rowCount
        const expectedB = acceptedInputAudit.parse(origin.audit).operationId.toString()
        const pending = a.agent.inbox.nextTurn
        return pending.length === 1 && pending[0]?.id === expectedB ? origins.rowCount : 0
      }, poll).toBe(1)
      const auditB = acceptedInputAudit.parse(first((await f.pool.query<{ audit: unknown }>(
        'SELECT accepted_audit_json AS audit FROM pe_native_input_origins WHERE session_id=$1 AND original_request_id=$2',
        [session.sessionId, bRequest])).rows).audit)
      expect(a.agent.inbox.nextTurn.map(item => item.id)).toEqual([auditB.operationId])
      expect(actualModel.calls).toHaveLength(1)
      expect(actualRuntime.observedOwners.get(session.sessionId)?.operationId).toBe(a.operation.operationId)
      if (budgetFirstChunk) {
        const originalPublisher = actualRuntime.publication(a.operation)
        await originalPublisher.flush()
        const originalFrames = (await f.pool.query('SELECT * FROM pe_native_turn_frames WHERE session_id=$1', [session.sessionId])).rows
        const originalEvents = (await f.pool.query('SELECT seq,event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows
        const failures: { error: unknown; diagnostic: NativePublicationBudgetDiagnostic | undefined }[] = []
        const stopObserving = originalPublisher.onFailure((error, diagnostic) => { failures.push({ error, diagnostic }) })
        const cancellation = vi.spyOn(a.agent, 'cancel')
        try {
          first(actualModel.gates).resolve(undefined)
          await expect.poll(() => ({ disposed: disposed.length, owners: actualRuntime.observedOwners.size,
            grants: actualRuntime.grants.size, codecClosed: nativeCodecClosures,
            writerReleased: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }), poll)
            .toEqual({ disposed: 1, owners: 0, grants: 0, codecClosed: 1, writerReleased: 1 })
          expect(cancellation).toHaveBeenCalledWith({ kind: 'disposed' }, { keepInbox: true })
          expect(failures).toHaveLength(1)
          const observed = first(failures), diagnostic = observed.diagnostic
          expect(observed.error).toBeInstanceOf(PlatformError)
          expect(observed.error).toMatchObject({ status: 413, code: 'native_publication_budget' })
          if (!diagnostic) throw new Error('Actual oversized codec chunk did not capture its budget guard')
          expect(diagnostic).toMatchObject({ site: 'enqueue', reason: 'item_bytes', kind: 'chunk', maxItemBytes: budgetMaxItemBytes })
          expect(diagnostic.itemBytes).toBeGreaterThan(Buffer.byteLength(budgetModelText))
          expect(diagnostic.singleWireBytes).toBeUndefined()
          for (const value of [diagnostic.itemBytes, diagnostic.bufferedItems, diagnostic.bufferedBytes,
            diagnostic.queueLength, diagnostic.maxQueueItems, diagnostic.maxQueueBytes, diagnostic.maxBatchBytes]) {
            expect(Number.isSafeInteger(value) && value >= 0).toBe(true)
          }
          expect(() => { originalPublisher.assertOpen() }).toThrow(observed.error)
          expect(actualModel.calls).toHaveLength(1); expect(actualModel.requests).toHaveLength(1)
          expect(nativeCodecRequests).toBe(1); expect(created).toHaveLength(1); expect(ctx.agents.list()).toEqual([])
          expect(a.agent.inbox.nextTurn.map(item => item.id)).toEqual([auditB.operationId])
          expect(claims).toHaveLength(1)
          expect(first(claims).request.command.frame.operationId).toBe(a.operation.operationId)
          expect(first(claims).receipt.committedSpliceSeqs).toHaveLength(1)
          expect((await f.pool.query('SELECT * FROM pe_native_turn_frames WHERE session_id=$1', [session.sessionId])).rows).toEqual(originalFrames)
          expect((await f.pool.query('SELECT seq,event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows).toEqual(originalEvents)
          const operations = (await f.pool.query<{
            id: string
            state: string
            error_code: string | null
            attempts: number
            skill_selection: unknown
          }>(
            'SELECT id,state,error_code,attempts,skill_selection FROM pe_operations WHERE session_id=$1 ORDER BY created_at', [session.sessionId])).rows
          expect(operations).toMatchObject([{ id: a.operation.operationId, state: 'running', error_code: null, attempts: 1 },
            { id: auditB.operationId, state: 'queued', error_code: null, attempts: 0 }])
          expect(z.array(skillSelection).parse(first(operations.slice(1)).skill_selection)).toEqual(auditB.selection)
          expect(transitions).toEqual([]); expect(prepareCalls).toBe(0); expect(transitionCalls).toBe(0); expect(finishes).toEqual([])
          expect(routeFailures).toEqual([])
          const firstFailures = consoleRecords.filter(record => record.includes('operation_first_failure'))
          const budgetFailures = consoleRecords.filter(record => record.includes('operation_publication_budget'))
          expect(firstFailures).toHaveLength(1); expect(budgetFailures).toHaveLength(1)
          expect(first(firstFailures)).toContain('stage=publication category=platform_refusal code=native_publication_budget')
          await expect.poll(() => consoleRecords.filter(record => record.includes('Operation processing failed')), poll).toHaveLength(1)
          expect(first(consoleRecords.filter(record => record.includes('Operation processing failed'))))
            .toContain('Operation processing failed (native_publication_budget)')
          const fields = [...first(budgetFailures).matchAll(/\b([a-zA-Z]+)=(\S+)/gu)].map(match => [match[1]!, match[2]!])
          expect(new Set(fields.map(([key]) => key)).size).toBe(fields.length)
          expect(Object.fromEntries(fields)).toEqual({ operation: a.operation.operationId, session: session.sessionId,
            epoch: String(a.operation.epoch), writerEpoch: String(first(claims).request.writer.epoch),
            site: 'enqueue', reason: 'item_bytes', kind: 'chunk', itemBytes: String(diagnostic.itemBytes),
            bufferedItems: String(diagnostic.bufferedItems), bufferedBytes: String(diagnostic.bufferedBytes),
            queueLength: String(diagnostic.queueLength), pumping: diagnostic.pumping ? '1' : '0',
            inputReservation: diagnostic.inputReservation ? '1' : '0', maxItemBytes: String(budgetMaxItemBytes),
            maxQueueItems: String(diagnostic.maxQueueItems), maxQueueBytes: String(diagnostic.maxQueueBytes),
            maxBatchBytes: String(diagnostic.maxBatchBytes), singleWireBytes: 'unmeasured' })
          for (const sensitive of [failureLogSentinel, budgetModelText,
            a.operation.token, digest(a.operation.token), workerToken, f.alice.token]) {
            expect(consoleRecords.join('\n')).not.toContain(sensitive)
          }
          process.stdout.write(JSON.stringify({ sink: 'context-plugin-console-exporter', loggerThrows, record: first(budgetFailures) }) + '\n')
        } finally { cancellation.mockRestore(); stopObserving() }
        await actualScheduler.close(); scheduler = undefined
        return
      }
      let capacityOccupant: Grant | undefined
      if (capacityPark) {
        const occupied = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
        await tasks.accept(f.alice.user, occupied.sessionId, requestId.parse(randomUUID()), 'Capacity occupant', f.alice.token)
        const capacityWorker = randomUUID()
        await expect.poll(async () => {
          capacityOccupant ??= (await tasks.claim(capacityWorker)) ?? undefined
          return capacityOccupant?.sessionId
        }, poll).toBe(occupied.sessionId)
      }
      let unloading: Promise<void> | undefined, retiredCount: number | undefined
      const postRetirement: SessionEvent[] = []
      if (ownerFirst) {
        const creatorOwner = owner
        if (!creatorOwner) throw new Error('Expected the actual Scheduler creator owner')
        host.on('session/event', (native, event) => {
          if (native === a.agent.session && retiredCount !== undefined) postRetirement.push(event)
        })
        actualRuntime.afterRetire = (operation, seal) => {
          expect(operation.operationId).toBe(a.operation.operationId)
          expect(a.agent.inbox.nextTurn.map(item => item.id)).toEqual([auditB.operationId])
          retiredCount = seal.eventCount
          actualRuntime.afterRetire = undefined
          unloading = creatorOwner.dispose()
          void unloading.catch((_retainedOwnerFailure: unknown) => { /* Awaited by the external test owner. */ })
        }
      }
      first(actualModel.gates).resolve(undefined)
      if (ownerFirst) {
        await expect.poll(() => unloading !== undefined, poll).toBe(true)
        if (!unloading || retiredCount === undefined) throw new Error('Actual generation was not retired before owner unload')
        await unloading
        await actualScheduler.close(); scheduler = undefined
        expect(postRetirement).toEqual([])
        expect(a.agent.session.seq).toBe(retiredCount)
        expect(a.agent.inbox.nextTurn.map(item => item.id)).toEqual([auditB.operationId])
        expect(actualModel.requests).toHaveLength(1); expect(actualModel.calls).toHaveLength(1)
        expect(created).toHaveLength(1); expect(disposed).toHaveLength(1)
        expect(ctx.agents.list()).toEqual([]); expect(actualRuntime.observedOwners.size).toBe(0)
        expect(actualRuntime.grants.size).toBe(0)
        expect(actualRuntime.ownerEvents).toEqual([
          { kind: 'register', operationId: a.operation.operationId }, { kind: 'release', operationId: a.operation.operationId },
        ])
        expect(transitions).toHaveLength(1)
        const transfer = first(transitions)
        expect(transfer.response.current.kind).toBe(capacityPark ? 'parked' : 'live')
        const issuedB = transfer.response.current.kind === 'live' ? transfer.response.current.grant : undefined
        if (capacityPark) {
          expect(transfer.response.receipt.result).toEqual({ kind: 'parked', reason: 'capacity' })
          if (!capacityOccupant) throw new Error('Expected actual capacity occupant to remain live')
          const actualOccupant = capacityOccupant
          expect(await transaction(f.pool, client => tasks.authorized(client, actualOccupant.token)))
            .toMatchObject({ operation_id: actualOccupant.operationId })
        } else {
          if (!issuedB) throw new Error('Expected the actual still-pending B grant')
          expect(issuedB.operationId).toBe(auditB.operationId)
          expect(issuedB.selection.map(item => item.skillId)).toEqual([skillB])
        }
        expect(transfer.writerAfter).toEqual(transfer.writerBefore)
        expect(transfer.response.receipt.settled.map(item => item.operationId)).toEqual([a.operation.operationId])
        await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, a.operation.token)))
          .rejects.toMatchObject({ code: 'lease_lost' })
        if (issuedB) {
          expect(await transaction(f.pool, client => tasks.authorized(client, issuedB.token)))
            .toMatchObject({ operation_id: issuedB.operationId })
          await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, issuedB.token)))
            .rejects.toMatchObject({ code: 'native_execution_frame_not_claimed' })
          expect(await tasks.claim(randomUUID())).toBeNull()
        }
        const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
          'SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows).header)
        const records = parseEvents(header, (await f.pool.query<{ event: unknown }>(
          'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
        expect(records).toHaveLength(retiredCount)
        expect(records.map(event => event.seq)).toEqual(records.map((_event, index) => index))
        expect(records.filter(event => event.type === 'user/message').map(event => event.data.id)).toEqual([a.operation.operationId])
        expect(records.filter(event => event.type === 'turn/start')).toHaveLength(1)
        expect(records.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
        expect(records.filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')).toEqual([])
        expect(foldInputHistory(header, records).inbox['next-turn'].map(item => item.id)).toEqual([auditB.operationId])
        expect(claims.map(item => item.request.command.frame.operationId)).toEqual([a.operation.operationId])
        expect((await f.pool.query<{ origin_input_id: string }>(
          'SELECT origin_input_id FROM pe_native_input_claims WHERE session_id=$1', [session.sessionId])).rows)
          .toEqual([{ origin_input_id: a.operation.operationId }])
        expect((await f.pool.query<{ receipt: unknown }>(
          'SELECT receipt_json AS receipt FROM pe_native_turn_transitions_v2 WHERE session_id=$1', [session.sessionId])).rows
          .map(row => nativeTurnReceiptV2.parse(row.receipt))).toEqual([transfer.response.receipt])
        expect((await f.pool.query<{ state: string }>(
          'SELECT state FROM pe_operations WHERE session_id=$1 ORDER BY created_at', [session.sessionId])).rows)
          .toEqual([{ state: 'completed' }, { state: capacityPark ? 'queued' : 'running' }])
        expect(first((await f.pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM pe_attempts a
          JOIN pe_operations o ON o.id=a.operation_id WHERE o.session_id=$1`, [session.sessionId])).rows).count).toBe(capacityPark ? 1 : 2)
        expect(writerRoutes).toEqual(['/runtime/native-writer/acquire', '/runtime/native-writer/release'])
        expect(first((await f.pool.query<{ released: boolean }>(
          'SELECT expires_at IS NULL AS released FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows).released).toBe(true)
        expect(releaseCalls).toBe(0); expect(finishes).toEqual([]); expect(routeFailures).toEqual([]); expect(agentErrors).toEqual([])
        if (recoverPrepared) {
          expect(recoveries).toEqual([{ version: 1, kind: 'fresh' }])
          expect(admissionCalls).toBe(2)
          const originalFrame = (await f.pool.query<Record<string, unknown>>(`SELECT * FROM pe_native_turn_frames
            WHERE operation_id=$1 ORDER BY operation_epoch`, [auditB.operationId])).rows
          expect(originalFrame).toHaveLength(capacityPark ? 0 : 1)
          if (!capacityPark) expect(nativeExecutionFrame.parse(first(originalFrame).frame_json).phase).toBe('prepared')
          const originalOrigins = (await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_native_input_origins WHERE session_id=$1 ORDER BY origin_input_id', [session.sessionId])).rows
          const originalRevisions = (await f.pool.query<Record<string, unknown>>(`SELECT * FROM pe_native_input_revisions
            WHERE session_id=$1 ORDER BY origin_input_id,input_revision`, [session.sessionId])).rows
          if (recoverConsumed === 'archive-parked') {
            if (!capacityPark || !capacityOccupant) throw new Error('Archival parked recovery requires actual occupied capacity')
            const sourceClaims = (await f.pool.query<Record<string, unknown>>(
              'SELECT * FROM pe_native_input_claims WHERE session_id=$1 ORDER BY claim_splice_seq', [session.sessionId])).rows
            const sourceFrames = (await f.pool.query<Record<string, unknown>>(
              'SELECT * FROM pe_native_turn_frames WHERE operation_id=$1 ORDER BY operation_epoch', [a.operation.operationId])).rows
            expect(originalFrame).toEqual([])
            expect(first((await f.pool.query<{ state: string; error_code: string | null; attempts: number }>(
              'SELECT state,error_code,attempts FROM pe_operations WHERE id=$1', [auditB.operationId])).rows))
              .toEqual({ state: 'queued', error_code: null, attempts: 0 })
            expect(await new NativeWorkspaceRead(f.pool, f.files, 8, 256)
              .archiveAndStop(f.alice.user, f.alice.token, session.sessionId, tasks, historyLimits))
              .toEqual({ archivedSessionIds: [session.sessionId] })
            const stop = nativeSessionStopIntent.parse(first((await f.pool.query<{ value: unknown }>(
              'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
              [f.alice.user.userId, `session-archive-stop:${session.sessionId}`])).rows).value)
            expect(stop.status).toBe('requested')
            expect(first((await f.pool.query<{ state: string; error_code: string | null; attempts: number }>(
              'SELECT state,error_code,attempts FROM pe_operations WHERE id=$1', [auditB.operationId])).rows))
              .toEqual({ state: 'queued', error_code: null, attempts: 0 })
            await tasks.finish(capacityOccupant.token, 'completed', null)
            expect(await tasks.claim(randomUUID())).toBeNull()
            recoveryHost = new Context()
            const recovered = await prepareHost(recoveryHost, origin, workerFile, join(f.root, 'archive-parked-image-cache'))
            expect(recovered.runtime.workerId).not.toBe(actualRuntime.workerId)
            recoveryHost.on('agent/created', ({ agent }) => { created.push(agent) })
            recoveryHost.on('agent/disposed', ({ agent }) => { disposed.push(agent) })
            recoveryHost.on('agent/error', ({ error }) => { agentErrors.push(error instanceof Error ? error.name : 'unknown') })
            recoveryModel = new GenerationModel(recovered.ctx, businessTasks, session.sessionId)
            const restoredModel = recoveryModel
            recovered.ctx.llm.registerAdapter(['power-evolve'], restoredModel)
            const archivalScheduler = new Scheduler(recovered.ctx, schedulerConfig)
            scheduler = archivalScheduler
            let retired: { operation: Grant; seal: NativePublicationSeal } | undefined, cancellationUnload: Promise<void> | undefined
            recovered.runtime.afterRetire = (operation, seal) => {
              retired = { operation, seal }
              recovered.runtime.afterRetire = undefined
              cancellationUnload = archivalScheduler.close()
              void cancellationUnload.catch((_retainedOwnerFailure: unknown) => { /* Awaited after actual prepared retirement. */ })
            }
            archivalScheduler.start()
            await expect.poll(() => ({ cancellations: preparedCancellations.length, disposed: disposed.length,
              owners: recovered.runtime.observedOwners.size, grants: recovered.runtime.grants.size,
              releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length, routeFailures }), poll)
              .toEqual({ cancellations: 1, disposed: 2, owners: 0, grants: 0, releases: 2, routeFailures: [] })
            if (!retired || !cancellationUnload) throw new Error('Actual parked archival owner did not retire its acknowledged publication')
            await cancellationUnload; scheduler = undefined
            expect(archiveClaimStates).toEqual([{ id: auditB.operationId, state: 'running', error_code: 'cancel_requested', attempts: 1 }])
            expect(archiveClaims).toHaveLength(1)
            const current = first(archiveClaims)
            expect(current).toMatchObject(auditB)
            expect(current.selection.map(item => item.skillId)).toEqual([skillB])
            expect(current.epoch).toBe(a.operation.epoch + 1)
            expect(retired.operation).toEqual(current)
            expect(recoveries).toHaveLength(2)
            const restored = first(recoveries.slice(1))
            if (restored.kind !== 'prepared') throw new Error('Actual no-frame parked B did not recover its native prepared input')
            expect(restored.grant).toEqual(current)
            expect(restored.frame).toMatchObject({ phase: 'prepared', operationId: auditB.operationId,
              candidateOriginInputId: auditB.operationId, messageId: auditB.operationId, operationEpoch: current.epoch, writerEpoch: 2 })
            const canceled = first(preparedCancellations)
            expect(canceled.request.frame).toEqual(restored.frame)
            expect(canceled.request.writer.workerId).toBe(recovered.runtime.workerId)
            const finalRecords = parseEvents(header, (await f.pool.query<{ event: unknown }>(
              'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
            expect(finalRecords.slice(0, records.length)).toEqual(records)
            expect(finalRecords.map(event => event.seq)).toEqual(finalRecords.map((_event, index) => index))
            expect(finalRecords.filter(event => event.type === 'turn/start')).toHaveLength(1)
            expect(finalRecords.filter(event => event.type === 'user/message').map(event => event.data.id)).toEqual([a.operation.operationId])
            expect(finalRecords.filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')).toHaveLength(1)
            expect(canceled.request.events).toEqual([finalRecords.at(-1)])
            expect(canceled.receipt.frame).toEqual({ ...restored.frame, phase: 'retired', reason: 'user_cancel', requeued: false,
              eventCount: finalRecords.length })
            const { epoch: _ackEpoch, ...acknowledged } = canceled.receipt.presentation
            expect(retired.seal).toEqual(acknowledged)
            const folded = foldInputHistory(header, finalRecords)
            expect(folded.inbox).toEqual({ 'next-turn': [], 'next-step': [] })
            expect(folded.claims.map(item => item.message.id)).toEqual([a.operation.operationId])
            expect((await f.pool.query<Record<string, unknown>>(
              'SELECT * FROM pe_native_input_origins WHERE session_id=$1 ORDER BY origin_input_id', [session.sessionId])).rows)
              .toEqual(originalOrigins)
            expect((await f.pool.query<Record<string, unknown>>(`SELECT * FROM pe_native_input_revisions
              WHERE session_id=$1 ORDER BY origin_input_id,input_revision`, [session.sessionId])).rows).toEqual(originalRevisions)
            expect((await f.pool.query<Record<string, unknown>>(
              'SELECT * FROM pe_native_input_claims WHERE session_id=$1 ORDER BY claim_splice_seq', [session.sessionId])).rows).toEqual(sourceClaims)
            expect((await f.pool.query<Record<string, unknown>>(
              'SELECT * FROM pe_native_turn_frames WHERE operation_id=$1 ORDER BY operation_epoch', [a.operation.operationId])).rows)
              .toEqual(sourceFrames)
            expect(nativeExecutionFrame.parse(first((await f.pool.query<{ frame: unknown }>(
              'SELECT frame_json AS frame FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
              [current.operationId, current.epoch])).rows).frame)).toEqual(canceled.receipt.frame)
            expect(first((await f.pool.query<{ state: string; error_code: string; attempts: number }>(
              'SELECT state,error_code,attempts FROM pe_operations WHERE id=$1', [current.operationId])).rows))
              .toEqual({ state: 'failed', error_code: 'turn_user', attempts: 1 })
            expect(nativeSessionStopIntent.parse(first((await f.pool.query<{ value: unknown }>(
              'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
              [f.alice.user.userId, `session-archive-stop:${session.sessionId}`])).rows).value)).toEqual({ ...stop, status: 'complete' })
            expect(actualModel.calls).toHaveLength(1); expect(actualModel.requests).toHaveLength(1)
            expect(restoredModel.calls).toEqual([]); expect(restoredModel.requests).toEqual([])
            expect(created).toHaveLength(2); expect(disposed).toHaveLength(2)
            expect(recovered.runtime.ownerEvents).toEqual([]); expect(recovered.ctx.agents.list()).toEqual([])
            expect(admissionCalls).toBe(2); expect(claims).toHaveLength(1); expect(transitions).toHaveLength(1)
            expect(archiveCancellations).toEqual([]); expect(consumedRecoveries).toEqual([])
            expect(droppedCancelReplies).toBe(0); expect(droppedArchiveReplies).toBe(0)
            expect(routeFailures).toEqual([]); expect(agentErrors).toEqual([]); expect(finishes).toEqual([])
            return
          }
          if (capacityPark) {
            if (!capacityOccupant) throw new Error('Expected actual capacity occupant before release')
            await tasks.finish(capacityOccupant.token, 'completed', null)
          } else {
            await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [session.sessionId])
          }
          recoveryHost = new Context()
          const recovered = await prepareHost(recoveryHost, origin, workerFile, join(f.root, 'recovery-image-cache'))
          expect(recovered.runtime.workerId).not.toBe(actualRuntime.workerId)
          recoveryHost.on('agent/created', ({ agent }) => { created.push(agent) })
          recoveryHost.on('agent/disposed', ({ agent }) => { disposed.push(agent) })
          recoveryHost.on('agent/error', ({ error }) => { agentErrors.push(error instanceof Error ? error.name : 'unknown') })
          recoveryModel = new GenerationModel(recovered.ctx, businessTasks, session.sessionId)
          const restoredModel = recoveryModel
          recovered.ctx.llm.registerAdapter(['power-evolve'], restoredModel)
          scheduler = new Scheduler(recovered.ctx, schedulerConfig)
          scheduler.start()
          await expect.poll(() => ({ calls: restoredModel.calls.length, routeFailures }), poll)
            .toEqual({ calls: 1, routeFailures: [] })
          const b = first(restoredModel.calls)
          expect(created).toHaveLength(2); expect(disposed).toHaveLength(1)
          expect(b.agent === a.agent).toBe(false)
          expect(b.operation.operationId).toBe(auditB.operationId)
          expect(b.operation.epoch).toBe((issuedB?.epoch ?? a.operation.epoch) + 1)
          const { token: _newToken, epoch: _newEpoch, ...restoredB } = b.operation
          if (issuedB) {
            expect(b.operation.token).not.toBe(issuedB.token)
            const { token: _oldToken, epoch: _oldEpoch, ...originalB } = issuedB
            expect(restoredB).toEqual(originalB)
          } else expect(restoredB).toMatchObject(auditB)
          expect(restoredB.selection.map(item => item.skillId)).toEqual([skillB])
          expect(first(restoredModel.requests).model).toBe(restoredB.settings.model)
          expect(first(restoredModel.requests).maxTokens).toBe(restoredB.settings.maxTokens)
          expect(first(restoredModel.requests).tools?.map(tool => tool.name)).toContain('skill_resource')
          expect(recoveries).toHaveLength(2)
          const recoveredPrepared = first(recoveries.slice(1))
          if (recoveredPrepared.kind !== 'prepared') throw new Error('Expected actual prepared B recovery')
          expect(recoveredPrepared.grant).toEqual(b.operation)
          expect(recoveredPrepared.frame.phase).toBe('prepared')
          expect(recoveredPrepared.frame.operationEpoch).toBe(b.operation.epoch)
          expect(recoveredPrepared.frame.writerEpoch).toBe(2)
          expect(recoveredPrepared.frame.candidateOriginInputId).toBe(auditB.operationId)
          expect(recoveredPrepared.frame.messageId).toBe(auditB.operationId)
          expect((await f.pool.query<Record<string, unknown>>(`SELECT * FROM pe_native_turn_frames
            WHERE operation_id=$1 AND operation_epoch<$2 ORDER BY operation_epoch`, [auditB.operationId, b.operation.epoch])).rows)
            .toEqual(originalFrame)
          const currentFrame = nativeExecutionFrame.parse(first((await f.pool.query<{ frame: unknown }>(`SELECT frame_json AS frame
            FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2`, [b.operation.operationId, b.operation.epoch])).rows).frame)
          expect(currentFrame.phase).toBe('claimed')
          expect(currentFrame.writerEpoch).toBe(2)
          expect(first((await f.pool.query<{ worker_id: string; epoch: string }>(
            'SELECT worker_id,epoch FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows))
            .toEqual({ worker_id: recovered.runtime.workerId, epoch: '2' })
          if (issuedB) await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, issuedB.token)))
            .rejects.toMatchObject({ code: 'lease_lost' })
          await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, a.operation.token)))
            .rejects.toMatchObject({ code: 'lease_lost' })
          expect(admissionCalls).toBe(2)
          expect(claims.map(item => item.request.command.frame.operationId)).toEqual([a.operation.operationId, auditB.operationId])
          first(restoredModel.gates).resolve(undefined)
          await expect.poll(() => ({ transitions: transitions.length, disposed: disposed.length,
            owners: recovered.runtime.observedOwners.size, grants: recovered.runtime.grants.size,
            releases: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }), poll)
            .toEqual({ transitions: 2, disposed: 2, owners: 0, grants: 0, releases: 2 })
          await scheduler.close(); scheduler = undefined
          expect(restoredModel.calls).toHaveLength(1); expect(restoredModel.requests).toHaveLength(1)
          expect(actualModel.calls).toHaveLength(1); expect(actualModel.requests).toHaveLength(1)
          expect(recovered.ctx.agents.list()).toEqual([])
          expect(transitions.map(item => item.response.receipt.settled.map(value => value.operationId)))
            .toEqual([[a.operation.operationId], [auditB.operationId]])
          expect(first(transitions.slice(1)).response.current.kind).toBe('parked')
          expect((await f.pool.query<Record<string, unknown>>(
            'SELECT * FROM pe_native_input_origins WHERE session_id=$1 ORDER BY origin_input_id', [session.sessionId])).rows)
            .toEqual(originalOrigins)
          expect((await f.pool.query<Record<string, unknown>>(`SELECT * FROM pe_native_input_revisions
            WHERE session_id=$1 ORDER BY origin_input_id,input_revision`, [session.sessionId])).rows).toEqual(originalRevisions)
          const finalRecords = parseEvents(header, (await f.pool.query<{ event: unknown }>(
            'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
          expect(finalRecords.map(event => event.seq)).toEqual(finalRecords.map((_event, index) => index))
          expect(finalRecords.filter(event => event.type === 'user/message').map(event => event.data.id))
            .toEqual([a.operation.operationId, auditB.operationId])
          expect(finalRecords.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
            .toEqual(['completed', 'completed'])
          expect((await f.pool.query<{ origin_input_id: string }>(`SELECT origin_input_id FROM pe_native_input_claims
            WHERE session_id=$1 ORDER BY claim_splice_seq`, [session.sessionId])).rows)
            .toEqual([{ origin_input_id: a.operation.operationId }, { origin_input_id: auditB.operationId }])
          expect((await f.pool.query<{ state: string }>(
            'SELECT state FROM pe_operations WHERE session_id=$1 ORDER BY created_at', [session.sessionId])).rows)
            .toEqual([{ state: 'completed' }, { state: 'completed' }])
          expect((await f.pool.query<{ id: string; count: number }>(`SELECT operation_id AS id,count(*)::integer AS count
            FROM pe_attempts WHERE operation_id=ANY($1::uuid[]) GROUP BY operation_id ORDER BY operation_id`,
          [[a.operation.operationId, auditB.operationId]])).rows)
            .toEqual([{ id: a.operation.operationId, count: 1 }, { id: auditB.operationId, count: capacityPark ? 1 : 2 }]
              .sort((x, y) => x.id.localeCompare(y.id)))
          expect(admissionCalls).toBe(2)
          expect(writerRoutes).toEqual(['/runtime/native-writer/acquire', '/runtime/native-writer/release',
            '/runtime/native-writer/acquire', '/runtime/native-writer/release'])
          expect(routeFailures).toEqual([]); expect(agentErrors).toEqual([]); expect(finishes).toEqual([]); expect(releaseCalls).toBe(0)
        }
        return
      }
      await expect.poll(() => ({ calls: actualModel.calls.length, modelRequests: actualModel.requests.length,
        transfers: transitions.length, created: created.length, disposed: disposed.length, routeFailures,
        agentErrors: agentErrors.length }), poll)
        .toEqual({ calls: 2, modelRequests: 2, transfers: 1, created: 2, disposed: 1, routeFailures: [],
          agentErrors: failFirstModel ? 1 : 0 })
      const b = first(actualModel.calls.slice(1)), transfer = first(transitions)
      expect(a.agent === b.agent).toBe(false)
      expect(disposed.includes(a.agent)).toBe(true)
      expect(ctx.agents.list().map(agent => agent === b.agent)).toEqual([true])
      expect(b.operation.operationId).toBe(auditB.operationId)
      expect(b.operation.requestId).toBe(bRequest)
      expect(b.operation.text).toBe('B original pending input')
      expect(b.operation.selection.map(item => item.skillId)).toEqual([skillB])
      expect(actualRuntime.observedOwners.size).toBe(1)
      expect(actualRuntime.observedOwners.get(session.sessionId)?.operationId).toBe(b.operation.operationId)
      expect(transfer.response.receipt.settled.map(item => item.operationId)).toEqual([a.operation.operationId])
      if (failFirstModel) {
        expect(transfer.response.receipt.settled).toEqual([{ originInputId: a.operation.operationId,
          operationId: a.operation.operationId, outcome: 'failed', errorCode: 'turn_error' }])
        expect(a.agent.inbox.nextTurn.map(item => item.id)).toEqual([b.operation.operationId])
        expect(first((await f.pool.query<{ state: string; error_code: string | null }>(
          'SELECT state,error_code FROM pe_operations WHERE id=$1', [a.operation.operationId])).rows))
          .toEqual({ state: 'failed', error_code: 'turn_error' })
      }
      expect(transfer.response.receipt.result.kind).toBe('prepared')
      if (transfer.response.receipt.result.kind !== 'prepared') throw new Error('Expected actual original B successor')
      const { token: _bToken, ...frozenB } = b.operation
      expect(frozenB).toEqual(transfer.response.receipt.result.grant)
      expect(transfer.response.receipt.result.grant).toMatchObject(auditB)
      expect(transfer.writerAfter).toEqual(transfer.writerBefore)
      await expect(transaction(f.pool, client => businessTasks.executionAuthorized(client, a.operation.token)))
        .rejects.toMatchObject({ code: 'lease_lost' })
      first(actualModel.gates.slice(1)).resolve(undefined)
      await expect.poll(() => transitions.length, poll).toBe(2)
      await expect.poll(() => ({ agents: ctx.agents.list().length, owners: actualRuntime.observedOwners.size,
        grants: actualRuntime.grants.size, writerReleased: writerRoutes.filter(path => path === '/runtime/native-writer/release').length }), poll)
        .toEqual({ agents: 0, owners: 0, grants: 0, writerReleased: 1 })
      await actualScheduler.close(); scheduler = undefined
      const parked = first(transitions.slice(1))
      expect(parked.response.receipt.settled.map(item => item.operationId)).toEqual([b.operation.operationId])
      expect(parked.response.receipt.result).toEqual({ kind: 'parked', reason: 'empty' })
      expect(parked.response.current).toEqual({ kind: 'parked' })
      expect(parked.writerAfter).toEqual(parked.writerBefore)
      expect(parked.writerBefore).toEqual(transfer.writerBefore)
      expect(writerRoutes).toEqual(['/runtime/native-writer/acquire', '/runtime/native-writer/release'])
      expect(releaseCalls).toBe(0); expect(finishes).toEqual([])
      expect(retainedRoutes).toContain(NATIVE_RETAINED_ROUTES.prepare)
      expect(retainedRoutes).toContain(NATIVE_RETAINED_ROUTES.execute)
      expect(retainedRoutes).toContain(NATIVE_RETAINED_ROUTES.reconcile)
      expect((await f.pool.query("SELECT 1 FROM pe_native_retained_intents WHERE state='prepared'")).rowCount).toBe(0)
      expect(agentErrors).toHaveLength(failFirstModel ? 1 : 0); expect(routeFailures).toEqual([])
      expect(created).toHaveLength(2); expect(disposed).toHaveLength(2); expect(actualModel.requests).toHaveLength(2)
      expect(actualRuntime.ownerEvents).toEqual([
        { kind: 'register', operationId: a.operation.operationId }, { kind: 'release', operationId: a.operation.operationId },
        { kind: 'register', operationId: b.operation.operationId }, { kind: 'release', operationId: b.operation.operationId },
      ])
      const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
        'SELECT header FROM pe_sessions WHERE id=$1', [session.sessionId])).rows).header)
      const records = parseEvents(header, (await f.pool.query<{ event: unknown }>(
        'SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [session.sessionId])).rows.map(row => row.event))
      expect(records.map(event => event.seq)).toEqual(records.map((_event, index) => index))
      expect(records.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
      expect(records.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
        .toEqual([failFirstModel ? 'error' : 'completed', 'completed'])
      expect(records.filter(event => event.type === 'user/message').map(event => event.data.id))
        .toEqual([a.operation.operationId, b.operation.operationId])
      expect(records.filter(event => event.type === 'assistant/message')).toHaveLength(failFirstModel ? 1 : 2)
      if (failFirstModel) {
        expect(records.filter(event => event.type === 'step/start')).toHaveLength(2)
        expect(records.filter(event => event.type === 'step/end')).toHaveLength(2)
        const failed = records.find(event => event.type === 'turn/end')
        if (failed?.data.reason.kind !== 'error') throw new Error('Expected the actual native model-error closure')
        expect(failed.data.reason.error.message).toContain('Owned external model stream failure')
        const firstFailures = consoleRecords.filter(record => record.includes('operation_first_failure'))
        expect(firstFailures).toHaveLength(1)
        expect(first(firstFailures)).toContain('[E]')
        expect(first(firstFailures)).toContain(`operation=${a.operation.operationId} session=${session.sessionId} epoch=${a.operation.epoch}`)
        expect(first(firstFailures)).toContain(`writerEpoch=${first(claims).request.writer.epoch} stage=agent_error category=llm_other code=unknown`)
        expect(consoleRecords.join('\n')).not.toContain(failureLogSentinel)
        expect(consoleRecords.some(record => record.includes(a.operation.token))).toBe(false)
        expect(consoleRecords.some(record => record.includes(digest(a.operation.token)))).toBe(false)
        process.stdout.write(JSON.stringify({ sink: 'context-plugin-console-exporter', loggerThrows, record: first(firstFailures) }) + '\n')
      }
      expect(claims.map(claim => claim.request.command.frame.operationId)).toEqual([a.operation.operationId, b.operation.operationId])
      expect(claims.map(claim => claim.receipt.committedSpliceSeqs.length)).toEqual([1, 1])
      expect((await f.pool.query<{ origin_input_id: string }>(
        'SELECT origin_input_id FROM pe_native_input_claims WHERE session_id=$1 ORDER BY claim_splice_seq', [session.sessionId])).rows)
        .toEqual([{ origin_input_id: a.operation.operationId }, { origin_input_id: b.operation.operationId }])
      const boundCohorts = (await f.pool.query<{ step: number | null; count: number }>(
        'SELECT step_start_seq AS step,claim_count AS count FROM pe_native_input_cohorts WHERE session_id=$1 ORDER BY turn_start_seq',
        [session.sessionId])).rows
      expect(boundCohorts).toHaveLength(2)
      expect(boundCohorts.every(row => row.step !== null && row.count === 1)).toBe(true)
      const commandReceipts = (await f.pool.query<{ receipt: unknown }>(
        'SELECT receipt_json AS receipt FROM pe_native_input_commands WHERE session_id=$1', [session.sessionId])).rows.map(row => readInputReceipt(row.receipt))
      expect(commandReceipts).toHaveLength(4)
      expect(commandReceipts.filter(receipt => receipt.kind === 'claim')).toHaveLength(2)
      const durableTransitions = (await f.pool.query<{ receipt: unknown }>(
        'SELECT receipt_json AS receipt FROM pe_native_turn_transitions_v2 WHERE session_id=$1 ORDER BY (receipt_json->>\'eventCount\')::integer',
        [session.sessionId])).rows.map(row => nativeTurnReceiptV2.parse(row.receipt))
      expect(durableTransitions).toEqual(transitions.map(item => item.response.receipt))
      expect((await f.pool.query<{ state: string }>(
        'SELECT state FROM pe_operations WHERE session_id=$1 ORDER BY created_at', [session.sessionId])).rows)
        .toEqual([{ state: failFirstModel ? 'failed' : 'completed' }, { state: 'completed' }])
      expect(first((await f.pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM pe_attempts a
        JOIN pe_operations o ON o.id=a.operation_id WHERE o.session_id=$1`, [session.sessionId])).rows).count).toBe(2)
      expect(first((await f.pool.query<{ released: boolean; epoch: string }>(
        'SELECT expires_at IS NULL AS released,epoch FROM pe_native_writers WHERE session_id=$1', [session.sessionId])).rows))
        .toMatchObject({ released: true, epoch: '1' })
      const entries = transitions.flatMap(item => item.entries)
      expect(entries.filter(entry => entry.item.type === 'event').map(entry => entry.item.type === 'event' ? entry.item.seq : -1))
        .toEqual(records.map(event => event.seq))
      expect((await f.pool.query('SELECT 1 FROM pe_native_presentation_entries WHERE session_id=$1', [session.sessionId])).rowCount).toBe(0)
      const unavailable = nativeInputQueueCommand.parse({ rpcNonce: 'final-owner-probe', payload: { sessionId: session.sessionId,
        itemId: b.operation.operationId, action: { kind: 'remove' } } })
      expect(() => actualRuntime.queueInput(f.alice.token, unavailable)).toThrow('native_input_owner_unavailable')
    } finally {
      stepReplyGate.resolve(undefined)
      claimReplyGate.resolve(undefined)
      warmPendingGate.resolve(undefined)
      for (const value of [model, recoveryModel]) for (const gate of value?.gates ?? []) gate.resolve(undefined)
      try {
        try { await scheduler?.close(); await owner?.dispose() }
        finally {
          try { await recoveryHost?.fiber.dispose(); await host.fiber.dispose() } finally { await preserved?.dispose() }
        }
      }
      finally {
        try {
          await Promise.all(requests)
          if (server.listening) await new Promise<void>((resolve, reject) => {
            server.close((error) => { if (error) reject(error); else resolve() })
          })
        } finally { restoreConsole?.() }
      }
    }
  })
}

test('actual Scheduler ends A before transferring original B to a new Agent and finally parks and releases the independent Writer',
  () => schedulerCase(false))

test('owner-first unload after actual Scheduler retirement preserves pending B and cannot re-execute claimed A',
  () => schedulerCase(true))

test.each([false, true])('native model failure after actual A claim and step settles A once and transfers preserved B to its original frozen selection (logger throws: %s)',
  loggerThrows => schedulerCase(false, true, false, false, false, false, 'none', loggerThrows))

test.each([false, true])('native codec publication budget after actual A claim cancels without settling A or changing preserved B (logger throws: %s)',
  loggerThrows => schedulerCase(false, false, false, false, false, false, 'none', loggerThrows, true))

test('step-bind lost reply after actual PG commit prevents advance and leaves claimed A and accepted B for reconciliation',
  () => schedulerCase(false, false, true))

test('new worker recovers owner-first prepared B once with its frozen selection and never re-executes claimed A',
  () => schedulerCase(true, false, false, true))

test('new worker recovers admitted capacity-parked B without a prior frame or another admission',
  () => schedulerCase(true, false, false, true, true))

test('new worker repairs an actual empty unclaimed turn after pre-commit claim failure and executes A once',
  () => schedulerCase(false, false, false, false, false, true))

test('new worker reconciles an actual open claimed turn without re-executing its model or permanent input',
  () => schedulerCase(false, false, false, false, false, false, 'complete'))

test('claimed reconciliation times out and releases its renewing Writer before another Host settles the closed original turn',
  () => schedulerCase(false, false, false, false, false, false, 'timeout'))

test('new Host retires an unclaimed prepared user-canceled input once after an actual lost reply and preserves its unadmitted sibling',
  () => schedulerCase(false, false, false, false, false, true, 'prepared-cancel'))

test('new Host archives an admitted prepared A after canceling native B and C, retrying one lost sibling reply without model entry',
  () => schedulerCase(false, false, false, false, false, false, 'archive-prepared'))

test('new Host restores preserved image/offload through SessionStore and archives prepared A plus native B/C with original history and lost-reply receipts intact',
  () => schedulerCase(false, false, false, false, false, false, 'archive-prepared', false, false, true))

test('new Host archives siblings of an original claimed A and reconciles its closed full frame without another claim or model entry',
  () => schedulerCase(false, false, false, false, false, false, 'archive-claimed'))

test('new Host cancels actual capacity-parked admitted B through an archive storage claim without a prior frame or B model entry',
  () => schedulerCase(true, false, false, true, true, false, 'archive-parked'))

test('warm Host settles original A after actual archive refuses pending read before the next periodic renewal',
  () => schedulerCase(false, false, false, false, false, false, 'archive-warm-pending'))

test('warm Host settles original A after actual archive refuses admission of B already read from PG',
  () => schedulerCase(false, false, false, false, false, false, 'archive-warm-admission'))
