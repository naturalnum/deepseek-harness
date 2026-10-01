/** Command recorders verify planning and temporary-artifact cleanup without spawning build or cluster tools. */
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildAndImport, connectorImageConfig } from './build-and-import.mjs'

const image = 'registry.qa.invalid:5000/pe-connector-runner:qa'
const cluster = 'pe-release-qa'

function recorder(failCommand) {
  const calls = []
  let context
  return { calls, context: () => context, async execute(command, args, environment) {
    calls.push({ command, args: [...args], strict: environment.npm_config_strict_dep_builds,
      ignoreScripts: environment.npm_config_ignore_scripts })
    if (command === 'pnpm' && args.includes('deploy')) {
      context = args.at(-1)
      assert.equal((await stat(context)).mode & 0o777, 0o700)
      await writeFile(join(context, 'artifact-marker'), 'fixture only\n', { mode: 0o600 })
    }
    if (command === 'docker') assert.equal(await readFile(join(context, 'artifact-marker'), 'utf8'), 'fixture only\n')
    if (command === failCommand) throw new Error(`injected ${command} failure`)
  } }
}

test('build-only accepts no cluster and ignores unrelated cluster configuration', () => {
  for (const value of [undefined, 'invalid cluster']) {
    assert.deepEqual(connectorImageConfig(['--build-only'], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: value }),
      { image, cluster: undefined })
  }
})

test('default import validates its explicit cluster, tagged image, and supported flags', () => {
  assert.deepEqual(connectorImageConfig([], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: cluster }), { image, cluster })
  for (const value of [undefined, 'invalid cluster']) {
    assert.throws(() => connectorImageConfig([], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: value }), /explicit cluster/u)
  }
  for (const value of [undefined, 'untagged-image']) {
    assert.throws(() => connectorImageConfig(['--build-only'], { PE_CONNECTOR_IMAGE: value }), /tagged image/u)
  }
  for (const flags of [['--unknown'], ['--build-only', '--build-only']]) {
    assert.throws(() => connectorImageConfig(flags, { PE_CONNECTOR_IMAGE: image }), /Use build-and-import/u)
  }
})

test('build-only plans strict deployment and Docker build, then removes its actual temporary artifact', async () => {
  const record = recorder()
  assert.deepEqual(await buildAndImport(['--build-only'], { PE_CONNECTOR_IMAGE: image }, record.execute),
    { image, cluster: undefined })
  assert.deepEqual(record.calls.map(call => call.command), ['pnpm', 'pnpm', 'docker'])
  assert.deepEqual(record.calls[0].args, ['--filter', '@power-evolve/connector-runner', 'build'])
  assert.deepEqual(record.calls[1].args, ['--filter', '@power-evolve/connector-runner', 'deploy', '--legacy', '--prod',
    '--ignore-scripts', '--frozen-lockfile', record.context()])
  assert.equal(record.calls[1].strict, 'true')
  assert.equal(record.calls[1].ignoreScripts, 'true')
  assert.deepEqual(record.calls[2].args.slice(-3), ['-t', image, record.context()])
  await assert.rejects(stat(record.context()), { code: 'ENOENT' })
})

test('no flags preserve build plus import into exactly the named cluster', async () => {
  const record = recorder()
  assert.deepEqual(await buildAndImport([], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: cluster }, record.execute),
    { image, cluster })
  assert.deepEqual(record.calls.map(call => call.command), ['pnpm', 'pnpm', 'docker', 'k3d'])
  assert.deepEqual(record.calls[3].args, ['image', 'import', image, '-c', cluster])
  await assert.rejects(stat(record.context()), { code: 'ENOENT' })
})

for (const command of ['docker', 'k3d']) {
  test(`${command} failure rejects and removes the temporary artifact before returning`, async () => {
    const record = recorder(command)
    await assert.rejects(buildAndImport([], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: cluster }, record.execute),
      new RegExp(`injected ${command} failure`, 'u'))
    assert.equal(record.calls.at(-1).command, command)
    await assert.rejects(stat(record.context()), { code: 'ENOENT' })
  })
}

test('invalid configuration rejects before executing a command', async () => {
  const record = recorder()
  await assert.rejects(buildAndImport([], { PE_CONNECTOR_IMAGE: image }, record.execute), /explicit cluster/u)
  assert.equal(record.calls.length, 0)
  assert.equal(record.context(), undefined)
})
