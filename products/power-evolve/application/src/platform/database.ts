/** Cloud schema lifecycle and transaction ownership on the trusted Platform. */
import { readFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

/** Database family prevents an old product version from being mistaken for the cloud migration. */
export const SCHEMA_FAMILY = 'cloud-native'
/** Current adjacent version inside the cloud database family. */
export const CURRENT_SCHEMA_VERSION = 12

/** Run exclusive transactional work, preserving its failure and discarding disconnected clients.
 * @param pool Database connection owner.
 * @param operation Work that settles before the exclusive connection is released.
 * @returns The operation's result after successful commit.
 */
export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let connectionError: Error | undefined
  let discard = false
  const onConnectionError = (error: Error) => { connectionError ??= error }
  const connectionFailure = (): Error | undefined => connectionError
  const discardConnection = (): boolean => discard || !!connectionError
  client.on('error', onConnectionError)
  try {
    await client.query('BEGIN')
    const failureAfterBegin = connectionFailure()
    if (failureAfterBegin) throw failureAfterBegin
    const result = await operation(client)
    const failureAfterOperation = connectionFailure()
    if (failureAfterOperation) throw failureAfterOperation
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (!connectionFailure()) {
      try { await client.query('ROLLBACK') }
      catch (_disconnected) { discard = true /* Preserve the operation failure. */ }
    }
    throw error
  } finally {
    client.release(discardConnection())
    client.removeListener('error', onConnectionError)
  }
}

/** Bootstrap an empty cloud database; legacy, partial and newer databases are rejected without writes.
 * @param pool Platform connection pool; concurrent bootstraps serialize under the same advisory lock.
 */
export async function initializeDatabase(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(72819531)')
    const tables = await client.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
    if (tables.rows.length === 0) {
      const ddl = await readFile(new URL('../../assets/cloud-schema-v1.sql', import.meta.url), 'utf8')
      // The schema orders SQL functions before their tables, as pg_dump does.
      await client.query('SET LOCAL check_function_bodies=false')
      await client.query(ddl)
      await client.query('INSERT INTO pe_schema(version,family) VALUES($1,$2)', [1, SCHEMA_FAMILY])
    }
    const columns = await client.query<{ name: string }>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='pe_schema'",
    )
    if (!columns.rows.some(row => row.name === 'family')) throw new Error('Legacy or partial database requires an isolated cloud import')
    const versions = await client.query<{ family: string; version: number }>('SELECT family,version FROM pe_schema')
    const entry = versions.rows[0]
    const version = entry?.version
    if (versions.rows.length !== 1 || entry?.family !== SCHEMA_FAMILY
      || (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5
        && version !== 6 && version !== 7 && version !== 8 && version !== 9
        && version !== 10 && version !== 11 && version !== CURRENT_SCHEMA_VERSION)) throw new Error('Unsupported PowerEvolve cloud schema')
    await assertManifest(client, version)
    for (let current = version; current < CURRENT_SCHEMA_VERSION; current++) {
      const next = current + 1
      await client.query(await readFile(new URL(`../../assets/cloud-schema-v${next}.sql`, import.meta.url), 'utf8'))
      await client.query('UPDATE pe_schema SET version=$1 WHERE version=$2', [next, current])
      await assertManifest(client, next)
    }
  })
}

async function assertManifest(client: PoolClient, version: number): Promise<void> {
  const expected = z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).parse(JSON.parse(
    await readFile(new URL(`../../assets/cloud-schema-v${version}.manifest.json`, import.meta.url), 'utf8'),
  ))
  const present = await client.query<{ table_name: string; column_name: string }>(
    "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name",
  )
  const actual = new Map<string, Set<string>>()
  for (const row of present.rows) {
    let fields = actual.get(row.table_name)
    if (!fields) actual.set(row.table_name, fields = new Set())
    fields.add(row.column_name)
  }
  if (actual.size !== Object.keys(expected).length || Object.entries(expected).some(([name, fields]) =>
    actual.get(name)?.size !== fields.length || fields.some(field => !actual.get(name)?.has(field)))) {
    throw new Error('Incomplete PowerEvolve cloud schema')
  }
}
