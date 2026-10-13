/** Browser credentials and unconsumed admission tickets; committed connector credentials and task grants are separate. */
import type { PoolClient } from 'pg'
import type { UserId } from '../contracts.ts'

/**
 * Revoke every browser audience and expire pending cloud admission tickets in the lifecycle transaction.
 * @param client The caller's transaction client, with the user row exclusively locked before ticket rows.
 * @param userId Identity whose password or enabled state changed.
 * @returns Completion after revocation is durable with the account mutation; consumed ticket history remains unchanged.
 */
export async function revokeAccountCredentials(client: PoolClient, userId: UserId): Promise<void> {
  await client.query('DELETE FROM pe_credentials WHERE user_id=$1', [userId])
  for (const table of ['pe_skill_upload_intents', 'pe_ssh_upload_intents', 'pe_mcp_credential_tickets']) {
    await client.query(`UPDATE ${table} SET expires_at=clock_timestamp()
      WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, [userId])
  }
}
