/** Atomic cloud-native/2 insertion into an exclusively new database and unpublished owned storage. */
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { LEGACY_FOREIGN_KEYS, LEGACY_PRIMARY_KEYS, LEGACY_SQL_DIGESTS, LEGACY_TARGET_LAYOUT } from './legacy-import-layout.ts'
import { LegacyImportError, legacyDigest, legacyJson } from './legacy-import-codec.ts'
import { assertLegacyImportPlan, legacyTimestamp, type LegacyImportPlan, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { discardLegacyStorage, stageLegacyStorage, verifyLegacyStorage, writeLegacyStorageReceipt,
  type LegacyStorageCandidate, type LegacyStorageOptions } from './legacy-import-storage.ts'
import { checkpointNativeProjections, nativeProjectionView } from './native-projections.ts'
import { headerSchema, parseEvents } from '../session-records.ts'

const late = Object.freeze([
  'ALTER TABLE ONLY public.pe_skill_package_versions\n    ADD CONSTRAINT pe_skill_package_versions_skill_id_user_id_fkey FOREIGN KEY (skill_id, user_id) REFERENCES public.pe_user_skills(id, user_id);',
  'ALTER TABLE ONLY public.pe_user_skills\n    ADD CONSTRAINT pe_user_skills_package_version FOREIGN KEY (package_version_id, user_id) REFERENCES public.pe_skill_package_versions(id, user_id);',
  'ALTER TABLE ONLY public.pe_stdio_v2_connections\n    ADD CONSTRAINT pe_stdio_v2_connections_current_catalog FOREIGN KEY (current_catalog_id, user_id, id, revision) REFERENCES public.pe_stdio_v2_catalogs(id, user_id, connection_id, config_revision);',
  'ALTER TABLE ONLY public.pe_mcp_remote_connections\n    ADD CONSTRAINT pe_mcp_remote_catalog FOREIGN KEY (current_catalog_id, user_id) REFERENCES public.pe_mcp_catalog_versions(id, user_id);',
])
/** Maintenance target identity and exclusively owned storage, never a source connection. */
export interface LegacyImportWriteOptions {
  readonly expectedDatabase: string
  readonly storage: LegacyStorageOptions
}
/** Independently compared committed candidate; a Profile is deliberately not launched here. */
export interface LegacyImportResult {
  readonly family: 'cloud-native'
  readonly version: 2
  readonly packetSha256: string
  readonly tableCounts: Readonly<Record<string, string>>
  readonly sourceCounts: LegacyImportPlan['counts']
  readonly storage: LegacyStorageCandidate
}
function quote(name: string): string {
  if (!/^[a-z_][a-z_0-9]*$/u.test(name)) throw new LegacyImportError('invalid_sql_identifier')
  return `"${name}"`
}
function cast(table: string, column: string): string {
  const specification = LEGACY_TARGET_LAYOUT[table]?.[column]
  if (!specification) throw new LegacyImportError('unknown_sql_column')
  return specification.kind
}
async function emptyTarget(client: PoolClient, expectedDatabase: string): Promise<void> {
  if (!(await client.query<{ same: boolean }>('SELECT current_database()=$1 AS same', [expectedDatabase])).rows[0]?.same) {
    throw new LegacyImportError('wrong_target_database')
  }
  const extraSchemas = await client.query(`SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('public','information_schema','pg_catalog','pg_toast')`)
  const objects = await client.query(`SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    UNION ALL SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'`)
  const extensions = await client.query("SELECT extname FROM pg_extension WHERE extname<>'plpgsql'")
  if (extraSchemas.rowCount || objects.rowCount || extensions.rowCount) throw new LegacyImportError('nonempty_target_database')
}
async function ddl(): Promise<{ initial: string; adjacent: string }> {
  const initial = await readFile(new URL('../../assets/cloud-schema-v1.sql', import.meta.url), 'utf8')
  const adjacent = await readFile(new URL('../../assets/cloud-schema-v2.sql', import.meta.url), 'utf8')
  if (legacyDigest(initial) !== LEGACY_SQL_DIGESTS.cloud1 || legacyDigest(adjacent) !== LEGACY_SQL_DIGESTS.cloud2) {
    throw new LegacyImportError('target_schema_fingerprint')
  }
  let staged = initial
  for (const statement of late) {
    const start = staged.indexOf(statement)
    if (start < 0 || staged.indexOf(statement, start + statement.length) >= 0) throw new LegacyImportError('late_constraint_definition')
    staged = staged.slice(0, start) + staged.slice(start + statement.length)
  }
  return { initial: staged, adjacent }
}
async function insert(client: PoolClient, row: LegacyPlannedRow): Promise<void> {
  const columns = Object.entries(LEGACY_TARGET_LAYOUT[row.table] ?? {}).filter(([, column]) => !column.generated).map(([name]) => name)
  if (!columns.length) throw new LegacyImportError('empty_insert')
  await client.query(`INSERT INTO public.${quote(row.table)}(${columns.map(quote).join(',')}) VALUES(${columns.map((column, index) =>
    `$${index + 1}::${cast(row.table, column)}`).join(',')})`, columns.map(column => row.values[column] ?? null))
}
async function compare(client: PoolClient, plan: LegacyImportPlan): Promise<Readonly<Record<string, string>>> {
  for (const row of plan.rows) {
    const columns = Object.keys(LEGACY_TARGET_LAYOUT[row.table] ?? {}), keys = LEGACY_PRIMARY_KEYS[row.table]
    if (!keys) throw new LegacyImportError('missing_primary_key')
    const selection = columns.map(column => cast(row.table, column) === 'timestamptz'
      ? `to_char(${quote(column)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${quote(column)}`
      : `${quote(column)}::text AS ${quote(column)}`).join(',')
    const result = await client.query<Record<string, string | null>>(`SELECT ${selection} FROM public.${quote(row.table)} WHERE ${keys.map((key, index) =>
      `${quote(key)} IS NOT DISTINCT FROM $${index + 1}::${cast(row.table, key)}`).join(' AND ')}`, keys.map(key => row.values[key]))
    const stored = result.rows[0]
    if (!stored || result.rows.length !== 1) throw new LegacyImportError('row_comparison_missing', row.table)
    for (const column of columns) {
      const current = stored[column], expected = row.values[column]
      let matches = current === expected
      if (current !== null && current !== undefined && expected !== null && expected !== undefined) {
        if (cast(row.table, column) === 'jsonb') matches = isDeepStrictEqual(legacyJson(current, plan.limits), legacyJson(expected, plan.limits))
        else if (cast(row.table, column) === 'timestamptz') matches = legacyTimestamp(current) === legacyTimestamp(expected)
      }
      if (!matches) throw new LegacyImportError('row_comparison_changed', `${row.table}.${column}`)
    }
  }
  const counts: Record<string, string> = {}
  for (const table of Object.keys(LEGACY_TARGET_LAYOUT)) {
    const expected = table === 'pe_native_preferences' ? plan.rows.filter(row => row.table === 'pe_sessions').length
      : plan.rows.filter(row => row.table === table).length
    const count = (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.${quote(table)}`)).rows[0]?.count
    if (count !== String(expected)) throw new LegacyImportError('table_comparison_changed', table)
    counts[table] = count
  }
  const constraints = (await client.query(`SELECT c.conname,c.convalidated,c.condeferrable,c.condeferred
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f'`)).rows
  const parsed = z.array(z.object({ conname: z.string(), convalidated: z.literal(true),
    condeferrable: z.boolean(), condeferred: z.boolean() })).safeParse(constraints)
  if (!parsed.success || parsed.data.length !== LEGACY_FOREIGN_KEYS.length || LEGACY_FOREIGN_KEYS.some((key) => {
    const actual = parsed.data.find(row => row.conname === key.name)
    return !actual || actual.condeferrable !== key.deferred || actual.condeferred !== key.deferred
  })) throw new LegacyImportError('foreign_key_definition_changed')
  for (const session of plan.rows) if (session.table === 'pe_sessions') {
    const value = (await client.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
      [session.values.user_id, `session-projections:${session.values.id}`])).rows[0]?.value
    nativeProjectionView(value, Number(session.values.event_count))
  }
  return Object.freeze(counts)
}
/** Write and compare an issued plan under the ordinary schema lock into a truly empty target.
 * @param pool Trusted new-target connection; the source is never connected.
 * @param plan Frozen preflight result with complete mandatory owner validation.
 * @param options Target database identity and owned detached/candidate storage configuration.
 * @returns A committed, private candidate after independent SQL and byte comparisons.
 * @throws Commit uncertainty or post-commit publication failures preserve the candidate for explicit reconciliation.
 */
export async function writeLegacyImport(pool: Pool, plan: LegacyImportPlan,
  options: LegacyImportWriteOptions): Promise<LegacyImportResult> {
  assertLegacyImportPlan(plan)
  const assets = await ddl(), client = await pool.connect()
  let candidate: LegacyStorageCandidate | undefined, commitAttempted = false, committed = false
  const connection: { error?: Error } = {}
  let discard = false
  const onError = (error: Error) => { connection.error ??= error; discard = true }
  client.on('error', onError)
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(72819531)')
    await emptyTarget(client, options.expectedDatabase)
    if (!(await client.query<{ ended: boolean }>('SELECT $1::timestamptz<=clock_timestamp() AS ended', [plan.source.cut])).rows[0]?.ended) {
      throw new LegacyImportError('source_cut_in_future')
    }
    await client.query('SET LOCAL search_path=public,pg_catalog')
    await verifyLegacyStorage(plan, options.storage)
    candidate = await stageLegacyStorage(plan, options.storage)
    await client.query('SET LOCAL check_function_bodies=false')
    await client.query(assets.initial); await client.query(assets.adjacent)
    for (const row of plan.rows) await insert(client, row)
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    for (const statement of late) await client.query(statement)
    for (const row of plan.rows) if (row.table === 'pe_sessions') {
      const header = headerSchema.parse(legacyJson(row.values.header ?? '', plan.limits))
      const events = plan.rows.filter(event => event.table === 'pe_events' && event.values.session_id === row.values.id)
        .sort((a, b) => Number(a.values.seq) - Number(b.values.seq))
      await checkpointNativeProjections(client, row.values.user_id ?? '', header, 0,
        parseEvents(header, events.map(event => legacyJson(event.values.event ?? '', plan.limits))))
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    const tableCounts = await compare(client, plan)
    if (connection.error) throw connection.error
    commitAttempted = true
    await client.query('COMMIT'); committed = true
    await writeLegacyStorageReceipt(candidate, 'database-committed')
    await writeLegacyStorageReceipt(candidate, 'complete')
    return Object.freeze({ family: 'cloud-native', version: 2, packetSha256: plan.packetSha256,
      tableCounts, sourceCounts: plan.counts, storage: candidate })
  } catch (error) {
    if (!commitAttempted) {
      try { await client.query('ROLLBACK') }
      catch (_rollbackUncertain) { discard = true }
      if (candidate && !discard) {
        try { await discardLegacyStorage(candidate) }
        catch (_cleanupIncomplete) { throw new LegacyImportError('import_cleanup_incomplete', candidate.root) }
      }
    }
    if (candidate && commitAttempted) {
      try { await writeLegacyStorageReceipt(candidate, committed ? 'publication-incomplete' : 'commit-unresolved') }
      catch (_receiptUnavailable) { /* Keep both outcomes unresolved and preserve the owned root. */ }
      throw new LegacyImportError(committed ? 'candidate_publication_failed' : 'commit_outcome_unknown', candidate.root)
    }
    if (discard) throw new LegacyImportError('rollback_outcome_unknown', candidate?.root ?? '')
    if (error instanceof LegacyImportError) throw error
    const sqlState = error instanceof Error && 'code' in error && typeof error.code === 'string'
      && /^[A-Z0-9]{5}$/u.test(error.code) ? error.code : ''
    throw new LegacyImportError('postgres_import_rejected', sqlState)
  } finally {
    client.removeListener('error', onError)
    client.release(discard)
  }
}
