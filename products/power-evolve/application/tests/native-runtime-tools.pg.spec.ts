/** Actual PG request series retain their Header across steps without admitting another operation or inherited seed. */
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { Session, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { DeepSeekSearchProvider, type DeepSeekSearchLlmRequest } from '@deepseek-ai/dsh-web-search-deepseek'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeExecutionAuthority } from '../src/platform/native-execution-authority.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSubagents } from '../src/platform/native-subagents.ts'
import { readNativeModelTools, registerNativeToolNames } from '../src/platform/native-tool-catalog.ts'
import { proxyNativeWebSearch } from '../src/platform/native-web-search.ts'
import { transaction } from '../src/platform/database.ts'
import { readJson, sendFailure, sendJson } from '../src/http.ts'
import { headerSchema } from '../src/session-records.ts'
import { requestId } from '../src/contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { admittedInputMessage, nativeInputAdmissionCommand, nativeInputClaimCommand, nativeInputStepCommand, originInputId } from '../src/native-input-ledger-contracts.ts'
import { nativeTurnMessageId } from '../src/native-turn-contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524288, maxHistoryBytes: 67108864, maxHistoryEvents: 100000, leaseMs: 30000,
  maxPendingPerUser: 8, maxActivePerUser: 2 }
const historyLimits = { maxHistoryBytes: limits.maxHistoryBytes, maxHistoryEvents: limits.maxHistoryEvents }
const inputLimits = { ...historyLimits, maxEventBytes: limits.maxEventBytes, maxCohortInputs: 128,
  maxAcceptedAuditBytes: 2097152, maxRevisionBytes: 262144, maxCommandBytes: 4194304 }
const nativeTool = { name: 'native_registered', description: 'Original native description', parameters: { type: 'object' } }
const external = { name: 'mcp__original__tool', description: 'Original catalog description', parameters: { type: 'object' } }
type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned Header fixture returned no row')
  return row
}

/** Claim and bind the original admission through the production Frame, ledger and Writer services. */
async function prepare(f: Fixture) {
  const tasks = new TaskStore(f.pool, limits), events = new EventStore(tasks, limits)
  const runtime = await new NativeRuntimeAuthority(f.pool).issue({ userId: f.alice.user.userId,
    runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const rpcId = requestId.parse(randomUUID())
  await tasks.accept(f.alice.user, created.sessionId, rpcId, 'Original Header owner', f.alice.token)
  const original = await tasks.claim(runtime.runtimeId)
  if (!original) throw new Error('Owned Header operation was not claimed')
  const workerId = nativeWriterWorkerId.parse(runtime.runtimeId), writers = new NativeSessionWriter(tasks, { leaseMs: 30000 })
  const acquire = { sessionId: original.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const leased = await writers.acquire(original.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch })
  const authority = { writer, operationToken: original.token }
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const session = Session.create(header.id, undefined, header), history: SessionEvent[] = []
  const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2097152, maxCohortInputs: 128 })
  const ledger = new NativeInputLedger(tasks, writers, events, inputLimits,
    (client, command) => frames.verifyInTransaction(client, command))
  const admitted = first((await f.pool.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [header.id, rpcId])).rows).admitted
  const message = admittedInputMessage.parse({ id: nativeTurnMessageId.parse(randomUUID()), role: 'user', source: { kind: 'user', rpcId }, content: admitted })
  const origin = originInputId.parse(randomUUID()), admission = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  history.push(admission)
  await ledger.admit(f.alice.token, { command: nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: header.id,
    originInputId: origin, originOperationId: original.operationId, messageId: message.id, target: 'next-turn' }),
  authority, expectedEventCount: 0, events: [admission] })
  const frame = await transaction(f.pool, client => frames.prepareInTransaction(client, authority, origin))
  const execution = new NativeExecutionAuthority((client, owned, token) => frames.readExecutionInTransaction(client, owned, token),
    { ...historyLimits, maxCohortInputs: 128, maxFactBytes: 2097152 })
  const business = new TaskStore(f.pool, limits, (client, owned, token) => execution.assertExecutionInTransaction(client, owned, token))
  const initial = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: randomUUID(), boundaryKind: 'initial-turn-step',
    frame: { sessionId: header.id, operationId: original.operationId, operationEpoch: original.epoch,
      writerEpoch: writer.epoch, frozenSnapshotDigest: frame.frozenSnapshotDigest } })
  const claimed = [session.append('turn/start', { turn: 1 }),
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
  await ledger.claim({ command: initial, authority, expectedEventCount: history.length, events: claimed }); history.push(...claimed)
  const append = async (event: SessionEvent) => { await events.append(original.token, [event]); history.push(event) }
  const step = async (number: number, command = initial) => {
    const event = session.append('step/start', { turn: 1, step: number })
    await transaction(f.pool, async (client) => {
      const owner = await tasks.authorized(client, original.token)
      await events.appendInTransaction(client, owner, [event])
      await ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: command.cohortId,
        frame: command.frame, stepStartSeq: event.seq }), authority)
    }); history.push(event)
  }
  await step(1)
  return { tasks, business, events, writers, writer, runtime, original, authority, session, history, ledger, initial, append, step }
}

function header(session: Session) {
  return session.append('request/header', { header: { config: { provider: 'power-evolve', model: 'trial-model' },
    tools: [nativeTool, external] }, reason: 'initial' })
}

const registration = { names: [nativeTool.name], tools: [nativeTool] }

test('native runtime requires its committed source and retains the original native and external schemas across a real continuing step', () => cloudFixture(async (f) => {
  const n = await prepare(f)
  const read = (admitted: Parameters<typeof readNativeModelTools>[2] = []) => transaction(f.pool,
    async client => readNativeModelTools(client, await n.business.executionAuthorized(client, n.original.token), admitted))
  await expect(read()).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  await registerNativeToolNames(n.business, n.original.token, registration)
  await expect(read()).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  const event = header(n.session)
  await expect(registerNativeToolNames(n.business, n.original.token, { ...registration, headerSeq: event.seq }))
    .rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  await n.append(event)
  // A committed Header alone cannot activate legacy names-only authorization for a native Runtime.
  await expect(read([external])).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  await registerNativeToolNames(n.business, n.original.token, { ...registration, headerSeq: event.seq })
  expect(await read([external])).toEqual([nativeTool])
  await expect(read([{ ...external, parameters: { type: 'object', additionalProperties: false } }]))
    .rejects.toMatchObject({ code: 'model_tool_not_authorized' })
  await n.append(n.session.append('step/end', { turn: 1, step: 1 }))
  const continuation = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: randomUUID(),
    frame: n.initial.frame, boundaryKind: 'continuing-step' })
  await n.ledger.claim({ command: continuation, authority: n.authority, expectedEventCount: n.history.length, events: [] })
  await n.step(2, continuation)
  expect(await read([external])).toEqual([nativeTool])
  await registerNativeToolNames(n.business, n.original.token, { ...registration, headerSeq: event.seq })
  expect(await read([external])).toEqual([nativeTool])
  expect((await f.pool.query('SELECT boundary_ordinal,owner_kind FROM pe_native_input_cohorts WHERE cohort_id=$1', [continuation.cohortId])).rows)
    .toEqual([{ boundary_ordinal: 1, owner_kind: 'current-frame' }])
}))

test.each(['fresh', 'inherited', 'missing-marker'] as const)('derived child Header source %s requires its explicit creation or inherited seed source and a new committed child request', mode => cloudFixture(async (f) => {
  const n = await prepare(f), parentHeader = header(n.session)
  await n.append(parentHeader)
  await registerNativeToolNames(n.business, n.original.token, { ...registration, headerSeq: parentHeader.seq })
  const childHeader = headerSchema.parse({ ...n.session.header, id: randomUUID(), origin: 'subagent',
    parentSession: n.original.sessionId, delegationDepth: 1, isSeeded: mode !== 'fresh', cwd: '/workspace' })
  const child = await new NativeSubagents(n.business, { maxChildren: 1, maxDepth: 2, lifetimeMs: 60000, leaseMs: 30000 })
    .create(n.original.token, childHeader)
  const acquire = { sessionId: child.sessionId, workerId: n.writer.workerId, token: randomBytes(32).toString('base64url') }
  await n.writers.acquire(child.token, acquire)
  const seed = mode === 'fresh' ? undefined : buildForkSeed(n.session.snapshotEvents(), parentHeader.seq)
  const native = Session.create(childHeader.id, seed, childHeader, seed === undefined ? undefined : SessionLogOffset(parentHeader.seq + 1))
  native.append('turn/start', { turn: 1 }); native.append('step/start', { turn: 1, step: 1 })
  await n.events.append(child.token, native.snapshotEvents())
  const read = () => transaction(f.pool, async client => readNativeModelTools(client,
    await n.business.executionAuthorized(client, child.token), [external]))
  await expect(read()).rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  if (mode !== 'fresh') {
    await expect(registerNativeToolNames(n.business, child.token, { ...registration, headerSeq: parentHeader.seq }))
      .rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
  }
  const ownHeader = header(native)
  await n.events.append(child.token, native.snapshotEvents())
  if (mode === 'missing-marker') {
    // Deliberate corruption of this owned test database proves that absence never supplies a zero seed boundary.
    await f.pool.query("DELETE FROM pe_events WHERE session_id=$1 AND event->>'type'='session/end-seed'", [child.sessionId])
    const before = (await f.pool.query('SELECT * FROM pe_native_preferences ORDER BY namespace')).rows
    await expect(registerNativeToolNames(n.business, child.token, { ...registration, headerSeq: ownHeader.seq }))
      .rejects.toMatchObject({ code: 'native_tool_snapshot_missing' })
    expect((await f.pool.query('SELECT * FROM pe_native_preferences ORDER BY namespace')).rows).toEqual(before)
  } else {
    await registerNativeToolNames(n.business, child.token, { ...registration, headerSeq: ownHeader.seq })
    expect(await read()).toEqual([nativeTool])
    const saved = first((await f.pool.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE namespace=$1',
      [`runtime-tools:${child.operationId}:${child.epoch}`])).rows).value
    expect(saved).toMatchObject({ headerSeq: ownHeader.seq, source: { kind: mode === 'fresh' ? 'subagent-create' : 'subagent-seed', operationId: child.operationId,
      epoch: child.epoch, preparedEventCount: mode === 'fresh' ? 0 : parentHeader.seq + 2 } })
  }
}))

type SearchBody = DeepSeekSearchLlmRequest['body']
function searchBody(query: string): SearchBody {
  return { model: 'trial-model', max_tokens: 1000,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] }
}

async function searchProxy(n: Awaited<ReturnType<typeof prepare>>, run: (http: {
  origin: string
  observed: { body: unknown; apiVersion: string | string[] | undefined; key: string | string[] | undefined }[]
  post: (body: SearchBody, version?: string) => Promise<{ status: number; body: unknown }>
}) => Promise<void>, concurrent = false) {
  const observed: { body: unknown; apiVersion: string | string[] | undefined; key: string | string[] | undefined }[] = []
  const waiting: { response: ServerResponse; query: string }[] = []
  const upstream = createServer((request, response) => {
    void (async () => {
      const body = await readJson(request, 65536)
      const query = z.object({ messages: z.tuple([z.object({ content: z.tuple([z.object({ text: z.string() })]) })]) })
        .parse(body).messages[0].content[0].text
      observed.push({ body, apiVersion: request.headers['anthropic-version'], key: request.headers['x-api-key'] })
      waiting.push({ response, query })
      if (concurrent && waiting.length < 2) return
      for (const item of waiting.splice(0)) sendJson(item.response, { content: [{ type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://search-fixture.example/' + encodeURIComponent(item.query),
          title: item.query }] }] })
    })().catch((error: unknown) => { sendFailure(response, error) })
  })
  const listen = async (server: ReturnType<typeof createServer>) => {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Owned Search fixture address missing')
    return `http://127.0.0.1:${address.port}`
  }
  const endpoint = await listen(upstream)
  const platform = createServer((request, response) => {
    void proxyNativeWebSearch(n.business, { url: endpoint, apiKey: 'owned-search-fixture-key', timeoutMs: 3000,
      maxRequestBytes: 65536, maxResponseBytes: 65536, maxUses: 5 }, request, response)
      .catch((error: unknown) => { sendFailure(response, error) })
  })
  try {
    const origin = await listen(platform)
    await run({ origin, observed, post: async (body, version = '2023-06-01') => {
      const response = await fetch(origin + '/runtime/web-search/messages', { method: 'POST',
        headers: { authorization: 'Bearer ' + n.original.token, 'content-type': 'application/json', 'anthropic-version': version },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      return { status: response.status, body: await response.json() }
    } })
  } finally {
    for (const server of [platform, upstream]) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    }
  }
}

test('concurrent native Search queries each match their own durable current-step input over actual HTTP', () => cloudFixture(async (f) => {
  const n = await prepare(f)
  await searchProxy(n, async ({ origin, observed }) => {
    const recorded: SessionEvent[] = [], ready = Promise.withResolvers<undefined>()
    let committed: Promise<unknown> | undefined
    const provider = new DeepSeekSearchProvider(() => ({ baseURL: origin + '/runtime/web-search',
      model: 'trial-model', maxTokens: 1000, maxUses: 5, apiVersion: '2023-06-01', apiKey: n.original.token,
      recordRequest: (request) => {
        recorded.push(n.session.append('web/deepseek-search-llm-request', request))
        if (recorded.length === 2) ready.resolve(undefined)
      }, fetch: async (address: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        await ready.promise
        await (committed ??= n.events.append(n.original.token, recorded))
        return await fetch(address, init)
      },
    }))
    const queries = ['current official Linux kernel release', 'kernel.org latest stable kernel version']
    const results = await Promise.allSettled(queries.map(query => provider.search({ query }, AbortSignal.timeout(5000))))
    expect(results.every(result => result.status === 'fulfilled')).toBe(true)
    expect(results.map(result => result.status === 'fulfilled' ? result.value.sources[0]?.title : undefined))
      .toEqual(queries.map(query => searchBody(query).messages[0].content[0].text))
    expect(observed).toHaveLength(2)
    expect(observed.map(item => item.body)).toEqual(expect.arrayContaining(queries.map(searchBody)))
    expect(observed.every(item => item.apiVersion === '2023-06-01' && item.key === 'owned-search-fixture-key')).toBe(true)
    const durable = (await f.pool.query<{ event: unknown }>(
      "SELECT event FROM pe_events WHERE session_id=$1 AND event->>'type'='web/deepseek-search-llm-request' ORDER BY seq",
      [n.original.sessionId])).rows.map(row => row.event)
    expect(durable).toEqual(recorded)
  }, true)
}))

test('native Search refuses altered bodies, versions, closed steps and exact requests from an earlier step', () => cloudFixture(async (f) => {
  const n = await prepare(f), a = searchBody('first query'), b = searchBody('second query')
  const log = (body: SearchBody) => n.append(n.session.append('web/deepseek-search-llm-request', {
    endpoint: 'https://original-search.example/messages', apiVersion: '2023-06-01', body }))
  await log(a)
  await searchProxy(n, async ({ post, observed }) => {
    for (const [body, version] of [[b, '2023-06-01'], [a, 'different-version']] as const) {
      expect(await post(body, version)).toEqual({ status: 403, body: { error: 'native_search_not_authorized' } })
    }
    await n.append(n.session.append('step/end', { turn: 1, step: 1 }))
    expect(await post(a)).toEqual({ status: 409, body: { error: 'native_execution_step_unclaimed' } })
    const next = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: randomUUID(),
      frame: n.initial.frame, boundaryKind: 'continuing-step' })
    await n.ledger.claim({ command: next, authority: n.authority, expectedEventCount: n.history.length, events: [] })
    await n.step(2, next); await log(b)
    expect(await post(a)).toEqual({ status: 403, body: { error: 'native_search_not_authorized' } })
    expect((await post(b)).status).toBe(200)
    expect(observed.map(item => item.body)).toEqual([b])
  })
}))

test.each(['writer', 'lease', 'runtime', 'account', 'model'] as const)(
  'a durable native Search request cannot bypass the current %s authorization fence', fence => cloudFixture(async (f) => {
    const n = await prepare(f), body = searchBody('original durable query')
    await n.append(n.session.append('web/deepseek-search-llm-request', {
      endpoint: 'https://original-search.example/messages', apiVersion: '2023-06-01', body }))
    if (fence === 'writer') await n.writers.release(n.writer)
    if (fence === 'lease') await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [n.original.sessionId])
    if (fence === 'runtime') await new NativeRuntimeAuthority(f.pool).revoke(n.runtime.credentialId)
    if (fence === 'account') await f.pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.alice.user.userId])
    if (fence === 'model') await f.pool.query('UPDATE pe_user_models SET enabled=false WHERE user_id=$1', [f.alice.user.userId])
    await searchProxy(n, async ({ post, observed }) => {
      const result = await post(body)
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(result.status).toBeLessThan(500)
      expect(observed).toEqual([])
    })
  }))
