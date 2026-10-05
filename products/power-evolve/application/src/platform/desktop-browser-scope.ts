/** Current browser account and exact Session membership in one authorization transaction. */
import type { Pool } from 'pg'
import { desktopBrowserScopeRequest, desktopBrowserScopeView,
  type DesktopBrowserScopeView } from '@power-evolve/contracts/desktop-browser-scope'
import { PlatformError } from '../contracts.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'

/** Reads logical membership without creating Workspaces or accessing their files. */
export class DesktopBrowserScopeService {
  constructor(private readonly pool: Pool) {}

  /**
   * Recheck the captured Agent bearer before and after reading the immutable Session binding.
   * Owner and credential locks serialize logout and account changes; expiry uses the current PG clock.
   * @param token Captured Agent credential; a previously authenticated Identity is insufficient.
   * @param input Untrusted request containing only the selected Session ID.
   * @returns Current owner, Session and Workspace IDs after the transaction commits.
   */
  async read(token: string, input: unknown): Promise<DesktopBrowserScopeView> {
    const request = desktopBrowserScopeRequest.parse(input)
    return transaction(this.pool, async client => {
      const owner = await requireBrowserAccount(client, token, { audience: 'agent', lock: 'update' })
      const membership = await client.query<{ userId: string; sessionId: string; workspaceId: string }>(
        `SELECT s.user_id AS "userId",s.id AS "sessionId",w.id AS "workspaceId"
         FROM pe_sessions s JOIN pe_workspaces w ON w.id=s.workspace_id AND w.user_id=s.user_id
         WHERE s.id=$1 AND s.user_id=$2 AND w.user_id=$2`, [request.sessionId, owner.userId])
      if (!membership.rows[0]) throw new PlatformError(404, 'session_not_found')
      await requireBrowserAccount(client, token, { audience: 'agent', lock: 'update' })
      return desktopBrowserScopeView.parse(membership.rows[0])
    })
  }
}
