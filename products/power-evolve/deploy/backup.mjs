/** Operator backup of stopped application Deployments; restore never starts target workloads. */
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { captureDeploymentBackupFence, stopDeploymentBackupWriters,
  requireDeploymentBackupStopped, restoreDeploymentBackupWriters } from './backup-lifecycle.mjs'
import { captureDeploymentPrivate, prepareRestoredDeploymentPrivate, writeRestoredDeploymentPrivate } from './backup-private.mjs'
import { inventoryBackupTree, inspectBackupState, requireIdleBackupState } from '../scripts/backup-state.mjs'
import { requireSeparateBackupPaths, verifyBackupPgTools, requireEmptyBackupDatabase,
  dumpBackupDatabase, restoreBackupDatabase } from '../scripts/backup-support.mjs'
import { copyPosixTree, requireSkillPackageVersions, prepareRestoredSkillMounts,
  prepareRestoredExecutionMounts } from '../scripts/backup-posix.mjs'
import { validateOfficeBackupSelection, readOfficeBackupSelection, officeBackupCensus, validateOfficeBackupCensus, captureOfficeBackup,
  prepareRestoredOfficeBackup, writeRestoredOfficeBackup, verifyRestoredOfficeBackup } from '../scripts/backup-office.mjs'

const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const dataNames = ['workspaces', 'homes', 'skill-packages', 'artifacts']
const self = fileURLToPath(import.meta.url)
async function exists(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function readJson(path) {
  if (!(await lstat(path)).isFile()) throw new Error('Backup metadata must be a regular file')
  return JSON.parse(await readFile(path, 'utf8'))
}
function absolute(path) {
  return typeof path === 'string' && isAbsolute(path) && path !== '/'
    && resolve(path) === path && !/[\u0000-\u001f\u007f]/u.test(path)
}
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key))
}

/** Validate explicit physical roots, private URL file and expected database/role before any mutation. */
export function validateDeploymentBackupConfig(config) {
  if (!exact(config, ['format', 'scope', 'postgres', 'storageRoot', 'private', 'bundle', 'fenceFile', 'officePreview'])
    || config.format !== 1 || !absolute(config.storageRoot) || !absolute(config.bundle) || !absolute(config.fenceFile)
    || !exact(config.postgres, ['urlFile', 'database', 'role', 'container', 'host', 'port', 'binDir', 'commandTimeoutMs'])
    || !absolute(config.postgres.urlFile) || typeof config.postgres.database !== 'string' || !config.postgres.database
    || typeof config.postgres.role !== 'string' || !config.postgres.role
    || !exact(config.private, ['projectedRoot', 'ssh', 'remoteMcp', 'notesCa']) || !absolute(config.private.projectedRoot)
    || !['ssh', 'remoteMcp', 'notesCa'].every(key => typeof config.private[key] === 'boolean')) {
    throw new Error('Invalid Deployment backup configuration')
  }
  validateOfficeBackupSelection(config.officePreview)
  for (const key of ['container', 'host', 'port', 'binDir']) {
    if (config.postgres[key] !== undefined && (typeof config.postgres[key] !== 'string' || !config.postgres[key]
      || /[\u0000-\u001f\u007f]/u.test(config.postgres[key]))) throw new Error('Invalid backup PostgreSQL tools')
  }
  const timeout = config.postgres.commandTimeoutMs ?? 900000
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 3600000) throw new Error('Invalid backup PostgreSQL command timeout')
  const scope = config.scope
  if (!exact(scope, ['context', 'namespace', 'runnerNamespace', 'connectorNamespace', 'appImage'])
    || typeof scope.context !== 'string' || !scope.context || /[\u0000-\u0020\u007f]/u.test(scope.context)
    || !['namespace', 'runnerNamespace', 'connectorNamespace'].every(key => typeof scope[key] === 'string'
      && /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(scope[key]))
    || new Set([scope.namespace, scope.runnerNamespace, scope.connectorNamespace]).size !== 3
    || typeof scope.appImage !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/u.test(scope.appImage)) {
    throw new Error('Invalid Deployment backup scope')
  }
  return config
}
function pgEnv(config) {
  const keys = { container: 'PE_BACKUP_PG_CONTAINER', host: 'PE_BACKUP_PG_HOST', port: 'PE_BACKUP_PG_PORT',
    binDir: 'PE_BACKUP_PG_BIN_DIR', commandTimeoutMs: 'PE_BACKUP_PG_COMMAND_TIMEOUT_MS' }
  return Object.fromEntries(Object.entries(keys).filter(([key]) => config.postgres[key] !== undefined)
    .map(([key, variable]) => [variable, String(config.postgres[key])]))
}
async function durableJson(path, record) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); await handle.sync() }
  finally { await handle.close() }
  try { await rename(temporary, path) }
  catch (error) { await rm(temporary, { force: true }); throw error }
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
  try { await parent.sync() }
  finally { await parent.close() }
}

/** Bind every Kubernetes request to the configured context and a finite API/process timeout. */
export function deploymentBackupIO(config) {
  const run = args => {
    const result = spawnSync('kubectl', ['--context', config.scope.context, '--request-timeout=15s', ...args],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error('Deployment backup Kubernetes request failed')
    return result.stdout
  }
  const list = (namespace, resource) => {
    const value = JSON.parse(run(['-n', namespace, 'get', resource, '-o', 'json']))
    if (!Array.isArray(value.items)) throw new Error('Invalid Deployment backup Kubernetes list')
    return value.items
  }
  return {
    getDeployment: async (namespace, name) => JSON.parse(run(['-n', namespace, 'get', 'deployment', name, '-o', 'json'])),
    getPods: async namespace => list(namespace, 'pods'),
    getSandboxes: async namespace => list(namespace, 'sandboxes.agents.x-k8s.io'),
    getAutoscalers: async namespace => list(namespace, 'horizontalpodautoscalers'),
    patchDeployment: async (namespace, name, patch) => {
      run(['-n', namespace, 'patch', 'deployment', name, '--type=json', '-p', JSON.stringify(patch)])
    },
    saveFence: record => durableJson(config.fenceFile, record),
    async requireEmptyTargetNamespaces() {
      for (const namespace of [config.scope.namespace, config.scope.runnerNamespace, config.scope.connectorNamespace]) {
        const found = run(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name']).trim()
        if (!found) continue
        if (list(namespace, 'deployments').length || list(namespace, 'pods').length) {
          throw new Error('Restore target namespace has workloads')
        }
        if (namespace === config.scope.runnerNamespace && list(namespace, 'sandboxes.agents.x-k8s.io').length) {
          throw new Error('Restore target namespace has Sandboxes')
        }
      }
    },
  }
}
async function database(config) {
  const metadata = await lstat(config.postgres.urlFile)
  if (!metadata.isFile() || metadata.mode & 0o077) throw new Error('Database URL file must be private and regular')
  const url = (await readFile(config.postgres.urlFile, 'utf8')).trim()
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000, statement_timeout: 5000,
    query_timeout: 6000, options: '-c default_transaction_read_only=on' })
  try {
    await client.connect()
    const { rows: [actual] } = await client.query('SELECT current_database() AS database, current_user AS role')
    if (actual.database !== config.postgres.database || actual.role !== config.postgres.role) {
      throw new Error('Backup database or role differs from configuration')
    }
  } catch { throw new Error('Cannot verify configured backup database and role') }
  finally { await client.end().catch(() => {}) }
  return { url, identity: await verifyBackupPgTools(Client, url, pgEnv(config)) }
}
async function loadFence(config) {
  const fence = await readJson(config.fenceFile)
  if (!isDeepStrictEqual(fence.scope, config.scope)) throw new Error('Saved backup fence scope differs from configuration')
  return fence
}
async function requireRealRoot(path) {
  const value = await lstat(path)
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('Backup data root must be a real directory')
}

/** Create an atomic bundle after stopping exact writers; failure keeps them stopped for operator reconciliation. */
export async function createDeploymentBackup(config, io = deploymentBackupIO(config)) {
  validateDeploymentBackupConfig(config)
  await requireSeparateBackupPaths([config.bundle, config.fenceFile], [config.storageRoot, config.private.projectedRoot])
  await requireSeparateBackupPaths([config.bundle], [config.fenceFile, config.postgres.urlFile])
  if (await exists(config.bundle)) throw new Error('Backup destination already exists')
  await requireRealRoot(config.storageRoot)
  for (const name of dataNames) await requireRealRoot(join(config.storageRoot, name))
  const { url, identity } = await database(config)
  const before = await inspectBackupState(Client, url)
  requireIdleBackupState(before)
  const office = await readOfficeBackupSelection(config.officePreview, dataNames.map(name => join(config.storageRoot, name)))
  if (office && office.settings.namespace !== config.scope.runnerNamespace) throw new Error('Office cache backup namespace differs from runner scope')
  if (!office && officeBackupCensus(before).byteRecords) throw new Error('Recorded Office jobs require explicit cache backup configuration')
  if (office) await requireSeparateBackupPaths([office.selection.cacheRoot], [config.bundle, config.fenceFile, config.postgres.urlFile, config.private.projectedRoot])
  if (before.sshRecords && !config.private.ssh || before.mcpRecords && !config.private.remoteMcp) {
    throw new Error('Backup must retain configured SSH/MCP credential material')
  }
  // Validate keys and file bytes before any source outage. The stage stays private and unpublished.
  const stage = `${config.bundle}.${randomBytes(8).toString('hex')}.tmp`
  await mkdir(stage, { mode: 0o700 })
  try {
    const privateMaterial = await captureDeploymentPrivate(config.private.projectedRoot, stage,
      { ssh: config.private.ssh, remoteMcp: config.private.remoteMcp, notesCa: config.private.notesCa })
    const fence = await exists(config.fenceFile) ? await loadFence(config) : await captureDeploymentBackupFence(config.scope, io)
    await stopDeploymentBackupWriters(fence, io)
    const state = await inspectBackupState(Client, url)
    requireIdleBackupState(state)
    await requireSkillPackageVersions(join(config.storageRoot, 'skill-packages'), state.packages)
    await requireDeploymentBackupStopped(fence, io)
    dumpBackupDatabase(join(stage, 'database.dump'), url, pgEnv(config))
    await mkdir(join(stage, 'data'), { mode: 0o700 })
    for (const name of dataNames) await copyPosixTree(join(config.storageRoot, name), join(stage, 'data', name))
    const officeCache = await captureOfficeBackup(office, stage, state)
    await requireDeploymentBackupStopped(fence, io)
    const after = await inspectBackupState(Client, url)
    requireIdleBackupState(after)
    if (!isDeepStrictEqual(officeBackupCensus(after), officeBackupCensus(state))) throw new Error('Office census changed during backup')
    const files = await inventoryBackupTree(stage)
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ format: 4, kind: 'power-evolve-deployment-backup',
      capturedAt: Date.now(), schema: state.schema, sourceDatabase: identity, sourceRole: config.postgres.role,
      sourceScope: config.scope, sourceStorageRoot: config.storageRoot, sourcePrivateRoot: config.private.projectedRoot,
      sourceFence: fence, privateMaterial, packages: state.packages, officeCache, officeCensus: officeBackupCensus(state), files }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(stage, config.bundle)
    return { bundle: config.bundle, schema: state.schema, files: files.length, keptStopped: true }
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}

/** Restore bytes into a new empty database and roots; target deployment remains a separate reviewed action. */
export async function restoreDeploymentBackup(config, io = deploymentBackupIO(config)) {
  validateDeploymentBackupConfig(config)
  const manifest = await readJson(join(config.bundle, 'manifest.json'))
  if (![3, 4].includes(manifest.format) || manifest.kind !== 'power-evolve-deployment-backup'
    || !Number.isInteger(manifest.schema) || manifest.schema < 18 || !Array.isArray(manifest.files) || !Array.isArray(manifest.packages)
    || !absolute(manifest.sourceStorageRoot) || !absolute(manifest.sourcePrivateRoot)
    || !/^[a-f0-9]{64}$/u.test(manifest.sourceDatabase?.cluster ?? '')
    || !/^[0-9]+$/u.test(manifest.sourceDatabase?.database ?? '')
    || typeof manifest.sourceDatabase.name !== 'string' || !manifest.sourceDatabase.name) throw new Error('Invalid Deployment backup manifest')
  const files = (await inventoryBackupTree(config.bundle)).filter(file => file.path !== 'manifest.json')
  if (!isDeepStrictEqual(files, manifest.files)) throw new Error('Deployment backup integrity mismatch')
  await requireSeparateBackupPaths([config.storageRoot, config.private.projectedRoot],
    [manifest.sourceStorageRoot, manifest.sourcePrivateRoot, config.bundle, config.postgres.urlFile, config.fenceFile,
      ...(manifest.officeCache ? [manifest.officeCache.sourceCacheRoot] : [])])
  await requireSeparateBackupPaths([config.storageRoot], [config.private.projectedRoot])
  if (manifest.format === 3 && (Object.hasOwn(manifest, 'officeCache') || Object.hasOwn(manifest, 'officeCensus'))) {
    throw new Error('Legacy Deployment backup cannot contain new Office mappings')
  }
  if (manifest.format === 4 && (!Object.hasOwn(manifest, 'officeCache') || !Object.hasOwn(manifest, 'officeCensus'))) {
    throw new Error('Deployment backup omits Office census or mapping')
  }
  if (manifest.format === 4) validateOfficeBackupCensus(manifest.officeCensus, manifest.officeCache)
  const office = await readOfficeBackupSelection(config.officePreview, dataNames.map(name => join(config.storageRoot, name)))
  if (office && office.settings.namespace !== config.scope.runnerNamespace) throw new Error('Office cache restore namespace differs from runner scope')
  const officePrepared = await prepareRestoredOfficeBackup(manifest.officeCache, config.bundle, office,
    [...dataNames.map(name => join(config.storageRoot, name)), config.private.projectedRoot,
      config.postgres.urlFile, config.fenceFile, manifest.sourceStorageRoot, manifest.sourcePrivateRoot])
  if (await exists(config.storageRoot)) throw new Error('Restore storage root must be new')
  const prepared = await prepareRestoredDeploymentPrivate(manifest.privateMaterial, config.bundle, config.private.projectedRoot)
  if (!isDeepStrictEqual(manifest.privateMaterial.features,
    { ssh: config.private.ssh, remoteMcp: config.private.remoteMcp, notesCa: config.private.notesCa })) {
    throw new Error('Restore private feature selection differs from bundle')
  }
  validateDeploymentBackupConfig({ ...config, scope: manifest.sourceScope })
  if (manifest.sourceScope.context === config.scope.context
    && [config.scope.namespace, config.scope.runnerNamespace, config.scope.connectorNamespace]
      .some(namespace => [manifest.sourceScope.namespace, manifest.sourceScope.runnerNamespace, manifest.sourceScope.connectorNamespace]
        .includes(namespace))) throw new Error('Restore requires independent target namespaces')
  await io.requireEmptyTargetNamespaces()
  const { url, identity } = await database(config)
  if (identity.cluster === manifest.sourceDatabase.cluster
    && (identity.database === manifest.sourceDatabase.database || identity.name === manifest.sourceDatabase.name)) {
    throw new Error('Restore database overlaps the source')
  }
  await requireEmptyBackupDatabase(Client, url)
  await requireSkillPackageVersions(join(config.bundle, 'data/skill-packages'), manifest.packages)
  await mkdir(config.storageRoot, { mode: 0o700 })
  for (const name of dataNames) await copyPosixTree(join(config.bundle, 'data', name), join(config.storageRoot, name))
  await writeRestoredDeploymentPrivate(prepared)
  const officeRestored = await writeRestoredOfficeBackup(officePrepared)
  restoreBackupDatabase(join(config.bundle, 'database.dump'), url, pgEnv(config))
  const state = await inspectBackupState(Client, url)
  if (state.schema !== manifest.schema) throw new Error('Restored database schema differs from bundle')
  requireIdleBackupState(state)
  if (manifest.format === 4 && !isDeepStrictEqual(officeBackupCensus(state), manifest.officeCensus)) {
    throw new Error('Restored Office census differs; target remains stopped and partial')
  }
  await verifyRestoredOfficeBackup(manifest.officeCache, officeRestored, state)
  await io.requireEmptyTargetNamespaces()
  await requireSkillPackageVersions(join(config.storageRoot, 'skill-packages'), state.packages)
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000,
    statement_timeout: 5000, query_timeout: 6000, options: '-c default_transaction_read_only=on' })
  let skillMountPermissionsRepaired, executionEntriesPrepared
  try {
    await client.connect()
    const userIds = (await client.query('SELECT id FROM pe_users ORDER BY id')).rows.map(row => row.id)
    const storageRootKeys = (await client.query(state.schema >= 27
      ? 'SELECT root_key FROM pe_storage_spaces ORDER BY root_key'
      : 'SELECT id AS root_key FROM pe_workspaces ORDER BY id')).rows.map(row => row.root_key)
    skillMountPermissionsRepaired = await prepareRestoredSkillMounts(join(config.storageRoot, 'skill-packages'), userIds)
    executionEntriesPrepared = await prepareRestoredExecutionMounts(config.storageRoot, { userIds, storageRootKeys }, { uid: 1000, gid: 1000 })
  } finally { await client.end().catch(() => {}) }
  await chmod(config.storageRoot, 0o755)
  const evidence = { sourceCapturedAt: manifest.capturedAt, schema: state.schema, restoredAt: Date.now(),
    sourceDatabase: manifest.sourceDatabase, targetDatabase: identity, targetScope: config.scope,
    skillMountPermissionsRepaired, executionEntriesPrepared, officeRestored, officeCensus: officeBackupCensus(state), keptStopped: true, readinessChecked: false }
  await writeFile(join(config.private.projectedRoot, 'restore-evidence.json'), JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' })
  return evidence
}

async function main() {
  const [command, path, ...extra] = process.argv.slice(2)
  if (!['create', 'restore', 'resume', 'status'].includes(command) || !absolute(path) || extra.length) {
    throw new Error('Use backup.mjs create|restore|resume|status <absolute-private-config.json>')
  }
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.mode & 0o077) throw new Error('Backup configuration must be a private regular file')
  const config = validateDeploymentBackupConfig(await readJson(path))
  await requireSeparateBackupPaths([config.fenceFile], [config.storageRoot, config.private.projectedRoot, config.bundle, path])
  const lockPath = `${config.fenceFile}.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n'); await lock.sync()
    const io = deploymentBackupIO(config)
    let result
    if (command === 'create') result = await createDeploymentBackup(config, io)
    if (command === 'restore') result = await restoreDeploymentBackup(config, io)
    if (command === 'resume') result = await restoreDeploymentBackupWriters(await loadFence(config), io)
    if (command === 'status') { await requireDeploymentBackupStopped(await loadFence(config), io); result = { stopped: true } }
    console.log(JSON.stringify(command === 'resume' ? { phase: result.phase, replicasRestored: true, readinessChecked: false } : result))
  } finally { await lock.close(); await rm(lockPath) }
}
if (process.argv[1] && resolve(process.argv[1]) === self) await main().catch(() => {
  console.error('Deployment backup failed; inspect its private fence and target before retrying. Writers are not automatically resumed.')
  process.exitCode = 1
})
