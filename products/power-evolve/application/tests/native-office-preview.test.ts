/** Real native HTTP/SDK multipart framing; Platform jobs and Kubernetes are substitutes, not acceptance evidence. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import { OFFICE_PREVIEW_ROUTES as routes, OFFICE_PREVIEW_MAX_OUTPUT_BYTES } from '@power-evolve/contracts/office-preview'
import { artifactDocumentPathFor } from '@power-evolve/contracts/artifact-document'
import { createWebConnectionRpc } from '../../../../packages/client/connection/src/client/rpc.ts'
import { NativeOfficePreview, NativeOfficePreviewError, type NativeOfficePreviewCall,
  type NativeOfficePreviewOptions } from '../src/host/native-office-preview.ts'
import { installNativeRemote } from '../src/host/native-remote.ts'
import { BrowserAgentAuth } from '../src/host/browser-auth.ts'
import RuntimeScope from '../src/host/scope.ts'
import { PlatformError } from '../src/contracts.ts'

const generation = 'a'.repeat(64)
const version = 'b'.repeat(64)
const jobId = randomUUID()
const args = { workspaceFileScopeId: randomUUID(), path: '/workspace/report.docx', priority: 'foreground' }
const options: NativeOfficePreviewOptions = { pollMs: 5, renderDeadlineMs: 200, cancelTimeoutMs: 30, maxActiveRenders: 1 }
const pdf = Buffer.from('%PDF-1.7\nfixture\u0000\u00ff\n%%EOF')
const source = { absolutePath: args.path, version, bytes: 100 }
const job = (state = 'succeeded', errorCode: string | null = null) => ({ jobId, generation, state, errorCode })
const content = () => ({ ...source, bytes: pdf.length, offset: 0, eof: true, data: pdf.toString('base64'),
  missingFonts: ['Fixture missing font'], generation, pdfSha256: createHash('sha256').update(pdf).digest('hex') })
type RecordedCall = { path: string; input: unknown; signal: AbortSignal }

function platform(override?: NativeOfficePreviewCall) {
  const calls: RecordedCall[] = []
  const call: NativeOfficePreviewCall = async (path, token, input, signal) => {
    assert.equal(token, 'fixture-token')
    calls.push({ path, input, signal })
    signal.throwIfAborted()
    if (override !== undefined) {
      const result = await override(path, token, input, signal)
      if (result !== undefined) return result
    }
    if (path === routes.generation) return { generation }
    if (path === '/native/files/stat') return source
    if (path === routes.prepare || path === routes.status) return job()
    if (path === routes.content) return content()
    if (path === routes.cancel) return job('cancelled')
    throw new Error('Unexpected fixture endpoint')
  }
  return { call, calls }
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof NativeOfficePreviewError && error.code === code
}

test('generation is a bare validated string and only Office requires a UUIDv4 RPC identity', async () => {
  const p = platform()
  const preview = new NativeOfficePreview(p.call, options)
  const signal = new AbortController().signal
  assert.equal(await preview.generation('fixture-token', randomUUID(), {}, signal), generation)
  await assert.rejects(preview.generation('fixture-token', 'rpc:1', {}, signal), z.ZodError)
  await assert.rejects(preview.render('fixture-token', randomUUID(), { ...args, path: '/private/x.docx' }, signal), z.ZodError)
  assert.equal(p.calls.length, 1)
})

for (const raw of [{}, { generation: 'invalid' }, { generation, extra: true }]) {
  test(`invalid generation ${JSON.stringify(raw)} refuses admission`, async () => {
    const p = platform(async path => path === routes.generation ? raw : undefined)
    await assert.rejects(new NativeOfficePreview(p.call, options).render('fixture-token', randomUUID(), args,
      new AbortController().signal), errorCode('invalid-output'))
    assert.equal(p.calls.some(call => call.path === routes.prepare), false)
  })
}

test('prepare and polling keep the original request, job and generation identities', async () => {
  let statuses = 0
  const p = platform(async path => path === routes.prepare ? job('queued')
    : path === routes.status && statuses++ === 0 ? job('running') : undefined)
  const rpcId = randomUUID()
  const rendered = await new NativeOfficePreview(p.call, options).render('fixture-token', rpcId, args,
    new AbortController().signal)
  assert.deepEqual(rendered.data, new Uint8Array(pdf))
  assert.equal('pdfSha256' in rendered, false)
  assert.deepEqual(p.calls.find(call => call.path === routes.prepare)?.input,
    { requestId: rpcId, sessionId: args.workspaceFileScopeId, path: 'report.docx', priority: 'foreground', generation })
  assert.deepEqual(p.calls.filter(call => call.path === routes.status).map(call => call.input),
    [{ jobId, generation }, { jobId, generation }])
  assert.equal(p.calls.some(call => call.path === routes.cancel), false)
})

test('artifact rendering fixes the canonical publication and stat digest without a Workspace source request', async () => {
  const artifactId = randomUUID(), filename = '报告.docx'
  const path = artifactDocumentPathFor(artifactId, filename)
  const artifactSource = { ...source, absolutePath: path }
  const p = platform(async route => route === '/native/files/stat' ? artifactSource
    : route === routes.content ? { ...content(), absolutePath: path } : undefined)
  const rpcId = randomUUID()
  const rendered = await new NativeOfficePreview(p.call, options).render('fixture-token', rpcId,
    { ...args, path }, new AbortController().signal)
  assert.equal(rendered.absolutePath, path)
  assert.deepEqual(rendered.data, new Uint8Array(pdf))
  assert.deepEqual(p.calls.find(call => call.path === '/native/files/stat')?.input,
    { sessionId: args.workspaceFileScopeId, path })
  assert.deepEqual(p.calls.find(call => call.path === routes.prepare)?.input,
    { requestId: rpcId, sessionId: args.workspaceFileScopeId,
      source: { kind: 'artifact', artifactId, filename, sha256: version }, priority: 'foreground', generation })
  assert.equal(p.calls.some(call => JSON.stringify(call.input).includes('/workspace/')), false)
})

test('lost prepare ACK cancels by the original key with an independent signal and never retries admission', async () => {
  let admitted!: () => void
  const accepted = new Promise<void>(resolve => { admitted = resolve })
  const p = platform(async (path, _token, _input, signal) => {
    if (path !== routes.prepare) return undefined
    admitted()
    await delay(1000, undefined, { signal })
  })
  const controller = new AbortController()
  const rpcId = randomUUID()
  const preview = new NativeOfficePreview(p.call, options)
  const task = preview.render('fixture-token', rpcId, args, controller.signal)
  await accepted
  controller.abort()
  await assert.rejects(task, errorCode('cancelled'))
  const cancel = p.calls.find(call => call.path === routes.cancel)!
  assert.deepEqual(cancel.input, { requestId: rpcId, generation })
  assert.equal(cancel.signal.aborted, false)
  assert.equal(p.calls.filter(call => call.path === routes.prepare).length, 1)
  await preview.close()
})

test('one deadline includes prepare and every poll; failed cancellation settles and releases capacity', { timeout: 3000 }, async t => {
  let waiting = true
  const p = platform(async (path, _token, _input, signal) => {
    if (waiting && path === routes.prepare) return job('running')
    if (waiting && path === routes.status) { await delay(8, undefined, { signal }); return job('running') }
    if (path === routes.cancel) await delay(1000, undefined, { signal })
  })
  const preview = new NativeOfficePreview(p.call, { ...options, renderDeadlineMs: 45, cancelTimeoutMs: 15 })
  t.after(() => preview.close())
  const start = performance.now()
  const task = preview.render('fixture-token', randomUUID(), args, new AbortController().signal)
  await assert.rejects(preview.render('fixture-token', randomUUID(), args, new AbortController().signal), errorCode('busy'))
  await assert.rejects(task, errorCode('timeout'))
  assert.ok(performance.now() - start < 1000)
  assert.ok(p.calls.filter(call => call.path === routes.status).length >= 1)
  assert.equal(p.calls.find(call => call.path === routes.cancel)?.signal.aborted, true)
  waiting = false
  assert.deepEqual((await preview.render('fixture-token', randomUUID(), args, new AbortController().signal)).data, new Uint8Array(pdf))
})

test('a transport failure after durable admission cancels without changing the original refusal', async () => {
  const p = platform(async path => { if (path === routes.prepare) throw new PlatformError(503, 'office_render_unavailable') })
  await assert.rejects(new NativeOfficePreview(p.call, options).render('fixture-token', randomUUID(), args,
    new AbortController().signal), errorCode('unavailable'))
  assert.equal(p.calls.filter(call => call.path === routes.cancel).length, 1)
})

for (const [label, endpoint, result, code] of [
  ['foreign generation in prepare', routes.prepare, { ...job(), generation: 'c'.repeat(64) }, 'invalid-output'],
  ['foreign job in status', routes.status, { ...job(), jobId: randomUUID() }, 'invalid-output'],
  ['foreign generation in content', routes.content, { ...content(), generation: 'c'.repeat(64) }, 'invalid-output'],
  ['different source version', routes.content, { ...content(), version: 'c'.repeat(64) }, 'source-changed'],
  ['different source path', routes.content, { ...content(), absolutePath: '/workspace/other.docx' }, 'source-changed'],
  ['incorrect PDF digest', routes.content, { ...content(), pdfSha256: 'c'.repeat(64) }, 'invalid-output'],
  ['incorrect PDF length', routes.content, { ...content(), bytes: pdf.length + 1 }, 'invalid-output'],
  ['noncanonical bytes', routes.content, { ...content(), data: 'Zh==' }, 'invalid-output'],
  ['oversized PDF declaration', routes.content, { ...content(), bytes: OFFICE_PREVIEW_MAX_OUTPUT_BYTES + 1 }, 'invalid-output'],
  ['unknown error reason', routes.prepare, job('failed', '/private/diagnostics'), 'invalid-output'],
] as const) {
  test(`${label} refuses native bytes and cancels only the admitted identity`, async () => {
    const p = platform(async path => path === endpoint ? result
      : endpoint === routes.status && path === routes.prepare ? job('running') : undefined)
    await assert.rejects(new NativeOfficePreview(p.call, options).render('fixture-token', randomUUID(), args,
      new AbortController().signal), errorCode(code))
    assert.equal(p.calls.filter(call => call.path === routes.cancel).length, 1)
  })
}

test('Host disposal waits for independent cancellation and rejects later work', async () => {
  let admitted!: () => void
  const accepted = new Promise<void>(resolve => { admitted = resolve })
  let cancelled = false
  const p = platform(async (path, _token, _input, signal) => {
    if (path === routes.prepare) { admitted(); await delay(1000, undefined, { signal }) }
    if (path === routes.cancel) { await delay(10, undefined, { signal }); cancelled = true }
  })
  const preview = new NativeOfficePreview(p.call, options)
  const task = preview.render('fixture-token', randomUUID(), args, new AbortController().signal)
  const rejection = assert.rejects(task, errorCode('cancelled'))
  await accepted
  await preview.close()
  assert.equal(cancelled, true)
  await rejection
  await assert.rejects(preview.render('fixture-token', randomUUID(), args, new AbortController().signal), errorCode('cancelled'))
})

async function httpFixture(t: TestContext, call: NativeOfficePreviewCall) {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  class FixtureRuntime extends RuntimeScope {
    override async [Service.init](): Promise<void> { /* No actual Platform credentials or infrastructure. */ }
    override async call(path: string, _token: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
      return call(path, 'fixture-token', input, signal ?? new AbortController().signal)
    }
  }
  await ctx.plugin(FixtureRuntime, { platformUrl: 'http://127.0.0.1', workerTokenFile: 'unused', timeoutMs: 15_000, maxResponseBytes: 12 * 1024 * 1024 })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const cookie = `pe_agent=${'a'.repeat(43)}`
  const auth = new BrowserAgentAuth(origin, 'https://platform.example.test', { call: async () => ({
    userId: randomUUID(), username: 'fixture', settings: { model: 'fixture', maxTokens: 512, revision: 1 },
  }) })
  await ctx.plugin({ inject: ['webServer', 'powerEvolveRuntime'],
    apply: (ctx: Context) => installNativeRemote(ctx, auth, origin, 50, 4096, 4, options) })
  const rpc = createWebConnectionRpc((input, init) => fetch(new URL(`/native/${String(input)}`, origin),
    { ...init, headers: { ...init.headers, origin, cookie } }))
  return { rpc, origin, cookie }
}

test('real native route returns bare generation and SDK-decoded multipart without the private digest', async t => {
  const p = platform()
  const { rpc } = await httpFixture(t, p.call)
  assert.deepEqual(await rpc.call('/api', 'officeToPdf/generation', { args: {} }), { ok: true, value: generation })
  const result = await rpc.call('/api', 'officeToPdf/render', { args })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('Fixture render refused')
  const value = z.object({ ...sourceSchemaForTest(), bytes: z.number(), offset: z.literal(0), eof: z.literal(true),
    data: z.instanceof(Uint8Array), missingFonts: z.array(z.string()), generation: z.string() }).strict().parse(result.value)
  assert.deepEqual(value.data, new Uint8Array(pdf))
  assert.equal(value.absolutePath, args.path)
  assert.equal(value.version, version)
  assert.equal(value.generation, generation)
})

function sourceSchemaForTest() { return { absolutePath: z.string(), version: z.string() } }

test('existing authorized readBytes still uses native multipart and non-Office RPC ids remain accepted', async t => {
  const p = platform(async path => path === '/native/files/readBytes'
    ? { ...source, offset: 0, eof: true, data: pdf.toString('base64') } : undefined)
  const { origin, cookie } = await httpFixture(t, p.call)
  const response = await fetch(`${origin}/native/api/workspaceFiles/readBytes`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify({
      type: 'client-request', rpcId: 'fixture-file-id', method: 'workspaceFiles/readBytes',
      payload: { args: { workspaceFileScopeId: args.workspaceFileScopeId, path: args.path, options: {} } },
    }) })
  assert.equal(response.status, 200)
  const body = await response.formData()
  const bytes = body.get('bytes-0')
  assert.ok(bytes instanceof Blob)
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), pdf)
  const metadata = body.get('metadata')
  assert.equal(typeof metadata, 'string')
  if (typeof metadata !== 'string') throw new Error('Fixture metadata absent')
  assert.equal(z.object({ rpcId: z.string() }).parse(JSON.parse(metadata)).rpcId, 'fixture-file-id')
})

test('real HTTP response close during admission cancels by RPC key and releases the next render slot', async t => {
  let admitted!: () => void
  const accepted = new Promise<void>(resolve => { admitted = resolve })
  let cancelled!: () => void
  const cancellation = new Promise<void>(resolve => { cancelled = resolve })
  let lose = true
  const p = platform(async (path, _token, _input, signal) => {
    if (path === routes.prepare && lose) { admitted(); await delay(1000, undefined, { signal }) }
    if (path === routes.cancel) { cancelled() }
  })
  const { origin, cookie, rpc } = await httpFixture(t, p.call)
  const rpcId = randomUUID()
  const req = request(`${origin}/native/api/officeToPdf/render`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie } })
  req.on('error', () => { /* Deliberate client disconnection. */ })
  req.end(JSON.stringify({ type: 'client-request', rpcId, method: 'officeToPdf/render', payload: { args } }))
  await accepted
  req.destroy()
  await cancellation
  assert.deepEqual(p.calls.find(call => call.path === routes.cancel)?.input, { requestId: rpcId, generation })
  lose = false
  assert.equal((await rpc.call('/api', 'officeToPdf/render', { args })).ok, true)
})

test('disconnect after admission cancels the verified job while cancellation refusal preserves an unknown stop result', async () => {
  let polling!: () => void
  const polled = new Promise<void>(resolve => { polling = resolve })
  const p = platform(async (path, _token, _input, signal) => {
    if (path === routes.prepare) return job('running')
    if (path === routes.status) { polling(); await delay(1000, undefined, { signal }) }
    if (path === routes.cancel) throw new PlatformError(503, 'office_render_unavailable')
  })
  const preview = new NativeOfficePreview(p.call, options)
  const controller = new AbortController()
  const task = preview.render('fixture-token', randomUUID(), args, controller.signal)
  await polled
  controller.abort()
  await assert.rejects(task, errorCode('cancelled'))
  assert.deepEqual(p.calls.find(call => call.path === routes.cancel)?.input, { jobId, generation })
  await preview.close()
})

test('native route keeps authorization refusal and maps only the ten Office failure reasons', async t => {
  let failure = new PlatformError(403, 'forbidden')
  const p = platform(async path => { if (path === routes.prepare) throw failure })
  const { rpc } = await httpFixture(t, p.call)
  const denied = await rpc.call('/api', 'officeToPdf/render', { args })
  assert.equal(denied.ok, false)
  if (denied.ok) throw new Error('Fixture denial not preserved')
  assert.equal(denied.error.code, 'gateway/forbidden')
  for (const reason of ['input-too-large', 'output-too-large', 'invalid-document', 'unsupported-format',
    'invalid-output', 'timeout', 'unavailable', 'failed', 'busy', 'source-changed']) {
    failure = new PlatformError(502, `office_render_${reason}`)
    const result = await rpc.call('/api', 'officeToPdf/render', { args })
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('Fixture failure not preserved')
    assert.equal(result.error.code, 'document-render/failed')
    assert.deepEqual(result.error.details, { reason })
  }
  failure = new PlatformError(499, 'office_render_cancelled')
  const cancelled = await rpc.call('/api', 'officeToPdf/render', { args })
  assert.equal(cancelled.ok, false)
  if (cancelled.ok) throw new Error('Fixture cancellation not preserved')
  assert.equal(cancelled.error.code, 'gateway/cancelled')
  failure = new PlatformError(502, 'office_render_unrecognized-diagnostic')
  const unknown = await rpc.call('/api', 'officeToPdf/render', { args })
  assert.equal(unknown.ok, false)
  if (unknown.ok) throw new Error('Fixture unknown failure not preserved')
  assert.deepEqual(unknown.error.details, { reason: 'failed' })
})
