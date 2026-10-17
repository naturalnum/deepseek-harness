/** Runtime-only secret configuration reader for actual instance metadata tests and child startups. */
import { readFile } from 'node:fs/promises'
import type { OwnerPgConnection } from '../src/owner-pg-executor.ts'

/**
 * Select only the coordinator-assigned runtime database; never log target or secret fields.
 * @param path Private root-provided JSON path.
 * @returns Explicit driver input for this database, with no ambient selection.
 */
export async function instanceTestConnection(path: string): Promise<OwnerPgConnection> {
  const input: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof input !== 'object' || input === null || !('host' in input) || !('port' in input)
    || !('user' in input) || !('password' in input) || !('databases' in input)) throw new Error('Assigned instance-test configuration is incomplete')
  const databases = input.databases
  if (typeof databases !== 'object' || databases === null || !('runtime' in databases) || typeof databases.runtime !== 'string'
    || typeof input.host !== 'string' || typeof input.user !== 'string' || typeof input.password !== 'string') {
    throw new Error('Assigned runtime database fields are invalid')
  }
  const port = typeof input.port === 'number' ? input.port : Number(input.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Assigned runtime database port is invalid')
  return { host: input.host, port, user: input.user, password: input.password, database: databases.runtime, ssl: false }
}
