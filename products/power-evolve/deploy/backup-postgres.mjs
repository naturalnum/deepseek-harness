/** Current-cloud PostgreSQL backup transport and full-table digests under ordinary deployment roles. */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
/** Only this current cloud generation is eligible for backup and restore. */
export const CURRENT_SCHEMA_VERSION = 6
const expectedColumns = JSON.parse(await readFile(new URL('../application/assets/cloud-schema-v6.manifest.json', import.meta.url), 'utf8'))
const identifier = name => '"' + name.replaceAll('"', '""') + '"'
const hash = value => createHash('sha256').update(value).digest('hex')
const identityQuery = `SELECT current_database() AS database,current_user AS role,
  (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
  concat(inet_server_addr(),':',inet_server_port(),':',pg_postmaster_start_time()) AS server,
  current_setting('server_version_num')::integer / 10000 AS major`
const catalogs = ['pg_class', 'pg_proc', 'pg_type', 'pg_collation', 'pg_conversion', 'pg_operator',
  'pg_opclass', 'pg_opfamily', 'pg_ts_config', 'pg_ts_dict', 'pg_ts_parser', 'pg_ts_template', 'pg_cast',
  'pg_transform', 'pg_am', 'pg_amop', 'pg_amproc', 'pg_language', 'pg_extension', 'pg_event_trigger',
  'pg_foreign_data_wrapper', 'pg_foreign_server', 'pg_publication', 'pg_default_acl', 'pg_constraint',
  'pg_trigger', 'pg_rewrite', 'pg_policy', 'pg_statistic_ext', 'pg_attrdef']

/** Connect to the explicitly named database as the explicitly named ordinary role.
 * @param config PostgreSQL URL-file and expected identity.
 * @returns Connected client and a credential-free database identity.
 */
export async function connectDatabase(config) {
  const url = (await readFile(config.urlFile, 'utf8')).trim()
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000, query_timeout: 60000, statement_timeout: 60000 })
  try {
    await client.connect()
    await client.query("SET timezone='UTC'; SET extra_float_digits=3")
    const { rows: [row] } = await client.query(identityQuery)
    if (row.database !== config.database || row.role !== config.role) throw new Error('PostgreSQL database or deployment role differs')
    return { client, url, identity: { database: row.database, role: row.role, oid: row.oid, server: hash(row.server), major: row.major } }
  } catch (error) { await client.end(); throw new Error('Cannot verify PostgreSQL deployment identity', { cause: error }) }
}

function invocation(tool, url, config) {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash) throw new Error('Unsupported PostgreSQL tool URL')
  const database = decodeURIComponent(parsed.pathname.slice(1))
  if (!database || /[=\p{Cc}]/u.test(database)) throw new Error('Invalid literal database name')
  // Container transports and PATH wrappers use the caller's explicit Docker selection.
  const env = {
    ...(process.env.DOCKER_HOST !== undefined ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    ...(process.env.DOCKER_CONTEXT !== undefined ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}),
    ...(process.env.DOCKER_CONFIG !== undefined ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
    ...(process.env.DOCKER_TLS_VERIFY !== undefined ? { DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY } : {}),
    ...(process.env.DOCKER_CERT_PATH !== undefined ? { DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH } : {}),
    PATH: process.env.PATH, HOME: process.env.HOME, PGDATABASE: database,
    PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password),
    PGHOST: config.tools?.host ?? parsed.hostname, PGPORT: config.tools?.port ?? parsed.port ?? '5432',
    PGCONNECT_TIMEOUT: '10', PGOPTIONS: '-c timezone=UTC -c extra_float_digits=3' }
  if (config.tools?.container) return { command: 'docker', args: ['exec', '-i',
    ...Object.keys(env).filter(key => key.startsWith('PG')).flatMap(key => ['--env', key]), config.tools.container, tool], env }
  return { command: config.tools?.binDir ? join(config.tools.binDir, tool) : tool, args: [], env }
}

/** Run libpq without credentials in argv or diagnostics; wait for the exact transport process.
 * @param tool psql, pg_dump or pg_restore.
 * @param url Private connection string.
 * @param config Explicit tool transport selection.
 * @param args Public PostgreSQL arguments.
 * @param stdio File descriptors or pipe selection.
 * @returns Standard output; failures expose no libpq output.
 */
export function postgresTool(tool, url, config, args, stdio = ['ignore', 'pipe', 'pipe']) {
  if (!['psql', 'pg_dump', 'pg_restore'].includes(tool)) throw new Error('Unsupported PostgreSQL tool')
  const run = invocation(tool, url, config)
  const result = spawnSync(run.command, [...run.args, ...args], {
    env: run.env, stdio, encoding: 'utf8', timeout: 600000, killSignal: 'SIGTERM', maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0) {
    const diagnostic = openSync(config.urlFile + `.${tool}-${randomUUID()}-failure-private.log`, 'wx', 0o600)
    try { writeSync(diagnostic, result.stderr ?? String(result.error ?? result.signal)) } finally { closeSync(diagnostic) }
    throw new Error(`PostgreSQL ${tool} failed`)
  }
  return result.stdout
}

/** Verify Node and libpq address the same server incarnation, database and role.
 * @param database Result of connectDatabase.
 * @param config Explicit transport selection.
 * @returns Nothing after identity and tool-version verification succeeds.
 */
export function verifyTools(database, config) {
  const row = JSON.parse(postgresTool('psql', database.url, config,
    ['--no-psqlrc', '--tuples-only', '--no-align', '--command', `SELECT row_to_json(i) FROM (${identityQuery}) i`]).trim())
  const identity = { database: row.database, role: row.role, oid: row.oid, server: hash(row.server), major: row.major }
  if (JSON.stringify(identity) !== JSON.stringify(database.identity)) throw new Error('PostgreSQL tools target another database or role')
  for (const tool of ['psql', 'pg_dump', 'pg_restore']) {
    const version = postgresTool(tool, database.url, config, ['--version']).match(/\(PostgreSQL\) (\d+)\./u)
    if (!version || Number(version[1]) !== database.identity.major) throw new Error('PostgreSQL tools must match the server major version')
  }
}

/** Refuse all user objects and database-local settings without privileged catalog access.
 * @param client Connected ordinary deployment role.
 * @returns Promise resolving after empty-database verification succeeds.
 */
export async function requireEmptyDatabase(client) {
  const { rows: [row] } = await client.query(`WITH objects AS (
    ${catalogs.map(name => `SELECT oid FROM pg_catalog.${name}`).join(' UNION ALL ')}
    UNION ALL SELECT umid AS oid FROM pg_catalog.pg_user_mappings
    UNION ALL SELECT oid FROM pg_catalog.pg_namespace WHERE nspname<>'public'
  ) SELECT EXISTS(SELECT 1 FROM objects WHERE oid>=16384)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_largeobject_metadata)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_subscription WHERE subdbid=(SELECT oid FROM pg_database WHERE datname=current_database()))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())) AS occupied`)
  if (row.occupied) throw new Error('Restore database is not empty')
}

/** Require exactly the current cloud family, version and complete column manifest.
 * @param client Connected source or restored database.
 * @returns Promise resolving only for the complete current cloud manifest.
 */
export async function requireCurrentSchema(client) {
  const { rows } = await client.query('SELECT family,version FROM pe_schema')
  if (rows.length !== 1 || rows[0].family !== 'cloud-native' || rows[0].version !== CURRENT_SCHEMA_VERSION) throw new Error(`Backup requires cloud-native Schema ${CURRENT_SCHEMA_VERSION}; older backups remain unchanged`)
  const fields = await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name")
  const actual = {}
  for (const row of fields.rows) (actual[row.table_name] ??= []).push(row.column_name)
  const expected = Object.fromEntries(Object.entries(expectedColumns).toSorted().map(([name, columns]) => [name, columns.toSorted()]))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Current cloud table manifest differs')
}

/** Reject temporary presentations, live native writers, active or uncertain effects and other connections.
 * @param client Connected backup client, after local Profile stop verification.
 * @returns Promise resolving after temporary-state and writer checks succeed.
 */
export async function requireQuiescentDatabase(client) {
  for (const table of ['pe_native_presentation_entries', 'pe_native_presentations']) {
    const { rows: [row] } = await client.query(`SELECT count(*)::text AS count FROM ${identifier(table)}`)
    if (row.count !== '0') throw new Error(`Backup temporary presentation state remains in ${table}; reconcile it before backup`)
  }
  const predicates = {
    pe_native_retained_intents: "state='prepared'",
    pe_native_writers: 'expires_at>clock_timestamp()',
    pe_operations: "state IN ('queued','running')",
    pe_cloud_executions: "state IN ('queued','starting','running','cancelling','uncertain')",
    pe_cloud_execution_resolutions: "state IN ('accepted','stopping','blocked')",
    pe_connector_actions: "state IN ('approved','dispatching','uncertain')",
    pe_mount_slots: "state<>'free'", pe_sandbox_instances: "state<>'deleted'",
    pe_office_preview_jobs: "state IN ('queued','creating','running','stopping','blocked') OR parser_slot IS NOT NULL",
    pe_mcp_actions: "state IN ('approved','preparing','dispatch-intent','uncertain')",
    pe_mcp_checks: "state IN ('queued','running')",
    pe_stdio_mcp_calls: "state IN ('accepted','preparing','ready','dispatch-intent','running','uncertain')",
    pe_ssh_calls: "state IN ('accepted','preparing','ready','dispatch-intent','running','uncertain')",
    pe_ssh_execute_actions: "state='approved'",
    pe_stdio_v2_actions: "state NOT IN ('succeeded','failed','cancelled','expired','rejected')",
  }
  for (const [table, predicate] of Object.entries(predicates)) {
    const { rows: [row] } = await client.query(`SELECT count(*)::text AS count FROM ${identifier(table)} WHERE ${predicate}`)
    if (row.count !== '0') throw new Error(`Backup writer is active or uncertain in ${table}`)
  }
  const { rows: [row] } = await client.query('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')
  if (row.count !== '0') throw new Error('Backup database has another connection; freeze all writers first')
}

/** Hash every row of every current table, retaining duplicates, JSON, timestamps and execution facts.
 * @param client Client already inside a repeatable-read transaction.
 * @returns Per-table row counts and SHA256 digests plus complete schema definitions and sequences.
 */
export async function databaseCensus(client) {
  await requireCurrentSchema(client)
  const tables = {}
  for (const name of Object.keys(expectedColumns).toSorted()) {
    await client.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS value FROM ${identifier(name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)
    const digest = createHash('sha256'); let count = 0
    for (;;) {
      const { rows } = await client.query('FETCH 256 FROM backup_rows')
      if (!rows.length) break
      for (const row of rows) { digest.update(row.value + '\n'); count++ }
    }
    await client.query('CLOSE backup_rows')
    tables[name] = { rows: count, sha256: digest.digest('hex') }
  }
  const definitions = (await client.query(`SELECT 'column' AS kind,table_name AS name,column_name AS member,
      concat(data_type,':',udt_name,':',is_nullable,':',column_default) AS definition FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT 'constraint',relname,c.conname,pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'index',tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'function',p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    ORDER BY kind,name,member,definition`)).rows
  const sequences = {}
  const names = (await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows
  for (const { sequencename } of names) sequences[sequencename] = (await client.query(`SELECT last_value::text,is_called FROM ${identifier(sequencename)}`)).rows[0]
  return { schema: CURRENT_SCHEMA_VERSION, family: 'cloud-native', tables, definitions, sequences }
}

/** Capture a custom dump using the census transaction's exported snapshot.
 * @param path Absent private dump file.
 * @param database Connected source identity and private URL.
 * @param config Transport selection.
 * @param snapshot Exported PostgreSQL snapshot identity.
 * @returns Nothing after the complete custom dump is flushed.
 */
export function dumpDatabase(path, database, config, snapshot) {
  const fd = openSync(path, 'wx', 0o600)
  try { postgresTool('pg_dump', database.url, config, ['--format=custom', '--no-owner', '--no-acl', '--snapshot', snapshot], ['ignore', fd, 'pipe']); fsyncSync(fd) }
  finally { closeSync(fd) }
}

/** Restore atomically into the independently prechecked empty database, never editing schema markers.
 * @param path Verified custom dump file.
 * @param database Connected target identity and private URL.
 * @param config Transport selection.
 * @returns Nothing after the atomic database restore succeeds.
 */
export function restoreDatabase(path, database, config) {
  const fd = openSync(path, 'r')
  try { postgresTool('pg_restore', database.url, config, ['--dbname', config.database, '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction'], [fd, 'pipe', 'pipe']) }
  finally { closeSync(fd) }
}
