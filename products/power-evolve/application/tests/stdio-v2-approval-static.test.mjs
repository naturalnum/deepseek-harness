/** Actual serveUi over isolated HTTP with shipped module bytes; no App or approval/backend service is started. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceModule = process.env.PE_STDIO_APPROVAL_UI_MODULE ?? fileURLToPath(new URL('../lib/ui.js', import.meta.url))
const contractAsset = process.env.PE_STDIO_APPROVAL_CONTRACT_ASSET
  ?? fileURLToPath(new URL('../../contracts/lib/browser/execution-resolution.js', import.meta.url))
const hostOrigin = 'https://host.fixture.invalid'

test('Platform serves the complete approval import closure with CSP; Host/Device cannot serve approval modules', async t => {
  assert(isAbsolute(sourceModule)); assert(isAbsolute(contractAsset))
  const root = await mkdtemp(join(tmpdir(), 'pe-stdio-approval-static-'))
  let server
  t.after(async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    await rm(root, { recursive: true, force: true })
  })
  const application = join(root, 'application'), packages = join(root, 'declared-packages')
  await Promise.all(['lib', 'web', 'node_modules/@power-evolve'].map(path => mkdir(join(application, path), { recursive: true, mode: 0o700 })))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert(Object.hasOwn(manifest.dependencies, '@power-evolve/contracts'))
  assert(Object.hasOwn(manifest.dependencies, '@power-evolve/cloud-web'))
  await writeFile(join(application, 'package.json'), JSON.stringify(manifest))
  for (const name of ['contracts', 'cloud-web']) {
    const path = join(packages, name); await mkdir(path, { recursive: true, mode: 0o700 })
    await copyFile(new URL(`../../${name}/package.json`, import.meta.url), join(path, 'package.json'))
    await symlink(path, join(application, 'node_modules/@power-evolve', name), 'dir')
  }
  await mkdir(join(packages, 'contracts/lib/browser'), { recursive: true, mode: 0o700 })
  await copyFile(contractAsset, join(packages, 'contracts/lib/browser/execution-resolution.js'))
  const webFiles = ['approval.html', 'approval.js', 'locale.js', 'execution-resolution.js', 'stdio-v2-approval.js', 'style.css']
  for (const file of webFiles) await copyFile(new URL(`../web/${file}`, import.meta.url), join(application, 'web', file))
  await copyFile(sourceModule, join(application, 'lib/ui.js'))
  const { serveUi } = await import(pathToFileURL(join(application, 'lib/ui.js')).href)
  const surfaces = ['login', 'client', 'device']
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture.invalid')
      const surface = surfaces[Number(url.searchParams.get('surface') ?? 0)]
      if (await serveUi(url.pathname, surface, response, hostOrigin)) return
      response.writeHead(404).end()
    } catch {
      if (response.headersSent) response.destroy()
      else response.writeHead(500).end('fixture_asset_unavailable')
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const get = path => fetch(origin + path, { redirect: 'manual' })
  const policy = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${hostOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  const bodies = new Map()
  const modules = ['/approval.js', '/stdio-v2-approval.js', '/locale.js', '/execution-resolution.js', '/execution-resolution-contract.js']
  for (const path of ['/approval', ...modules, '/style.css']) {
    const response = await get(path)
    assert.equal(response.status, 200, path); assert.equal(response.headers.get('location'), null, path)
    assert.equal(response.headers.get('content-type'), `${path === '/approval' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript'}; charset=utf-8`, path)
    assert.equal(response.headers.get('content-security-policy'), policy, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path)
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path)
    const body = Buffer.from(await response.arrayBuffer())
    const expected = path === '/execution-resolution-contract.js' ? await readFile(contractAsset)
      : await readFile(new URL(`../web/${path === '/approval' ? 'approval.html' : path.slice(1)}`, import.meta.url))
    assert.deepEqual(body, expected, path); bodies.set(path, body.toString('utf8'))
  }
  const scriptPath = /<script type="module" src="([^"]+)"/u.exec(bodies.get('/approval'))[1]
  assert.equal(scriptPath, '/approval.js')
  const visited = new Set(), visit = path => {
    assert(bodies.has(path), `Import absent from the actual allowlist responses: ${path}`)
    if (visited.has(path)) return
    visited.add(path)
    for (const match of bodies.get(path).matchAll(/\bimport\s+[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gu)) {
      assert(match[1].startsWith('./'), 'Approval modules only import same-origin relative modules')
      visit(new URL(match[1], origin + path).pathname)
    }
  }
  visit(scriptPath); assert.deepEqual([...visited].sort(), [...modules].sort())
  for (const surface of [1, 2]) for (const path of modules.filter(path => path !== '/locale.js').concat('/approval')) {
    const response = await get(`${path}?surface=${surface}`)
    assert.equal(response.status, 404, `${surfaces[surface]} ${path}`)
    assert.equal(response.headers.get('location'), null)
    assert.equal(await response.text(), '')
  }
  for (const path of ['/stdio-v2-approval.js.map', '/web/stdio-v2-approval.js', '/src/ui.ts']) assert.equal((await get(path)).status, 404)
})
