/** Tenant-scoped carrier for the native DSH Web Session client. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteStreamMuxServer, rejectRemoteStreamUpgrade } from '@deepseek-ai/dsh-api-gateway'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createScope } from '@deepseek-ai/dsh-scope'
import { z } from 'zod'
import { requestId, sessionId, PlatformError } from '../contracts.ts'
import { readJson, sendFailure, sendJson } from '../http.ts'
import type { BrowserAgentAuth } from './browser-auth.ts'

const address = z.object({ kind: z.literal('session'), sessionId }).strict()
const window = z.object({ maxMessages: z.number().int().min(1).max(200).optional(),
  turnWindow: z.object({ minMessages: z.number().int().positive(), minTurns: z.number().int().positive() }).strict().optional() })
const page = window.extend({ address, throughSeq: z.number().int().min(-1), beforeSeq: z.number().int().nonnegative().optional() }).strict()
const follow = window.extend({ address, assistantStream: z.literal(true).optional() }).strict()
const prompt = z.object({ sessionId, requestId, mode: z.literal('queue'),
  content: z.array(z.object({ type: z.literal('text'), text: z.string().min(1) }).strict()).min(1).max(8),
  clientTimeZone: z.string().max(100).optional() }).strict()
const envelope = z.object({ type: z.literal('client-request'), rpcId: z.string().min(1).max(128),
  method: z.string().min(1).max(120), payload: z.object({ args: z.unknown() }).strict() }).strict()
const projectionRequest = z.object({ sessionId }).strict()
const afterResult = z.object({ events: z.array(z.object({ seq: z.number().int().nonnegative() }).passthrough()) }).strict()

type NativeCall = (path: string, token: string, input: unknown) => Promise<unknown>

function failure(error: unknown): { code: string; message: string; details: object } {
  if (error instanceof PlatformError) {
    if (error.code === 'native_remote_not_enabled' || error.code === 'native_stream_not_enabled') {
      return { code: 'gateway/invocation-unavailable', message: 'Remote endpoint is not enabled', details: {} }
    }
    if (error.status === 404) return { code: 'session/not-found', message: 'Session not found', details: {} }
    if (error.status === 401 || error.status === 403) return { code: 'gateway/forbidden', message: 'Access denied', details: {} }
    if (error.status === 409) return { code: 'session/conflict', message: 'Session request conflicts with stored state', details: {} }
    if (error.status === 429) return { code: 'session/agent-busy', message: 'Session capacity is unavailable', details: { reason: 'CAPACITY' } }
  }
  if (error instanceof z.ZodError) return { code: 'gateway/arguments-invalid', message: 'Invalid Remote request', details: {} }
  return { code: 'gateway/service-unavailable', message: 'Remote request unavailable', details: {} }
}

function assertHostAuthority(request: IncomingMessage, origin: string): void {
  if (request.headers.host !== new URL(origin).host || !request.url?.startsWith('/')) {
    throw new PlatformError(403, 'invalid_host_authority')
  }
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

/** Register one browser-authenticated native Session carrier without exposing Host-local Remotes. */
export function installNativeRemote(ctx: Context, auth: BrowserAgentAuth, origin: string, pollMs: number, maxRequestBytes: number): void {
  const tokens = new WeakMap<PeerScope, string>()
  const call: NativeCall = (path, token, input) => ctx.powerEvolveRuntime.call(path, token, input)
  const tokenOf = (peer: PeerScope): string => {
    const token = tokens.get(peer)
    if (!token) throw new PlatformError(401, 'unauthorized_peer')
    return token
  }
  const unary = async (method: string, args: unknown, token: string, rpcId: string): Promise<unknown> => {
    switch (method) {
      case 'session/list': {
        z.object({}).strict().parse(args)
        return call('/native/sessions/list', token, {})
      }
      case 'session/create': {
        z.object({}).strict().parse(args)
        return call('/sessions/create', token, { requestId: requestId.parse(rpcId) })
      }
      case 'session/prompt': {
        const value = prompt.parse(args)
        const accepted = z.object({ accepted: z.literal(true) }).parse(await call('/sessions/prompt', token, { sessionId: value.sessionId, requestId: value.requestId,
          text: value.content.map(part => part.text).join('\n'), target: { kind: 'cloud' } }))
        return { accepted: accepted.accepted }
      }
      case 'session/page': return call('/native/sessions/page', token, page.parse(args))
      case 'session/projections': {
        const { sessionId: id } = projectionRequest.parse(args)
        const snapshot = z.object({ projections: z.object({ asOfSeq: z.number().int(), values: z.record(z.string(), z.json()) }) })
          .parse(await call('/native/sessions/snapshot', token, { address: { kind: 'session', sessionId: id }, maxMessages: 1 }))
        return snapshot.projections
      }
      case 'settings/describe': {
        z.object({}).strict().parse(args)
        return { writable: false, hasDocument: false, namespaces: [] }
      }
      default: throw new PlatformError(404, 'native_remote_not_enabled')
    }
  }
  const stream = async function* (method: string, args: unknown, peer: PeerScope, signal: AbortSignal): AsyncGenerator<unknown> {
    const token = tokenOf(peer)
    switch (method) {
      case '$events': {
        z.object({}).strict().parse(args)
        yield { type: 'ready', clientId: randomUUID(), host: { home: '/workspace' } }
        await waitForAbort(signal)
        return
      }
      case 'session/control': {
        z.object({}).strict().parse(args)
        yield { type: 'baseline', value: { projections: {} } }
        await waitForAbort(signal)
        return
      }
      case 'session/follow': {
        const input = follow.parse(args)
        const snapshot = z.object({ cursor: z.number().int().min(-1) }).passthrough().parse(
          await call('/native/sessions/snapshot', token, input),
        )
        yield snapshot
        let cursor = snapshot.cursor
        while (!signal.aborted) {
          const next = afterResult.parse(await call('/native/sessions/after', token, { sessionId: input.address.sessionId, cursor }))
          for (const event of next.events) {
            if (event.seq !== cursor + 1) throw new PlatformError(503, 'native_history_gap')
            cursor = event.seq
            yield { type: 'event', event }
          }
          if (next.events.length) continue
          try { await delay(pollMs, undefined, { signal }) }
          catch (error) { if (signal.aborted) return; throw error }
        }
        return
      }
      default: throw new PlatformError(404, 'native_stream_not_enabled')
    }
  }
  const mux = new RemoteStreamMuxServer(async (method, payload, _uplink, peer, control) => {
    const value = z.object({ args: z.unknown() }).strict().parse(payload)
    return stream(method, value.args, peer, control.signal)
  }, failure, 2000, 262_144)
  ctx.effect(() => () => mux.close())
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/native/api/remote.mux',
    handler: async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      try {
        const credential = await auth.authenticate(req)
        assertHostAuthority(req, origin)
        const scope = createScope(ctx, {})
        const peer: PeerScope = { id: brandString<PeerId>(randomUUID()), ctx: scope.ctx, dispose: scope.dispose }
        tokens.set(peer, credential.token)
        mux.handleUpgrade(req, socket, head, peer)
      } catch (error) {
        rejectRemoteStreamUpgrade(socket, error instanceof PlatformError && error.status === 403 ? 403 : 401)
      }
    },
  }))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/native/api', handler: async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const credential = await auth.authenticate(req)
      assertHostAuthority(req, origin)
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (req.method !== 'POST' || !/^\/native\/api\/[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/.test(path)) {
        throw new PlatformError(404, 'not_found')
      }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
        throw new PlatformError(415, 'invalid_content_type')
      }
      const message = envelope.parse(await readJson(req, maxRequestBytes))
      const method = path.slice('/native/api/'.length)
      if (message.method !== method) throw new PlatformError(400, 'method_mismatch')
      try {
        const value = await unary(method, message.payload.args, credential.token, message.rpcId)
        sendJson(res, { type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } })
      } catch (error) {
        sendJson(res, { type: 'server-response', rpcId: message.rpcId, result: { ok: false, error: failure(error) } })
      }
    } catch (error) { sendFailure(res, error) }
  } }))
}
