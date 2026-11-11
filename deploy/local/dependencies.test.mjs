import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { externalDependencyHash } from '../bundle.mjs'
import { preflight } from './dependencies.mjs'

const root = '/opt/dsh-installed-products'
const snapshot = { productRoot: root, nodePath: '/dsh-tools/node24', namespacePid: 20 }
const lock = 'importers:\n  cloud:\n    dependencies: {}\npackages:\n  package-one@1: {}\nsnapshots:\n  package-one@1: {}\n'
const researchLockHash = createHash('sha256').update('research fixture lock').digest('hex')
const manifest = { externalDependencyHash: externalDependencyHash(lock), researchLockHash }
const rgPath = `${root}/node_modules/@vscode/ripgrep-linux-arm64/bin/rg`
const observation = { architecture: 'arm64', nodeVersion: '24.19.0', pnpmLock: lock, researchLockHash,
  sshCommandPluginReady: true, rgPath, rgRealPath: rgPath, rgRegularFile: true }

function fixture(value = observation) {
  return { execute: async (actualSnapshot, args) => {
    assert.equal(actualSnapshot, snapshot)
    assert.equal(args[0], snapshot.nodePath)
    assert.equal(args[1], '-e')
    assert.equal(args[3], root)
    return JSON.stringify(value)
  } }
}

test('accepts workspace-importer-only changes and returns only whitelisted compatibility facts', async () => {
  const changedImporters = { ...observation, pnpmLock: lock.replace('dependencies: {}', 'dependencies:\n      local-package: workspace:*'), secret: 'never returned' }
  const result = await preflight(snapshot, manifest, fixture(changedImporters))
  assert.equal(result.compatible, true)
  assert.equal(result.externalDependencyHash, manifest.externalDependencyHash)
  assert.equal(result.rgPath, rgPath)
  assert.notEqual(result.pnpmLockHash, createHash('sha256').update(lock).digest('hex'))
  assert.deepEqual(Object.keys(result).sort(), ['compatible', 'externalDependencyHash', 'nodeVersion', 'pnpmLockHash', 'researchLockHash', 'rgPath', 'sshCommandPluginReady'].sort())
  assert.equal(JSON.stringify(result).includes('never returned'), false)
})

test('refuses changed external packages, snapshots or research dependencies before update', async () => {
  await assert.rejects(preflight(snapshot, manifest, fixture({ ...observation, pnpmLock: lock.replaceAll('package-one@1', 'package-one@2') })), /外部依赖不一致/)
  await assert.rejects(preflight(snapshot, manifest, fixture({ ...observation, pnpmLock: `${lock}  package-extra@2: {}\n` })), /外部依赖不一致/)
  await assert.rejects(preflight(snapshot, manifest, fixture({ ...observation, researchLockHash: 'different' })), /外部依赖不一致/)
  await assert.rejects(preflight(snapshot, { researchLockHash }, fixture()), /外部依赖不一致/)
})

test('refuses a missing SSH addon, a different ripgrep resolver path and linked or missing binaries', async () => {
  await assert.rejects(preflight(snapshot, manifest, fixture({ ...observation, sshCommandPluginReady: false })), /SSH 命令插件/)
  for (const change of [{ rgPath: `${root}/node_modules/.pnpm/ripgrep/bin/rg` },
    { rgRealPath: '/different/rg' }, { rgRegularFile: false }, { architecture: 'darwin' }]) {
    await assert.rejects(preflight(snapshot, manifest, fixture({ ...observation, ...change })), /文件搜索程序/)
  }
})

test('read failures and invalid lockfiles stop preflight without exposing command output', async () => {
  await assert.rejects(preflight(snapshot, manifest, { execute: async () => { throw new Error('private command payload') } }), error => {
    assert.match(error.message, /无法读取或解析/)
    assert.equal(error.message.includes('private command payload'), false)
    return true
  })
  await assert.rejects(preflight(snapshot, manifest, fixture({ ...observation, pnpmLock: 'not a dependency lock' })), /无法读取或解析/)
})
