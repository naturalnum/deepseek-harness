/** Requires prepared client bundles, built Host ui.js and cloud-web dist; VM checks register factories without opening a document. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { serveNativeUi } from '../../application/lib/ui.js'
import { buildNativeWeb } from '../scripts/build.mjs'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('native DSH shell uses the upstream page and a closed, external boot graph', async () => {
  const html = await readFile(join(dist, 'index.html'), 'utf8')
  assert.match(html, /<div id="root"><\/div>/u)
  assert.match(html, /<title>PowerEvolve<\/title>/u)
  assert.doesNotMatch(html, /<script>/u)
  assert.match(html, /<script src="\.\/boot\/inline\.[a-f0-9]+\.js"><\/script>/u)
  const assets = JSON.parse(await readFile(join(dist, 'asset-list.json'), 'utf8'))
  assert(assets.includes('index.html'))
  const scripts = await Promise.all(assets.filter(name => name.startsWith('boot/inline.'))
    .map(async name => readFile(join(dist, name), 'utf8')))
  const source = scripts.find(text => /globalThis\["__DSH_BOOT__"\]/u.test(text))
  assert(source, 'native boot graph script missing')
  const match = /globalThis\["__DSH_BOOT__"\] = (\{.*\})/u.exec(source)
  assert(match, 'native boot graph assignment missing')
  const graph = JSON.parse(match[1])
  assert.equal(graph.batches.length, 2)
  const ids = new Set(graph.entries.map(row => row.id))
  for (const id of ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-ui-chat',
    '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-settings-general',
    '@deepseek-ai/dsh-client-ui-sidebar-browser',
    '@power-evolve/client-brand', '@power-evolve/client-account', '@power-evolve/client-extension-center',
    '@power-evolve/client-execution-target',
    '@power-evolve/client-cloud-workspaces', '@power-evolve/client-artifacts']) assert(ids.has(id), id)
  for (const id of ['@deepseek-ai/dsh-client-ui-skill', '@deepseek-ai/dsh-client-ui-plugin-manager']) {
    assert(!ids.has(id), `${id} is deferred`)
  }
  assert(!ids.has('@deepseek-ai/dsh-client-ui-brand-official'), 'product brand owns the native slots')
  assert.equal(graph.entries.find(row => row.id === '@deepseek-ai/dsh-client-ui-sidebar-browser').requiresCarrier, 'desktop-browser')
  assert.equal(graph.entries.find(row => row.id === '@deepseek-ai/dsh-client-ui-sidebar-files').requiresCarrier, undefined)
  for (const row of graph.entries) {
    assert(row.url.startsWith('./plugins/'))
    assert(assets.includes(row.url.slice(2).split('?')[0]))
  }
  const preview = 'plugins/@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
  for (const name of ['client.pdf.js', 'client.excel.js']) assert(assets.includes(`${preview}/${name}`), name)
  for (const name of ['client.js.map', 'index.js', 'types/client/index.js']) assert(!assets.includes(`${preview}/${name}`), name)
})

test('Host serves native static files and chunk registrations through the exact allowlist', async t => {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    void serveNativeUi(path, res, 'http://127.0.0.1:18881').then(matched => {
      if (!matched) { res.writeHead(404); res.end() }
    }).catch(error => { res.writeHead(500); res.end(String(error)) })
  })
  server.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const redirect = await fetch(`${base}/native`, { redirect: 'manual' })
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.get('location'), '/native/')
  const page = await fetch(`${base}/native/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/u)
  assert.match(page.headers.get('content-security-policy') ?? '', /'unsafe-eval'/u)
  assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self' http:\/\/127\.0\.0\.1:18881/u)
  assert.match(await page.text(), /<div id="root"><\/div>/u)
  const asset = await fetch(`${base}/native/favicon.svg`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type') ?? '', /image\/svg\+xml/u)
  const preview = 'plugins/@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
  const assets = JSON.parse(await readFile(join(dist, 'asset-list.json'), 'utf8'))
  const bootSources = await Promise.all(assets.filter(name => name.startsWith('boot/inline.')).map(name => readFile(join(dist, name), 'utf8')))
  const graph = JSON.parse(/globalThis\["__DSH_BOOT__"\] = (\{.*\})/u.exec(bootSources.find(source => source.includes('globalThis["__DSH_BOOT__"]')))[1])
  const row = graph.entries.find(entry => entry.id === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview')
  for (const name of ['client.pdf.js', 'client.excel.js']) {
    const response = await fetch(`${base}/native/${preview}/${name}?rev=${row.rev}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/javascript/u)
    const source = await response.text(), registrations = []
    runInNewContext(source, { window: { __ModuleLoader__: { load: registration => registrations.push(registration) } } }, { timeout: 1000 })
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].id, row.id); assert.equal(registrations[0].chunk, name)
    assert.equal(typeof registrations[0].factory, 'function')
  }
  await writeFile(join(dist, 'unlisted.txt'), 'unlisted fixture bytes')
  t.after(() => rm(join(dist, 'unlisted.txt'), { force: true }))
  for (const path of ['unlisted.txt', `${preview}/client.js.map`, `${preview}/index.js`, `${preview}/types/client/index.js`,
    `${preview}/client.not-built.js`, 'plugins/%2e%2e%2fpackage.json']) assert.equal((await fetch(`${base}/native/${path}`)).status, 404, path)
  assert.equal((await fetch(`${base}/native/missing.js`)).status, 404)
  assert.equal((await fetch(`${base}/`)).status, 404)
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pe-native-client-assets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const frontendDirectory = join(root, 'frontend'), outputDirectory = join(root, 'output'), clientDirectory = join(root, 'client')
  await Promise.all([frontendDirectory, clientDirectory].map(directory => mkdir(directory)))
  await writeFile(join(frontendDirectory, 'index.html'), '<html><head><title>DSH</title></head><body><div id="root"></div></body></html>')
  const bootstrap = join(root, 'bootstrap'); await mkdir(bootstrap)
  await writeFile(join(bootstrap, 'client.js'), 'window.__ModuleLoader__.load({id:"@deepseek-ai/dsh-client-modules",factory:()=>({})});')
  const clients = [
    { id: '@deepseek-ai/dsh-client-modules', clientPath: join(bootstrap, 'client.js'), inject: [], external: [], immediately: true },
    { id: '@power-evolve/client-fixture', clientPath: join(clientDirectory, 'client.js'), inject: [], external: [], immediately: false },
  ]
  const main = 'window.__ModuleLoader__.load({id:"@power-evolve/client-fixture",factory:require=>({pdf:()=>require.async("./client.pdf.js")})});'
  const pdf = 'window.__ModuleLoader__.load({id:"@power-evolve/client-fixture",chunk:"client.pdf.js",factory:require=>({value:"pdf marker",shared:()=>require.async("./client.shared.js")})});'
  await writeFile(join(clientDirectory, 'client.js'), main)
  await writeFile(join(clientDirectory, 'client.pdf.js'), pdf)
  await writeFile(join(clientDirectory, 'client.shared.js'), 'window.__ModuleLoader__.load({id:"@power-evolve/client-fixture",chunk:"client.shared.js",factory:()=>({value:"shared marker"})});')
  return { root, frontendDirectory, outputDirectory, clientDirectory, clients, main, pdf }
}

test('copies native sibling chunks without publishing maps, Node entries or other package files', async t => {
  const f = await fixture(t)
  for (const name of ['client.js.map', 'index.js', 'private.txt', 'client..js']) await writeFile(join(f.clientDirectory, name), 'unpublished fixture')
  const { graph, files } = await buildNativeWeb(f)
  const row = graph.entries.find(entry => entry.id === '@power-evolve/client-fixture')
  assert.match(row.url, /^\.\/plugins\/@power-evolve\/client-fixture\/client\.js\?rev=[a-f0-9]{16}$/u)
  assert.deepEqual(files.filter(name => name.startsWith('plugins/@power-evolve/client-fixture/')),
    ['client.js', 'client.pdf.js', 'client.shared.js'].map(name => `plugins/@power-evolve/client-fixture/${name}`))
  assert.equal(await readFile(join(f.outputDirectory, 'plugins/@power-evolve/client-fixture/client.pdf.js'), 'utf8'), f.pdf)
  const application = await readFile(join(f.outputDirectory, graph.batches.find(batch => batch.phase === 'application').url.slice(2)), 'utf8')
  assert(application.includes(f.main)); assert(!application.includes('pdf marker')); assert(!application.includes('shared marker'))
})

test('chunk-only changes update owner, application and graph revisions while retaining entry bytes', async t => {
  const f = await fixture(t), first = await buildNativeWeb(f), repeated = await buildNativeWeb(f)
  assert.deepEqual(repeated.graph, first.graph)
  await writeFile(join(f.clientDirectory, 'client.pdf.js'), f.pdf.replace('pdf marker', 'changed pdf marker'))
  const changed = await buildNativeWeb(f)
  const row = result => result.graph.entries.find(entry => entry.id === '@power-evolve/client-fixture')
  const batch = result => result.graph.batches.find(entry => entry.phase === 'application')
  assert.notEqual(row(changed).rev, row(first).rev); assert.notEqual(changed.graph.rev, first.graph.rev)
  assert.notEqual(batch(changed).rev, batch(first).rev); assert.notEqual(batch(changed).url, batch(first).url)
  assert.equal(await readFile(join(f.clientDirectory, 'client.js'), 'utf8'), f.main)
  assert.equal(await readFile(join(f.outputDirectory, batch(changed).url.slice(2)), 'utf8'), `${f.main}\n;\n`)
})

test('carrier-only changes update application and graph revisions without changing module assets', async t => {
  const f = await fixture(t), first = await buildNativeWeb(f)
  f.clients[1].requiresCarrier = 'desktop-browser'
  const next = await buildNativeWeb(f)
  const row = result => result.graph.entries.find(entry => entry.id === '@power-evolve/client-fixture')
  assert.equal(row(next).requiresCarrier, 'desktop-browser')
  assert.equal(row(first).rev, row(next).rev)
  assert.notEqual(first.graph.rev, next.graph.rev)
  assert.notEqual(first.graph.batches[1].rev, next.graph.batches[1].rev)
})

test('missing or invalid entry and transitive chunk references fail before replacing output', async t => {
  const f = await fixture(t); await mkdir(f.outputDirectory); await writeFile(join(f.outputDirectory, 'keep'), 'previous output')
  for (const [name, source] of [['client.js', 'require.async("./client.missing.js")'], ['client.pdf.js', 'require.async("./client.missing.js")'],
    ['client.pdf.js', 'require.async("./../outside.js")']]) {
    const path = join(f.clientDirectory, name), original = await readFile(path)
    await writeFile(path, source)
    await assert.rejects(buildNativeWeb(f), /requires missing client asset/u)
    assert.equal(await readFile(join(f.outputDirectory, 'keep'), 'utf8'), 'previous output')
    await writeFile(path, original)
  }
  await rm(join(f.clientDirectory, 'client.js'))
  await assert.rejects(buildNativeWeb(f), /ENOENT/u)
  assert.equal(await readFile(join(f.outputDirectory, 'keep'), 'utf8'), 'previous output')
})

test('client assets must be physical files and package ids cannot escape the plugin directory', async t => {
  const f = await fixture(t), chunk = join(f.clientDirectory, 'client.pdf.js'), outside = join(f.root, 'outside.js')
  await writeFile(outside, f.pdf); await rm(chunk); await symlink(outside, chunk)
  await assert.rejects(buildNativeWeb(f), /is not a physical client asset/u)
  await rm(chunk); await mkdir(chunk)
  await assert.rejects(buildNativeWeb(f), /is not a physical client asset/u)
  await rm(chunk, { recursive: true }); await writeFile(chunk, f.pdf)
  await assert.rejects(buildNativeWeb({ ...f, clients: [f.clients[0], { ...f.clients[1], id: '../../outside' }] }), /invalid native client package id/u)
})
