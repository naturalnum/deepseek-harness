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
import { executionTarget, requestId, sessionId, PlatformError } from '../contracts.ts'
import { readJson, sendFailure, sendJson } from '../http.ts'
import type { BrowserAgentAuth } from './browser-auth.ts'

const address = z.object({ kind: z.literal('session'), sessionId }).strict()
const window = z.object({ maxMessages: z.number().int().min(1).max(500).optional(),
  turnWindow: z.object({ minMessages: z.number().int().positive(), minTurns: z.number().int().positive() }).strict().optional() })
const page = window.extend({ address, throughSeq: z.number().int().min(-1), beforeSeq: z.number().int().nonnegative().optional() }).strict()
const follow = window.extend({ address, assistantStream: z.literal(true).optional() }).strict()
const prompt = z.object({ sessionId, requestId, mode: z.literal('queue'),
  content: z.array(z.object({ type: z.literal('text'), text: z.string().min(1) }).strict()).min(1).max(8),
  clientTimeZone: z.string().max(100).optional(),
  clientHints: z.object({ 'powerEvolve.executionTarget': z.string().max(256) }).strict().optional() }).strict()

function selectedExecutionTarget(hints: z.infer<typeof prompt>['clientHints']) {
  const value = hints?.['powerEvolve.executionTarget']
  if (value === undefined) return { kind: 'cloud' as const }
  try { return executionTarget.parse(JSON.parse(value)) }
  catch { throw new PlatformError(400, 'invalid_execution_target') }
}
const envelope = z.object({ type: z.literal('client-request'), rpcId: z.string().min(1).max(128),
  method: z.string().min(1).max(120), payload: z.object({ args: z.unknown() }).strict() }).strict()
const projectionRequest = z.object({ sessionId }).strict()
const afterResult = z.object({ events: z.array(z.object({ seq: z.number().int().nonnegative() }).passthrough()) }).strict()
const workspace = z.object({ workspaceId: z.uuid(), path: z.string(), title: z.string(),
  sessionIds: z.array(sessionId), createdAt: z.string(), updatedAt: z.string() }).strict()
const workspaceBaseline = z.object({ items: z.array(workspace),
  archivedSessionIds: z.array(sessionId), pinnedSessionIds: z.array(sessionId) }).strict()
const cloudWorkspaceTitlePrefix = 'power-evolve-cloud-title:'
const cloudWorkspaceCreated = z.object({ workspaceId: z.uuid(), title: z.string(),
  isDefault: z.literal(false), createdAt: z.string() }).strict()
const sessionSummary = z.object({ sessionId, updatedAt: z.number(), agentAvailable: z.boolean(),
  running: z.boolean(), blank: z.boolean(), cwd: z.string().optional() }).passthrough()
const sessionList = z.object({ items: z.array(sessionSummary) }).strict()
const fileScope = z.object({ workspaceFileScopeId: sessionId, path: z.string().min(1).max(1024) }).strict()
const fileRead = fileScope.extend({ range: z.object({ offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional() }).strict() }).strict()
const fileBytes = fileScope.extend({ options: z.object({
  baseFile: z.string().min(1).max(1024).optional(),
  range: z.object({ offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).max(2 * 1024 * 1024).optional() }).strict().optional(),
}).strict() }).strict()
const binaryFileResult = z.object({ absolutePath: z.string(), version: z.string(), bytes: z.number(),
  offset: z.number(), data: z.string(), eof: z.boolean() }).strict()
const withRequest = <T extends z.ZodType>(request: T) => z.object({ request }).strict()

function cloudWorkspaceTitle(path: string): string {
  if (!path.startsWith(cloudWorkspaceTitlePrefix) || path.length > 1024) {
    throw new PlatformError(400, 'invalid_cloud_workspace_title')
  }
  let title: string
  try { title = decodeURIComponent(path.slice(cloudWorkspaceTitlePrefix.length)) }
  catch { throw new PlatformError(400, 'invalid_cloud_workspace_title') }
  if (encodeURIComponent(title) !== path.slice(cloudWorkspaceTitlePrefix.length)
    || title !== title.trim() || title.length < 1 || title.length > 80
    || [...title].some(character => {
      const point = character.codePointAt(0)
      return point === undefined || point <= 0x1f || point === 0x7f
    })) throw new PlatformError(400, 'invalid_cloud_workspace_title')
  return title
}

type NativeCall = (path: string, token: string, input: unknown) => Promise<unknown>

function failure(error: unknown): { code: string; message: string; details: object } {
  if (error instanceof PlatformError) {
    if (error.code === 'native_remote_not_enabled' || error.code === 'native_stream_not_enabled') {
      return { code: 'gateway/invocation-unavailable', message: 'Remote endpoint is not enabled', details: {} }
    }
    if (error.code === 'workspace_not_found') {
      return { code: 'workspace/not-found', message: 'Workspace not found', details: {} }
    }
    if (error.code === 'file_not_found') return { code: 'workspace-file/not-found', message: 'File not found', details: { path: '' } }
    if (error.code === 'file_not_directory') return { code: 'workspace-file/not-directory', message: 'Path is not a directory', details: { path: '', kind: 'file' } }
    if (error.code === 'file_not_text') return { code: 'workspace-file/not-text', message: 'File is not UTF-8 text', details: { path: '' } }
    if (error.code === 'file_too_large') return { code: 'workspace-file/too-large', message: 'File exceeds read limit', details: { path: '', limit: 2 * 1024 * 1024 } }
    if (error.code === 'invalid_path') return { code: 'workspace-file/outside-workspace', message: 'File path is unavailable', details: { path: '' } }
    if (error.code === 'invalid_execution_target') return { code: 'gateway/arguments-invalid', message: 'Invalid execution target', details: {} }
    if (error.code === 'invalid_cloud_workspace_title') return { code: 'workspace/invalid-path', message: 'Invalid cloud Workspace title', details: { path: '' } }
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

async function sendNativeBytes(response: ServerResponse, rpcId: string, raw: unknown): Promise<void> {
  const { data, ...value } = binaryFileResult.parse(raw)
  const bytes = Buffer.from(data, 'base64')
  const parts = new FormData()
  parts.set('bytes-0', new Blob([new Uint8Array(bytes)]))
  parts.set('metadata', JSON.stringify({ type: 'server-response', rpcId,
    result: { ok: true, value: { ...value, data: null } },
    attachments: [{ path: ['data'], codec: 'bytes', part: 'bytes-0' }] }))
  const encoded = new Response(parts)
  const body = Buffer.from(await encoded.arrayBuffer())
  response.writeHead(200, { 'content-type': encoded.headers.get('content-type') ?? 'multipart/form-data',
    'content-length': String(body.length), 'cache-control': 'no-store' })
  response.end(body)
}

/** Register one browser-authenticated native Session carrier without exposing Host-local Remotes. */
export function installNativeRemote(ctx: Context, auth: BrowserAgentAuth, origin: string,
  pollMs: number, maxRequestBytes: number, maxStreams: number): void {
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
        z.object({ _request: z.object({}).strict() }).strict().parse(args)
        return call('/native/sessions/list', token, {})
      }
      case 'session/create': {
        const { request } = withRequest(z.object({ workspaceId: z.uuid().optional(), sessionId: sessionId.optional() }).strict()).parse(args)
        // Check Session ownership before comparing its Workspace membership. A foreign
        // Session must be indistinguishable from a missing one to this caller.
        if (request.sessionId !== undefined) {
          await call('/native/sessions/adopt', token, { sessionId: request.sessionId })
        }
        if (request.workspaceId !== undefined) {
          const baseline = workspaceBaseline.parse(await call('/native/workspace/baseline', token, {}))
          const target = baseline.items.find(item => item.workspaceId === request.workspaceId)
          if (target === undefined) {
            throw new PlatformError(404, 'workspace_not_found')
          }
          if (request.sessionId !== undefined && !target.sessionIds.includes(request.sessionId)) {
            throw new PlatformError(409, 'workspace_session_mismatch')
          }
        }
        return request.sessionId === undefined
          ? call('/sessions/create', token, { requestId: requestId.parse(rpcId),
            ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }) })
          : { sessionId: request.sessionId }
      }
      case 'workspace/create': {
        const { request } = withRequest(z.object({ path: z.string() }).strict()).parse(args)
        const title = cloudWorkspaceTitle(request.path)
        const created = cloudWorkspaceCreated.parse(await call('/workspaces/create', token, {
          requestId: requestId.parse(rpcId), title,
        }))
        const baseline = workspaceBaseline.parse(await call('/native/workspace/baseline', token, {}))
        const item = baseline.items.find(value => value.workspaceId === created.workspaceId)
        if (item === undefined || item.title !== created.title || item.path !== '/workspace') {
          throw new PlatformError(503, 'workspace_baseline_unavailable')
        }
        return { workspace: item, created: true }
      }
      case 'session/prompt': {
        const { request: value } = withRequest(prompt).parse(args)
        const accepted = z.object({ accepted: z.literal(true) }).parse(await call('/sessions/prompt', token, { sessionId: value.sessionId, requestId: value.requestId,
          text: value.content.map(part => part.text).join('\n'), target: selectedExecutionTarget(value.clientHints) }))
        return { accepted: accepted.accepted }
      }
      case 'session/cancel': {
        const { request } = withRequest(z.object({ sessionId }).strict()).parse(args)
        return z.object({ accepted: z.literal(true) }).strict().parse(
          await call('/sessions/cancel', token, request),
        )
      }
      case 'session/page': return call('/native/sessions/page', token, withRequest(page).parse(args).request)
      case 'session/projections': {
        const { sessionId: id } = withRequest(projectionRequest).parse(args).request
        const snapshot = z.object({ projections: z.object({ asOfSeq: z.number().int(), values: z.record(z.string(), z.json()) }) })
          .parse(await call('/native/sessions/snapshot', token, { address: { kind: 'session', sessionId: id }, maxMessages: 1 }))
        return snapshot.projections
      }
      case 'workspaceFiles/list': {
        const input = fileScope.parse(args)
        return call('/native/files/list', token, { sessionId: input.workspaceFileScopeId, path: input.path })
      }
      case 'workspaceFiles/stat': {
        const input = fileScope.parse(args)
        return call('/native/files/stat', token, { sessionId: input.workspaceFileScopeId, path: input.path })
      }
      case 'workspaceFiles/read': {
        const input = fileRead.parse(args)
        return call('/native/files/read', token, { sessionId: input.workspaceFileScopeId,
          path: input.path, range: input.range })
      }
      case 'workspaceFiles/readBytes': {
        const input = fileBytes.parse(args)
        return call('/native/files/readBytes', token, { sessionId: input.workspaceFileScopeId,
          path: input.path, options: input.options })
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
        const initial = sessionList.parse(await call('/native/sessions/list', token, {})).items
        let previous = new Map(initial.map(item => [item.sessionId, item]))
        yield { type: 'ready', clientId: randomUUID(), host: { home: '/workspace' } }
        for (const item of initial) {
          if (item.running) yield { type: 'emit', event: 'api-session/status', args: [item.sessionId, true] }
        }
        while (!signal.aborted) {
          try { await delay(Math.max(pollMs, 1000), undefined, { signal }) }
          catch (error) { if (signal.aborted) return; throw error }
          const items = sessionList.parse(await call('/native/sessions/list', token, {})).items
          const current = new Map(items.map(item => [item.sessionId, item]))
          for (const item of items) {
            const before = previous.get(item.sessionId)
            if (JSON.stringify(item) !== JSON.stringify(before)) {
              yield { type: 'emit', event: 'api-session/added', args: [item] }
            }
            if (item.running !== before?.running) {
              yield { type: 'emit', event: 'api-session/status', args: [item.sessionId, item.running] }
            }
          }
          for (const id of previous.keys()) {
            if (!current.has(id)) yield { type: 'emit', event: 'api-session/removed', args: [id] }
          }
          previous = current
        }
        return
      }
      case 'session/control': {
        z.object({}).strict().parse(args)
        yield { type: 'baseline', value: { projections: {} } }
        await waitForAbort(signal)
        return
      }
      case 'workspace/follow': {
        z.object({}).strict().parse(args)
        let baseline = workspaceBaseline.parse(await call('/native/workspace/baseline', token, {}))
        yield { type: 'baseline', value: baseline }
        while (!signal.aborted) {
          try { await delay(Math.max(pollMs, 1000), undefined, { signal }) }
          catch (error) { if (signal.aborted) return; throw error }
          const current = workspaceBaseline.parse(await call('/native/workspace/baseline', token, {}))
          if (JSON.stringify(current) === JSON.stringify(baseline)) continue
          for (const item of current.items) yield { type: 'upsert', workspace: item }
          if (JSON.stringify(current.archivedSessionIds) !== JSON.stringify(baseline.archivedSessionIds)) {
            yield { type: 'archived', archivedSessionIds: current.archivedSessionIds }
          }
          if (JSON.stringify(current.pinnedSessionIds) !== JSON.stringify(baseline.pinnedSessionIds)) {
            yield { type: 'pinned', pinnedSessionIds: current.pinnedSessionIds }
          }
          baseline = current
        }
        return
      }
      case 'session/follow': {
        const input = withRequest(follow).parse(args).request
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
      case 'workspaceFiles/changes': {
        const input = fileScope.parse(args)
        const request = { sessionId: input.workspaceFileScopeId, path: input.path }
        let previous = await call('/native/files/observe', token, request)
        yield { kind: 'ready' }
        while (!signal.aborted) {
          try { await delay(Math.max(pollMs, 2000), undefined, { signal }) }
          catch (error) { if (signal.aborted) return; throw error }
          const current = await call('/native/files/observe', token, request)
          if (JSON.stringify(current) === JSON.stringify(previous)) continue
          previous = current
          yield { kind: 'change', change: current }
        }
        return
      }
      default: throw new PlatformError(404, 'native_stream_not_enabled')
    }
  }
  let activeStreams = 0
  const mux = new RemoteStreamMuxServer(async (method, payload, _uplink, peer, control) => {
    const value = z.object({ args: z.unknown() }).strict().parse(payload)
    if (activeStreams >= maxStreams) throw new PlatformError(429, 'native_stream_limit')
    activeStreams++
    return (async function* (): AsyncGenerator<unknown> {
      try { yield* stream(method, value.args, peer, control.signal) }
      finally { activeStreams-- }
    })()
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
        if (method === 'workspaceFiles/readBytes') await sendNativeBytes(res, message.rpcId, value)
        else sendJson(res, { type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } })
      } catch (error) {
        sendJson(res, { type: 'server-response', rpcId: message.rpcId, result: { ok: false, error: failure(error) } })
      }
    } catch (error) { sendFailure(res, error) }
  } }))
}
