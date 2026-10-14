/** Tenant HTTP admission is ready before its original Web server begins listening. */
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BrowserAgentAuth } from './browser-auth.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { nativeRuntimeUiAdmission: NativeRuntimeUiAdmission }
}

const bootDefaults = { maxBootBytes: 16_777_216, maxBootResources: 128 }
const bootLimits = z.object({ maxBootBytes: z.number().int().min(1024).default(bootDefaults.maxBootBytes),
  maxBootResources: z.number().int().min(1).default(bootDefaults.maxBootResources) })
/** Exact deployment origins and bounded verbatim boot scripts; credentials remain in the original RuntimeScope. */
export const Config = schema.object({ origin: schema.string().required(), platformOrigin: schema.string().required(),
  maxBootBytes: schema.number().step(1).min(1024).default(bootDefaults.maxBootBytes),
  maxBootResources: schema.number().step(1).min(1).default(bootDefaults.maxBootResources) })
/** Validated origins for tenant HTTP admission. */
export type Config = ReturnType<typeof Config>

/** The original Runtime and browser credentials fence every original tenant HTTP and upgrade route. */
export default class NativeRuntimeUiAdmission extends Service {
  static inject = ['powerEvolveRuntime']
  static Config = Config
  private readonly ownerFiber
  private readonly auth: BrowserAgentAuth
  private readonly pending = new Set<Promise<boolean>>()
  private readonly scripts = new Map<string, Buffer>()
  private readonly limits: z.infer<typeof bootLimits>
  private documentReady = false
  private closing = false
  private closePromise: Promise<void> | undefined

  constructor(private readonly owner: Context, config: Config) {
    super(owner, 'nativeRuntimeUiAdmission')
    this.ownerFiber = owner.fiber
    this.limits = bootLimits.parse(config)
    const runtime = owner.powerEvolveRuntime
    if (runtime.config.runtimeUserId === '') throw new Error('Tenant HTTP admission requires an account Runtime')
    this.auth = new BrowserAgentAuth(config.origin, config.platformOrigin, runtime,
      runtime.config.runtimeUserId, token => runtime.verifyBroker(token))
    owner.inject(['webServer', 'connection'], (ui) => {
      const require = createRequire(import.meta.url)
      const index = join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
      ui.effect(() => ui.webServer.register({ kind: 'exact', path: '/native/runtime/document', handler: async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
        if (new URL(request.url ?? '/', 'http://tenant').search) { response.writeHead(400); response.end(); return }
        const html = this.externalize(ui.webServer.renderIndex(await readFile(index, 'utf8')))
          .replace(/<head(?:\s[^>]*)?>/iu, open => `${open}<base href="./">`)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(request.method === 'HEAD' ? undefined : html)
      } }))
      ui.effect(() => ui.webServer.register({ kind: 'prefix', path: '/boot', handler: (request, response) => {
        const target = new URL(request.url ?? '/', 'http://tenant')
        const body = this.scripts.get(target.pathname)
        if ((request.method !== 'GET' && request.method !== 'HEAD') || target.search || body === undefined) {
          response.writeHead(404); response.end(); return
        }
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        response.end(request.method === 'HEAD' ? undefined : body)
      } }))
      this.documentReady = true
      ui.effect(() => () => { this.documentReady = false })
    })
    owner.effect(() => () => this.shutdown())
  }

  /** Whether the original tenant document renderer has joined its required services. */
  get available(): boolean { return this.documentReady && !this.isClosing() }

  private externalize(input: string): string {
    const wanted = new Map<string, Buffer>()
    const html = input.replace(/<script>([\s\S]*?)<\/script>/gu, (_whole, source: string) => {
      const target = `/boot/inline.${createHash('sha256').update(source).digest('hex').slice(0, 16)}.js`
      const body = Buffer.from(source)
      const previous = this.scripts.get(target)
      if (previous && !previous.equals(body)) throw new Error('Native boot content identity collision')
      wanted.set(target, body)
      return `<script src=".${target}"></script>`
    })
    const size = (entries: Iterable<Buffer>): number => [...entries].reduce((sum, body) => sum + body.byteLength, 0)
    if (wanted.size > this.limits.maxBootResources || size(wanted.values()) > this.limits.maxBootBytes) {
      throw new Error('Native boot resources exceed the configured budget')
    }
    for (const [target, body] of wanted) { this.scripts.delete(target); this.scripts.set(target, body) }
    for (const target of this.scripts.keys()) {
      if (this.scripts.size <= this.limits.maxBootResources && size(this.scripts.values()) <= this.limits.maxBootBytes) break
      if (!wanted.has(target)) this.scripts.delete(target)
    }
    return html.replaceAll('href="/manifest.webmanifest"', 'href="./manifest.webmanifest"')
      .replaceAll('href="/favicon-dark.svg"', 'href="./favicon-dark.svg"')
      .replaceAll('href="/favicon.svg"', 'href="./favicon.svg"')
      .replace(/<title>[^<]*<\/title>/u, '<title>PowerEvolve</title>')
  }

  private isClosing(): boolean {
    return this.closing || this.ownerFiber.state === FiberState.UNLOADING || this.ownerFiber.state === FiberState.DISPOSED
  }

  /** Admit original HTTP or upgrades only after both original credentials identify this account.
   * @param request Actual tenant request; public readiness retains its existing Runtime-only credential boundary.
   * @returns Admission before any original route receives the request.
   */
  readonly admit = (request: IncomingMessage): Promise<boolean> => {
    if (this.isClosing()) return Promise.resolve(false)
    const work = (async () => {
      try {
        const path = new URL(request.url ?? '/', 'http://tenant').pathname
        if (path === '/api' || path.startsWith('/api/')) return false
        if (path === '/health' || path === '/native/runtime/ready') {
          const token = request.headers['x-power-evolve-runner-token']
          await this.owner.powerEvolveRuntime.verifyBroker(typeof token === 'string' ? token : undefined)
        } else await this.auth.authenticate(request, true)
        return !this.isClosing()
      } catch { return false }
    })().finally(() => { this.pending.delete(work) })
    this.pending.add(work)
    return work
  }

  /** Stop admission and join every accepted credential check before the owning services are disposed.
   * @returns Cached shutdown of this admission owner.
   */
  shutdown(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closing = true
      await Promise.all([...this.pending])
    })()
  }
}
