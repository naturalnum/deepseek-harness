/** Build the package deploy artifact without lifecycle scripts, then import its image into one named k3d cluster. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const image = process.env.PE_CONNECTOR_IMAGE
const cluster = process.env.PE_K3D_CLUSTER
if (!image || !/^[a-z0-9][a-z0-9./:_-]*:[a-z0-9][a-z0-9._-]*$/u.test(image)
  || !cluster || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(cluster)) {
  throw new Error('Set PE_CONNECTOR_IMAGE to a tagged image and PE_K3D_CLUSTER to an explicit cluster')
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(packageRoot, '../../..')
const context = await mkdtemp(join(tmpdir(), 'power-evolve-connector-image-'))
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed`)
}
try {
  run('pnpm', ['--filter', '@power-evolve/connector-runner', 'build'])
  run('pnpm', ['--filter', '@power-evolve/connector-runner', 'deploy', '--legacy', '--prod',
    '--ignore-scripts', '--frozen-lockfile', context],
  { ...process.env, npm_config_strict_dep_builds: 'true', npm_config_ignore_scripts: 'true' })
  run('docker', ['build', '-f', join(packageRoot, 'Dockerfile'), '-t', image, context])
  run('k3d', ['image', 'import', image, '-c', cluster])
  console.log(`Imported ${image} into k3d cluster ${cluster}`)
} finally {
  await rm(context, { recursive: true, force: true })
}
