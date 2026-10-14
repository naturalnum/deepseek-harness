/** Cold interactive disposal waits for the real native factory's unpublished setup and rejects new opens. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createWebConnectionRpc } from '../../../../packages/client/connection/src/client/rpc.ts'
import { installNativeRemote } from '../src/host/native-remote.ts'
import { BrowserAgentAuth } from '../src/host/browser-auth.ts'
import { NativeSessionRead, nativeFollowRequest } from '../src/platform/native-session-read.ts'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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
import { interactivePool } from './native-interactive-pool-fixture.ts'
import { accountUserId } from '../src/account-contracts.ts'

class WireAgentProbe extends Service {
  readonly typertRemote = bindTypertRemote(this, 'nativeWireProbe')
  constructor(ctx: import('@deepseek-ai/cordis').Context) { super(ctx, 'nativeWireProbe') }
  @Remote
  read(agent: Agent): string { return agent.id }
}

const limits = { maxEventBytes: 524288, maxHistoryEvents: 1000, maxHistoryBytes: 8388608,
  leaseMs: 30000, maxPendingPerUser: 8, maxActivePerUser: 2 }

test.each(['closing', 'publishing', 'failed-cleanup',
  'normal-failed-cleanup', 'gateway-wire', 'renew-ack', 'renew-timeout',
  'setup-renew-live', 'setup-renew-ack', 'setup-renew-timeout', 'authority-expiry', 'authority-status-failure',
  'authority-stop-failure', 'authority-retained-blocked', 'authority-cleanup-invalid'] as const)('real cold Agent setup %s keeps original PG durability and lifetime ownership', mode => cloudFixture(async (f) => {
  const expiring = mode.startsWith('authority-')
  let service: NativeRuntimeSessions | undefined
  const setupRenewing = mode.startsWith('setup-renew-'), leaseMs = setupRenewing ? 1000 : 30000
  const tasks = new TaskStore(f.pool, { ...limits, leaseMs, nativeAssistantTtlMs: 20000 }), events = new EventStore(tasks, limits),
    authority = new NativeRuntimeAuthority(f.pool)
  const ownedPool = expiring ? await interactivePool(f.pool, f.root, f.alice.user.userId, () => service?.available ?? true) : undefined
  const issued = ownedPool ? { ...await authority.authenticate(ownedPool.token), token: ownedPool.token }
    : await authority.issue({ userId: f.alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const interactive = new NativeInteractive(tasks, authority, { leaseMs, lifetimeMs: mode === 'authority-expiry' ? 5000 : expiring ? 1200 : 30000, maxActivePerUser: 2 })
  const writers = new NativeSessionWriter(tasks, { leaseMs }), nativeRead = new NativeSessionRead(f.pool)
  const presentation = { maxBatchItems: 32, maxBatchBytes: 1048576, maxItemBytes: 1048576,
    maxActiveBytes: 4194304, maxRingItems: 1024, maxRingBytes: 4194304, ttlMs: 20000, maxEventBytes: limits.maxEventBytes }
  const publisher = new NativeAssistantStore(tasks, events, presentation)
  const inputLimits = { maxEventBytes: limits.maxEventBytes, maxHistoryBytes: limits.maxHistoryBytes,
    maxHistoryEvents: limits.maxHistoryEvents, maxAcceptedAuditBytes: 2097152, maxRevisionBytes: 262144,
    maxCohortInputs: 128, maxCommandBytes: 4194304 }
  const frames = new NativeExecutionFrames(tasks, writers, { maxHistoryEvents: limits.maxHistoryEvents,
    maxHistoryBytes: limits.maxHistoryBytes, maxFrameBytes: 2097152, maxCohortInputs: 128 })
  const verifier: ConstructorParameters<typeof NativeInputLedger>[4] = (client, command) => frames.verifyInTransaction(client, command)
  const ledger = new NativeInputLedger(tasks, writers, events, inputLimits, verifier)
  const config = { input: inputLimits, presentation }, bridge = new NativeInputCommit(tasks, ledger, frames, publisher, writers, config)
  const turn = new NativeTurnContinuationV2(tasks, writers, verifier, { ...inputLimits, leaseMs: limits.leaseMs,
    maxActivePerUser: limits.maxActivePerUser, assistant: presentation }, frames)
  const retained = retainedTestStore({ tasks, writers, publisher, ledger, frames, bridge }, config, turn, expiring ? 256 : 32)()
  const first = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token, undefined, 'standard')
  const second = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token, undefined, 'standard')
  if (mode === 'closing' || mode === 'failed-cleanup') await transaction(f.pool, async (client) => {
    const row = (await client.query<OwnedAppendState>('SELECT id,header,event_count,event_bytes FROM pe_sessions WHERE id=$1 FOR UPDATE', [first.sessionId])).rows[0]
    if (!row) throw new Error('Owned cold fixture Session missing')
    const header = headerSchema.parse(row.header), native = Session.create(header.id, undefined, header)
    native.append('sandbox/mode', { mode: 'read-only' }); native.append('agent-preset/selected', { agentPreset: 'standard' })
    await appendOwnedEvents(client, f.alice.user.userId, row, native.snapshotEvents(), limits)
  })
  const ctx = await harness(), pending = new Set<Promise<void>>()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const renewalEntered = Promise.withResolvers<undefined>(), renewalRelease = Promise.withResolvers<undefined>()
  const reconciliationEntered = Promise.withResolvers<undefined>(), reconciliationRelease = Promise.withResolvers<undefined>()
  let holdReconciliation = mode === 'authority-expiry'
  const renewalRoutes: string[] = [], renewalFailures: string[] = []
  const renewing = mode === 'renew-ack' || mode === 'renew-timeout' || setupRenewing || expiring
  const published: string[] = []
  let calls = 0
  const statusFailures: string[] = []
  const authorityRoutes: Array<{ path: string; code: string }> = []
  const routes: WebRoute[] = []
  const hostServer = createServer((request, response) => {
    const route = routes.find(candidate => candidate.kind === 'prefix' && (request.url ?? '').startsWith(candidate.path))
    if (!route) { response.writeHead(404).end(); return }
    void route.handler(request, response)
  })
  const server = createServer((request, response) => {
    const work = (async () => {
      try {
        const token = bearer(request), input = await readJson(request, 1048576)
        switch (request.url) {
          case '/identity/me': sendJson(response, await f.identities.authenticate(token)); return
          case '/native/sessions/snapshot': sendJson(response, await nativeRead.snapshot(await f.identities.authenticate(token),
            nativeFollowRequest.parse(input))); return
          case NATIVE_RETAINED_ROUTES.prepare: sendJson(response, await retained.prepare(token, input)); return
          case NATIVE_RETAINED_ROUTES.execute: sendJson(response, await retained.execute(token, input)); return
          case NATIVE_RETAINED_ROUTES.reconcile:
          case '/runtime/user/native-intents/reconcile': {
            const actor = await authority.authenticate(token)
            if (z.object({ workerId: z.uuid() }).loose().parse(input).workerId !== actor.runtimeId) throw new PlatformError(401, 'owned_worker_mismatch')
            if (holdReconciliation) {
              holdReconciliation = false; reconciliationEntered.resolve(undefined); await reconciliationRelease.promise
            }
            sendJson(response, await retained.reconcile(input, actor.userId)); return
          }
          case NATIVE_RETAINED_ROUTES.resolve:
          case '/runtime/user/native-intents/resolve': {
            const actor = await authority.authenticate(token)
            if (z.object({ workerId: z.uuid() }).loose().parse(input).workerId !== actor.runtimeId) throw new PlatformError(401, 'owned_worker_mismatch')
            sendJson(response, await retained.resolve(input, actor.userId)); return
          }
          case '/runtime/user/identity': {
            const actor = await authority.authenticate(token)
            const account = await f.pool.query<{ settings: unknown }>('SELECT settings FROM pe_users WHERE id=$1', [actor.userId])
            sendJson(response, { ...actor, settings: account.rows[0]?.settings }); return
          }
          case '/runtime/user/interactive/open': calls++; sendJson(response, await interactive.open(token,
            z.object({ sessionId, requestId, browserToken: z.string(), candidateToken: z.string() }).parse(input))); return
          case '/runtime/interactive/status': {
            if (mode === 'authority-status-failure' && published.includes(first.sessionId)) throw new PlatformError(502, 'owned_status_transport_failure')
            const status = await transaction(f.pool, async (client) => {
              const owner = await tasks.authorized(client, token)
              const pending = await client.query("SELECT 1 FROM pe_operations WHERE session_id=$1 AND id<>$2 AND state IN ('queued','running') LIMIT 1",
                [owner.id, owner.operation_id])
              return { pending: Boolean(pending.rowCount) }
            })
            sendJson(response, { ...status, ...await tasks.renew(token) }); return
          }
          case '/runtime/native-writer/renew':
            renewalRoutes.push('renew'); renewalEntered.resolve(undefined)
            if (!expiring && mode !== 'setup-renew-live') await renewalRelease.promise
            sendJson(response, await routeNativeWriter(writers, request.url, token, input)); return
          case '/runtime/native-writer/release':
            renewalRoutes.push('release'); sendJson(response, await routeNativeWriter(writers, request.url, token, input)); return
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
            if (setupRenewing) renewalRoutes.push('cleanup')
            const value = z.object({ operationId, epoch: z.number(), writer: nativeWriterIdentity, errorCode: z.string() }).parse(input)
            const receipt = await cleanupNativeRuntime(f.pool, token, value, limits)
            sendJson(response, mode === 'authority-cleanup-invalid' ? null : receipt); return
          }
          default: throw new PlatformError(404, 'fixture_route_not_found')
        }
      } catch (error) {
        if (expiring && error instanceof PlatformError) authorityRoutes.push({ path: request.url ?? '', code: error.code })
        if (request.url === '/runtime/interactive/status' && error instanceof PlatformError) statusFailures.push(error.code)
        if (request.url === '/runtime/native-writer/renew' && error instanceof PlatformError) renewalFailures.push(error.code)
        sendFailure(response, error)
      }
    })()
    pending.add(work); void work.finally(() => { pending.delete(work) })
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned listener missing')
    const runtimeTokenFile = join(f.root, 'late-setup-runtime-token')
    await writeFile(runtimeTokenFile, issued.token, { mode: 0o600 })
    await ctx.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, runtimeUserId: issued.userId,
      workerId: issued.runtimeId, runtimeTokenFile, timeoutMs: mode === 'renew-timeout' || mode === 'setup-renew-timeout' ? 1000 : 5000, maxResponseBytes: 8388608 })
    await ctx.plugin(PlatformPersistence)
    await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: '/workspace' })
    await declare(ctx, { id: 'standard', plugins: [] })
    // Only the external execution bind is held; AgentLoop, Session load, preset binding and PG Writer are real.
    ctx.provide('nativeRuntimeExecution', { bind: async () => { entered.resolve(undefined); await release.promise },
      drain: async () => { if (mode === 'failed-cleanup' || mode === 'normal-failed-cleanup' || mode === 'authority-stop-failure') throw new Error('fixture execution cleanup proof failed') } })
    const fiber = await ctx.plugin(NativeRuntimeSessions, { renewMs: renewing ? 50 : 60000 })
    await ctx.inject(['nativeRuntimeSessions'], (owned) => { service = owned.nativeRuntimeSessions })
    if (!service) throw new Error('Actual interactive service inactive')
    ctx.on('agent/created', ({ agent }) => { published.push(agent.id) })
    if (mode === 'gateway-wire') {
      await ctx.plugin(TypertRegistry); await ctx.plugin(TypertGateway); await ctx.plugin(WireAgentProbe)
      ctx.provide('webServer', { register: (route: WebRoute) => {
        routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) }
      }, registerUpgrade: () => () => undefined })
      hostServer.listen(0, '127.0.0.1'); await once(hostServer, 'listening')
      const listener = hostServer.address()
      if (!listener || typeof listener === 'string') throw new Error('Owned native RPC listener missing')
      const origin = `http://127.0.0.1:${listener.port}`
      installNativeRemote(ctx, new BrowserAgentAuth(origin, origin, ctx.powerEvolveRuntime, issued.userId), origin,
        20, 1048576, 8, [], { maxGenerationMs: 10000, maxGenerationItems: 1000, maxGenerationBytes: 1048576 }, 5000)
      release.resolve(undefined)
      expect(ctx.agents.get(first.sessionId)).toBeUndefined()
      const caller = createWebConnectionRpc((route, init) => fetch(new URL(route, origin + '/native/'), {
        ...init, headers: { ...Object.fromEntries(new Headers(init.headers).entries()), origin, authorization: `Bearer ${f.alice.token}` },
      }))
      expect(await caller.call('/api', 'nativeWireProbe/read', { args: { agentId: first.sessionId } }))
        .toEqual({ ok: true, value: first.sessionId })
      expect(calls).toBe(1)
      expect(ctx.agents.get(first.sessionId)?.session.header.id).toBe(first.sessionId)
      expect((await f.pool.query('SELECT source,state FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
        .toEqual([{ source: 'native_interactive', state: 'running' }])
      const missing = await caller.call('/api', 'missing/read', { args: { agentId: second.sessionId } })
      expect(missing).toMatchObject({ ok: false, error: { code: 'gateway/invocation-unavailable' } })
      expect((await f.pool.query('SELECT * FROM pe_operations WHERE session_id=$1', [second.sessionId])).rowCount).toBe(0)
      await service.close(first.sessionId)
      return
    }
    const opening = service.ensure(first.sessionId, f.alice.token)
    const result = opening.then(() => undefined, (error: unknown) => error)
    await Promise.race([entered.promise, result.then((error) => { if (error) throw error })])
    if (setupRenewing) {
      const initial = (await f.pool.query<{ expires_at: Date }>('SELECT expires_at FROM pe_native_writers WHERE session_id=$1',
        [first.sessionId])).rows[0]?.expires_at
      if (!initial) throw new Error('Original setup Writer missing')
      await Promise.race([renewalEntered.promise, delay(1500).then(() => { throw new Error('No Writer renewal while real setup is held') })])
      expect(published).toEqual([])
      expect(ctx.agents.get(first.sessionId)).toBeUndefined()
      if (mode === 'setup-renew-live') {
        await delay(1250)
        const current = (await f.pool.query<{ initialExpired: boolean; writerLive: boolean; grantLive: boolean }>(
          `SELECT clock_timestamp()>$2 AS "initialExpired",w.expires_at>clock_timestamp() AS "writerLive",
            s.lease_until>clock_timestamp() AS "grantLive" FROM pe_native_writers w JOIN pe_sessions s ON s.id=w.session_id
            WHERE w.session_id=$1`, [first.sessionId, initial])).rows[0]
        expect(current).toEqual({ initialExpired: true, writerLive: true, grantLive: true })
        expect(published).toEqual([])
        release.resolve(undefined)
        expect((await opening).id).toBe(first.sessionId)
        await service.close(first.sessionId)
        expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
          .toEqual([{ state: 'completed', error_code: null }])
      } else {
        let settled = false
        const shutdown = service.shutdown().then(() => { settled = true; return undefined },
          (error: unknown) => { settled = true; return error })
        release.resolve(undefined)
        await delay(200)
        expect(settled).toBe(false)
        expect(renewalRoutes).toEqual(['renew'])
        if (mode === 'setup-renew-ack') {
          renewalRelease.resolve(undefined)
          expect(await shutdown).toBeUndefined()
          expect(await result).toBeInstanceOf(Error)
          expect(renewalFailures).toEqual([])
        } else {
          const failed = await result
          expect(failed).toBeInstanceOf(AggregateError)
          if (!(failed instanceof AggregateError)) throw new Error('Expected original setup renewal failure')
          expect(failed.errors).toContainEqual(expect.objectContaining({ name: 'TimeoutError' }))
          expect(await shutdown).toBeInstanceOf(AggregateError)
          await expect(service.close(first.sessionId)).rejects.toBe(failed)
          await expect(service.shutdown()).rejects.toBeInstanceOf(AggregateError)
          renewalRelease.resolve(undefined); await Promise.all(pending)
          expect(renewalFailures).toEqual(['native_writer_lost'])
        }
        expect(renewalRoutes).toEqual(['renew', 'cleanup'])
        expect(published).toEqual([])
        expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
          .toEqual([{ state: 'failed', error_code: 'native_interactive_setup_failed' }])
      }
      expect((await f.pool.query<{ released: boolean }>('SELECT expires_at IS NULL AS released FROM pe_native_writers WHERE session_id=$1',
        [first.sessionId])).rows[0]?.released).toBe(true)
      return
    }
    if (mode === 'closing' || mode === 'failed-cleanup') {
      let disposed = false
      const disposal = fiber.dispose().then(() => { disposed = true }, (error: unknown) => { disposed = true; return error })
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
      const committed = (await f.pool.query<{ event: unknown }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
        [first.sessionId])).rows
      expect(committed).toHaveLength(2)
      expect(committed[0]?.event).toMatchObject({ seq: 0, type: 'session/end-seed', data: {} })
      expect(committed[1]?.event).toMatchObject({ seq: 1, type: 'sandbox/mode', data: { mode: 'read-only' } })
      expect((await f.pool.query('SELECT * FROM pe_native_input_origins WHERE session_id=$1', [first.sessionId])).rowCount).toBe(0)
      if (expiring) {
        if (!ownedPool) throw new Error('Original consumer Pool missing')
        const captured = ctx.powerEvolveRuntime.require(first.sessionId), localPublisher = ctx.powerEvolveRuntime.publication(captured)
        if (mode === 'authority-expiry') {
          for (let index = 0; index < 40; index++) { localPublisher.heartbeat(); await localPublisher.flush() }
          expect((await f.pool.query<{ count: string }>('SELECT count(*) FROM pe_native_retained_intents WHERE operation_id=$1',
            [captured.operationId])).rows[0]?.count).toSatisfy((count: string) => Number(count) > 32)
        } else if (mode === 'authority-retained-blocked') {
          await localPublisher.close()
          const existing = agent.session.snapshotEvents()[1]
          if (!existing) throw new Error('Original acknowledged canonical event missing')
          await ctx.powerEvolveRuntime.call(NATIVE_RETAINED_ROUTES.prepare, captured.token, {
            version: 1, workerId: issued.runtimeId, mutation: { family: 'publication', request: { version: 1,
              epoch: captured.epoch, publisherId: localPublisher.publisherId, batchId: randomUUID(), firstOrdinal: 1,
              items: [{ type: 'event', event: existing }] } },
          })
          expect((await f.pool.query("SELECT 1 FROM pe_native_retained_intents WHERE operation_id=$1 AND state='prepared'",
            [captured.operationId])).rowCount).toBe(1)
        }
        await expect.poll(async () => (await f.pool.query<{ state: string }>('SELECT state FROM pe_operations WHERE session_id=$1',
          [first.sessionId])).rows[0]?.state, { timeout: 10000 }).toBe('failed')
        let settled = false
        const closing = service.close(first.sessionId).then(() => { settled = true; return undefined },
          (error: unknown) => { settled = true; return error })
        if (mode === 'authority-expiry') {
          await Promise.race([reconciliationEntered.promise, closing.then((error) => {
            if (error) throw error
            throw new Error('Original cleanup returned before retained journal proof')
          })])
          expect(service.available).toBe(false)
          await expect(service.ensure(second.sessionId, f.alice.token)).rejects.toMatchObject({ code: 'native_interactive_closing' })
          await delay(50); expect(settled).toBe(false)
          reconciliationRelease.resolve(undefined)
        }
        const originalClose = await closing
        const expected = mode === 'authority-expiry' || mode === 'authority-retained-blocked' || mode === 'authority-cleanup-invalid'
          ? 'native_interactive_closed' : 'native_interactive_close_failed'
        expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
          .toEqual([{ state: 'failed', error_code: expected }])
        expect(statusFailures).toEqual([mode === 'authority-status-failure' ? 'owned_status_transport_failure' : 'native_interactive_authority_lost'])
        expect((await f.pool.query<{ released: boolean }>('SELECT expires_at IS NULL AS released FROM pe_native_writers WHERE session_id=$1',
          [first.sessionId])).rows[0]?.released).toBe(true)
        expect((await f.pool.query('SELECT * FROM pe_native_cleanup_receipts WHERE session_id=$1', [first.sessionId])).rowCount).toBe(1)
        expect(() => { localPublisher.heartbeat() }).not.toThrow()
        expect(() => ctx.powerEvolveRuntime.publication(captured)).toThrow()
        if (mode === 'authority-expiry') {
          expect(originalClose).toBeUndefined()
          expect((await f.pool.query("SELECT 1 FROM pe_native_retained_intents WHERE operation_id=$1 AND (state='prepared' OR resolved_at IS NULL AND state='committed')",
            [captured.operationId])).rowCount).toBe(0)
          expect(await ownedPool.pool.ensure(accountUserId.parse(f.alice.user.userId))).toEqual(ownedPool.original)
          expect(service.available).toBe(true)
          await service.ensure(second.sessionId, f.alice.token)
          expect((await f.pool.query('SELECT source,state FROM pe_operations WHERE session_id=$1', [second.sessionId])).rows)
            .toEqual([{ source: 'native_interactive', state: 'running' }])
          await service.close(second.sessionId)
          await expect(service.shutdown()).resolves.toBeUndefined()
        } else {
          expect(originalClose).toBeInstanceOf(AggregateError)
          if (mode === 'authority-retained-blocked') {
            expect((await f.pool.query("SELECT 1 FROM pe_native_retained_intents WHERE operation_id=$1 AND state='prepared'",
              [captured.operationId])).rowCount).toBe(1)
            expect(authorityRoutes.some(route => route.path === NATIVE_RETAINED_ROUTES.execute)).toBe(false)
          }
          expect(service.available).toBe(false)
          await expect(ownedPool.pool.ensure(accountUserId.parse(f.alice.user.userId))).rejects.toMatchObject({ code: 'native_runtime_ready_timeout' })
          await expect(service.shutdown()).rejects.toBeInstanceOf(AggregateError)
        }
        expect(ownedPool.calls.filter(call => call.method === 'POST' && call.path.endsWith('/pods'))).toHaveLength(1)
        expect((await f.pool.query('SELECT generation FROM pe_native_runtime_instances')).rows).toEqual([{ generation: 1 }])
        return
      }
      if (renewing) {
        await renewalEntered.promise
        let settled = false
        const closing = service.close(first.sessionId).then(() => { settled = true; return undefined },
          (error: unknown) => { settled = true; return error })
        await delay(200)
        expect(settled).toBe(false)
        expect(renewalRoutes).toEqual(['renew'])
        expect((await f.pool.query<{ live: boolean }>('SELECT expires_at>clock_timestamp() AS live FROM pe_native_writers WHERE session_id=$1',
          [first.sessionId])).rows[0]?.live).toBe(true)
        if (mode === 'renew-timeout') {
          const failed = await closing
          expect(failed).toBeInstanceOf(AggregateError)
          if (!(failed instanceof AggregateError)) throw new Error('Expected exact interactive Writer failure')
          expect(failed.errors).toContainEqual(expect.objectContaining({ name: 'TimeoutError' }))
          await expect(service.close(first.sessionId)).rejects.toBe(failed)
          await expect(service.shutdown()).rejects.toBeInstanceOf(AggregateError)
          expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
            .toEqual([{ state: 'failed', error_code: 'native_interactive_close_failed' }])
          renewalRelease.resolve(undefined); await Promise.all(pending)
          expect(renewalFailures).toEqual(['native_writer_lost'])
        } else {
          renewalRelease.resolve(undefined)
          expect(await closing).toBeUndefined()
          expect(renewalRoutes).toEqual(['renew', 'release'])
          expect(renewalFailures).toEqual([])
          expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
            .toEqual([{ state: 'completed', error_code: null }])
        }
        expect((await f.pool.query<{ released: boolean }>('SELECT expires_at IS NULL AS released FROM pe_native_writers WHERE session_id=$1',
          [first.sessionId])).rows[0]?.released).toBe(true)
        return
      }
      if (mode === 'normal-failed-cleanup') {
        await expect(service.close(first.sessionId)).rejects.toBeInstanceOf(AggregateError)
        await expect(service.shutdown()).rejects.toBeInstanceOf(AggregateError)
        expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
          .toEqual([{ state: 'failed', error_code: 'native_interactive_close_failed' }])
      } else {
        await service.close(first.sessionId)
        expect((await f.pool.query('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [first.sessionId])).rows)
          .toEqual([{ state: 'completed', error_code: null }])
      }
    }
    expect((await f.pool.query('SELECT * FROM pe_operations WHERE session_id=$1', [second.sessionId])).rowCount).toBe(0)
  } finally {
    reconciliationRelease.resolve(undefined)
    renewalRelease.resolve(undefined)
    release.resolve(undefined)
    hostServer.closeAllConnections(); if (hostServer.listening) await new Promise<void>((resolve,
      reject) => hostServer.close((error) => { if (error) reject(error); else resolve() }))
    await ctx.fiber.dispose()
    server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve,
      reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    await Promise.allSettled(pending)
    await ownedPool?.close()
  }
}))
