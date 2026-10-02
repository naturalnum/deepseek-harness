import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { validateDeploymentBackupConfig, restoreDeploymentBackup } from './backup.mjs'
import { verifyBackupPgTools } from '../scripts/backup-support.mjs'

function config(root) {
  return { format: 1, scope: { context: 'fixture-context', namespace: 'pe-target', runnerNamespace: 'pe-target-runners',
    connectorNamespace: 'pe-target-connectors', appImage: 'registry/app@sha256:' + 'a'.repeat(64) },
  postgres: { urlFile: join(root, 'database-url'), database: 'fixture-target', role: 'fixture-role' },
  storageRoot: join(root, 'target-data'), bundle: join(root, 'bundle'), fenceFile: join(root, 'fence.json'),
  private: { projectedRoot: join(root, 'target-private'), ssh: false, remoteMcp: false, notesCa: false } }
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'pe-deployment-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function bundle(config, root) {
  await mkdir(config.bundle, { mode: 0o700 })
  const bytes = Buffer.from('unopened dump sentinel'), path = 'database.dump'
  await writeFile(join(config.bundle, path), bytes, { mode: 0o600 })
  const manifest = { format: 3, kind: 'power-evolve-deployment-backup', schema: 27, packages: [],
    sourceDatabase: { cluster: 'b'.repeat(64), database: '10000', name: 'fixture-source' },
    sourceStorageRoot: join(root, 'source-data'), sourcePrivateRoot: join(root, 'source-private'),
    files: [{ path, kind: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o600 }] }
  await writeFile(join(config.bundle, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  return manifest
}
const noInfrastructure = { requireEmptyTargetNamespaces() { assert.fail('preflight must precede infrastructure access') } }

test('deployment configuration rejects inline secrets, implicit roots and ambiguous namespace scopes', () => {
  const good = config('/private-fixture')
  assert.equal(validateDeploymentBackupConfig(good), good)
  for (const edit of [
    value => { value.postgres.url = 'postgres://inline-credential' },
    value => { value.storageRoot = '/' }, value => { value.storageRoot = '/data/../other' },
    value => { value.private.remoteMcp = 'true' }, value => { value.scope.runnerNamespace = value.scope.namespace },
    value => { value.scope.appImage = 'registry/app:latest' }, value => { value.scope.context = 'context\nother' },
    value => { value.postgres.commandTimeoutMs = 0 }, value => { value.postgres.commandTimeoutMs = '1000' },
  ]) {
    const bad = structuredClone(good); edit(bad)
    assert.throws(() => validateDeploymentBackupConfig(bad), /Invalid/)
  }
})

test('altered dump bytes fail before any target directory, credential read or Kubernetes access', async t => {
  const root = await temporary(t), values = config(root)
  await bundle(values, root)
  await writeFile(join(values.bundle, 'database.dump'), 'altered sentinel', { mode: 0o600 })
  await assert.rejects(restoreDeploymentBackup(values, noInfrastructure), /integrity mismatch/)
  await assert.rejects(readFile(values.postgres.urlFile), { code: 'ENOENT' })
  await assert.rejects(readFile(join(values.private.projectedRoot, 'worker-token')), { code: 'ENOENT' })
})

test('symlink alias to source storage is refused before private bytes or database restoration', async t => {
  const root = await temporary(t), values = config(root)
  const manifest = await bundle(values, root)
  await mkdir(manifest.sourceStorageRoot)
  await symlink(manifest.sourceStorageRoot, values.storageRoot)
  await assert.rejects(restoreDeploymentBackup(values, noInfrastructure), /paths overlap/)
  assert.equal(await readFile(join(values.bundle, 'database.dump'), 'utf8'), 'unopened dump sentinel')
})

test('missing package version metadata is refused before target mutation', async t => {
  const root = await temporary(t), values = config(root), manifest = await bundle(values, root)
  delete manifest.packages
  await writeFile(join(values.bundle, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  await assert.rejects(restoreDeploymentBackup(values, noInfrastructure), /Invalid Deployment backup manifest/)
})

test('PostgreSQL tool hangs reach a bounded failure without connection diagnostics', { timeout: 5000 }, async t => {
  const root = await temporary(t), script = join(root, 'psql')
  await writeFile(script, `#!${process.execPath}\nsetTimeout(() => {}, 60000)\n`, { mode: 0o700 })
  class FixtureClient {
    async connect() {}
    async query() { return { rows: [{ cluster: 'fixture-cluster', database: '10000', name: 'fixture' }] } }
    async end() {}
  }
  const started = Date.now()
  await assert.rejects(verifyBackupPgTools(FixtureClient, 'postgres://fixture:sentinel-password@127.0.0.1/fixture',
    { PE_BACKUP_PG_BIN_DIR: root, PE_BACKUP_PG_COMMAND_TIMEOUT_MS: 1000 }), error => {
    assert.equal(error.message, 'Backup PostgreSQL psql failed')
    return true
  })
  assert(Date.now() - started < 4000)
})
