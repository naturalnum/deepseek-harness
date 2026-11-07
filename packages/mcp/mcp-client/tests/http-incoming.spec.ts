/** Real HTTP byte admission before JSON/SSE materialization; default native transport behavior remains separate. */
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boundedHttpIncoming } from '../src/http-incoming.ts'
import { apply, Config, type McpClientLifecycle } from '../src/index.ts'
import { startHttpMcpFixture } from './http-fixture.ts'

it('bounds chunked success/error/SSE and decoded gzip bytes, cancels the real reader and preserves response metadata', async () => {
  const counters = { incomplete: 0 }
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/small' }).end(); return }
    if (request.url === '/small') { response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return }
    if (request.url === '/gzip') {
      const compressed = gzipSync(JSON.stringify({ value: 'x'.repeat(65536) }))
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': compressed.length })
        .end(compressed); return
    }
    response.writeHead(request.url === '/error' ? 503 : 200,
      { 'content-type': request.url === '/sse' ? 'text/event-stream' : 'application/json' })
    let sent = 0
    const timer = setInterval(() => {
      response.write(request.url === '/sse' ? ': ' + 'x'.repeat(252) + '\n\n' : 'x'.repeat(256))
      if (++sent === 64) { clearInterval(timer); response.end() }
    }, 1)
    response.on('close', () => { clearInterval(timer); if (sent < 64) counters.incomplete++ })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve); await listening.promise
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP byte fixture has no TCP address')
  const url = `http://127.0.0.1:${address.port}`
  const small = boundedHttpIncoming(1024), response = await small.fetch(url + '/redirect')
  expect(response.url).toBe(url + '/small'); expect(response.redirected).toBe(true); expect(response.type).toBe('basic')
  const clone = response.clone()
  expect(clone.url).toBe(response.url); expect(clone.redirected).toBe(true); expect(clone.type).toBe(response.type)
  expect(await response.json()).toEqual({ ok: true }); expect(await clone.json()).toEqual({ ok: true })
  expect(await small.close()).toBe(true)
  const exact = boundedHttpIncoming(11)
  expect(await (await exact.fetch(url + '/small')).json()).toEqual({ ok: true })
  expect(await exact.close()).toBe(true)
  const short = boundedHttpIncoming(10)
  await expect((await short.fetch(url + '/small')).text()).rejects.toThrow('incoming HTTP response exceeds')
  expect(await short.close()).toBe(true)
  for (const route of ['/large', '/error', '/sse', '/gzip']) {
    const bounded = boundedHttpIncoming(1024)
    const result = await bounded.fetch(url + route)
    await expect(result.text()).rejects.toThrow('incoming HTTP response exceeds')
    expect(await bounded.close()).toBe(true)
  }
  await vi.waitFor(() => { expect(counters.incomplete).toBe(3) })
})

it('bounds real SDK initialize and tools/list before publication, and a cumulative SSE tool response can recover', async () => {
  const external = await startHttpMcpFixture(), ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await external.close() })
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
  const config = Config({ transport: 'streamable-http', serverName: 'bounded', url: external.url,
    maxIncomingResponseBytes: 1024, listMaxPages: 4, failOnStartupError: true,
    reconnect: { enabled: false }, toolCallTimeoutMs: 2000 })
  for (const kind of ['instructions', 'description'] as const) {
    external.setInstructions(kind === 'instructions' ? 'x'.repeat(8192) : '')
    external.setToolDescription(kind === 'description' ? 'x'.repeat(8192) : 'Replies pong.')
    let lifecycle: McpClientLifecycle | undefined
    const scope = ctx.plugin({ inject: ['tools'], async apply(owner: Context) {
      try { await apply(owner, config, (value) => { lifecycle = value }) }
      catch (_error) { /* Inspect without poisoning the parent fixture. */ }
    } })
    await scope
    expect(ctx.tools.schemas()).toEqual([])
    expect(await lifecycle?.close()).toBe(true); await scope.dispose()
  }
  external.setInstructions(''); external.setToolDescription('Replies pong.')
  let lifecycle: McpClientLifecycle | undefined
  const active = ctx.plugin({ inject: ['tools'], apply: async (owner: Context) => apply(owner, config, (value) => { lifecycle = value }) })
  await active
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__bounded__ping'])
  external.setSsePadding(4096)
  const tooLarge = await ctx.tools.execute({ name: 'mcp__bounded__ping', arguments: {}, callId: ToolCallId('sse-over-limit'),
    signal: new AbortController().signal })
  expect(tooLarge.isError).toBe(true)
  external.setSsePadding(1)
  expect(await ctx.tools.execute({ name: 'mcp__bounded__ping', arguments: {}, callId: ToolCallId('sse-recovered'),
    signal: new AbortController().signal })).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'pong' }] } })
  expect(await lifecycle?.close()).toBe(true); await active.dispose()
})

it('uses the official SDK pagination cap without publishing a partial list and preserves omitted native pagination behavior', async () => {
  const external = await startHttpMcpFixture(), ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await external.close() })
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
  external.setListPageCount(5)
  const base = Config({ transport: 'streamable-http', serverName: 'pages', url: external.url,
    maxIncomingResponseBytes: 4096, failOnStartupError: true, reconnect: { enabled: false } })
  let refusal: unknown
  const refused = ctx.plugin({ inject: ['tools'], async apply(owner: Context) {
    try { await apply(owner, { ...base, listMaxPages: 2 }) } catch (error) { refusal = error }
  } })
  await refused
  expect(refusal).toBeInstanceOf(Error)
  expect(external.listRequests).toEqual(['0', '1'])
  expect(ctx.tools.schemas()).toEqual([])
  await refused.dispose()
  const defaultNative = ctx.plugin({ inject: ['tools'], apply: async (owner: Context) => apply(owner, base) })
  await defaultNative
  expect(external.listRequests).toEqual(['0', '1', '0', '1', '2', '3', '4'])
  expect(ctx.tools.schemas()).toHaveLength(5)
})

it('does not confirm closure while an original response reader cancellation is still unresolved', async () => {
  const cancel: PromiseWithResolvers<void> = Promise.withResolvers()
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const bounded = boundedHttpIncoming(16, () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    cancel() { started.resolve(); return cancel.promise },
  }))))
  await bounded.fetch('http://synthetic.invalid/mcp')
  let closed = false
  const closing = bounded.close().then((value) => { closed = true; return value })
  await started.promise
  expect(closed).toBe(false)
  cancel.resolve()
  expect(await closing).toBe(true)
})
