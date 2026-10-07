/** Stop writers, snapshot PG and POSIX bytes, then restore into a fresh trial. */
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { backupSourceRoots, copyPosixTree, prepareRestoredExecutionMounts, prepareRestoredSkillMounts,
  requireSkillPackageVersions, resolveTrialStorage, trialDataPath } from './backup-posix.mjs'
import { inspectBackupState, inventoryBackupTree, requireIdleBackupState } from './backup-state.mjs'
import { validateOfficeBackupSelection, readOfficeBackupSelection, officeBackupCensus, validateOfficeBackupCensus, captureOfficeBackup,
  prepareRestoredOfficeBackup, writeRestoredOfficeBackup, verifyRestoredOfficeBackup } from './backup-office.mjs'
import { backupDatabaseIdentity, requireEmptyBackupDatabase, requireSeparateBackupPaths,
  runningBackupTargets, requireNoKubernetesWriters, verifyBackupPgTools, dumpBackupDatabase, restoreBackupDatabase,
  captureBackupMcpConfiguration, prepareRestoredMcpConfiguration, writeRestoredMcpConfiguration } from './backup-support.mjs'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const command = process.argv[2]
const bundle = process.env.PE_BACKUP_BUNDLE
const trialName = process.env.PE_TRIAL_NAME
const privateDir = process.env.PE_PRIVATE_DIR
if (!['create', 'restore'].includes(command) || !bundle || !isAbsolute(bundle)
  || !trialName || !/^[a-z0-9-]{1,32}$/u.test(trialName)
  || !privateDir || !isAbsolute(privateDir)) {
  throw new Error('Set create|restore, absolute PE_BACKUP_BUNDLE, PE_TRIAL_NAME and absolute PE_PRIVATE_DIR')
}
const bundlePath = resolve(bundle)
const privatePath = resolve(privateDir)
if (!privatePath.startsWith(`${join(homedir(), '.config', 'power-evolve')}/`)) {
  throw new Error('Trial private directory must be under ~/.config/power-evolve')
}
const databaseMode = process.env.PE_TRIAL_DATABASE ?? 'compose'
if (!['compose', 'external'].includes(databaseMode)) throw new Error('PE_TRIAL_DATABASE must be compose or external')
if (process.env.PE_BACKUP_KEEP_STOPPED && process.env.PE_BACKUP_KEEP_STOPPED !== '1') {
  throw new Error('PE_BACKUP_KEEP_STOPPED must be 1 when set')
}
const keepStopped = process.env.PE_BACKUP_KEEP_STOPPED === '1'
const pgEnv = { ...process.env, ...(databaseMode === 'compose' && !process.env.PE_BACKUP_PG_CONTAINER
  ? { PE_BACKUP_PG_CONTAINER: `pe-shared-host-${trialName}-postgres-1` } : {}) }
const trialOutput = join(root, '.artifacts/power-evolve', trialName === 'slice1' ? '' : trialName)
const secretNames = ['users.json', 'worker-token', 'connector-key', 'model-key', 'model.env',
  'runner-key', 'ssh-credential-key', 'account-management.json', 'account-bootstrap.json']
const dataNames = ['workspaces', 'homes', 'skill-packages', 'artifacts']
const officeSelection = process.env.PE_BACKUP_OFFICE_CONFIG_FILE || process.env.PE_BACKUP_OFFICE_CACHE_ROOT
  ? validateOfficeBackupSelection({ configFile: process.env.PE_BACKUP_OFFICE_CONFIG_FILE,
    cacheRoot: process.env.PE_BACKUP_OFFICE_CACHE_ROOT }) : null
const officeKubeconfig = process.env.PE_BACKUP_OFFICE_KUBECONFIG_FILE
if (officeSelection && (!isAbsolute(officeKubeconfig ?? '') || resolve(officeKubeconfig) !== officeKubeconfig)) {
  throw new Error('Office backup requires explicit absolute PE_BACKUP_OFFICE_KUBECONFIG_FILE')
}
const trialScript = join(root, 'products/power-evolve/scripts/trial.mjs')
const prepareScript = join(root, 'products/power-evolve/scripts/prepare-trial.mjs')
const composeFiles = ['-f', 'products/power-evolve/compose.yaml',
  ...(process.env.PE_COMPOSE_EXTERNAL_NETWORK
    ? ['-f', 'products/power-evolve/compose.external-network.yaml'] : [])]

function run(exe, args, options = {}) {
  const result = spawnSync(exe, args, { cwd: root, env: process.env, encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`${basename(exe)} ${args[0] ?? ''} failed`)
  return result.stdout?.trim() ?? ''
}
async function exists(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function roots(requireRecorded = false) {
  const sandbox = await exists(join(privatePath, 'sandbox.json'))
    ? await json(join(privatePath, 'sandbox.json')) : null
  const shared = sandbox ? resolve(sandbox.localRoot) : privatePath
  if (sandbox && (resolve(sandbox.workspaceRoot) !== join(shared, 'workspaces')
    || !isAbsolute(sandbox.nodeRoot) || !sandbox.namespace)) {
    throw new Error('Sandbox POSIX root is inconsistent')
  }
  if (!(await exists(shared))?.isDirectory() || (await lstat(shared)).isSymbolicLink()) {
    throw new Error('Shared POSIX root must be a real directory')
  }
  const storage = await resolveTrialStorage(privatePath, sandbox, process.env, requireRecorded)
  return { sandbox, shared, storage }
}
async function waitStableDatabase(url) {
  const until = Date.now() + 30_000
  let consecutive = 0
  while (Date.now() < until) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 })
    try {
      await client.connect()
      await client.query('SELECT 1')
      if (++consecutive === 3) return
    } catch (_notReady) { consecutive = 0 }
    finally { await client.end().catch(() => {}) }
    await delay(300)
  }
  throw new Error('Restore PostgreSQL did not become stable')
}
if (command === 'create') {
  if (await exists(bundlePath)) throw new Error('Backup destination already exists')
  const { sandbox, shared, storage } = await roots(true)
  const office = await readOfficeBackupSelection(officeSelection, dataNames.map(name => trialDataPath(storage, name)))
  if (office) await requireSeparateBackupPaths([office.selection.cacheRoot], [bundlePath, privatePath])
  await requireSeparateBackupPaths([bundlePath], [privatePath, ...dataNames.map(name => trialDataPath(storage, name))])
  if (!(await exists(trialDataPath(storage, 'skill-packages')))?.isDirectory()) {
    throw new Error('Prepared Skill package storage is missing')
  }
  const originallyRunning = await runningBackupTargets(join(trialOutput, 'trial'))
  const stage = `${bundlePath}.partial-${randomBytes(5).toString('hex')}`
  await mkdir(dirname(bundlePath), { recursive: true, mode: 0o700 })
  await mkdir(stage, { mode: 0o700 })
  const stoppedTargets = []
  let backupError
  const startedAt = Date.now()
  try {
    for (const name of [...originallyRunning].reverse()) {
      run(process.execPath, [trialScript, 'stop-one', name])
      stoppedTargets.unshift(name)
    }
    const stoppedAt = Date.now()
    const databaseUrl = (await readFile(join(privatePath, 'database-url'), 'utf8')).trim()
    const status = await inspectBackupState(Client, databaseUrl)
    requireIdleBackupState(status)
    const ssh = await exists(join(privatePath, 'ssh.json')) ? await json(join(privatePath, 'ssh.json')) : null
    const officeScope = office ? { namespace: office.settings.namespace, kubeconfigFile: officeKubeconfig } : null
    requireNoKubernetesWriters({ sandbox, ssh, office: officeScope, sshRequired: status.sshQuarantined > 0 }, run)
    if (status.sshRecords && !(await exists(join(privatePath, 'ssh-credential-key')))?.isFile()) {
      throw new Error('Existing SSH history requires its credential key for backup')
    }
    await requireSkillPackageVersions(trialDataPath(storage, 'skill-packages'), status.packages)
    if (status.mcpRecords && !process.env.PE_REMOTE_MCP_CONFIG_FILE) {
      throw new Error('Existing MCP history requires explicit PE_REMOTE_MCP_CONFIG_FILE for backup')
    }
    const sourceDatabase = await verifyBackupPgTools(Client, databaseUrl, pgEnv)
    dumpBackupDatabase(join(stage, 'database.dump'), databaseUrl, pgEnv)
    await mkdir(join(stage, 'data'), { mode: 0o700 })
    for (const name of dataNames) await copyPosixTree(trialDataPath(storage, name),
      join(stage, 'data', name))
    await mkdir(join(stage, 'config'), { mode: 0o700 })
    const included = []
    for (const name of secretNames) {
      if (await exists(join(privatePath, name))) {
        await copyFile(join(privatePath, name), join(stage, 'config', name), constants.COPYFILE_EXCL)
        await chmod(join(stage, 'config', name), 0o600)
        included.push(name)
      }
    }
    if (!['users.json', 'worker-token', 'connector-key', 'model-key', 'model.env']
      .every(name => included.includes(name))) throw new Error('Required private configuration missing')
    const remoteMcp = await captureBackupMcpConfiguration(process.env.PE_REMOTE_MCP_CONFIG_FILE, stage)
    const officeCache = await captureOfficeBackup(office, stage, status)
    requireNoKubernetesWriters({ sandbox, ssh, office: officeScope, sshRequired: status.sshQuarantined > 0 }, run)
    const after = await inspectBackupState(Client, databaseUrl)
    requireIdleBackupState(after)
    if (JSON.stringify(officeBackupCensus(after)) !== JSON.stringify(officeBackupCensus(status))) {
      throw new Error('Office census changed during backup')
    }
    const files = await inventoryBackupTree(stage)
    const capturedAt = Date.now()
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify({ format: 3, sourceTrial: trialName,
      schema: status.schema, startedAt, stoppedAt, capturedAt, sourceSharedRoot: shared,
      sourcePrivateRoot: privatePath, sourceDatabase, ...(remoteMcp ? { remoteMcp } : {}),
      storage, configFiles: included, officeCache, officeCensus: officeBackupCensus(status), files }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(stage, bundlePath)
    console.log(`Backup ready; writer freeze ${capturedAt - stoppedAt} ms; bundle ${bundlePath}`)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    backupError = error
  } finally {
    if (stoppedTargets.length && !keepStopped) {
      try { for (const name of stoppedTargets) run(process.execPath, [trialScript, 'start-one', name]) }
      catch (error) {
        if (backupError) throw new AggregateError([backupError, error], 'Backup failed and source restart failed')
        throw error
      }
    }
  }
  if (backupError) throw backupError
} else {
  const startedAt = Date.now()
  const manifest = await json(join(bundlePath, 'manifest.json'))
  const sourceRoots = backupSourceRoots(manifest)
  if (!Number.isInteger(manifest.schema) || manifest.schema < 18
    || manifest.sourceTrial === trialName
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.configFiles)) {
    throw new Error('Unsupported backup or source/restore trial collision')
  }
  const actual = (await inventoryBackupTree(bundlePath)).filter(entry => entry.path !== 'manifest.json')
  // Older format-1/2 inventories did not record modes; their byte/link checks remain unchanged.
  const expectedFiles = new Map(manifest.files.map(file => [file.path, file]))
  const comparable = actual.map(file => {
    if (!Object.hasOwn(expectedFiles.get(file.path) ?? {}, 'mode')) { const { mode, ...legacy } = file; return legacy }
    return file
  })
  if (JSON.stringify(comparable) !== JSON.stringify(manifest.files)) {
    throw new Error('Backup integrity check failed before restore')
  }
  const { shared, sandbox, storage } = await roots()
  if (manifest.format < 3 && (Object.hasOwn(manifest, 'officeCache') || Object.hasOwn(manifest, 'officeCensus'))) {
    throw new Error('Legacy trial backup cannot contain new Office mappings')
  }
  if (manifest.format === 3 && (!Object.hasOwn(manifest, 'officeCache') || !Object.hasOwn(manifest, 'officeCensus'))) {
    throw new Error('Trial backup omits Office census or mapping')
  }
  if (manifest.format === 3) validateOfficeBackupCensus(manifest.officeCensus, manifest.officeCache)
  if ((manifest.officeCache || officeSelection) && !keepStopped) {
    throw new Error('Office restore requires PE_BACKUP_KEEP_STOPPED=1; enable reviewed deployment settings separately')
  }
  const office = await readOfficeBackupSelection(officeSelection, dataNames.map(name => trialDataPath(storage, name)))
  const officePrepared = await prepareRestoredOfficeBackup(manifest.officeCache, bundlePath, office,
    [privatePath, ...dataNames.map(name => trialDataPath(storage, name)), ...sourceRoots,
      ...(manifest.sourcePrivateRoot ? [manifest.sourcePrivateRoot] : [])])
  const targetRoots = [privatePath, shared, ...dataNames.map(name => trialDataPath(storage, name))]
  await requireSeparateBackupPaths(targetRoots,
    [...sourceRoots, bundlePath, ...(manifest.sourcePrivateRoot ? [manifest.sourcePrivateRoot] : [])])
  if ((await runningBackupTargets(join(trialOutput, 'trial'))).length) throw new Error('Restore target has live trial writers')
  const officeScope = office ? { namespace: office.settings.namespace, kubeconfigFile: officeKubeconfig } : null
  requireNoKubernetesWriters({ office: officeScope }, run)
  for (const name of dataNames) {
    const target = trialDataPath(storage, name)
    const current = await exists(target)
    if (current && (!current.isDirectory() || (await readdir(target)).length)) {
      throw new Error(`Restore target ${name} must be empty`)
    }
  }
  for (const name of manifest.configFiles) {
    if (!secretNames.includes(name) || await exists(join(privatePath, name))) {
      throw new Error('Restore config target must be fresh')
    }
  }
  const mcpPrepared = await prepareRestoredMcpConfiguration(manifest.remoteMcp, bundlePath, privatePath)
  if (mcpPrepared && await exists(mcpPrepared.directory)) throw new Error('Restore MCP config target must be fresh')
  let targetUrl
  if (databaseMode === 'external') {
    targetUrl = (await readFile(join(privatePath, 'database-url'), 'utf8')).trim()
    const targetIdentity = await verifyBackupPgTools(Client, targetUrl, pgEnv)
    let sourceIdentity = manifest.sourceDatabase
    if (!sourceIdentity) {
      if (!process.env.PE_BACKUP_SOURCE_DATABASE_URL_FILE) throw new Error('Legacy external restore requires a source database-url file')
      sourceIdentity = await backupDatabaseIdentity(Client,
        (await readFile(process.env.PE_BACKUP_SOURCE_DATABASE_URL_FILE, 'utf8')).trim())
    }
    if (!sourceIdentity || !/^[a-f0-9]{64}$/u.test(sourceIdentity.cluster)
      || !/^[0-9]+$/u.test(sourceIdentity.database) || typeof sourceIdentity.name !== 'string'
      || !sourceIdentity.name) throw new Error('Invalid backup source database identity')
    if (sourceIdentity.cluster === targetIdentity.cluster
      && (sourceIdentity.database === targetIdentity.database || sourceIdentity.name === targetIdentity.name)) {
      throw new Error('Restore database overlaps the source')
    }
    await requireEmptyBackupDatabase(Client, targetUrl)
  } else {
    const volume = `pe-shared-host-${trialName}_postgres-data`
    const volumeCheck = spawnSync('docker', ['volume', 'inspect', volume], { encoding: 'utf8' })
    if (volumeCheck.status === 0) throw new Error('Restore PostgreSQL volume already exists')
    if (volumeCheck.status !== 1) throw new Error('Could not check restore PostgreSQL volume')
  }
  for (const name of manifest.configFiles) {
    await copyFile(join(bundlePath, 'config', name), join(privatePath, name), constants.COPYFILE_EXCL)
    await chmod(join(privatePath, name), 0o600)
  }
  for (const name of dataNames) {
    const target = trialDataPath(storage, name)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    if (await exists(target)) await rm(target, { recursive: true })
    await copyPosixTree(join(bundlePath, 'data', name), target)
  }
  if (!(await exists(join(privatePath, 'storage-layout.json')))) {
    await writeFile(join(privatePath, 'storage-layout.json'), JSON.stringify(storage, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' })
  }
  const remoteMcpConfigFile = await writeRestoredMcpConfiguration(mcpPrepared)
  const officeRestored = await writeRestoredOfficeBackup(officePrepared)
  if (remoteMcpConfigFile) process.env.PE_REMOTE_MCP_CONFIG_FILE = remoteMcpConfigFile
  if (databaseMode === 'compose') {
    run(process.execPath, [prepareScript])
    run('docker', ['compose', '-p', `pe-shared-host-${trialName}`,
      ...composeFiles, 'up', '-d', '--wait'])
    targetUrl = (await readFile(join(privatePath, 'database-url'), 'utf8')).trim()
    await waitStableDatabase(targetUrl)
    await verifyBackupPgTools(Client, targetUrl, pgEnv)
    await requireEmptyBackupDatabase(Client, targetUrl)
  }
  restoreBackupDatabase(join(bundlePath, 'database.dump'), targetUrl, pgEnv)
  const restored = await inspectBackupState(Client, (await readFile(join(privatePath, 'database-url'), 'utf8')).trim())
  if (restored.schema !== manifest.schema) throw new Error('Restored database schema differs from the source snapshot')
  requireIdleBackupState(restored)
  if (manifest.format === 3 && JSON.stringify(officeBackupCensus(restored)) !== JSON.stringify(manifest.officeCensus)) {
    throw new Error('Restored Office census differs; target remains stopped and partial')
  }
  await verifyRestoredOfficeBackup(manifest.officeCache, officeRestored, restored)
  requireNoKubernetesWriters({ office: officeScope }, run)
  if (restored.mcpRecords && !remoteMcpConfigFile) {
    throw new Error('Restored MCP history requires its operator configuration and credential key')
  }
  await requireSkillPackageVersions(trialDataPath(storage, 'skill-packages'), restored.packages)
  const owners = new Client({ connectionString: targetUrl })
  let skillMountPermissionsRepaired
  let executionEntriesPrepared = 0
  try {
    await owners.connect()
    const users = await owners.query('SELECT id FROM pe_users ORDER BY id')
    const userIds = users.rows.map(user => user.id)
    skillMountPermissionsRepaired = await prepareRestoredSkillMounts(
      trialDataPath(storage, 'skill-packages'), userIds)
    if (sandbox) {
      const workspaces = await owners.query(restored.schema >= 27
        ? 'SELECT root_key FROM pe_storage_spaces ORDER BY root_key'
        : 'SELECT id AS root_key FROM pe_workspaces ORDER BY id')
      executionEntriesPrepared = await prepareRestoredExecutionMounts(shared,
        { userIds, storageRootKeys: workspaces.rows.map(workspace => workspace.root_key) }, { uid: 1000, gid: 1000 })
    }
  } finally { await owners.end() }
  if (!keepStopped) run(process.execPath, [trialScript, 'up'])
  const restoredAt = Date.now(), readyAt = keepStopped ? null : restoredAt
  const ready = await inspectBackupState(Client, (await readFile(join(privatePath, 'database-url'), 'utf8')).trim())
  if (ready.schema < manifest.schema) throw new Error('Startup downgraded the restored schema')
  await writeFile(join(privatePath, 'restore-evidence.json'), `${JSON.stringify({ sourceTrial: manifest.sourceTrial,
    restoredTrial: trialName, startedAt, restoredAt, readyAt, rtoToHealthMs: keepStopped ? null : readyAt - startedAt,
    keptStopped: keepStopped, ...(remoteMcpConfigFile ? { remoteMcpConfigFile } : {}),
    sourceCapturedAt: manifest.capturedAt, schemaBeforeStartup: restored.schema,
    schemaAfterStartup: ready.schema, skillMountPermissionsRepaired, executionEntriesPrepared,
    officeRestored, officeCensus: officeBackupCensus(restored) }, null, 2)}\n`,
  { mode: 0o600, flag: 'wx' })
  console.log(`Restored trial ${trialName}: schema ${restored.schema} -> ${ready.schema}; ${keepStopped
    ? 'kept stopped; health not checked' : `health RTO ${readyAt - startedAt} ms`}`)
}
