/** Explicit first-administrator initialization; persisted accounts and seeds remain authoritative. */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { ACCOUNT_ERROR_CODES } from '../account-contracts.ts'
import { PlatformError } from '../contracts.ts'
import { lockAccountAdministration, lockAccountAuthorities } from './account-authority.ts'
import type { AccountBootstrapConfig, AccountManagementConfig } from './account-config.ts'
import { transaction } from './database.ts'
import { hashPassword } from './identity.ts'

/**
 * Create or explicitly promote exactly one configured identity under the account administration lock.
 * @param pool Platform-owned PostgreSQL pool.
 * @param config Private explicit bootstrap settings, or null to leave all roles unchanged.
 * @param management Deployment-owned initial settings and available model catalog for an empty database.
 * @returns Resolves after the one-shot record commits; replay never restores password, grants, role or enablement.
 */
export async function bootstrapAccount(pool: Pool, config: AccountBootstrapConfig | null,
  management: AccountManagementConfig): Promise<void> {
  if (!config) return
  await transaction(pool, async client => {
    await lockAccountAdministration(client)
    const recorded = await client.query<{ user_id: string; username: string }>(
      'SELECT user_id,username FROM pe_account_bootstrap WHERE singleton=true')
    if (recorded.rows[0]) {
      if (recorded.rows[0].user_id !== config.userId.toLowerCase() || recorded.rows[0].username !== config.username) {
        throw new PlatformError(409, ACCOUNT_ERROR_CODES.bootstrapConflict)
      }
      return
    }
    if (config.mode === 'create') {
      if ((await client.query('SELECT 1 FROM pe_users LIMIT 1')).rowCount) {
        throw new PlatformError(409, ACCOUNT_ERROR_CODES.bootstrapConflict)
      }
      await client.query(`INSERT INTO pe_users(id,username,display_name,role,password_hash,settings)
        VALUES($1,$2,$3,'ADMIN',$4,$5)`, [config.userId, config.username, config.displayName,
        await hashPassword(config.password), { ...management.initialSettings, revision: 1 }])
      const initialModel = management.models.find(model => model.id === management.initialSettings.model)!
      await client.query(`INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled)
        VALUES($1,$2,$3,$4,true)`, [config.userId, initialModel.id, initialModel.label, management.initialSettings.maxTokens])
    } else {
      const users = await client.query('SELECT 1 FROM pe_users WHERE role=\'ADMIN\' AND enabled AND deleted_at IS NULL LIMIT 1')
      if (users.rowCount) throw new PlatformError(409, ACCOUNT_ERROR_CODES.bootstrapConflict)
      if (!(await client.query('SELECT 1 FROM pe_users WHERE id=$1', [config.userId])).rowCount) {
        throw new PlatformError(409, ACCOUNT_ERROR_CODES.bootstrapConflict)
      }
      const target = (await lockAccountAuthorities(client, [config.userId], 'update'))[0]!
      if (target.username !== config.username || !target.enabled || target.deletedAt) {
        throw new PlatformError(409, ACCOUNT_ERROR_CODES.bootstrapConflict)
      }
      await client.query(`UPDATE pe_users SET role='ADMIN',account_revision=account_revision+1,updated_at=clock_timestamp()
        WHERE id=$1`, [config.userId])
    }
    await client.query('INSERT INTO pe_account_bootstrap(singleton,user_id,username,mode) VALUES(true,$1,$2,$3)',
      [config.userId, config.username, config.mode])
    await client.query(`INSERT INTO pe_account_audit(id,actor_user_id,target_user_id,request_id,kind,metadata)
      VALUES($1,$2,$2,$3,'bootstrap',$4)`, [randomUUID(), config.userId, randomUUID(), { mode: config.mode }])
  })
}
