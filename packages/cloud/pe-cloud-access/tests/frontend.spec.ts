/** Real Loader and HTTP coverage for the public login document; no authentication service is substituted. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it, vi } from 'vitest'
import * as Frontend from '../src/frontend.ts'

let ctx: Context | undefined
let directory: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  vi.restoreAllMocks()
})

async function composition(): Promise<Context> {
  directory = await mkdtemp(join(tmpdir(), 'dsh-cloud-public-frontend-'))
  const dist = join(directory, 'dist')
  await mkdir(dist)
  await mkdir(join(dist, 'empty'))
  await writeFile(join(dist, 'index.html'), '<head></head><body>public login</body>')
  await writeFile(join(dist, 'app.js'), 'export {}')
  await writeFile(join(dist, 'other.bin'), 'BLOB')
  await writeFile(join(directory, 'private.txt'), 'private fixture')
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'cordis:webServer'",
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- id: frontend',
    "  name: 'cordis:frontend'",
    '  config:',
    `    distIndex: ${JSON.stringify(join(dist, 'index.html'))}`,
    '',
  ].join('\n'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.webServer = WebServer
  ctx.loader.builtins.frontend = Frontend
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await entry(ctx, 'frontend').fiber?.await()
  return ctx
}

function entry(context: Context, id: string) {
  const result = [...context.loader.entries()].find(row => row.options.id === id)
  if (result === undefined) throw new Error('Fixture entry is missing')
  return result
}

function address(context: Context, path: string): string {
  if (context.webServer.port === undefined) throw new Error('Fixture listener is not ready')
  return `http://127.0.0.1:${String(context.webServer.port)}${path}`
}

it('serves only public files with the original index transforms and HTTP errors, without native Connection', async () => {
  const context = await composition()
  expect(context.get('connection')).toBeUndefined()
  context.on('webserver/index-inject', (rows) => { rows.push({ kind: 'script-preload', src: 'plugins/boot.js' }) })
  context.webServer.tapIndex(html => html.replace('<head>', '<head><script>window.PUBLIC_MARK=1</script>'))
  for (const path of ['/', '/index.html', '/?view=test']) {
    const response = await fetch(address(context, path)), body = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(body).toContain('public login')
    expect(body.match(/<base\b/g)).toHaveLength(1)
    expect(body.indexOf('<base href="./">')).toBeLessThan(body.indexOf('plugins/boot.js'))
    expect(body).toContain('window.PUBLIC_MARK=1')
  }
  for (const [path, status] of [['/missing', 404], ['/empty', 404], ['/..%2fprivate.txt', 403], ['/bad%00path', 400]] as const) {
    const response = await fetch(address(context, path))
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain('private fixture')
  }
  const asset = await fetch(address(context, '/app.js'))
  expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(await asset.text()).toBe('export {}')
  const binary = await fetch(address(context, '/other.bin'))
  expect(binary.headers.get('content-type')).toBe('application/octet-stream')
  expect(await binary.text()).toBe('BLOB')
  const head = await fetch(address(context, '/index.html'), { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  expect((await fetch(address(context, '/app.js'), { method: 'POST' })).status).toBe(405)
  expect((await fetch(address(context, '/api/session/list'))).status).toBe(404)
})

it('leaves named business handlers in control and releases only its own fallback on withdrawal', async () => {
  const context = await composition()
  context.effect(() => context.webServer.register({ kind: 'exact', path: '/cloud/bootstrap', handler: (_req, res) => {
    res.writeHead(401); res.end('authentication required')
  } }))
  for (const method of ['GET', 'POST']) {
    const response = await fetch(address(context, '/cloud/bootstrap'), { method })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('authentication required')
  }
  await entry(context, 'frontend').fiber?.dispose()
  expect((await fetch(address(context, '/'))).status).toBe(404)
  expect((await fetch(address(context, '/cloud/bootstrap'))).status).toBe(401)
  const remove = context.webServer.registerFallback((_req, res) => { res.end('replacement') })
  expect(await (await fetch(address(context, '/'))).text()).toBe('replacement')
  remove()
})

it('rejects a relative distribution and a duplicate fallback without replacing the original owner', async () => {
  const context = await composition()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const [distIndex, diagnostic] of [
    ['dist/index.html', 'absolute public distIndex'],
    [join(directory!, 'dist', 'index.html'), 'fallback'],
  ] as const) {
    const created = await context.loader.create({ name: 'cordis:frontend', config: { distIndex } })
    await context.loader.await()
    const fiber = context.loader.resolve(created).fiber
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow(diagnostic)
    expect((await fetch(address(context, '/'))).status).toBe(200)
  }
})
