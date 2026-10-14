/** Cold interactive disposal waits for the real native factory's unpublished setup and rejects new opens. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { Session } from '@deepseek-ai/dsh-session'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { harness, declare } from '../../../../packages/preset/agent-preset-registry/tests/harness.ts'
import { PlatformError, operationId, requestId, sessionId } from '../src/contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { nativeWriterIdentity } from '../src/native-writer-contracts.ts'
import { bearer, readJson, sendJson, sendFailure } from '../src/http.ts'
import RuntimeScope from '../src/host/scope.ts'
import PlatformPersistence from '../src/host/persistence.ts'
import NativeRuntimeSessions from '../src/host/native-runtime-sessions.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { NativeInteractive } from '../src/platform/native-interactive.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { EventStore } from '../src/platform/events.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { routeNativeWriter } from '../src/platform/native-writer-routes.ts'
import { releaseNativeAssistant } from '../src/platform/native-assistant-lifecycle.ts'
import { cleanupNativeRuntime } from '../src/platform/native-runtime-cleanup.ts'
import { transaction } from '../src/platform/database.ts'
import { appendOwnedEvents, type OwnedAppendState } from '../src/platform/native-owned-append.ts'
import { cloudFixture } from './cloud-fixture.ts'
import { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeInputCommit } from '../src/platform/native-input-commit.ts'
import { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { NATIVE_RETAINED_ROUTES } from '../src/native-retained-intent-contracts.ts'
import { retainedTestStore } from './native-retained-intent-fixture.ts'

const limits = { maxEventBytes: 524288, maxHistoryEvents: 1000, maxHistoryBytes: 8388608,
  leaseMs: 30000, maxPendingPerUser: 8, maxActivePerUser: 2 }

test.each(['closing', 'publishing', 'failed-cleanup'] as const)('real cold Agent setup %s keeps original PG durability and lifetime ownership', mode => cloudFixture(async f => {
  const tasks = new TaskStore(f.pool, limits), events = new EventStore(tasks, limits), authority = new NativeRuntimeAuthority(f.pool)
  const issued = await authority.issue({ userId: f.alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const interactive = new NativeInteractive(tasks, authority, { leaseMs: 30000, lifetimeMs: 30000, maxActivePerUser: 2 })
  const writers = new NativeSessionWriter(tasks, { leaseMs: 30000 })
  const presentation = { maxBatchItems: 32, maxBatchBytes: 1048576, maxItemBytes: 1048576,
    maxActiveBytes: 4194304, maxRingItems: 1024, maxRingBytes: 4194304, ttlMs: 20000, maxEventBytes: limits.maxEventBytes }
  const publisher = new NativeAssistantStore(tasks, events, presentation)
  const inputLimits = { maxEventBytes: limits.maxEventBytes, maxHistoryBytes: limits.maxHistoryBytes, maxHistoryEvents: limits.maxHistoryEvents, maxAcceptedAuditBytes: 2097152, maxRevisionBytes: 262144,
    maxCohortInputs: 128, maxCommandBytes: 4194304 }
  const frames = new NativeExecutionFrames(tasks, writers, { maxHistoryEvents: limits.maxHistoryEvents, maxHistoryBytes: limits.maxHistoryBytes, maxFrameBytes: 2097152, maxCohortInputs: 128 })
  const verifier: ConstructorParameters<typeof NativeInputLedger>[4] = (client, command) => frames.verifyInTransaction(client, command)
  const ledger = new NativeInputLedger(tasks, writers, events, inputLimits, verifier)
  const config = { input: inputLimits, presentation }, bridge = new NativeInputCommit(tasks, ledger, frames, publisher, writers, config)
  const turn = new NativeTurnContinuationV2(tasks, writers, verifier, { ...inputLimits, leaseMs: limits.leaseMs, maxActivePerUser: limits.maxActivePerUser, assistant: presentation }, frames)
  const retained = retainedTestStore({ tasks, writers, publisher, ledger, frames, bridge }, config, turn)()
  const first = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token, undefined, 'standard')
  const second = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token, undefined, 'standard')
  if (mode !== 'publishing') await transaction(f.pool, async client => {
    const row = (await client.query<OwnedAppendState>('SELECT id,header,event_count,event_bytes FROM pe_sessions WHERE id=$1 FOR UPDATE', [first.sessionId])).rows[0]
    if (!row) throw new Error('Owned cold fixture Session missing')
    const header = headerSchema.parse(row.header), native = Session.create(header.id, undefined, header)
    native.append('sandbox/mode', { mode: 'read-only' }); native.append('agent-preset/selected', { agentPreset: 'standard' })
    await appendOwnedEvents(client, f.alice.user.userId, row, native.snapshotEvents(), limits)
  })
  const ctx = await harness(), pending = new Set<Promise<void>>()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const published: string[] = []
  let service: NativeRuntimeSessions | undefined, calls = 0
  const server = createServer((request, response) => {
    const work = (async () => {
      try {
        const token = bearer(request), input = await readJson(request, 1048576)
        switch (request.url) {
          case NATIVE_RETAINED_ROUTES.prepare: sendJson(response, await retained.prepare(token, input)); return
          case NATIVE_RETAINED_ROUTES.execute: sendJson(response, await retained.execute(token, input)); return
          case '/runtime/user/identity': {
            const actor = await authority.authenticate(token)
            const account = await f.pool.query('SELECT settings FROM pe_users WHERE id=$1', [actor.userId])
            sendJson(response, { ...actor, settings: account.rows[0]?.settings }); return
          }
          case '/runtime/user/interactive/open': calls++; sendJson(response, await interactive.open(token, z.object({ sessionId, requestId, browserToken: z.string(), candidateToken: z.string() }).parse(input))); return
          case '/runtime/native-writer/release': sendJson(response, await routeNativeWriter(writers, request.url, token, input)); return
          case '/runtime/finish': {
            const value = z.object({ outcome: z.enum(['completed', 'failed']), errorCode: z.string().nullable() }).parse(input)
            await tasks.finish(token, value.outcome, value.errorCode); sendJson(response, {}); return
          }
          case '/runtime/native-writer/acquire': sendJson(response, await routeNativeWriter(writers, request.url, token, input)); return
          case '/runtime/snapshot': sendJson(response, await events.runtimeSnapshot(token)); return
          case '/runtime/native-assistant/release': {
            await releaseNativeAssistant(tasks, token, z.object({ publisherId: z.string() }).parse(input).publisherId)
            sendJson(response, {}); return
          }
          case '/runtime/cleanup': {
            const value = z.object({ operationId, epoch: z.number(), writer: nativeWriterIdentity, errorCode: z.string() }).parse(input)
            sendJson(response, await cleanupNativeRuntime(f.pool, token, value, limits)); return
          }
          default: throw new PlatformError(404, 'fixture_route_not_found')
        }
      } catch (error) { sendFailure(response, error) }
    })()
    pending.add(work); void work.finally(() => { pending.delete(work) })
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned listener missing')
    const runtimeTokenFile = join(f.root, 'late-setup-runtime-token')
    await writeFile(runtimeTokenFile, issued.token, { mode: 0o600 })
    await ctx.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, runtimeUserId: issued.userId,
      workerId: issued.runtimeId, runtimeTokenFile, timeoutMs: 5000, maxResponseBytes: 8388608 })
    await ctx.plugin(PlatformPersistence)
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: '/workspace' })
    await declare(ctx, { id: 'standard', plugins: [] })
    // Only the external execution bind is held; AgentLoop, Session load, preset binding and PG Writer are real.
    ctx.provide('nativeRuntimeExecution', { bind: async () => { entered.resolve(undefined); await release.promise },
      drain: async () => { if (mode === 'failed-cleanup') throw new Error('fixture execution cleanup proof failed') } })
    const fiber = await ctx.plugin(NativeRuntimeSessions, { renewMs: 60000 })
    await ctx.inject(['nativeRuntimeSessions'], owned => { service = owned.nativeRuntimeSessions })
    if (!service) throw new Error('Actual interactive service inactive')
    ctx.on('agent/created', ({ agent }) => { published.push(agent.id) })
    const opening = service.ensure(first.sessionId, f.alice.token)
    const result = opening.then(() => undefined, error => error as unknown)
    await Promise.race([entered.promise, result.then(error => { if (error) throw error })])
    if (mode !== 'publishing') {
      let disposed = false
      const disposal = fiber.dispose().then(() => { disposed = true }, error => { disposed = true; return error as unknown })
      await expect(service.ensure(second.sessionId, f.alice.token)).rejects.toMatchObject({ code: 'native_interactive_closing' })
      expect(disposed).toBe(false)
      expect(calls).toBe(1)
      release.resolve(undefined)
      expect(await result).toBeInstanceOf(Error)
      const stopped = await disposal
      expect(stopped).toBeUndefined()
      if (mode === 'failed-cleanup') {
        expect(service.available).toBe(false)
        await expect(service.shutdown()).rejects.toBeInstanceOf(AggregateError)
      } else await service.shutdown()
      expect(published).toEqual([])
      expect(ctx.agents.list()).toEqual([])
      expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
        .toEqual([{ state: 'failed', error_code: 'native_interactive_setup_failed' }])
      expect((await f.pool.query('SELECT * FROM pe_native_cleanup_receipts WHERE session_id=$1', [first.sessionId])).rowCount).toBe(1)
    } else {
      release.resolve(undefined)
      const agent = await opening
      expect(agent.id).toBe(first.sessionId)
      expect(published).toEqual([first.sessionId])
      expect((await f.pool.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq', [first.sessionId])).rows)
        .toEqual([{ event: expect.objectContaining({ seq: 0, type: 'session/end-seed', data: {} }) },
          { event: expect.objectContaining({ seq: 1, type: 'sandbox/mode', data: { mode: 'read-only' } }) }])
      expect((await f.pool.query('SELECT * FROM pe_native_input_origins WHERE session_id=$1', [first.sessionId])).rowCount).toBe(0)
      await service.close(first.sessionId)
      expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
        .toEqual([{ state: 'completed', error_code: null }])
    }
    expect((await f.pool.query('SELECT * FROM pe_operations WHERE session_id=$1', [second.sessionId])).rowCount).toBe(0)
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await Promise.allSettled(pending)
  }
}))
