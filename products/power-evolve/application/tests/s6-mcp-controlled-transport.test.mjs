/** Real TLS protocol fixtures; these do not claim real-service or native-client acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { discoverMcp, callMcp, McpTransportError, McpDispatchRejected } from '../lib/platform/mcp-transport.js'
import { McpNetworkOperation } from '../lib/platform/mcp-network.js'

const budgets = { timeoutMs: 10_000, idleTimeoutMs: 5_000, maxRequestBytes: 65_536,
  maxResponseBytes: 65_536, maxTotalResponseBytes: 262_144, maxResponseHeaderBytes: 16_384,
  maxRequests: 32, maxHeaderBytes: 8_192, maxHeaders: 16, maxPages: 4, maxTools: 16,
  maxCatalogBytes: 65_536 }
const tools = [
  { name: 'sum', description: '加总\u0000 literal \\u0000', inputSchema: { type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  annotations: { readOnlyHint: true, extension: { original: '\u0000' } },
  extension: { original: '\u0000', nested: [{ message: '表😀', literal: '\\u0000' }] } },
  { name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
]
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const rejects = (code, dispatched = false) => error => {
  assert(error instanceof McpTransportError)
  assert.equal(error.code, code)
  assert.equal(error.dispatched, dispatched)
  assert.equal(error.phase, dispatched ? 'after-dispatch' : 'before-dispatch')
  assert.equal(error.message, code)
  assert.equal(error.cause, undefined)
  return true
}

test('remote MCP uses pinned TLS sockets and a one-use dispatch gate', { timeout: 60_000 }, async t => {
  if (spawnSync('openssl', ['version']).status !== 0) { t.skip('OpenSSL is unavailable'); return }
  const temporary = await mkdtemp(join(tmpdir(), 'pe-s6-mcp-'))
  let server
  const socketCloses = [], seen = [], sessions = new Map(), ownedChildren = new Set()
  t.after(async () => {
    for (const child of ownedChildren) child.kill()
    await Promise.all([...ownedChildren].map(child => once(child, 'close')))
    if (server?.listening) {
      const closed = new Promise(done => server.close(done))
      server.closeAllConnections()
      await closed
    }
    await Promise.all(socketCloses)
    await rm(temporary, { recursive: true, force: true })
  })
  const keyPath = join(temporary, 'key.pem'), caPath = join(temporary, 'ca.pem')
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', caPath, '-days', '1', '-subj', '/CN=mcp-fixture.test',
    '-addext', 'subjectAltName=DNS:mcp-fixture.test,IP:127.0.0.1'], { encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  const ca = await readFile(caPath, 'utf8')
  let nextSession = 0
  server = createServer({ key: await readFile(keyPath), cert: ca }, async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8'), message = raw ? JSON.parse(raw) : {}
      const path = request.url
      seen.push({ path, method: request.method, rpc: message.method, message,
        authorization: request.headers.authorization, key: request.headers['x-api-key'],
        session: request.headers['mcp-session-id'], sni: request.socket.servername,
        lastEventId: request.headers['last-event-id'] })
      const json = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
      const modern = path?.startsWith('/modern')
      const rpc = result => {
        const payload = modern ? { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } : result
        if (path === '/modern-missing-list-cache' && message.method === 'tools/list') delete payload.ttlMs
        json({ jsonrpc: '2.0', id: message.id, result: payload })
      }
      if (request.method === 'GET') { response.writeHead(405).end(); return }
      if (request.method === 'DELETE') { sessions.delete(request.headers['mcp-session-id']); response.writeHead(200).end(); return }
      if (message.method === 'server/discover') {
        if (modern) { rpc({ supportedVersions: ['2026-07-28'],
          capabilities: path === '/modern-no-tools' ? {} : { tools: {} } }); return }
        json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'legacy fixture' } }); return
      }
      if (path === '/init-redirect') { response.writeHead(307, { location: 'https://127.0.0.1:1/private' }).end(); return }
      if (message.method === 'initialize') {
        const session = `fixture-${++nextSession}`
        sessions.set(session, request.headers.authorization ?? request.headers['x-api-key'] ?? 'none')
        response.setHeader('mcp-session-id', session)
        rpc({ protocolVersion: message.params.protocolVersion,
          capabilities: path === '/no-tool-capability' ? {} : { tools: {} },
          serverInfo: { name: 'real-tls-fixture', version: '1.0.0' } }); return
      }
      const credential = request.headers.authorization ?? request.headers['x-api-key'] ?? 'none'
      if (!modern && path !== '/wire-gate' && sessions.get(request.headers['mcp-session-id']) !== credential) {
        response.writeHead(403).end(); return
      }
      if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return }
      if (message.method === 'tools/list') {
        if (path === '/invalid-list' || path === '/modern-invalid-list') rpc({ tools: [{ name: 'invalid', inputSchema: { type: 'string' } }] })
        else if (modern) rpc({ tools: [{ ...tools[0], inputSchema: { type: 'object',
          properties: { a: { type: 'number', 'x-mcp-header': 'Authorization' }, b: { type: 'number' } } } }] })
        else if (path === '/zero') rpc({ tools: [] })
        else if (path === '/cycle') rpc({ tools: [], nextCursor: 'same' })
        else if (path === '/duplicate') rpc({ tools: [tools[0]], ...(message.params?.cursor ? {} : { nextCursor: 'second' }) })
        else if (path === '/catalog-change') rpc({ tools: [{ ...tools[0], description: 'changed remotely' }] })
        else if (path === '/external-schema') rpc({ tools: [{ name: 'echo', inputSchema: { type: 'object',
          properties: { message: { $ref: 'https://127.0.0.1:1/forbidden-schema' } } } }] })
        else rpc(message.params?.cursor ? { tools: [tools[1]] }
          : { tools: [tools[0]], nextCursor: 'second', _meta: { fixture: '\u0000' } })
        return
      }
      if (message.method !== 'tools/call') { response.writeHead(404).end(); return }
      const args = message.params.arguments
      const result = message.params.name === 'sum'
        ? { content: [{ type: 'text', text: String(args.a + args.b), extension: { original: '\u0000' } }],
          structuredContent: { sum: args.a + args.b }, extension: { nested: ['\u0000', { message: '表😀' }] } }
        : { content: [{ type: 'text', text: args.message, extension: { original: '\u0000' } }, { type: 'resource_link', name: 'opaque',
          uri: 'https://127.0.0.1:1/do-not-fetch' }], structuredContent: { message: args.message }, _meta: { raw: '\u0000' } }
      if (path === '/invalid-call' || path === '/modern-invalid-call') { rpc({ content: [{ type: 'text', text: 42 }] }); return }
      if (path === '/contentless-call') { rpc({ structuredContent: { value: 42 }, extension: { original: '\u0000' } }); return }
      if (path === '/drop') { request.socket.destroy(); return }
      if (path === '/half') {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': 1_000 })
        response.write('{"jsonrpc":"2.0",', () => setImmediate(() => response.destroy())); return
      }
      if (path === '/slow') { response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders(); return }
      if (path === '/overflow') { response.writeHead(200, { 'content-type': 'application/json',
        'content-length': budgets.maxResponseBytes + 1 }); response.flushHeaders(); return }
      if (path === '/chunk-overflow') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('x'.repeat(budgets.maxResponseBytes + 1)); return }
      if (path === '/header-overflow') { response.setHeader('x-padding', 'x'.repeat(budgets.maxResponseHeaderBytes)); rpc(result); return }
      if (path === '/upgrade') { response.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' }).end(); return }
      if (path === '/sse-drip') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': keep-alive\n\n')
        const interval = setInterval(() => response.write(': keep-alive\n\n'), 100)
        response.once('close', () => clearInterval(interval)); return
      }
      if (path === '/redirect-call') { response.writeHead(307, { location: 'https://127.0.0.1:1/forbidden' }).end(); return }
      if (path === '/auth-fail-on-call') {
        response.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="https://127.0.0.1:1/oauth"' })
        response.end(JSON.stringify({ private: request.headers.authorization })); return
      }
      if (path === '/rpc-error') {
        json({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'private echo ' + credential } }); return
      }
      if (path === '/modern-header-error') {
        json({ jsonrpc: '2.0', id: message.id, error: { code: -32020, message: 'HEADER_MISMATCH' } }); return
      }
      if (path === '/boundary' || path === '/boundary-plus-one') {
        const value = { jsonrpc: '2.0', id: message.id, result: { content: [], _meta: { padding: '' } } }
        value.result._meta.padding = 'x'.repeat(budgets.maxResponseBytes - Buffer.byteLength(JSON.stringify(value))
          + (path === '/boundary-plus-one' ? 1 : 0))
        json(value); return
      }
      if (path === '/tool-error') { rpc({ content: [{ type: 'text', text: 'tool declined' }], isError: true }); return }
      if (path === '/sse' || path === '/sse-prime' || path === '/sse-overflow' || path === '/sse-invalid') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (path === '/sse-prime') response.end('id: resume-token\nevent: message\ndata: \n\n')
        else if (path === '/sse-overflow') response.end(':' + 'x'.repeat(budgets.maxResponseBytes) + '\n\n')
        else if (path === '/sse-invalid') response.end('data: {malformed\n\n')
        else response.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n\n')
        return
      }
      rpc(result)
    } catch (error) {
      if (!request.destroyed) response.destroy(error)
    }
  })
  server.on('connection', socket => { socketCloses.push(new Promise(done => socket.once('close', done))) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `https://mcp-fixture.test:${server.address().port}`
  const target = (path = '/tools', headers = { Authorization: 'Bearer fixture-a' }) => ({ endpoint: origin + path, headers })
  const options = (overrides = {}) => ({ signal: new AbortController().signal, budgets,
    networkPolicy: { internalExceptions: [{ origin, addresses: ['127.0.0.1'], ca }],
      resolve: async () => [{ address: '127.0.0.1', family: 4 }] }, ...overrides })
  const call = (path = '/tools', extra = {}) => callMcp(target(path), { name: 'sum', arguments: { a: 17, b: 25 } },
    { ...options(), onBeforeDispatch: async () => {}, ...extra })
  const calls = path => seen.filter(item => item.path === path && item.rpc === 'tools/call').length

  await t.test('raw multi-page directory and parameterized tools preserve NUL, metadata and opaque resources', async () => {
    assert.deepEqual(await discoverMcp(target(), options()), { tools, _meta: { fixture: '\u0000' } })
    let gates = 0
    const sum = await call('/tools', { onBeforeDispatch: async (preflight, signal) => {
      assert.deepEqual(preflight, { toolName: 'sum', catalog: { tools, _meta: { fixture: '\u0000' } } })
      assert.equal(signal.aborted, false)
      assert.equal(calls('/tools'), 0)
      gates++
    } })
    assert.equal(gates, 1)
    assert.equal(sum.structuredContent.sum, 42)
    assert.deepEqual(sum.extension, { nested: ['\u0000', { message: '表😀' }] })
    assert.deepEqual(sum.content[0].extension, { original: '\u0000' })
    const message = '\u0000表😀 literal \\u0000'
    const echoed = await callMcp(target(), { name: 'echo', arguments: { message } },
      { ...options(), onBeforeDispatch: async () => {} })
    assert.equal(echoed.content[0].text, message)
    assert.equal(echoed.structuredContent.message, message)
    assert.equal(echoed._meta.raw, '\u0000')
    assert.equal(echoed.content[1].uri, 'https://127.0.0.1:1/do-not-fetch')
    assert.deepEqual(echoed.content[0].extension, { original: '\u0000' })
    assert(seen.every(item => item.sni === 'mcp-fixture.test'))
  })
  await t.test('none, Bearer and private custom headers use fresh principal-specific sessions', async () => {
    await Promise.all([discoverMcp(target('/none', {}), options()),
      discoverMcp(target('/bearer', { Authorization: 'Bearer fixture-b' }), options()),
      discoverMcp(target('/custom', { 'X-Api-Key': 'fixture-key' }), options())])
    const handshakes = seen.filter(item => item.rpc === 'initialize' && ['/none', '/bearer', '/custom'].includes(item.path))
    assert.equal(new Set(handshakes.map(item => item.path)).size, 3)
    const perPrincipal = seen.filter(item => item.rpc === 'tools/list' && ['/none', '/bearer', '/custom'].includes(item.path))
    assert.equal(new Set(perPrincipal.map(item => item.session)).size, 3)
    assert(perPrincipal.every(item => item.path === '/none' ? !item.authorization && !item.key
      : item.path === '/bearer' ? item.authorization === 'Bearer fixture-b' && !item.key
      : item.key === 'fixture-key' && !item.authorization))
    assert.equal(sessions.size, 0)
  })
  await t.test('zero tools is valid; missing tool, duplicate names and cyclic pagination reject explicitly', async () => {
    assert.deepEqual(await discoverMcp(target('/zero'), options()), { tools: [] })
    await assert.rejects(call('/zero'), rejects('tool_not_found'))
    await assert.rejects(discoverMcp(target('/duplicate'), options()), rejects('invalid_catalog'))
    await assert.rejects(discoverMcp(target('/cycle'), options()), rejects('invalid_catalog'))
    assert.equal(calls('/zero'), 0)
  })
  await t.test('legacy and modern services without a tools capability have a legal empty directory', async () => {
    for (const path of ['/no-tool-capability', '/modern-no-tools']) {
      assert.deepEqual(await discoverMcp(target(path), options()), { tools: [] })
      await assert.rejects(call(path), rejects('tool_not_found'))
      assert.equal(seen.filter(item => item.path === path && item.rpc === 'tools/list').length, 0)
      assert.equal(calls(path), 0)
    }
  })
  await t.test('directory changes rejected by the outer permission callback send zero tool POSTs', async () => {
    await assert.rejects(call('/catalog-change', { onBeforeDispatch: async ({ toolName, catalog }) => {
      assert.equal(toolName, 'sum')
      assert.notDeepEqual(catalog.tools, tools)
      throw new McpDispatchRejected()
    } }), rejects('dispatch_rejected'))
    assert.equal(calls('/catalog-change'), 0)
  })
  await t.test('lost permission COMMIT acknowledgement stays uncertain and sends zero tool POSTs', async () => {
    await assert.rejects(call('/commit-unknown', { onBeforeDispatch: async () => {
      throw new Error('private PG COMMIT response lost')
    } }), rejects('callback_uncertain', true))
    assert.equal(calls('/commit-unknown'), 0)
  })
  await t.test('tool name and arguments are frozen before asynchronous discovery and permission work', async () => {
    const input = { name: 'sum', arguments: { a: 1, b: 2 } }
    const result = await callMcp(target('/frozen'), input, { ...options(), onBeforeDispatch: async preflight => {
      assert.equal(preflight.toolName, 'sum')
      input.name = 'echo'
      input.arguments.a = 100
    } })
    assert.equal(result.structuredContent.sum, 3)
    assert.equal(calls('/frozen'), 1)
  })
  await t.test('modern SDK negotiation preserves raw tool headers and a HEADER_MISMATCH cannot resend tools/call', async () => {
    const catalog = await discoverMcp(target('/modern'), options())
    assert.equal(catalog.tools.length, 1)
    assert.equal(catalog.tools[0].inputSchema.properties.a['x-mcp-header'], 'Authorization')
    assert.equal(catalog.ttlMs, 0)
    assert.deepEqual(catalog.tools[0].extension, tools[0].extension)
    assert.deepEqual(catalog.tools[0].annotations.extension, tools[0].annotations.extension)
    const result = await call('/modern')
    assert.equal(result.structuredContent.sum, 42)
    assert.deepEqual(result.extension, { nested: ['\u0000', { message: '表😀' }] })
    assert.deepEqual(result.content[0].extension, { original: '\u0000' })
    await assert.rejects(call('/modern-header-error'), rejects('protocol_error', true))
    assert.equal(calls('/modern-header-error'), 1)
    assert.equal(seen.filter(item => item.path === '/modern-header-error' && item.rpc === 'tools/list').length, 1)
  })
  await t.test('raw preservation retains SDK validation, modern cache metadata requirements and legacy content defaults', async () => {
    for (const path of ['/invalid-list', '/modern-invalid-list', '/modern-missing-list-cache']) {
      await assert.rejects(discoverMcp(target(path), options()), rejects('protocol_error'))
      assert.equal(calls(path), 0)
    }
    for (const path of ['/invalid-call', '/modern-invalid-call']) {
      await assert.rejects(call(path), rejects('protocol_error', true))
      assert.equal(calls(path), 1)
    }
    assert.deepEqual(await call('/contentless-call'), { content: [], structuredContent: { value: 42 }, extension: { original: '\u0000' } })
  })
  await t.test('pending permission abort stays uncertain and late success cannot send a request', async () => {
    const entered = deferred(), release = deferred(), controller = new AbortController()
    const promise = call('/pending', { signal: controller.signal, onBeforeDispatch: async (_preflight, signal) => {
      entered.resolve()
      await release.promise
      assert.equal(signal.aborted, true)
    } })
    const failed = assert.rejects(promise, rejects('aborted', true))
    await entered.promise
    controller.abort()
    await failed
    const countAfterAbort = seen.length
    release.resolve()
    await new Promise(done => setImmediate(done))
    assert.equal(calls('/pending'), 0)
    assert.equal(seen.length, countAfterAbort)
  })
  await t.test('permission success followed by cancellation sends zero POSTs and retains issued-intent state', async () => {
    const controller = new AbortController()
    await assert.rejects(call('/cancel-after-intent', { signal: controller.signal,
      onBeforeDispatch: async () => { controller.abort() } }), rejects('aborted', true))
    assert.equal(calls('/cancel-after-intent'), 0)
  })
  await t.test('an already-aborted operation starts no DNS or socket and consumes its rejected work promise', async () => {
    const controller = new AbortController()
    controller.abort()
    let resolutions = 0
    const before = seen.length
    await assert.rejects(discoverMcp(target(), options({ signal: controller.signal,
      networkPolicy: { resolve: async () => { resolutions++; throw new Error('resolver must not start') } } })), rejects('aborted'))
    assert.equal(resolutions, 0)
    assert.equal(seen.length, before)
    await new Promise(done => setImmediate(done))
  })
  await t.test('real POST disconnect, truncated response and JSON-RPC error each issue exactly one call', async () => {
    for (const [path, code] of [['/drop', 'transport_error'], ['/half', 'transport_error'], ['/rpc-error', 'protocol_error']]) {
      await assert.rejects(call(path), rejects(code, true))
      assert.equal(calls(path), 1)
    }
    const result = await call('/tool-error')
    assert.deepEqual(result, { content: [{ type: 'text', text: 'tool declined' }], isError: true })
  })
  await t.test('fetch rejects an SDK replay and changed endpoint before any second socket or callback', async () => {
    const operation = new McpNetworkOperation(budgets, new AbortController().signal)
    let gates = 0
    try {
      const controlled = await operation.fetchFor(target('/wire-gate').endpoint, options().networkPolicy,
        async () => { gates++; operation.dispatched = true })
      const init = { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'sum', arguments: { a: 1, b: 2 } } }) }
      const response = await controlled.fetch(controlled.url, init)
      assert.equal((await response.json()).result.structuredContent.sum, 3)
      await assert.rejects(controlled.fetch(controlled.url, init), rejects('dispatch_replay_denied', true))
      assert.equal(gates, 1)
      assert.equal(calls('/wire-gate'), 1)
    } finally { await operation.dispose() }
    const another = new McpNetworkOperation(budgets, new AbortController().signal)
    try {
      const controlled = await another.fetchFor(target('/wire-gate').endpoint, options().networkPolicy, async () => {})
      await assert.rejects(controlled.fetch(origin + '/changed', { method: 'GET' }), rejects('endpoint_changed'))
      assert.equal(seen.filter(item => item.path === '/changed').length, 0)
    } finally { await another.dispose() }
  })
  await t.test('SSE result resolves while the stream is open; disconnect, malformed data and overflow never resume', async () => {
    assert.equal((await call('/sse')).structuredContent.sum, 42)
    for (const [path, code] of [['/sse-prime', 'protocol_error'], ['/sse-invalid', 'protocol_error'], ['/sse-overflow', 'response_limit']]) {
      await assert.rejects(call(path), rejects(code, true))
      assert.equal(calls(path), 1)
      assert.equal(seen.filter(item => item.path === path && item.lastEventId).length, 0)
      assert(seen.filter(item => item.path === path && item.method === 'GET').length <= 1)
    }
    await Promise.all(socketCloses)
  })
  await t.test('all DNS answers and mapped addresses are checked; one approved resolution pins all sockets and SNI', async () => {
    const before = seen.length
    for (const answers of [
      [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
      [{ address: '::ffff:127.0.0.1', family: 6 }],
      [{ address: '64:ff9b::7f00:1', family: 6 }],
      [{ address: '2002:7f00:1::', family: 6 }],
      [{ address: 'fe80::1', family: 6 }], [{ address: '100.64.0.1', family: 4 }],
      [{ address: '::ffff:8.8.8.8', family: 4 }],
    ]) {
      await assert.rejects(discoverMcp(target(), options({ networkPolicy: { resolve: async () => answers } })), rejects('address_denied'))
    }
    assert.equal(seen.length, before)
    let resolutions = 0
    await call('/pinned', { networkPolicy: { internalExceptions: [{ origin, addresses: ['127.0.0.1'], ca }],
      resolve: async () => { resolutions++; return [{ address: resolutions === 1 ? '::ffff:127.0.0.1' : '169.254.169.254', family: 6 }] } } })
    assert.equal(resolutions, 1)
    assert.equal(calls('/pinned'), 1)
    assert(seen.filter(item => item.path === '/pinned').every(item => item.sni === 'mcp-fixture.test'))
  })
  await t.test('TLS verification, endpoint protocol and redirects cannot bypass the destination policy', async () => {
    await assert.rejects(discoverMcp(target(), options({ networkPolicy: {
      internalExceptions: [{ origin, addresses: ['127.0.0.1'] }], resolve: async () => [{ address: '127.0.0.1', family: 4 }] } })),
    rejects('transport_error'))
    const badOrigin = origin.replace('mcp-fixture.test', 'wrong-certificate.test')
    await assert.rejects(discoverMcp({ endpoint: badOrigin + '/tools', headers: {} }, options({ networkPolicy: {
      internalExceptions: [{ origin: badOrigin, addresses: ['127.0.0.1'], ca }],
      resolve: async () => [{ address: '127.0.0.1', family: 4 }] } })), rejects('transport_error'))
    await assert.rejects(discoverMcp({ endpoint: 'http://127.0.0.1:1/tools', headers: {} }, options()), rejects('address_denied'))
    await assert.rejects(discoverMcp({ endpoint: 'https://user:secret@example.com/tools', headers: {} }, options()), rejects('invalid_endpoint'))
    await assert.rejects(discoverMcp(target('/init-redirect'), options()), rejects('redirect_denied'))
    await assert.rejects(call('/redirect-call'), rejects('redirect_denied', true))
    assert.equal(calls('/redirect-call'), 1)
    assert.equal(calls('/init-redirect'), 0)
  })
  await t.test('plain HTTP requires an operator exception for the exact origin and address', async st => {
    const plain = createHttpServer(server.listeners('request')[0])
    st.after(async () => {
      const closed = new Promise(done => plain.close(done))
      plain.closeAllConnections()
      await closed
    })
    await new Promise((resolve, reject) => { plain.once('error', reject); plain.listen(0, '127.0.0.1', resolve) })
    const plainOrigin = `http://127.0.0.1:${plain.address().port}`
    const httpTarget = { endpoint: plainOrigin + '/http-explicit', headers: {} }
    await assert.rejects(discoverMcp(httpTarget, options()), rejects('address_denied'))
    assert.equal(seen.filter(item => item.path === '/http-explicit').length, 0)
    const catalog = await discoverMcp(httpTarget, options({ networkPolicy: {
      internalExceptions: [{ origin: plainOrigin, addresses: ['127.0.0.1'], allowHttp: true }] } }))
    assert.deepEqual(catalog.tools, tools)
  })
  await t.test('credentials cannot override headers or appear in errors; HTTP auth challenges are never retried', async () => {
    const before = seen.length
    for (const headers of [{ Host: 'evil' }, { Cookie: 'secret' }, { 'mcp-session-id': 'secret' },
      { 'Proxy-Authorization': 'secret' }, { connection: 'keep-alive' }, { Authorization: 'one', authorization: 'two' },
      { 'X-Api-Key': 'secret\r\nHost: evil' }, { 'X-Api-Key': 'x'.repeat(budgets.maxHeaderBytes) },
      Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`X-Key-${index}`, 'secret']))]) {
      await assert.rejects(discoverMcp(target('/invalid-header', headers), options()), rejects('invalid_headers'))
    }
    assert.equal(seen.length, before)
    await assert.rejects(call('/auth-fail-on-call'), rejects('protocol_error', true))
    assert.equal(calls('/auth-fail-on-call'), 1)
    assert.equal(seen.filter(item => item.path === '/oauth').length, 0)
  })
  await t.test('catalog, request, response, total bytes and deadline budgets are explicit failures', async () => {
    await assert.rejects(discoverMcp(target(), options({ budgets: { ...budgets, maxTools: 1 } })), rejects('catalog_limit'))
    await assert.rejects(discoverMcp(target(), options({ budgets: { ...budgets, maxPages: 1 } })), rejects('catalog_limit'))
    await assert.rejects(discoverMcp(target(), options({ budgets: { ...budgets, maxCatalogBytes: 100 } })), rejects('catalog_limit'))
    await assert.rejects(discoverMcp(target(), options({ budgets: { ...budgets, maxRequests: 1 } })), rejects('request_limit'))
    await assert.rejects(discoverMcp(target(), options({ budgets: { ...budgets, timeoutMs: Number.NaN } })), rejects('invalid_config'))
    await assert.rejects(callMcp(target(), { name: 'echo', arguments: { message: 'x'.repeat(budgets.maxRequestBytes) } },
      { ...options(), onBeforeDispatch: async () => {} }), rejects('request_limit'))
    for (const path of ['/overflow', '/chunk-overflow', '/header-overflow']) {
      await assert.rejects(call(path), rejects('response_limit', true))
      assert.equal(calls(path), 1)
    }
    assert((await call('/boundary'))._meta.padding.length > 60_000)
    await assert.rejects(call('/boundary-plus-one'), rejects('response_limit', true))
    await assert.rejects(discoverMcp(target(), options({ budgets: { ...budgets, maxResponseBytes: 512,
      maxTotalResponseBytes: 512 } })), rejects('response_limit'))
    await assert.rejects(call('/slow', { budgets: { ...budgets, timeoutMs: 5_000, idleTimeoutMs: 1_500 } }), rejects('timeout', true))
    await assert.rejects(call('/upgrade'), rejects('unsupported_response', true))
    await assert.rejects(call('/sse-drip', { budgets: { ...budgets, timeoutMs: 2_000, idleTimeoutMs: 1_500 } }), rejects('timeout', true))
    assert.equal(calls('/sse-drip'), 1)
    await Promise.all(socketCloses)
    assert.deepEqual(await discoverMcp(target('/zero'), options()), { tools: [] })
  })
  await t.test('DNS waiting uses the operation deadline and a late resolution cannot open sockets', async () => {
    const started = deferred(), release = deferred()
    const before = seen.length
    await assert.rejects(discoverMcp(target(), options({ budgets: { ...budgets, timeoutMs: 300, idleTimeoutMs: 300 },
      networkPolicy: { resolve: async () => { started.resolve(); await release.promise; return [{ address: '127.0.0.1', family: 4 }] } } })), rejects('timeout'))
    await started.promise
    release.resolve()
    await new Promise(done => setImmediate(done))
    assert.equal(seen.length, before)
  })
  await t.test('remote schema references stay opaque and no resource or schema URL is fetched', async () => {
    const catalog = await discoverMcp(target('/external-schema'), options())
    assert.equal(catalog.tools[0].inputSchema.properties.message.$ref, 'https://127.0.0.1:1/forbidden-schema')
    assert(seen.every(item => ['GET', 'DELETE'].includes(item.method)
      || ['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'].includes(item.rpc)))
  })
  await t.test('ambient proxy variables cannot redirect native controlled sockets', async () => {
    const module = new URL('../lib/platform/mcp-transport.js', import.meta.url).href
    const source = `import { discoverMcp } from ${JSON.stringify(module)};
      const result = await discoverMcp(${JSON.stringify(target('/proxy-proof'))}, {
        signal: new AbortController().signal, budgets: ${JSON.stringify(budgets)},
        networkPolicy: { internalExceptions: ${JSON.stringify([{ origin, addresses: ['127.0.0.1'], ca }])},
          resolve: async () => [{ address: '127.0.0.1', family: 4 }] }});
      console.log(result.tools.length);`
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
        ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '', NODE_USE_ENV_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    ownedChildren.add(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const [code] = await once(child, 'close')
    ownedChildren.delete(child)
    assert.equal(code, 0, stderr)
    assert.equal(stdout.trim(), '2')
  })
})
