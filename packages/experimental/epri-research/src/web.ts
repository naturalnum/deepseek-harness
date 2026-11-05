/** Public research assets and explicit browser package supply on the shared Web root. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-modules'

export const name = 'epri-research/web'
export const inject = ['webServer', 'clientModules']
/** Public built assets and browser request bounds; no account data or credentials. */
export interface Config {
  assetsRoot: string
  requestTimeoutMs: number
  maxPendingRequests: number
}
export const Config: z<Config> = z.object({ assetsRoot: z.string().required(),
  requestTimeoutMs: z.number().min(1).required(), maxPendingRequests: z.number().min(1).required() })

/** Register public assets only; all business operations use the platform's account-bound Remote.
 * @param ctx Shared Web root's original Loader scope.
 * @param config Built public directory and finite browser budgets.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.assetsRoot) || !Number.isSafeInteger(config.requestTimeoutMs)
    || config.requestTimeoutMs > 2147483647 || !Number.isSafeInteger(config.maxPendingRequests)) throw new Error('Research Web inputs are invalid.')
  const baseUrl = ctx.fiber.entry?.parent.tree.ctx.baseUrl
  if (baseUrl === undefined) throw new Error('Research Web requires its original Loader resolution base.')
  const publicConfig = { cloud: true, platformIdentity: true, harnessUrl: '/', workbenchUrl: '/research/',
    requestTimeoutMs: config.requestTimeoutMs, maxPendingRequests: config.maxPendingRequests }
  ctx.effect(() => ctx.clientModules.registerClientPackages(
    ['@deepseek-ai/dsh-experimental-epri-research', 'deepscientist-harness-suite'], baseUrl, { activate: true },
  ), 'epri-research: explicit account browser modules')
  ctx.on('webserver/index-inject', rows => rows.push({ kind: 'global', name: '__DS_RESEARCH_PUBLIC__', value: publicConfig }))
  const assets = new Map([
    ['/research/', ['index.html', 'text/html; charset=utf-8']],
    ['/research/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/research/app.css', ['app.css', 'text/css; charset=utf-8']],
  ])
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/research', async handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://research.invalid')
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    if (url.pathname === '/research') { res.writeHead(308, { Location: '/research/' + url.search }); res.end(); return }
    let body: string | Buffer, contentType: string
    if (url.pathname === '/research/public-config.js') {
      contentType = 'text/javascript; charset=utf-8'
      body = 'window.__DS_RESEARCH_PUBLIC__=' + JSON.stringify(publicConfig).replaceAll('<', '\\u003c') + ';'
    } else {
      const asset = assets.get(url.pathname)
      if (asset === undefined) { res.writeHead(404); res.end(); return }
      const [file, type] = asset
      if (file === undefined || type === undefined) throw new Error('Research asset declaration is incomplete.')
      contentType = type
      body = await readFile(join(config.assetsRoot, file))
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-ancestors 'self'" })
    res.end(body)
  } }), 'epri-research: public workbench assets')
}
