/** Owned PostgreSQL and HTTP peers exercise native providers with isolated tenant configuration and keys. */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { onTestFinished, expect, test } from 'vitest'
import type { Pool } from 'pg'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { modelSettingsLimits, modelDiscoveryDraft } from '@power-evolve/contracts/model-settings'
import { requestId } from '../src/contracts.ts'
import { nativeModelRequest, nativeModelStreamChunk } from '../src/model-runtime-contracts.ts'
import { TenantModelCredentials } from '../src/platform/tenant-model-credentials.ts'
import { TenantModelSettings } from '../src/platform/tenant-model-settings.ts'
import { TenantModelHttp } from '../src/platform/tenant-model-services.ts'
import { TenantModelRuntime } from '../src/platform/tenant-model-runtime.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { NativeInteractive } from '../src/platform/native-interactive.ts'
import { NativePreferences, nativeModelSelect } from '../src/platform/native-preferences.ts'
import { registerNativeToolNames } from '../src/platform/native-tool-catalog.ts'
import { EventStore } from '../src/platform/events.ts'
import { mcpOperationTools } from '../src/mcp-operation-contracts.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { transaction } from '../src/platform/database.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = modelSettingsLimits.parse({}), key = randomBytes(32).toString('base64url')
const eventLimits = { maxEventBytes: 524_288, maxHistoryEvents: 100_000, maxHistoryBytes: 67_108_864 }
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 4 }
const transportLimits = { timeoutMs: 10_000, idleTimeoutMs: 10_000, maxRequestBytes: 1_048_576,
  maxResponseBytes: 1_048_576, maxTotalResponseBytes: 1_048_576, maxResponseHeaderBytes: 65_536,
  maxRequests: 16, maxHeaderBytes: 65_536, maxHeaders: 128, maxPages: 1, maxTools: 1, maxCatalogBytes: 1_048_576 }
const deepEvents = [
  { type: 'message_start', message: { id: 'owned-msg', model: 'deepseek-flash', role: 'assistant', content: [],
    usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]
function services(pool: Pool, url: string) {
  const credentials = new TenantModelCredentials(pool, key, limits)
  const http = new TenantModelHttp(transportLimits, { internalExceptions: [{ origin: url, addresses: ['127.0.0.1'], allowHttp: true }] })
  const authority = new NativeRuntimeAuthority(pool)
  const models = new TenantModelSettings(pool, credentials, limits, endpoint => http.assertEndpoint(endpoint),
    { baseURL: 'https://operator.example', apiKey: 'operator-test-key', streamIdleTimeoutMs: 10_000 }, http, authority)
  const tasks = new TaskStore(pool, taskLimits, async () => {}), preferences = new NativePreferences(pool, eventLimits)
  const runtime = new TenantModelRuntime(tasks, models, authority, { ...eventLimits, ...transportLimits,
    preparation: { maxPending: 64, lifetimeMs: transportLimits.timeoutMs },
    attachments: (_token, signal, authorize) => http.open(signal, authorize) })
  return { credentials, http, authority, models, tasks, preferences, runtime }
}
async function peer(api: string) {
  const calls: { path: string; headers: IncomingHttpHeaders; body: unknown }[] = []
  const failures: unknown[] = []
  const receive = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Owned peer received an invalid byte chunk')
      chunks.push(chunk)
    }
    calls.push({ path: req.url ?? '', headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined })
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'peer-model', name: 'Peer' }] })); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = api === 'openai-completions' ? [
      { choices: [{ delta: { role: 'assistant', content: 'hello' }, index: 0, finish_reason: null }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ] : api === 'openai-responses' ? [
      { type: 'response.created', response: { id: 'owned-response' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'owned-message', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'owned-message', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] } },
      { type: 'response.completed', response: { id: 'owned-response', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ] : deepEvents
    for (const event of events) res.write(`event: ${'type' in event ? event.type : 'message'}\ndata: ${JSON.stringify(event)}\n\n`)
    if (api === 'openai-completions') res.write('data: [DONE]\n\n')
    res.end()
  }
  const server = createServer((req, res) => {
    void receive(req, res).catch((error: unknown) => { failures.push(error); res.destroy() })
  })
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() }); server.closeAllConnections()
    })
    if (failures.length) throw new AggregateError(failures, 'Owned protocol peer failed')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Owned peer address unavailable')
  return { url: `http://127.0.0.1:${address.port}`, calls }
}
async function collect(stream: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
async function save(credentials: TenantModelCredentials, token: string, ref: string, value: string) {
  const ticket = await credentials.ticket(token, { requestId: randomUUID(), ref, sizeBytes: Buffer.byteLength(value) }, 'https://platform.example')
  return credentials.upload(ticket.ticket, Buffer.from(value))
}

test('credentials are write-only, encrypted, owner-bound and preserve keep, replacement, clear and original receipts', () => cloudFixture(async ({ pool, alice, bob, identities }) => {
  const credentials = new TenantModelCredentials(pool, key, limits), ref = 'OWNED_MODEL_KEY', value = 'owned-key-a'
  expect(await credentials.describe(alice.token, [ref])).toEqual({ [ref]: { configured: false, writable: true } })
  const request = { requestId: randomUUID(), ref, sizeBytes: value.length }
  const ticket = await credentials.ticket(alice.token, request, 'https://platform.example')
  expect(ticket.ticket).toMatch(/^[A-Za-z0-9_-]+$/u)
  expect(await credentials.upload(ticket.ticket, Buffer.from(value))).toEqual({ saved: true })
  await expect(credentials.upload(ticket.ticket, Buffer.from(value))).rejects.toMatchObject({ status: 401 })
  expect(await credentials.receipt(alice.token, request.requestId)).toEqual({ saved: true })
  expect(await credentials.receipt(bob.token, request.requestId)).toEqual({ saved: false })
  expect(await credentials.describe(bob.token, [ref])).toEqual({ [ref]: { configured: false, writable: true } })
  const durable = await pool.query<{ sealed: Buffer }>('SELECT sealed FROM pe_tenant_model_credentials')
  expect(durable.rows[0]?.sealed.includes(Buffer.from(value))).toBe(false)
  const replay = await credentials.ticket(alice.token, request, 'https://platform.example')
  expect(await credentials.upload(replay.ticket, Buffer.from(value))).toEqual({ saved: true })
  await save(credentials, bob.token, ref, 'owned-key-b')
  await save(credentials, alice.token, ref, 'replacement-a')
  const read = (token: string) => transaction(pool, async client =>
    credentials.resolve(client, (await requireBrowserAccount(client, token)).userId, ref))
  expect(await read(alice.token)).toBe('replacement-a')
  expect(await read(bob.token)).toBe('owned-key-b')
  await credentials.unset(alice.token, ref)
  expect(await read(alice.token)).toBeUndefined()
  expect(await read(bob.token)).toBe('owned-key-b')
  const doomed = await credentials.ticket(alice.token, { ...request, requestId: randomUUID() }, 'https://platform.example')
  await identities.logout(alice.token)
  await expect(credentials.describe(alice.token, [ref])).rejects.toMatchObject({ status: 401 })
  // Account logout retires Agent bearers; upload remains its bounded one-use capability for that same active owner.
  expect(await credentials.upload(doomed.ticket, Buffer.from(value))).toEqual({ saved: true })
}))

test('native settings and default selection persist independently; existing Sessions retain their model intent', () => cloudFixture(async ({ pool, alice, bob }) => {
  const credentials = new TenantModelCredentials(pool, key, limits)
  const models = new TenantModelSettings(pool, credentials, limits, () => Promise.resolve(),
    { baseURL: 'https://operator.example', apiKey: 'operator-test-key', streamIdleTimeoutMs: 10_000 })
  const tasks = new TaskStore(pool, taskLimits), preferences = new NativePreferences(pool, eventLimits)
  const old = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const cold = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await models.write(alice.token, { ns: 'llm-pi-ai', mode: 'replace', expectedRevision: 1, value: { providers: {
    'owned-peer': { api: 'openai-completions', baseURL: 'https://peer.example/v1', apiKeyEnv: 'SHARED_REF',
      models: [{ id: 'same-model', contextWindow: 8192, maxTokens: 2048 }] },
  } } })
  expect((await new TenantModelSettings(pool, credentials, limits, () => Promise.resolve(),
    { baseURL: 'https://operator.example', apiKey: 'operator-test-key', streamIdleTimeoutMs: 10_000 }).describe(alice.token)).namespaces)
    .toEqual((await models.describe(alice.token)).namespaces)
  expect((await models.modelCatalog(alice.token)).groups.find(group => group.id === 'owned-peer')?.models).toMatchObject([{ id: 'same-model' }])
  await models.write(alice.token, { ns: 'llm-pi-ai', mode: 'update', value: { providers: { 'owned-peer': { displayName: 'Renamed' } } } })
  expect((await models.modelCatalog(alice.token)).groups.find(group => group.id === 'owned-peer'))
    .toMatchObject({ name: 'Renamed', models: [{ id: 'same-model' }] })
  await models.write(alice.token, { ns: 'llm-pi-ai', mode: 'mutate', value: [
    { op: 'set', path: ['providers', 'owned-peer', 'displayName'], value: 'Edited' },
  ] })
  expect((await models.modelCatalog(alice.token)).groups.find(group => group.id === 'owned-peer')?.name).toBe('Edited')
  expect((await models.modelCatalog(bob.token)).groups.some(group => group.id === 'owned-peer')).toBe(false)
  const a = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await preferences.selectModel(alice.user, alice.token, nativeModelSelect.parse({ sessionId: a.sessionId, provider: 'owned-peer', model: 'same-model' }))
  const fresh = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await tasks.accept(alice.user, old.sessionId, requestId.parse(randomUUID()), 'old', alice.token)
  await tasks.accept(alice.user, fresh.sessionId, requestId.parse(randomUUID()), 'fresh', alice.token)
  expect((await pool.query('SELECT input,settings FROM pe_operations ORDER BY input')).rows).toEqual([
    { input: 'fresh', settings: { provider: 'owned-peer', model: 'same-model', maxTokens: 1000, revision: 2 } },
    { input: 'old', settings: { model: 'trial-model', maxTokens: 1000, revision: 2 } },
  ])
  expect((await models.modelCatalog(alice.token)).default).toEqual({ provider: 'owned-peer', model: 'same-model' })
  expect((await models.modelCatalog(bob.token)).default.model).toBe('trial-model')
  await expect(models.write(alice.token, { ns: 'llm-pi-ai', mode: 'replace', expectedRevision: 1, value: {} })).rejects.toMatchObject({ status: 409 })
  const authority = new NativeRuntimeAuthority(pool)
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
  const interactive = new NativeInteractive(tasks, authority, { lifetimeMs: 30_000, leaseMs: 30_000, maxActivePerUser: 2 })
  const opened = await interactive.open(issued.token, { sessionId: cold.sessionId, requestId: requestId.parse(randomUUID()),
    browserToken: alice.token, candidateToken: randomBytes(32).toString('base64url') })
  expect(opened.settings).toEqual({ model: 'trial-model', maxTokens: 1000, revision: 2 })
}))

test.each(['deepseek', 'openai-completions', 'openai-responses', 'anthropic-messages'])('native %s executes through Platform with each owner key and exact operation route', api => cloudFixture(async ({ pool, alice, bob }) => {
  const server = await peer(api), { credentials, models, tasks, preferences, runtime, authority } = services(pool, server.url)
  const provider = api === 'deepseek' ? 'deepseek-official' : 'owned-peer', model = api === 'deepseek' ? 'deepseek-flash' : 'peer-model'
  for (const [account, value] of [[alice, 'owner-key-a'], [bob, 'owner-key-b']] as const) {
    await save(credentials, account.token, 'SAME_REFERENCE', value)
    await models.write(account.token, api === 'deepseek' ? { ns: 'llm-deepseek', mode: 'replace', value: {
      baseURL: server.url, apiKeyEnv: 'SAME_REFERENCE', thinking: 'disabled' } }
      : { ns: 'llm-pi-ai', mode: 'replace', value: { providers: { [provider]: { api, baseURL: server.url,
        apiKeyEnv: 'SAME_REFERENCE', models: [{ id: model, contextWindow: 8192, maxTokens: 2048 }] } } } })
    const session = await tasks.create(account.user, requestId.parse(randomUUID()), account.token)
    await preferences.selectModel(account.user, account.token, nativeModelSelect.parse({ sessionId: session.sessionId, provider, model }))
    await tasks.accept(account.user, session.sessionId, requestId.parse(randomUUID()), 'hi', account.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Owned operation was not claimed')
    const issued = await authority.issue({ userId: account.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
    const prepared = await runtime.prepare(issued.token, { provider, model })
    const body = { provider, model, preparationId: prepared.preparationId, sessionId: session.sessionId, maxTokens: 1000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
    const chunks = await collect(runtime.stream(grant.token, body, AbortSignal.timeout(10_000)))
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello')).toBe(true)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    for (const chunk of chunks) expect(nativeModelStreamChunk.safeParse(chunk).success).toBe(true)
    expect(server.calls.at(-1)?.headers[api === 'deepseek' || api === 'anthropic-messages' ? 'x-api-key' : 'authorization'])
      .toBe(api === 'deepseek' || api === 'anthropic-messages' ? value : `Bearer ${value}`)
    const count = server.calls.length
    await expect(collect(runtime.stream(grant.token, { ...body, provider: 'forged' }, new AbortController().signal))).rejects.toMatchObject({ status: 403 })
    await expect(collect(runtime.stream(grant.token, { ...body, tools: [{ name: 'forged', description: '', parameters: {} }] }, new AbortController().signal)))
      .rejects.toMatchObject({ status: 403 })
    await tasks.finish(grant.token, 'completed', null)
    await expect(collect(runtime.stream(grant.token, body, new AbortController().signal))).rejects.toMatchObject({ status: 409 })
    expect(server.calls).toHaveLength(count)
  }
  expect(JSON.stringify(await models.describe(alice.token))).not.toContain('owner-key')
  expect(JSON.stringify(await models.providers(alice.token))).not.toContain('owner-key')
}))

test('native preparation retains its model and dispatch generation across configuration changes and consumes once', () => cloudFixture(async ({ pool, alice }) => {
  const server = await peer('openai-completions'), { credentials, models, tasks, preferences, runtime, authority } = services(pool, server.url)
  await save(credentials, alice.token, 'OWNED_KEY', 'prepared-key')
  const configure = (generation: string, contextWindow: number) => models.write(alice.token, { ns: 'llm-pi-ai', mode: 'replace', value: {
    providers: { 'owned-peer': { api: 'openai-completions', baseURL: `${server.url}/${generation}`, apiKeyEnv: 'OWNED_KEY',
      models: [{ id: 'peer-model', contextWindow, maxTokens: 2048 }] } },
  } })
  await configure('original', 8192)
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await preferences.selectModel(alice.user, alice.token, nativeModelSelect.parse({ sessionId: created.sessionId,
    provider: 'owned-peer', model: 'peer-model' }))
  await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'prepared', alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Owned prepared operation unavailable')
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
  const prepared = await runtime.prepare(issued.token, { provider: 'owned-peer', model: 'peer-model' })
  expect(prepared.model.context).toEqual({ contextWindow: 8192 })
  expect(prepared.imagePricing).toEqual({ kind: 'none' })
  await configure('replacement', 16384)
  expect((await runtime.resolve(issued.token, { provider: 'owned-peer', model: 'peer-model' })).context).toEqual({ contextWindow: 16384 })
  const body = { provider: 'owned-peer', model: 'peer-model', preparationId: prepared.preparationId,
    sessionId: created.sessionId, maxTokens: 1000, messages: [{ role: 'user', content: [{ type: 'text', text: 'prepared' }] }] }
  expect((await collect(runtime.stream(grant.token, body, AbortSignal.timeout(10_000)))).at(-1))
    .toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(server.calls.map(call => call.path)).toEqual(['/original/chat/completions'])
  await expect(collect(runtime.stream(grant.token, body, new AbortController().signal)))
    .rejects.toMatchObject({ code: 'model_preparation_unavailable' })
  expect((await pool.query('SELECT configuration,operation_id FROM pe_tenant_model_preparations WHERE id=$1', [prepared.preparationId])).rows)
    .toEqual([{ configuration: [], operation_id: grant.operationId }])
  const replacement = await runtime.prepare(issued.token, { provider: 'owned-peer', model: 'peer-model' })
  expect(replacement.model.context).toEqual({ contextWindow: 16384 })
  await collect(runtime.stream(grant.token, { ...body, preparationId: replacement.preparationId }, AbortSignal.timeout(10_000)))
  expect(server.calls.map(call => call.path)).toEqual(['/original/chat/completions', '/replacement/chat/completions'])
}))

test('native preparation is bounded by its owner, expiry and credential generation before network I/O', () => cloudFixture(async ({ pool, alice, bob }) => {
  const server = await peer('openai-completions'), { credentials, models, tasks, preferences, runtime, authority } = services(pool, server.url)
  for (const account of [alice, bob]) {
    await save(credentials, account.token, 'OWNED_KEY', 'prepared-key')
    await models.write(account.token, { ns: 'llm-pi-ai', mode: 'replace', value: { providers: {
      'owned-peer': { api: 'openai-completions', baseURL: server.url, apiKeyEnv: 'OWNED_KEY',
        models: [{ id: 'peer-model', contextWindow: 8192, maxTokens: 2048 }] },
    } } })
  }
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await preferences.selectModel(alice.user, alice.token, nativeModelSelect.parse({ sessionId: created.sessionId,
    provider: 'owned-peer', model: 'peer-model' }))
  await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'private', alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Owned operation unavailable')
  const aliceRuntime = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
  const bobRuntime = await authority.issue({ userId: bob.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
  const body = { provider: 'owned-peer', model: 'peer-model', sessionId: created.sessionId, maxTokens: 1000,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'private' }] }] }
  const foreign = await runtime.prepare(bobRuntime.token, { provider: body.provider, model: body.model })
  await expect(collect(runtime.stream(grant.token, { ...body, preparationId: foreign.preparationId }, new AbortController().signal)))
    .rejects.toMatchObject({ code: 'model_preparation_unavailable' })
  const expired = await runtime.prepare(aliceRuntime.token, { provider: body.provider, model: body.model })
  await pool.query("UPDATE pe_tenant_model_preparations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.preparationId])
  await expect(collect(runtime.stream(grant.token, { ...body, preparationId: expired.preparationId }, new AbortController().signal)))
    .rejects.toMatchObject({ code: 'model_preparation_unavailable' })
  const rotated = await runtime.prepare(aliceRuntime.token, { provider: body.provider, model: body.model })
  await pool.query('UPDATE pe_tenant_model_preparations SET credential_version=credential_version+1 WHERE id=$1', [rotated.preparationId])
  await expect(collect(runtime.stream(grant.token, { ...body, preparationId: rotated.preparationId }, new AbortController().signal)))
    .rejects.toMatchObject({ code: 'model_preparation_unavailable' })
  expect(server.calls).toEqual([])
}))

test('one-shot discovery uses native listing with a direct-upload key and never changes saved credentials', () => cloudFixture(async ({ pool, alice }) => {
  const server = await peer('openai-completions'), credentials = new TenantModelCredentials(pool, key, limits)
  const http = new TenantModelHttp(transportLimits, { internalExceptions: [{ origin: server.url, addresses: ['127.0.0.1'], allowHttp: true }] })
  const models = new TenantModelSettings(pool, credentials, limits, url => http.assertEndpoint(url),
    { baseURL: 'https://operator.example', apiKey: 'operator-key', streamIdleTimeoutMs: 10_000 }, http)
  await save(credentials, alice.token, 'SAVED', 'keep-original')
  const ticket = await credentials.ticket(alice.token, { requestId: randomUUID(), ref: 'SAVED', sizeBytes: 10,
    discovery: { settingsNs: 'llm-pi-ai', baseURL: server.url, api: 'openai-completions' } }, 'https://platform.example')
  expect(await credentials.upload(ticket.ticket, Buffer.from('draft-only'), (owner, draft, value, client) =>
    models.discoverOwned(client, owner, draft, value, AbortSignal.timeout(10_000))))
    .toEqual({ saved: false, models: [{ id: 'peer-model', name: 'Peer' }] })
  expect(server.calls[0]?.headers.authorization).toBe('Bearer draft-only')
  expect(await transaction(pool, client => credentials.resolve(client, alice.user.userId, 'SAVED'))).toBe('keep-original')
}))

test('native transport keeps assistant replay metadata and rejects credential literals in draft metadata', () => {
  const replay = { arbitrary: ['opaque', { signature: 'sig', nested: { retained: true } }] }
  const value = { provider: 'provider', model: 'model', preparationId: randomUUID(), sessionId: randomUUID(), messages: [{ role: 'assistant', id: 'assistant',
    source: { kind: 'model', provider: 'provider', model: 'model', replayState: replay }, content: [{ type: 'text', text: 'hello' }] }] }
  expect(nativeModelRequest.parse(value)).toBe(value)
  const chunk = { type: 'finish', reason: { kind: 'stop' }, replayState: { response: replay, blocks: [null] } }
  expect(nativeModelStreamChunk.parse(chunk)).toBe(chunk)
  expect(modelDiscoveryDraft.safeParse({ settingsNs: 'llm-pi-ai', apiKey: 'never-through-host' }).success).toBe(false)
})

test('credential intake rejects expired, altered, oversized and credential-rotated tickets before any write', () => cloudFixture(async ({ pool, alice }) => {
  const credentials = new TenantModelCredentials(pool, key, { ...limits, maxCredentialBytes: 20 })
  const mint = (ref = 'KEY') => credentials.ticket(alice.token, { requestId: randomUUID(), ref, sizeBytes: 3 }, 'https://platform.example')
  await expect(credentials.ticket(alice.token, { requestId: randomUUID(), ref: 'KEY', sizeBytes: 21 }, 'https://platform.example'))
    .rejects.toMatchObject({ status: 413 })
  const expired = await mint()
  await pool.query('UPDATE pe_tenant_model_credential_tickets SET expires_at=clock_timestamp()-interval \'1 second\' WHERE request_id=$1', [expired.requestId])
  await expect(credentials.upload(expired.ticket, Buffer.from('one'))).rejects.toMatchObject({ status: 401 })
  const size = await mint()
  await expect(credentials.upload(size.ticket, Buffer.from('four'))).rejects.toMatchObject({ status: 400 })
  await expect(credentials.upload(size.ticket, Buffer.from('a\nb'))).rejects.toMatchObject({ status: 400 })
  await expect(credentials.upload('altered', Buffer.from('one'))).rejects.toMatchObject({ status: 401 })
  const rotated = await mint()
  await pool.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [alice.user.userId])
  await expect(credentials.upload(rotated.ticket, Buffer.from('one'))).rejects.toMatchObject({ status: 401 })
  expect((await pool.query('SELECT reference FROM pe_tenant_model_credentials')).rows).toEqual([])
}))

test('native refresh records and ambient reference lookup remain owner-local across service instances', () => cloudFixture(async ({ pool, alice, bob }) => {
  const first = new TenantModelCredentials(pool, key, limits), second = new TenantModelCredentials(pool, key, limits)
  const auth = (service: TenantModelCredentials, token: string, owner: typeof alice.user.userId) => service.nativeAuth(owner,
    async (client) => { expect((await requireBrowserAccount(client, token)).userId).toBe(owner) })
  const a = auth(first, alice.token, alice.user.userId), b = auth(second, alice.token, alice.user.userId)
  await Promise.all([a, b].map(provider => provider.credentials.modify('llm-pi-ai/owned', current => Promise.resolve({
    type: 'oauth', refresh: String(current?.type === 'oauth' ? Number(current.refresh) + 1 : 1), access: 'owned-access', expires: 123,
  }))))
  expect(await a.credentials.read('llm-pi-ai/owned')).toEqual({ type: 'oauth', refresh: '2', access: 'owned-access', expires: 123 })
  expect(await auth(second, bob.token, bob.user.userId).credentials.read('llm-pi-ai/owned')).toBeUndefined()
  expect(await a.credentials.list()).toEqual([{ providerId: 'llm-pi-ai/owned', type: 'oauth' }])
  expect(await a.authContext.env('PATH')).toBeUndefined()
  expect(await a.authContext.fileExists('/etc/passwd')).toBe(false)
  await a.credentials.delete('llm-pi-ai/owned')
  expect(await a.credentials.read('llm-pi-ai/owned')).toBeUndefined()
}))

test('native tool declarations and history use the committed native header and exact external selection', () => cloudFixture(async ({ pool, alice, bob }) => {
  const server = await peer('openai-completions'), { models, credentials, tasks, preferences, runtime, authority } = services(pool, server.url)
  await save(credentials, alice.token, 'KEY', 'tool-owner-key')
  await models.write(alice.token, { ns: 'llm-pi-ai', mode: 'replace', value: { providers: { peer: {
    api: 'openai-completions', baseURL: server.url, apiKeyEnv: 'KEY', models: [{ id: 'peer-model' }],
  } } } })
  const selected = { provider: 'peer', model: 'peer-model' }
  const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  await preferences.selectModel(alice.user, alice.token, nativeModelSelect.parse({ sessionId: session.sessionId, ...selected }))
  await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'tools', alice.token)
  const grant = await tasks.claim(randomUUID())
  if (!grant) throw new Error('Owned operation was not claimed')
  const native = { name: 'owned_native', description: 'Native tool', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }
  const external = { name: 'mcp__owned__search', description: 'Original external descriptor', parameters: native.parameters }
  const frozen = mcpOperationTools.parse([{ formatVersion: 1, connectionId: randomUUID(), connectionRevision: 1,
    configurationRevision: 1, credentialRevision: null, catalogId: randomUUID(), toolId: randomUUID(),
    descriptorDigest: 'a'.repeat(64), modelDigest: 'b'.repeat(64), raw: { name: 'search', inputSchema: native.parameters }, model: external }])
  await pool.query('UPDATE pe_operations SET remote_mcp_selection=$2 WHERE id=$1', [grant.operationId, JSON.stringify(frozen)])
  const count = (await pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1', [session.sessionId])).rows[0]?.event_count
  await new EventStore(tasks, eventLimits).append(grant.token, [{ seq: count, time: Date.now(), type: 'request/header',
    data: { reason: 'initial', header: { config: { ...selected, maxTokens: 1000 }, tools: [native, external] } } }])
  await registerNativeToolNames(tasks, grant.token, { names: [native.name], tools: [native] })
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
  const prepared = await runtime.prepare(issued.token, selected)
  const body = { ...selected, preparationId: prepared.preparationId, sessionId: session.sessionId, maxTokens: 1000, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [native, external], toolHistory: { tools: [native, external], updates: [] } }
  expect((await collect(runtime.stream(grant.token, body, AbortSignal.timeout(10_000)))).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  expect(server.calls[0]?.body).toMatchObject({ tools: [{ function: { name: native.name } }, { function: { name: external.name } }] })
  for (const invalid of [
    { ...body, tools: [native, { ...external, description: 'changed' }] },
    { ...body, toolHistory: { tools: [{ ...native, description: 'changed' }, external], updates: [] } },
  ]) await expect(collect(runtime.stream(grant.token, invalid, new AbortController().signal))).rejects.toMatchObject({ status: 403 })
  expect(server.calls).toHaveLength(1)
  expect(await runtime.resolve(issued.token, selected)).toMatchObject({ provider: 'peer', id: 'peer-model' })
  expect(await runtime.imagePricing(issued.token, selected)).toEqual({ kind: 'none' })
  expect((await models.providers(issued.token, true)).registered.some(route => route.id === 'peer')).toBe(true)
  const foreign = await authority.issue({ userId: bob.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60_000 })
  await expect(runtime.resolve(foreign.token, selected)).rejects.toMatchObject({ status: 403 })
  await expect(models.providers(alice.token, true)).rejects.toMatchObject({ status: 401 })
}))
