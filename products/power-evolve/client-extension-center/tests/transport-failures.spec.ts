/** Public HTTP reply and request boundaries; no Platform, approval service or executor is started. */
import { afterEach, expect, test, vi } from 'vitest'
import { PersonalMcpConnectionHttpClient } from '../src/client/personal-mcp-api.ts'
import { PersonalMcpConnectionRequestError, type PersonalMcpConnectionCreateRequest } from '../src/client/personal-mcp-client.ts'
import { PersonalSshHttpClient } from '../src/client/ssh-api.ts'
import { StdioV2HttpClient } from '../src/client/stdio-v2-api.ts'
import { available, id } from './stdio-v2-fixtures.ts'
import { bodyText, jsonRecord, requestUrl } from './fetch-fixture.ts'

const connectionId = id(101), requestId = id(102), checkId = id(103), sessionId = id(104)
const connection = {
  connectionId, revision: 2, configurationRevision: 2, credentialRevision: null,
  displayName: 'Boundary connection', serverName: 'boundary', serverUrl: 'https://endpoint.test/mcp',
  transport: 'streamable-http', authentication: 'none', headerNames: [], secretConfigured: false,
  enabled: false, deletedAt: null, currentCatalogId: null,
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
}
const check = {
  checkId, draftId: null, connectionId, sessionId, connectionRevision: 2, configurationRevision: 2,
  credentialRevision: null, state: 'queued', catalogId: null, discoveredTools: null,
  errorCode: null, cancelRequested: false, createdAt: '2026-09-30T00:00:00.000Z', expiresAt: '2099-09-30T00:00:00.000Z',
}
const form: PersonalMcpConnectionCreateRequest = {
  display_name: connection.displayName, server_url: connection.serverUrl, enabled: false, authentication: { kind: 'none' },
}
const bearer: PersonalMcpConnectionCreateRequest = {
  ...form, authentication: { kind: 'bearer' }, secrets: { bearer_token: 'write-only token' },
}
const ticket = { state: 'pending', requestId, ticket: 't'.repeat(40),
  uploadUrl: 'https://platform.test/mcp/connections/upload', expiresAt: '2099-09-30T00:00:00.000Z' }

afterEach(() => { vi.unstubAllGlobals() })

test('both personal HTTP adapters use the current global browser transport by default', async () => {
  const request = vi.fn<typeof fetch>(async input => Response.json(requestUrl(input).endsWith('mcpConnectionsList')
    ? { available: true, items: [] } : { available: false, items: [] }))
  const mcp = new PersonalMcpConnectionHttpClient(), ssh = new PersonalSshHttpClient()
  vi.stubGlobal('fetch', request)
  expect(await mcp.list()).toEqual({ available: true, items: [] })
  expect(await ssh.list()).toEqual({ available: false, items: [] })
  expect(request).toHaveBeenCalledTimes(2)
})

test.each([
  ['missing media type', () => new Response('{}')],
  ['wrong media type', () => new Response('{}', { headers: { 'content-type': 'text/plain' } })],
  ['interrupted JSON reply', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
] as const)('MCP metadata rejects %s as an invalid service reply', async (_label, reply) => {
  await expect(new PersonalMcpConnectionHttpClient(async () => reply()).list()).rejects.toMatchObject({ status: 502 })
})

test.each([
  ['unparseable endpoint', { serverUrl: 'not a URL' }],
  ['foreign protocol', { serverUrl: 'file:///mcp' }],
  ['embedded user', { serverUrl: 'https://user@endpoint.test/mcp' }],
  ['embedded password', { serverUrl: 'https://:secret@endpoint.test/mcp' }],
  ['endpoint fragment', { serverUrl: 'https://endpoint.test/mcp#fragment' }],
  ['unknown authentication', { authentication: 'oauth' }],
  ['impossible anonymous secret', { secretConfigured: true }],
  ['invalid header name', { authentication: 'headers', headerNames: ['bad name'] }],
  ['duplicate header names', { authentication: 'headers', headerNames: ['X-Key', 'x-key'] }],
  ['excess headers', { authentication: 'headers', headerNames: Array.from({ length: 17 }, (_, index) => 'X-' + String(index)) }],
] as const)('MCP list rejects %s without returning trusted metadata', async (_label, fields) => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ available: true,
    items: [{ connection: { ...connection, ...fields }, latestCheck: null }] }))
  await expect(client.list()).rejects.toMatchObject({ status: 502 })
})

test.each([
  ['dns_failed', 'MCP_DNS_FAILED'], ['connect_timeout', 'MCP_CONNECT_TIMEOUT'], ['tls_failed', 'MCP_TLS_FAILED'],
  ['auth_rejected', 'MCP_AUTH_REJECTED'], ['protocol_error', 'MCP_PROTOCOL_INVALID'], ['check_discovery_failed', 'MCP_DISCOVERY_FAILED'],
  ['response_limit', 'MCP_RESPONSE_LIMIT'], ['cancelled', 'MCP_CANCELED'], ['schema_unsupported', 'MCP_SCHEMA_UNSUPPORTED'],
  ['tasks_unsupported', 'MCP_TASKS_UNSUPPORTED'], ['tool_size_limit', 'MCP_TOOL_SIZE_LIMIT'],
  ['description_size_limit', 'MCP_DESCRIPTION_SIZE_LIMIT'], ['tool_name_conflict', 'MCP_TOOL_NAME_CONFLICT'],
  ['catalog_limit', 'MCP_CATALOG_LIMIT'], ['tool_duplicate', 'MCP_TOOL_DUPLICATE'], ['tool_collision', 'MCP_TOOL_COLLISION'],
  ['revision_conflict', 'MCP_CHECK_STALE'], ['connection_not_found', 'MCP_CONNECTION_UNAVAILABLE'],
  ['check_snapshot_failed', 'MCP_CHECK_SNAPSHOT_FAILED'], ['check_expired', 'MCP_CHECK_EXPIRED'],
] as const)('MCP saved checks retain the public failure meaning of %s', async (errorCode, expected) => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...check, state: 'failed', errorCode }))
  expect((await client.getCheck(connectionId, checkId)).error_code).toBe(expected)
})

test('header metadata can preserve existing values without a credential upload', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ ...connection, authentication: 'headers', headerNames: ['X-Key'] }))
  const client = new PersonalMcpConnectionHttpClient(request)
  const value = await client.create({ ...form, authentication: { kind: 'headers' }, headers: [{ name: 'X-Key' }] }, requestId)
  expect(value.headers).toEqual([{ name: 'X-Key', value_configured: false }])
  const init = request.mock.calls[0]?.[1]
  expect(jsonRecord(JSON.parse(bodyText(init?.body)))).toEqual({ request: { requestId, configuration: {
    displayName: form.display_name, serverUrl: form.server_url, enabled: false,
    authentication: { kind: 'headers', headers: [{ name: 'X-Key', action: 'retain' }] },
  } } })
  expect(request).toHaveBeenCalledOnce()
})

test('a header form with no replacement values avoids ticket and credential intake', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ ...connection, authentication: 'headers' }))
  const client = new PersonalMcpConnectionHttpClient(request)
  expect((await client.create({ ...form, authentication: { kind: 'headers' } }, requestId)).headers).toEqual([])
  expect(request).toHaveBeenCalledOnce()
})

test('explicit bearer clearing changes metadata without transmitting a secret', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ ...connection, revision: 3, authentication: 'bearer' }))
  const client = new PersonalMcpConnectionHttpClient(request)
  await client.update(connectionId, { ...form, authentication: { kind: 'bearer' },
    expected_revision: 2, clear_secret_keys: ['bearer_token'] }, requestId)
  const init = request.mock.calls[0]?.[1]
  expect(jsonRecord(JSON.parse(bodyText(init?.body)))).toEqual({ request: { requestId, connectionId, baseRevision: 2,
    configuration: { displayName: form.display_name, serverUrl: form.server_url, enabled: false,
      authentication: { kind: 'bearer', action: 'clear' } } } })
  expect(request).toHaveBeenCalledOnce()
})

test.each([
  ['wrong check ID', { checkId: id(105) }],
  ['wrong connection', { connectionId: id(106) }],
  ['draft on saved route', { draftId: id(107) }],
  ['unknown state', { state: 'completed' }],
  ['malformed failure code', { errorCode: 'SECRET DETAILS' }],
] as const)('MCP check status refuses %s', async (_label, fields) => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...check, ...fields }))
  await expect(client.getCheck(connectionId, checkId)).rejects.toMatchObject({ status: 502 })
})

test('draft metadata rejects an unpaired saved connection revision before sending', async () => {
  const request = vi.fn<typeof fetch>()
  const client = new PersonalMcpConnectionHttpClient(request)
  await expect(client.createDraftCheck({ configuration: form, session_id: sessionId, connection_id: connectionId }, requestId))
    .rejects.toMatchObject({ status: 400 })
  await expect(client.createDraftCheck({ configuration: form, session_id: sessionId, expected_revision: 2 }, requestId))
    .rejects.toMatchObject({ status: 400 })
  expect(request).not.toHaveBeenCalled()
})

test('saved reads and cancellation reject invalid IDs before transport', async () => {
  const request = vi.fn<typeof fetch>(), mcp = new PersonalMcpConnectionHttpClient(request), ssh = new PersonalSshHttpClient(request)
  await expect(mcp.getCheck('invalid', checkId)).rejects.toMatchObject({ status: 400 })
  await expect(mcp.cancelCheck(connectionId, 'invalid', requestId)).rejects.toMatchObject({ status: 400 })
  await expect(mcp.getDraftCheck('invalid')).rejects.toMatchObject({ status: 400 })
  await expect(mcp.cancelDraftCheck('invalid', requestId)).rejects.toMatchObject({ status: 400 })
  await expect(ssh.check({ requestId: 'invalid', connectionId, connectionRevision: 1 })).rejects.toThrow('Invalid SSH check request')
  await expect(ssh.callStatus('invalid')).rejects.toThrow('Invalid SSH call ID')
  await expect(ssh.callCancel('invalid')).rejects.toThrow('Invalid SSH call ID')
  expect(request).not.toHaveBeenCalled()
})

test.each([
  ['expired ticket', { expiresAt: '2000-01-01T00:00:00.000Z' }, 410],
  ['relative upload destination', { uploadUrl: '/mcp/connections/upload' }, 502],
] as const)('credential intake refuses %s before upload', async (_label, fields, status) => {
  const request = vi.fn<typeof fetch>(async input => Response.json(requestUrl(input) === '/config'
    ? { approvalUrl: 'https://platform.test/approval' } : { ...ticket, ...fields }))
  await expect(new PersonalMcpConnectionHttpClient(request).create(bearer, requestId)).rejects.toMatchObject({ status })
  expect(request.mock.calls.every(([input]) => requestUrl(input).startsWith('/'))).toBe(true)
})

test('oversized MCP credential intake is rejected before reserving a ticket', async () => {
  const request = vi.fn<typeof fetch>()
  await expect(new PersonalMcpConnectionHttpClient(request).create({ ...bearer, secrets: { bearer_token: 's'.repeat(17000) } }, requestId))
    .rejects.toMatchObject({ status: 413 })
  expect(request).not.toHaveBeenCalled()
})

test('received credential refusal remains definitive after an empty receipt lookup', async () => {
  const paths: string[] = []
  const client = new PersonalMcpConnectionHttpClient(async (input) => {
    const route = requestUrl(input); paths.push(route)
    if (route === '/config') return Response.json({ approvalUrl: 'https://platform.test/approval' })
    if (route.endsWith('mcpConnectionsTicket')) return Response.json(ticket)
    if (route.endsWith('mcpConnectionsReceipt')) return Response.json({ result: null })
    return Response.json({ privateDetail: 'not public' }, { status: 403 })
  })
  await expect(client.create(bearer, requestId)).rejects.toBeInstanceOf(PersonalMcpConnectionRequestError)
  expect(paths).toEqual(['/api/powerEvolve/mcpConnectionsTicket', '/config', ticket.uploadUrl,
    '/api/powerEvolve/mcpConnectionsReceipt'])
})

test.each(['status', 'cancel'] as const)('SSH %s refuses a reply for another check', async (action) => {
  const client = new PersonalSshHttpClient(async () => Response.json({ callId: id(108), state: 'succeeded' }))
  await expect(action === 'status' ? client.callStatus(checkId) : client.callCancel(checkId)).rejects.toThrow('SSH call response mismatch')
})

test('SSH live lists reject historical tombstones', async () => {
  const deleted = { connectionId, revision: 2, credentialRevision: 1, displayName: 'Deleted server', host: 'server.test', port: 22,
    username: 'alice', hostKeySha256: 'SHA256:' + 'a'.repeat(43), workingDirectory: null, authentication: 'password',
    secretConfigured: true, passphraseConfigured: false, enabled: false, deletedAt: '2026-09-30T00:00:00.000Z',
    createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' }
  await expect(new PersonalSshHttpClient(async () => Response.json({ available: true, items: [deleted] })).list())
    .rejects.toThrow('Invalid SSH list response')
})

test('STDIO connection pages reject a continuation without a final item', async () => {
  const client = new StdioV2HttpClient(async input => Response.json(requestUrl(input).endsWith('Config')
    ? available : { items: [], next: id(109) }))
  await client.config()
  await expect(client.list({})).rejects.toThrow('STDIO connection page mismatch')
})

test.each([null, { available: true, items: null }, { available: 'true', items: [] },
  { available: true, items: [{ connection }] }])('MCP list rejects an incomplete public envelope', async (reply) => {
  await expect(new PersonalMcpConnectionHttpClient(async () => Response.json(reply)).list()).rejects.toMatchObject({ status: 502 })
})

test('MCP does not send an unsupported cursor or inconsistent saved-check identity', async () => {
  const request = vi.fn<typeof fetch>(), client = new PersonalMcpConnectionHttpClient(request)
  await expect(client.list({ cursor: connectionId })).rejects.toMatchObject({ status: 400 })
  await expect(client.createCheck(connectionId, { session_id: sessionId, configuration: form,
    connection_id: id(110), expected_revision: 2 }, requestId)).rejects.toMatchObject({ status: 400 })
  await expect(client.createCheck(connectionId, { session_id: sessionId, configuration: form,
    connection_id: connectionId, expected_revision: 0 }, requestId)).rejects.toMatchObject({ status: 400 })
  expect(request).not.toHaveBeenCalled()
})

test('a completed credential ticket returns matching metadata without uploading again', async () => {
  const item = { ...connection, authentication: 'bearer', secretConfigured: true }
  const request = vi.fn<typeof fetch>(async () => Response.json({ state: 'ready', result: { kind: 'connection', item } }))
  const result = await new PersonalMcpConnectionHttpClient(request).create(bearer, requestId)
  expect(result.authentication).toEqual({ kind: 'bearer', secret_configured: true })
  expect(request).toHaveBeenCalledOnce()
})

test.each([
  ['missing result fields', { kind: 'connection' }],
  ['unknown result purpose', { kind: 'unknown', item: connection }],
] as const)('a ready credential ticket rejects %s', async (_label, result) => {
  await expect(new PersonalMcpConnectionHttpClient(async () => Response.json({ state: 'ready', result }))
    .create(bearer, requestId)).rejects.toMatchObject({ status: 502 })
})

test.each(['create', 'update', 'draft'] as const)('a ready credential ticket cannot cross the %s operation purpose', async (operation) => {
  const result = operation === 'draft'
    ? { kind: 'connection', item: { ...connection, authentication: 'bearer', secretConfigured: true } }
    : { kind: 'check', item: check }
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ state: 'ready', result }))
  const action = operation === 'create' ? client.create(bearer, requestId)
    : operation === 'update' ? client.update(connectionId, { ...bearer, expected_revision: 1 }, requestId)
      : client.createDraftCheck({ session_id: sessionId, configuration: bearer }, requestId)
  await expect(action).rejects.toMatchObject({ status: 502 })
})

test.each([
  ['wrong connection', { connectionId: id(111), revision: 3 }],
  ['unchanged revision', { revision: 2 }],
] as const)('MCP updates refuse %s', async (_label, fields) => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...connection, ...fields }))
  await expect(client.update(connectionId, { ...form, expected_revision: 2 }, requestId)).rejects.toMatchObject({ status: 502 })
})

test.each([
  ['renamed display', { displayName: 'Another form' }], ['changed endpoint', { serverUrl: 'https://other.test/mcp' }],
  ['changed enablement', { enabled: true }], ['changed authentication', { authentication: 'bearer' }],
] as const)('MCP creates refuse %s in a received mutation reply', async (_label, fields) => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...connection, ...fields }))
  await expect(client.create(form, requestId)).rejects.toMatchObject({ status: 502 })
})

test.each([
  ['wrong connection', { connectionId: id(112), enabled: true, revision: 3 }],
  ['wrong enablement', { enabled: false, revision: 3 }], ['unchanged revision', { enabled: true, revision: 2 }],
] as const)('MCP toggles refuse %s', async (_label, fields) => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...connection, ...fields }))
  await expect(client.toggle(connectionId, 2, true, requestId)).rejects.toMatchObject({ status: 502 })
})

test.each([
  ['wrong connection', { connectionId: id(113), revision: 3 }], ['enabled tombstone', { enabled: true, revision: 3 }],
  ['unchanged revision', { revision: 2 }],
] as const)('MCP deletion refuses %s', async (_label, fields) => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...connection,
    deletedAt: '2026-09-30T00:00:00.000Z', ...fields }))
  await expect(client.remove(connectionId, 2, requestId)).rejects.toMatchObject({ status: 502 })
})

test('a saved-connection draft carries its source revision and independent draft result', async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ ...check, draftId: id(114) }))
  const client = new PersonalMcpConnectionHttpClient(request)
  expect((await client.createDraftCheck({ session_id: sessionId, configuration: form,
    connection_id: connectionId, expected_revision: 2 }, requestId)).check_id).toBe(checkId)
  expect(jsonRecord(JSON.parse(bodyText(request.mock.calls[0]?.[1]?.body)))).toEqual({ request: {
    requestId, sessionId, sourceConnectionId: connectionId, baseRevision: 2,
    configuration: { displayName: form.display_name, serverUrl: form.server_url, enabled: false, authentication: { kind: 'none' } },
  } })
})

test('still-uncertain credential recovery retries the receipt without uploading the same secret again', async () => {
  const request = vi.fn<typeof fetch>(async (input) => {
    const route = requestUrl(input)
    if (route === '/config') return Response.json({ approvalUrl: 'https://platform.test/approval' })
    if (route.endsWith('mcpConnectionsTicket')) return Response.json(ticket)
    if (route.endsWith('mcpConnectionsReceipt')) return Response.json({ result: null })
    throw new Error('Upload reply lost')
  })
  const client = new PersonalMcpConnectionHttpClient(request)
  await expect(client.create(bearer, requestId)).rejects.toMatchObject({ status: 503 })
  await expect(client.create(bearer, requestId)).rejects.toMatchObject({ status: 503 })
  expect(request.mock.calls.filter(([input]) => requestUrl(input) === ticket.uploadUrl)).toHaveLength(1)
  expect(request.mock.calls.filter(([input]) => requestUrl(input).endsWith('mcpConnectionsReceipt'))).toHaveLength(2)
})

test('credential recovery rejects an incomplete receipt envelope', async () => {
  const client = new PersonalMcpConnectionHttpClient(async (input) => {
    const route = requestUrl(input)
    if (route === '/config') return Response.json({ approvalUrl: 'https://platform.test/approval' })
    if (route.endsWith('mcpConnectionsTicket')) return Response.json(ticket)
    if (route.endsWith('mcpConnectionsReceipt')) return Response.json({ privateDetail: 'untrusted' })
    throw new Error('Upload reply lost')
  })
  await expect(client.create(bearer, requestId)).rejects.toMatchObject({ status: 502 })
})

test.each([{ state: 'ready' }, { ...ticket, ticket: 'short' }, { ...ticket, requestId: id(115) }])(
  'credential intake refuses a malformed reservation before upload', async (value) => {
    const request = vi.fn<typeof fetch>(async () => Response.json(value))
    await expect(new PersonalMcpConnectionHttpClient(request).create(bearer, requestId)).rejects.toMatchObject({ status: 502 })
    expect(request).toHaveBeenCalledOnce()
  })

test.each([
  ['protocol_invalid', 'MCP_PROTOCOL_INVALID'], ['discovery_failed', 'MCP_DISCOVERY_FAILED'], ['canceled', 'MCP_CANCELED'],
] as const)('MCP checks preserve the alternate public spelling %s', async (errorCode, expected) => {
  const client = new PersonalMcpConnectionHttpClient(async () => Response.json({ ...check, state: 'failed', errorCode }))
  expect((await client.getCheck(connectionId, checkId)).error_code).toBe(expected)
})

test('SSH check reads retain public error codes and an explicit null result', async () => {
  const client = new PersonalSshHttpClient(async () => Response.json({ callId: checkId, state: 'failed', errorCode: 'auth_rejected', result: null }))
  expect(await client.callStatus(checkId)).toEqual({ callId: checkId, state: 'failed', errorCode: 'auth_rejected', result: null })
})

test.each(['', 'x'.repeat(101)])('SSH rejects an invalid public error code', async (errorCode) => {
  const client = new PersonalSshHttpClient(async () => Response.json({ callId: checkId, state: 'failed', errorCode }))
  await expect(client.callStatus(checkId)).rejects.toThrow('Invalid SSH check response')
})

test('SSH upload recovery refuses a non-receipt reply', async () => {
  const input = { requestId, configuration: { displayName: 'Server', host: 'server.test', port: 22, username: 'alice',
    hostKeySha256: 'SHA256:' + 'a'.repeat(43), workingDirectory: null,
    authentication: { kind: 'password' as const, password: 'replace' as const }, enabled: false },
  credentials: { formatVersion: 2 as const, password: 'write-only password' } }
  const client = new PersonalSshHttpClient(async (url) => {
    const route = requestUrl(url)
    if (route.endsWith('sshConnectionsTicket')) return Response.json({ ...ticket, uploadUrl: 'https://platform.test/ssh/upload' })
    if (route === '/config') return Response.json({ approvalUrl: 'https://platform.test/approval' })
    if (route.endsWith('sshConnectionsReceipt')) return Response.json({ wrong: 'envelope' })
    throw new Error('Upload reply lost')
  })
  await expect(client.create(input)).rejects.toThrow('Invalid SSH receipt response')
})
