/** Command substitutes write real deploy files and verify the lock gate plus actual temporary-context removal. */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { buildAndImport, connectorImageConfig } from './build-and-import.mjs'
import { readConnectorProductionLock } from './production-lock.mjs'
import { withProductionLockFixture } from './production-lock-fixture.mjs'

const image = 'registry.qa.invalid:5000/pe-connector-runner:qa'
const cluster = 'pe-release-qa'

function recorder(fixture, failCommand, mutateDeploy, beforeCommand) {
  const calls = []
  let context
  return { calls, context: () => context, async execute(command, args, environment) {
    calls.push({ command, args: [...args], strict: environment.npm_config_strict_dep_builds,
      ignoreScripts: environment.npm_config_ignore_scripts })
    await beforeCommand?.(command, args)
    if (command === 'pnpm' && args.includes('deploy')) {
      context = args.at(-1)
      fixture.ownContext(context)
      const lock = structuredClone(fixture.deployedLock)
      await mutateDeploy?.(lock)
      await fixture.writeDeploy(context, lock)
      await writeFile(join(context, 'artifact-marker'), 'fixture only\n', { mode: 0o600 })
    }
    if (command === 'docker') assert.equal(await readFile(join(context, 'artifact-marker'), 'utf8'), 'fixture only\n')
    if (command === failCommand) throw new Error(`injected ${command} failure`)
  } }
}

const fixtureSource = fixture => () => readConnectorProductionLock(fixture.root)

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

test('build-only verifies real deployed metadata, builds Docker, and removes its temporary context', async () => {
  await withProductionLockFixture(async fixture => {
    const record = recorder(fixture)
    assert.deepEqual(await buildAndImport(['--build-only'], { PE_CONNECTOR_IMAGE: image }, record.execute, fixtureSource(fixture)),
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
})

test('no flags preserve verified build plus import into exactly the named cluster', async () => {
  await withProductionLockFixture(async fixture => {
    const record = recorder(fixture)
    assert.deepEqual(await buildAndImport([], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: cluster }, record.execute,
      fixtureSource(fixture)), { image, cluster })
    assert.deepEqual(record.calls.map(call => call.command), ['pnpm', 'pnpm', 'docker', 'k3d'])
    assert.deepEqual(record.calls[3].args, ['image', 'import', image, '-c', cluster])
    await assert.rejects(stat(record.context()), { code: 'ENOENT' })
  })
})

for (const command of ['docker', 'k3d']) {
  test(`${command} failure rejects and removes the temporary artifact before returning`, async () => {
    await withProductionLockFixture(async fixture => {
      const record = recorder(fixture, command)
      await assert.rejects(buildAndImport([], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: cluster }, record.execute,
        fixtureSource(fixture)), new RegExp(`injected ${command} failure`, 'u'))
      assert.equal(record.calls.at(-1).command, command)
      await assert.rejects(stat(record.context()), { code: 'ENOENT' })
    })
  })
}

for (const [name, mutate] of [
  ['version drift', lock => { lock.importers['.'].dependencies['@qa/client'].version = '999.0.0' }],
  ['integrity drift', lock => { lock.packages['qa-leaf@1.2.0'].resolution.integrity = 'sha512-drift' }],
  ['missing optional dependency', lock => { delete lock.snapshots['qa-optional-leaf@0.2.0'] }],
]) {
  test(`${name} blocks both Docker and k3d and removes the actual context`, async () => {
    await withProductionLockFixture(async fixture => {
      const record = recorder(fixture, undefined, mutate)
      await assert.rejects(buildAndImport([], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: cluster }, record.execute,
        fixtureSource(fixture)), /Connector production lock:/u)
      assert.deepEqual(record.calls.map(call => call.command), ['pnpm', 'pnpm'])
      await assert.rejects(stat(record.context()), { code: 'ENOENT' })
    })
  })
}

test('source lock changes during build block Docker and k3d without changing the real repository lock', async () => {
  await withProductionLockFixture(async fixture => {
    const record = recorder(fixture, undefined, undefined, async (command, args) => {
      if (command === 'pnpm' && args.includes('build')) {
        await writeFile(fixture.lockPath, `${await readFile(fixture.lockPath, 'utf8')}# changed in build\n`)
      }
    })
    await assert.rejects(buildAndImport([], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: cluster }, record.execute,
      fixtureSource(fixture)), /source lock changed during preparation/u)
    assert.deepEqual(record.calls.map(call => call.command), ['pnpm', 'pnpm'])
    await assert.rejects(stat(record.context()), { code: 'ENOENT' })
  })
})

test('failed deploy preserves its command failure and cleans up before trying to read artifact metadata', async () => {
  await withProductionLockFixture(async fixture => {
    const calls = []
    let context
    await assert.rejects(buildAndImport(['--build-only'], { PE_CONNECTOR_IMAGE: image }, async (command, args) => {
      calls.push(command)
      if (args.includes('deploy')) {
        context = args.at(-1)
        fixture.ownContext(context)
        throw new Error('deploy failed before writing files')
      }
    }, fixtureSource(fixture)), /deploy failed before writing files/u)
    assert.deepEqual(calls, ['pnpm', 'pnpm'])
    await assert.rejects(stat(context), { code: 'ENOENT' })
  })
})

test('default source reader rejects a real zod drift artifact before Docker', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const bytes = await readFile(join(root, 'pnpm-lock.yaml'))
  const lock = yaml.load(bytes.toString('utf8'))
  const manifest = JSON.parse(await readFile(join(root, 'products/power-evolve/connector-runner/package.json'), 'utf8'))
  lock.importers['products/power-evolve/connector-runner'].dependencies.zod = { specifier: '999.0.0', version: '999.0.0' }
  manifest.dependencies.zod = '999.0.0'
  const calls = []
  let context
  try {
    await assert.rejects(buildAndImport([], { PE_CONNECTOR_IMAGE: image, PE_K3D_CLUSTER: cluster }, async (command, args) => {
      calls.push(command)
      if (args.includes('deploy')) {
        context = args.at(-1)
        await mkdir(join(context, 'node_modules/.pnpm'), { recursive: true })
        await writeFile(join(context, 'node_modules/.pnpm/lock.yaml'), yaml.dump(lock))
        await writeFile(join(context, 'package.json'), `${JSON.stringify(manifest)}\n`)
      }
    }), /Connector production lock:/u)
    assert.deepEqual(calls, ['pnpm', 'pnpm'])
    await assert.rejects(stat(context), { code: 'ENOENT' })
    assert.deepEqual(await readFile(join(root, 'pnpm-lock.yaml')), bytes)
  } finally { if (context) await rm(context, { recursive: true, force: true }) }
})

test('temporary deploy contexts are private on POSIX', {
  skip: process.platform === 'win32' ? 'Windows does not expose POSIX directory permissions' : false,
}, async () => {
  await withProductionLockFixture(async fixture => {
    const record = recorder(fixture, undefined, undefined, async (command, args) => {
      if (command === 'pnpm' && args.includes('deploy')) {
        fixture.ownContext(args.at(-1))
        assert.equal((await stat(args.at(-1))).mode & 0o777, 0o700)
      }
    })
    await buildAndImport(['--build-only'], { PE_CONNECTOR_IMAGE: image }, record.execute, fixtureSource(fixture))
    await assert.rejects(stat(record.context()), { code: 'ENOENT' })
  })
})

test('invalid configuration rejects before reading source or executing a command', async () => {
  let read = false, executed = false
  await assert.rejects(buildAndImport([], { PE_CONNECTOR_IMAGE: image }, async () => { executed = true },
    async () => { read = true }), /explicit cluster/u)
  assert.equal(read, false)
  assert.equal(executed, false)
})
