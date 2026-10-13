/** Assemble the prepared native Web shell and revisioned client scripts for the Host's exact static allowlist. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { bootInjections, orderByModuleGraph } from '@deepseek-ai/dsh-client-modules'
import { PLATFORM_MODULES } from '@deepseek-ai/dsh-client-web/platform'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
const require = createRequire(import.meta.url)
const upstreamRequire = createRequire(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
const applicationRequire = createRequire(new URL('../../application/package.json', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const clientChunk = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u
const packageRecords = new Map()
const packageJson = (id, ownerPath) => {
  if (packageRecords.has(id)) return packageRecords.get(id)
  let path
  try { path = (ownerPath ? createRequire(ownerPath) : upstreamRequire).resolve(`${id}/package.json`) }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    try { path = applicationRequire.resolve(`${id}/package.json`) }
    catch (nested) {
      if (nested.code !== 'MODULE_NOT_FOUND') throw nested
      path = require.resolve(`${id}/package.json`)
    }
  }
  const record = { path, value: JSON.parse(readFileSync(path, 'utf8')) }
  packageRecords.set(id, record)
  return record
}

// Resolve exactly the official Web roster; conditional Desktop rows stay absent.
const webPatch = parseYaml(readFileSync(upstreamRequire.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml'), 'utf8'),
  { schema: DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })]) })
const officialRows = webPatch.flatMap(row => row.insert ?? []).filter(row => row.disabled === undefined)
const roots = [...new Set(officialRows.map(row => row.name.startsWith('@') ? row.name.split('/').slice(0, 2).join('/') : row.name.split('/')[0]).filter(id => packageJson(id).value.dsh?.client?.platform === 'web')),
  '@deepseek-ai/dsh-client-ui-directory-picker-browse', '@power-evolve/client-account', '@power-evolve/client-extension-center']

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
      if (PLATFORM_MODULES.includes(dependency)) continue
      const declaration = packageJson(dependency, path).value.dsh?.client
      if (declaration?.platform !== 'web') throw new Error(`${id} requires unavailable Web client ${dependency}`)
      pending.push(dependency)
    }
    records.set(id, { id, clientPath: join(dirname(path), clientPath), inject, external,
      immediately: client.immediately === true,
      ...(id === '@deepseek-ai/dsh-client-ui-sidebar-browser' ? { requiresCarrier: 'desktop-browser' } : {}) })
  }
  return [...records.values()]
}

async function clientAssets(record) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(record.id)) {
    throw new Error(`invalid native client package id ${JSON.stringify(record.id)}`)
  }
  if (basename(record.clientPath) !== 'client.js' || !(await lstat(record.clientPath)).isFile()) {
    throw new Error(`${record.id} has no physical client.js entry`)
  }
  const assets = []
  const directory = dirname(record.clientPath)
  for (const name of (await readdir(directory)).filter(name => name === 'client.js' || clientChunk.test(name)).sort()) {
    const path = join(directory, name)
    if (!(await lstat(path)).isFile()) throw new Error(`${record.id}/${name} is not a physical client asset`)
    assets.push({ name, bytes: await readFile(path) })
  }
  const names = new Set(assets.map(asset => asset.name))
  for (const asset of assets) {
    // The native preset emits literal require.async("./client.<name>.js") requests.
    for (const [, , request] of asset.bytes.toString('utf8').matchAll(/\brequire\.async\(\s*(["'])(\.\/[^"'\r\n]+)\1\s*\)/gu)) {
      const name = request.slice(2)
      if (!clientChunk.test(name) || !names.has(name)) throw new Error(`${record.id}/${asset.name} requires missing client asset ${request}`)
    }
  }
  const rev = hash(JSON.stringify(assets.map(asset => [asset.name, createHash('sha256').update(asset.bytes).digest('hex')])))
  return { ...record, assets, rev }
}

async function writeAsset(outputDirectory, name, bytes) {
  const path = join(outputDirectory, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return `./${name}`
}

async function writeBoot(index, graph, outputDirectory) {
  const rendered = renderIndexInjections(index, bootInjections(graph))
  // Native DSH renders three inline boot scripts. Move each verbatim to a
  // content-addressed file so the product Host can retain script-src 'self'.
  const scripts = [...rendered.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
  if (scripts.length !== 3) throw new Error(`expected three native DSH boot scripts, found ${scripts.length}`)
  let html = rendered
  for (const [, source] of scripts) {
    const url = await writeAsset(outputDirectory, `boot/inline.${hash(source)}.js`, source)
    html = html.replace(`<script>${source}</script>`, `<script src="${url}"></script>`)
  }
  if (/<script(?:\s[^>]*)?>/u.test(html) && /<script>/u.test(html)) throw new Error('inline script remained in native Web shell')
  return html.replaceAll('href="/manifest.webmanifest"', 'href="./manifest.webmanifest"')
    .replaceAll('href="/favicon-dark.svg"', 'href="./favicon-dark.svg"')
    .replaceAll('href="/favicon.svg"', 'href="./favicon.svg"')
    .replace(/<title>[^<]*<\/title>/u, '<title>PowerEvolve</title>')
}

async function listFiles(directory, outputDirectory) {
  const names = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(...await listFiles(join(directory, entry.name), outputDirectory))
    else if (entry.isFile()) names.push(relative(outputDirectory, join(directory, entry.name)).replaceAll('\\', '/'))
  }
  return names
}

/**
 * Assemble prepared native frontend and client factories into a closed static asset directory.
 * Only physical client.js and same-directory client.<name>.js assets are copied; missing literal
 * chunk references fail before replacing output. Owner, application and graph revisions include
 * all copied client asset bytes. Dynamic chunks remain outside the eager application batch.
 * Carrier requirements are explicit graph metadata; inactive factories grant no browser capability.
 * @param options - Prepared frontend directory, output directory owned by the caller, and resolved native client records.
 * @returns Native boot graph and exact static-file allowlist; no application or server is started.
 */
export async function buildNativeWeb(options) {
  const { frontendDirectory, outputDirectory, clients } = options
  const snapshots = await Promise.all(clients.map(clientAssets))
  await rm(outputDirectory, { recursive: true, force: true })
  await cp(frontendDirectory, outputDirectory, { recursive: true })
  await rm(join(outputDirectory, 'preview'), { recursive: true, force: true })
  await rm(join(outputDirectory, 'preview.html'), { force: true })

  const rows = orderByModuleGraph(await Promise.all(snapshots.map(async (record) => {
    const { rev } = record
    for (const asset of record.assets) await writeAsset(outputDirectory, `plugins/${record.id}/${asset.name}`, asset.bytes)
    const url = `./plugins/??${record.id}/client.js&rev=${rev}`
    return { id: record.id, url, rev,
      ...(record.inject.length ? { inject: record.inject } : {}),
      ...(record.external.length ? { external: record.external } : {}),
      ...(record.requiresCarrier === undefined ? {} : { requiresCarrier: record.requiresCarrier }),
      ...(record.immediately ? { immediately: true } : {}) }
  })))
  const bootstrap = rows.find(row => row.id === '@deepseek-ai/dsh-client-modules')
  if (!bootstrap) throw new Error('native DSH module bootstrap is missing')
  const application = rows.filter(row => row !== bootstrap)
  const applicationBytes = Buffer.concat(await Promise.all(application.map(async row =>
    Buffer.concat([await readFile(join(outputDirectory, `plugins/${row.id}/client.js`)), Buffer.from('\n;\n')]))))
  const applicationRev = hash(Buffer.concat([Buffer.from(JSON.stringify(application.map(row => row.requiresCarrier === undefined
    ? [row.id, row.rev] : [row.id, row.rev, row.requiresCarrier]))), applicationBytes]))
  const applicationUrl = await writeAsset(outputDirectory, `boot/application.${applicationRev}.js`, applicationBytes)
  const graph = { entries: rows, batches: [
    { phase: 'bootstrap', url: bootstrap.url, rev: bootstrap.rev, entries: [bootstrap.id] },
    { phase: 'application', url: applicationUrl, rev: applicationRev, entries: application.map(row => row.id) },
  ] }
  graph.rev = hash(JSON.stringify(graph))
  const clientResources = Object.fromEntries(snapshots.flatMap(record => record.assets.map(asset => [
    asset.name === 'client.js' ? `plugins/??${record.id}/client.js&rev=${record.rev}`
      : `plugins/${record.id}/${asset.name}?rev=${record.rev}`,
    `plugins/${record.id}/${asset.name}`,
  ])))
  await writeFile(join(outputDirectory, 'client-resource-map.json'), `${JSON.stringify(clientResources)}\n`)
  const index = await readFile(join(outputDirectory, 'index.html'), 'utf8')
  await writeFile(join(outputDirectory, 'index.html'), await writeBoot(index, graph, outputDirectory))
  const files = (await listFiles(outputDirectory, outputDirectory))
    .filter(name => name !== 'asset-list.json' && name !== 'client-resource-map.json').sort()
  await writeFile(join(outputDirectory, 'asset-list.json'), `${JSON.stringify(files)}\n`)
  return { graph, files }
}

async function main() {
  const frontend = dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json'))
  const { graph, files } = await buildNativeWeb({ frontendDirectory: join(frontend, 'dist'), outputDirectory: dist, clients: await collect() })
  console.log(`PowerEvolve native Web shell: ${graph.entries.length} client modules, ${files.length} static files`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
