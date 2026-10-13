/** Stopped current-cloud backup and independent data restore; no business-app launch or legacy conversion. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { durableJson, privateJson, processIdentity, reserveProfile } from './lifecycle.mjs'
import { copyTree, inventoryTree, newPrivatePath, physicalPath, separatePaths } from './backup-tree.mjs'
import { CURRENT_SCHEMA_VERSION, connectDatabase, databaseCensus, dumpDatabase, requireCurrentSchema, requireEmptyDatabase,
  requireQuiescentDatabase, restoreDatabase, verifyTools } from './backup-postgres.mjs'

const labels = ['privateConfig', 'workspaces', 'homes', 'skillPackages', 'attachments', 'officeCache']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const absolute = path => typeof path === 'string' && isAbsolute(path) && path === resolve(path) && path !== '/'
  && !/\p{Cc}/u.test(path)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))

/** Validate complete explicit storage selection and literal database/role identities.
 * @param config Private configuration with an explicit nativeIntentKeyFile inside privateConfig and no embedded credentials.
 * @returns Validated version-one configuration.
 */
export function backupConfig(config) {
  if (!exact(config, ['format', 'bundle', 'postgres', 'roots', 'profiles', 'nativeIntentKeyFile']) || config.format !== 1 || !absolute(config.bundle)
    || !exact(config.postgres, ['urlFile', 'database', 'role', 'tools']) || !absolute(config.postgres.urlFile)
    || !['database', 'role'].every(key => typeof config.postgres[key] === 'string' && /^[a-z][a-z0-9_]*$/u.test(config.postgres[key]))
    || !exact(config.roots, labels) || !labels.every(label => absolute(config.roots[label]))
    || !Array.isArray(config.profiles) || config.profiles.length !== 2 || !config.profiles.every(absolute)
    || !absolute(config.nativeIntentKeyFile)) throw new Error('Invalid current-cloud backup configuration')
  keyPath(config)
  const tools = config.postgres.tools
  if (tools !== undefined && (!exact(tools, ['container', 'host', 'port', 'binDir'])
    || Object.entries(tools).some(([, value]) => typeof value !== 'string' || !value || /[\p{Cc}\s]/u.test(value))
    || tools.container && (tools.binDir || !tools.host || !tools.port) || tools.binDir && !absolute(tools.binDir))) throw new Error('Invalid explicit PostgreSQL transport')
  return config
}

function keyPath(config) {
  const path = relative(config.roots.privateConfig, config.nativeIntentKeyFile)
  if (!path || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..')
    || /[\p{Cc}\\]/u.test(path)) throw new Error('Native intent key must be inside privateConfig')
  return path
}
async function keyFile(path, root) {
  if (await physicalPath(path) !== join(await physicalPath(root), relative(root, path))) throw new Error('Native intent key must be physical')
  const before = await lstat(path)
  if (!before.isFile() || (before.mode & 0o7777) !== 0o600 || before.size < 43 || before.size > 44) {
    throw new Error('Native intent key must be a 0600 canonical 32-byte base64url file')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes, decoded
  try {
    const info = await file.stat()
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size
      || (info.mode & 0o7777) !== 0o600) throw new Error('Native intent key identity changed')
    bytes = Buffer.alloc(45)
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    bytes = bytes.subarray(0, length)
    const text = bytes.toString('utf8'), encoded = text.endsWith('\n') ? text.slice(0, -1) : text
    decoded = Buffer.from(encoded, 'base64url')
    if (!/^[A-Za-z0-9_-]{43}\n?$/u.test(text) || decoded.length !== 32 || decoded.toString('base64url') !== encoded) {
      throw new Error('Native intent key must be a 0600 canonical 32-byte base64url file')
    }
    const after = await file.stat()
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error('Native intent key changed while reading')
    return { size: bytes.length, sha256: digest(bytes) }
  } finally { bytes?.fill(0); decoded?.fill(0); await file.close() }
}
function keyInventory(inventory, key) {
  const entry = inventory.find(item => item.path === key.path)
  if (!entry || !['file', 'hardlink'].includes(entry.kind) || entry.mode !== 0o600
    || entry.size !== key.size || entry.sha256 !== key.sha256) throw new Error('Native intent key differs from the privateConfig inventory')
}

async function privateFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Backup configuration and URL must be private regular files')
}
async function stoppedProfile(path) {
  const owner = await privateJson(join(path, 'power-evolve-owner.json'))
  const lifecycle = await privateJson(join(path, 'lifecycle.json'))
  if (owner?.format !== 2 || !['host', 'platform'].includes(owner.role) || !/^[a-f0-9]{64}$/u.test(owner.deployment ?? '')
    || lifecycle?.phase !== 'stopped' || !isDeepStrictEqual(lifecycle.owner, owner) || !lifecycle.child || !lifecycle.exit) throw new Error('Backup requires exact stopped Profile evidence')
  for (const identity of [lifecycle.parent, lifecycle.child]) {
    if (!identity || typeof identity.birth !== 'string' || await processIdentity(identity.pid)) throw new Error('Profile process or reused PID is active or uncertain')
  }
  return owner
}
async function lockStoppedProfiles(paths) {
  const reservations = [], roles = new Set()
  try {
    for (const path of paths) {
      const owner = await stoppedProfile(path)
      reservations.push(await reserveProfile(path, owner))
      await stoppedProfile(path)
      if (roles.has(owner.role)) throw new Error('Backup requires distinct Host and Platform Profiles')
      roles.add(owner.role)
    }
    return reservations
  } catch (error) {
    for (const lock of reservations.toReversed()) await lock.release()
    throw error
  }
}
async function inventoryRoots(config) {
  const result = {}
  for (const label of labels) result[label] = await inventoryTree(config.roots[label], label === 'privateConfig' || label === 'attachments')
  result.profiles = []
  for (const path of config.profiles) result.profiles.push(await inventoryTree(path))
  return result
}

/** Create a new immutable private bundle while both exact local Profiles remain reserved and stopped.
 * @param raw Complete stopped-deployment configuration; external writers must already be reconciled.
 * @returns Credential-free manifest summary; failure retains an unpublished stage for inspection.
 */
export async function createBackup(raw) {
  const config = backupConfig(raw)
  const nativeIntentKey = { path: keyPath(config), ...await keyFile(config.nativeIntentKeyFile, config.roots.privateConfig) }
  await privateFile(config.postgres.urlFile)
  await separatePaths([config.bundle, ...Object.values(config.roots), ...config.profiles])
  await newPrivatePath(config.bundle)
  const reservations = await lockStoppedProfiles(config.profiles)
  let database, transactionOpen = false
  const stage = `${config.bundle}.${randomUUID()}.partial`
  try {
    database = await connectDatabase(config.postgres)
    verifyTools(database, config.postgres)
    await requireCurrentSchema(database.client)
    await requireQuiescentDatabase(database.client)
    await database.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transactionOpen = true
    const snapshot = (await database.client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot
    const census = await databaseCensus(database.client)
    const inventories = await inventoryRoots(config)
    keyInventory(inventories.privateConfig, nativeIntentKey)
    await mkdir(stage, { mode: 0o700 })
    dumpDatabase(join(stage, 'database.dump'), database, config.postgres, snapshot)
    await mkdir(join(stage, 'roots'), { mode: 0o700 })
    for (const label of labels) await copyTree(config.roots[label], join(stage, 'roots', label), inventories[label])
    if (!isDeepStrictEqual(await keyFile(join(stage, 'roots', 'privateConfig', nativeIntentKey.path), join(stage, 'roots', 'privateConfig')),
      { size: nativeIntentKey.size, sha256: nativeIntentKey.sha256 })) throw new Error('Archived native intent key differs')
    await mkdir(join(stage, 'profiles'), { mode: 0o700 })
    for (let i = 0; i < config.profiles.length; i++) await copyTree(config.profiles[i], join(stage, 'profiles', String(i)), inventories.profiles[i])
    if (!isDeepStrictEqual(inventories, await inventoryRoots(config))) throw new Error('Backup source bytes or permissions changed')
    await database.client.query('COMMIT'); transactionOpen = false
    await requireQuiescentDatabase(database.client)
    const files = (await inventoryTree(stage)).filter(entry => entry.path !== '')
    const manifest = { format: 1, kind: 'power-evolve-current-cloud-backup', capturedAt: Date.now(),
      schema: CURRENT_SCHEMA_VERSION, family: 'cloud-native', database: database.identity, sourceRoots: config.roots,
      sourceProfiles: config.profiles, nativeIntentKey, census, inventories, files, keptStopped: true }
    const bytes = JSON.stringify(manifest) + '\n'
    await durableJson(join(stage, 'manifest.json'), manifest)
    await durableJson(join(stage, 'manifest-digest.json'), { sha256: digest(bytes) })
    await rename(stage, config.bundle)
    const parent = await import('node:fs/promises').then(fs => fs.open(dirname(config.bundle), 'r'))
    try { await parent.sync() } finally { await parent.close() }
    return { bundle: config.bundle, schema: CURRENT_SCHEMA_VERSION, tables: Object.keys(census.tables).length,
      files: files.length, keptStopped: true }
  } finally {
    if (transactionOpen) await database.client.query('ROLLBACK')
    await database?.client.end()
    for (const lock of reservations.toReversed()) await lock.release()
  }
}

async function verifiedManifest(bundle) {
  const manifest = await privateJson(join(bundle, 'manifest.json')), checksum = await privateJson(join(bundle, 'manifest-digest.json'))
  if (manifest?.format !== 1 || manifest.kind !== 'power-evolve-current-cloud-backup' || manifest.schema !== CURRENT_SCHEMA_VERSION
    || manifest.family !== 'cloud-native' || digest(await readFile(join(bundle, 'manifest.json'))) !== checksum?.sha256) throw new Error('Invalid current-cloud backup manifest or digest')
  const files = (await inventoryTree(bundle)).filter(entry => !['', 'manifest.json', 'manifest-digest.json'].includes(entry.path))
  if (!isDeepStrictEqual(files, manifest.files)) throw new Error('Backup file integrity or permission mismatch')
  const inventories = { profiles: [] }
  for (const label of labels) inventories[label] = await inventoryTree(join(bundle, 'roots', label), label === 'privateConfig' || label === 'attachments')
  for (let i = 0; i < 2; i++) inventories.profiles.push(await inventoryTree(join(bundle, 'profiles', String(i))))
  if (!isDeepStrictEqual(inventories, manifest.inventories)) throw new Error('Backup root inventory differs before restore')
  const key = manifest.nativeIntentKey
  if (!exact(key, ['path', 'size', 'sha256']) || ![43, 44].includes(key.size) || !/^[a-f0-9]{64}$/u.test(key.sha256)
    || typeof key.path !== 'string' || !key.path || isAbsolute(key.path)
    || key.path.split('/').some(part => !part || part === '.' || part === '..') || /[\p{Cc}\\]/u.test(key.path)) throw new Error('Invalid native intent key manifest')
  keyInventory(inventories.privateConfig, key)
  if (!isDeepStrictEqual(await keyFile(join(bundle, 'roots', 'privateConfig', key.path), join(bundle, 'roots', 'privateConfig')),
    { size: key.size, sha256: key.sha256 })) throw new Error('Archived native intent key differs')
  return manifest
}

/** Restore all current data and archived Profile snapshots to an independent empty database and new roots.
 * @param raw Target configuration; Profiles are archival snapshots and must be rebound via start.mjs.
 * @returns Full census and byte-verification facts, with business readiness explicitly unchecked.
 */
export async function restoreBackup(raw) {
  const config = backupConfig(raw), manifest = await verifiedManifest(config.bundle)
  if (keyPath(config) !== manifest.nativeIntentKey.path) throw new Error('Restored native intent key must keep its original relative path')
  await privateFile(config.postgres.urlFile)
  const targets = [...Object.values(config.roots), ...config.profiles]
  await separatePaths([...targets, config.bundle, config.postgres.urlFile,
    ...Object.values(manifest.sourceRoots), ...manifest.sourceProfiles])
  for (const path of targets) await newPrivatePath(path)
  const database = await connectDatabase(config.postgres)
  try {
    verifyTools(database, config.postgres)
    if (database.identity.database === manifest.database.database || database.identity.server === manifest.database.server
      && database.identity.oid === manifest.database.oid) throw new Error('Restore target overlaps the source database')
    await requireEmptyDatabase(database.client)
    await database.client.query('SELECT pg_advisory_lock(72819532)')
    await requireEmptyDatabase(database.client)
    restoreDatabase(join(config.bundle, 'database.dump'), database, config.postgres)
    await database.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    let census
    try {
      census = await databaseCensus(database.client)
      await requireQuiescentDatabase(database.client)
      await database.client.query('COMMIT')
    }
    catch (error) { await database.client.query('ROLLBACK'); throw error }
    if (!isDeepStrictEqual(census, manifest.census)) throw new Error('Restored table rows, definitions or sequences differ')
    for (const label of labels) await copyTree(join(config.bundle, 'roots', label), config.roots[label], manifest.inventories[label])
    for (let i = 0; i < config.profiles.length; i++) await copyTree(join(config.bundle, 'profiles', String(i)), config.profiles[i], manifest.inventories.profiles[i])
    if (!isDeepStrictEqual(await inventoryRoots(config), manifest.inventories)) throw new Error('Restored file bytes, owners or permissions differ')
    if (!isDeepStrictEqual(await keyFile(config.nativeIntentKeyFile, config.roots.privateConfig),
      { size: manifest.nativeIntentKey.size, sha256: manifest.nativeIntentKey.sha256 })) throw new Error('Restored native intent key differs from the original bytes')
    await requireQuiescentDatabase(database.client)
    const evidence = { schema: CURRENT_SCHEMA_VERSION, family: 'cloud-native', tables: Object.keys(census.tables).length,
      allRowsVerified: true, allFilesVerified: true, source: manifest.database, target: database.identity,
      restoredAt: Date.now(), keptStopped: true, readinessChecked: false, profilesRequireRebinding: true }
    await durableJson(`${config.bundle}.restore-${randomUUID()}.json`, evidence)
    return evidence
  } finally { await database.client.end() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, path, ...extra] = process.argv.slice(2)
    if (!['create', 'restore'].includes(command) || !absolute(path) || extra.length) throw new Error('Use backup.mjs create|restore <absolute-private-config.json>')
    await privateFile(path)
    const config = await privateJson(path)
    console.log(JSON.stringify(await (command === 'create' ? createBackup(config) : restoreBackup(config))))
  } catch {
    console.error('Current-cloud backup or restore failed; preserve the private bundle and partial target for inspection. Business readiness is unchecked.')
    process.exitCode = 1
  }
}
