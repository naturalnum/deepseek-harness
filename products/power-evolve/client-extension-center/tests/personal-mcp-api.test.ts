import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { PersonalMcpConnectionHttpClient } from '../src/client/personal-mcp-api.ts'
import { PersonalMcpConnectionRequestError, type PersonalMcpConnectionCreateRequest } from '../src/client/personal-mcp-client.ts'
import { personalMcpCheckErrorLabel, personalMcpCheckView } from '../src/client/personal-mcp-check-view.ts'
import { en, zh } from '../src/client/locales.ts'

// Network substitutes validate browser transport; this file is not real-backend evidence.
const connectionId = '00000000-0000-4000-8000-000000000001'
const requestId = '00000000-0000-4000-8000-000000000002'
const sessionId = '00000000-0000-4000-8000-000000000003'
const checkId = '00000000-0000-4000-8000-000000000004'
const draftId = '00000000-0000-4000-8000-000000000005'
const platform = 'https://platform.example.test'
const token = 'a'.repeat(43)
const item = { connectionId, revision: 2, configurationRevision: 2, credentialRevision: null,
  displayName: 'Private MCP', serverName: 'mcp_private', serverUrl: 'https://remote.example.test/mcp',
  transport: 'streamable-http', authentication: 'none', headerNames: [], secretConfigured: false,
  enabled: false, deletedAt: null, currentCatalogId: null, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' }
const pendingCheck = { checkId, draftId: null, connectionId, sessionId, connectionRevision: 2,
  configurationRevision: 2, credentialRevision: null, state: 'queued', catalogId: null,
  discoveredTools: null, errorCode: null, cancelRequested: false, createdAt: '2026-09-30T00:00:00.000Z', expiresAt: '2099-09-30T00:00:00.000Z' }
const form: PersonalMcpConnectionCreateRequest = { display_name: item.displayName, server_url: item.serverUrl,
  authentication: { kind: 'none' }, enabled: false }
const ticket = { state: 'pending', requestId, ticket: token,
  uploadUrl: `${platform}/mcp/connections/upload`, expiresAt: '2099-09-30T00:00:00.000Z' }

function input(init: RequestInit | undefined): { request: Record<string, unknown> } {
  assert.equal(typeof init?.body, 'string')
  return JSON.parse(String(init?.body)) as { request: Record<string, unknown> }
}
function route(url: RequestInfo | URL): string { return String(url).split('/').at(-1)! }
function approved(): Response { return Response.json({ approvalUrl: `${platform}/approval` }) }

function credentialFetch(uploadUrl = ticket.uploadUrl) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  let uploaded: Uint8Array | undefined
  let original: Uint8Array | undefined
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url) === '/config') return approved()
    if (route(url) === 'mcpConnectionsTicket') return Response.json({ ...ticket, uploadUrl })
    if (String(url) === uploadUrl) {
      assert(init?.body instanceof Uint8Array)
      original = init.body
      uploaded = new Uint8Array(init.body)
      return Response.json({ kind: 'connection', item: { ...item, authentication: 'bearer', secretConfigured: true, credentialRevision: 1 } })
    }
    throw new Error('Unexpected fixture route')
  }
  return { fetch, calls, uploaded: () => uploaded, original: () => original }
}

test('one bounded native list restores multiple masked connections and exact check status', async () => {
  let body: unknown
  const client = new PersonalMcpConnectionHttpClient(async (_url, init) => {
    body = input(init)
    return Response.json({ available: true, items: [
      { connection: item, latestCheck: { ...pendingCheck, state: 'succeeded', discoveredTools: 0 } },
      { connection: { ...item, connectionId: draftId, displayName: 'Second MCP' }, latestCheck: null },
    ] })
  })
  const page = await client.list({ limit: 50 })
  assert.deepEqual(body, { request: {} })
  assert.equal(page.available, true)
  assert.equal(page.items.length, 2)
  assert.equal(page.nextCursor, undefined)
  assert.equal(page.items[0]?.latest_check?.discovered_tools, 0)
  assert.equal(page.items[0]?.latest_check?.started_at, null)
  assert.equal(page.items[0]?.latest_check?.finished_at, null)
})

test('native list retains historical discovery versions after a configuration edit', async () => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ available: true, items: [{
    connection: { ...item, revision: 3, credentialRevision: 2, authentication: 'bearer', secretConfigured: true },
    latestCheck: { ...pendingCheck, connectionRevision: 1, configurationRevision: 1, credentialRevision: 1,
      state: 'succeeded', discoveredTools: 2 },
  }] }))
  const saved = (await client.list()).items[0]
  assert(saved)
  assert.equal(saved.revision, 3)
  assert.equal(saved.configuration_revision, 2)
  assert.equal(saved.credential_revision, 2)
  assert.equal(saved.latest_check?.configuration_revision, 1)
  assert.equal(saved.latest_check?.credential_revision, 1)
  assert.deepEqual(personalMcpCheckView(saved), {
    state: 'succeeded', label: 'personalMcpCheckSucceeded', stale: true, discoveredTools: 2,
  })
})

test('none, retained and cleared credentials use metadata-only writes; toggle and delete use exact revisions', async () => {
  const calls: Array<{ method: string; body: { request: Record<string, unknown> } }> = []
  const client = new PersonalMcpConnectionHttpClient(async (url, init) => {
    const body = input(init); calls.push({ method: route(url), body })
    const config = body.request.configuration as { authentication?: { kind: string } } | undefined
    return Response.json({ ...item, authentication: config?.authentication?.kind ?? 'none',
      enabled: body.request.enabled ?? false,
      deletedAt: route(url) === 'mcpConnectionsDelete' ? item.updatedAt : null })
  })
  await client.create(form, requestId)
  await client.update(connectionId, { ...form, authentication: { kind: 'bearer' }, expected_revision: 1 }, requestId)
  await client.update(connectionId, { ...form, authentication: { kind: 'bearer' },
    expected_revision: 1, clear_secret_keys: ['bearer_token'] }, requestId)
  await client.toggle(connectionId, 1, true, requestId)
  await client.remove(connectionId, 1, requestId)
  assert.deepEqual(calls.map(call => call.method), ['mcpConnectionsCreate', 'mcpConnectionsUpdate',
    'mcpConnectionsUpdate', 'mcpConnectionsToggle', 'mcpConnectionsDelete'])
  assert.deepEqual((calls[1]?.body.request.configuration as { authentication: unknown }).authentication,
    { kind: 'bearer', action: 'retain' })
  assert.deepEqual((calls[2]?.body.request.configuration as { authentication: unknown }).authentication,
    { kind: 'bearer', action: 'clear' })
  assert.deepEqual(calls[3]?.body, { request: { requestId, connectionId, baseRevision: 1, enabled: true } })
  assert.deepEqual(calls[4]?.body, { request: { requestId, connectionId, baseRevision: 1 } })
})

test('a delete response requires a tombstone and live lists reject deleted connections', async () => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json(item))
  await assert.rejects(client.remove(connectionId, 1, requestId),
    (cause: unknown) => cause instanceof PersonalMcpConnectionRequestError && cause.status === 502)
  const listClient = new PersonalMcpConnectionHttpClient(async () => Response.json({ available: true,
    items: [{ connection: { ...item, deletedAt: item.updatedAt }, latestCheck: null }] }))
  await assert.rejects(listClient.list(),
    (cause: unknown) => cause instanceof PersonalMcpConnectionRequestError && cause.status === 502)
})

test('Bearer replacement goes only to the pinned Platform endpoint with exact UTF-8 bytes', async () => {
  const mock = credentialFetch()
  const client = new PersonalMcpConnectionHttpClient(mock.fetch)
  await client.create({ ...form, authentication: { kind: 'bearer' }, secrets: { bearer_token: 'fixture-中文-secret' } }, requestId)
  const metadata = input(mock.calls[0]?.init)
  const bytes = mock.uploaded()!
  assert.equal(JSON.stringify(metadata).includes('fixture-中文-secret'), false)
  assert.deepEqual((metadata.request.configuration as { authentication: unknown }).authentication,
    { kind: 'bearer', action: 'replace' })
  assert.equal(metadata.request.sizeBytes, bytes.byteLength)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), { formatVersion: 1, bearerToken: 'fixture-中文-secret' })
  const upload = mock.calls.find(call => call.url === ticket.uploadUrl)!
  assert.equal(upload.init?.credentials, 'omit')
  assert.equal(upload.init?.redirect, 'error')
  assert.equal(upload.init?.referrerPolicy, 'no-referrer')
  assert.deepEqual(upload.init?.headers, { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', accept: 'application/json' })
  assert(mock.original()?.every(byte => byte === 0))
})

test('custom-header edit sends retain/replace names to Host and only replacement values to Platform', async () => {
  const calls: Array<{ method: string; init: RequestInit | undefined }> = []
  let upload: unknown
  const client = new PersonalMcpConnectionHttpClient(async (url, init) => {
    calls.push({ method: route(url), init })
    if (String(url) === '/config') return approved()
    if (route(url) === 'mcpConnectionsTicket') return Response.json(ticket)
    assert(init?.body instanceof Uint8Array)
    upload = JSON.parse(new TextDecoder().decode(init.body))
    return Response.json({ kind: 'connection', item: { ...item, authentication: 'headers',
      headerNames: ['Authorization', 'X-API-Key'], secretConfigured: true, credentialRevision: 1 } })
  })
  const updated = await client.update(connectionId, { ...form, expected_revision: 1,
    authentication: { kind: 'headers' }, headers: [{ name: 'Authorization' }, { name: 'X-API-Key', value: 'fixture-value' }] }, requestId)
  assert.deepEqual((input(calls[0]?.init).request.configuration as { authentication: unknown }).authentication,
    { kind: 'headers', headers: [{ name: 'Authorization', action: 'retain' }, { name: 'X-API-Key', action: 'replace' }] })
  assert.equal(JSON.stringify(input(calls[0]?.init)).includes('fixture-value'), false)
  assert.deepEqual(upload, { formatVersion: 1, headers: [{ name: 'X-API-Key', value: 'fixture-value' }] })
  assert.deepEqual(updated.headers, [{ name: 'Authorization', value_configured: true }, { name: 'X-API-Key', value_configured: true }])
  assert.equal(JSON.stringify(updated).includes('fixture-value'), false)
})

test('a lost upload response is reconciled through its original receipt without another upload', async () => {
  const methods: string[] = []
  const client = new PersonalMcpConnectionHttpClient(async (url, init) => {
    methods.push(route(url))
    if (String(url) === '/config') return approved()
    if (route(url) === 'mcpConnectionsTicket') return Response.json(ticket)
    if (route(url) === 'upload') throw new Error('fixture lost response')
    assert.deepEqual(input(init), { request: { requestId } })
    return Response.json({ result: { kind: 'connection', item: { ...item, authentication: 'bearer', secretConfigured: true, credentialRevision: 1 } } })
  })
  await client.create({ ...form, authentication: { kind: 'bearer' }, secrets: { bearer_token: 'fixture-secret' } }, requestId)
  assert.deepEqual(methods, ['mcpConnectionsTicket', 'config', 'upload', 'mcpConnectionsReceipt'])
})

test('an unresolved upload retries only receipt and rejects changed secret bytes under the same ID', async () => {
  const methods: string[] = []
  let completed = false
  const client = new PersonalMcpConnectionHttpClient(async url => {
    methods.push(route(url))
    if (String(url) === '/config') return approved()
    if (route(url) === 'mcpConnectionsTicket') return Response.json(ticket)
    if (route(url) === 'upload') throw new Error('fixture lost response')
    return Response.json({ result: completed ? { kind: 'connection', item: { ...item, authentication: 'bearer', secretConfigured: true, credentialRevision: 1 } } : null })
  })
  const inputForm: PersonalMcpConnectionCreateRequest = { ...form, authentication: { kind: 'bearer' }, secrets: { bearer_token: 'fixture-secret' } }
  await assert.rejects(client.create(inputForm, requestId), (cause: unknown) => cause instanceof PersonalMcpConnectionRequestError && cause.status === 503)
  const before = methods.length
  await assert.rejects(client.create({ ...inputForm, secrets: { bearer_token: 'changed-fixture' } }, requestId),
    (cause: unknown) => cause instanceof PersonalMcpConnectionRequestError && cause.status === 409)
  assert.equal(methods.length, before)
  completed = true
  await client.create(inputForm, requestId)
  assert.equal(methods.filter(method => method === 'upload').length, 1)
  assert.equal(methods.filter(method => method === 'mcpConnectionsTicket').length, 1)
  assert.equal(methods.at(-1), 'mcpConnectionsReceipt')
})

test('completed ticket replay may be pending and revalidates the original upload bytes', async () => {
  const mock = credentialFetch()
  const client = new PersonalMcpConnectionHttpClient(mock.fetch)
  const inputForm: PersonalMcpConnectionCreateRequest = { ...form, authentication: { kind: 'bearer' }, secrets: { bearer_token: 'fixture-secret' } }
  await client.create(inputForm, requestId)
  await client.create(inputForm, requestId)
  assert.equal(mock.calls.filter(call => route(call.url) === 'mcpConnectionsTicket').length, 2)
  assert.equal(mock.calls.filter(call => route(call.url) === 'upload').length, 2)
})

test('unsafe upload URLs never receive credential bytes', async () => {
  for (const url of ['https://other.example.test/mcp/connections/upload',
    `${platform}/mcp/connections/upload?next=elsewhere`, `${platform}/mcp/connections/upload#secret`,
    'https://user:password@platform.example.test/mcp/connections/upload', `${platform}/wrong-path`]) {
    const mock = credentialFetch(url)
    const client = new PersonalMcpConnectionHttpClient(mock.fetch)
    await assert.rejects(client.create({ ...form, authentication: { kind: 'bearer' }, secrets: { bearer_token: 'fixture-secret' } }, requestId))
    assert.equal(mock.calls.filter(call => call.url === url).length, 0)
  }
})

test('credential byte budget is checked before ticket issuance', async () => {
  let called = false
  const client = new PersonalMcpConnectionHttpClient(async () => { called = true; return Response.json(ticket) })
  await assert.rejects(client.create({ ...form, authentication: { kind: 'bearer' }, secrets: { bearer_token: '界'.repeat(6000) } }, requestId),
    (cause: unknown) => cause instanceof PersonalMcpConnectionRequestError && cause.status === 413)
  assert.equal(called, false)
})

test('saved and draft checks pin the original Session and use distinct native requests', async () => {
  const calls: Array<{ method: string; body: { request: Record<string, unknown> } }> = []
  const client = new PersonalMcpConnectionHttpClient(async (url, init) => {
    calls.push({ method: route(url), body: input(init) })
    return Response.json({ ...pendingCheck, ...(route(url) === 'mcpConnectionsDraftCheck' ? { draftId } : {}) })
  })
  await client.createCheck(connectionId, { session_id: sessionId, connection_id: connectionId,
    expected_revision: 2, configuration: form }, requestId)
  await client.createDraftCheck({ session_id: sessionId, connection_id: connectionId, expected_revision: 2,
    configuration: { ...form, authentication: { kind: 'bearer' }, clear_secret_keys: ['bearer_token'] } }, requestId)
  assert.deepEqual(calls[0], { method: 'mcpConnectionsCheck', body: { request: { requestId, connectionId, baseRevision: 2, sessionId } } })
  assert.equal(calls[1]?.method, 'mcpConnectionsDraftCheck')
  assert.equal(calls[1]?.body.request.sourceConnectionId, connectionId)
  assert.deepEqual((calls[1]?.body.request.configuration as { authentication: unknown }).authentication, { kind: 'bearer', action: 'clear' })
  assert.equal(calls.length, 2)
})

test('checks cannot be attached to a different returned Session', async () => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...pendingCheck, sessionId: draftId }))
  await assert.rejects(client.createCheck(connectionId, { session_id: sessionId, connection_id: connectionId,
    expected_revision: 2, configuration: form }, requestId))
})

test('status and cancellation send only checkId, preserve expiry and do not invent timestamps', async () => {
  const calls: Array<{ method: string; body: { request: Record<string, unknown> } }> = []
  let isDraft = false
  const client = new PersonalMcpConnectionHttpClient(async (url, init) => {
    calls.push({ method: route(url), body: input(init) })
    return Response.json({ ...pendingCheck, draftId: isDraft ? draftId : null,
      state: route(url) === 'mcpConnectionsCheckCancel' ? 'cancelled' : 'expired' })
  })
  assert.equal((await client.getCheck(connectionId, checkId)).state, 'expired')
  assert.equal((await client.cancelCheck(connectionId, checkId, requestId)).state, 'canceled')
  isDraft = true
  assert.equal((await client.getDraftCheck(checkId)).started_at, null)
  assert.equal((await client.cancelDraftCheck(checkId, requestId)).finished_at, null)
  assert(calls.every(call => JSON.stringify(call.body) === JSON.stringify({ request: { checkId } })))
})

test('wire parsing rejects mismatched identities, secret fields and duplicate list records', async () => {
  const wrongCheck = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...pendingCheck, checkId: draftId }))
  await assert.rejects(wrongCheck.getCheck(connectionId, checkId))
  const leaking = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...item, bearerToken: 'fixture-only' }))
  await assert.rejects(leaking.create(form, requestId))
  const duplicate = new PersonalMcpConnectionHttpClient(async () => Response.json({ available: true,
    items: [{ connection: item, latestCheck: null }, { connection: item, latestCheck: null }] }))
  await assert.rejects(duplicate.list())
})

test('all fixed worker refusals preserve a specific bilingual explanation instead of connection failure', async () => {
  const worker = readFileSync(new URL('../../application/src/platform/mcp-check-worker.ts', import.meta.url), 'utf8')
  const network = readFileSync(new URL('../../application/src/platform/mcp-network.ts', import.meta.url), 'utf8')
  const codes = []
  for (const name of ['admissionCodes', 'storeCodes']) {
    const declaration = worker.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`, 'u'))
    assert(declaration, `Worker ${name} declaration must remain discoverable`)
    codes.push(...[...declaration[1]!.matchAll(/'([^']+)'/gu)].map(match => match[1]!))
  }
  const transport = network.match(/export type McpTransportErrorCode =([\s\S]*?)\n\n/u)
  assert(transport, 'Transport error declaration must remain discoverable')
  codes.push(...[...transport[1]!.matchAll(/'([^']+)'/gu)].map(match => `mcp_${match[1]}`),
    'mcp_check_snapshot_failed', 'mcp_check_discovery_failed', 'mcp_check_expired')
  for (const errorCode of new Set(codes)) {
    const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...pendingCheck, state: 'failed', errorCode }))
    const check = await client.getCheck(connectionId, checkId)
    assert.equal(check.state, 'failed')
    assert.notEqual(check.error_code, 'MCP_CONNECTION_FAILED', errorCode)
    assert(check.error_code)
    const label = personalMcpCheckErrorLabel(check.error_code)
    assert(en[label].length > 0 && zh[label].length > 0, errorCode)
    assert.notEqual(en[label], 'Connection failed', errorCode)
    assert.notEqual(zh[label], '连接失败', errorCode)
  }
})

test('admission and catalog limits keep their exact public category without remote detail', async () => {
  const cases = [
    ['mcp_schema_unsupported', 'MCP_SCHEMA_UNSUPPORTED', 'mcpCheckErrorSchemaUnsupported'],
    ['mcp_tasks_unsupported', 'MCP_TASKS_UNSUPPORTED', 'mcpCheckErrorTasksUnsupported'],
    ['mcp_tool_size_limit', 'MCP_TOOL_SIZE_LIMIT', 'mcpCheckErrorToolSizeLimit'],
    ['mcp_description_size_limit', 'MCP_DESCRIPTION_SIZE_LIMIT', 'mcpCheckErrorDescriptionSizeLimit'],
    ['mcp_catalog_limit', 'MCP_CATALOG_LIMIT', 'mcpCheckErrorCatalogLimit'],
    ['revision_conflict', 'MCP_CHECK_STALE', 'mcpCheckErrorStale'],
    ['mcp_timeout', 'MCP_CHECK_TIMEOUT', 'mcpCheckErrorTimeout'],
  ] as const
  for (const [errorCode, sanitized, label] of cases) {
    const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...pendingCheck, state: 'failed', errorCode }))
    const check = await client.getCheck(connectionId, checkId)
    assert.equal(check.error_code, sanitized)
    assert.equal(personalMcpCheckErrorLabel(sanitized), label)
  }
})

test('unknown error codes remain masked and do not claim the HTTP connection failed', async () => {
  for (const errorCode of ['remote_private_token', 'mcp_schema_unsupported_private_detail']) {
    const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...pendingCheck, state: 'failed', errorCode }))
    const check = await client.getCheck(connectionId, checkId)
    assert.equal(check.error_code, 'MCP_CONNECTION_FAILED')
    assert.equal(personalMcpCheckErrorLabel(check.error_code), 'mcpCheckErrorGeneric')
    assert.equal(en.mcpCheckErrorGeneric, 'The check could not be completed')
    assert.equal(zh.mcpCheckErrorGeneric, '检查未完成')
    assert.equal(JSON.stringify(check).includes(errorCode), false)
  }
})
