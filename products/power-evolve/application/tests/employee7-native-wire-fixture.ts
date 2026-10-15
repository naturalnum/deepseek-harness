/** Shared real Host HTTP fixture; all Platform identity, roster, queue, search and acknowledgement behavior is explicitly substituted. */
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect } from 'vitest'
import { z } from 'zod'
import { PlatformError } from '../src/contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import { BrowserAgentAuth } from '../src/host/browser-auth.ts'
import { installNativeRemote } from '../src/host/native-remote.ts'
import RuntimeScope from '../src/host/scope.ts'

/** Platform substitute request path, bearer credential and parsed JSON captured in arrival order. */
export interface Call { path: string; token: string; input: unknown }
interface QueuedInput { requestId: string; text: string; state: 'queued' | 'failed' }
interface PlatformSubstitute {
  readonly calls: Call[]
  readonly queued: QueuedInput[]
  identityDenied: boolean
  sessionItems: unknown[]
  listReads: number
  cancelDenial: { status: number; code: string } | undefined
  acknowledgement: unknown
  searchValue: unknown
  searchDenial: { status: number; code: string } | undefined
  holdSearch: boolean
  searchDisconnected: boolean
}
/** Owned Host address and RuntimeScope; Platform identity, durable queue and search outcomes are substitutes. */
export interface NativeFixture {
  readonly origin: string
  readonly sessionId: string
  readonly token: string
  readonly platform: PlatformSubstitute
  readonly runtime: RuntimeScope
}

const addressedSession = z.object({ sessionId: z.uuid() }).strict()

/**
 * Run production Host services on owned loopback ports and dispose their scope, listeners and temporary files on exit.
 * @param run Callback using the real Host and the explicit Platform substitute.
 * @returns The callback result after owned resources have been released.
 */
export async function nativeHost<T>(run: (fixture: NativeFixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'employee7-native-wire-'))
  const context = new Context()
  const releaseSearch = Promise.withResolvers<undefined>()
  const token = randomUUID().replaceAll('-', '')
  const id = randomUUID()
  const platform: PlatformSubstitute = {
    calls: [], queued: [
      { requestId: randomUUID(), text: 'first durable pending input', state: 'queued' },
      { requestId: randomUUID(), text: 'second durable pending input', state: 'queued' },
    ],
    identityDenied: false, sessionItems: [], listReads: 0, cancelDenial: undefined, acknowledgement: { accepted: true },
    searchValue: { items: [{ sessionId: id, snippet: 'Explicit Platform substitute' }], hasMore: false },
    searchDenial: undefined, holdSearch: false, searchDisconnected: false,
  }
  const user = { userId: randomUUID(), username: 'employee7-wire-fixture',
    settings: { model: 'wire-fixture', maxTokens: 1000, revision: 1 } }
  const pending = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const processing = (async () => {
      try {
        const credential = bearer(request)
        const input: unknown = await readJson(request, 4096)
        platform.calls.push({ path: request.url ?? '', token: credential, input })
        if (credential !== token) throw new PlatformError(401, 'unauthorized')
        if (request.url === '/identity/me') {
          z.object({}).strict().parse(input)
          if (platform.identityDenied) throw new PlatformError(401, 'account_unauthorized')
          sendJson(response, user)
          return
        }
        if (request.url === '/native/sessions/list') {
          z.object({}).strict().parse(input)
          platform.listReads++
          sendJson(response, { items: platform.sessionItems })
          return
        }
        if (request.url === '/native/sessions/search') {
          z.object({ query: z.string() }).strict().parse(input)
          response.once('close', () => { if (!response.writableEnded) platform.searchDisconnected = true })
          if (platform.searchDenial !== undefined) {
            throw new PlatformError(platform.searchDenial.status, platform.searchDenial.code)
          }
          if (platform.holdSearch) await releaseSearch.promise
          if (!response.destroyed) sendJson(response, platform.searchValue)
          return
        }
        if (request.url === '/native/sessions/cancel' || request.url === '/sessions/cancel') {
          expect(addressedSession.parse(input)).toEqual({ sessionId: id })
          if (platform.cancelDenial !== undefined) {
            throw new PlatformError(platform.cancelDenial.status, platform.cancelDenial.code)
          }
          // The sentinel deliberately distinguishes the legacy route. This is not a TaskStore implementation.
          if (request.url === '/sessions/cancel') {
            const queued = platform.queued.find(item => item.state === 'queued')
            if (queued !== undefined) queued.state = 'failed'
          }
          sendJson(response, platform.acknowledgement)
          return
        }
        throw new PlatformError(404, 'unexpected_fixture_endpoint')
      } catch (error) { sendFailure(response, error) }
    })().finally(() => { pending.delete(processing) })
    pending.add(processing)
  })
  try {
    await writeFile(join(root, 'worker-token'), randomUUID(), { mode: 0o600, flag: 'wx' })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Owned Platform substitute did not listen')
    const platformOrigin = `http://127.0.0.1:${address.port}`
    await context.plugin(RuntimeScope, { platformUrl: platformOrigin, workerTokenFile: join(root, 'worker-token'),
      timeoutMs: 5000, maxResponseBytes: 4096 })
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    let origin = ''
    let runtime: RuntimeScope | undefined
    await context.inject(['powerEvolveRuntime', 'webServer'], (ctx) => {
      origin = `http://127.0.0.1:${ctx.webServer.port}`
      runtime = ctx.powerEvolveRuntime
      const auth = new BrowserAgentAuth(origin, platformOrigin, ctx.powerEvolveRuntime)
      installNativeRemote(ctx, auth, origin, 10, 4096, 4, [], {
        maxGenerationMs: 60_000, maxGenerationItems: 1024, maxGenerationBytes: 16_777_216,
      }, 10_000)
    })
    if (runtime === undefined || origin === '') throw new Error('Production native carrier did not activate')
    return await run({ origin, runtime, sessionId: id, token, platform })
  } finally {
    releaseSearch.resolve(undefined)
    try { await context.fiber.dispose() }
    finally {
      await Promise.allSettled(pending)
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve() })
          server.closeIdleConnections()
        })
      }
      await rm(root, { recursive: true, force: true })
    }
  }
}

/**
 * Submit a native unary request to the owned Host with cookie or bearer credentials.
 * @param fixture Active Host fixture.
 * @param endpoint Controller and method used in the request path.
 * @param args Native controller arguments.
 * @param options RPC identity, method, credential, Origin and caller cancellation overrides.
 * @returns The actual Host HTTP response; caller abort rejects the fetch.
 */
export function nativePost(fixture: NativeFixture, endpoint: string, args: unknown, options: {
  readonly rpcId?: string
  readonly method?: string
  readonly cookie?: boolean
  readonly origin?: string
  readonly signal?: AbortSignal
} = {}): Promise<Response> {
  return fetch(`${fixture.origin}/native/api/${endpoint}`, {
    method: 'POST', ...(options.signal === undefined ? {} : { signal: options.signal }), headers: { 'content-type': 'application/json', origin: options.origin ?? fixture.origin,
      ...(options.cookie ? { cookie: `pe_agent=${fixture.token}` } : { authorization: `Bearer ${fixture.token}` }) },
    body: JSON.stringify({ type: 'client-request', rpcId: options.rpcId ?? 'employee7-native-wire',
      method: options.method ?? endpoint, payload: { args } }),
  })
}
