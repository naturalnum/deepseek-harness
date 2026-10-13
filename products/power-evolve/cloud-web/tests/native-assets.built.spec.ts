/** Artifact plane: read the prepared dist and execute its native bootstrap and product factories. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, relative, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import type { DshWindow } from '../../../../packages/client/modules/src/client/manifest.ts'
import type { serveNativeUi as ServeNativeUi } from '../../application/src/ui.ts'

const dist = process.env.PE_NATIVE_WEB_DIST === undefined
  ? fileURLToPath(new URL('../dist/', import.meta.url)) : resolve(process.env.PE_NATIVE_WEB_DIST)
const productIds = ['@power-evolve/client-account', '@power-evolve/client-extension-center'] as const
const platformOrigin = 'https://platform.example.test'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value))
  return value
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function strings(value: unknown): string[] {
  assert(isStrings(value))
  return value
}

async function assetList(): Promise<string[]> {
  const value: unknown = JSON.parse(await readFile(join(dist, 'asset-list.json'), 'utf8'))
  return strings(value)
}

async function clientResources(): Promise<Record<string, string>> {
  const value: unknown = JSON.parse(await readFile(join(dist, 'client-resource-map.json'), 'utf8'))
  return Object.fromEntries(Object.entries(record(value)).map(([url, asset]) => {
    assert.equal(typeof asset, 'string')
    assert(typeof asset === 'string')
    return [url, asset]
  }))
}

async function asset(url: string): Promise<string> {
  const resolved = new URL(url, 'https://host.example.test/native/')
  assert.equal(resolved.origin, 'https://host.example.test', `External static URL: ${url}`)
  assert(resolved.pathname.startsWith('/native/'), `Static URL escaped /native/: ${url}`)
  const resource = resolved.pathname.slice('/native/'.length)
  const name = resource.startsWith('plugins/') ? (await clientResources())[`${resource}${resolved.search}`] : resource
  assert(name, `Missing exact static resource URL: ${url}`)
  assert((await assetList()).includes(name), `Missing allowlisted static asset: ${url}`)
  return await readFile(join(dist, name), 'utf8')
}

async function diskFiles(directory = dist): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await diskFiles(path))
    else { assert(entry.isFile(), `Non-file static artifact: ${path}`); files.push(relative(dist, path).replaceAll('\\', '/')) }
  }
  return files
}

function isNativeServer(value: unknown): value is typeof ServeNativeUi {
  return typeof value === 'function'
}

async function server(t: TestContext, origin: string | undefined = platformOrigin): Promise<{
  base: string
  errors: unknown[]
}> {
  const exports: unknown = await import(new URL('../../application/lib/ui.js', import.meta.url).href)
  const serve = record(exports).serveNativeUi
  assert(isNativeServer(serve), 'Built Host ui.js must export serveNativeUi')
  const errors: unknown[] = []
  const listener = createServer((request, response) => {
    void (async () => {
      try {
        if (!await serve(new URL(request.url ?? '/', 'http://localhost'), response, origin)) {
          response.writeHead(404); response.end()
        }
      } catch (error) { errors.push(error); response.writeHead(500); response.end() }
    })()
  })
  t.after(async () => {
    if (!listener.listening) return
    const closed = new Promise<void>((done, fail) => {
      listener.close((error) => { if (error) fail(error); else done() })
    })
    listener.closeAllConnections()
    await closed
  })
  const ready = once(listener, 'listening')
  listener.listen(0, '127.0.0.1')
  await ready
  const address = listener.address()
  assert(address !== null && typeof address === 'object')
  return { base: `http://127.0.0.1:${address.port}/native/`, errors }
}

interface BootWindow extends DshWindow {
  window?: BootWindow
  __DSH_BOOT_READY__?: { promise: Promise<void> }
}

async function bootstrap(t: TestContext) {
  const dom = new JSDOM(await readFile(join(dist, 'index.html'), 'utf8'), { url: 'https://host.example.test/native/' })
  t.after(() => { dom.window.close() })
  const window: BootWindow = {}
  window.window = window
  const context = createContext(Object.assign(window, { URL, TextEncoder, TextDecoder, AbortController }), {
    codeGeneration: { strings: false, wasm: false },
  })
  const evaluate = (source: string, url: string): void => { runInContext(source, context, { filename: url, timeout: 1000 }) }
  const scripts = [...dom.window.document.querySelectorAll('script')]
  for (const script of scripts.filter(script => script.type !== 'module')) {
    const url = script.getAttribute('src')
    assert(url, 'Native bootstrap scripts must be external')
    evaluate(await asset(url), url)
  }
  assert(window.__ModuleLoader__, 'The HTML must preload the native module loader')
  assert(window.__DSH_BOOT_READY__, 'The HTML must signal native bootstrap readiness')
  await window.__DSH_BOOT_READY__.promise
  return { window, evaluate }
}

async function moduleSystem(t: TestContext, fault?: (url: string, source: string) => string) {
  const boot = await bootstrap(t)
  const target = boot.window.__ModuleLoader__
  assert(target)
  const requests: string[] = []
  // Explicit platform-singleton substitutes: the test materializes factories, without mounting the renderer.
  const system = target.create({ boot: boot.window.__DSH_BOOT__, staticModules: {
    react: {}, 'react/jsx-runtime': {}, '@deepseek-ai/dsh-client-ui-primitives': {},
  }, loadBundle: async (url) => {
    requests.push(url)
    const source = await asset(url)
    boot.evaluate(fault === undefined ? source : fault(url, source), url)
  } })
  return { ...boot, system, requests }
}

function csp(value: string | null): Map<string, string[]> {
  assert(value, 'The built Host must send a CSP')
  return new Map(value.split(';').map((directive) => {
    const [name, ...values] = directive.trim().split(/\s+/u)
    assert(name)
    return [name, values]
  }))
}

await test('the formal static allowlist contains every physical file and only browser assets', async (t) => {
  const allowed = await assetList()
  assert(allowed.length > 0)
  assert.equal(new Set(allowed).size, allowed.length)
  assert.deepEqual([...allowed].sort(), (await diskFiles()).filter(file => file !== 'asset-list.json' && file !== 'client-resource-map.json').sort())
  for (const name of allowed) {
    assert(!name.startsWith('/') && !name.split('/').includes('..'), `Unsafe static path: ${name}`)
    assert(!/\.(?:ts|tsx)$/u.test(name) && !name.startsWith('preview/'), `Non-shipping artifact: ${name}`)
    if (name.startsWith('plugins/')) {
      assert(/^client(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.js$/u.test(name.split('/').at(-1) ?? ''), name)
    }
    assert((await readFile(join(dist, name))).length > 0, `Empty static asset: ${name}`)
  }
  for (const id of productIds) assert(allowed.includes(`plugins/${id}/client.js`), `Missing product factory: ${id}`)
  const manifest: unknown = JSON.parse(await asset('./manifest.webmanifest'))
  const icons = record(manifest).icons
  assert(Array.isArray(icons) && icons.length > 0)
  for (const icon of icons) {
    const src = record(icon).src
    assert.equal(typeof src, 'string')
    assert(typeof src === 'string')
    await asset(src)
  }
  t.diagnostic(JSON.stringify({ dist, assets: allowed.length,
    manifestSha256: createHash('sha256').update(await readFile(join(dist, 'asset-list.json'))).digest('hex') }))
})

await test('the built Host serves the formal HTML and its referenced scripts, styles and icons with native CSP', async (t) => {
  const host = await server(t)
  const response = await fetch(host.base)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.equal(html, await readFile(join(dist, 'index.html'), 'utf8'))
  const policy = csp(response.headers.get('content-security-policy'))
  assert.deepEqual(policy.get('script-src'), ["'self'", "'unsafe-eval'"])
  assert.deepEqual(policy.get('worker-src'), ["'self'", 'blob:'])
  assert.deepEqual(policy.get('connect-src'), ["'self'", platformOrigin])
  assert.deepEqual(policy.get('frame-ancestors'), ["'none'"])
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const dom = new JSDOM(html, { url: host.base })
  t.after(() => { dom.window.close() })
  assert.equal(dom.window.document.title, 'PowerEvolve')
  assert.equal(dom.window.document.querySelectorAll('script:not([src])').length, 0)
  assert.equal(dom.window.document.querySelectorAll('[onclick], [onload], [onerror]').length, 0)
  for (const element of dom.window.document.querySelectorAll('script[src], link[href]')) {
    const url = element.getAttribute('src') ?? element.getAttribute('href')
    assert(url)
    const resolved = new URL(url, host.base)
    assert.equal(resolved.origin, new URL(host.base).origin)
    assert(resolved.pathname.startsWith('/native/'))
    const resource = await fetch(resolved)
    assert.equal(resource.status, 200, `Missing HTML resource: ${url}`)
    assert.deepEqual(Buffer.from(await resource.arrayBuffer()), Buffer.from(await asset(url)))
  }
  assert.deepEqual(host.errors, [])
})

await test('the built Host rejects unknown resources and keeps internal manifests and client maps unserved', async (t) => {
  const host = await server(t)
  for (const path of ['missing.js', 'asset-list.json', 'client-resource-map.json', 'plugins/@power-evolve/client-account/client.js.map', 'lib/host.js']) {
    const response = await fetch(new URL(path, host.base))
    assert.equal(response.status, 404, path)
    assert.equal(await response.text(), '')
  }
  const resources = await clientResources()
  const entry = Object.keys(resources).find(url => url.startsWith(`plugins/??${productIds[0]}/client.js&rev=`))
  const chunk = Object.keys(resources).find(url => url.startsWith('plugins/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client.pdf.js?rev='))
  assert(entry && chunk)
  for (const resource of [entry, chunk]) {
    assert.equal((await fetch(new URL(resource, host.base))).status, 200, resource)
    for (const invalid of [resource.replace(/([?&]rev=)[^&]+$/u, '$1wrong'),
      resource.replace(/[?&]rev=[^&]+$/u, ''), `${resource}&extra=1`]) {
      const response = await fetch(new URL(invalid, host.base))
      assert.equal(response.status, 404, invalid)
      assert.equal(await response.text(), '')
    }
  }
  for (const invalid of [`plugins/${productIds[0]}/client.js`,
    entry.replace('/client.js&', '/missing.js&'), entry.replace('/client.js&', `/client.js,${productIds[1]}/client.js&`),
    chunk.replace('/client.pdf.js?', '/client.missing.js?')]) {
    const response = await fetch(new URL(invalid, host.base))
    assert.equal(response.status, 404, invalid)
    assert.equal(await response.text(), '')
  }
  const redirect = await fetch(host.base.slice(0, -1), { redirect: 'manual' })
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.get('location'), '/native/')
  assert.deepEqual(host.errors, [])
})

await test('an invalid Platform CSP origin fails the actual built static handler', async (t) => {
  const host = await server(t, `${platformOrigin}/not-an-origin`)
  assert.equal((await fetch(host.base)).status, 500)
  assert.equal(host.errors.length, 1)
  assert.match(String(host.errors[0]), /Invalid platform origin/u)
})

await test('the formal native graph registers its full application batch and materializes both product factories without dynamic code', async (t) => {
  const { system, requests, window } = await moduleSystem(t)
  const host = await server(t)
  const registered = new Set<string>()
  const target = window.__ModuleLoader__
  assert(target)
  const load = target.load.bind(target)
  target.load = (registration) => { assert(!registered.has(registration.id)); registered.add(registration.id); load(registration) }
  await Promise.all(system.manifest.modules.map(row => system.prefetch(row.id)))
  assert.equal(requests.length, 1, 'All application rows must share the actual emitted batch')
  assert(requests[0]?.startsWith('./boot/application.'))
  const applicationIds = Array.from(system.manifest.modules).filter(row => row.id !== '@deepseek-ai/dsh-client-modules').map(row => row.id)
  assert.deepEqual([...registered].sort(), applicationIds.sort())
  for (const row of system.manifest.modules) {
    assert.equal(new URL(row.url, 'https://host.example.test/native/').searchParams.get('rev'), row.rev)
    const source = await asset(row.url)
    assert(source.length > 0, `Missing native factory URL: ${row.id}`)
    const response = await fetch(new URL(row.url, host.base))
    assert.equal(response.status, 200, `Unreadable native factory URL: ${row.id}`)
    assert.equal(await response.text(), source, row.id)
  }
  for (const id of productIds) {
    const row = system.manifest.modules.find(row => row.id === id)
    assert(row, `Missing product graph entry: ${id}`)
    assert(row.url.startsWith(`./plugins/??${id}/client.js&rev=`))
    const exports = record(await system.import(id))
    assert.equal(typeof exports.apply, 'function')
    assert(!Object.hasOwn(exports, 'default'))
    assert(strings(exports.inject).includes('slots'))
    const emitted = await readFile(new URL(`../../${id.slice('@power-evolve/'.length)}/lib/client.js`, import.meta.url), 'utf8')
    const deployed = await asset(row.url)
    assert.equal(deployed, emitted, `The formal dist must contain the current emitted ${id} bytes`)
    t.diagnostic(JSON.stringify({ id, url: row.url, sha256: createHash('sha256').update(deployed).digest('hex') }))
  }
  const graph = record(window.__DSH_BOOT__)
  assert(Array.isArray(graph.entries))
  const browser = graph.entries.map(record).find(row => row.id === '@deepseek-ai/dsh-client-ui-sidebar-browser')
  if (browser !== undefined) assert.equal(browser.requiresCarrier, 'desktop-browser')
})

for (const id of productIds) {
  await test(`a missing formal batch and ${id} URL rejects import and records its failure`, async (t) => {
    const boot = await moduleSystem(t, (url, source) => {
      if (url.startsWith('./boot/application.') || url.startsWith(`./plugins/??${id}/client.js&`)) {
        throw new Error(`HTTP 404 for ${url}`)
      }
      return source
    })
    await assert.rejects(boot.system.import(id), /HTTP 404/u)
    assert.match(boot.system.importError(id)?.message ?? '', /HTTP 404/u)
    assert(!boot.system.loadCache.has(id))
    assert(boot.requests.some(url => url.startsWith(`./plugins/??${id}/client.js&`)))
  })
}

await test('a failed batch falls back to the actual individual factory URL', async (t) => {
  const boot = await moduleSystem(t, (url, source) => {
    if (url.startsWith('./boot/application.')) throw new Error(`HTTP 503 for ${url}`)
    return source
  })
  const exports = record(await boot.system.import(productIds[0]))
  assert.equal(typeof exports.apply, 'function')
  assert(boot.requests.some(url => url.startsWith('./plugins/??@power-evolve/client-account/client.js&rev=')))
  assert.equal(boot.system.importError('@power-evolve/client-account'), undefined)
})

await test('a syntax error in actual factory transport bytes rejects import instead of admitting empty exports', async (t) => {
  const id = '@power-evolve/client-extension-center'
  const boot = await moduleSystem(t, (url, source) => url.startsWith('./boot/application.')
    || url.startsWith(`./plugins/??${id}/client.js&`) ? `${source}\n}` : source)
  await assert.rejects(boot.system.import(id), /Unexpected token/u)
  assert.match(boot.system.importError(id)?.message ?? '', /Unexpected token/u)
  assert(!boot.system.loadCache.has(id))
})

await test('the emitted native loader refuses a missing boot manifest and an unbatched product row', async (t) => {
  const boot = await bootstrap(t)
  const target = boot.window.__ModuleLoader__
  assert(target)
  assert.throws(() => target.create({ boot: undefined, staticModules: {} }), /__DSH_BOOT__.*missing/u)
  const unbatched = await bootstrap(t)
  const unbatchedTarget = unbatched.window.__ModuleLoader__
  assert(unbatchedTarget)
  const graph = record(unbatched.window.__DSH_BOOT__)
  assert(Array.isArray(graph.entries))
  const entries: unknown[] = graph.entries
  const product = entries.map(record).find(row => row.id === productIds[0])
  assert(product)
  assert.throws(() => unbatchedTarget.create({ boot: { ...graph, entries: [...entries,
    { ...product, id: '@power-evolve/unbatched-product' }] }, staticModules: {} }), /belongs to no initial-load batch/u)
})
