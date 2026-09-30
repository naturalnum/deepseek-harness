/** Account-package assets served only by the trusted Platform origin. */
import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { z } from 'zod'

const mime: Readonly<Record<string, string>> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2',
}
const assetPath = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u).refine(value =>
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  && Object.hasOwn(mime, extname(value)))
const manifest = z.array(assetPath).refine(paths => paths.includes('index.html')
  && new Set(paths).size === paths.length)

/** Serve a listed account asset; unknown account paths return 404 without a filesystem lookup.
 * @param path - URL pathname received by the trusted Platform.
 * @param response - response owned by the Platform request.
 * @param directory - installed account package's trusted asset directory.
 * @returns whether this request belongs to the account UI.
 */
export async function serveTrustedAccountUi(path: string, response: ServerResponse,
  directory: string): Promise<boolean> {
  if (path !== '/account' && !path.startsWith('/account/')) return false
  const asset = path === '/account' || path === '/account/' ? 'index.html' : path.slice('/account/'.length)
  const assets = manifest.safeParse(JSON.parse(await readFile(join(directory, 'asset-list.json'), 'utf8')))
  if (!assets.success) throw new Error('Invalid trusted account asset manifest')
  if (!assets.data.includes(asset)) {
    response.writeHead(404, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    response.end()
    return true
  }
  const bytes = await readFile(join(directory, asset))
  response.writeHead(200, {
    'content-type': mime[extname(asset)]!, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  })
  response.end(bytes)
  return true
}
