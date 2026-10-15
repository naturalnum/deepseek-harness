/** Native guarded edits serialize only aliases of the same physical path across every owner kind. */
import { posix } from 'node:path'
import type { Pool } from 'pg'
import type { NativeExecutionProcessWorld } from '../native-execution/types.ts'
import type { StorageBinding } from './cloud-storage-types.ts'
import { PlatformError } from '../contracts.ts'

const usage = new WeakMap<Pool, { active: number }>()

/** Hold the original physical-path lock until the single mutation and exact worker cleanup settle.
 * Account and Session locks must already have been released; two PG slots remain available for authority and cleanup.
 * @param pool Trusted provider pool shared by Agent and independent service owners.
 * @param world Original execution owner and storage address.
 * @param binding Current server-selected physical root.
 * @param path Canonical execution-world path.
 * @param apply Original non-replayed mutation.
 * @returns Native mutation outcome after joined worker cleanup.
 */
export async function mutateNativeExecutionPath<T>(pool: Pool, world: NativeExecutionProcessWorld,
  binding: StorageBinding, path: string, apply: () => Promise<T>): Promise<T> {
  const inside = (root: string) => path === root || path.startsWith(root + '/')
  if (posix.normalize(path) !== path) throw new PlatformError(409, 'native_fs_path_not_canonical')
  const physical = inside('/workspace') ? ['workspace', binding.rootKey,
    posix.join(binding.rootRelativePath, posix.relative('/workspace', path))]
    : inside('/tmp') ? ['temporary', world.userId, world.sessionId, posix.relative('/tmp', path)]
      : inside('/home/agent') ? ['home', world.userId, posix.relative('/home/agent', path)] : null
  if (physical === null) throw new PlatformError(403, 'native_fs_path_outside_world')
  let current = usage.get(pool)
  if (!current) { current = { active: 0 }; usage.set(pool, current) }
  const maximum = pool.options.max
  if (maximum < 3 || current.active >= maximum - 2) throw new PlatformError(429, 'native_fs_capacity')
  current.active++
  try {
    const client = await pool.connect(), key = JSON.stringify(physical)
    let locked = false, releaseError: unknown
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key])
      locked = true
      return await apply()
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]) }
      catch (error) { releaseError = error; throw error }
      finally { client.release(releaseError !== undefined) }
    }
  } finally { current.active-- }
}
