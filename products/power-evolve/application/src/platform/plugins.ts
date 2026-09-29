/** User-scoped built-in Plugin choices; capability grants remain separate platform policy. */
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'

type PluginRow = { enabled: boolean; revision: number }
type MutationRow = { request_digest: string; result_enabled: boolean; result_revision: number }
export interface NotesPluginChoice { requestId: string; expectedRevision: number; enabled: boolean }

const item = (row: PluginRow) => ({
  id: 'notes' as const, title: '受控便签' as const, category: 'tools' as const,
  kind: 'builtin' as const, enabled: row.enabled, revision: row.revision,
  requiresApproval: true as const,
})

function choiceDigest(choice: NotesPluginChoice): string {
  return createHash('sha256').update(JSON.stringify({ pluginId: 'notes',
    expectedRevision: choice.expectedRevision, enabled: choice.enabled })).digest('hex')
}

export class PluginService {
  constructor(private readonly pool: Pool) {}

  /** Existing users retain the prior enabled behaviour; restart never re-enables a disabled row. */
  async seedUsers(usernames: string[]): Promise<void> {
    await this.pool.query(`INSERT INTO pe_user_plugins(user_id,plugin_id,enabled,revision)
      SELECT id,'notes',true,1 FROM pe_users WHERE username=ANY($1::text[])
      ON CONFLICT(user_id,plugin_id) DO NOTHING`, [usernames])
  }

  private async ensureUser(client: PoolClient, userId: string): Promise<PluginRow> {
    await client.query(`INSERT INTO pe_user_plugins(user_id,plugin_id,enabled,revision)
      SELECT id,'notes',true,1 FROM pe_users WHERE id=$1
      ON CONFLICT(user_id,plugin_id) DO NOTHING`, [userId])
    const result = await client.query<PluginRow>(
      `SELECT enabled,revision FROM pe_user_plugins WHERE user_id=$1 AND plugin_id='notes'`, [userId])
    if (!result.rows[0]) throw new PlatformError(401, 'unauthorized')
    return result.rows[0]
  }

  async list(user: Identity): Promise<{ items: ReturnType<typeof item>[] }> {
    const row = await transaction(this.pool, client => this.ensureUser(client, user.userId))
    return { items: [item(row)] }
  }

  /** The first successful mutation owns its request ID and preserves its original response. */
  async notesSetEnabled(user: Identity, choice: NotesPluginChoice): Promise<ReturnType<typeof item>> {
    const fingerprint = choiceDigest(choice)
    return transaction(this.pool, async client => {
      const locked = await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      if (!locked.rowCount) throw new PlatformError(401, 'unauthorized')
      await this.ensureUser(client, user.userId)
      const previous = await client.query<MutationRow>(
        'SELECT request_digest,result_enabled,result_revision FROM pe_plugin_mutations WHERE user_id=$1 AND request_id=$2',
        [user.userId, choice.requestId])
      if (previous.rows[0]) {
        if (previous.rows[0].request_digest !== fingerprint) throw new PlatformError(409, 'request_id_conflict')
        return item({ enabled: previous.rows[0].result_enabled, revision: previous.rows[0].result_revision })
      }
      const current = await client.query<PluginRow>(
        `SELECT enabled,revision FROM pe_user_plugins WHERE user_id=$1 AND plugin_id='notes' FOR UPDATE`, [user.userId])
      if (current.rows[0]?.revision !== choice.expectedRevision) {
        throw new PlatformError(409, 'plugin_revision_conflict')
      }
      const updated = await client.query<PluginRow>(
        `UPDATE pe_user_plugins SET enabled=$2,revision=revision+1,updated_at=now()
         WHERE user_id=$1 AND plugin_id='notes' RETURNING enabled,revision`, [user.userId, choice.enabled])
      const row = updated.rows[0]!
      await client.query(
        `INSERT INTO pe_plugin_mutations(user_id,plugin_id,request_id,request_digest,result_enabled,result_revision)
         VALUES($1,'notes',$2,$3,$4,$5)`, [user.userId, choice.requestId, fingerprint, row.enabled, row.revision])
      return item(row)
    })
  }
}
