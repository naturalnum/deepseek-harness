/** Fixed schema2 transactional successor writer; prior importer modules and DDL generations remain immutable. */
import { readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { parseEvents } from '../session-records.ts'
import { LEGACY_FOREIGN_KEYS, LEGACY_PRIMARY_KEYS, LEGACY_SQL_DIGESTS, LEGACY_TARGET_LAYOUT } from './legacy-import-layout.ts'
import { LEGACY_LATE_CONSTRAINTS, legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { LegacyImportError, legacyDigest, legacyJson } from './legacy-import-codec.ts'
import type { LegacyStorageOptions } from './legacy-import-storage.ts'
import { checkpointNativeProjections } from './native-projections.ts'
import { assertLegacyMigrationPlan, type LegacyMigrationPlan } from './legacy-migration-v2-plan.ts'
import { stageLegacyHistoryFiles } from './legacy-migration-v2-attachments.ts'
import { stageLegacyHistoryImages } from './legacy-migration-v2-images.ts'
import { legacyMigrationImageLedger } from './legacy-migration-v2-media-contracts.ts'
import { stageLegacyMigrationStorage, discardLegacyMigrationStorage, writeLegacyMigrationReceipt,
  type LegacyMigrationStorage } from './legacy-migration-v2-storage.ts'

/** Only new target identities and detached file assignments may enter the successor writer. */
export interface LegacyMigrationWriteOptions {
  readonly expectedDatabase: string
  readonly statementTimeoutMs: number
  readonly storage: LegacyStorageOptions
  readonly attachmentSourceRoots: Readonly<Record<string, string>>
  readonly imageSourceHomes?: Readonly<Record<string, string>>
  readonly maxImagePixels?: number
}
/** Compared committed schema2 candidate, ready for a separately reported adjacent schema3 initialization. */
export interface LegacyMigrationWriteResult {
  readonly family: 'cloud-native'
  readonly version: 2
  readonly storage: LegacyMigrationStorage
  readonly captureSha256: string
  readonly tableCounts: Readonly<Record<string, string>>
}
const quote = (name: string): string => {
  if (!/^[a-z_][a-z_0-9]*$/u.test(name)) throw new LegacyImportError('migration_sql_identifier')
  return `"${name}"`
}
async function fixedAssets() {
  const original = await readFile(new URL('../../assets/cloud-schema-v1.sql', import.meta.url), 'utf8')
  const adjacent = await readFile(new URL('../../assets/cloud-schema-v2.sql', import.meta.url), 'utf8')
  if (legacyDigest(original) !== LEGACY_SQL_DIGESTS.cloud1 || legacyDigest(adjacent) !== LEGACY_SQL_DIGESTS.cloud2) {
    throw new LegacyImportError('migration_ddl_changed')
  }
  let initial = original
  const late: string[] = []
  for (const name of LEGACY_LATE_CONSTRAINTS) {
    const matches = original.match(new RegExp(`ALTER TABLE ONLY public\\.[a-z_0-9]+\\n    ADD CONSTRAINT ${name} [^;]+;`, 'gu'))
    if (matches?.length !== 1 || !matches[0]) throw new LegacyImportError('migration_late_constraint_missing', name)
    late.push(matches[0]); initial = initial.replace(matches[0], '')
  }
  return { initial, adjacent, late }
}
async function admitEmptyTarget(client: PoolClient, expectedDatabase: string): Promise<void> {
  const identity = await client.query<{ database: string }>('SELECT current_database() AS database')
  if (identity.rows[0]?.database !== expectedDatabase) throw new LegacyImportError('migration_target_identity')
  const objects = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema','pg_toast')
    UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
    UNION ALL SELECT 1 FROM pg_extension WHERE extname<>'plpgsql'`)
  if (objects.rows.length) throw new LegacyImportError('migration_target_not_empty')
}
async function parameterRow(client: PoolClient, row: LegacyPlannedRow): Promise<void> {
  const layout = LEGACY_TARGET_LAYOUT[row.table]
  if (!layout) throw new LegacyImportError('migration_insert_table')
  const columns = Object.entries(layout).filter(([, field]) => !field.generated)
  await client.query(`INSERT INTO public.${quote(row.table)}(${columns.map(([name]) => quote(name)).join(',')})
    VALUES(${columns.map(([, field], index) => `$${index + 1}::${field.kind}`).join(',')})`,
  columns.map(([name]) => row.values[name]))
}
async function compareOriginalRows(client: PoolClient, plan: LegacyMigrationPlan): Promise<void> {
  for (const row of plan.rows) {
    const layout = LEGACY_TARGET_LAYOUT[row.table], keys = LEGACY_PRIMARY_KEYS[row.table]
    if (!layout || !keys) throw new LegacyImportError('migration_compare_layout')
    const columns = Object.keys(layout)
    const projection = columns.map(name => layout[name]?.kind === 'timestamptz'
      ? `to_char(${quote(name)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${quote(name)}`
      : `${quote(name)}::text AS ${quote(name)}`).join(',')
    const values = await client.query<Record<string, string | null>>(`SELECT ${projection} FROM public.${quote(row.table)}
      WHERE ${keys.map((key, index) => `${quote(key)} IS NOT DISTINCT FROM $${index + 1}::${layout[key]?.kind}`).join(' AND ')}`,
    keys.map(key => row.values[key]))
    const stored = values.rows[0]
    if (!stored || values.rows.length !== 1) throw new LegacyImportError('migration_compare_missing', row.table)
    for (const name of columns) {
      const expected = row.values[name], actual = stored[name]
      let equal = expected === actual
      if (expected !== null && expected !== undefined && actual !== null && actual !== undefined) {
        if (layout[name]?.kind === 'jsonb') equal = isDeepStrictEqual(legacyJson(expected, plan.limits), legacyJson(actual, plan.limits))
        if (layout[name]?.kind === 'timestamptz') equal = legacyTimestamp(expected) === legacyTimestamp(actual)
      }
      if (!equal) throw new LegacyImportError('migration_compare_changed', `${row.table}.${name}`)
    }
  }
}
async function compareConstraints(client: PoolClient): Promise<void> {
  const result = await client.query<{
    name: string
    table: string
    target: string
    columns: string[]
    references: string[]
    valid: boolean
    deferrable: boolean
    deferred: boolean
  }>(`
    SELECT c.conname AS name,f.relname AS table,t.relname AS target,c.convalidated AS valid,
      c.condeferrable AS deferrable,c.condeferred AS deferred,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
        JOIN pg_attribute a ON a.attrelid=f.oid AND a.attnum=k.num ORDER BY k.ord) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.num ORDER BY k.ord) AS references
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      JOIN pg_class f ON f.oid=c.conrelid JOIN pg_class t ON t.oid=c.confrelid
    WHERE n.nspname='public' AND c.contype='f'`)
  if (result.rows.length !== LEGACY_FOREIGN_KEYS.length || LEGACY_FOREIGN_KEYS.some((key) => {
    const actual = result.rows.find(item => item.name === key.name)
    return !actual || actual.table !== key.table || actual.target !== key.target || !actual.valid
      || actual.deferrable !== key.deferred || actual.deferred !== key.deferred
      || !isDeepStrictEqual(actual.columns, key.columns) || !isDeepStrictEqual(actual.references, key.references)
  })) throw new LegacyImportError('migration_constraint_changed')
}

/** Import the qualified current relation and actual file bytes under the normal schema advisory lock.
 * @param pool Explicit empty-target pool; source connections are never used for writes.
 * @param plan Current-process issued successor plan with original capture and source-backed receipts.
 * @param options New target/database/root identities and bounded statement timeout.
 * @param signal Maintenance lifetime; no business worker, task, model or continuation is started.
 * @returns Independently compared committed schema2 candidate; uncertain commit/publication preserves its owned root.
 */
export async function writeLegacyMigration(pool: Pool, plan: LegacyMigrationPlan, options: LegacyMigrationWriteOptions,
  signal: AbortSignal): Promise<LegacyMigrationWriteResult> {
  assertLegacyMigrationPlan(plan)
  if (!options.expectedDatabase || !Number.isSafeInteger(options.statementTimeoutMs)
    || options.statementTimeoutMs < 1) throw new LegacyImportError('migration_write_config')
  const assets = await fixedAssets(), client = await pool.connect()
  let candidate: LegacyMigrationStorage | undefined, commitAttempted = false, committed = false
  const connection = { discard: false }
  const failed = () => { connection.discard = true }
  client.on('error', failed)
  try {
    signal.throwIfAborted()
    await client.query('BEGIN')
    await client.query("SELECT set_config('statement_timeout',$1,true)", [String(options.statementTimeoutMs)])
    await client.query('SELECT pg_advisory_xact_lock(72819531)')
    await admitEmptyTarget(client, options.expectedDatabase)
    const future = await client.query<{ allowed: boolean }>('SELECT $1::timestamptz<=clock_timestamp() AS allowed', [plan.capture.source.cut])
    if (!future.rows[0]?.allowed) throw new LegacyImportError('migration_future_cut')
    const fileObjects = new Map(plan.receipts.map(receipt => [
      JSON.stringify([receipt.userId, receipt.storageSessionId, receipt.file]), receipt.file.bytes,
    ]))
    const fileBytesByObject = new Map(plan.receipts.map(receipt => [
      JSON.stringify([receipt.userId, receipt.storageSessionId, receipt.file.attachmentId]), receipt.file.bytes,
    ]))
    const imageObjectsByIdentity = new Map(plan.images.map(binding => [
      JSON.stringify([binding.userId, binding.storageSessionId, binding.image.attachmentId]), binding.image.bytes,
    ]))
    const selectedBytes = plan.files.reduce((sum, entry) => sum + (entry.kind === 'file' && entry.bytes !== null ? BigInt(entry.bytes) : 0n), 0n)
      + [...fileBytesByObject.values(), ...imageObjectsByIdentity.values()].reduce((sum, bytes) => sum + BigInt(bytes), 0n)
    if (plan.files.length + fileObjects.size + imageObjectsByIdentity.size > plan.limits.maxFiles
      || selectedBytes > BigInt(plan.limits.maxStorageBytes)) throw new LegacyImportError('migration_storage_budget')
    candidate = await stageLegacyMigrationStorage(plan, options.storage)
    const objects = await stageLegacyHistoryFiles(plan.receipts, options.attachmentSourceRoots,
      candidate.roots.attachmentRoot, plan.limits, signal)
    let imageObjects: readonly string[] = []
    if (plan.images.length) {
      if (options.imageSourceHomes === undefined || options.maxImagePixels === undefined) {
        throw new LegacyImportError('migration_image_configuration_missing')
      }
      imageObjects = await stageLegacyHistoryImages(plan.images, options.imageSourceHomes,
        candidate.roots.attachmentRoot, plan.limits, options.maxImagePixels, signal)
    }
    await writeFile(join(candidate.root, 'migration-source-v2.json'), JSON.stringify(plan.capture) + '\n', { flag: 'wx', mode: 0o600 })
    await writeLegacyMigrationReceipt(candidate, 'storage-staged', { captureSha256: plan.capture.sha256, objects, imageObjects })
    await client.query('SET LOCAL search_path=public,pg_catalog')
    await client.query('SET LOCAL check_function_bodies=false')
    await client.query(assets.initial)
    await client.query(assets.adjacent)
    for (const row of plan.rows) { signal.throwIfAborted(); await parameterRow(client, row) }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    for (const statement of assets.late) await client.query(statement)
    for (const history of plan.histories) {
      await checkpointNativeProjections(client, history.userId, history.header, 0, parseEvents(history.header, history.events))
    }
    for (const receipt of plan.receipts) {
      await client.query(`INSERT INTO pe_native_file_receipts(id,user_id,session_id,storage_session_id,file,request_id)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [receipt.id, receipt.userId, receipt.sessionId, receipt.storageSessionId,
        JSON.stringify(receipt.file), receipt.bindingRequestId])
      const stored = await client.query<{
        file: unknown
        user_id: string
        session_id: string
        storage_session_id: string
        request_id: string
      }>(
        'SELECT file,user_id,session_id,storage_session_id,request_id FROM pe_native_file_receipts WHERE id=$1', [receipt.id])
      const row = stored.rows[0]
      if (!row || !isDeepStrictEqual(row.file, receipt.file) || row.user_id !== receipt.userId || row.session_id !== receipt.sessionId
        || row.storage_session_id !== receipt.storageSessionId || row.request_id !== receipt.bindingRequestId) {
        throw new LegacyImportError('migration_receipt_comparison')
      }
    }
    const owners = [...new Set(plan.histories.map(history => history.userId))]
    const imageSessions = [...new Set(plan.images.map(image => image.sessionId))]
    for (const sessionId of imageSessions) {
      const bindings = plan.images.filter(image => image.sessionId === sessionId), userId = bindings[0]?.userId
      const ledger = legacyMigrationImageLedger.parse({ version: 1, userId, sessionId, bindings })
      const namespace = `legacy-migration-v2-images:${sessionId}`
      await client.query('INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3::jsonb,1)',
        [userId, namespace, JSON.stringify(ledger)])
      const stored = await client.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
        [userId, namespace])
      if (!isDeepStrictEqual(legacyMigrationImageLedger.parse(stored.rows[0]?.value), ledger)) {
        throw new LegacyImportError('migration_image_ledger_changed')
      }
    }
    for (const owner of owners) {
      await client.query('INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3::jsonb,1)',
        [owner, `legacy-migration-v2:${plan.migrationId}`, JSON.stringify({ version: 2, captureSha256: plan.capture.sha256,
          authority: 'verified-history-migration', receipts: plan.receipts.filter(receipt => receipt.userId === owner),
          histories: plan.histories.filter(history => history.userId === owner).map(history => ({ sessionId: history.sessionId,
            sourceHeaderSha256: history.sourceHeaderSha256, sourceRows: history.sourceRows, sourceVersion: history.sourceVersion,
            encoding: history.encoding, coordinates: history.coordinates, inheritedEventCount: history.inheritedEventCount,
            targetSha256: history.targetSha256 })) })])
    }
    await compareOriginalRows(client, plan)
    await compareConstraints(client)
    const tableCounts: Record<string, string> = {}
    for (const table of Object.keys(LEGACY_TARGET_LAYOUT)) {
      const expected = table === 'pe_native_preferences' ? plan.histories.length + owners.length + imageSessions.length
        : table === 'pe_native_file_receipts' ? plan.receipts.length : plan.rows.filter(row => row.table === table).length
      const count = (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.${quote(table)}`)).rows[0]?.count
      if (count !== String(expected)) throw new LegacyImportError('migration_table_count', table)
      tableCounts[table] = count
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    signal.throwIfAborted()
    if (connection.discard) throw new LegacyImportError('migration_connection_lost')
    commitAttempted = true
    await client.query('COMMIT'); committed = true
    await writeLegacyMigrationReceipt(candidate, 'schema2-compared', { captureSha256: plan.capture.sha256, tableCounts,
      receipts: plan.receipts, objects, images: plan.images, imageObjects })
    return Object.freeze({ family: 'cloud-native', version: 2, storage: candidate, captureSha256: plan.capture.sha256,
      tableCounts: Object.freeze(tableCounts) })
  } catch (error) {
    if (!commitAttempted) {
      try { await client.query('ROLLBACK') }
      catch (_rollbackUnresolved) { connection.discard = true }
      if (candidate && !connection.discard) await discardLegacyMigrationStorage(candidate)
    } else if (candidate) {
      try { await writeLegacyMigrationReceipt(candidate, committed ? 'publication-unresolved' : 'commit-unresolved', {}) }
      catch (_receiptUnavailable) { /* Preserve the candidate and the ambiguous database outcome. */ }
      throw new LegacyImportError(committed ? 'migration_publication_unresolved' : 'migration_commit_unresolved', candidate.root)
    }
    if (error instanceof LegacyImportError) throw error
    signal.throwIfAborted()
    const state = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/u.test(error.code)
      ? error.code : ''
    throw new LegacyImportError('migration_database_rejected', state)
  } finally { client.off('error', failed); client.release(connection.discard) }
}
