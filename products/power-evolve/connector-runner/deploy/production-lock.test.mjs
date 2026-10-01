/** Filesystem cases reject production dependency drift without invoking package or container tools. */
import assert from 'node:assert/strict'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { readConnectorProductionLock, verifyConnectorProductionLock } from './production-lock.mjs'
import { connectorProject, withProductionLockFixture } from './production-lock-fixture.mjs'

for (const importer of ['.', connectorProject]) {
  test(`matching production and nested optional metadata passes with importer ${importer}`, async () => {
    await withProductionLockFixture(async fixture => {
      const source = await readConnectorProductionLock(fixture.root)
      const lock = structuredClone(fixture.deployedLock)
      lock.importers = { [importer]: lock.importers['.'] }
      lock.snapshots['@qa/client@1.0.0(@qa/peer@2.0.0)'].dependencies = { '@qa/peer': '2.0.0', 'qa-leaf': '1.2.0' }
      // Unreachable development metadata can be removed without affecting production.
      delete lock.packages['qa-dev@9.0.0']
      delete lock.snapshots['qa-dev@9.0.0']
      await fixture.writeDeploy(fixture.context, lock)
      const proof = await verifyConnectorProductionLock(source, fixture.context)
      assert.equal(proof.packages, 6)
      assert.match(proof.sourceLockSha256, /^[0-9a-f]{64}$/u)
      assert.match(proof.deployedLockSha256, /^[0-9a-f]{64}$/u)
    })
  })
}

const changes = [
  ['direct specifier', lock => { lock.importers['.'].dependencies['@qa/client'].specifier = '^1.0.0' }, /manifest dependencies/u],
  ['direct version', lock => { lock.importers['.'].dependencies['@qa/client'].version = '999.0.0' }, /snapshot .*missing/u],
  ['direct reference changed but resolving to the same snapshot', lock => {
    lock.importers['.'].dependencies['@qa/client'].version = '@qa/client@1.0.0(@qa/peer@2.0.0)'
  }, /direct dependencies changed/u],
  ['missing importer', lock => { lock.importers = {} }, /importer must be a mapping/u],
  ['package integrity', lock => { lock.packages['qa-leaf@1.2.0'].resolution.integrity = 'sha512-drift' }, /resolution changed/u],
  ['missing integrity', lock => { delete lock.packages['qa-leaf@1.2.0'].resolution.integrity }, /integrity .*missing/u],
  ['tarball resolution', lock => { lock.packages['qa-leaf@1.2.0'].resolution.tarball = 'https://qa.invalid/other.tgz' }, /resolution changed/u],
  ['missing direct optional snapshot', lock => { delete lock.snapshots['qa-optional@3.1.0'] }, /snapshot .*missing/u],
  ['missing nested optional snapshot', lock => { delete lock.snapshots['qa-optional-leaf@0.2.0'] }, /snapshot .*missing/u],
  ['missing optional package metadata', lock => { delete lock.packages['qa-cpu@0.1.0'] }, /package .*mapping/u],
  ['changed dependency edge with the same reachable packages', lock => {
    delete lock.snapshots['@qa/client@1.0.0(@qa/peer@2.0.0)'].dependencies['qa-leaf']
  }, /dependencies changed/u],
  ['removed optional edge', lock => {
    delete lock.snapshots['@qa/client@1.0.0(@qa/peer@2.0.0)'].optionalDependencies['qa-cpu']
  }, /snapshot keys changed/u],
  ['changed peer context snapshot key', lock => {
    lock.snapshots['@qa/client@1.0.0(@qa/peer@2.1.0)'] = lock.snapshots['@qa/client@1.0.0(@qa/peer@2.0.0)']
    delete lock.snapshots['@qa/client@1.0.0(@qa/peer@2.0.0)']
  }, /snapshot .*missing/u],
  ['changed transitive peers', lock => {
    lock.snapshots['@qa/client@1.0.0(@qa/peer@2.0.0)'].transitivePeerDependencies = []
  }, /transitivePeerDependencies changed/u],
  ['registry dependency replaced by a workspace link', lock => {
    lock.snapshots['@qa/client@1.0.0(@qa/peer@2.0.0)'].dependencies['qa-leaf'] = 'link:../elsewhere'
  }, /registry-only/u],
]

for (const [name, change, failure] of changes) {
  test(`${name} rejects the real deployed lockfile`, async () => {
    await withProductionLockFixture(async fixture => {
      const source = await readConnectorProductionLock(fixture.root)
      const deployed = structuredClone(fixture.deployedLock)
      change(deployed)
      await fixture.writeDeploy(fixture.context, deployed)
      await assert.rejects(verifyConnectorProductionLock(source, fixture.context), failure)
    })
  })
}

for (const [field, value] of [
  ['peerDependencies', { '@qa/peer': '^3.0.0' }],
  ['peerDependenciesMeta', { '@qa/peer': { optional: false } }],
  ['engines', { node: '>=24' }], ['cpu', ['arm64']], ['os', ['darwin']], ['libc', ['musl']],
]) {
  test(`${field} drift rejects an otherwise matching production graph`, async () => {
    await withProductionLockFixture(async fixture => {
      const source = await readConnectorProductionLock(fixture.root)
      const deployed = structuredClone(fixture.deployedLock)
      deployed.packages['@qa/client@1.0.0'][field] = value
      await fixture.writeDeploy(fixture.context, deployed)
      await assert.rejects(verifyConnectorProductionLock(source, fixture.context), new RegExp(`${field} changed`, 'u'))
    })
  })
}

test('a changed source lock rejects even when its production closure did not change', async () => {
  await withProductionLockFixture(async fixture => {
    const source = await readConnectorProductionLock(fixture.root)
    await fixture.writeDeploy(fixture.context)
    await writeFile(fixture.lockPath, `${await readFile(fixture.lockPath, 'utf8')}# changed during preparation\n`)
    await assert.rejects(verifyConnectorProductionLock(source, fixture.context), /source lock changed during preparation/u)
  })
})

test('byte-identical source replacement is rejected by file identity', async () => {
  await withProductionLockFixture(async fixture => {
    const source = await readConnectorProductionLock(fixture.root)
    await fixture.writeDeploy(fixture.context)
    const replacement = join(fixture.root, 'replacement-lock.yaml')
    await writeFile(replacement, await readFile(fixture.lockPath))
    await rename(replacement, fixture.lockPath)
    await assert.rejects(verifyConnectorProductionLock(source, fixture.context), /source lock changed during preparation/u)
  })
})

test('source manifest changes are rejected even when production specifiers are unchanged', async () => {
  await withProductionLockFixture(async fixture => {
    const source = await readConnectorProductionLock(fixture.root)
    await fixture.writeDeploy(fixture.context)
    await fixture.writeSourceManifest({ ...fixture.manifest, version: '0.2.0' })
    await assert.rejects(verifyConnectorProductionLock(source, fixture.context), /source manifest changed during preparation/u)
  })
})

test('a deployed manifest with changed specifiers rejects before image construction', async () => {
  await withProductionLockFixture(async fixture => {
    const source = await readConnectorProductionLock(fixture.root)
    const manifest = structuredClone(fixture.deployedManifest)
    manifest.dependencies['@qa/client'] = '^1.0.0'
    await fixture.writeDeploy(fixture.context, fixture.deployedLock, manifest)
    await assert.rejects(verifyConnectorProductionLock(source, fixture.context), /manifest dependencies changed/u)
  })
})

test('a self-consistent deployed manifest and importer still cannot change the source specifier', async () => {
  await withProductionLockFixture(async fixture => {
    const source = await readConnectorProductionLock(fixture.root)
    const manifest = structuredClone(fixture.deployedManifest)
    const lock = structuredClone(fixture.deployedLock)
    manifest.dependencies['@qa/client'] = '^1.0.0'
    lock.importers['.'].dependencies['@qa/client'].specifier = '^1.0.0'
    await fixture.writeDeploy(fixture.context, lock, manifest)
    await assert.rejects(verifyConnectorProductionLock(source, fixture.context), /direct dependencies changed/u)
  })
})

test('a present manifest cannot substitute for a missing production lockfile', async () => {
  await withProductionLockFixture(async fixture => {
    const source = await readConnectorProductionLock(fixture.root)
    await fixture.writeDeploy(fixture.context)
    await rm(join(fixture.context, 'node_modules/.pnpm/lock.yaml'))
    await assert.rejects(verifyConnectorProductionLock(source, fixture.context), { code: 'ENOENT' })
  })
})

test('missing production files cannot be accepted as an empty deployment', async () => {
  await withProductionLockFixture(async fixture => {
    const source = await readConnectorProductionLock(fixture.root)
    await assert.rejects(verifyConnectorProductionLock(source, fixture.context), { code: 'ENOENT' })
  })
})
