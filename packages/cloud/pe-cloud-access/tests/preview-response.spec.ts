/** Response tests model original transport and ingress settlement without opening services or sockets. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { ExposurePolicy } from '@deepseek-ai/dsh-pe-cloud-api/src/exposure.ts'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExistingPreviewAdmission, PreviewPolicy, SanitizedPreviewRequest } from '../src/preview-access.ts'
import { forwardInertPreview, type InertPreviewReply, type OriginalIngressSink, type OwnedPreviewResponse,
  PreviewResponseError, type ResponseExecutionPreviewPort, type ResponseLimits, type ResponsePreviewService } from '../src/preview-response.ts'

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const requestLife = new AbortController(), accountLife = new AbortController(), serviceLife = new AbortController()
  const binding: AccountBinding = { accountId: 'A' as AccountBinding['accountId'],
    epoch: '17' as AccountBinding['epoch'], recipeVersion: 'fixture', lifetime: accountLife.signal }
  const exposure = new ExposurePolicy({ recipeVersion: 'fixture', rpcEndpoints: [], streamEndpoints: [], allowedSettings: [],
    exactFetchRoutes: ['GET', 'HEAD'].map(method => ({ method, path: '/cloud/service-preview', handlerId: 'candidate:servicePreview', guard: 'account-session' })) })
  exposure.audit(exposure.manifest)
  const policy: PreviewPolicy = { manifest: exposure.manifest, routePath: '/cloud/service-preview', handlerId: 'candidate:servicePreview',
    previewOrigin: 'https://preview.example.invalid', managementOrigin: 'https://console.example.invalid', allowedServicePorts: [8000],
    maxFieldBytes: 128, maxResourceBytes: 2048, maxHeaderCount: 32, maxHeaderBytes: 4096 }
  const limits: ResponseLimits = { mode: 'inert-text-v1', maxBodyBytes: 64, maxChunkBytes: 16, maxChunks: 32,
    maxHeaderCount: 32, maxHeaderBytes: 4096 }
  const scope: ResponsePreviewService['scope'] = { accountId: binding.accountId, epoch: binding.epoch,
    sessionId: 'native-session' as ResponsePreviewService['scope']['sessionId'],
    allocationId: 'allocation' as ResponsePreviewService['scope']['allocationId'],
    serviceId: 'service' as ResponsePreviewService['scope']['serviceId'] }
  const input = { origin: policy.previewOrigin, method: 'GET', pathname: policy.routePath, scope, resourcePath: '/',
    headers: [['Accept', 'application/json'], ['Cookie', 'fixture-cookie'], ['Authorization', 'fixture-authorization'],
      ['OPEN-SANDBOX-API-KEY', 'fixture-key'], ['X-EXECD-ACCESS-TOKEN', 'fixture-execd'], ['X-Agent-Token', 'fixture-agent']] }
  let closeReason: unknown
  const state = { status: 200, headers: [['Content-Type', 'application/json']] as string[][],
    body: Buffer.from('{"message":"Hello World"}'), offset: 0, opens: 0, commits: 0, sends: 0, reads: [] as number[],
    closeCalls: 0, sinkCloseCalls: 0, upstreamClosed: false, sinkClosed: false,
    sourceUnknown: false, ingressUnknown: false, serviceBorrow: false, accountUseHeld: true, current: true,
    closeFailure: undefined as Error | undefined, sinkCloseFailure: undefined as Error | undefined,
    get closeReason() { return closeReason }, captured: undefined as SanitizedPreviewRequest | undefined,
    reply: undefined as InertPreviewReply | undefined,
    beforeHeaders: async () => {}, beforeClose: async () => {}, beforeCommit: async () => {},
    beforeSendSettles: async () => {}, beforeSinkClose: async () => {},
    customRead: undefined as undefined | ((maximum: number) => Promise<Uint8Array | null>) }
  const current = (): void => { if (!state.current) throw new Error('fixture-stale-original-admission') }
  const admission: ExistingPreviewAdmission = { signal: requestLife.signal, assertCurrent: current,
    use: { binding, assertCurrent: current }, api: { binding, requireFetch: (method, path) => exposure.requireFetch(method, path) } }
  const response: OwnedPreviewResponse = { get status() { return state.status },
    get headers() { return state.headers as Array<[string, string]> },
    async read(maximum) {
      state.reads.push(maximum)
      if (state.customRead) return state.customRead(maximum)
      if (state.offset === state.body.length) return null
      const next = state.body.subarray(state.offset, state.offset + maximum); state.offset += next.byteLength; return next
    },
    async close(reason) {
      state.closeCalls++; closeReason = reason; await state.beforeClose()
      if (state.closeFailure) { state.sourceUnknown = true; throw state.closeFailure }
      state.upstreamClosed = true
    } }
  const service: ResponsePreviewService = { scope, manifest: exposure.manifest,
    port: 8000, lifetime: serviceLife.signal, assertCurrent: current,
    async withResponse(request, actualLimits, _signal, consume) {
      state.opens++; state.captured = request; assert.equal(actualLimits, limits)
      await state.beforeHeaders(); await consume(response)
    } }
  const execution: ResponseExecutionPreviewPort = { async withRegisteredService(actualBinding, _selector, manifest, _signal, consume) {
    assert.equal(actualBinding, binding); assert.equal(manifest, exposure.manifest); state.serviceBorrow = true
    try { await consume(service) }
    finally { if (!state.sourceUnknown && !state.ingressUnknown) state.serviceBorrow = false }
  } }
  const sink: OriginalIngressSink = {
    async send(reply, signal, assertCurrent) {
      state.sends++; await state.beforeCommit(); signal.throwIfAborted(); assertCurrent()
      state.commits++; state.reply = reply; await state.beforeSendSettles()
    },
    async close() {
      state.sinkCloseCalls++; await state.beforeSinkClose()
      if (state.sinkCloseFailure) { state.ingressUnknown = true; throw state.sinkCloseFailure }
      state.sinkClosed = true
    },
  }
  const run = async (value: unknown = input): Promise<void> => {
    try { await forwardInertPreview(value, admission, policy, limits, execution, sink) }
    finally { if (!state.sourceUnknown && !state.ingressUnknown) state.accountUseHeld = false }
  }
  return { state, input, limits, policy, exposure, requestLife, accountLife, serviceLife, run }
}
function code(value: PreviewResponseError['code']) {
  return (error: unknown): boolean => error instanceof PreviewResponseError && error.code === value
}

test('Hello JSON is bounded inert text; request credentials and every upstream browser-control header disappear', async () => {
  const f = fixture(); f.state.headers.push(['Set-Cookie', 'fixture=1; Domain=example.invalid'], ['Set-Cookie', 'fixture2=2'],
    ['Location', 'https://console.example.invalid/'], ['Refresh', '0;url=https://console.example.invalid/'],
    ['Access-Control-Allow-Origin', '*'], ['Access-Control-Allow-Credentials', 'true'], ['Cache-Control', 'public,max-age=999'],
    ['ETag', 'fixture-etag'], ['Clear-Site-Data', '"cookies"'], ['Service-Worker-Allowed', '/'], ['X-Internal-Key', 'fixture-secret'])
  await f.run(); assert.equal(f.state.commits, 1); assert.equal(f.state.closeCalls, 1); assert.ok(f.state.upstreamClosed)
  assert.deepEqual(f.state.captured?.headers, [['accept', 'application/json']])
  assert.equal(Buffer.from(f.state.reply!.body).toString(), '{"message":"Hello World"}')
  const headers = f.state.reply!.headers
  assert.equal(headers['content-type'], 'text/plain; charset=utf-8'); assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['cache-control'], 'no-store, max-age=0'); assert.equal(headers['referrer-policy'], 'no-referrer')
  assert.match(headers['content-security-policy']!, /sandbox; default-src 'none'/)
  for (const name of ['set-cookie', 'location', 'refresh', 'access-control-allow-origin', 'access-control-allow-credentials',
    'etag', 'clear-site-data', 'service-worker-allowed', 'x-internal-key']) assert.equal(headers[name], undefined)
})
test('HTML/SVG are literal text, never upstream MIME or an active app document', async () => {
  const f = fixture(); f.state.body = Buffer.from('<svg onload="alert(1)"></svg>'); f.state.headers = [['Content-Type', 'image/svg+xml']]
  await f.run(); assert.equal(f.state.reply!.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(Buffer.from(f.state.reply!.body).toString(), f.state.body.toString())
  assert.equal(f.state.reply!.headers['x-frame-options'], 'DENY')
})
test('old account/epoch/Session/allocation/service selection is rejected before upstream response acquisition', async () => {
  for (const key of ['accountId', 'epoch', 'sessionId', 'allocationId', 'serviceId']) {
    const f = fixture(); await assert.rejects(f.run({ ...f.input, scope: { ...f.input.scope, [key]: 'old' } }))
    assert.equal(f.state.opens, 0); assert.equal(f.state.commits, 0)
  }
})
test('redirect/upgrade/partial/error statuses close without reads, follow-up requests or browser bytes', async () => {
  for (const status of [302, 307, 101, 206, 500]) {
    const f = fixture(); f.state.status = status
    await assert.rejects(f.run(), code('cloud/forbidden')); assert.equal(f.state.opens, 1)
    assert.equal(f.state.reads.length, 0); assert.equal(f.state.closeCalls, 1); assert.equal(f.state.commits, 0)
  }
})
test('unknown-length body reads at most cap+1 before refusal, and keeps borrow until actual close', async () => {
  const f = fixture(); f.state.body = Buffer.alloc(65, 97); const closing = Promise.withResolvers<undefined>()
  f.state.beforeClose = () => closing.promise
  const running = f.run(); await turn()
  assert.equal(f.state.offset, 65); assert.ok(f.state.reads.every(n => n <= 16))
  assert.equal(f.state.commits, 0); assert.equal(f.state.serviceBorrow, true); assert.equal(f.state.accountUseHeld, true)
  closing.resolve(undefined); await assert.rejects(running, code('cloud/capacity'))
  assert.equal(f.state.serviceBorrow, false); assert.equal(f.state.accountUseHeld, false)
})
test('even valid EOF cannot publish until source close actually settles', async () => {
  const f = fixture(), closed = Promise.withResolvers<undefined>(); f.state.beforeClose = () => closed.promise
  const running = f.run(); await turn(); assert.equal(f.state.commits, 0); assert.equal(f.state.serviceBorrow, true)
  closed.resolve(undefined); await running; assert.equal(f.state.commits, 1)
})
test('abort of pending read initiates close once but waits for both actual read and close', async () => {
  const f = fixture(), read = Promise.withResolvers<Uint8Array | null>()
  const closed = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  f.state.customRead = () => { entered.resolve(undefined); return read.promise }; f.state.beforeClose = () => closed.promise
  const running = f.run(); await entered.promise
  const reason = new Error('fixture-request-abort'); f.requestLife.abort(reason); await turn()
  assert.equal(f.state.closeCalls, 1); assert.equal(f.state.closeReason, reason); assert.equal(f.state.serviceBorrow, true)
  closed.resolve(undefined); await turn(); assert.equal(f.state.accountUseHeld, true)
  read.resolve(null); await assert.rejects(running, error => error === reason)
  assert.equal(f.state.commits, 0); assert.equal(f.state.closeCalls, 1)
})
test('late headers after abort still acquire no browser bytes and close the actual late response', async () => {
  const f = fixture(), headers = Promise.withResolvers<undefined>(); f.state.beforeHeaders = () => headers.promise
  const running = f.run(); await turn(); const reason = new Error('fixture-late-acquisition-abort'); f.requestLife.abort(reason)
  assert.equal(f.state.accountUseHeld, true); headers.resolve(undefined); await assert.rejects(running, error => error === reason)
  assert.equal(f.state.closeCalls, 1); assert.equal(f.state.commits, 0)
})
test('source close rejection is stop-unconfirmed and leaves ORIGINAL execution/account responsibility retained', async () => {
  const f = fixture(); f.state.closeFailure = new Error('fixture-unknown-response-close')
  await assert.rejects(f.run(), code('cloud/stop-unconfirmed'))
  assert.equal(f.state.sourceUnknown, true); assert.equal(f.state.serviceBorrow, true)
  assert.equal(f.state.accountUseHeld, true); assert.equal(f.state.commits, 0)
})
test('compressed, ambiguous framing, truncated length and oversized headers refuse before publication', async () => {
  for (const headers of [[['Content-Encoding', 'gzip']], [['Content-Length', '3'], ['Content-Length', '3']],
    [['Transfer-Encoding', 'chunked'], ['Content-Length', '24']], [['Content-Length', '60']],
    [['Content-Length', '65']], [['X-Long', 'a'.repeat(4097)]], [['X-Injection', 'a\r\nSet-Cookie: fixture=1']]]) {
    const f = fixture(); f.state.headers = headers
    await assert.rejects(f.run()); assert.equal(f.state.closeCalls, 1); assert.equal(f.state.commits, 0)
  }
  const chunked = fixture(); chunked.state.headers = [['Transfer-Encoding', 'chunked']]; await chunked.run()
  assert.equal(chunked.state.reply!.headers['transfer-encoding'], undefined)
})
test('empty/oversized producer chunks and finite pull count cannot make an unbounded body loop', async () => {
  const empty = fixture(); empty.state.customRead = async () => new Uint8Array(); await assert.rejects(empty.run(), code('cloud/capacity'))
  const oversized = fixture(); oversized.state.customRead = async n => new Uint8Array(n + 1)
  await assert.rejects(oversized.run(), code('cloud/capacity'))
  const pulls = fixture(); pulls.state.customRead = async () => new Uint8Array([97])
  await assert.rejects(pulls.run(), code('cloud/capacity')); assert.equal(pulls.state.reads.length, 32)
})
test('original admission revocation during read or immediately before sink commit prevents browser bytes', async () => {
  const duringRead = fixture(); duringRead.state.customRead = async () => { duringRead.state.current = false; return new Uint8Array([97]) }
  await assert.rejects(duringRead.run()); assert.equal(duringRead.state.commits, 0)
  const beforeCommit = fixture(); beforeCommit.state.beforeCommit = async () => { beforeCommit.state.current = false }
  await assert.rejects(beforeCommit.run()); assert.equal(beforeCommit.state.commits, 0); assert.equal(beforeCommit.state.sinkCloseCalls, 1)
})
test('downstream abort retains service/AccountUse until actual send AND sink close complete', async () => {
  const f = fixture(), writing = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  f.state.beforeSendSettles = () => { entered.resolve(undefined); return writing.promise }; f.state.beforeSinkClose = () => closed.promise
  const running = f.run(); await entered.promise; const reason = new Error('fixture-browser-disconnect'); f.requestLife.abort(reason)
  await turn(); assert.equal(f.state.sinkCloseCalls, 1); assert.equal(f.state.serviceBorrow, true)
  writing.resolve(undefined); await turn(); assert.equal(f.state.accountUseHeld, true)
  closed.resolve(undefined); await assert.rejects(running, error => error === reason)
  assert.equal(f.state.sinkClosed, true); assert.equal(f.state.accountUseHeld, false)
})
test('sink close uncertainty retains original ingress and execution unknown responsibility', async () => {
  const f = fixture(); f.state.beforeSendSettles = async () => { throw new Error('fixture-write-failed') }
  f.state.sinkCloseFailure = new Error('fixture-sink-close-unknown')
  await assert.rejects(f.run(), code('cloud/stop-unconfirmed'))
  assert.equal(f.state.ingressUnknown, true); assert.equal(f.state.serviceBorrow, true); assert.equal(f.state.accountUseHeld, true)
})
test('HEAD validates EOF, publishes no body, and preserves only bounded representation length', async () => {
  const f = fixture(); f.input.method = 'HEAD'; f.state.body = Buffer.alloc(0); f.state.headers.push(['Content-Length', '25'])
  await f.run(); assert.deepEqual(f.state.reads, [1]); assert.equal(f.state.reply!.body.byteLength, 0)
  assert.equal(f.state.reply!.headers['content-length'], '25')
})
