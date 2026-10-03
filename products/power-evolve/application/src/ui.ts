/** Static product UI served from an explicit allowlist with a same-origin CSP. */
import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDist = process.env.PE_NATIVE_WEB_DIST
  ? resolve(process.env.PE_NATIVE_WEB_DIST)
  : fileURLToPath(new URL('../../cloud-web/dist/', import.meta.url))
const nativeMime: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png',
}

/** Serve the built upstream DSH shell from an isolated route while the native client transport is integrated.
 * @param path - URL pathname without query parameters.
 * @param response - HTTP response owned by the Host.
 * @returns whether the native-shell route matched.
 */
export async function serveNativeUi(path: string, response: ServerResponse, platformOrigin?: string): Promise<boolean> {
  if (path === '/native') {
    response.writeHead(308, { location: '/native/' })
    response.end()
    return true
  }
  if (!path.startsWith('/native/')) return false
  const asset = path.slice('/native/'.length) || 'index.html'
  const allowed = JSON.parse(await readFile(join(nativeDist, 'asset-list.json'), 'utf8')) as string[]
  if (!allowed.includes(asset)) {
    response.writeHead(404)
    response.end()
    return true
  }
  const extension = asset.slice(asset.lastIndexOf('.'))
  const body = await readFile(join(nativeDist, asset))
  const platform = platformOrigin === undefined ? undefined : new URL(platformOrigin)
  if (platform && (platform.origin !== platformOrigin || platform.username || platform.password)) {
    throw new Error('Invalid platform origin for native Web CSP')
  }
  response.writeHead(200, {
    'content-type': `${nativeMime[extension] ?? 'application/octet-stream'}; charset=utf-8`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'${platform ? ` ${platform.origin}` : ''}; img-src 'self' data: blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  })
  response.end(body)
  return true
}

/** Serve a known UI asset without resolving user-controlled filesystem paths.
 * @param path - decoded URL pathname.
 * @param application - login, conversation, or local device surface.
 * @param response - HTTP response owned by the caller.
 * @param loginHostOrigin - exact Host origin permitted for the trusted login exchange.
 * @returns whether an asset matched.
 */
export async function serveUi(path: string, application: 'login' | 'client' | 'device', response: ServerResponse,
  loginHostOrigin?: string): Promise<boolean> {
  const assets: Record<string, [string, string, URL?]> = {
    '/': [`${application}.html`, 'text/html'],
    '/login': ['login.html', 'text/html'],
    '/approval': ['approval.html', 'text/html'],
    '/approval.js': ['approval.js', 'text/javascript'],
    '/execution-resolution.js': ['execution-resolution.js', 'text/javascript'],
    '/execution-resolution-contract.js': ['execution-resolution-contract.js', 'text/javascript',
      new URL('../../contracts/lib/browser/execution-resolution.js', import.meta.url)],
    '/app.js': [`${application}.js`, 'text/javascript'],
    '/locale.js': ['locale.js', 'text/javascript'],
    '/workspace.js': ['workspace.js', 'text/javascript'],
    '/style.css': ['style.css', 'text/css'],
  }
  const asset = assets[path]
  if (!asset || (['/login', '/approval', '/approval.js', '/execution-resolution.js',
    '/execution-resolution-contract.js'].includes(path) && application !== 'login')) return false
  const connectSource = application === 'login' && loginHostOrigin
    ? `'self' ${new URL(loginHostOrigin).origin}` : "'self'"
  response.writeHead(200, {
    'content-type': `${asset[1]}; charset=utf-8`, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; connect-src ${connectSource}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  })
  response.end(await readFile(asset[2] ?? new URL(`../web/${asset[0]}`, import.meta.url)))
  return true
}
