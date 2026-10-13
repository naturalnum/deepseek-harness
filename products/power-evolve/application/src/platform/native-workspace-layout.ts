/** Durable native grouping and cloud directory names; filesystem roots remain server-owned. */
import { posix } from 'node:path'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, sessionId, workspaceId } from '../contracts.ts'
import { cloudDirectory, cloudHome } from '../native-workspace-contracts.ts'
import { readSessionStopInTransaction } from './native-session-stop.ts'

const layout = z.object({
  version: z.literal(1), directories: z.array(cloudDirectory), paths: z.record(z.uuid(), cloudDirectory),
  removedWorkspaceIds: z.array(workspaceId), workspaceOrder: z.array(workspaceId),
  sessionOrder: z.record(z.uuid(), z.array(sessionId)),
  archivedSessionIds: z.array(sessionId), pinnedSessionIds: z.array(sessionId),
}).strict()
/** Validated private layout, unavailable through the presentation Settings API. */
export type NativeWorkspaceLayout = z.infer<typeof layout>
/** Workspace metadata used to initialize names for pre-existing cloud records. */
export interface LayoutWorkspace { id: string; title: string; is_default: boolean }

/** Read or derive an owned cloud directory tree without provisioning bytes.
 * @param client Transaction holding the account lock.
 * @param userId Authenticated account identity.
 * @param workspaces Owned Workspace rows.
 * @returns Validated private grouping state; missing historical names are derived deterministically.
 */
export async function readWorkspaceLayout(client: PoolClient, userId: string,
  workspaces: readonly LayoutWorkspace[]): Promise<NativeWorkspaceLayout> {
  const stored = await client.query<{ value: unknown }>(
    "SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace='workspace-layout'", [userId])
  const parsed = layout.safeParse(stored.rows[0]?.value ?? { version: 1, directories: [cloudHome], paths: {},
    removedWorkspaceIds: [], workspaceOrder: [], sessionOrder: {}, archivedSessionIds: [], pinnedSessionIds: [] })
  if (!parsed.success) throw new PlatformError(503, 'native_workspace_layout_invalid')
  const state = parsed.data
  const used = new Set(Object.values(state.paths))
  for (const workspace of workspaces) {
    if (state.paths[workspace.id] !== undefined) continue
    const candidate = workspace.is_default ? cloudHome : `${cloudHome}/${workspace.title}`
    const path = cloudDirectory.safeParse(candidate).success && !used.has(candidate)
      ? candidate : `${cloudHome}/${workspace.id}`
    state.paths[workspace.id] = path
    used.add(path)
    for (let directory = path; directory !== '/'; directory = posix.dirname(directory)) {
      if (!state.directories.includes(directory)) state.directories.push(directory)
    }
  }
  const owned = new Set(workspaces.map(workspace => workspace.id))
  const sessions = await client.query<{ id: string; workspace_id: string }>(
    'SELECT id,workspace_id FROM pe_sessions WHERE user_id=$1', [userId])
  const sessionWorkspaces = new Map(sessions.rows.map(row => [row.id, row.workspace_id]))
  const unique = (values: readonly string[]) => new Set(values).size === values.length
  const validSessions = (values: readonly string[]) => unique(values) && values.every(id => sessionWorkspaces.has(id))
  if (Object.keys(state.paths).some(id => !owned.has(id)) || used.size !== Object.keys(state.paths).length
    || state.removedWorkspaceIds.some(id => !owned.has(id)) || state.workspaceOrder.some(id => !owned.has(id))
    || !unique(state.removedWorkspaceIds) || !unique(state.workspaceOrder) || !unique(state.directories)
    || !state.directories.includes(cloudHome)
    || state.directories.some(path => path !== cloudHome && !state.directories.includes(posix.dirname(path)))
    || Object.values(state.paths).some(path => !state.directories.includes(path))
    || !validSessions(state.archivedSessionIds) || !validSessions(state.pinnedSessionIds)
    || state.pinnedSessionIds.some(id => state.archivedSessionIds.includes(id))
    || Object.entries(state.sessionOrder).some(([workspace, ids]) => !owned.has(workspace)
      || !unique(ids) || ids.some(id => sessionWorkspaces.get(id) !== workspace))) {
    throw new PlatformError(503, 'native_workspace_layout_invalid')
  }
  return state
}

/** Commit grouping state with a monotonic private preference revision.
 * @param client Transaction holding the account update lock.
 * @param userId Authenticated account identity.
 * @param state Validated cloud layout.
 * @returns Completion after the layout write; the enclosing transaction owns commit.
 */
export async function writeWorkspaceLayout(client: PoolClient, userId: string, state: NativeWorkspaceLayout): Promise<void> {
  const value = layout.parse(state)
  await client.query(`INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,'workspace-layout',$2,1)
    ON CONFLICT(user_id,namespace) DO UPDATE SET value=EXCLUDED.value,
    revision=pe_native_preferences.revision+1,updated_at=clock_timestamp()`, [userId, value])
}

/** Read authoritative archival while the caller holds the active account and owned Session locks.
 * This storage read does not revoke the separate authority needed to finish an interrupted turn.
 * @param client Caller transaction serialized with workspace grouping writes by the account lock.
 * @param userId Current authenticated Session owner.
 * @param sessionId Exact owned Session whose business admission is being checked.
 * @returns Whether the validated persisted workspace layout archives this Session.
 */
export async function isSessionArchivedInTransaction(client: PoolClient, userId: string, sessionId: string): Promise<boolean> {
  const workspaces = await client.query<LayoutWorkspace>('SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [userId])
  const state = await readWorkspaceLayout(client, userId, workspaces.rows)
  return state.archivedSessionIds.some(id => id === sessionId)
}

/** Keep an issued archival stop effective after the Session becomes visible again.
 * @param client Caller transaction holding the active account and owned Session locks.
 * @param userId Exact current Session owner.
 * @param id Exact owned Session whose business admission is being checked.
 * @returns Whether archival or an unfinished original archival stop blocks business execution.
 */
export async function isSessionBusinessBlockedInTransaction(client: PoolClient, userId: string, id: string): Promise<boolean> {
  if (await isSessionArchivedInTransaction(client, userId, id)) return true
  const stop = await readSessionStopInTransaction(client, userId, sessionId.parse(id))
  return stop?.status === 'requested'
}

/** Apply the native insert-before operation without duplicating entries.
 * @param order Current owned registry order.
 * @param item Item being moved.
 * @param before Optional anchor; omission moves to the end.
 * @returns A new order; a missing item or anchor rejects before a write.
 */
export function insertBefore<T extends string>(order: readonly T[], item: T, before?: T): T[] {
  if (!order.includes(item) || (before !== undefined && !order.includes(before))) throw new PlatformError(409, 'native_move_invalid')
  if (item === before) return [...order]
  const result = order.filter(value => value !== item)
  result.splice(before === undefined ? result.length : result.indexOf(before), 0, item)
  return result
}

/** Keep recorded items in manual order and append newly created items once.
 * @param recorded Persisted manual order.
 * @param current Current owned registry items.
 * @returns Complete current order without stale entries.
 */
export function completeOrder<T extends string>(recorded: readonly T[], current: readonly T[]): T[] {
  const available = new Set(current)
  return [...new Set([...recorded.filter(item => available.has(item)), ...current])]
}
