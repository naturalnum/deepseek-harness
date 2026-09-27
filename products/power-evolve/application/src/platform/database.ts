/** Transaction and schema lifecycle owned by the trusted platform. */
import { Pool, type PoolClient } from 'pg'
import { schema } from './schema.ts'

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
    const versions = await client.query<{ version: number }>('SELECT version FROM pe_schema ORDER BY version')
    if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) throw new Error('Unsupported PowerEvolve schema version')
  })
}
