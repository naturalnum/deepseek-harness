/** Private trial backup transport and preflight; PostgreSQL URLs never enter argv or diagnostics. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
// FirstNormalObjectId: initdb reserves OIDs below 16384; normal operation allocates above that boundary.
// Include schema-independent objects and user objects placed inside pg_catalog by an operator.
const databaseObjectCatalogs = ['pg_class', 'pg_proc', 'pg_type', 'pg_collation',
  'pg_conversion', 'pg_operator', 'pg_opclass', 'pg_opfamily', 'pg_ts_config', 'pg_ts_dict',
  'pg_ts_parser', 'pg_ts_template', 'pg_cast', 'pg_transform', 'pg_am', 'pg_amop', 'pg_amproc', 'pg_language',
  'pg_extension', 'pg_event_trigger', 'pg_foreign_data_wrapper', 'pg_foreign_server',
  'pg_user_mapping', 'pg_publication', 'pg_default_acl', 'pg_constraint', 'pg_trigger',
  'pg_rewrite', 'pg_policy', 'pg_statistic_ext', 'pg_attrdef']

/** Read a cluster/database identity without recording its address, username or password. */
export async function backupDatabaseIdentity(Client, url) {
  let client
  try {
    client = new Client({ connectionString: url, connectionTimeoutMillis: 10000,
      statement_timeout: 5000, query_timeout: 6000, options: '-c default_transaction_read_only=on' })
    await client.connect()
    const { rows: [row] } = await client.query(`SELECT system_identifier::text AS cluster,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database,
      current_database() AS name FROM pg_control_system()`)
    return { cluster: digest(row.cluster), database: row.database, name: row.name }
  } catch { throw new Error('Cannot verify backup PostgreSQL identity') }
  finally { await client?.end().catch(() => {}) }
}

/** Refuse user database objects, large objects and database-local settings before copying files. */
export async function requireEmptyBackupDatabase(Client, url) {
  let client, occupied = false
  try {
    client = new Client({ connectionString: url, connectionTimeoutMillis: 10000,
      statement_timeout: 5000, query_timeout: 6000, options: '-c default_transaction_read_only=on' })
    await client.connect()
    const { rows: [row] } = await client.query(`WITH objects AS (
      ${databaseObjectCatalogs.map(catalog => catalog === 'pg_user_mapping'
        ? 'SELECT umid AS oid FROM pg_catalog.pg_user_mappings'
        : `SELECT oid FROM pg_catalog.${catalog}`).join(' UNION ALL ')}
      UNION ALL SELECT oid FROM pg_catalog.pg_namespace WHERE nspname<>'public'
    ), target AS (SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
    SELECT EXISTS(SELECT 1 FROM objects WHERE oid>=16384)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_largeobject_metadata)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_subscription WHERE subdbid=(SELECT oid FROM target))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setdatabase=(SELECT oid FROM target)) AS occupied`)
    occupied = row.occupied
    if (occupied) throw new Error('Restore database is not empty')
  } catch { throw new Error(occupied ? 'Restore database is not empty' : 'Cannot verify empty restore PostgreSQL database') }
  finally { await client?.end().catch(() => {}) }
}

/** Resolve existing ancestors so symlink aliases cannot bypass the source/target overlap check. */
export async function canonicalBackupPath(path) {
  let current = resolve(path), suffix = []
  for (;;) {
    try { return join(await realpath(current), ...suffix) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      suffix.unshift(current.slice(parent.length + (parent.endsWith('/') ? 0 : 1)))
      current = parent
    }
  }
}

/** Reject equal, nested and symlink-aliased destinations before a copy or restore. */
export async function requireSeparateBackupPaths(targets, sources) {
  const left = await Promise.all(targets.map(canonicalBackupPath))
  const right = await Promise.all(sources.map(canonicalBackupPath))
  if (left.some(target => right.some(source => target === source || target.startsWith(`${source}/`)
    || source.startsWith(`${target}/`)))) throw new Error('Backup paths overlap the source or bundle')
}

/** Discover only live, health-verified trial processes; stale records never cause a restart. */
export async function runningBackupTargets(directory) {
  let names
  try { names = await readdir(directory) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const targets = []
  for (const name of names.sort()) {
    let record
    try { record = JSON.parse(await readFile(join(directory, name, 'ready.json'), 'utf8')) }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error }
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.instanceId !== 'string'
      || !record.instanceId || typeof record.url !== 'string' || !record.url) throw new Error('Invalid trial readiness record')
    try { process.kill(record.pid, 0) }
    catch (error) { if (error.code === 'ESRCH') continue; throw error }
    let status
    try {
      const response = await fetch(`${record.url}/health`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) status = await response.json()
    } catch { /* An alive process needs independent identity verification before backup. */ }
    if (!status || status.instanceId !== record.instanceId) throw new Error('Cannot verify a live trial writer')
    targets.push(name)
  }
  const order = ['api', 'mcp', 'remote-mcp', 'platform', 'platform-b', 'platform-lb',
    'host', 'host-b', 'lb', 'device', 'device-bob']
  if (targets.some(name => !order.includes(name))) throw new Error('Unknown live trial writer')
  return targets.sort((left, right) => order.indexOf(left) - order.indexOf(right))
}

/** Require independent cluster evidence after writers stop; a cleanup flag alone is insufficient. */
export function requireNoKubernetesWriters({ sandbox, ssh, sshRequired = false }, run) {
  if (sshRequired && !ssh) throw new Error('Quarantined SSH calls require SSH Connector Runner configuration for backup')
  if (!sandbox && !ssh) return
  const list = (configuration, resource) => {
    if (typeof configuration.namespace !== 'string' || configuration.namespace.length > 63
      || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u.test(configuration.namespace)
      || typeof configuration.kubeconfigFile !== 'string' || !configuration.kubeconfigFile) {
      throw new Error('Invalid Kubernetes writer configuration')
    }
    // Mirror KubernetesClient.fromFile: each Runner uses its pinned file's current-context.
    const context = run('kubectl', ['--kubeconfig', configuration.kubeconfigFile, 'config', 'current-context']).trim()
    if (!context || /[\u0000-\u001f\u007f]/u.test(context)) {
      throw new Error('Cannot verify Kubernetes writer current-context')
    }
    const result = JSON.parse(run('kubectl', ['--kubeconfig', configuration.kubeconfigFile,
      '--context', context, '-n', configuration.namespace, 'get', resource, '-o', 'json']))
    if (!Array.isArray(result.items)) throw new Error('Cannot verify Kubernetes writer absence')
    return result.items
  }
  if (sandbox && list(sandbox, 'sandboxes.agents.x-k8s.io').length) {
    throw new Error('Sandbox objects remain active during backup')
  }
  if (ssh) {
    if (!isAbsolute(ssh.kubeconfigFile ?? '')) throw new Error('Invalid SSH Connector Runner kubeconfig')
    const pods = list(ssh, 'pods')
    if (pods.some(pod => typeof pod?.metadata?.name !== 'string')) {
      throw new Error('Cannot verify Connector Runner Pod absence')
    }
    // Include canaries and terminating Pods; SSH target servers are separate resources.
    if (pods.some(pod => /^pe-(cr|mcp)-/u.test(pod.metadata.name))) {
      throw new Error('Connector Runner Pods remain active during backup')
    }
  }
}

function pgInvocation(tool, url, env) {
  let parsed
  try { parsed = new URL(url) }
  catch { throw new Error('Invalid backup PostgreSQL configuration') }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Invalid backup PostgreSQL configuration')
  let database, username, password
  try {
    database = decodeURIComponent(parsed.pathname.slice(1))
    username = decodeURIComponent(parsed.username)
    password = decodeURIComponent(parsed.password)
  } catch { throw new Error('Invalid backup PostgreSQL configuration') }
  // libpq expands --dbname values containing '=' or a PostgreSQL URI prefix into connection settings.
  if (!database || /[=\0\r\n]/u.test(database) || /^postgres(?:ql)?:\/\//iu.test(database)) {
    throw new Error('Invalid backup PostgreSQL database name')
  }
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
  const childEnv = { ...inherited, PGDATABASE: database, PGUSER: username,
    PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' }
  const parameters = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY', connect_timeout: 'PGCONNECT_TIMEOUT' }
  for (const [key, value] of parsed.searchParams) {
    if (!parameters[key]) throw new Error('Unsupported backup PostgreSQL parameter')
    childEnv[parameters[key]] = value
  }
  if (env.PE_BACKUP_PG_CONTAINER) {
    // This explicitly selected existing container supplies libpq, using its local server socket.
    childEnv.PGHOST = env.PE_BACKUP_PG_HOST || '/var/run/postgresql'
    childEnv.PGPORT = env.PE_BACKUP_PG_PORT || '5432'
    const keys = Object.keys(childEnv).filter(key => key.startsWith('PG'))
    return { exe: 'docker', args: ['exec', '-i', ...keys.flatMap(key => ['--env', key]),
      env.PE_BACKUP_PG_CONTAINER, tool], env: childEnv }
  }
  childEnv.PGHOST = parsed.hostname.replace(/^\[|\]$/gu, '')
  childEnv.PGPORT = parsed.port || '5432'
  return { exe: env.PE_BACKUP_PG_BIN_DIR ? join(env.PE_BACKUP_PG_BIN_DIR, tool) : tool,
    args: [], env: childEnv }
}

function pgRun(tool, url, args, env, stdio) {
  const invocation = pgInvocation(tool, url, env)
  const timeout = Number(env.PE_BACKUP_PG_COMMAND_TIMEOUT_MS ?? 900000)
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 3600000) {
    throw new Error('Invalid backup PostgreSQL command timeout')
  }
  const databaseArgs = tool === 'pg_restore' ? ['--dbname', invocation.env.PGDATABASE] : []
  const result = spawnSync(invocation.exe, [...invocation.args, ...databaseArgs, ...args], {
    env: invocation.env, stdio, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout, killSignal: 'SIGTERM',
  })
  if (result.error || result.status !== 0) throw new Error(`Backup PostgreSQL ${tool} failed`)
  return result.stdout
}

/** Check that local libpq or the operator-selected existing container reaches the configured database. */
export async function verifyBackupPgTools(Client, url, env) {
  // Validate literal dbname semantics before opening either the Node or libpq connection.
  pgInvocation('psql', url, env)
  const expected = await backupDatabaseIdentity(Client, url)
  const result = pgRun('psql', url, ['--no-psqlrc', '--tuples-only', '--no-align', '--command',
    "SELECT system_identifier::text,(SELECT oid::text FROM pg_database WHERE datname=current_database()) FROM pg_control_system()"],
  env, ['ignore', 'pipe', 'pipe']).trim().split('|')
  if (result.length !== 2 || digest(result[0]) !== expected.cluster || result[1] !== expected.database) {
    throw new Error('Backup PostgreSQL tool destination differs from the configured database')
  }
  return expected
}

/** Dump the exact configured database; credentials travel only through the child environment. */
export function dumpBackupDatabase(path, url, env) {
  const fd = openSync(path, 'wx', 0o600)
  try { pgRun('pg_dump', url, ['--format=custom', '--no-owner', '--no-acl'], env, ['ignore', fd, 'pipe']) }
  finally { closeSync(fd) }
}

/** Restore the dump in one database transaction; previously copied private files remain if restoration fails. */
export function restoreBackupDatabase(path, url, env) {
  const fd = openSync(path, 'r')
  try { pgRun('pg_restore', url, ['--no-owner', '--no-acl', '--exit-on-error',
    '--single-transaction'], env, [fd, 'pipe', 'pipe']) }
  finally { closeSync(fd) }
}

async function privateBytes(path) {
  if (!isAbsolute(path) || !(await lstat(path)).isFile()) throw new Error('Invalid MCP backup private file')
  return readFile(path)
}

/** Copy explicit operator configuration, its original sealing key and every referenced CA into the private bundle. */
export async function captureBackupMcpConfiguration(path, stage) {
  if (!path) return undefined
  const { loadMcpPlatformConfig } = await import('../application/lib/platform/mcp-platform-config.js')
  await loadMcpPlatformConfig(path)
  const bytes = await privateBytes(path), configuration = JSON.parse(bytes)
  const directory = join(stage, 'config/remote-mcp')
  await mkdir(directory, { mode: 0o700 })
  const descriptor = { format: 1, configFile: 'config/remote-mcp/configuration.json',
    credentialKeyFile: 'config/remote-mcp/credential-key', caFiles: [] }
  await writeFile(join(stage, descriptor.configFile), bytes, { mode: 0o600, flag: 'wx' })
  await writeFile(join(stage, descriptor.credentialKeyFile), await privateBytes(configuration.credentialKeyFile),
    { mode: 0o600, flag: 'wx' })
  for (const [index, exception] of configuration.internalExceptions.entries()) if (exception.caFile) {
    const file = `config/remote-mcp/ca-${index}.pem`
    await writeFile(join(stage, file), await privateBytes(exception.caFile), { mode: 0o600, flag: 'wx' })
    descriptor.caFiles.push({ index, file })
  }
  return descriptor
}

/** Validate the manifest's MCP mapping and rewrite only private file references for a fresh target. */
export async function prepareRestoredMcpConfiguration(descriptor, bundle, privateDir) {
  if (!descriptor) return undefined
  if (descriptor.format !== 1 || descriptor.configFile !== 'config/remote-mcp/configuration.json'
    || descriptor.credentialKeyFile !== 'config/remote-mcp/credential-key' || !Array.isArray(descriptor.caFiles)) {
    throw new Error('Unsupported MCP backup private mapping')
  }
  const configuration = JSON.parse(await privateBytes(join(bundle, descriptor.configFile)))
  if (!Array.isArray(configuration.internalExceptions)) throw new Error('Invalid MCP backup configuration')
  const target = join(privateDir, 'remote-mcp')
  configuration.credentialKeyFile = join(target, 'credential-key')
  const indexes = new Set()
  const files = [{ source: descriptor.credentialKeyFile, target: configuration.credentialKeyFile }]
  for (const { index, file } of descriptor.caFiles) {
    if (!Number.isSafeInteger(index) || index < 0 || indexes.has(index) || file !== `config/remote-mcp/ca-${index}.pem`
      || !configuration.internalExceptions[index]?.caFile) throw new Error('Invalid MCP backup CA mapping')
    indexes.add(index)
    configuration.internalExceptions[index].caFile = join(target, `ca-${index}.pem`)
    files.push({ source: file, target: configuration.internalExceptions[index].caFile })
  }
  if (configuration.internalExceptions.some((exception, index) => exception.caFile && !indexes.has(index))) {
    throw new Error('MCP backup omits a configured CA')
  }
  // Preload every immutable bundle file before the caller starts any target mutation.
  const contents = await Promise.all(files.map(async file => ({ ...file, bytes: await privateBytes(join(bundle, file.source)) })))
  return { path: join(target, 'configuration.json'), directory: target, configuration, contents }
}

/** Publish restored MCP private bytes, then validate them through the Platform's own configuration parser. */
export async function writeRestoredMcpConfiguration(prepared) {
  if (!prepared) return undefined
  await mkdir(prepared.directory, { mode: 0o700 })
  for (const file of prepared.contents) await writeFile(file.target, file.bytes, { mode: 0o600, flag: 'wx' })
  await writeFile(prepared.path, JSON.stringify(prepared.configuration, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  const { loadMcpPlatformConfig } = await import('../application/lib/platform/mcp-platform-config.js')
  await loadMcpPlatformConfig(prepared.path)
  return prepared.path
}
