/** Transaction and schema lifecycle owned by the trusted platform. */
import { Pool, type PoolClient } from 'pg'
import { schemaV27 } from './storage-binding-schema.ts'
import { schemaV29 } from './device-execution-schema.ts'
import { schemaV30 } from './device-resolution-schema.ts'
import { schemaV28 } from './execution-resolution-schema.ts'
import { CURRENT_SCHEMA_VERSION, schema, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8, schemaV9, schemaV10, schemaV11, schemaV12, schemaV13, schemaV14, schemaV15, schemaV16, schemaV17, schemaV18, schemaV19, schemaV20, schemaV21, schemaV22, schemaV23, schemaV24, schemaV25, schemaV26 } from './schema.ts'

/**
 * Run one operation in a transaction; retain its failure and discard disconnected clients.
 * @param pool Pool supplying the transaction's exclusive client.
 * @param operation Work that settles before the client is released.
 * @returns The operation's result after commit succeeds.
 */
export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let connectionError: Error | undefined
  let discard = false
  const onConnectionError = (error: Error) => { connectionError ??= error }
  client.on('error', onConnectionError)
  try {
    await client.query('BEGIN')
    if (connectionError) throw connectionError
    const result = await operation(client)
    if (connectionError) throw connectionError
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (!connectionError) {
      try { await client.query('ROLLBACK') }
      catch (_connectionUnavailable) { discard = true /* Retain the transaction's original failure. */ }
    }
    throw error
  } finally {
    client.release(discard || !!connectionError)
    client.removeListener('error', onConnectionError)
  }
}

/** Initialize the product schema once under a database lock; refuse newer schemas. */
export async function initializeDatabase(pool: Pool): Promise<void> {
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(72819531)')
    await client.query(schema)
    await client.query('INSERT INTO pe_schema(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pe_schema)')
    const versions = await client.query<{ version: number }>('SELECT version FROM pe_schema ORDER BY version')
    if (versions.rows.length !== 1 || versions.rows[0]!.version < 1
      || versions.rows[0]!.version > CURRENT_SCHEMA_VERSION) throw new Error('Unsupported PowerEvolve schema version')
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
    if (initialVersion < 13) await client.query(schemaV13)
    if (initialVersion < 14) await client.query(schemaV14)
    if (initialVersion < 15) await client.query(schemaV15)
    if (initialVersion < 16) await client.query(schemaV16)
    if (initialVersion < 17) await client.query(schemaV17)
    if (initialVersion < 18) await client.query(schemaV18)
    if (initialVersion < 19) await client.query(schemaV19)
    if (initialVersion < 20) await client.query(schemaV20)
    if (initialVersion < 21) await client.query(schemaV21)
    if (initialVersion < 22) await client.query(schemaV22)
    if (initialVersion < 23) await client.query(schemaV23)
    if (initialVersion < 24) await client.query(schemaV24)
    if (initialVersion < 25) await client.query(schemaV25)
    if (initialVersion < 26) await client.query(schemaV26)
    if (initialVersion < 27) await client.query(schemaV27)
    if (initialVersion < 28) await client.query(schemaV28)
    if (initialVersion < 29) await client.query(schemaV29)
    if (initialVersion < 30) await client.query(schemaV30)
  })
}
