/** Tenant-scoped persistent cloud Workspaces for the native browser. */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PlatformError, sessionId, workspaceId, type Identity, type RequestId, type WorkspaceId } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireActiveAccount, requireBrowserAccount } from './account-authority.ts'
import type { FileService } from './files.ts'
import { completeOrder, insertBefore,
  readWorkspaceLayout, writeWorkspaceLayout, type NativeWorkspaceLayout } from './native-workspace-layout.ts'
import { cloudDirectory, cloudDirectoryName, cloudHome } from '../native-workspace-contracts.ts'
import type { TaskStore } from './tasks.ts'
import { requestSessionActivityStopInTransaction } from './native-session-activity-stop.ts'
import { completeSessionStopInTransaction } from './native-session-stop-completion.ts'
import type { NativeTurnHistoryLimits } from './native-turn-history.ts'

interface WorkspaceRow {
  id: string
  title: string
  is_default: boolean
  created_at: Date
  binding_updated_at: Date
}

function view(row: WorkspaceRow): { workspaceId: string; title: string; isDefault: boolean; createdAt: string } {
  return { workspaceId: row.id, title: row.title, isDefault: row.is_default,
    createdAt: row.created_at.toISOString() }
}

interface MemberRow { id: string; workspace_id: string; updated_at: Date; active: boolean }
interface WorkspaceView {
  workspaceId: WorkspaceId
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}
interface WorkspaceBaseline { items: WorkspaceView[]; archivedSessionIds: SessionId[]; pinnedSessionIds: SessionId[] }

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new PlatformError(503, 'native_workspace_state_invalid')
  return value
}

function requireWorkspace(rows: readonly WorkspaceRow[], state: NativeWorkspaceLayout, id: WorkspaceId): WorkspaceRow {
  const row = rows.find(candidate => candidate.id === id && !state.removedWorkspaceIds.includes(id))
  if (!row) throw new PlatformError(404, 'workspace_not_found')
  return row
}

async function members(client: PoolClient, user: Identity): Promise<MemberRow[]> {
  const result = await client.query<MemberRow>(`SELECT s.id,s.workspace_id,s.updated_at,
    (COALESCE(s.lease_until>clock_timestamp(),false) OR EXISTS(SELECT 1 FROM pe_operations o
      WHERE o.session_id=s.id AND o.state IN ('queued','running')) OR EXISTS(SELECT 1 FROM pe_cloud_executions e
      WHERE e.session_id=s.id AND e.state IN ('queued','starting','running','cancelling','uncertain'))) AS active
    FROM pe_sessions s WHERE s.user_id=$1 ORDER BY s.created_at DESC,s.id`, [user.userId])
  return result.rows
}

function project(rows: readonly WorkspaceRow[], state: NativeWorkspaceLayout, sessions: readonly MemberRow[]): WorkspaceBaseline {
  const activeRows = rows.filter(row => !state.removedWorkspaceIds.includes(workspaceId.parse(row.id)))
  const ordered = completeOrder(state.workspaceOrder, activeRows.map(row => workspaceId.parse(row.id)))
  return { items: ordered.map((id) => {
    const row = required(activeRows.find(candidate => candidate.id === id))
    const owned = sessions.filter(session => session.workspace_id === id)
    const current = owned.map(item => sessionId.parse(item.id)), recorded = state.sessionOrder[id] ?? []
    return { workspaceId: id, path: required(state.paths[id]), title: row.title,
      sessionIds: [...current.filter(item => !recorded.includes(item)), ...recorded.filter(item => current.includes(item))],
      createdAt: row.created_at.toISOString(),
      updatedAt: new Date(Math.max(row.binding_updated_at.getTime(), row.created_at.getTime(),
        ...owned.map(item => item.updated_at.getTime()))).toISOString() }
  }), archivedSessionIds: state.archivedSessionIds, pinnedSessionIds: state.pinnedSessionIds }
}

/** Owned native Workspace catalogue independent of byte availability. */
export class NativeWorkspaceRead {
  constructor(private readonly pool: Pool, private readonly files: FileService,
    private readonly maxPerUser: number, private readonly maxDirectories: number) {}

  private async withState<T>(user: Identity, token: string | undefined,
    run: (client: PoolClient, rows: WorkspaceRow[], state: NativeWorkspaceLayout) => Promise<T> | T): Promise<T> {
    return transaction(this.pool, async (client) => {
      if (token === undefined) await requireActiveAccount(client, user.userId, 'share')
      else {
        const actor = await requireBrowserAccount(client, token, { lock: 'update' })
        if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      }
      await client.query(`INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,'Workspace',true)
        ON CONFLICT(user_id) WHERE is_default DO NOTHING`, [randomUUID(), user.userId])
      const result = await client.query<WorkspaceRow>(
        'SELECT id,title,is_default,created_at,binding_updated_at FROM pe_workspaces WHERE user_id=$1 ORDER BY is_default DESC,created_at,id', [user.userId])
      const state = await readWorkspaceLayout(client, user.userId, result.rows)
      return run(client, result.rows, state)
    })
  }

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
   * Persist the original title and creation identity before provisioning private storage.
   * @param user Authenticated owner.
   * @param requestId Stable creation identity.
   * @param title Validated display title.
   * @returns The same Workspace metadata on a matching retry.
   */
  async create(user: Identity, requestId: RequestId, title: string, token: string): Promise<ReturnType<typeof view>> {
    const created = await transaction(this.pool, async (client) => {
      const actor = await requireBrowserAccount(client, token, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      await client.query(`INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,'Workspace',true)
        ON CONFLICT(user_id) WHERE is_default DO NOTHING`, [randomUUID(), user.userId])
      const prior = await client.query<WorkspaceRow>(
        'SELECT id,title,is_default,created_at,binding_updated_at FROM pe_workspaces WHERE user_id=$1 AND create_request_id=$2',
        [user.userId, requestId])
      if (prior.rows[0]) {
        if (prior.rows[0].title !== title) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        return prior.rows[0]
      }
      const count = await client.query<{ count: string }>(
        'SELECT count(*) FROM pe_workspaces WHERE user_id=$1', [user.userId])
      if (Number(required(count.rows[0]).count) >= this.maxPerUser) throw new PlatformError(429, 'workspace_limit')
      const result = await client.query<WorkspaceRow>(
        `INSERT INTO pe_workspaces(id,user_id,title,is_default,create_request_id)
         VALUES($1,$2,$3,false,$4) RETURNING id,title,is_default,created_at,binding_updated_at`,
        [randomUUID(), user.userId, title, requestId])
      return required(result.rows[0])
    })
    await this.files.workspaceForId(user.userId, created.id)
    return view(created)
  }

  /**
   * Project immutable Session membership and binding changes into native updates.
   * @param user Authenticated owner.
   * @returns Native Workspace baseline; updatedAt includes binding transitions.
   */
  async baseline(user: Identity): Promise<WorkspaceBaseline> {
    return this.withState(user, undefined, async (client, rows, state) => project(rows, state, await members(client, user)))
  }

  /** List the caller's cloud directory names using the native browse DTO.
   * @param user Authenticated owner.
   * @param path Canonical cloud directory; omission selects home.
   * @returns Direct children and server-computed breadcrumbs, without physical paths.
   */
  async directories(user: Identity, path: string = cloudHome): Promise<unknown> {
    return this.withState(user, undefined, (_client, _rows, state) => {
      if (path !== '/' && !state.directories.includes(cloudDirectory.parse(path))) throw new PlatformError(404, 'directory_unreadable', { path })
      const crumbPaths = ['/']
      if (path !== '/') {
        let current = ''
        for (const segment of path.slice(1).split('/')) { current += `/${segment}`; crumbPaths.push(current) }
      }
      return { path, home: cloudHome, crumbs: crumbPaths.map(directory => ({ name: posix.basename(directory) || '/', path: directory, hidden: false })),
        entries: state.directories.filter(directory => directory !== path && posix.dirname(directory) === path)
          .sort().map(directory => ({ name: posix.basename(directory), path: directory, hidden: posix.basename(directory).startsWith('.') })),
        truncated: false }
    })
  }

  /** Create one cloud directory under a current owned parent.
   * @param user Authenticated owner.
   * @param token Current browser credential rechecked under the account lock.
   * @param path Existing cloud parent.
   * @param name Single normalized child segment.
   * @returns The canonical created path; duplicate or over-capacity creation rejects.
   */
  async createDirectory(user: Identity, token: string, path: string, name: string): Promise<string> {
    const parent = cloudDirectory.parse(path), child = cloudDirectory.parse(`${parent}/${cloudDirectoryName.parse(name)}`)
    return this.withState(user, token, async (client, _rows, state) => {
      if (!state.directories.includes(parent)) throw new PlatformError(404, 'directory_unreadable', { path: parent })
      if (state.directories.includes(child)) throw new PlatformError(409, 'directory_exists', { path: child })
      if (state.directories.length >= this.maxDirectories) throw new PlatformError(429, 'directory_limit')
      state.directories.push(child)
      await writeWorkspaceLayout(client, user.userId, state)
      return child
    })
  }

  /** Adopt an existing cloud directory without accepting a physical filesystem path.
   * @param user Authenticated owner.
   * @param token Current browser credential.
   * @param path Existing cloud directory.
   * @param requestId Native creation request identity.
   * @returns Current native Workspace and whether registration was newly created.
   */
  async adopt(user: Identity, token: string, path: string, requestId: RequestId): Promise<{ workspace: WorkspaceView; created: boolean }> {
    cloudDirectory.parse(path)
    const result = await this.withState(user, token, async (client, rows, state) => {
      if (!state.directories.includes(path)) throw new PlatformError(404, 'directory_unreadable', { path })
      const prior = rows.find(row => state.paths[row.id] === path)
      if (prior) {
        const id = workspaceId.parse(prior.id), removed = state.removedWorkspaceIds.includes(id)
        if (removed) {
          state.removedWorkspaceIds = state.removedWorkspaceIds.filter(value => value !== id)
          await writeWorkspaceLayout(client, user.userId, state)
        }
        return { id, created: removed }
      }
      if (rows.length >= this.maxPerUser) throw new PlatformError(429, 'workspace_limit')
      const conflicting = rows.find(row => row.title === posix.basename(path)
        && !state.removedWorkspaceIds.includes(workspaceId.parse(row.id)))
      if (conflicting) throw new PlatformError(409, 'workspace_name_conflict', { name: posix.basename(path) })
      const id = workspaceId.parse(randomUUID())
      const added = await client.query<WorkspaceRow>(`INSERT INTO pe_workspaces(id,user_id,title,is_default,create_request_id)
        VALUES($1,$2,$3,false,$4) RETURNING id,title,is_default,created_at,binding_updated_at`, [id, user.userId, posix.basename(path), requestId])
      rows.push(required(added.rows[0]))
      state.paths[id] = path
      state.workspaceOrder = completeOrder(state.workspaceOrder, rows.filter(row =>
        !state.removedWorkspaceIds.includes(workspaceId.parse(row.id))).map(row => workspaceId.parse(row.id)))
      await writeWorkspaceLayout(client, user.userId, state)
      return { id, created: true }
    })
    await this.files.workspaceForId(user.userId, result.id)
    const baseline = await this.baseline(user)
    const workspace = baseline.items.find(item => item.workspaceId === result.id)
    if (!workspace) throw new PlatformError(409, 'workspace_not_found')
    return { workspace, created: result.created }
  }

  /** Change a native Workspace title while preserving its directory and Session ownership.
   * @param user Authenticated owner.
   * @param token Current browser credential.
   * @param id Registered Workspace identity.
   * @param title Validated title.
   * @returns Updated native Workspace; duplicate titles refuse without changing paths.
   */
  async rename(user: Identity, token: string, id: WorkspaceId, title: string): Promise<{ workspace: WorkspaceView }> {
    return this.withState(user, token, async (client, rows, state) => {
      const row = requireWorkspace(rows, state, id)
      if (rows.some(other => other.id !== id && other.title === title
        && !state.removedWorkspaceIds.includes(workspaceId.parse(other.id)))) {
        throw new PlatformError(409, 'workspace_name_conflict', { name: title })
      }
      const changed = await client.query<WorkspaceRow>('UPDATE pe_workspaces SET title=$2,binding_updated_at=clock_timestamp() WHERE id=$1 RETURNING id,title,is_default,created_at,binding_updated_at', [id, title])
      Object.assign(row, required(changed.rows[0]))
      await writeWorkspaceLayout(client, user.userId, state)
      return { workspace: required(project(rows, state, await members(client, user)).items.find(item => item.workspaceId === id)) }
    })
  }

  /** Remove only a native registration; files and immutable Session membership survive.
   * @param user Authenticated owner.
   * @param token Current browser credential.
   * @param id Registered Workspace identity.
   * @returns Durable registration removal receipt.
   */
  async remove(user: Identity, token: string, id: WorkspaceId): Promise<{ deleted: true }> {
    return this.withState(user, token, async (client, rows, state) => {
      requireWorkspace(rows, state, id)
      state.removedWorkspaceIds.push(id)
      state.workspaceOrder = state.workspaceOrder.filter(value => value !== id)
      await writeWorkspaceLayout(client, user.userId, state)
      return { deleted: true }
    })
  }

  /** Reorder registered Workspaces with native insert-before semantics.
   * @param user Authenticated owner.
   * @param token Current browser credential.
   * @param id Registered Workspace identity.
   * @param before Optional registered anchor.
   * @returns Complete durable registry order.
   */
  async order(user: Identity, token: string, id: WorkspaceId, before?: WorkspaceId): Promise<{ workspaceIds: WorkspaceId[] }> {
    return this.withState(user, token, async (client, rows, state) => {
      requireWorkspace(rows, state, id)
      if (before !== undefined) requireWorkspace(rows, state, before)
      const current = project(rows, state, await members(client, user)).items.map(item => item.workspaceId)
      state.workspaceOrder = insertBefore(current, id, before)
      await writeWorkspaceLayout(client, user.userId, state)
      return { workspaceIds: state.workspaceOrder }
    })
  }

  /** Reorder only Sessions permanently bound to the selected Workspace.
   * @param user Authenticated owner.
   * @param token Current browser credential.
   * @param id Registered Workspace identity.
   * @param session Owned member to move.
   * @param before Optional owned member anchor.
   * @returns Updated native Workspace membership order.
   */
  async orderSession(user: Identity, token: string, id: WorkspaceId,
    session: SessionId, before?: SessionId): Promise<{ workspace: WorkspaceView }> {
    return this.withState(user, token, async (client, rows, state) => {
      requireWorkspace(rows, state, id)
      const owned = await members(client, user)
      const current = required(project(rows, state, owned).items.find(item => item.workspaceId === id))
      if (!current.sessionIds.includes(session) || (before !== undefined && !current.sessionIds.includes(before))) {
        throw new PlatformError(409, 'native_move_invalid', { workspaceId: id, sessionId: session,
          ...(before === undefined ? {} : { beforeSessionId: before }) })
      }
      state.sessionOrder[id] = insertBefore(current.sessionIds, session, before)
      await writeWorkspaceLayout(client, user.userId, state)
      return { workspace: required(project(rows, state, owned).items.find(item => item.workspaceId === id)) }
    })
  }

  /** Archive first and persist stops for the exact Session's existing operation roots and execution carriers.
   * @param user Owner authenticated by the route.
   * @param token Current browser credential rechecked under the account update lock.
   * @param session Exact owned Session; restoring visibility does not withdraw its issued stop.
   * @param tasks Platform task authority issuing the retained archival purpose in this same transaction.
   * @param history Explicit deployment bounds for proving an idle native Session's actual canonical state.
   * @returns Archived membership after durable requests; native cleanup and physical workers finish independently.
   */
  async archiveAndStop(user: Identity, token: string, session: SessionId,
    tasks: TaskStore, history: NativeTurnHistoryLimits): Promise<{ archivedSessionIds: SessionId[] }> {
    return this.withState(user, token, async (client, _rows, state) => {
      const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [session, user.userId])
      if (owned.rowCount !== 1) throw new PlatformError(404, 'session_not_found')
      if (!state.archivedSessionIds.includes(session)) state.archivedSessionIds.push(session)
      state.pinnedSessionIds = state.pinnedSessionIds.filter(id => id !== session)
      await writeWorkspaceLayout(client, user.userId, state)
      const stop = await tasks.requestArchiveStopInTransaction(client, user, session)
      await requestSessionActivityStopInTransaction(client, user, session)
      await completeSessionStopInTransaction(client, user.userId, session, stop.stopId, history)
      return { archivedSessionIds: state.archivedSessionIds }
    })
  }

  /** Persist native archive or pin membership for one owned Session.
   * @param user Authenticated owner.
   * @param token Current browser credential.
   * @param session Owned Session identity.
   * @param action Native archive, restore, pin or unpin operation.
   * @returns Complete corresponding native set; active archival and archived pinning refuse.
   */
  async groupSession(user: Identity, token: string, session: SessionId,
    action: 'archive' | 'unarchive' | 'pin' | 'unpin'): Promise<{ archivedSessionIds: SessionId[] } | { pinnedSessionIds: SessionId[] }> {
    return this.withState(user, token, async (client, _rows, state) => {
      const owned = await members(client, user), member = owned.find(item => item.id === session)
      if (!member) throw new PlatformError(404, 'session_not_found')
      if (action === 'archive' && member.active) throw new PlatformError(409, 'native_session_active', { sessionId: session, activity: [{ kind: 'turn' }] })
      if (action === 'pin' && state.archivedSessionIds.includes(session)) throw new PlatformError(409, 'native_session_archived')
      if (action === 'archive' || action === 'unarchive') {
        state.archivedSessionIds = state.archivedSessionIds.filter(id => id !== session)
        if (action === 'archive') {
          state.archivedSessionIds.push(session)
          state.pinnedSessionIds = state.pinnedSessionIds.filter(id => id !== session)
        }
      } else {
        state.pinnedSessionIds = state.pinnedSessionIds.filter(id => id !== session)
        if (action === 'pin') state.pinnedSessionIds.unshift(session)
      }
      await writeWorkspaceLayout(client, user.userId, state)
      return action === 'archive' || action === 'unarchive'
        ? { archivedSessionIds: state.archivedSessionIds } : { pinnedSessionIds: state.pinnedSessionIds }
    })
  }
}
