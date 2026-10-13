/** Actual PG owners and ledger receipts through two owned HTTP endpoints; no Host composition claim. */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { expect, test } from 'vitest'
import { PlatformError, requestId } from '../src/contracts.ts'
import { admittedInputMessage, nativeInputAdmissionCommand, nativeInputQueueCommand, originInputId,
  type NativeInputQueueCommand, type NativeInputLedgerLimits } from '../src/native-input-ledger-contracts.ts'
import { loadNativeInputOwnerRoutingConfig, nativeInputOwnerRoutingConfig } from '../src/native-input-owner-routing-config.ts'
import { nativeTurnMessageId } from '../src/native-turn-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { CURRENT_SCHEMA_VERSION, transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputLedger, NativeInputNativePlanner } from '../src/platform/native-input-ledger.ts'
import { NativeInputOwnerRouting } from '../src/platform/native-input-owner-routing.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
type Owned = Awaited<ReturnType<typeof prepare>>
type Reply = 'actual' | 'invalid-json' | 'extra-token' | 'wrong-session' | 'wrong-user' | 'wrong-nonce'
  | 'wrong-digest' | 'writer-actor' | 'wrong-kind' | 'oversize-length' | 'oversize-stream' | 'timeout' | 'timeout-body'
  | 'redirect' | 'platform-error' | 'invalid-error'
const taskLimits = { maxEventBytes: 524_288, maxHistoryBytes: 8_388_608, maxHistoryEvents: 1000,
  leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 2 }
const ledgerLimits: NativeInputLedgerLimits = { maxEventBytes: taskLimits.maxEventBytes,
  maxHistoryBytes: taskLimits.maxHistoryBytes, maxHistoryEvents: taskLimits.maxHistoryEvents,
  maxAcceptedAuditBytes: 524_288, maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 }

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned routing fixture returned no row')
  return row
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Owned HTTP request was not bytes')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function endpoint(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.statusCode = error instanceof PlatformError ? error.status : 500
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: error instanceof PlatformError ? error.code : 'owned_fixture_failure' }))
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Owned HTTP listener lacks an IP port')
  return { origin: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  } }
}

async function prepare(f: Fixture, ctx: Context) {
  const frameFile = process.env.PE_NATIVE_TURN_TEST_DDL_FILE, ledgerFile = process.env.PE_NATIVE_INPUT_TEST_DDL_FILE
  const tables = ['pe_native_turn_frames', 'pe_native_input_origins', 'pe_native_input_commands', 'pe_native_input_revisions',
    'pe_native_input_cohorts', 'pe_native_input_claims', 'pe_native_turn_transitions_v2']
  const inspect = async () => (await f.pool.query<{ name: string; present: boolean }>(
    "SELECT name,to_regclass('public.'||name) IS NOT NULL AS present FROM unnest($1::text[]) AS needed(name)",
    [[...tables, 'pe_native_turn_transitions']])).rows
  const versions = (await f.pool.query<{ family: string; version: number }>('SELECT family,version FROM pe_schema')).rows
  if (versions.length !== 1 || first(versions).family !== 'cloud-native') throw new Error('Invalid cloud fixture schema metadata')
  const present = await inspect()
  if (frameFile !== undefined || ledgerFile !== undefined) {
    if (!frameFile || !ledgerFile || first(versions).version !== 4 || present.some(row => row.present)) {
      throw new Error('Private routing DDL requires an empty schema4 extension and both complete files')
    }
    await f.pool.query(await readFile(frameFile, 'utf8'))
    await f.pool.query(await readFile(ledgerFile, 'utf8'))
    const installed = await inspect()
    if (tables.filter(name => name !== 'pe_native_turn_transitions_v2').some(name => !installed.find(row => row.name === name)?.present)) {
      throw new Error('Private routing DDL did not install every required table')
    }
  } else if (first(versions).version !== CURRENT_SCHEMA_VERSION || tables.some(name => !present.find(row => row.name === name)?.present)
    || present.find(row => row.name === 'pe_native_turn_transitions')?.present) {
    throw new Error(`Routing tests require complete formal cloud-native schema${CURRENT_SCHEMA_VERSION}`)
  }
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const acceptedId = requestId.parse(randomUUID())
  await tasks.accept(f.alice.user, created.sessionId, acceptedId, 'Original routed input', f.alice.token)
  const workerA = nativeWriterWorkerId.parse(randomUUID()), workerB = nativeWriterWorkerId.parse(randomUUID())
  const grant = await tasks.claim(workerA)
  if (!grant) throw new Error('Actual routing operation was not claimed')
  const writers = new NativeSessionWriter(tasks, { leaseMs: 20_000 })
  const acquire = { sessionId: created.sessionId, workerId: workerA, token: randomBytes(32).toString('base64url') }
  const leased = await writers.acquire(grant.token, acquire)
  const authority = { writer: nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch }), operationToken: grant.token }
  const events = new EventStore(tasks, taskLimits)
  const frames = new NativeExecutionFrames(tasks, writers, { maxHistoryEvents: taskLimits.maxHistoryEvents,
    maxHistoryBytes: taskLimits.maxHistoryBytes, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  await ctx.plugin(SessionProjectionRegistry)
  ctx.effect(() => ctx.sessionProjections.register(inboxProjectionDefinition))
  const ledger = new NativeInputLedger(tasks, writers, events, ledgerLimits,
    (client, command) => frames.verifyInTransaction(client, command), new NativeInputNativePlanner(ctx.sessionProjections))
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>(
    'SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const native = Session.create(header.id, undefined, header)
  const content = first((await f.pool.query<{ admitted: unknown }>(
    'SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [created.sessionId, acceptedId])).rows).admitted
  const message = admittedInputMessage.parse({ id: nativeTurnMessageId.parse(randomUUID()), role: 'user',
    source: { kind: 'user', rpcId: acceptedId }, content })
  if (message.source.kind !== 'user') throw new Error('Owned routing admission lacks the original browser request source')
  const admission = nativeInputAdmissionCommand.parse({ rpcNonce: 'owned-routing-admission', sessionId: created.sessionId,
    originInputId: originInputId.parse(randomUUID()), originOperationId: grant.operationId, messageId: message.id, target: 'next-turn' })
  await ledger.admit(f.alice.token, { command: admission, authority, expectedEventCount: 0,
    events: [native.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ ...message, source: message.source }] })] })
  await transaction(f.pool, client => frames.prepareInTransaction(client, authority, admission.originInputId))
  const command = nativeInputQueueCommand.parse({ rpcNonce: 'original-browser-nonce', payload: {
    sessionId: created.sessionId, itemId: message.id, action: { kind: 'edit', content: [{ type: 'text', text: 'Original wire replacement' }] },
  } })
  return { ledger, grant, authority, workerA, workerB, command }
}

async function routingCase(run: (f: Fixture, n: Owned, ports: {
  wireA: {
    readonly method: string | undefined
    readonly path: string | undefined
    readonly authorization: string | undefined
    readonly raw: string
  }[]
  wireB: string[]
  ownerOrigin: string
  ingressOrigin: string
  setReply: (reply: Reply) => void
  router: (options?: { mapped?: boolean; timeoutMs?: number; maxResponseBytes?: number }) => NativeInputOwnerRouting
}) => Promise<void>): Promise<void> {
  await cloudFixture(async (f) => {
    const ctx = new Context()
    let a: Awaited<ReturnType<typeof endpoint>> | undefined, b: Awaited<ReturnType<typeof endpoint>> | undefined
    try {
      const n = await prepare(f, ctx)
      const wireA: { method: string | undefined; path: string | undefined; authorization: string | undefined; raw: string }[] = []
      const wireB: string[] = []
      let reply: Reply = 'actual'
      a = await endpoint(async (req, res) => {
        const raw = await body(req)
        wireA.push({ method: req.method, path: req.url, authorization: req.headers.authorization, raw })
        res.setHeader('content-type', 'application/json')
        if (reply === 'timeout') return
        if (reply === 'timeout-body') { res.flushHeaders(); res.write('{'); return }
        if (reply === 'redirect') { res.statusCode = 307; res.setHeader('location', b?.origin ?? '/'); res.end('{}'); return }
        if (reply === 'platform-error') { res.statusCode = 409; res.end('{"error":"native_input_already_consumed"}'); return }
        if (reply === 'invalid-error') { res.statusCode = 409; res.end('{"success":true}'); return }
        if (reply === 'invalid-json') { res.end('{'); return }
        if (reply === 'oversize-length') { res.setHeader('content-length', 1_000_000); res.end('x'); return }
        if (reply === 'oversize-stream') { res.write(' '.repeat(4096)); res.end('{}'); return }
        const command = nativeInputQueueCommand.parse(JSON.parse(raw))
        const credential = req.headers.authorization?.slice('Bearer '.length)
        if (!credential) throw new PlatformError(401, 'unauthorized')
        // This HTTP test adapter calls actual PG planning/commit, not a NativeInputCoordinator or a Host profile.
        const result = await n.ledger.queue(credential, command, n.authority)
        const changed = reply === 'extra-token' ? { ...result, token: 'refused-extra-field' }
          : reply === 'wrong-session' ? { ...result, sessionId: randomUUID() }
            : reply === 'wrong-user' ? { ...result, actor: { kind: 'browser', userId: f.bob.user.userId } }
              : reply === 'wrong-nonce' ? { ...result, rpcNonce: 'other-nonce' }
                : reply === 'wrong-digest' ? { ...result, payloadDigest: 'f'.repeat(64) }
                  : reply === 'writer-actor' ? { ...result, actor: { kind: 'writer', userId: f.alice.user.userId,
                    workerId: n.workerA, writerEpoch: n.authority.writer.epoch } }
                    : reply === 'wrong-kind' ? { ...result, kind: 'admission' } : result
        res.end(JSON.stringify(changed))
      })
      const ownerOrigin = a.origin
      const replay = (credential: string, command: NativeInputQueueCommand) => transaction(f.pool,
        client => n.ledger.lookupQueueReceiptInTransaction(client, credential, command))
      const router = (options: { mapped?: boolean; timeoutMs?: number; maxResponseBytes?: number } = {}) =>
        new NativeInputOwnerRouting(f.pool, { workerOrigins: options.mapped === false ? { [n.workerB]: b!.origin }
          : { [n.workerA]: ownerOrigin, [n.workerB]: b!.origin }, timeoutMs: options.timeoutMs ?? 2000,
        maxResponseBytes: options.maxResponseBytes ?? 65_536 }, replay)
      b = await endpoint(async (req, res) => {
        const raw = await body(req); wireB.push(raw)
        const command = nativeInputQueueCommand.parse(JSON.parse(raw))
        const credential = req.headers.authorization?.slice('Bearer '.length)
        if (!credential) throw new PlatformError(401, 'unauthorized')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(await router().queue(credential, command)))
      })
      await run(f, n, { wireA, wireB, ownerOrigin, ingressOrigin: b.origin, router, setReply: (value) => { reply = value } })
    } finally {
      try { if (b) await b.close() }
      finally { try { if (a) await a.close() } finally { await ctx.fiber.dispose() } }
    }
  })
}

test('browser ingress B forwards the original bearer and command only to actual PG Writer/attempt A', () =>
  routingCase(async (f, n, ports) => {
    const response = await fetch(new URL('/browser/queue', ports.ingressOrigin), { method: 'POST',
      headers: { authorization: `Bearer ${f.alice.token}`, 'content-type': 'application/json' }, body: JSON.stringify(n.command) })
    expect(response.status).toBe(200)
    const receipt: unknown = await response.json()
    expect(receipt).toMatchObject({ sessionId: n.command.payload.sessionId, actor: { kind: 'browser', userId: f.alice.user.userId },
      rpcNonce: n.command.rpcNonce, kind: 'edit', result: { kind: 'pending', inputRevision: 2 } })
    expect(ports.wireB).toEqual([JSON.stringify(n.command)])
    expect(ports.wireA).toEqual([{ method: 'POST', path: '/native/input/queue', authorization: `Bearer ${f.alice.token}`,
      raw: JSON.stringify(n.command) }])
    expect(first((await f.pool.query<{ receipt: unknown }>(
      'SELECT receipt_json AS receipt FROM pe_native_input_commands WHERE transport_nonce=$1', [n.command.rpcNonce])).rows).receipt).toEqual(receipt)
    expect(first((await f.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM pe_attempts')).rows).n).toBe('1')
  }))

test('actual immutable PG replay returns before owner discovery after both leases expire; a changed nonce payload refuses', () =>
  routingCase(async (f, n, ports) => {
    const receipt = await ports.router().queue(f.alice.token, n.command)
    await f.pool.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second'")
    await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second'")
    expect(await ports.router().queue(f.alice.token, n.command)).toEqual(receipt)
    await expect(ports.router().queue(f.alice.token, { ...n.command, payload: { ...n.command.payload, action: { kind: 'remove' } } }))
      .rejects.toMatchObject({ status: 409, code: 'native_input_nonce_conflict' })
    expect(ports.wireA).toHaveLength(1)
  }))

test('a different authenticated user cannot discover or forward the Session owner', () => routingCase(async (f, n, ports) => {
  await expect(ports.router().queue(f.bob.token, n.command)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
  expect(ports.wireA).toHaveLength(0)
}))

test.each(['writer-expired', 'operation-expired', 'attempt-worker', 'attempt-epoch', 'attempt-ended',
  'operation-ended', 'operation-canceled', 'writer-absent'] as const)('actual %s refuses before HTTP forwarding', change =>
  routingCase(async (f, n, ports) => {
    if (change === 'writer-expired') await f.pool.query("UPDATE pe_native_writers SET expires_at=clock_timestamp()-interval '1 second'")
    else if (change === 'operation-expired') await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second'")
    else if (change === 'attempt-worker') await f.pool.query('UPDATE pe_attempts SET worker_id=$1', [n.workerB])
    else if (change === 'attempt-epoch') await f.pool.query('UPDATE pe_sessions SET lease_epoch=lease_epoch+1')
    else if (change === 'attempt-ended') await f.pool.query('UPDATE pe_attempts SET ended_at=clock_timestamp()')
    else if (change === 'operation-ended') await f.pool.query("UPDATE pe_operations SET state='completed'")
    else if (change === 'operation-canceled') await f.pool.query("UPDATE pe_operations SET error_code='cancel_requested'")
    else await f.pool.query('DELETE FROM pe_native_writers')
    await expect(ports.router().queue(f.alice.token, n.command)).rejects.toMatchObject({ status: 409, code: 'native_input_owner_unavailable' })
    expect(ports.wireA).toHaveLength(0); expect(ports.wireB).toHaveLength(0)
  }))

test('a live unmapped owner refuses instead of using mapped browser Host B', () => routingCase(async (f, n, ports) => {
  await expect(ports.router({ mapped: false }).queue(f.alice.token, n.command))
    .rejects.toMatchObject({ status: 503, code: 'native_input_owner_unmapped' })
  expect(ports.wireA).toHaveLength(0); expect(ports.wireB).toHaveLength(0)
}))

test.each(['writer', 'operation'] as const)('%s expiry during an actual owner row-lock wait refuses after the wait', clock =>
  routingCase(async (f, n, ports) => {
    const expiry = clock === 'writer'
      ? "UPDATE pe_native_writers SET expires_at=clock_timestamp()+interval '1 second'"
      : "UPDATE pe_sessions SET lease_until=clock_timestamp()+interval '1 second'"
    await f.pool.query(expiry)
    const blocker = await f.pool.connect()
    let pending: Promise<{ allowed: true } | { allowed: false; error: unknown }> | undefined
    try {
      const pid = first((await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows).pid
      await blocker.query('BEGIN')
      await blocker.query('SELECT session_id FROM pe_native_writers WHERE session_id=$1 FOR UPDATE', [n.command.payload.sessionId])
      pending = ports.router().queue(f.alice.token, n.command).then(() => ({ allowed: true as const }),
        (error: unknown) => ({ allowed: false as const, error }))
      await expect.poll(async () => first((await f.pool.query<{ waiting: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
          AND strpos(query,'FOR SHARE OF w,o,a')>0) AS waiting`, [pid])).rows).waiting,
      { timeout: 10_000, interval: 10 }).toBe(true)
      const clockSql = clock === 'writer'
        ? 'SELECT expires_at<=clock_timestamp() AS expired FROM pe_native_writers WHERE session_id=$1'
        : 'SELECT lease_until<=clock_timestamp() AS expired FROM pe_sessions WHERE id=$1'
      await expect.poll(async () => first((await blocker.query<{ expired: boolean }>(clockSql,
        [n.command.payload.sessionId])).rows).expired, { timeout: 10_000, interval: 10 }).toBe(true)
      await blocker.query('COMMIT')
      const outcome = await pending
      expect(outcome.allowed).toBe(false)
      if (outcome.allowed) throw new Error('Expired owner unexpectedly authorized')
      expect(outcome.error).toMatchObject({ status: 409, code: 'native_input_owner_unavailable' })
      expect(ports.wireA).toHaveLength(0)
    } finally {
      try { await blocker.query('ROLLBACK') }
      finally { blocker.release(); if (pending) await pending }
    }
  }))

test.each(['invalid-json', 'extra-token', 'wrong-session', 'wrong-user', 'wrong-nonce', 'wrong-digest', 'writer-actor',
  'wrong-kind', 'invalid-error'] as const)('forwarded %s response refuses without replacing it with success', mode =>
  routingCase(async (f, n, ports) => {
    ports.setReply(mode)
    await expect(ports.router().queue(f.alice.token, n.command)).rejects.toMatchObject({ status: 502,
      code: ['invalid-json', 'extra-token', 'invalid-error'].includes(mode)
        ? 'native_input_owner_response_invalid' : 'native_input_owner_response_mismatch' })
    expect(ports.wireA).toHaveLength(1); expect(ports.wireB).toHaveLength(0)
  }))

test.each(['oversize-length', 'oversize-stream'] as const)('%s enforces the configured reply budget', mode =>
  routingCase(async (f, n, ports) => {
    ports.setReply(mode)
    await expect(ports.router({ maxResponseBytes: 1024 }).queue(f.alice.token, n.command))
      .rejects.toMatchObject({ status: 502, code: 'native_input_owner_response_budget' })
    expect(ports.wireA).toHaveLength(1)
  }))

test.each(['timeout', 'timeout-body'] as const)('%s enforces one HTTP deadline including the response stream', mode =>
  routingCase(async (f, n, ports) => {
    ports.setReply(mode)
    await expect(ports.router({ timeoutMs: 100 }).queue(f.alice.token, n.command))
      .rejects.toMatchObject({ status: 504, code: 'native_input_owner_timeout' })
    expect(ports.wireA).toHaveLength(1)
  }))

test('redirects cannot send a browser bearer to another Host', () => routingCase(async (f, n, ports) => {
  ports.setReply('redirect')
  await expect(ports.router().queue(f.alice.token, n.command)).rejects.toMatchObject({ status: 502, code: 'native_input_owner_unavailable' })
  expect(ports.wireA).toHaveLength(1); expect(ports.wireB).toHaveLength(0)
}))

test('strict owner PlatformError status and code survive forwarding', () => routingCase(async (f, n, ports) => {
  ports.setReply('platform-error')
  await expect(ports.router().queue(f.alice.token, n.command)).rejects.toMatchObject({ status: 409, code: 'native_input_already_consumed' })
  expect(ports.wireA).toHaveLength(1)
}))

test('only required operator UUID origins and positive forwarding budgets load from a private absolute file', () =>
  cloudFixture(async (f) => {
    const workerId = randomUUID(), valid = { workerOrigins: { [workerId]: 'http://127.0.0.1:41000' }, timeoutMs: 1000, maxResponseBytes: 4096 }
    const filename = join(f.root, 'owner-routing.json')
    await writeFile(filename, JSON.stringify(valid), { mode: 0o600 })
    expect(await loadNativeInputOwnerRoutingConfig(filename)).toEqual(valid)
    for (const value of [ { workerOrigins: valid.workerOrigins, maxResponseBytes: 4096 }, { ...valid, timeoutMs: 0 },
      { ...valid, maxResponseBytes: 0 }, { ...valid, workerOrigins: { invalid: 'http://127.0.0.1:41000' } },
      { ...valid, workerOrigins: { [workerId]: 'http://127.0.0.1:41000/other' } },
      { ...valid, workerOrigins: { [workerId]: 'http://user:secret@127.0.0.1:41000' } },
      { ...valid, workerOrigins: { [workerId]: 'file:///tmp/owner' } },
      { ...valid, workerOrigins: { [workerId]: 'not-an-absolute-url' } }, { ...valid, browserUrl: 'http://127.0.0.1:41000' } ]) {
      expect(nativeInputOwnerRoutingConfig.safeParse(value).success).toBe(false)
    }
    await expect(loadNativeInputOwnerRoutingConfig('owner-routing.json')).rejects.toThrow('Invalid native input owner routing configuration')
    await writeFile(filename, '{', { mode: 0o600 })
    await expect(loadNativeInputOwnerRoutingConfig(filename)).rejects.toThrow('Invalid native input owner routing configuration')
  }))
