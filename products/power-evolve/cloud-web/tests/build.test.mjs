import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { serveNativeUi } from '../../application/lib/ui.js'

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
    '@power-evolve/client-brand', '@power-evolve/client-execution-target',
    '@power-evolve/client-cloud-workspaces', '@power-evolve/client-artifacts']) assert(ids.has(id), id)
  for (const id of ['@deepseek-ai/dsh-client-ui-skill', '@deepseek-ai/dsh-client-ui-plugin-manager']) {
    assert(!ids.has(id), `${id} is deferred`)
  }
  assert(!ids.has('@deepseek-ai/dsh-client-ui-brand-official'), 'product brand owns the native slots')
  for (const row of graph.entries) {
    assert(row.url.startsWith('./plugins/'))
    assert(assets.includes(row.url.slice(2).split('?')[0]))
  }
})

test('Host serves native static files separately from the existing trial root', async () => {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    void serveNativeUi(path, res).then(matched => {
      if (!matched) { res.writeHead(404); res.end() }
    }).catch(error => { res.writeHead(500); res.end(String(error)) })
  })
  server.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  after(() => server.close())
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
  assert.match(await page.text(), /<div id="root"><\/div>/u)
  const asset = await fetch(`${base}/native/favicon.svg`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type') ?? '', /image\/svg\+xml/u)
  assert.equal((await fetch(`${base}/native/missing.js`)).status, 404)
  assert.equal((await fetch(`${base}/`)).status, 404)
})
