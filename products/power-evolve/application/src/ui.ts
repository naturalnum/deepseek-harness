/** Static product UI served from an explicit allowlist with a same-origin CSP. */
import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'

/** Serve a known UI asset without resolving user-controlled filesystem paths.
 * @param path - decoded URL pathname.
 * @param application - login or conversation surface.
 * @param response - HTTP response owned by the caller.
 * @returns whether an asset matched.
 */
export async function serveUi(path: string, application: 'login' | 'client', response: ServerResponse): Promise<boolean> {
  const assets: Record<string, [string, string]> = {
    '/': [`${application}.html`, 'text/html'],
    '/login': ['login.html', 'text/html'],
    '/app.js': [`${application}.js`, 'text/javascript'],
    '/locale.js': ['locale.js', 'text/javascript'],
    '/workspace.js': ['workspace.js', 'text/javascript'],
    '/style.css': ['style.css', 'text/css'],
  }
  const asset = assets[path]
  if (!asset || (path === '/login' && application !== 'login')) return false
  response.writeHead(200, {
    'content-type': `${asset[1]}; charset=utf-8`, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  })
  response.end(await readFile(new URL(`../web/${asset[0]}`, import.meta.url)))
  return true
}
