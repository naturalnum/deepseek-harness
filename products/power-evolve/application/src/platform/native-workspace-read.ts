/** Tenant-scoped projection of one persistent POSIX workspace for the native browser. */
import type { Pool } from 'pg'
import { PlatformError, type Identity } from '../contracts.ts'
import type { FileService } from './files.ts'
import type { NativeSessionRead } from './native-session-read.ts'

export class NativeWorkspaceRead {
  constructor(private readonly pool: Pool, private readonly files: FileService,
    private readonly sessions: NativeSessionRead) {}

  async baseline(user: Identity): Promise<unknown> {
    const owned = await this.files.workspaceForUser(user.userId)
    const result = await this.pool.query<{ created_at: Date }>(
      'SELECT created_at FROM pe_workspaces WHERE id=$1 AND user_id=$2', [owned.id, user.userId],
    )
    const createdAt = result.rows[0]?.created_at
    if (!createdAt) throw new PlatformError(503, 'workspace_unavailable')
    const { items } = await this.sessions.list(user)
    const updatedAt = new Date(Math.max(createdAt.getTime(), ...items.map(item => item.updatedAt))).toISOString()
    return { items: [{ workspaceId: owned.id, path: '/workspace', title: 'Workspace',
      sessionIds: items.map(item => item.sessionId), createdAt: createdAt.toISOString(), updatedAt }],
    archivedSessionIds: [], pinnedSessionIds: [] }
  }
}
