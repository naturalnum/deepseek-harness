/** Build a deploy artifact without lifecycle scripts; import into one named k3d cluster unless --build-only is set. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(packageRoot, '../../..')
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed`)
}

/**
 * Require a tagged image; only the default import mode requires a named k3d cluster.
 * @param argv CLI flags; --build-only is the only supported flag.
 * @param environment Explicit image and cluster environment values.
 * @returns The image and optional import cluster; invalid flags or required values throw.
 */
export function connectorImageConfig(argv, environment) {
  if (argv.some(arg => arg !== '--build-only') || argv.length > 1) {
    throw new Error('Use build-and-import.mjs [--build-only]')
  }
  const image = environment.PE_CONNECTOR_IMAGE
  if (!image || !/^[a-z0-9][a-z0-9./:_-]*:[a-z0-9][a-z0-9._-]*$/u.test(image)) {
    throw new Error('Set PE_CONNECTOR_IMAGE to a tagged image')
  }
  if (argv.includes('--build-only')) return { image, cluster: undefined }
  const cluster = environment.PE_K3D_CLUSTER
  if (!cluster || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(cluster)) {
    throw new Error('Set PE_K3D_CLUSTER to an explicit cluster for image import')
  }
  return { image, cluster }
}

/**
 * Build an isolated deploy artifact and image, optionally import it, and remove the artifact on success or failure.
 * @param argv CLI flags; no flags preserves build plus import, --build-only omits import.
 * @param environment Command environment containing PE_CONNECTOR_IMAGE and, for import, PE_K3D_CLUSTER.
 * @param execute Awaited command runner; tests inject a recorder without spawning pnpm, Docker, or k3d.
 * @returns The built image and optional import cluster after all commands and cleanup complete.
 */
export async function buildAndImport(argv = [], environment = process.env, execute = run) {
  const config = connectorImageConfig(argv, environment)
  const context = await mkdtemp(join(tmpdir(), 'power-evolve-connector-image-'))
  try {
    await execute('pnpm', ['--filter', '@power-evolve/connector-runner', 'build'], environment)
    await execute('pnpm', ['--filter', '@power-evolve/connector-runner', 'deploy', '--legacy', '--prod',
      '--ignore-scripts', '--frozen-lockfile', context],
    { ...environment, npm_config_strict_dep_builds: 'true', npm_config_ignore_scripts: 'true' })
    await execute('docker', ['build', '-f', join(packageRoot, 'Dockerfile'), '-t', config.image, context], environment)
    if (config.cluster) await execute('k3d', ['image', 'import', config.image, '-c', config.cluster], environment)
    return config
  } finally {
    await rm(context, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { image, cluster } = await buildAndImport(process.argv.slice(2))
  console.log(cluster ? `Imported ${image} into k3d cluster ${cluster}` : `Built ${image}`)
}
