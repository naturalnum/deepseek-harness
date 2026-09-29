/** Transaction and schema lifecycle owned by the trusted platform. */
import { Pool, type PoolClient } from 'pg'
import { schema, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8, schemaV9, schemaV10, schemaV11, schemaV12 } from './schema.ts'

/** Run one operation in a transaction, retaining its original failure after rollback. */
export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') }
    catch (_connectionUnavailable) { /* Retain the transaction's original failure. */ }
    throw error
  } finally { client.release() }
}

/** Initialize the product schema once under a database lock; refuse newer schemas. */
export async function initializeDatabase(pool: Pool): Promise<void> {
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(72819531)')
    await client.query(schema)
    await client.query('INSERT INTO pe_schema(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pe_schema)')
    const versions = await client.query<{ version: number }>('SELECT version FROM pe_schema ORDER BY version')
    if (versions.rows.length !== 1 || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(versions.rows[0]!.version)) throw new Error('Unsupported PowerEvolve schema version')
    const initialVersion = versions.rows[0]!.version
    if (initialVersion < 2) await client.query(schemaV2)
    if (initialVersion < 3) await client.query(schemaV3)
    if (initialVersion < 4) await client.query(schemaV4)
    if (initialVersion < 5) await client.query(schemaV5)
    if (initialVersion < 6) await client.query(schemaV6)
    if (initialVersion < 7) await client.query(schemaV7)
    if (initialVersion < 8) await client.query(schemaV8)
    if (initialVersion < 9) await client.query(schemaV9)
    if (initialVersion < 10) await client.query(schemaV10)
    if (initialVersion < 11) await client.query(schemaV11)
    if (initialVersion < 12) await client.query(schemaV12)
  })
}
