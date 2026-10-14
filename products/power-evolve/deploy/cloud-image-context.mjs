/** Copy an explicit source corpus into a new, caller-owned Docker context; no host artifacts or private inputs. */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directories = ['vendor', 'packages', 'patches', 'native/system', 'apps/cli', 'apps/web', 'scripts', 'python/sdk-runtime',
  ...['application', 'contracts', 'connector-runner', 'client-account', 'client-extension-center', 'cloud-web', 'host', 'platform', 'native-runtime', 'deploy']
    .map(name => 'products/power-evolve/' + name), 'products/power-evolve/scripts']
const rootFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function excluded(path) {
  const pieces = path.split('/')
  if (pieces.some(piece => ['node_modules', '.git', '.cache', 'tests', '__tests__', 'private', 'reference'].includes(piece)
    || piece.startsWith('.env')) || /(?:\.test|\.spec|\.bench)\.[cm]?[jt]sx?$/u.test(path) || path.endsWith('.tsbuildinfo')) return true
  if (['CLAUDE.md', 'AGENTS.md'].includes(pieces.at(-1))) return true
  if (/^(?:packages\/[^/]+\/[^/]+|vendor\/[^/]+|apps\/(?:cli|web)|products\/power-evolve\/[^/]+)\/(?:lib|dist)\//u.test(path)
    || /^native\/system\/(?:\.release\/|packages\/[^/]+\/(?:lib|bin)\/)/u.test(path)) return true
  return /(?:^|\/)(?:worker-token|native-intent-key|model-key|connector-key|runner-key|database-url|deployment\.json|users\.json)$/u
    .test(path)
    || /^products\/power-evolve\/deploy\/(?:employee4-|EMPLOYEE|QA-)/u.test(path)
}

/** Snapshot only reviewed source/configuration paths, refusing aliases and changes while reading.
 * @param repository Fixed official-baseline migration checkout.
 * @param destination New absent Docker context owned by the caller.
 * @returns Manifest of copied bytes and fixed baseline; no credential content.
 */
export async function cloudImageContext(repository, destination) {
  repository = resolve(repository); destination = resolve(destination)
  if (destination === repository || destination.startsWith(repository + '/')) throw new Error('Build context must be outside the checkout')
  const expected = JSON.parse(await readFile(join(repository, 'products/power-evolve/deploy/baseline.json'), 'utf8'))
  if (expected.officialTag !== 'dsh-v0.2.1-alpha.1' || !/^[a-f0-9]{40}$/u.test(expected.officialCommit)) throw new Error('Invalid reviewed image baseline')
  const baseline = spawnSync('git', ['rev-parse', expected.officialTag + '^{commit}', 'HEAD'], { cwd: repository, encoding: 'utf8' })
  const revisions = baseline.stdout.trim().split('\n')
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', expected.officialCommit, revisions[1]], { cwd: repository, encoding: 'utf8' })
  if (baseline.status !== 0 || revisions.length !== 2 || revisions[0] !== expected.officialCommit || ancestry.status !== 0) {
    throw new Error('Image checkout must contain the reviewed official baseline; full tag/history evidence is required')
  }
  await mkdir(destination, { mode: 0o700 })
  const files = []
  async function sourceDirectory(path) {
    const first = await mkdir(path, { recursive: true, mode: 0o755 })
    if (first === undefined) return
    for (let directory = path; ; directory = dirname(directory)) {
      await chmod(directory, 0o755)
      if (directory === first) break
    }
  }
  async function copy(path) {
    if (excluded(path)) return
    const source = join(repository, path), before = await lstat(source)
    if (before.isSymbolicLink()) throw new Error('Source context refuses symlinks: ' + path)
    if (before.isDirectory()) { for (const name of (await readdir(source)).toSorted()) await copy(path + '/' + name); return }
    if (!before.isFile()) throw new Error('Source context requires ordinary files: ' + path)
    const bytes = await readFile(source), after = await lstat(source)
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed while constructing image: ' + path)
    const target = join(destination, 'source', path)
    await sourceDirectory(dirname(target))
    await writeFile(target, bytes, { mode: before.mode & 0o777 })
    await chmod(target, before.mode & 0o777)
    files.push({ path, sha256: hash(bytes), mode: before.mode & 0o777 })
  }
  async function inputPaths() {
    const configs = (await readdir(repository)).filter(entryName => /^tsconfig.*\.json$/u.test(entryName))
    // Frozen lock importers retain upstream manifest identities; Desktop application source is absent.
    const appManifests = (await readdir(join(repository, 'apps'))).filter(entryName => !['cli', 'web'].includes(entryName))
      .map(name => 'apps/' + name + '/package.json')
    return [...rootFiles, ...configs, ...directories, ...appManifests]
  }
  for (const path of await inputPaths()) await copy(path)
  const dockerfile = await readFile(join(repository, 'products/power-evolve/deploy/Dockerfile'))
  await writeFile(join(destination, 'Dockerfile'), dockerfile)
  for (const file of files) {
    if (hash(await readFile(join(repository, file.path))) !== file.sha256) {
      await writeFile(join(destination, 'input-drift.json'), JSON.stringify({ file: file.path, expected: file.sha256 }) + '\n')
      throw new Error('Image input drift after source freeze: ' + file.path)
    }
  }
  const inventory = []
  async function inspect(path) {
    if (excluded(path)) return
    const entry = await lstat(join(repository, path))
    if (entry.isSymbolicLink()) throw new Error('Source context refuses symlinks: ' + path)
    if (entry.isDirectory()) { for (const name of await readdir(join(repository, path))) await inspect(path + '/' + name); return }
    if (!entry.isFile()) throw new Error('Source context requires ordinary files: ' + path)
    inventory.push(path)
  }
  for (const path of await inputPaths()) await inspect(path)
  if (JSON.stringify(inventory.toSorted()) !== JSON.stringify(files.map(file => file.path).toSorted())) {
    await writeFile(join(destination, 'input-drift.json'), JSON.stringify({ kind: 'source inventory changed', expectedFiles: files.length, observedFiles: inventory.length }) + '\n')
    throw new Error('Image input inventory drift after source freeze')
  }
  const finalRevisions = spawnSync('git', ['rev-parse', expected.officialTag + '^{commit}', 'HEAD'], { cwd: repository, encoding: 'utf8' })
  if (finalRevisions.status !== 0 || finalRevisions.stdout !== baseline.stdout) throw new Error('Image Git revisions changed during source freeze')
  const manifest = { version: 1, officialTag: expected.officialTag, baseline: revisions[0], currentCommit: revisions[1],
    sourceKind: 'fixed official baseline with current migration working-tree source', files: files.toSorted((a, b) => a.path.localeCompare(b.path)) }
  const manifestPath = join(destination, 'source/image-source.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 })
  await chmod(manifestPath, 0o644)
  await mkdir(join(destination, 'native-coverage'), { mode: 0o700 })
  await writeFile(join(destination, 'native-coverage/.keep'), '')
  await writeFile(join(destination, '.dockerignore'), '*\n!Dockerfile\n!source\n!source/**\n!native-coverage\n!native-coverage/**\n')
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository, destination, ...extra] = process.argv.slice(2)
  if (!repository || !destination || extra.length) throw new Error('Use cloud-image-context.mjs <checkout> <new-context>')
  const manifest = await cloudImageContext(repository, destination)
  console.log(JSON.stringify({ baseline: manifest.baseline, files: manifest.files.length }))
}
