/** Tenant-scoped persistent cloud Workspaces for the native browser. */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { PlatformError, type Identity, type RequestId } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireActiveAccount } from './account-authority.ts'
import type { FileService } from './files.ts'
import type { NativeSessionRead } from './native-session-read.ts'

interface WorkspaceRow {
  id: string; title: string; is_default: boolean; created_at: Date
}

function view(row: WorkspaceRow): { workspaceId: string; title: string; isDefault: boolean; createdAt: string } {
  return { workspaceId: row.id, title: row.title, isDefault: row.is_default,
    createdAt: row.created_at.toISOString() }
}

export class NativeWorkspaceRead {
  constructor(private readonly pool: Pool, private readonly files: FileService,
    private readonly sessions: NativeSessionRead, private readonly maxPerUser: number) {}

  /** List metadata without disclosing physical storage paths. */
  async list(user: Identity): Promise<{ items: ReturnType<typeof view>[] }> {
    await this.files.workspaceForUser(user.userId)
    const result = await this.pool.query<WorkspaceRow>(
      'SELECT id,title,is_default,created_at FROM pe_workspaces WHERE user_id=$1 ORDER BY is_default DESC,created_at,id',
      [user.userId])
    return { items: result.rows.map(view) }
  }

  /** Deduplicate creation within one user before enforcing the deployment limit. */
  async create(user: Identity, requestId: RequestId, title: string): Promise<ReturnType<typeof view>> {
    await this.files.workspaceForUser(user.userId)
    const created = await transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const prior = await client.query<WorkspaceRow>(
        'SELECT id,title,is_default,created_at FROM pe_workspaces WHERE user_id=$1 AND create_request_id=$2',
        [user.userId, requestId])
      if (prior.rows[0]) {
        if (prior.rows[0].title !== title) throw new PlatformError(409, 'request_id_conflict')
        return prior.rows[0]
      }
      const count = await client.query<{ count: string }>(
        'SELECT count(*) FROM pe_workspaces WHERE user_id=$1', [user.userId])
      if (Number(count.rows[0]!.count) >= this.maxPerUser) throw new PlatformError(429, 'workspace_limit')
      const result = await client.query<WorkspaceRow>(
        `INSERT INTO pe_workspaces(id,user_id,title,is_default,create_request_id)
         VALUES($1,$2,$3,false,$4) RETURNING id,title,is_default,created_at`,
        [randomUUID(), user.userId, title, requestId])
      return result.rows[0]!
    })
    await this.files.workspaceForId(user.userId, created.id)
    return view(created)
  }

  /** Project each owned Session into its immutable Workspace association. */
  async baseline(user: Identity): Promise<unknown> {
    const [{ items: workspaces }, { items: sessions }] = await Promise.all([this.list(user), this.sessions.list(user)])
    const membership = await this.pool.query<{ id: string; workspace_id: string }>(
      'SELECT id,workspace_id FROM pe_sessions WHERE user_id=$1', [user.userId])
    const bySession = new Map(membership.rows.map(row => [row.id, row.workspace_id]))
    return { items: workspaces.map(workspace => {
      const members = sessions.filter(session => bySession.get(session.sessionId) === workspace.workspaceId)
      return { workspaceId: workspace.workspaceId, path: '/workspace', title: workspace.title,
        sessionIds: members.map(session => session.sessionId), createdAt: workspace.createdAt,
        updatedAt: new Date(Math.max(Date.parse(workspace.createdAt), ...members.map(session => session.updatedAt))).toISOString() }
    }), archivedSessionIds: [], pinnedSessionIds: [] }
  }
}
