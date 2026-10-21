/** Own loopback servers exercise actual Node socket cleanup; all owner hooks and credentials are fixtures. */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { test, vi } from 'vitest'
import { ExposurePolicy } from '@deepseek-ai/dsh-pe-cloud-api/src/exposure.ts'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ApplicationReadLimits, ApplicationReadRequest, RegisteredApplicationService } from '@deepseek-ai/dsh-pe-opensandbox/types'
import { forwardInertPreview, type InertPreviewReply } from '../src/preview-response.ts'
import { createSelectedServerHttp, type PreviewHttpOwner } from '@deepseek-ai/dsh-pe-opensandbox/src/application-http.ts'

const responseLimits: ApplicationReadLimits = { maxBodyBytes: 64, maxChunkBytes: 16, maxChunks: 64,
  maxHeaderCount: 16, maxHeaderBytes: 512 }
const applicationRequest: ApplicationReadRequest = { method: 'GET', resourcePath: '/', headers: [['accept', 'application/json']] }
async function serverFixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler), sockets = new Set<Socket>(), closed: Promise<void>[] = []
  server.on('connection', (socket) => {
    sockets.add(socket); const terminal = Promise.withResolvers<undefined>(); closed.push(terminal.promise)
    socket.once('close', () => { sockets.delete(socket); terminal.resolve(undefined) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', reject); resolve() })
  })
  const address = server.address(); assert.ok(address !== null && typeof address === 'object')
  return { url: `http://127.0.0.1:${address.port}/v1`,
    async assertIdle() {
      // Independent peer observation precedes teardown, so fixture cleanup cannot hide an adapter socket leak.
      await vi.waitFor(() => { assert.equal(sockets.size, 0) }, { timeout: 1000, interval: 5 })
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
      await Promise.all(closed); assert.equal(sockets.size, 0)
    } }
}
function provider(url: string, timeoutMs: number, allowCapacity: boolean, maxWireBytes: number) {
  const residentDeadlineAtMs = performance.now() + 300000
  const state = { adoptions: 0, settled: false, unknown: false, controller: undefined as AbortController | undefined,
    terminal: Promise.resolve(), charge: undefined as Parameters<PreviewHttpOwner['retainRequest']>[0]['charge'] | undefined,
    leaseCurrent: true, targetCurrent: true, blockNextCheckMs: 0 }
  const owner: PreviewHttpOwner = { retainRequest(input) {
    state.adoptions++
    if (!allowCapacity) throw new Error('fixture-original-capacity-denied')
    state.controller = input.controller; state.charge = input.charge
    state.terminal = input.settled.then(() => { state.settled = true }, (_error: unknown) => { state.unknown = true })
    return { timeoutMs, assertCurrent() { assert.ok(state.leaseCurrent && state.targetCurrent) } }
  } }
  const adapter = createSelectedServerHttp({ lifecycleBaseUrl: url, apiKey: 'fixture-control-key',
    limits: { readBufferBytes: 32, prefetchBytes: 64, maxWireBytes,
      maxRequestHeaderBytes: 1024, maxPathBytes: 2048, timeoutMs, maxBufferPoolBytes: 8192 },
    assertCurrent() {
      if (state.blockNextCheckMs > 0) {
        const milliseconds = state.blockNextCheckMs; state.blockNextCheckMs = 0
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
      }
      assert.ok(state.leaseCurrent)
    } }, {
    sandboxId: 'fixture-sandbox', port: 8000, deadlineAtMs: residentDeadlineAtMs, assertCurrent() { assert.ok(state.targetCurrent) },
  }, owner)
  return { adapter, state }
}
async function inertRun(adapter: ReturnType<typeof provider>['adapter'], signal: AbortSignal): Promise<InertPreviewReply> {
  const binding: AccountBinding = { accountId: 'A' as AccountBinding['accountId'], epoch: '17' as AccountBinding['epoch'],
    recipeVersion: 'fixture', lifetime: signal }
  const exposure = new ExposurePolicy({ recipeVersion: 'fixture', rpcEndpoints: [], streamEndpoints: [], allowedSettings: [],
    exactFetchRoutes: [{ method: 'GET', path: '/cloud/service-preview', handlerId: 'fixture:preview', guard: 'account-session' }] })
  exposure.audit(exposure.manifest)
  const scope: RegisteredApplicationService['scope'] = { accountId: binding.accountId, epoch: binding.epoch,
    sessionId: 'session' as RegisteredApplicationService['scope']['sessionId'],
    allocationId: 'allocation' as RegisteredApplicationService['scope']['allocationId'],
    serviceId: 'service' as RegisteredApplicationService['scope']['serviceId'] }
  let delivered: InertPreviewReply | undefined
  await forwardInertPreview({ origin: 'https://preview.example.invalid', method: 'GET', pathname: '/cloud/service-preview',
    scope, resourcePath: '/', headers: [['Accept', 'application/json'], ['Cookie', 'fixture-platform-cookie'],
      ['Authorization', 'fixture-platform-auth'], ['X-EXECD-ACCESS-TOKEN', 'fixture-execd']] }, {
    signal, assertCurrent() { signal.throwIfAborted() }, use: { binding, assertCurrent() { signal.throwIfAborted() } },
    api: { binding, requireFetch: (method, path) => exposure.requireFetch(method, path) },
  }, { manifest: exposure.manifest, routePath: '/cloud/service-preview', handlerId: 'fixture:preview',
    managementOrigin: 'https://console.example.invalid', previewOrigin: 'https://preview.example.invalid', allowedServicePorts: [8000],
    maxFieldBytes: 128, maxResourceBytes: 2048, maxHeaderCount: 16, maxHeaderBytes: 1024 }, {
    ...responseLimits, mode: 'inert-text-v1',
  }, { async withRegisteredService(_binding, _selector, manifest, _signal, consume) {
    await consume({ ...adapter, scope, port: 8000, lifetime: signal, manifest, assertCurrent() { signal.throwIfAborted() } })
  } }, { async send(reply, _signal, current) { current(); delivered = reply }, async close() {} })
  assert.ok(delivered); return delivered
}

test('real proxy-path GET uses only control API key and sanitized headers, then original inert helper closes it', async () => {
  let calls = 0
  const server = await serverFixture((req, res) => {
    calls++; assert.equal(req.url, '/v1/sandboxes/fixture-sandbox/proxy/8000/')
    assert.equal(req.headers['open-sandbox-api-key'], 'fixture-control-key')
    assert.equal(req.headers['opensandbox-access-renew'], 'skip')
    for (const key of ['cookie', 'authorization', 'x-execd-access-token', 'x-agent-token']) assert.equal(req.headers[key], undefined)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fixture=1', 'Access-Control-Allow-Origin': '*' })
    res.end('{"message":"Hello World"}')
  })
  try {
    const p = provider(server.url, 1000, true, 16384), reply = await inertRun(p.adapter, new AbortController().signal)
    await p.state.terminal
    assert.equal(calls, 1); assert.ok(p.state.settled && !p.state.unknown)
    assert.equal(Buffer.from(reply.body).toString(), '{"message":"Hello World"}')
    assert.equal(reply.headers['set-cookie'], undefined); assert.equal(reply.headers['access-control-allow-origin'], undefined)
    assert.ok(p.state.charge !== undefined && p.state.charge.retainedPayloadBytes > 0)
    assert.deepEqual(Object.keys(p.adapter), ['withResponse'])
    await server.assertIdle()
  } finally { await server.close() }
})
test('real chunked oversized body is refused by the existing collector and actual connection settles', async () => {
  const server = await serverFixture((_req, res) => { res.writeHead(200); res.write(Buffer.alloc(4096, 97)); res.end() })
  try {
    const p = provider(server.url, 1000, true, 16384)
    await assert.rejects(inertRun(p.adapter, new AbortController().signal))
    await p.state.terminal; assert.ok(p.state.settled && !p.state.unknown)
    await server.assertIdle()
  } finally { await server.close() }
})
test('real parser header overflow closes request/response/socket before original owner terminal resolves', async () => {
  for (const headers of [{ 'X-Long': 'a'.repeat(2048) }, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`X-${i}`, 'x']))]) {
    const server = await serverFixture((_req, res) => { res.writeHead(200, headers); res.end('x') })
    try {
      const p = provider(server.url, 1000, true, 16384)
      await assert.rejects(inertRun(p.adapter, new AbortController().signal)); await p.state.terminal
      assert.ok(p.state.settled && !p.state.unknown)
      await server.assertIdle()
    } finally { await server.close() }
  }
})
test('fixed native read buffer enforces wire cap even before a complete response header arrives', async () => {
  const server = await serverFixture((_req, res) => { res.end('x') })
  try {
    const p = provider(server.url, 1000, true, 64)
    let consumed = false
    await assert.rejects(p.adapter.withResponse(applicationRequest, responseLimits, new AbortController().signal,
      async () => { consumed = true }))
    await p.state.terminal; assert.equal(consumed, false); assert.ok(p.state.settled)
    await server.assertIdle()
  } finally { await server.close() }
})
test('owner-installed absolute HTTP deadline cancels a real request waiting for headers and joins close', async () => {
  const server = await serverFixture((_req, _res) => {})
  try {
    const p = provider(server.url, 100, true, 16384)
    const running = p.adapter.withResponse(applicationRequest, responseLimits, new AbortController().signal, async () => {})
    const rejection = assert.rejects(running)
    assert.equal(p.state.settled, false); assert.ok(p.state.controller)
    await rejection; await p.state.terminal; assert.ok(p.state.controller.signal.aborted && p.state.settled)
    await server.assertIdle()
  } finally { await server.close() }
})
test('real pending read cancellation is idempotent and joins socket plus read settlement', async () => {
  const server = await serverFixture((_req, res) => { res.writeHead(200); res.flushHeaders() })
  try {
    const p = provider(server.url, 1000, true, 16384), reason = new Error('fixture-read-cancel')
    await assert.rejects(p.adapter.withResponse(applicationRequest, responseLimits, new AbortController().signal, async (response) => {
      const reading = response.read(1), observed = reading.then(() => 'fulfilled', (_error: unknown) => 'rejected')
      const one = response.close(reason), two = response.close(reason)
      assert.equal(one, two)
      await Promise.all([one, two]); assert.equal(await observed, 'rejected')
    }), error => error === reason)
    await p.state.terminal; assert.ok(p.state.settled)
    await server.assertIdle()
  } finally { await server.close() }
})
test('external abort before late server headers prevents consumption and joins the actual connection', async () => {
  const entered = Promise.withResolvers<ServerResponse>()
  const server = await serverFixture((_req, res) => { entered.resolve(res) })
  try {
    const p = provider(server.url, 1000, true, 16384), signal = new AbortController(), reason = new Error('fixture-before-late-headers')
    let consumed = false
    const running = p.adapter.withResponse(applicationRequest, responseLimits, signal.signal, async () => { consumed = true })
    const rejection = assert.rejects(running, error => error === reason)
    const response = await Promise.race([entered.promise, running.then(() => { throw new Error('fixture-headers-not-observed') },
      (error: unknown) => { throw error })])
    signal.abort(reason); response.end('late body')
    await rejection; await p.state.terminal
    assert.equal(consumed, false); assert.ok(p.state.settled)
    await server.assertIdle()
  } finally { await server.close() }
})
test('consumer stop-unconfirmed remains with original owner even when local socket close is known', async () => {
  const server = await serverFixture((_req, res) => { res.end('x') })
  try {
    const p = provider(server.url, 1000, true, 16384)
    const failure = Object.assign(new Error('fixture-original-consumer-close-unknown'), { code: 'cloud/stop-unconfirmed' })
    await assert.rejects(p.adapter.withResponse(applicationRequest, responseLimits, new AbortController().signal, async (response) => {
      await response.close(); throw failure
    }), error => error === failure)
    await p.state.terminal; assert.ok(p.state.unknown && !p.state.settled)
    await server.assertIdle()
  } finally { await server.close() }
})
test('owner capacity, unsupported HEAD and unsanitized headers have zero upstream calls', async () => {
  let calls = 0
  const server = await serverFixture((_req, res) => { calls++; res.end('unexpected') })
  try {
    const denied = provider(server.url, 1000, false, 16384)
    await assert.rejects(denied.adapter.withResponse(applicationRequest, responseLimits, new AbortController().signal, async () => {}))
    const p = provider(server.url, 1000, true, 16384)
    const refused: ApplicationReadRequest[] = [{ ...applicationRequest, method: 'HEAD' },
      { ...applicationRequest, headers: [['cookie', 'fixture-cookie']] }, { ...applicationRequest, resourcePath: '//other.invalid/' }]
    for (const request of refused) {
      await assert.rejects(p.adapter.withResponse(request, responseLimits, new AbortController().signal, async () => {}))
    }
    assert.equal(calls, 0); assert.equal(p.state.adoptions, 0)
    await server.assertIdle()
  } finally { await server.close() }
})
test('deadline elapsed inside a synchronous lease check prevents even the first socket request', async () => {
  let calls = 0
  const server = await serverFixture((_req, res) => { calls++; res.end('unexpected') })
  try {
    const p = provider(server.url, 20, true, 16384); p.state.blockNextCheckMs = 40
    await assert.rejects(p.adapter.withResponse(applicationRequest, responseLimits, new AbortController().signal, async () => {}))
    await p.state.terminal; assert.equal(calls, 0); assert.ok(p.state.settled)
    await server.assertIdle()
  } finally { await server.close() }
})
