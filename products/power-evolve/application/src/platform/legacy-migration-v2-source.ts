/** Consistent, explicitly read-only Schema37 capture; this module never stops source processes. */
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { LEGACY_SOURCE_LAYOUT, LEGACY_SQL_DIGESTS, type LegacyColumn } from './legacy-import-layout.ts'
import { LegacyImportError, legacyDigest, legacyLimits,
  type LegacyBundle, type LegacyImportLimits } from './legacy-import-codec.ts'

/** Original database text cells, including NULL, before migration classification. */
export type LegacyMigrationCells = Readonly<Record<string, string | null>>
/** Original tables and the database snapshot/catalog observed by the read-only producer. */
export interface LegacyMigrationCapture {
  readonly format: 'power-evolve-legacy-offline'
  readonly version: 2
  readonly source: LegacyBundle['source']
  readonly snapshot: string
  readonly catalogSha256: string
  readonly tables: Readonly<Record<string, readonly LegacyMigrationCells[]>>
  readonly sha256: string
}
/** Explicit offline connection identity and capture budgets; no live-source or stop operation exists. */
export interface LegacyMigrationCaptureOptions {
  readonly purpose: 'offline-readonly-export'
  readonly expectedDatabase: string
  readonly expectedCatalogSha256: string
  readonly batchRows: number
  readonly statementTimeoutMs: number
  readonly limits: LegacyImportLimits
}
const cells = z.record(z.string(), z.string().nullable())
const pgKind: Readonly<Record<string, LegacyColumn['kind']>> = {
  uuid: 'uuid', text: 'text', int4: 'integer', int8: 'bigint', bool: 'boolean',
  json: 'json', jsonb: 'jsonb', timestamptz: 'timestamptz', bytea: 'bytea',
}
function identifier(name: string): string {
  if (!/^[a-z_][a-z_0-9]*$/u.test(name)) throw new LegacyImportError('capture_identifier')
  return `"${name}"`
}
function projection(name: string, column: LegacyColumn): string {
  const quoted = identifier(name)
  return column.kind === 'timestamptz'
    ? `CASE WHEN ${quoted} IS NULL THEN NULL WHEN isfinite(${quoted}) THEN to_char(${quoted} AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE ${quoted}::text END AS ${quoted}`
    : `${quoted}::text AS ${quoted}`
}

/** Fingerprint catalog definitions without database-specific OIDs or data cells.
 * @param client Caller-owned transaction on the detached source.
 * @returns SHA-256 of ordered tables, columns, constraints, indexes, triggers and function definitions.
 */
export async function legacyMigrationCatalogDigest(client: PoolClient): Promise<string> {
  const definitions = await client.query<{
    category: string
    identity: string
    definition: string
  }>(`
    SELECT category,identity,definition FROM (
      SELECT 'relation' AS category,c.relname AS identity,c.relkind::text AS definition
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL SELECT 'column',c.relname||'.'||a.attname,
        json_build_array(a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,
          pg_get_expr(d.adbin,d.adrelid))::text
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL SELECT 'constraint',c.conrelid::regclass::text||'.'||c.conname,
        json_build_array(c.contype,c.condeferrable,c.condeferred,c.convalidated,pg_get_constraintdef(c.oid,true))::text
        FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
      UNION ALL SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname='public'
      UNION ALL SELECT 'trigger',c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid,true)
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND NOT t.tgisinternal
      UNION ALL SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',pg_get_functiondef(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    ) definitions ORDER BY category COLLATE "C",identity COLLATE "C",definition COLLATE "C"`)
  return legacyDigest(JSON.stringify(definitions.rows))
}

async function sourceIdentity(client: PoolClient, options: LegacyMigrationCaptureOptions): Promise<void> {
  const identity = await client.query<{
    database: string
    readonly: string
    isolation: string
    privileged: boolean
    writable: boolean
  }>(`
    SELECT current_database() AS database,current_setting('transaction_read_only') AS readonly,
      current_setting('transaction_isolation') AS isolation,
      r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls AS privileged,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
          AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS writable
    FROM pg_roles r WHERE r.rolname=current_user`)
  const row = identity.rows[0]
  if (!row || row.database !== options.expectedDatabase || row.readonly !== 'on'
    || row.isolation !== 'repeatable read' || row.privileged || row.writable) throw new LegacyImportError('capture_source_identity')
  const columns = await client.query<{
    table: string
    column: string
    kind: string
    nullable: boolean
    generated: boolean
  }>(`
    SELECT c.relname AS table,a.attname AS column,t.typname AS kind,NOT a.attnotnull AS nullable,
      a.attgenerated<>'' AS generated FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid
      WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)
  if (columns.rows.length !== 844 || new Set(columns.rows.map(item => item.table)).size !== 77
    || columns.rows.some((item) => {
      const fixed = LEGACY_SOURCE_LAYOUT[item.table]?.[item.column]
      return !fixed || pgKind[item.kind] !== fixed.kind || item.nullable !== fixed.nullable || item.generated !== fixed.generated
    })) throw new LegacyImportError('capture_source_columns')
  const version = await client.query<{ version: string }>('SELECT version::text AS version FROM public.pe_schema')
  if (version.rows.length !== 1 || version.rows[0]?.version !== '37') throw new LegacyImportError('capture_source_schema')
  if (await legacyMigrationCatalogDigest(client) !== options.expectedCatalogSha256) throw new LegacyImportError('capture_source_catalog')
}

/** Capture all77 original tables under one read-only repeatable-read snapshot.
 * @param pool Explicit offline restored-source pool, never a target or running-source discovery mechanism.
 * @param source Independently supplied source/cut identity; capture does not authenticate physical stops.
 * @param options Exact offline database/catalog and explicit bounded cursor configuration.
 * @param signal Maintenance lifetime; PostgreSQL statement timeouts bound each pending read.
 * @returns Original text cells and their snapshot-bound digest, without dispositions or target writes.
 */
export async function captureLegacyMigrationSource(pool: Pool, source: LegacyBundle['source'],
  options: LegacyMigrationCaptureOptions, signal: AbortSignal): Promise<LegacyMigrationCapture> {
  const limits = legacyLimits(options.limits)
  if (source.ddlSha256 !== LEGACY_SQL_DIGESTS.source37
    || !/^[a-f0-9]{64}$/u.test(options.expectedCatalogSha256) || !Number.isSafeInteger(options.batchRows)
    || options.batchRows < 1 || !Number.isSafeInteger(options.statementTimeoutMs) || options.statementTimeoutMs < 1) {
    throw new LegacyImportError('capture_config')
  }
  signal.throwIfAborted()
  const client = await pool.connect()
  let discard = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL TIME ZONE 'UTC'")
    await client.query("SET LOCAL bytea_output='hex'")
    await client.query("SELECT set_config('statement_timeout',$1,true)", [String(options.statementTimeoutMs)])
    await sourceIdentity(client, options)
    const snapshot = (await client.query<{ snapshot: string }>('SELECT txid_current_snapshot()::text AS snapshot')).rows[0]?.snapshot
    if (!snapshot) throw new LegacyImportError('capture_snapshot')
    const tables: Record<string, readonly LegacyMigrationCells[]> = {}
    let rowCount = 0, encodedBytes = 0
    for (const [table, layout] of Object.entries(LEGACY_SOURCE_LAYOUT)) {
      signal.throwIfAborted()
      const count = (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.${identifier(table)}`)).rows[0]?.count
      if (!count || BigInt(count) + BigInt(rowCount) > BigInt(limits.maxRows)) throw new LegacyImportError('capture_row_limit')
      const columns = Object.keys(layout)
      const maximum = (await client.query<{ maximum: string | null }>(`SELECT max(greatest(${columns.map(column =>
        `octet_length(${identifier(column)}::text)`).join(',')}))::text AS maximum FROM public.${identifier(table)}`)).rows[0]?.maximum
      if (maximum !== null && maximum !== undefined && BigInt(maximum) > BigInt(limits.maxCellBytes)) {
        throw new LegacyImportError('capture_cell_limit', table)
      }
      await client.query(`DECLARE migration_capture NO SCROLL CURSOR FOR SELECT ${Object.entries(layout)
        .map(([name, column]) => projection(name, column)).join(',')} FROM public.${identifier(table)}`)
      const original: LegacyMigrationCells[] = []
      for (;;) {
        signal.throwIfAborted()
        const batch = z.array(cells).parse((await client.query(`FETCH FORWARD ${options.batchRows} FROM migration_capture`)).rows)
        if (!batch.length) break
        for (const values of batch) {
          if (Object.keys(values).length !== columns.length) throw new LegacyImportError('capture_cell_inventory', table)
          for (const [name, specification] of Object.entries(layout)) {
            const value = values[name]
            if (value === undefined) throw new LegacyImportError('capture_missing_cell', table)
            if (value === null && !specification.nullable || value !== null && Buffer.byteLength(value) > limits.maxCellBytes) {
              throw new LegacyImportError('capture_cell_invalid', `${table}.${name}`)
            }
          }
          encodedBytes += Buffer.byteLength(JSON.stringify(values))
          if (encodedBytes > limits.maxBundleBytes) throw new LegacyImportError('capture_bundle_limit')
          original.push(Object.freeze(values)); rowCount++
        }
      }
      await client.query('CLOSE migration_capture')
      if (BigInt(original.length) !== BigInt(count)) throw new LegacyImportError('capture_count_changed', table)
      original.sort((left, right) => legacyDigest(JSON.stringify(left)).localeCompare(legacyDigest(JSON.stringify(right))))
      tables[table] = Object.freeze(original)
    }
    signal.throwIfAborted()
    const body = Object.freeze({ format: 'power-evolve-legacy-offline' as const, version: 2 as const,
      source: Object.freeze({ ...source }), snapshot,
      catalogSha256: options.expectedCatalogSha256, tables: Object.freeze(tables) })
    const text = JSON.stringify(body)
    if (Buffer.byteLength(text) > limits.maxBundleBytes) throw new LegacyImportError('capture_bundle_limit')
    await client.query('ROLLBACK')
    return Object.freeze({ ...body, sha256: legacyDigest(text) })
  } catch (error) {
    try { await client.query('ROLLBACK') }
    catch (_connectionUnavailable) { discard = true }
    if (error instanceof LegacyImportError) throw error
    signal.throwIfAborted()
    throw new LegacyImportError('capture_postgres_rejected')
  } finally { client.release(discard) }
}
