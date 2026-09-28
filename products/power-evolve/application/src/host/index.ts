/** Authenticated product RPC carrier over the native Typert Gateway. */
import { randomUUID } from 'node:crypto'
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
import { createRequest, filesListRequest, fileReadRequest, filePutRequest, listRequest, pageRequest, promptRequest, skillInstallRequest, skillRequest, skillToggleRequest, PlatformError } from '../contracts.ts'
import { readJson, sendFailure, sendJson, writeLine } from '../http.ts'
import { serveNativeUi, serveUi } from '../ui.ts'
import { BrowserAgentAuth } from './browser-auth.ts'
import { Scheduler } from './scheduler.ts'

const requests = { me: z.object({}).strict(), logout: z.object({}).strict(), create: createRequest, list: listRequest, prompt: promptRequest, page: pageRequest, follow: pageRequest,
  filesList: filesListRequest, fileRead: fileReadRequest, filePut: filePutRequest, skillsList: z.object({}).strict(), skillsRead: skillRequest,
  skillsInstall: skillInstallRequest, skillsToggle: skillToggleRequest, actionsList: z.object({}).strict(),
  executionsList: z.object({}).strict(), executionCancel: z.object({ executionId: z.uuid() }).strict(),
  devicesList: z.object({}).strict(), devicesPair: z.object({}).strict(),
  devicesRevoke: z.object({ deviceId: z.uuid() }).strict(),
  directoriesRevoke: z.object({ directoryId: z.uuid() }).strict() }
const endpoint = { me: '/identity/me', logout: '/identity/logout', create: '/sessions/create', list: '/sessions/list', prompt: '/sessions/prompt', page: '/sessions/page',
  filesList: '/files/list', fileRead: '/files/read', filePut: '/files/put', skillsList: '/skills/list', skillsRead: '/skills/read',
  skillsInstall: '/skills/install', skillsToggle: '/skills/toggle', actionsList: '/connectors/actions',
  executionsList: '/executions/list', executionCancel: '/executions/cancel',
  devicesList: '/devices/list', devicesPair: '/devices/pair',
  devicesRevoke: '/devices/revoke', directoriesRevoke: '/devices/directories/revoke' } as const
type Method = keyof typeof requests

declare module '@deepseek-ai/cordis' { interface Context { powerEvolve: ProductRemote; powerEvolveBrowserAuth: BrowserAgentAuth } }

class ProductRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly options: { tokens: WeakMap<PeerScope, string>; pollMs: number }) { super(ctx, 'powerEvolve') }
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
  @Remote create(request: z.infer<typeof createRequest>) { return this.call('create', request) }
  @Remote list(request: z.infer<typeof listRequest>) { return this.call('list', request) }
  @Remote prompt(request: z.infer<typeof promptRequest>) { return this.call('prompt', request) }
  @Remote page(request: z.infer<typeof pageRequest>) { return this.call('page', request) }
  @Remote filesList(request: z.infer<typeof filesListRequest>) { return this.call('filesList', request) }
  @Remote fileRead(request: z.infer<typeof fileReadRequest>) { return this.call('fileRead', request) }
  @Remote filePut(request: z.infer<typeof filePutRequest>) { return this.call('filePut', request) }
  @Remote skillsList(request: z.infer<typeof requests.skillsList>) { return this.call('skillsList', request) }
  @Remote skillsRead(request: z.infer<typeof skillRequest>) { return this.call('skillsRead', request) }
  @Remote skillsInstall(request: z.infer<typeof skillInstallRequest>) { return this.call('skillsInstall', request) }
  @Remote skillsToggle(request: z.infer<typeof skillToggleRequest>) { return this.call('skillsToggle', request) }
  @Remote actionsList(request: z.infer<typeof requests.actionsList>) { return this.call('actionsList', request) }
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
  const tokens = new WeakMap<PeerScope, string>()
  ctx.plugin(ProductRemote, { tokens, pollMs: config.pollMs })
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
      if (req.method === 'GET' && await serveNativeUi(path, res)) return
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
