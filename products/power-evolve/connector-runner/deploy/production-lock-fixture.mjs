/** Private per-case filesystem fixture for Connector lock and image-builder tests. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

/** Repository-relative Connector directory used by the private source fixtures. */
export const connectorProject = 'products/power-evolve/connector-runner'

/**
 * Allocate and finally remove a private source/deploy fixture, including when setup or the test fails.
 * @param use Async case receiving real small lock/manifest files and their writers.
 * @returns The case's result after its temporary directory has been removed.
 */
export async function withProductionLockFixture(use) {
  const root = await mkdtemp(join(tmpdir(), 'pe-connector-lock-test-'))
  const contexts = new Set()
  try {
    const manifestPath = join(root, connectorProject, 'package.json')
    const lockPath = join(root, 'pnpm-lock.yaml')
    const manifest = { name: '@power-evolve/connector-runner', version: '0.1.0', type: 'module',
      dependencies: { '@qa/client': '1.0.0' }, optionalDependencies: { 'qa-optional': '^3.0.0' },
      devDependencies: { 'qa-dev': '9.0.0' } }
    const importer = { dependencies: { '@qa/client': { specifier: '1.0.0', version: '1.0.0(@qa/peer@2.0.0)' } },
      optionalDependencies: { 'qa-optional': { specifier: '^3.0.0', version: '3.1.0' } },
      devDependencies: { 'qa-dev': { specifier: '9.0.0', version: '9.0.0' } } }
    const sourceLock = { lockfileVersion: '9.0', importers: { '.': {}, [connectorProject]: importer },
      packages: {}, snapshots: {
        '@qa/client@1.0.0(@qa/peer@2.0.0)': {
          dependencies: { 'qa-leaf': '1.2.0', '@qa/peer': '2.0.0' },
          optionalDependencies: { 'qa-cpu': '0.1.0' }, transitivePeerDependencies: ['@qa/peer'],
        },
        'qa-leaf@1.2.0': {}, '@qa/peer@2.0.0': {}, 'qa-cpu@0.1.0': {},
        'qa-optional@3.1.0': { dependencies: { 'qa-leaf': '1.2.0' }, optionalDependencies: { 'qa-optional-leaf': '0.2.0' } },
        'qa-optional-leaf@0.2.0': {}, 'qa-dev@9.0.0': {},
      } }
    for (const key of Object.keys(sourceLock.snapshots)) {
      sourceLock.packages[key.split('(')[0]] = { resolution: { integrity: `sha512-${Buffer.from(key).toString('base64')}` } }
    }
    Object.assign(sourceLock.packages['@qa/client@1.0.0'], { peerDependencies: { '@qa/peer': '^2.0.0' },
      peerDependenciesMeta: { '@qa/peer': { optional: true } }, engines: { node: '>=22' },
      cpu: ['x64'], os: ['linux'], libc: ['glibc'] })
    const deployedLock = structuredClone(sourceLock)
    deployedLock.importers = { '.': structuredClone(importer) }
    delete deployedLock.importers['.'].devDependencies
    const deployedManifest = structuredClone(manifest)
    delete deployedManifest.devDependencies
    const writeSourceLock = value => writeFile(lockPath, yaml.dump(value))
    const writeSourceManifest = value => writeFile(manifestPath, `${JSON.stringify(value)}\n`)
    const writeDeploy = async (context, lock = deployedLock, packageManifest = deployedManifest) => {
      contexts.add(context)
      await mkdir(join(context, 'node_modules/.pnpm'), { recursive: true })
      await writeFile(join(context, 'node_modules/.pnpm/lock.yaml'), yaml.dump(lock))
      await writeFile(join(context, 'package.json'), `${JSON.stringify(packageManifest)}\n`)
    }
    await mkdir(join(root, connectorProject), { recursive: true })
    await writeSourceLock(sourceLock)
    await writeSourceManifest(manifest)
    return await use({ root, lockPath, manifestPath, sourceLock, manifest, deployedLock, deployedManifest,
      context: join(root, 'context'), ownContext: context => contexts.add(context),
      writeSourceLock, writeSourceManifest, writeDeploy })
  } finally {
    const errors = []
    for (const path of [...contexts, root]) {
      try { await rm(path, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Connector test fixture cleanup failed')
  }
}
