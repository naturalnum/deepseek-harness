/** Source-only HTTP verifies native client resource admission using owned static fixtures. */
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'

const owner = '@power-evolve/source-ui-fixture'
const revision = '0123456789abcdef'
const entryAsset = `plugins/${owner}/client.js`
const chunkAsset = `plugins/${owner}/client.pdf.js`
const entryResource = `plugins/??${owner}/client.js&rev=${revision}`
const chunkResource = `plugins/${owner}/client.pdf.js?rev=${revision}`
const routes = { [entryResource]: entryAsset, [chunkResource]: chunkAsset }
const files = new Map([
  ['index.html', Buffer.from('<!doctype html><title>owned native source fixture</title>')],
  ['style.css', Buffer.from('body { color: black; }')],
  ['assets/owned-font.ttf', Buffer.from([0, 1, 0, 0, 65, 66])],
  [entryAsset, Buffer.from('owned entry bytes; these fixtures never execute a module factory')],
  [chunkAsset, Buffer.from('owned chunk bytes; these fixtures never execute a PDF renderer')],
])

interface NativeFixture {
  directory: string
  origin: string
  errors: unknown[]
}

async function nativeAssets<T>(run: (fixture: NativeFixture) => Promise<T>, options: {
  platformOrigin?: string
  useDefaultNativeDist?: boolean
  application?: 'login'
  loginHostOrigin?: string
} = {}): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'pe-native-ui-source-'))
  vi.stubEnv('PE_NATIVE_WEB_DIST', options.useDefaultNativeDist ? undefined : directory)
  vi.resetModules()
  let close: (() => Promise<void>) | undefined
  try {
    for (const [asset, bytes] of files) {
      await mkdir(dirname(join(directory, asset)), { recursive: true })
      await writeFile(join(directory, asset), bytes)
    }
    await writeFile(join(directory, 'asset-list.json'), JSON.stringify([...files.keys()]))
    await writeFile(join(directory, 'client-resource-map.json'), JSON.stringify(routes))
    const { serveNativeUi, serveUi } = await import('../src/ui.ts')
    const errors: unknown[] = []
    const listener = createServer((request, response) => {
      void (async () => {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const served = options.application === 'login'
            ? await serveUi(url.pathname, options.application, response, options.loginHostOrigin)
            : await serveNativeUi(url, response, options.platformOrigin)
          if (!served) {
            response.writeHead(404, { 'x-owned-fallback': '1' })
            response.end()
          }
        } catch (error) {
          errors.push(error)
          response.writeHead(500)
          response.end()
        }
      })()
    })
    close = async () => {
      if (!listener.listening) return
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => { if (error) reject(error); else resolve() })
        listener.closeAllConnections()
      })
    }
    const ready = once(listener, 'listening')
    listener.listen(0, '127.0.0.1')
    await ready
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Expected owned HTTP listener')
    return await run({ directory, origin: `http://127.0.0.1:${address.port}`, errors })
  } finally {
    try { await close?.() } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

async function denied(origin: string, resource: string): Promise<void> {
  const response = await fetch(`${origin}/native/${resource}`)
  expect(response.status).toBe(404)
  expect(response.headers.get('x-owned-fallback')).toBeNull()
  expect(await response.text()).toBe('')
}

test('native entry and current-revision chunk URLs serve only their exact listed bytes with the native CSP', () =>
  nativeAssets(async ({ origin, errors }) => {
    for (const [resource, asset, mime] of [
      ['', 'index.html', 'text/html'], ['index.html', 'index.html', 'text/html'],
      ['style.css', 'style.css', 'text/css'],
      ['assets/owned-font.ttf', 'assets/owned-font.ttf', 'application/octet-stream'],
      [entryResource, entryAsset, 'text/javascript'], [chunkResource, chunkAsset, 'text/javascript'],
    ] as const) {
      const response = await fetch(`${origin}/native/${resource}`)
      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(files.get(asset))
      expect(response.headers.get('content-type')).toBe(`${mime}; charset=utf-8`)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'self' https://platform.example.test;")
      expect(response.headers.get('content-security-policy')).toContain("worker-src 'self' blob:;")
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none';")
    }
    const redirect = await fetch(`${origin}/native`, { redirect: 'manual' })
    expect(redirect.status).toBe(308)
    expect(redirect.headers.get('location')).toBe('/native/')
    expect(await redirect.text()).toBe('')
    const unrelated = await fetch(`${origin}/unrelated`)
    expect(unrelated.status).toBe(404)
    expect(unrelated.headers.get('x-owned-fallback')).toBe('1')
    expect(await unrelated.text()).toBe('')
    expect(errors).toEqual([])
  }, { platformOrigin: 'https://platform.example.test' }))

test('missing or changed revisions, undeclared resources and internal tables never admit native client bytes', () =>
  nativeAssets(async ({ origin, errors }) => {
    for (const resource of [
      'asset-list.json', 'client-resource-map.json', 'missing.js',
      entryAsset, chunkAsset, `${entryAsset}.map?rev=${revision}`, `${chunkAsset}.map?rev=${revision}`,
      entryResource.replace(/&rev=[^&]+$/u, ''), chunkResource.replace(/\?rev=[^&]+$/u, ''),
      entryResource.replace(revision, 'wrong'), chunkResource.replace(revision, 'wrong'),
      `${entryResource}&extra=1`, `${chunkResource}&extra=1`,
      `${entryResource}&rev=${revision}`, `${chunkResource}&rev=${revision}`,
      entryResource.replace(owner, '@power-evolve/unknown'),
      chunkResource.replace('client.pdf.js', 'client.missing.js'),
      entryResource.replace('/client.js&', `/client.js,${owner}/client.js&`),
      'plugins/%2e%2e%2fasset-list.json',
    ]) await denied(origin, resource)
    expect(errors).toEqual([])
  }))

test('a route-table hit cannot expose an existing file absent from the physical allowlist', () =>
  nativeAssets(async ({ directory, origin, errors }) => {
    await writeFile(join(directory, 'private.js'), 'private fixture bytes')
    await writeFile(join(directory, 'client-resource-map.json'), JSON.stringify({ ...routes,
      [`plugins/??${owner}/private.js&rev=${revision}`]: 'private.js',
    }))
    await denied(origin, `plugins/??${owner}/private.js&rev=${revision}`)
    await denied(origin, 'private.js')
    const response = await fetch(`${origin}/native/${chunkResource}`)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(files.get(chunkAsset))
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self';")
    expect(errors).toEqual([])
  }))

test('broken route metadata and missing admitted bytes fail without serving an entry-page fallback', () =>
  nativeAssets(async ({ directory, origin, errors }) => {
    await rm(join(directory, 'client-resource-map.json'))
    const missingMap = await fetch(`${origin}/native/${entryResource}`)
    expect(missingMap.status).toBe(500)
    expect(await missingMap.text()).toBe('')
    expect(missingMap.headers.get('x-owned-fallback')).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'ENOENT' })
    await writeFile(join(directory, 'client-resource-map.json'), JSON.stringify(routes))
    await writeFile(join(directory, 'client-resource-map.json'), '{')
    const broken = await fetch(`${origin}/native/${entryResource}`)
    expect(broken.status).toBe(500)
    expect(await broken.text()).toBe('')
    expect(errors).toHaveLength(2)
    expect(errors[1]).toBeInstanceOf(SyntaxError)
    const html = await fetch(`${origin}/native/`)
    expect(html.status).toBe(200)
    expect(Buffer.from(await html.arrayBuffer())).toEqual(files.get('index.html'))
    await writeFile(join(directory, 'client-resource-map.json'), JSON.stringify(routes))
    await rm(join(directory, chunkAsset))
    const missing = await fetch(`${origin}/native/${chunkResource}`)
    expect(missing.status).toBe(500)
    expect(await missing.text()).toBe('')
    expect(errors).toHaveLength(3)
    expect(errors[2]).toMatchObject({ code: 'ENOENT' })
  }))

test('a Platform URL with a path cannot broaden the native CSP origin', () =>
  nativeAssets(async ({ origin, errors }) => {
    const response = await fetch(`${origin}/native/${entryResource}`)
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('')
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ message: 'Invalid platform origin for native Web CSP' })
  }, { platformOrigin: 'https://platform.example.test/not-an-origin' }))

test('the default native mount redirects and delegates unrelated routes without reading prepared assets', () =>
  nativeAssets(async ({ origin, errors }) => {
    const redirect = await fetch(`${origin}/native`, { redirect: 'manual' })
    expect(redirect.status).toBe(308)
    expect(redirect.headers.get('location')).toBe('/native/')
    expect(await redirect.text()).toBe('')
    const unrelated = await fetch(`${origin}/unrelated`)
    expect(unrelated.status).toBe(404)
    expect(unrelated.headers.get('x-owned-fallback')).toBe('1')
    expect(await unrelated.text()).toBe('')
    expect(errors).toEqual([])
  }, { useDefaultNativeDist: true }))

test('source login and approval assets retain their bytes and admit only the configured Host CSP origin', async () => {
  for (const loginHostOrigin of [undefined, 'https://host.example.test']) {
    await nativeAssets(async ({ origin, errors }) => {
      for (const [path, file, mime] of [
        ['/', 'login.html', 'text/html'], ['/login', 'login.html', 'text/html'],
        ['/approval', 'approval.html', 'text/html'], ['/approval.js', 'approval.js', 'text/javascript'],
        ['/stdio-v2-approval.js', 'stdio-v2-approval.js', 'text/javascript'],
        ['/execution-resolution.js', 'execution-resolution.js', 'text/javascript'],
        ['/app.js', 'login.js', 'text/javascript'], ['/locale.js', 'locale.js', 'text/javascript'],
        ['/style.css', 'style.css', 'text/css'],
      ] as const) {
        const response = await fetch(origin + path)
        expect(response.status).toBe(200)
        expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(new URL(`../web/${file}`, import.meta.url)))
        expect(response.headers.get('content-type')).toBe(`${mime}; charset=utf-8`)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('referrer-policy')).toBe(path === '/' || path === '/login' ? 'strict-origin' : 'no-referrer')
        expect(response.headers.get('content-security-policy')).toContain(loginHostOrigin === undefined
          ? "connect-src 'self';" : `connect-src 'self' ${loginHostOrigin};`)
        expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'; base-uri 'none';")
      }
      const unknown = await fetch(`${origin}/unlisted.js`)
      expect(unknown.status).toBe(404)
      expect(unknown.headers.get('x-owned-fallback')).toBe('1')
      expect(await unknown.text()).toBe('')
      expect(errors).toEqual([])
    }, { application: 'login', ...(loginHostOrigin === undefined ? {} : { loginHostOrigin }) })
  }
})
