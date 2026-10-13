/** Native Host model and tools over owned HTTP, actual PG and controlled external stream timing. */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, createUserMessage, expandAssistantStream, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, test, vi } from 'vitest'
import { PlatformError, requestId, type Grant } from '../src/contracts.ts'
import { encodeOfficeCommand, installOfficeTool, parseOfficeCommand } from '../src/host/office.ts'
import RuntimeScope from '../src/host/scope.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { once } from 'node:events'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { sse, start, end } from '../../../../packages/llm/llm-deepseek/tests/helpers.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import * as HostModel from '../src/host/model.ts'
import type { NativeAssistantPublisher } from '../src/host/native-assistant-publisher.ts'
import PlatformPersistence from '../src/host/persistence.ts'
import { nativeAssistantBatch, type NativeAssistantBatch } from '../src/native-assistant-records.ts'
import { NATIVE_RETAINED_ROUTES, nativeRetainedExecute, nativeRetainedPrepare,
  type NativeRetainedMutation } from '../src/native-retained-intent-contracts.ts'
import { transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { releaseNativeAssistant } from '../src/platform/native-assistant-lifecycle.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { retainedTestStore } from './native-retained-intent-fixture.ts'

test('Office batch path inspection preserves lexical JSON and rejects paths nested inside its arrays and objects', () => {
  const json = '[{"data":1e400,"nested":[{"file":"/workspace/报告.docx"}]}]'
  expect(parseOfficeCommand(`batch --commands '${json}'`)).toEqual(['batch', '--commands', json])
  expect(encodeOfficeCommand(`batch --commands '${json}'`)).toContain(json)
  expect(() => parseOfficeCommand('batch --commands \'[{"nested":[{"file":"/private/report.docx"}]}]\''))
    .toThrow('OfficeCLI file paths must stay below /workspace')
})

test('native tool cancellation drains an in-flight Office RPC response before the configured transport timeout', () => cloudFixture(async (f) => {
  const ctx = new Context(), started = Promise.withResolvers<undefined>(), disconnected = Promise.withResolvers<undefined>()
  let posts = 0
  const server = createServer((request, response) => {
    request.resume()
    if (request.method !== 'POST' || request.url !== '/runtime/executions/propose') {
      response.writeHead(404).end(); return
    }
    posts++
    response.on('close', () => { disconnected.resolve(undefined) })
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"executionId":')
    started.resolve(undefined) // The real fetch is now waiting for the rest of the response body.
  })
  let pending: Promise<Awaited<ReturnType<ToolRuntime['execute']>>> | undefined
  const stop = new AbortController()
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Signal fixture has no owned HTTP port')
    const workerFile = join(f.root, 'signal-worker-token'); await writeFile(workerFile, randomUUID(), { mode: 0o600 })
    await ctx.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, workerTokenFile: workerFile,
      timeoutMs: 5000, maxResponseBytes: 65536 })
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
      await ctx.plugin(plugin)
    }
    await ctx.plugin(AgentLoop, { agents: [] })
    let active: Context | undefined
    await ctx.inject(['powerEvolveRuntime', 'llm', 'sessions', 'sessionProjections', 'systemPrompt', 'tools', 'agents', 'agentLoop'],
      (current) => { active = current })
    if (!active) throw new Error('Actual tool Host did not activate')
    const tasks = new TaskStore(f.pool, { maxEventBytes: 524_288, leaseMs: 30_000,
      maxPendingPerUser: 8, maxActivePerUser: 1, executionEnabled: true })
    const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
    await tasks.accept(f.alice.user, session.sessionId, requestId.parse(randomUUID()), 'Read Office help', f.alice.token)
    const grant = await tasks.claim(active.powerEvolveRuntime.workerId)
    if (!grant) throw new Error('Signal fixture did not claim its original PG operation')
    const agent = await active.agentLoop.create(session.sessionId)
    installOfficeTool(agent, grant, active.powerEvolveRuntime)
    expect(active.tools.get('office', agent)).toBeDefined()
    pending = active.tools.execute({ name: 'office', arguments: { command: 'help word' },
      callId: ToolCallId(randomUUID()), agent, signal: stop.signal })
    await started.promise
    const abortedAt = performance.now(); stop.abort()
    expect(await pending).toMatchObject({ isError: true })
    await disconnected.promise
    expect(performance.now() - abortedAt).toBeLessThan(1000)
    expect(posts).toBe(1)
  } finally {
    stop.abort(); await pending; await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() }); server.closeAllConnections()
    })
  }
}))

type Database = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const history = { maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000 }
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const presentation = { maxBatchItems: 32, maxBatchBytes: 1_048_576, maxItemBytes: 1_048_576,
  maxActiveBytes: 4_194_304, maxRingItems: 1024, maxRingBytes: 4_194_304, ttlMs: 20_000, maxEventBytes: taskLimits.maxEventBytes }
const inputLimits = { ...history, maxEventBytes: taskLimits.maxEventBytes, maxAcceptedAuditBytes: 2_097_152,
  maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }
const poll = { timeout: 5000, interval: 10 }

interface ModelFixture {
  db: Database
  ctx: Context
  grant: Grant
  tasks: TaskStore
  events: EventStore
  store: NativeAssistantStore
  handle: AgentHandle
  publisher: NativeAssistantPublisher
  frames: AssistantStreamFrame[]
  sourceChunks: StreamChunk[]
  batches: NativeAssistantBatch[]
  held: Promise<void>
  release(): void
  start(): void
  pulls: () => number
  sourceClosed: () => number
  modelCalls: () => number
  firstFailure: () => unknown
}

async function modelCase(parts: readonly string[], run: (fixture: ModelFixture) => Promise<void>): Promise<void> {
  await cloudFixture(async (db) => {
    vi.stubEnv('DSH_HOME', db.root)
    const tasks = new TaskStore(db.pool, taskLimits)
    const events = new EventStore(tasks, { ...history, maxEventBytes: taskLimits.maxEventBytes })
    const writers = new NativeSessionWriter(tasks, { leaseMs: taskLimits.leaseMs })
    const store = new NativeAssistantStore(tasks, events, presentation)
    const frames = new NativeExecutionFrames(tasks, writers, { ...history, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
    const verifier: ConstructorParameters<typeof NativeInputLedger>[4] = (client, request) => frames.verifyInTransaction(client, request)
    const ledger = new NativeInputLedger(tasks, writers, events, inputLimits, verifier)
    const config = { input: inputLimits, presentation }
    const bridge = new NativeInputCommit(tasks, ledger, frames, store, writers, config)
    const turn = new NativeTurnContinuationV2(tasks, writers, verifier,
      { ...inputLimits, leaseMs: taskLimits.leaseMs, maxActivePerUser: taskLimits.maxActivePerUser, assistant: presentation }, frames)
    const retained = retainedTestStore({ tasks, writers, publisher: store, ledger, frames, bridge }, config, turn)()
    const mutations = new Map<string, NativeRetainedMutation>(), batches: NativeAssistantBatch[] = []
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const requests = new Set<Promise<void>>()
    const sourceChunks: StreamChunk[] = []
    let held = false, modelCalls = 0, pulls = 0, sourceClosed = 0, firstFailure: unknown
    // oxlint-disable-next-line typescript/unbound-method -- The probe invokes this original codec method with the exact instance below.
    const originalStream = DeepSeekAdapter.prototype.stream
    const probe = vi.spyOn(DeepSeekAdapter.prototype, 'stream').mockImplementation(function (this: DeepSeekAdapter, options) {
      const original = originalStream.call(this, options)
      return { async *[Symbol.asyncIterator]() {
        try { for await (const chunk of original) { pulls++; sourceChunks.push(chunk); yield chunk } }
        finally { sourceClosed++ }
      } }
    })
    const server = createServer((request, response) => {
      const work = (async () => {
        try {
          const token = bearer(request), input: unknown = await readJson(request, inputLimits.maxCommandBytes)
          if (request.url === '/model/v1/messages' || request.url === '/model/messages') {
            await transaction(db.pool, client => tasks.authorized(client, token))
            modelCalls++
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.end(sse([{ ...start, message: { ...start.message, model: 'trial-model' } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              ...parts.map(text => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
              { type: 'content_block_stop', index: 0 }, ...end()]))
            return
          }
          if (request.url === NATIVE_RETAINED_ROUTES.prepare) {
            const parsed = nativeRetainedPrepare.parse(input), result = await retained.prepare(token, parsed)
            mutations.set(result.intentId, parsed.mutation)
            sendJson(response, result); return
          }
          if (request.url === NATIVE_RETAINED_ROUTES.execute) {
            const parsed = nativeRetainedExecute.parse(input), mutation = mutations.get(parsed.intentId)
            if (!mutation) throw new Error('Owned model fixture missed the original prepare')
            const result = await retained.execute(token, parsed)
            if (mutation.family === 'publication') {
              batches.push(mutation.request)
              if (!held && mutation.request.items.some(item => item.type === 'assistant-stream' && item.frame.type === 'chunk')) {
                held = true; entered.resolve(undefined); await release.promise
              }
            }
            sendJson(response, result); return
          }
          if (request.url === '/runtime/snapshot') { sendJson(response, await events.runtimeSnapshot(token)); return }
          if (request.url === '/runtime/native-assistant/release') {
            const id = nativeAssistantBatch.pick({ publisherId: true }).parse(input).publisherId
            sendJson(response, await releaseNativeAssistant(tasks, token, id))
            return
          }
          throw new PlatformError(404, 'unexpected_fixture_endpoint')
        } catch (error) { sendFailure(response, error) }
      })().finally(() => { requests.delete(work) })
      requests.add(work)
    })
    const host = new Context()
    let handle: AgentHandle | undefined
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Owned model listener missing')
      const worker = join(db.root, 'worker-token'); await writeFile(worker, randomUUID(), { mode: 0o600 })
      await host.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, workerTokenFile: worker,
        timeoutMs: 5000, maxResponseBytes: history.maxHistoryBytes })
      for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt,
        ToolRuntime, AgentRegistry, PlatformPersistence]) {
        await host.plugin(plugin)
      }
      await host.plugin(AgentLoop, { agents: [] })
      await host.plugin(HostModel, { streamIdleTimeoutMs: 1000 })
      let active: Context | undefined
      await host.inject(['powerEvolveRuntime', 'llm', 'sessions', 'agents', 'sessionPersistence', 'agentLoop'], (ctx) => { active = ctx })
      if (!active) throw new Error('Actual model Host did not activate')
      const ctx = active
      const created = await tasks.create(db.alice.user, requestId.parse(randomUUID()), db.alice.token)
      await tasks.accept(db.alice.user, created.sessionId, requestId.parse(randomUUID()), 'Original model input', db.alice.token)
      const grant = await tasks.claim(ctx.powerEvolveRuntime.workerId)
      if (!grant) throw new Error('Actual model fixture did not obtain a PG grant')
      ctx.powerEvolveRuntime.grants.set(grant.sessionId, grant)
      const observed: AssistantStreamFrame[] = []
      handle = await ctx.agents.resume({ resumeSessionId: grant.sessionId,
        disposeOptions: { keepInbox: true }, agentOptions: { provider: 'power-evolve', model: grant.settings.model, maxTokens: grant.settings.maxTokens },
        setup(agentCtx, agent) {
          const publisher = ctx.powerEvolveRuntime.publication(grant)
          agentCtx.effect(() => publisher.onFailure((error) => { firstFailure ??= error; agent.cancel({ kind: 'disposed' }, { keepInbox: true }) }))
          agentCtx.on('agent/assistant-stream', ({ agent: source, frame }) => {
            if (source === agent) { publisher.frame(frame); observed.push(frame) }
          })
          return { commit: () => { ctx.powerEvolveRuntime.assertGrant(grant) } }
        },
      })
      const current = handle
      await run({ db, ctx, grant, tasks, events, store, handle: current,
        publisher: ctx.powerEvolveRuntime.publication(grant), frames: observed, sourceChunks, batches, held: entered.promise,
        release: () => { release.resolve(undefined) }, start: () => { current.agent.followup(createUserMessage({
          source: { kind: 'user' }, content: [{ type: 'text', text: 'Original model input' }],
        })) }, pulls: () => pulls, sourceClosed: () => sourceClosed, modelCalls: () => modelCalls, firstFailure: () => firstFailure })
    } finally {
      release.resolve(undefined)
      try {
        handle?.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
        await handle?.agent.whenIdle()
        try { await handle?.dispose() } catch (error) { if (firstFailure === undefined) throw error }
      } finally {
        try { await host.fiber.dispose() } finally {
          await Promise.allSettled([...requests])
          await new Promise<void>((resolve, reject) => {
            server.close((error) => { if (error) reject(error); else resolve() }); server.closeAllConnections()
          })
          probe.mockRestore()
          vi.unstubAllEnvs()
        }
      }
    }
  })
}

async function reserveInput(n: ModelFixture, entered: PromiseWithResolvers<undefined>,
  release: PromiseWithResolvers<undefined>): Promise<void> {
  await n.handle.agent.runMaintenance(async (signal) => {
    const agent = n.handle.agent, activity = agent.captureInboxActivity(signal)
    const detached = Session.forPlanning(agent.id, agent.session.snapshotEvents(), agent.session.header, agent.session.inheritedEventCount)
    const event = detached.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] })
    await n.publisher.commitInput(activity.cursor, [event], false, async (position) => {
      entered.resolve(undefined); await release.promise
      const receipt = await transaction(n.db.pool, async (client) => {
        await n.events.appendInTransaction(client, await n.tasks.authorized(client, n.grant.token), [event])
        return n.store.commitInputInTransaction(client, n.grant.token, activity.cursor, nativeAssistantBatch.parse({
          version: 1, epoch: n.grant.epoch, publisherId: position.publisherId, batchId: randomUUID(),
          firstOrdinal: position.firstOrdinal, items: [{ type: 'event', event }],
        }))
      })
      activity.synchronize(() => {
        n.ctx.powerEvolveRuntime.synchronizeCommitted(n.grant, activity.cursor, [event])
        agent.session.synchronizeCommitted([event])
        return undefined
      })
      return { receipt, value: undefined }
    })
  }, { scope: 'inbox' })
}

test('native burst pauses demand at capacity and preserves every original delta in durable PG settlement', () =>
  modelCase(Array.from({ length: 320 }, (_value, index) => `[${index}]`), async (n) => {
    n.start(); await n.held
    await expect.poll(n.pulls, poll).toBe(32)
    await setImmediate(); expect(n.pulls()).toBe(32)
    expect(n.handle.agent.status).toBe('running')
    n.release(); await n.handle.agent.whenIdle(); await n.ctx.sessions.flush(n.handle.agent.session)
    expect(n.firstFailure()).toBeUndefined()
    expect(n.modelCalls()).toBe(1); expect(n.sourceClosed()).toBe(1)
    const chunks = n.frames.filter(frame => frame.type === 'chunk')
    expect(chunks.map(frame => frame.chunk)).toEqual(n.sourceChunks)
    expect(n.frames.map(frame => frame.revision)).toEqual(n.frames.map((_frame, index) => index + 1))
    expect(chunks.map(frame => frame.index)).toEqual(chunks.map((_frame, index) => index))
    expect(chunks.filter(frame => frame.chunk.type === 'text-delta').map(frame => frame.chunk.type === 'text-delta' ? frame.chunk.text : ''))
      .toEqual(Array.from({ length: 320 }, (_value, index) => `[${index}]`))
    const messages = n.handle.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    const message = messages[0]
    if (!message || message.type !== 'assistant/message' || !message.data.stream) throw new Error('Expected original native stream settlement')
    expect(expandAssistantStream(message.data.stream)).toEqual(chunks.map(frame => ({ time: frame.time, chunk: frame.chunk })))
    const pg = (await n.db.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 AND event->>\'type\'=$2',
      [n.grant.sessionId, 'assistant/message'])).rows
    expect(pg.map(row => row.event)).toEqual([message])
    expect(n.batches.some(batch => batch.items.length > 1)).toBe(true)
    expect(n.batches.length).toBeLessThan(chunks.length / 2)
  }))

test('native model waits for input commit without blocking the holder or overtaking its canonical suffix', () =>
  modelCase(Array.from({ length: 64 }, () => 'x'), async (n) => {
    n.start(); await n.held; await expect.poll(n.pulls, poll).toBe(32)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const input = reserveInput(n, entered, release)
    try {
      n.release(); await entered.promise
      const paused = n.pulls(); await delay(1100); expect(n.pulls()).toBe(paused)
      release.resolve(undefined); await input
      await n.handle.agent.whenIdle(); await n.ctx.sessions.flush(n.handle.agent.session)
      expect(n.firstFailure()).toBeUndefined(); expect(n.modelCalls()).toBe(1)
      const ordered = n.batches.flatMap(batch => batch.items)
      expect(ordered.filter(item => item.type === 'assistant-stream' && item.frame.type === 'chunk')).toHaveLength(n.pulls())
      expect(n.handle.agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.length === 0).length)
        .toBeGreaterThan(0)
    } finally { release.resolve(undefined); await input }
  }))

test.each([false, true])('native cancellation closes the source but joins owned publication and input cleanup (input held: %s)',
  inputHeld => modelCase(Array.from({ length: 64 }, () => 'x'), async (n) => {
    n.start(); await n.held; await expect.poll(n.pulls, poll).toBe(32)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const input = inputHeld ? reserveInput(n, entered, release) : undefined
    if (inputHeld) { n.release(); await entered.promise }
    n.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    let disposed = false
    const disposal = n.handle.dispose().then(() => { disposed = true })
    try {
      await expect.poll(n.sourceClosed, poll).toBe(1)
      const paused = n.pulls(); await setImmediate()
      expect(n.pulls()).toBe(paused); expect(disposed).toBe(false)
      n.release(); release.resolve(undefined); await input; await disposal
      expect(n.modelCalls()).toBe(1); expect(n.firstFailure()).toBeUndefined()
      const pg = (await n.db.pool.query<{ event: { data: { interrupted?: boolean } } }>(
        'SELECT event FROM pe_events WHERE session_id=$1 AND event->>\'type\'=$2', [n.grant.sessionId, 'assistant/message'])).rows
      expect(pg).toHaveLength(1); expect(pg[0]?.event.data.interrupted).toBe(true)
    } finally { n.release(); release.resolve(undefined); await input; await disposal }
  }))

test('an exact Grant replacement fences the suspended model without rebinding its chunks or making another request', () =>
  modelCase(Array.from({ length: 64 }, () => 'x'), async (n) => {
    n.start(); await n.held; await expect.poll(n.pulls, poll).toBe(32)
    await n.tasks.finish(n.grant.token, 'failed', 'turn_interrupted')
    await n.tasks.accept(n.db.alice.user, n.grant.sessionId, requestId.parse(randomUUID()), 'Successor input', n.db.alice.token)
    const successor = await n.tasks.claim(n.ctx.powerEvolveRuntime.workerId)
    if (!successor || successor.sessionId !== n.grant.sessionId || successor.epoch <= n.grant.epoch) {
      throw new Error('Expected a separately issued successor PG grant')
    }
    n.ctx.powerEvolveRuntime.grants.set(n.grant.sessionId, successor)
    n.release(); await n.handle.agent.whenIdle()
    expect(n.firstFailure()).toMatchObject({ code: 'lease_lost' })
    expect(n.pulls()).toBe(32); expect(n.sourceClosed()).toBe(1); expect(n.modelCalls()).toBe(1)
    expect(n.batches.every(batch => batch.epoch === n.grant.epoch)).toBe(true)
  }))

test('sub-watermark EOF waits for the original tail receipt before native final settlement', () =>
  modelCase(['a', '界', 'c'], async (n) => {
    n.start(); await n.held
    await expect.poll(n.sourceClosed, poll).toBe(1)
    expect(n.pulls()).toBeLessThan(32)
    expect(n.frames.some(frame => frame.type === 'end')).toBe(false)
    expect(n.handle.agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
    n.release(); await n.handle.agent.whenIdle(); await n.ctx.sessions.flush(n.handle.agent.session)
    expect(n.frames.filter(frame => frame.type === 'end')).toHaveLength(1)
    expect(n.modelCalls()).toBe(1); expect(n.firstFailure()).toBeUndefined()
  }))
