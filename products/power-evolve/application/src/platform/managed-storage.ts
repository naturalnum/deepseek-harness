/** Persistent cloud roots: create only accepted provisioning; missing ready bytes remain unavailable. */
import assert from 'node:assert/strict'
import type { Pool, PoolClient } from 'pg'
import { PlatformError } from '../contracts.ts'
import { accountUserId } from '../account-contracts.ts'
import { requireActiveAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { storageBinding, type StorageBinding } from './cloud-storage-types.ts'
import type { SafePosix } from './safe-posix.ts'

interface StorageRow {
  id: string
  user_id: string
  title: string
  binding_generation: string
  binding_state: string
  space_id: string | null
  root_relative_path: string | null
  root_key: string | null
  root_state: string | null
}

/** Storage addresses are fixed by Platform metadata before any writer obtains a mount. */
export class ManagedCloudStorage {
  constructor(private readonly pool: Pool, private readonly safe: SafePosix) {}

  /** Resolve one owned mount, preserving imported addresses and refusing to recreate missing ready files.
   * @param userId Authenticated account owner.
   * @param workspaceId Accepted logical Workspace identity.
   * @param client Optional owner-locked admission transaction.
   * @returns Descriptor-verified storage address and its captured generation.
   */
  async resolve(userId: string, workspaceId: string, client?: PoolClient): Promise<StorageBinding> {
    if (!client) return transaction(this.pool, async (current) => {
      await requireActiveAccount(current, accountUserId.parse(userId), 'update')
      return this.resolve(userId, workspaceId, current)
    })
    const read = async () => {
      const result = await client.query<StorageRow>(`SELECT w.*,b.space_id,b.root_relative_path,s.root_key,s.root_state
        FROM pe_workspaces w LEFT JOIN pe_workspace_bindings b ON b.workspace_id=w.id AND b.user_id=w.user_id
        LEFT JOIN pe_storage_spaces s ON s.id=b.space_id AND s.user_id=w.user_id
        WHERE w.id=$1 AND w.user_id=$2 FOR UPDATE OF w`, [workspaceId, userId])
      if (!result.rows[0]) throw new PlatformError(404, 'workspace_not_found')
      return result.rows[0]
    }
    let row = await read()
    if (row.binding_state === 'provisioning') {
      if (row.space_id === null) {
        await client.query(`INSERT INTO pe_storage_spaces(id,user_id,root_key,title,is_default,root_state)
          VALUES($1,$2,$1,$3,false,'provisioning')`, [workspaceId, userId, row.title])
        await client.query("INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path) VALUES($1,$2,$1,'')", [workspaceId, userId])
        row = await read()
      }
      if (row.root_state === 'provisioning') {
        assert(row.root_key !== null)
        await this.safe.ensureWorkspace(row.root_key)
        await client.query("UPDATE pe_storage_spaces SET root_state='ready',updated_at=clock_timestamp() WHERE id=$1", [row.space_id])
      }
      await client.query("UPDATE pe_workspaces SET binding_state='ready',binding_updated_at=clock_timestamp() WHERE id=$1", [workspaceId])
      row = await read()
    }
    if (row.binding_state !== 'ready' || row.root_state !== 'ready') throw new PlatformError(503, 'workspace_unavailable')
    const result = storageBinding.parse({ workspaceId: row.id, spaceId: row.space_id, rootKey: row.root_key,
      rootRelativePath: row.root_relative_path, generation: Number(row.binding_generation) })
    if (!await this.safe.probeDirectory(result)) throw new PlatformError(503, 'workspace_unavailable')
    return result
  }
}
