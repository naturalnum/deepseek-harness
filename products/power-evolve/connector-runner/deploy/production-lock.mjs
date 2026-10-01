/** Compare the Connector's production and optional lock metadata before allowing image construction. */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import yaml from 'js-yaml'

const project = 'products/power-evolve/connector-runner'
const productionFields = ['dependencies', 'optionalDependencies']

function requireValue(condition, message) {
  if (!condition) throw new Error(`Connector production lock: ${message}`)
}

function record(value, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be a mapping`)
  return value
}

function equal(actual, expected, label) {
  requireValue(isDeepStrictEqual(actual, expected), `${label} changed`)
}

function fileIdentity(info) {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs }
}

async function sourceFile(path, label) {
  const before = fileIdentity(await stat(path, { bigint: true }))
  const bytes = await readFile(path)
  const after = fileIdentity(await stat(path, { bigint: true }))
  equal(after, before, `${label} during read`)
  return { path, label, bytes, identity: after }
}

function lockfile(bytes, label) {
  const lock = record(yaml.load(bytes.toString('utf8'), { schema: yaml.JSON_SCHEMA }), label)
  requireValue(lock.lockfileVersion === '9.0', `${label} must use lockfileVersion 9.0`)
  for (const field of ['importers', 'packages', 'snapshots']) record(lock[field], `${label} ${field}`)
  return lock
}

function directDependencies(importer, manifest, label) {
  const direct = {}
  for (const field of productionFields) {
    const entries = record(importer[field] ?? {}, `${label} ${field}`)
    const specifiers = {}
    for (const [name, value] of Object.entries(entries)) {
      record(value, `${label} ${field} ${name}`)
      requireValue(typeof value.specifier === 'string' && value.specifier.length > 0
        && typeof value.version === 'string' && value.version.length > 0, `${label} ${name} is not locked`)
      specifiers[name] = value.specifier
    }
    equal(record(manifest[field] ?? {}, `${label} manifest ${field}`), specifiers, `${label} manifest ${field}`)
    direct[field] = entries
  }
  return direct
}

function productionClosure(lock, importer, manifest, label) {
  const direct = directDependencies(record(importer, `${label} importer`), manifest, label)
  const queue = productionFields.flatMap(field => Object.entries(direct[field])
    .map(([name, value]) => [name, value.version]))
  const nodes = new Map()
  while (queue.length) {
    const [name, reference] = queue.shift()
    requireValue(typeof reference === 'string' && reference.length > 0, `${label} dependency ${name} is not locked`)
    requireValue(!/^(?:link|file|workspace):/u.test(reference), `${label} dependency ${name} must be registry-only`)
    const key = Object.hasOwn(lock.snapshots, reference) ? reference : `${name}@${reference}`
    requireValue(Object.hasOwn(lock.snapshots, key), `${label} snapshot ${key} is missing`)
    if (nodes.has(key)) continue
    const snapshot = record(lock.snapshots[key], `${label} snapshot ${key}`)
    const packageId = key.split('(')[0]
    const metadata = record(lock.packages[packageId], `${label} package ${packageId}`)
    const resolution = record(metadata.resolution, `${label} resolution ${packageId}`)
    requireValue(typeof resolution.integrity === 'string' && resolution.integrity.length > 0,
      `${label} integrity ${packageId} is missing`)
    const node = { resolution }
    for (const field of productionFields) {
      node[field] = record(snapshot[field] ?? {}, `${label} snapshot ${key} ${field}`)
      queue.push(...Object.entries(node[field]))
    }
    const peers = snapshot.transitivePeerDependencies ?? []
    requireValue(Array.isArray(peers) && peers.every(value => typeof value === 'string'), `${label} peers ${key} must be strings`)
    node.transitivePeerDependencies = [...peers].sort()
    for (const field of ['peerDependencies', 'peerDependenciesMeta', 'engines', 'cpu', 'os', 'libc']) {
      node[field] = metadata[field]
    }
    nodes.set(key, node)
  }
  return { direct, nodes }
}

async function unchanged(source) {
  for (const original of [source.lock, source.manifestFile]) {
    const current = await sourceFile(original.path, original.label)
    requireValue(current.bytes.equals(original.bytes) && isDeepStrictEqual(current.identity, original.identity),
      `${original.label} changed during preparation`)
  }
}

/**
 * Read and validate the source lock and package manifest before preparing a Connector artifact.
 * @param root Repository directory containing the root pnpm lockfile and Connector package.
 * @returns The captured source bytes, file identities, manifest, and locked production closure.
 */
export async function readConnectorProductionLock(root) {
  const lock = await sourceFile(join(root, 'pnpm-lock.yaml'), 'source lock')
  const manifestFile = await sourceFile(join(root, project, 'package.json'), 'source manifest')
  const manifest = record(JSON.parse(manifestFile.bytes.toString('utf8')), 'source manifest')
  requireValue(manifest.name === '@power-evolve/connector-runner', 'source manifest package is not the Connector')
  const parsed = lockfile(lock.bytes, 'source lock')
  const closure = productionClosure(parsed, parsed.importers[project], manifest, 'source')
  const source = { lock, manifestFile, manifest, closure }
  await unchanged(source)
  return source
}

/**
 * Reject drift or missing production metadata after successful deploy and before any image build.
 * @param source Source captured by readConnectorProductionLock before preparation.
 * @param context Completed pnpm deploy directory containing package.json and node_modules/.pnpm/lock.yaml.
 * @returns Source/deploy lock hashes and the number of matching production and optional packages.
 */
export async function verifyConnectorProductionLock(source, context) {
  await unchanged(source)
  const lockBytes = await readFile(join(context, 'node_modules/.pnpm/lock.yaml'))
  const manifestBytes = await readFile(join(context, 'package.json'))
  const deployed = lockfile(lockBytes, 'deployed lock')
  const manifest = record(JSON.parse(manifestBytes.toString('utf8')), 'deployed manifest')
  for (const field of ['name', 'version', 'type']) equal(manifest[field], source.manifest[field], `deployed manifest ${field}`)
  const importer = Object.hasOwn(deployed.importers, project) ? deployed.importers[project] : deployed.importers['.']
  const closure = productionClosure(deployed, importer, manifest, 'deployed')
  for (const field of productionFields) equal(closure.direct[field], source.closure.direct[field], `direct ${field}`)
  equal([...closure.nodes.keys()].sort(), [...source.closure.nodes.keys()].sort(), 'production snapshot keys')
  for (const [key, expected] of source.closure.nodes) {
    const actual = closure.nodes.get(key)
    for (const field of Object.keys(expected)) equal(actual[field], expected[field], `${key} ${field}`)
  }
  await unchanged(source)
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  return { sourceLockSha256: hash(source.lock.bytes), deployedLockSha256: hash(lockBytes), packages: closure.nodes.size }
}
