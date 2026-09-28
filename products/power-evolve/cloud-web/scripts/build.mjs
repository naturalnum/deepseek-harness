import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootInjections, orderByModuleGraph } from '@deepseek-ai/dsh-client-modules'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
const require = createRequire(import.meta.url)
const upstreamRequire = createRequire(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
const roots = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-trajectory',
]
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const packageJson = id => {
  const path = upstreamRequire.resolve(`${id}/package.json`)
  return { path, value: JSON.parse(readFileSync(path, 'utf8')) }
}

async function collect() {
  const pending = [...roots]
  const records = new Map()
  while (pending.length > 0) {
    const id = pending.shift()
    if (records.has(id)) continue
    const { path, value } = packageJson(id)
    const client = value.dsh?.client
    if (client?.platform !== 'web') throw new Error(`${id} is not a native DSH Web client`)
    const exported = value.exports?.['./client']
    const clientPath = typeof exported === 'string' ? exported : exported?.default
    if (typeof clientPath !== 'string') throw new Error(`${id} has no client bundle export`)
    const inject = client.inject ?? []
    const external = client.external ?? []
    if (![inject, external].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))) {
      throw new Error(`${id} has invalid client dependencies`)
    }
    for (const dependency of inject) {
      const declaration = packageJson(dependency).value.dsh?.client
      if (declaration?.platform !== 'web') throw new Error(`${id} requires unavailable Web client ${dependency}`)
      pending.push(dependency)
    }
    records.set(id, { id, clientPath: join(dirname(path), clientPath), inject, external,
      immediately: client.immediately === true })
  }
  return [...records.values()]
}

async function writeAsset(name, bytes) {
  const path = join(dist, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return `./${name}`
}

async function writeBoot(index, graph) {
  const rendered = renderIndexInjections(index, bootInjections(graph))
  // Native DSH renders three inline boot scripts. Move each verbatim to a
  // content-addressed file so the product Host can retain script-src 'self'.
  const scripts = [...rendered.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
  if (scripts.length !== 3) throw new Error(`expected three native DSH boot scripts, found ${scripts.length}`)
  let html = rendered
  for (const [, source] of scripts) {
    const url = await writeAsset(`boot/inline.${hash(source)}.js`, source)
    html = html.replace(`<script>${source}</script>`, `<script src="${url}"></script>`)
  }
  if (/<script(?:\s[^>]*)?>/u.test(html) && /<script>/u.test(html)) throw new Error('inline script remained in native Web shell')
  return html.replaceAll('href="/manifest.webmanifest"', 'href="./manifest.webmanifest"')
    .replaceAll('href="/favicon-dark.svg"', 'href="./favicon-dark.svg"')
    .replaceAll('href="/favicon.svg"', 'href="./favicon.svg"')
}

async function listFiles(directory) {
  const names = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(...await listFiles(join(directory, entry.name)))
    else if (entry.isFile()) names.push(relative(dist, join(directory, entry.name)).replaceAll('\\', '/'))
  }
  return names
}

async function main() {
  const frontend = dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json'))
  await rm(dist, { recursive: true, force: true })
  await cp(join(frontend, 'dist'), dist, { recursive: true })
  await rm(join(dist, 'preview'), { recursive: true, force: true })
  await rm(join(dist, 'preview.html'), { force: true })

  const rows = orderByModuleGraph(await Promise.all((await collect()).map(async record => {
    const bytes = await readFile(record.clientPath)
    const rev = hash(bytes)
    const url = await writeAsset(`plugins/${record.id}/client.js`, bytes)
    return { id: record.id, url: `${url}?rev=${rev}`, rev,
      ...(record.inject.length ? { inject: record.inject } : {}),
      ...(record.external.length ? { external: record.external } : {}),
      ...(record.immediately ? { immediately: true } : {}) }
  })))
  const bootstrap = rows.find(row => row.id === '@deepseek-ai/dsh-client-modules')
  if (!bootstrap) throw new Error('native DSH module bootstrap is missing')
  const application = rows.filter(row => row !== bootstrap)
  const applicationBytes = Buffer.concat(await Promise.all(application.map(async row =>
    Buffer.concat([await readFile(join(dist, row.url.split('?')[0].slice(2))), Buffer.from('\n;\n')]))))
  const applicationRev = hash(applicationBytes)
  const applicationUrl = await writeAsset(`boot/application.${applicationRev}.js`, applicationBytes)
  const graph = { entries: rows, batches: [
    { phase: 'bootstrap', url: bootstrap.url, rev: bootstrap.rev, entries: [bootstrap.id] },
    { phase: 'application', url: applicationUrl, rev: applicationRev, entries: application.map(row => row.id) },
  ] }
  graph.rev = hash(JSON.stringify(graph))
  const index = await readFile(join(dist, 'index.html'), 'utf8')
  await writeFile(join(dist, 'index.html'), await writeBoot(index, graph))
  const files = (await listFiles(dist)).filter(name => name !== 'asset-list.json').sort()
  await writeFile(join(dist, 'asset-list.json'), `${JSON.stringify(files)}\n`)
  console.log(`PowerEvolve native Web shell: ${rows.length} upstream client modules, ${files.length} static files`)
}

await main()
