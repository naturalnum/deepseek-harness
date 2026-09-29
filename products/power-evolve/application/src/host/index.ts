/** Authenticated product RPC carrier over the native Typert Gateway. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createScope } from '@deepseek-ai/dsh-scope'
import { TypertRemoteService, Remote, type PeerScope, type PeerId, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { createRequest, sessionFilesListRequest, sessionFileReadRequest, sessionFilePutRequest, listRequest, pageRequest, promptRequest, settingsUpdateRequest, skillInstallRequest, skillRequest, skillToggleRequest, PlatformError } from '../contracts.ts'
import { readJson, sendFailure, sendJson, writeLine } from '../http.ts'
import { serveNativeUi, serveUi } from '../ui.ts'
import { BrowserAgentAuth } from './browser-auth.ts'
import { installNativeRemote } from './native-remote.ts'
import { Scheduler } from './scheduler.ts'

const requests = { me: z.object({}).strict(), logout: z.object({}).strict(), modelsList: z.object({}).strict(), settingsUpdate: settingsUpdateRequest,
  create: createRequest, list: listRequest, prompt: promptRequest, page: pageRequest, follow: pageRequest,
  filesList: sessionFilesListRequest, filesRead: sessionFileReadRequest, filesPut: sessionFilePutRequest,
  skillsList: z.object({}).strict(), skillsRead: skillRequest,
  skillsInstall: skillInstallRequest, skillsToggle: skillToggleRequest,
  skillsUploadTicket: z.object({ requestId: z.uuid(), sizeBytes: z.number().int().min(1).max(1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
  skillsRevoke: skillRequest, actionsList: z.object({}).strict(),
  artifactsPublish: z.object({ requestId: z.uuid(), sessionId: z.uuid(), path: z.string().min(1).max(512) }).strict(),
  artifactsList: z.object({ workspaceId: z.uuid().optional(), sessionId: z.uuid().optional(),
    cursor: z.uuid().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  artifactsPreview: z.object({ artifactId: z.uuid() }).strict(),
  executionsList: z.object({}).strict(), executionCancel: z.object({ executionId: z.uuid() }).strict(),
  devicesList: z.object({}).strict(), devicesPair: z.object({}).strict(),
  devicesRevoke: z.object({ deviceId: z.uuid() }).strict(),
  directoriesRevoke: z.object({ directoryId: z.uuid() }).strict() }
const endpoint = { me: '/identity/me', logout: '/identity/logout', modelsList: '/identity/models', settingsUpdate: '/identity/settings/update',
  create: '/sessions/create', list: '/sessions/list', prompt: '/sessions/prompt', page: '/sessions/page',
  filesList: '/files/session/list', filesRead: '/files/session/read', filesPut: '/files/session/put',
  skillsList: '/skills/list', skillsRead: '/skills/read',
  skillsInstall: '/skills/install', skillsToggle: '/skills/toggle',
  skillsUploadTicket: '/skills/upload-ticket', skillsRevoke: '/skills/revoke', actionsList: '/connectors/actions',
  artifactsPublish: '/artifacts/publish', artifactsList: '/artifacts/list', artifactsPreview: '/artifacts/preview',
  executionsList: '/executions/list', executionCancel: '/executions/cancel',
  devicesList: '/devices/list', devicesPair: '/devices/pair',
  devicesRevoke: '/devices/revoke', directoriesRevoke: '/devices/directories/revoke' } as const
type Method = keyof typeof requests

declare module '@deepseek-ai/cordis' { interface Context { powerEvolve: ProductRemote; powerEvolveBrowserAuth: BrowserAgentAuth } }

class ProductRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly options: { tokens: WeakMap<PeerScope, string>; pollMs: number;
    platformOrigin: string }) { super(ctx, 'powerEvolve') }
  private token(): string {
    const peer = this.ctx.invocation?.peer
    const token = peer && this.options.tokens.get(peer)
    if (!token) throw new PlatformError(401, 'unauthorized_peer')
    return token
  }
  private call(method: keyof typeof endpoint, request: unknown) {
    return this.ctx.powerEvolveRuntime.call(endpoint[method], this.token(), request)
  }
  @Remote me(request: z.infer<typeof requests.me>) { return this.call('me', request) }
  @Remote logout(request: z.infer<typeof requests.logout>) { return this.call('logout', request) }
  @Remote modelsList(request: z.infer<typeof requests.modelsList>) { return this.call('modelsList', request) }
  @Remote settingsUpdate(request: z.infer<typeof settingsUpdateRequest>) { return this.call('settingsUpdate', request) }
  @Remote create(request: z.infer<typeof createRequest>) { return this.call('create', request) }
  @Remote list(request: z.infer<typeof listRequest>) { return this.call('list', request) }
  @Remote prompt(request: z.infer<typeof promptRequest>) { return this.call('prompt', request) }
  @Remote page(request: z.infer<typeof pageRequest>) { return this.call('page', request) }
  @Remote filesList(request: z.infer<typeof sessionFilesListRequest>) { return this.call('filesList', request) }
  @Remote filesRead(request: z.infer<typeof sessionFileReadRequest>) { return this.call('filesRead', request) }
  @Remote filesPut(request: z.infer<typeof sessionFilePutRequest>) { return this.call('filesPut', request) }
  @Remote skillsList(request: z.infer<typeof requests.skillsList>) { return this.call('skillsList', request) }
  @Remote skillsRead(request: z.infer<typeof skillRequest>) { return this.call('skillsRead', request) }
  @Remote skillsInstall(request: z.infer<typeof skillInstallRequest>) { return this.call('skillsInstall', request) }
  @Remote skillsToggle(request: z.infer<typeof skillToggleRequest>) { return this.call('skillsToggle', request) }
  @Remote async skillsUploadTicket(request: z.infer<typeof requests.skillsUploadTicket>) {
    const result = z.discriminatedUnion('state', [
      z.object({ state: z.literal('ready'), item: z.json() }).strict(),
      z.object({ state: z.literal('pending'), ticket: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
        uploadUrl: z.url(), expiresAt: z.iso.datetime() }).strict(),
    ]).parse(await this.call('skillsUploadTicket', request))
    if (result.state === 'pending') {
      const upload = new URL(result.uploadUrl)
      if (upload.origin !== this.options.platformOrigin || upload.pathname !== '/skills/upload'
        || upload.username || upload.password || upload.search || upload.hash) {
        throw new PlatformError(503, 'skill_upload_unavailable')
      }
    }
    return result
  }
  @Remote skillsRevoke(request: z.infer<typeof skillRequest>) { return this.call('skillsRevoke', request) }
  @Remote actionsList(request: z.infer<typeof requests.actionsList>) { return this.call('actionsList', request) }
  @Remote artifactsPublish(request: z.infer<typeof requests.artifactsPublish>) { return this.call('artifactsPublish', request) }
  @Remote artifactsList(request: z.infer<typeof requests.artifactsList>) { return this.call('artifactsList', request) }
  @Remote artifactsPreview(request: z.infer<typeof requests.artifactsPreview>) { return this.call('artifactsPreview', request) }
  @Remote executionsList(request: z.infer<typeof requests.executionsList>) { return this.call('executionsList', request) }
  @Remote executionCancel(request: z.infer<typeof requests.executionCancel>) { return this.call('executionCancel', request) }
  @Remote devicesList(request: z.infer<typeof requests.devicesList>) { return this.call('devicesList', request) }
  @Remote devicesPair(request: z.infer<typeof requests.devicesPair>) { return this.call('devicesPair', request) }
  @Remote devicesRevoke(request: z.infer<typeof requests.devicesRevoke>) { return this.call('devicesRevoke', request) }
  @Remote directoriesRevoke(request: z.infer<typeof requests.directoriesRevoke>) { return this.call('directoriesRevoke', request) }
  @Remote async *follow(request: z.infer<typeof pageRequest>, signal: AbortSignal): AsyncGenerator<unknown> {
    let after = request.after
    let previous = ''
    while (!signal.aborted) {
      const result = await this.call('page', { ...request, after })
      const parsed = z.object({ events: z.array(z.object({ seq: z.number().int() })), operations: z.array(z.json()) }).parse(result)
      const signature = JSON.stringify(parsed.operations)
      if (parsed.events.length || signature !== previous) { yield result; previous = signature }
      after = parsed.events.at(-1)?.seq ?? after
      try { await delay(this.options.pollMs, undefined, { signal }) }
      catch (error) { if (signal.aborted) return; throw error }
    }
  }
}

export const name = 'power-evolve-host'
export const inject = ['powerEvolveRuntime', 'sessionPersistence', 'agents', 'sessions', 'tools', 'webServer', 'typert', 'typertGateway', 'agentLoop']
export const Config = schema.object({
  origin: schema.string().required(), platformOrigin: schema.string().required(),
  deviceOrigin: schema.string().required(),
  concurrency: schema.number().step(1).min(1).required(), pollMs: schema.number().min(50).required(),
  renewMs: schema.number().min(100).required(), operationTimeoutMs: schema.number().min(1000).required(),
  maxRequestBytes: schema.number().min(1024).required(), maxStreams: schema.number().step(1).min(1).required(),
  readyFile: schema.string().required(),
})
export type Config = ReturnType<typeof Config>

/** Mount only product RPC methods; native global settings and execution endpoints stay unexposed.
 * @param ctx - host profile plugin lifetime.
 * @param config - admission, dispatch, and carrier bounds.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const instanceId = randomUUID()
  const browserAuth = new BrowserAgentAuth(config.origin, config.platformOrigin, ctx.powerEvolveRuntime)
  ctx.provide('powerEvolveBrowserAuth', browserAuth)
  installNativeRemote(ctx, browserAuth, config.origin, config.pollMs, config.maxRequestBytes, config.maxStreams)
  const tokens = new WeakMap<PeerScope, string>()
  ctx.plugin(ProductRemote, { tokens, pollMs: config.pollMs, platformOrigin: config.platformOrigin })
  const invocations: InvocationDescriptor[] = Object.entries(requests).map(([method, request]) => ({
    id: `@power-evolve/application#powerEvolve/${method}`, service: 'powerEvolve', namespace: 'powerEvolve', method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: `PowerEvolve/${method}`, create: () => request } }],
    result: { mode: 'strict', typeSymbol: 'PowerEvolve/Json', create: () => z.json() },
    ...(method === 'follow' ? { mode: 'stream' as const, cancellation: { parameter: 'signal' } } : {}),
  }))
  ctx.typert.register({ package: '@power-evolve/application', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations })
  const scheduler = new Scheduler(ctx, config)
  scheduler.start()
  ctx.effect(() => () => scheduler.close())
  let streams = 0
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    let peer: PeerScope | undefined
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    let streaming = false
    try {
      const url = new URL(req.url ?? '/', config.origin)
      const path = url.pathname
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, { ready: true, service: 'host', activeAgents: ctx.agents.list().length, loadedSessions: ctx.sessions.list().length, activeGrants: ctx.powerEvolveRuntime.grants.size, instanceId }); return
      }
      if (req.method === 'GET' && path === '/config') { sendJson(res, { loginUrl: `${config.platformOrigin}/login`,
        approvalUrl: `${config.platformOrigin}/approval`, deviceOrigin: config.deviceOrigin }); return }
      if (req.method === 'GET' && await serveNativeUi(path, res, config.platformOrigin)) return
      const artifactContent = /^\/api\/powerEvolve\/artifacts\/([^/]+)\/content$/u.exec(path)
      if (req.method === 'GET' && artifactContent) {
        const artifactId = z.uuid().parse(artifactContent[1])
        const credential = await browserAuth.authenticate(req, true)
        const upstream = await fetch(`${config.platformOrigin}/artifacts/${artifactId}/content`, {
          headers: { authorization: `Bearer ${credential.token}` }, signal: abort.signal,
        })
        if (!upstream.ok || !upstream.body) throw new PlatformError(upstream.status === 404 ? 404 : 503, 'artifact_unavailable')
        const length = Number(upstream.headers.get('content-length'))
        if (!Number.isInteger(length) || length < 0 || length > 2 * 1024 * 1024) throw new PlatformError(503, 'artifact_unavailable')
        res.writeHead(200, { 'content-type': 'application/octet-stream',
          'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment',
          'content-length': String(length), 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff' })
        let received = 0
        for await (const chunk of upstream.body) {
          abort.signal.throwIfAborted()
          received += chunk.byteLength
          if (received > length) throw new PlatformError(503, 'artifact_unavailable')
          if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal })
        }
        if (received !== length) throw new PlatformError(503, 'artifact_unavailable')
        res.end()
        return
      }
      if (path === '/auth/exchange') {
        if (url.search) throw new PlatformError(400, 'invalid_request')
        await browserAuth.exchange(req, res)
        return
      }
      if (req.method === 'GET' && await serveUi(path, 'client', res)) return
      if (req.method !== 'POST' || !path.startsWith('/api/powerEvolve/')) throw new PlatformError(404, 'not_found')
      const method = z.enum(Object.keys(requests) as [Method, ...Method[]]).parse(path.slice('/api/powerEvolve/'.length))
      const credential = await browserAuth.authenticate(req)
      const token = credential.token
      if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '')) {
        throw new PlatformError(415, 'invalid_content_type')
      }
      const input = z.object({ request: requests[method] }).strict().parse(await readJson(req, config.maxRequestBytes))
      if (method === 'follow') {
        if (streams >= config.maxStreams) throw new PlatformError(429, 'stream_limit')
        // Check Session ownership before committing stream response headers.
        await ctx.powerEvolveRuntime.call('/sessions/page', token, input.request)
        streams++; streaming = true
      }
      const scope = createScope(ctx, {})
      peer = { id: brandString<PeerId>(randomUUID()), ctx: scope.ctx, dispose: scope.dispose }
      tokens.set(peer, token)
      const invocation = { namespace: 'powerEvolve', method, args: { request: input.request }, peer, signal: abort.signal }
      if (streaming) {
        const iterable = await ctx.typertGateway.stream(invocation)
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
        for await (const item of iterable) await writeLine(res, item, abort.signal)
        res.end()
      } else {
        const result = await ctx.typertGateway.invoke(invocation)
        if (method === 'logout' && credential.fromCookie) browserAuth.clear(res)
        sendJson(res, result)
      }
    } catch (error) { if (!abort.signal.aborted) sendFailure(res, error) }
    finally {
      if (streaming) streams--
      if (peer) { tokens.delete(peer); await peer.dispose() }
    }
  }))
  await writeFile(config.readyFile, JSON.stringify({ pid: process.pid, url: `http://${ctx.webServer.host}:${ctx.webServer.port}`, instanceId }), { mode: 0o600 })
}
