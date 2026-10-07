/** Platform verification of Runner candidates and Session-scoped reads of persisted facts. */
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import {
  runnerFileChanges, verifiedExecutionFiles, executionFilesRequest, executionFilesItem, executionFilesView,
  type RunnerFileChanges, type VerifiedExecutionFiles, type ExecutionFilesRequest, type ExecutionFilesView,
} from '@power-evolve/contracts/execution-files'
import { PlatformError, type Identity, type UserId } from '../contracts.ts'
import { requireActiveAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import type { FileService } from './files.ts'

interface ExecutionRow { execution_kind: 'legacy_command'; id: string; call_id: string; state: string; result: unknown }
const persistedResult = z.object({ verifiedFiles: verifiedExecutionFiles.optional() }).passthrough()
const pendingStates = new Set(['queued', 'starting', 'running', 'cancelling'])

/** Verification never persists candidates; the execution owner commits verified versions with its result. */
export class ExecutionFileFactsService {
  constructor(private readonly pool: Pool, private readonly files: FileService) {}

  /**
   * Verify bounded candidate bytes in the Session's currently owned Workspace.
   * @param userId Execution owner from persisted platform authority.
   * @param sessionId Owned Session determining the Workspace.
   * @param observation Optional untrusted Runner file changes; absence identifies a legacy Runner.
   * @param signal Worker cancellation passed through to the descriptor helper.
   * @returns Verified versions and explicit completeness; failed candidates are discarded, while loss of authority or cancellation propagates.
   */
  async verify(userId: UserId, sessionId: string, observation: RunnerFileChanges | undefined,
    signal?: AbortSignal): Promise<VerifiedExecutionFiles> {
    const scope = await this.owned(userId, sessionId, signal)
    if (observation === undefined) return this.unavailable('legacy_runner')
    const parsed = runnerFileChanges.safeParse(observation)
    if (!parsed.success) throw new PlatformError(503, 'execution_file_facts_unavailable')
    const result: VerifiedExecutionFiles = { status: parsed.data.status, files: [], reasons: [...parsed.data.reasons] }
    for (const candidate of parsed.data.files) {
      await this.owned(userId, sessionId, signal, scope.workspaceId)
      let bytes: Buffer | undefined
      try { bytes = await this.files.readBytesInWorkspace(scope.user, scope.workspaceId, candidate.path, signal) }
      catch (error) {
        signal?.throwIfAborted()
        if (error instanceof PlatformError && (error.status === 401
          || error.code === 'workspace_not_found' || error.code === 'session_not_found')) throw error
        // The current filesystem could not establish this version; retain no candidate bytes or claims.
      }
      await this.owned(userId, sessionId, signal, scope.workspaceId)
      if (bytes !== undefined && bytes.length === candidate.sizeBytes
        && createHash('sha256').update(bytes).digest('hex') === candidate.sha256) {
        result.files.push(candidate)
      } else {
        result.status = 'partial'
        if (!result.reasons.includes('verification_failed')) result.reasons.push('verification_failed')
      }
    }
    signal?.throwIfAborted()
    return verifiedExecutionFiles.parse(result)
  }

  /**
   * Return stored file versions without inspecting the current filesystem.
   * @param user Authenticated requester whose current account and Session ownership are checked.
   * @param request One Session and a bounded unique ordered list of execution identities.
   * @returns Facts in request order; any foreign or missing execution fails the entire query with 404, and malformed persisted facts fail with 503.
   */
  async read(user: Identity, request: ExecutionFilesRequest): Promise<ExecutionFilesView> {
    const parsed = executionFilesRequest.safeParse(request)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId)
      const session = await client.query<{ workspace_id: string }>(`SELECT s.workspace_id FROM pe_sessions s
        JOIN pe_workspaces w ON w.id=s.workspace_id AND w.user_id=$2 WHERE s.id=$1 AND s.user_id=$2`,
      [parsed.data.sessionId, user.userId])
      if (!session.rows[0]) throw new PlatformError(404, 'session_not_found')
      const executions = await client.query<ExecutionRow>(`SELECT execution_kind,id,call_id,state,result FROM pe_cloud_executions
        WHERE execution_kind='legacy_command' AND user_id=$1 AND session_id=$2 AND id=ANY($3::uuid[])`,
      [user.userId, parsed.data.sessionId, parsed.data.executionIds])
      if (executions.rows.length !== parsed.data.executionIds.length) throw new PlatformError(404, 'execution_not_found')
      const rows = new Map(executions.rows.map(row => [row.id.toLowerCase(), row]))
      const items = parsed.data.executionIds.map(id => {
        const row = rows.get(id.toLowerCase())!
        let facts: VerifiedExecutionFiles | { status: 'pending'; files: []; reasons: [] }
        if (pendingStates.has(row.state)) facts = { status: 'pending', files: [], reasons: [] }
        else if (row.state === 'uncertain') facts = this.unavailable('execution_unavailable')
        else {
          const stored = persistedResult.safeParse(row.result ?? {})
          if (!stored.success) throw new PlatformError(503, 'execution_file_facts_unavailable')
          facts = stored.data.verifiedFiles ?? this.unavailable('legacy_runner')
        }
        const item = executionFilesItem.safeParse({ executionId: row.id, callId: row.call_id, state: row.state, ...facts })
        if (!item.success) throw new PlatformError(503, 'execution_file_facts_unavailable')
        return item.data
      })
      return executionFilesView.parse({ sessionId: parsed.data.sessionId, workspaceId: session.rows[0].workspace_id, items })
    })
  }

  private unavailable(reason: 'legacy_runner' | 'execution_unavailable'): VerifiedExecutionFiles {
    return { status: 'unavailable', files: [], reasons: [reason] }
  }

  private async owned(userId: UserId, sessionId: string, signal?: AbortSignal,
    expectedWorkspace?: string): Promise<{ user: Identity; workspaceId: string }> {
    signal?.throwIfAborted()
    const scope = await transaction(this.pool, async client => {
      const authority = await requireActiveAccount(client, userId)
      const result = await client.query<{ workspace_id: string }>(`SELECT s.workspace_id FROM pe_sessions s
        JOIN pe_workspaces w ON w.id=s.workspace_id AND w.user_id=$2 WHERE s.id=$1 AND s.user_id=$2`, [sessionId, userId])
      if (!result.rows[0] || expectedWorkspace !== undefined && result.rows[0].workspace_id !== expectedWorkspace) {
        throw new PlatformError(404, 'session_not_found')
      }
      return { user: { userId, username: authority.username }, workspaceId: result.rows[0].workspace_id }
    })
    signal?.throwIfAborted()
    return scope
  }
}
