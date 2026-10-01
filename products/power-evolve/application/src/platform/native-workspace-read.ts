/** Tenant-scoped persistent cloud Workspaces for the native browser. */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { PlatformError, type Identity, type RequestId } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireActiveAccount } from './account-authority.ts'
import type { FileService } from './files.ts'
import type { NativeSessionRead } from './native-session-read.ts'
import { workspaceStorageTarget, type WorkspaceStorageTarget } from '@power-evolve/contracts/workspace-binding'

interface WorkspaceRow {
  id: string; title: string; is_default: boolean; created_at: Date; binding_updated_at: Date
  create_storage_target?: unknown
}

function view(row: WorkspaceRow): { workspaceId: string; title: string; isDefault: boolean; createdAt: string } {
  return { workspaceId: row.id, title: row.title, isDefault: row.is_default,
    createdAt: row.created_at.toISOString() }
}

/** Owned native Workspace catalogue independent of byte availability. */
export class NativeWorkspaceRead {
  constructor(private readonly pool: Pool, private readonly files: FileService,
    private readonly sessions: NativeSessionRead, private readonly maxPerUser: number) {}

  /**
   * List owned metadata without probing physical storage.
   * @param user Authenticated Workspace owner.
   * @returns Logical Workspace metadata without physical paths.
   */
  async list(user: Identity): Promise<{ items: ReturnType<typeof view>[] }> {
    await this.files.defaultWorkspaceId(user.userId)
    const result = await this.pool.query<WorkspaceRow>(
      'SELECT id,title,is_default,created_at,binding_updated_at FROM pe_workspaces WHERE user_id=$1 ORDER BY is_default DESC,created_at,id',
      [user.userId])
    return { items: result.rows.map(view) }
  }

  /**
   * Persist the original title and selected target before initializing bytes.
   * @param user Authenticated owner.
   * @param requestId Stable creation identity.
   * @param title Validated display title.
   * @param target Optional existing owned directory; omission creates a private directory.
   * @returns The same Workspace metadata on a matching retry.
   */
  async create(user: Identity, requestId: RequestId, title: string,
    target?: WorkspaceStorageTarget): Promise<ReturnType<typeof view>> {
    const selected = target === undefined ? null : workspaceStorageTarget.parse(target)
    await this.files.defaultWorkspaceId(user.userId)
    const created = await transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const prior = await client.query<WorkspaceRow>(
        'SELECT id,title,is_default,created_at,binding_updated_at,create_storage_target FROM pe_workspaces WHERE user_id=$1 AND create_request_id=$2',
        [user.userId, requestId])
      if (prior.rows[0]) {
        const original = prior.rows[0].create_storage_target === null ? null
          : workspaceStorageTarget.parse(prior.rows[0].create_storage_target)
        if (prior.rows[0].title !== title || (original === null) !== (selected === null)
          || original !== null && selected !== null && (original.spaceId !== selected.spaceId
            || original.rootRelativePath !== selected.rootRelativePath)) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        return prior.rows[0]
      }
      const count = await client.query<{ count: string }>(
        'SELECT count(*) FROM pe_workspaces WHERE user_id=$1', [user.userId])
      if (Number(count.rows[0]!.count) >= this.maxPerUser) throw new PlatformError(429, 'workspace_limit')
      const result = await client.query<WorkspaceRow>(
        `INSERT INTO pe_workspaces(id,user_id,title,is_default,create_request_id,create_storage_target)
         VALUES($1,$2,$3,false,$4,$5) RETURNING id,title,is_default,created_at,binding_updated_at`,
        [randomUUID(), user.userId, title, requestId, selected])
      await this.files.bindings.attachInitial(client, user, result.rows[0]!.id, target)
      return result.rows[0]!
    })
    await this.files.workspaceForId(user.userId, created.id)
    return view(created)
  }

  /**
   * Project immutable Session membership and binding changes into native updates.
   * @param user Authenticated owner.
   * @returns Native Workspace baseline; updatedAt includes binding transitions.
   */
  async baseline(user: Identity): Promise<unknown> {
    const [{ items: workspaces }, { items: sessions }] = await Promise.all([this.list(user), this.sessions.list(user)])
    const membership = await this.pool.query<{ id: string; workspace_id: string }>(
      'SELECT id,workspace_id FROM pe_sessions WHERE user_id=$1', [user.userId])
    const bySession = new Map(membership.rows.map(row => [row.id, row.workspace_id]))
    const changed = await this.pool.query<{ id: string; binding_updated_at: Date }>(
      'SELECT id,binding_updated_at FROM pe_workspaces WHERE user_id=$1', [user.userId])
    const bindingTimes = new Map(changed.rows.map(row => [row.id, row.binding_updated_at.getTime()]))
    return { items: workspaces.map(workspace => {
      const members = sessions.filter(session => bySession.get(session.sessionId) === workspace.workspaceId)
      return { workspaceId: workspace.workspaceId, path: '/workspace', title: workspace.title,
        sessionIds: members.map(session => session.sessionId), createdAt: workspace.createdAt,
        updatedAt: new Date(Math.max(Date.parse(workspace.createdAt), bindingTimes.get(workspace.workspaceId)!,
          ...members.map(session => session.updatedAt))).toISOString() }
    }), archivedSessionIds: [], pinnedSessionIds: [] }
  }
}
