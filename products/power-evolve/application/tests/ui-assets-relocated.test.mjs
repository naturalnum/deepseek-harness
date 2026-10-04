/** Real HTTP gate for production built UI assets resolved through relocated package aliases. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceModule = process.env.PE_RELOCATED_UI_MODULE ?? fileURLToPath(new URL('../lib/ui.js', import.meta.url))
const platformOrigin = 'http://127.0.0.1:23001', hostOrigin = 'http://127.0.0.1:23002'
const nativeHtml = '<!doctype html><title>Relocated native fixture</title>\n'
const nativeJs = 'export const nativeFixture = "relocated-native";\n'
const contractJs = 'export const resolutionFixture = "relocated-contract";\n'
const approvalHtml = '<!doctype html><title>Relocated approval fixture</title>\n'

/** Materialize three independent physical package roots, with only declared aliases joining them. */
async function fixture(context, override = false) {
  assert(isAbsolute(sourceModule), 'Select an absolute production built UI module')
  const root = await mkdtemp(join(tmpdir(), 'pe-ui-relocated-'))
  let server
  context.after(async () => {
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    await rm(root, { recursive: true, force: true })
  })
  const application = join(root, 'application-copy/deep/application')
  const cloud = join(root, 'independent-static-store/slot/cloud-web')
  const contracts = join(root, 'another-package-store/version/contracts')
  await Promise.all([join(application, 'lib'), join(application, 'web'), join(application, 'node_modules/@power-evolve'),
    join(cloud, 'dist/assets'), join(contracts, 'lib/browser')].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  assert(Object.hasOwn(manifest.dependencies, '@power-evolve/cloud-web'))
  assert(Object.hasOwn(manifest.dependencies, '@power-evolve/contracts'))
  await writeFile(join(application, 'package.json'), JSON.stringify(manifest))
  for (const [name, path] of [['cloud-web', cloud], ['contracts', contracts]]) {
    const packageManifest = JSON.parse(await readFile(new URL(`../../${name}/package.json`, import.meta.url)))
    await writeFile(join(path, 'package.json'), JSON.stringify(packageManifest))
    await symlink(path, join(application, 'node_modules/@power-evolve', name), 'dir')
    assert.notEqual(dirname(path), dirname(application))
  }
  const native = override ? join(root, 'explicit-native-dist') : join(cloud, 'dist')
  await mkdir(join(native, 'assets'), { recursive: true, mode: 0o700 })
  const html = override ? nativeHtml.replace('Relocated', 'Overridden') : nativeHtml
  await writeFile(join(native, 'index.html'), html)
  await writeFile(join(native, 'assets/native.js'), nativeJs)
  await writeFile(join(native, 'unlisted.js'), 'unlisted fixture must not be served\n')
  await writeFile(join(native, 'asset-list.json'), JSON.stringify(['index.html', 'assets/native.js']))
  await writeFile(join(contracts, 'lib/browser/execution-resolution.js'), contractJs)
  await writeFile(join(application, 'web/approval.html'), approvalHtml)
  await copyFile(sourceModule, join(application, 'lib/ui.js'))
  const previous = process.env.PE_NATIVE_WEB_DIST
  let ui
  try {
    if (override) process.env.PE_NATIVE_WEB_DIST = native
    else delete process.env.PE_NATIVE_WEB_DIST
    ui = await import(pathToFileURL(join(application, 'lib/ui.js')).href)
  } finally {
    if (previous === undefined) delete process.env.PE_NATIVE_WEB_DIST
    else process.env.PE_NATIVE_WEB_DIST = previous
  }
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      if (await ui.serveNativeUi(path, response, platformOrigin)) return
      if (await ui.serveUi(path, 'login', response, hostOrigin)) return
      response.writeHead(404).end()
    } catch (_assetFailure) {
      if (response.headersSent) response.destroy()
      else response.writeHead(500).end('fixture_asset_unavailable')
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const get = async path => {
    try {
      const response = await fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
      return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) }
    } catch (_incompleteResponse) { return { status: null, code: 'http_response_incomplete' } }
  }
  return { get, html }
}

function commonHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

test('built assets resolve nonadjacent physical cloud-web and contracts aliases', { timeout: 15000 }, async context => {
  const { get } = await fixture(context)
  await context.test('native document and listed asset preserve exact bytes and CSP', async () => {
    const index = await get('/native/')
    assert.equal(index.status, 200)
    assert.deepEqual(index.body, Buffer.from(nativeHtml))
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8')
    commonHeaders(index)
    assert.equal(index.headers.get('content-security-policy'), `default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${platformOrigin}; img-src 'self' data: blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`)
    const asset = await get('/native/assets/native.js')
    assert.equal(asset.status, 200)
    assert.deepEqual(asset.body, Buffer.from(nativeJs))
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')
    const redirect = await get('/native')
    assert.equal(redirect.status, 308)
    assert.equal(redirect.headers.get('location'), '/native/')
  })
  await context.test('missing and physically present unlisted assets return 404', async () => {
    for (const path of ['/native/missing.js', '/native/unlisted.js', '/native/asset-list.json', '/not-an-asset']) {
      const result = await get(path)
      assert.equal(result.status, 404, path)
      assert.equal(result.body.length, 0)
    }
  })
  await context.test('trusted approval contract comes from its declared package with the original CSP', async () => {
    const approval = await get('/approval')
    assert.equal(approval.status, 200)
    assert.deepEqual(approval.body, Buffer.from(approvalHtml))
    const contract = await get('/execution-resolution-contract.js')
    assert.equal(contract.status, 200)
    assert.deepEqual(contract.body, Buffer.from(contractJs))
    assert.equal(contract.headers.get('content-type'), 'text/javascript; charset=utf-8')
    commonHeaders(contract)
    assert.equal(contract.headers.get('content-security-policy'), `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${hostOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`)
    assert.equal((await get('/execution-resolution-contract.js.map')).status, 404)
  })
})

test('PE_NATIVE_WEB_DIST override retains the native asset allowlist after relocation', { timeout: 10000 }, async context => {
  const { get, html } = await fixture(context, true)
  const index = await get('/native/')
  assert.equal(index.status, 200)
  assert.deepEqual(index.body, Buffer.from(html))
  assert.equal((await get('/native/assets/native.js')).status, 200)
  for (const path of ['/native/unlisted.js', '/native/missing.js', '/native/asset-list.json']) {
    const result = await get(path)
    assert.equal(result.status, 404)
    assert.equal(result.body.length, 0)
  }
  console.log('PE_RELOCATED_UI_EVIDENCE ' + JSON.stringify({ builtModuleSha256: createHash('sha256')
    .update(await readFile(sourceModule)).digest('hex'), environmentAllowlist: true }))
})
