/** Durable acceptance, per-session leases, and operation attempts. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { SESSION_FORMAT_VERSION, type SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { executionTarget, grant, mcpSelection, stdioMcpSelection, sshSelection, skillSelection, PlatformError, settings,
  userId as executionUserId, operationId as executionOperationId, type OperationId, type ExecutionTarget,
  type Grant, type Identity, type RequestId, type WorkspaceId, type UserId } from '../contracts.ts'
import { z } from 'zod'
import { digest } from './identity.ts'
import { transaction } from './database.ts'
import { requireModelGrant } from './account-settings.ts'
import { continuationInput } from '../continuation-input.ts'
import { mcpOperationTools } from '../mcp-operation-contracts.ts'
import { selectMcpOperationTools, type McpOperationAdmissionLimits } from './mcp-admission.ts'
import { requireActiveAccount, requireBrowserAccount } from './account-authority.ts'
import type { StdioOperationAdmissionV2 } from './stdio-v2-operation-admission.ts'
import { isSessionBusinessBlockedInTransaction, readWorkspaceLayout } from './native-workspace-layout.ts'
import { admittedNativeContent, nativeFileAttachment, nativePromptContent } from '../native-attachment-contracts.ts'
import { NativeAttachments } from './native-attachments.ts'
import type { NativeAttachmentLimits } from './native-attachments.ts'
import { admitNativeImageContent, type NativeImageAdmissionConfig } from './native-image-admission.ts'
import { catalogModelInfo, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import { saveNativeImageBindings } from './native-images.ts'
import { readSessionStopInTransaction, requestSessionStopInTransaction } from './native-session-stop.ts'
import type { NativeSessionStopIntent } from '../native-session-stop-contracts.ts'
import type { NativeTurnHistoryLimits } from './native-turn-history.ts'
import { completeSessionStopInTransaction } from './native-session-stop-completion.ts'
import { readNativeToolNames } from './native-tool-catalog.ts'
import { assertNativeSubagentStorage, assertNativeSubagentExecution } from './native-subagent-authority.ts'
import { assertNativeInteractiveStorage, assertNativeInteractiveWorld } from './native-interactive-authority.ts'
import { assertNativeRuntimeGrant } from './native-runtime-authority.ts'

interface SessionRow {
  id: string
  user_id: string
  workspace_id: string
  header: SessionHeader
  event_count: number
  event_bytes: string
  lease_epoch: number
}

/** Limits are deployment inputs, applied atomically during acceptance and claiming. */
export interface TaskLimits {
  readonly maxEventBytes: number
  readonly leaseMs: number
  readonly nativeAssistantTtlMs?: number
  readonly maxPendingPerUser: number
  readonly maxActivePerUser: number
  readonly executionEnabled?: boolean
  readonly mcpEnabled?: boolean
  readonly remoteMcpAdmission?: McpOperationAdmissionLimits
  readonly stdioV2Admission?: { readonly selection: Pick<StdioOperationAdmissionV2,
    'select' | 'restore'>
  readonly reservedNames: readonly string[] }
  readonly stdioMcpEnabled?: boolean
  readonly sshEnabled?: boolean
  readonly archiveStopHistory?: NativeTurnHistoryLimits
  readonly nativeImageAdmission?: { readonly storage: NativeAttachmentLimits
    readonly sdk: NativeImageAdmissionConfig
    readonly maxLedgerBytes: number }
}

/** Current-generation execution check under the caller's existing account and Session locks.
 * A provider must verify durable native consumption and the operation/Writer clocks before returning.
 * @param client Caller transaction holding account and Session locks.
 * @param session Exact live operation returned by TaskStore.authorized.
 * @param token Current operation bearer whose native consumption must be checked.
 * @returns Completion only when the native execution provider authorizes the current step.
 */
export type TaskExecutionAuthority = (client: PoolClient,
  session: Awaited<ReturnType<TaskStore['authorized']>>, token: string) => Promise<void>

/** Select the original native pending owner after the account and Session have been locked.
 * @param client Caller transaction holding account and Session locks before a new attempt is issued.
 * @param sessionId Locked Session whose expired lease is eligible for claiming.
 * @param fallbackOperationId Oldest eligible operation when no native admission exists.
 * @returns Original operation identity only; no execution capability or historical bearer is issued.
 */
export type TaskClaimSelection = (client: PoolClient, sessionId: SessionId,
  fallbackOperationId: OperationId) => Promise<OperationId>

/** Platform-owned state machine. Host callers never choose a task's user identity. */
export class TaskStore {
  /**
   * @param pool Platform-owned database connection pool.
   * @param limits Deployment admission and lease bounds.
   * @param executionAuthority Explicit native execution provider; absence makes executionAuthorized unavailable.
   * @param claimSelection Bounded native pending-head provider evaluated under the existing account and Session locks.
   */
  constructor(readonly pool: Pool, private readonly limits: TaskLimits,
    private readonly executionAuthority?: TaskExecutionAuthority,
    private readonly claimSelection?: TaskClaimSelection) {}

  /** Create a durable empty native Session, deduplicated within one authenticated user.
   * @param user Owner authenticated by the route.
   * @param requestId Stable Session creation request identity.
   * @param credentialToken Original Agent bearer rechecked inside the acceptance transaction.
   * @param workspaceId Optional owned workspace to bind permanently.
   * @returns The new or previously accepted native Session identity.
   */
  async create(user: Identity, requestId: RequestId, credentialToken: string,
    workspaceId?: WorkspaceId, agentPreset?: string): Promise<{ sessionId: SessionId }> {
    const id = randomUUID()
    const header: SessionHeader = { id: brandString<SessionId>(id), version: SESSION_FORMAT_VERSION,
      createdAt: Date.now(), isSeeded: false, cwd: '/workspace', ...(agentPreset === undefined ? {} : { agentPreset }) }
    return transaction(this.pool, async (client) => {
      const actor = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      await client.query(
        `INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,'Workspace',true)
         ON CONFLICT(user_id) WHERE is_default DO NOTHING`, [randomUUID(), user.userId])
      const previous = await client.query<{ id: string; workspace_id: string }>(
        'SELECT id,workspace_id FROM pe_sessions WHERE user_id=$1 AND create_request_id=$2',
        [user.userId, requestId])
      if (previous.rows[0] && workspaceId !== undefined) {
        if (previous.rows[0].workspace_id !== workspaceId) throw new PlatformError(409, 'request_id_conflict')
        return { sessionId: brandString<SessionId>(previous.rows[0].id) }
      }
      const target = await client.query<{ id: string }>(
        `SELECT id FROM pe_workspaces WHERE id=COALESCE($2::uuid,
           (SELECT id FROM pe_workspaces WHERE user_id=$1 AND is_default)) AND user_id=$1`,
        [user.userId, workspaceId ?? null])
      const chosen = target.rows[0]?.id
      if (!chosen) throw new PlatformError(404, 'workspace_not_found')
      if (previous.rows[0]) {
        if (previous.rows[0].workspace_id !== chosen) throw new PlatformError(409, 'request_id_conflict')
        return { sessionId: brandString<SessionId>(previous.rows[0].id) }
      }
      const workspaces = await client.query<{ id: string; title: string; is_default: boolean }>(
        'SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [user.userId])
      const layout = await readWorkspaceLayout(client, user.userId, workspaces.rows)
      if (layout.removedWorkspaceIds.some(id => id === chosen)) throw new PlatformError(404, 'workspace_not_found')
      await client.query(
        `INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header)
         VALUES ($1,$2,$3,$4,$5)`, [id, user.userId, chosen, requestId, header])
      return { sessionId: brandString<SessionId>(id) }
    })
  }

  /** Return only the authenticated user's Session metadata and first-input titles.
   * @param user Owner authenticated by the route.
   * @param offset Validated number of catalog rows to skip.
   * @param limit Validated maximum number of rows to return.
   * @returns Owned Session rows with the requested pagination values; no execution grant is issued.
   */
  async list(user: Identity, offset: number, limit: number): Promise<unknown> {
    const result = await this.pool.query(
      `SELECT id AS "sessionId", workspace_id AS "workspaceId", created_at AS "createdAt", event_count AS "eventCount",
       (SELECT left(input,80) FROM pe_operations o WHERE o.session_id=s.id ORDER BY created_at,id LIMIT 1) AS title
       FROM pe_sessions s WHERE user_id=$1 ORDER BY created_at DESC,id OFFSET $2 LIMIT $3`,
      [user.userId, offset, limit],
    )
    return { items: result.rows, offset, limit }
  }

  /** Commit an input before returning acceptance; identical retries reuse the Operation.
   * @param user Owner authenticated by the route.
   * @param session Owned native Session identity.
   * @param requestId Stable input request identity.
   * @param text Exact user input to persist.
   * @param credentialToken Original Agent bearer rechecked before any resource lock.
   * @param target Fixed cloud placement.
   * @param content Ordered native browser content; omission preserves the exact text input.
   * @param signal Request disconnect and image intake deadline; checked again before durable acceptance.
   * @returns Durable acceptance and the original operation state on replay.
   */
  async accept(user: Identity, session: SessionId, requestId: RequestId, text: string,
    credentialToken: string, target: ExecutionTarget = { kind: 'cloud' },
    content?: z.infer<typeof nativePromptContent>, signal?: AbortSignal): Promise<unknown> {
    const submitted = content ?? [{ type: 'text' as const, text }]
    return transaction(this.pool, async (client) => {
      const actor = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const current = await client.query<{ settings: unknown }>(
        'SELECT settings FROM pe_users WHERE id=$1', [user.userId])
      if (!current.rows[0]) throw new PlatformError(401, 'unauthorized')
      const receiving = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [session, user.userId])
      if (!receiving.rowCount) throw new PlatformError(404, 'session_not_found')
      const prior = await client.query<{ id: string; input: string; state: string; execution_target: unknown }>(
        'SELECT id,input,state,execution_target FROM pe_operations WHERE session_id=$1 AND request_id=$2', [session, requestId],
      )
      const found = prior.rows[0]
      if (found) {
        executionTarget.parse(found.execution_target)
        if (found.input !== text) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        const saved = await client.query<{ submitted: unknown }>(
          'SELECT submitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [session, requestId])
        const original = saved.rows[0] ? nativePromptContent.parse(saved.rows[0].submitted)
          : [{ type: 'text' as const, text: found.input }]
        if (JSON.stringify(original) !== JSON.stringify(submitted)) throw new PlatformError(409, 'request_id_conflict')
        return { accepted: true, operationId: found.id, state: found.state }
      }
      const derived = await client.query(`SELECT 1 FROM pe_native_subagent_grants g
        JOIN pe_operations o ON o.id=g.operation_id WHERE o.session_id=$1 LIMIT 1`, [session])
      if (derived.rowCount) throw new PlatformError(403, 'native_subagent_input_forbidden')
      if (await isSessionBusinessBlockedInTransaction(client, user.userId, session)) {
        throw new PlatformError(409, 'native_session_archived')
      }
      if (submitted.filter(part => part.type === 'text').map(part => part.text).join('\n') !== text) {
        throw new PlatformError(400, 'native_input_mismatch')
      }
      const config = settings.parse(current.rows[0].settings)
      const modelIntent = await client.query<{ value: unknown }>(
        'SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
        [user.userId, `session-model:${session}`])
      if (modelIntent.rows[0]) {
        const selectedModel = z.object({ provider: z.literal('power-evolve'), model: z.string().min(1).max(100),
          reasoningEffort: z.literal('off').optional() }).strict()
          .parse(modelIntent.rows[0].value)
        const grant = await client.query<{ max_tokens: number }>(
          'SELECT max_tokens FROM pe_user_models WHERE user_id=$1 AND model_id=$2 AND enabled=true', [user.userId, selectedModel.model])
        if (!grant.rows[0]) throw new PlatformError(403, 'model_not_authorized')
        config.model = selectedModel.model
        config.maxTokens = Math.min(config.maxTokens, grant.rows[0].max_tokens)
      }
      await requireModelGrant(client, user.userId, config.model, config.maxTokens)
      const imageAdmission = this.limits.nativeImageAdmission
      if (submitted.some(part => part.type === 'image')) {
        if (!imageAdmission) throw new PlatformError(403, 'native_image_admission_unavailable')
        const model = resolveAdapterOptions({ thinking: 'disabled' }).models.find(item => item.id === config.model)
        if (model === undefined || !catalogModelInfo('power-evolve', model).inputModalities?.includes('image')) {
          throw new PlatformError(400, 'model_image_unsupported')
        }
      }
      const count = await client.query<{ count: string }>(
        `SELECT count(*) FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
         WHERE s.user_id=$1 AND o.state IN ('queued','running')`, [user.userId],
      )
      const pendingCount = count.rows[0]
      if (!pendingCount) throw new Error('Pending operation count is missing')
      if (Number(pendingCount.count) >= this.limits.maxPendingPerUser) throw new PlatformError(429, 'pending_limit')
      const selected = await client.query(
        `SELECT s.id AS "skillId",s.name,s.description,s.digest,s.revision,s.kind,
          v.version,v.archive_digest AS "packageDigest",v.manifest_digest AS "manifestDigest"
         FROM pe_user_skills s LEFT JOIN pe_skill_package_versions v ON v.id=s.package_version_id
         WHERE s.user_id=$1 AND s.enabled=true AND s.revoked_at IS NULL
           ORDER BY s.name,s.id`, [user.userId],
      )
      const selection = z.array(skillSelection).max(256).parse(selected.rows)
      const mcpRows = this.limits.mcpEnabled
        ? await client.query<{ connectionId: string; revision: number }>(
          'SELECT id AS "connectionId",revision FROM pe_mcp_connections WHERE user_id=$1 AND enabled=true', [user.userId])
        : { rows: [] }
      const mcp = z.array(mcpSelection).max(1).parse(mcpRows.rows)
      const remoteMcp = this.limits.remoteMcpAdmission
        ? await selectMcpOperationTools(client, user.userId, this.limits.remoteMcpAdmission) : []
      const stdioRows = this.limits.stdioMcpEnabled
        ? await client.query<{ connectionId: string; revision: number }>(
          'SELECT id AS "connectionId",revision FROM pe_stdio_mcp_connections WHERE user_id=$1 AND enabled=true',
          [user.userId]) : { rows: [] }
      const stdio = z.array(stdioMcpSelection).max(1).parse(stdioRows.rows)
      const sshRows = this.limits.sshEnabled
        ? await client.query<{ connectionId: string
          revision: number
          credentialRevision: number
          displayName: string
          host: string
          port: number
          username: string }>(
          `SELECT c.id AS "connectionId",v.revision,v.credential_revision AS "credentialRevision",
            v.display_name AS "displayName",v.host,v.port,v.username
           FROM pe_ssh_connections c JOIN pe_ssh_configuration_versions v
             ON v.connection_id=c.id AND v.user_id=c.user_id AND v.revision=c.revision
               AND v.credential_revision=c.credential_revision
           WHERE c.user_id=$1 AND c.enabled=true AND c.deleted_at IS NULL ORDER BY c.created_at,c.id`, [user.userId])
        : { rows: [] }
      const ssh = z.array(sshSelection).max(8).parse(sshRows.rows)
      const stdioV2 = this.limits.stdioV2Admission ? await this.limits.stdioV2Admission.selection.select(client,
        user.userId, session, target,
        [...this.limits.stdioV2Admission.reservedNames, ...await readNativeToolNames(client, user.userId),
          ...remoteMcp.map(tool => tool.model.name)]) : []
      const id = randomUUID()
      const bound = await NativeAttachments.bind(client, user, session, requestId, submitted)
      let admitted: z.infer<typeof admittedNativeContent>
      try {
        admitted = admittedNativeContent.parse(submitted.some(part => part.type === 'image') && imageAdmission
          ? await admitNativeImageContent({ userId: user.userId, sessionId: session, content: bound },
            imageAdmission.storage, imageAdmission.sdk, signal ?? new AbortController().signal)
          : bound)
      } catch (error) {
        if (isImageAdmissionError(error)) throw new PlatformError(400, error.code)
        throw error
      }
      signal?.throwIfAborted()
      const currentActor = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (currentActor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      await client.query(
        `INSERT INTO pe_operations(id,session_id,request_id,input,settings,skill_selection,mcp_selection,
          stdio_mcp_selection,ssh_selection,execution_target,remote_mcp_selection,stdio_v2_selection,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued')`,
        [id, session, requestId, text, config, JSON.stringify(selection), JSON.stringify(mcp),
          JSON.stringify(stdio), JSON.stringify(ssh), JSON.stringify(target), JSON.stringify(remoteMcp), JSON.stringify(stdioV2)],
      )
      await client.query('INSERT INTO pe_native_prompt_inputs(session_id,request_id,submitted,admitted) VALUES($1,$2,$3,$4)',
        [session, requestId, JSON.stringify(submitted), JSON.stringify(admitted)])
      if (imageAdmission) await saveNativeImageBindings(client, user.userId, session, requestId, admitted,
        imageAdmission.maxLedgerBytes)
      await client.query('SELECT pg_notify(\'pe_tasks\',$1)', [session])
      signal?.throwIfAborted()
      const finalActor = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (finalActor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      signal?.throwIfAborted()
      return { accepted: true, operationId: id, state: 'queued' }
    })
  }

  /** Cancel active work or the oldest queued input; later pending inputs remain independent.
   * @param user Owner authenticated by the route.
   * @param session Owned native Session to cancel.
   * @param credentialToken Original Agent bearer rechecked inside the cancellation transaction.
   * @returns A durable acknowledgement, including when no turn is active.
   */
  async cancel(user: Identity, session: SessionId, credentialToken: string): Promise<{ accepted: true }> {
    return this.cancelOperation(user, session, credentialToken, 'current-or-queued')
  }

  /** Cancel active work while preserving the pending inbox used by the native Session controller.
   * @param user Owner authenticated by the route.
   * @param session Owned native Session to cancel.
   * @param credentialToken Original Agent bearer rechecked inside the cancellation transaction.
   * @returns A durable acknowledgement, including when only pending inputs remain.
   */
  async cancelActive(user: Identity, session: SessionId, credentialToken: string): Promise<{ accepted: true }> {
    return this.cancelOperation(user, session, credentialToken, 'current')
  }

  private async cancelOperation(user: Identity, session: SessionId, credentialToken: string,
    mode: 'current' | 'current-or-queued'): Promise<{ accepted: true }> {
    return transaction(this.pool, async (client) => {
      // Remote dispatch takes the same owner lock before checking cancellation.
      const actor = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [session, user.userId])
      if (!owned.rowCount) throw new PlatformError(404, 'session_not_found')
      type CancellableOperation = { id: string; state: 'queued' | 'running' | 'completed' | 'failed' }
      const running = await client.query<CancellableOperation>(
        `SELECT o.id,o.state FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
         JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch AND a.ended_at IS NULL
         WHERE s.id=$1 AND o.state='running' ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o,a`, [session])
      const call = !running.rowCount ? await client.query<CancellableOperation>(
        `SELECT r.id,r.state FROM pe_stdio_v2_actions a JOIN pe_operations r ON r.id=a.root_operation_id
         WHERE a.session_id=$1 AND a.user_id=$2 AND a.phase='call' AND r.session_id=$1
           AND (EXISTS(SELECT 1 FROM pe_cloud_executions e WHERE e.stdio_action_id=a.id AND e.user_id=$2
             AND e.state IN ('queued','starting','running','cancelling','uncertain')))
         ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF r`, [session, user.userId]) : { rows: [] }
      const queued = mode === 'current-or-queued' && !running.rowCount && !call.rows.length ? await client.query<CancellableOperation>(
        `SELECT id,state FROM pe_operations WHERE session_id=$1 AND state='queued'
         ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [session]) : { rows: [] }
      const operation = running.rows[0] ?? call.rows[0] ?? queued.rows[0]
      if (!operation) return { accepted: true }
      await this.stopOperationChain(client, operation.id, user, session)
      if (operation.state === 'queued') {
        await client.query(
          'UPDATE pe_operations SET state=\'failed\',error_code=\'turn_user\',completed_at=now() WHERE id=$1', [operation.id],
        )
      } else if (operation.state === 'running') {
        await client.query(
          'UPDATE pe_operations SET error_code=\'cancel_requested\' WHERE id=$1 AND error_code IS DISTINCT FROM \'cancel_requested\'',
          [operation.id],
        )
      }
      return { accepted: true }
    })
  }

  private async stopOperationChain(client: PoolClient, operation: string, user: Identity, session: SessionId): Promise<void> {
    // Native turn completion may clear error_code; a stopped MCP chain remains stopped.
    await client.query(`UPDATE pe_operations SET mcp_chain_cancelled_at=COALESCE(mcp_chain_cancelled_at,clock_timestamp())
      WHERE id=(SELECT COALESCE(mcp_root_operation_id,id) FROM pe_operations WHERE id=$1)`, [operation])
    await client.query(`UPDATE pe_mcp_action_chains SET stopped_at=COALESCE(stopped_at,clock_timestamp()),
      error_code=COALESCE(error_code,'mcp_operation_cancelled') WHERE root_operation_id=
      (SELECT COALESCE(mcp_root_operation_id,id) FROM pe_operations WHERE id=$1)`, [operation])
    await client.query(`UPDATE pe_stdio_v2_actions SET cancel_requested=true,updated_at=clock_timestamp()
      WHERE user_id=$2 AND session_id=$3 AND phase='call' AND root_operation_id=
        (SELECT COALESCE(mcp_root_operation_id,id) FROM pe_operations WHERE id=$1) AND NOT cancel_requested`,
    [operation, user.userId, session])
    await client.query(`UPDATE pe_cloud_executions e SET cancel_requested=true,updated_at=clock_timestamp()
      FROM pe_stdio_v2_actions a WHERE a.id=e.stdio_action_id AND a.user_id=$2 AND a.session_id=$3
      AND a.phase='call' AND a.root_operation_id=(SELECT COALESCE(mcp_root_operation_id,id) FROM pe_operations WHERE id=$1)
      AND e.execution_kind='stdio_v2' AND NOT e.cancel_requested`, [operation, user.userId, session])
  }

  /** Persist one archival stop and request current work to stop without inventing native removals or remote outcomes.
   * @param client Archive transaction holding the authenticated account update and owned Session locks.
   * @param user Exact owner authenticated by that transaction.
   * @param session Exact owned Session archived by the same transaction.
   * @returns Original unfinished stop identity; native pending inputs retain their state until acknowledged removal.
   */
  async requestArchiveStopInTransaction(client: PoolClient, user: Identity,
    session: SessionId): Promise<NativeSessionStopIntent> {
    const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [session, user.userId])
    if (owned.rowCount !== 1) throw new PlatformError(404, 'session_not_found')
    const stop = await requestSessionStopInTransaction(client, user.userId, session)
    await client.query(`UPDATE pe_operations r SET mcp_chain_cancelled_at=COALESCE(r.mcp_chain_cancelled_at,clock_timestamp())
      WHERE r.session_id=$1 AND EXISTS(SELECT 1 FROM pe_operations o
        WHERE o.session_id=$1 AND COALESCE(o.mcp_root_operation_id,o.id)=r.id)`, [session])
    await client.query(`UPDATE pe_mcp_action_chains c SET stopped_at=COALESCE(c.stopped_at,clock_timestamp()),
      error_code=COALESCE(c.error_code,'mcp_operation_cancelled') FROM pe_operations r
      WHERE c.root_operation_id=r.id AND r.session_id=$1`, [session])
    await client.query(`UPDATE pe_stdio_v2_actions a SET cancel_requested=true,updated_at=clock_timestamp()
      FROM pe_operations r WHERE a.user_id=$2 AND a.session_id=$1 AND a.phase='call'
      AND r.id=a.root_operation_id AND r.session_id=$1 AND NOT a.cancel_requested`, [session, user.userId])
    await client.query(`UPDATE pe_cloud_executions e SET cancel_requested=true,updated_at=clock_timestamp()
      FROM pe_stdio_v2_actions a,pe_operations r WHERE a.id=e.stdio_action_id AND a.user_id=$2 AND a.session_id=$1
      AND a.phase='call' AND r.id=a.root_operation_id AND r.session_id=$1
      AND e.user_id=$2 AND e.session_id=$1 AND e.execution_kind='stdio_v2' AND NOT e.cancel_requested`,
    [session, user.userId])
    await client.query(`UPDATE pe_operations SET error_code='cancel_requested'
      WHERE session_id=$1 AND state='running' AND error_code IS DISTINCT FROM 'cancel_requested'`, [session])
    await client.query(`UPDATE pe_operations o SET state='failed',error_code='turn_user',completed_at=clock_timestamp()
      WHERE o.session_id=$1 AND o.state='queued' AND o.attempts=0
      AND NOT EXISTS(SELECT 1 FROM pe_native_input_origins i WHERE i.origin_operation_id=o.id)`, [session])
    await client.query("SELECT pg_notify('pe_tasks',$1)", [session])
    return stop
  }

  /** Claim accepted work from an active account after serializing its capacity and Session lease.
   * Live native writer occupancy and unresolved retained mutations prevent claiming, including after a Session lock wait.
   * @param workerId Trusted Host worker identity.
   * @returns One execution grant, or null when eligible work is unavailable.
   */
  async claim(workerId: string, owner?: { userId: UserId; authenticate: (client: PoolClient) => Promise<void> }): Promise<Grant | null> {
    return this.claimForPurpose(workerId, false, owner)
  }

  /** Acquire only storage ownership for an unfinished archival stop, including after unarchive.
   * The returned original operation remains fenced from model and tool execution by its stop purpose.
   * @param workerId Trusted Host worker that will acquire an independent Session Writer.
   * @returns Current original storage grant, or null when no stopped Session is eligible for maintenance.
   */
  async claimArchiveStop(workerId: string,
    owner?: { userId: UserId; authenticate: (client: PoolClient) => Promise<void> }): Promise<Grant | null> {
    return this.claimForPurpose(workerId, true, owner)
  }

  private async claimForPurpose(workerId: string, archiveStop: boolean,
    owner?: { userId: UserId; authenticate: (client: PoolClient) => Promise<void> }): Promise<Grant | null> {
    return transaction(this.pool, async (client) => {
      await owner?.authenticate(client)
      const candidate = await client.query<{ id: string; session_id: string; user_id: string }>(
        `SELECT o.id,o.session_id,s.user_id
         FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id JOIN pe_users u ON u.id=s.user_id
         WHERE u.enabled=true AND u.deleted_at IS NULL AND o.state IN ('queued','running')
         AND ($3::uuid IS NULL OR s.user_id=$3) AND o.source<>'native_interactive'
         AND NOT EXISTS (SELECT 1 FROM pe_native_subagent_grants g JOIN pe_operations child ON child.id=g.operation_id WHERE child.session_id=s.id)
         AND (CASE WHEN $2::boolean THEN EXISTS (SELECT 1 FROM pe_native_preferences p WHERE p.user_id=s.user_id
           AND p.namespace='session-archive-stop:'||s.id::text AND p.value->>'status'='requested')
         ELSE NOT EXISTS (SELECT 1 FROM pe_native_preferences p WHERE p.user_id=s.user_id
           AND p.namespace='workspace-layout' AND p.value->'archivedSessionIds' ? s.id::text)
           AND NOT EXISTS (SELECT 1 FROM pe_native_preferences p WHERE p.user_id=s.user_id
             AND p.namespace='session-archive-stop:'||s.id::text AND p.value->>'status'='requested') END)
         AND (s.lease_until IS NULL OR s.lease_until<=now())
         AND NOT EXISTS (SELECT 1 FROM pe_native_writers w WHERE w.session_id=s.id AND w.expires_at>clock_timestamp())
         AND NOT EXISTS (SELECT 1 FROM pe_native_retained_intents j WHERE j.session_id=s.id AND j.state='prepared')
         AND (SELECT count(*) FROM pe_sessions active WHERE active.user_id=s.user_id AND active.lease_until>clock_timestamp())<$1
         AND NOT EXISTS (SELECT 1 FROM pe_operations earlier WHERE earlier.session_id=s.id
           AND earlier.state IN ('queued',
             'running') AND earlier.source<>'native_interactive' AND (earlier.created_at,earlier.id)<(o.created_at,o.id))
         ORDER BY u.last_claim_at NULLS FIRST,o.created_at,o.id LIMIT 1 FOR NO KEY UPDATE OF u SKIP LOCKED`,
        [this.limits.maxActivePerUser, archiveStop, owner?.userId ?? null],
      )
      const row = candidate.rows[0]
      if (!row) return null
      // Serialize a user's capacity check across otherwise independent Session rows.
      await requireActiveAccount(client, executionUserId.parse(row.user_id), 'update')
      const resource = await client.query(`SELECT o.id FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
        WHERE o.id=$1 AND s.user_id=$2 AND o.state IN ('queued','running') AND o.source<>'native_interactive'
        AND NOT EXISTS (SELECT 1 FROM pe_native_subagent_grants g JOIN pe_operations child ON child.id=g.operation_id WHERE child.session_id=s.id)
        AND (s.lease_until IS NULL OR s.lease_until<=clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM pe_native_writers w WHERE w.session_id=s.id AND w.expires_at>clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM pe_native_retained_intents j WHERE j.session_id=s.id AND j.state='prepared')
        AND NOT EXISTS (SELECT 1 FROM pe_operations earlier WHERE earlier.session_id=s.id
          AND earlier.state IN ('queued','running') AND earlier.source<>'native_interactive' AND (earlier.created_at,earlier.id)<(o.created_at,o.id))
        FOR UPDATE OF s,o`, [row.id, row.user_id])
      if (!resource.rowCount) return null
      const pending = await client.query(`SELECT 1 FROM pe_native_retained_intents
        WHERE session_id=$1 AND state='prepared' LIMIT 1`, [row.session_id])
      if (pending.rowCount) return null
      if (archiveStop) {
        const stop = await readSessionStopInTransaction(client, row.user_id, brandString<SessionId>(row.session_id))
        if (stop?.status !== 'requested') return null
      } else if (await isSessionBusinessBlockedInTransaction(client, row.user_id, row.session_id)) return null
      const writer = await client.query(`SELECT session_id FROM pe_native_writers
        WHERE session_id=$1 AND expires_at>clock_timestamp()`, [row.session_id])
      if (writer.rowCount) return null
      const active = await client.query<{ count: string }>(
        'SELECT count(*) FROM pe_sessions WHERE user_id=$1 AND lease_until>clock_timestamp()', [row.user_id],
      )
      const activeCount = active.rows[0]
      if (!activeCount) throw new Error('Active Session count is missing')
      if (Number(activeCount.count) >= this.limits.maxActivePerUser) return null
      await client.query(`UPDATE pe_native_interactive_grants SET released_at=clock_timestamp()
        WHERE session_id=$1 AND released_at IS NULL`, [row.session_id])
      await client.query(`UPDATE pe_attempts a SET ended_at=clock_timestamp() FROM pe_operations o
        WHERE o.session_id=$1 AND o.source='native_interactive' AND o.state='running' AND a.operation_id=o.id AND a.ended_at IS NULL`, [row.session_id])
      await client.query(`UPDATE pe_operations SET state='failed',error_code='native_interactive_expired',completed_at=clock_timestamp()
        WHERE session_id=$1 AND source='native_interactive' AND state='running'`, [row.session_id])
      const selected = this.claimSelection
        ? await this.claimSelection(client, brandString<SessionId>(row.session_id), executionOperationId.parse(row.id))
        : executionOperationId.parse(row.id)
      const eligible = await client.query(`SELECT o.id FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
        WHERE o.id=$1 AND s.id=$2 AND s.user_id=$3 AND o.state IN ('queued','running')
          AND (s.lease_until IS NULL OR s.lease_until<=clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM pe_native_writers w WHERE w.session_id=s.id AND w.expires_at>clock_timestamp())
        FOR UPDATE OF o`, [selected, row.session_id, row.user_id])
      if (eligible.rowCount !== 1) throw new PlatformError(409, 'native_claim_selection_changed')
      await client.query('UPDATE pe_users SET last_claim_at=clock_timestamp() WHERE id=$1', [row.user_id])
      const token = randomBytes(32).toString('base64url')
      const updated = await client.query<{ lease_epoch: number }>(
        `UPDATE pe_sessions SET lease_epoch=lease_epoch+1,grant_digest=$2,
         lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE id=$1 RETURNING lease_epoch`,
        [row.session_id, digest(token), this.limits.leaseMs],
      )
      const updatedSession = updated.rows[0]
      if (!updatedSession) throw new PlatformError(409, 'lease_lost')
      const epoch = updatedSession.lease_epoch
      await client.query(`UPDATE pe_operations SET state='running',attempts=attempts+1,
        error_code=CASE WHEN $2::boolean THEN 'cancel_requested' ELSE error_code END WHERE id=$1`, [selected, archiveStop])
      await client.query('INSERT INTO pe_attempts(operation_id,epoch,worker_id) VALUES($1,$2,$3)', [selected, epoch, workerId])
      return this.restoreGrantInTransaction(client, selected, token, epoch)
    })
  }

  /** Restore the original accepted fields for one exact live operation attempt in the caller's transaction.
   * @param client Existing transaction; account and Session authority is checked before the operation lock.
   * @param operationId Exact operation whose attempt has just been issued by the caller.
   * @param token Current Session bearer; no new token is generated and no acceptance is repeated.
   * @param epoch Exact live Session and attempt epoch; historical receipts must use their stored tokenless snapshot.
   * @returns Frozen accepted input and selections under the current bearer, rechecked after restoration reads.
   */
  async restoreGrantInTransaction(client: PoolClient, operationId: OperationId, token: string, epoch: number): Promise<Grant> {
    const authorized = await this.authorized(client, token)
    if (authorized.operation_id !== operationId || authorized.lease_epoch !== epoch) throw new PlatformError(409, 'lease_lost')
    const found = await client.query<{
      id: string
      session_id: string
      user_id: string
      workspace_id: string
      request_id: string
      input: string
      settings: unknown
      skill_selection: unknown
      mcp_selection: unknown
      stdio_mcp_selection: unknown
      ssh_selection: unknown
      remote_mcp_selection: unknown
      stdio_v2_selection: unknown
      execution_target: unknown
      source: Grant['source']
      source_action_id: string | null
      source_execution_id: string | null
      source_stdio_mcp_call_id: string | null
      source_ssh_execute_action_id: string | null
      source_mcp_action_id: string | null
      source_stdio_v2_action_id: string | null
      source_stdio_v2_no_start_action_id: string | null
      source_stdio_v2_phase: string | null
    }>(
      `SELECT o.id,o.session_id,s.user_id,s.workspace_id,o.request_id,o.input,o.settings,o.skill_selection,
        o.mcp_selection,o.remote_mcp_selection,o.stdio_v2_selection,o.stdio_mcp_selection,o.ssh_selection,
        o.source,o.source_action_id,o.source_execution_id,o.source_stdio_mcp_call_id,o.source_ssh_execute_action_id,
        o.source_mcp_action_id,o.source_stdio_v2_action_id,o.source_stdio_v2_no_start_action_id,o.source_stdio_v2_phase,
        o.execution_target FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
        WHERE o.id=$1 AND o.session_id=$2 AND o.state='running'
          AND EXISTS(SELECT 1 FROM pe_attempts a WHERE a.operation_id=o.id AND a.epoch=$3 AND a.ended_at IS NULL)
        FOR UPDATE OF o`, [operationId, authorized.id, epoch])
    const row = found.rows[0]
    if (!row) throw new PlatformError(409, 'lease_lost')
    const remoteMcpTools = mcpOperationTools.parse(row.remote_mcp_selection)
    const stdioV2Connections = this.limits.stdioV2Admission ? this.limits.stdioV2Admission.selection.restore(row.stdio_v2_selection,
      [...this.limits.stdioV2Admission.reservedNames, ...remoteMcpTools.map(tool => tool.model.name)]) : []
    if (!this.limits.stdioV2Admission && !z.array(z.never()).safeParse(row.stdio_v2_selection).success) {
      throw new PlatformError(409, 'stdio_v2_admission_unavailable')
    }
    executionTarget.parse(row.execution_target)
    if (stdioV2Connections.some(group => group.scopeBinding.userId !== row.user_id
      || group.scopeBinding.workspaceId !== row.workspace_id)) {
      throw new PlatformError(409, 'stdio_v2_origin_changed')
    }
    const prompt = await client.query<{ admitted: unknown }>(
      'SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2', [row.session_id, row.request_id])
    const attached = await client.query<{ file: unknown }>(
      'SELECT DISTINCT file FROM pe_native_file_receipts WHERE user_id=$1 AND session_id=$2 AND request_id IS NOT NULL',
      [row.user_id, row.session_id])
    const restored = grant.parse({
      operationId: row.id, sessionId: row.session_id, userId: row.user_id, requestId: row.request_id,
      text: row.source === 'native_interactive' ? '' : row.source === 'user' ? row.input : continuationInput(row.input, this.limits.maxEventBytes),
      nativeContent: row.source === 'user' && prompt.rows[0] ? admittedNativeContent.parse(prompt.rows[0].admitted) : null,
      attachments: attached.rows.map(item => nativeFileAttachment.parse(item.file)).sort((a, b) =>
        a.attachmentId.localeCompare(b.attachmentId) || a.name.localeCompare(b.name)),
      settings: settings.parse(row.settings), selection: z.array(skillSelection).max(256).parse(row.skill_selection),
      mcpConnections: z.array(mcpSelection).max(1).parse(row.mcp_selection),
      remoteMcpTools, stdioV2Connections,
      stdioMcpConnections: z.array(stdioMcpSelection).max(1).parse(row.stdio_mcp_selection),
      sshConnections: z.array(sshSelection).max(8).parse(row.ssh_selection),
      source: row.source, sourceActionId: row.source_action_id,
      sourceExecutionId: row.source_execution_id,
      sourceStdioMcpCallId: row.source_stdio_mcp_call_id,
      sourceSshExecuteActionId: row.source_ssh_execute_action_id,
      sourceMcpActionId: row.source_mcp_action_id,
      sourceStdioV2ActionId: row.source_stdio_v2_action_id, sourceStdioV2NoStartActionId: row.source_stdio_v2_no_start_action_id,
      sourceStdioV2Phase: row.source_stdio_v2_phase,
      target: executionTarget.parse(row.execution_target), executionEnabled: this.limits.executionEnabled ?? false,
      token, epoch,
    })
    const current = await this.authorized(client, token)
    if (current.operation_id !== operationId || current.lease_epoch !== epoch) throw new PlatformError(409, 'lease_lost')
    return restored
  }

  /** Lock the grant owner before the Session, then recheck expiry against the current PG clock.
   * @param client Caller transaction; acquire this authority before resource locks.
   * @param token Current Session execution grant, independent of browser credential rotation.
   * @returns Current owned Session and operation; required password change does not revoke this grant.
   */
  async authorized(client: PoolClient, token: string): Promise<SessionRow & {
    operation_id: string
    settings: unknown
    execution_target: unknown
    source: string
  }> {
    const owner = await client.query<{ user_id: string }>('SELECT user_id FROM pe_sessions WHERE grant_digest=$1', [digest(token)])
    if (!owner.rows[0]) throw new PlatformError(409, 'lease_lost')
    await requireActiveAccount(client, executionUserId.parse(owner.rows[0].user_id), 'update')
    const result = await client.query<SessionRow & { operation_id: string; settings: unknown; execution_target: unknown; source: string }>(
      `SELECT s.*,o.id AS operation_id,o.settings,o.execution_target,o.source FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
       JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch AND a.ended_at IS NULL
       WHERE s.grant_digest=$1 AND s.lease_until>clock_timestamp() AND o.state='running' FOR UPDATE OF s`, [digest(token)],
    )
    const row = result.rows[0]
    if (!row || result.rows.length !== 1) throw new PlatformError(409, 'lease_lost')
    // PG can test WHERE before a row lock wait without rechecking an unchanged tuple afterward.
    const live = await client.query(`SELECT id FROM pe_sessions WHERE id=$1
      AND grant_digest=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()`,
    [row.id, digest(token), row.lease_epoch])
    if (!live.rowCount) throw new PlatformError(409, 'lease_lost')
    await assertNativeRuntimeGrant(client, row)
    if (row.source === 'native_interactive') await assertNativeInteractiveStorage(client, row)
    await assertNativeSubagentStorage(client, row)
    return row
  }

  /** Authorize business execution only through the explicitly installed native consumption provider.
   * @param client Existing transaction; active account and Session locks are acquired before the provider runs.
   * @param token Exact live operation bearer; prepared storage authorization alone cannot start execution.
   * @returns Current Session and operation after the provider verifies the durable claim, open step and clocks.
   */
  async executionAuthorized(client: PoolClient, token: string): Promise<Awaited<ReturnType<TaskStore['authorized']>>> {
    if (!this.executionAuthority) throw new PlatformError(503, 'execution_authority_unavailable')
    const session = await this.authorized(client, token)
    if (session.source === 'native_interactive') throw new PlatformError(403, 'native_interactive_model_forbidden')
    if (await isSessionBusinessBlockedInTransaction(client, session.user_id, session.id)) {
      throw new PlatformError(409, 'native_session_archived')
    }
    if (await assertNativeSubagentStorage(client, session)) await assertNativeSubagentExecution(client, session)
    else await this.executionAuthority(client, session, token)
    return session
  }

  /** Authorize one native execution world by its explicit purpose without granting interactive model consumption.
   * @param client Existing account and Session transaction.
   * @param token Exact original operation or formal interactive bearer.
   * @param purpose Read-only storage initialization or native Fs/process execution.
   * @returns Current exact Session after purpose-specific clocks and durable interactive Writer checks.
   */
  async nativeWorldAuthorized(client: PoolClient, token: string, purpose: 'storage-read' | 'execution' = 'execution'):
  Promise<Awaited<ReturnType<TaskStore['authorized']>>> {
    const session = await this.authorized(client, token)
    if (session.source !== 'native_interactive') return purpose === 'storage-read' ? session : this.executionAuthorized(client, token)
    if (await isSessionBusinessBlockedInTransaction(client, session.user_id,
      session.id)) throw new PlatformError(409, 'native_session_archived')
    await assertNativeInteractiveWorld(client, session)
    return session
  }

  /** Renew only a grant still live at the lease update, after any authorization lock waits.
   * Configured presentation renewal preserves the same live prefix without reviving an expired presentation.
   * @param token Current execution grant, independent of browser credential rotation.
   * @returns Cancellation status after extending the live lease from the current PG clock.
   */
  async renew(token: string): Promise<{ cancelRequested: boolean; archiveStop?: NativeSessionStopIntent }> {
    return transaction(this.pool, async (client) => {
      const row = await this.authorized(client, token)
      const renewed = await client.query(`UPDATE pe_sessions
        SET lease_until=clock_timestamp()+$2::double precision*interval '1 millisecond'
        WHERE id=$1 AND grant_digest=$3 AND lease_epoch=$4 AND lease_until>clock_timestamp() RETURNING id`,
      [row.id, this.limits.leaseMs, digest(token), row.lease_epoch])
      if (!renewed.rowCount) throw new PlatformError(409, 'lease_lost')
      if (this.limits.nativeAssistantTtlMs !== undefined) {
        await client.query('SELECT session_id FROM pe_native_presentations WHERE session_id=$1 AND epoch=$2 FOR UPDATE',
          [row.id, row.lease_epoch])
        await client.query(`UPDATE pe_native_presentations p
          SET expires_at=LEAST(s.lease_until,clock_timestamp()+$3::double precision*interval '1 millisecond')
          FROM pe_sessions s WHERE p.session_id=s.id AND s.id=$1 AND p.epoch=$2
            AND p.expires_at>clock_timestamp() AND s.lease_until>clock_timestamp()`,
        [row.id, row.lease_epoch, this.limits.nativeAssistantTtlMs])
        await this.authorized(client, token)
      }
      const operation = await client.query<{ error_code: string | null }>(
        'SELECT error_code FROM pe_operations WHERE id=$1', [row.operation_id],
      )
      const stop = await readSessionStopInTransaction(client, row.user_id, brandString<SessionId>(row.id))
      return { cancelRequested: operation.rows[0]?.error_code === 'cancel_requested' || stop?.status === 'requested',
        ...stop?.status === 'requested' ? { archiveStop: stop } : {} }
    })
  }

  /** Read the operation's accepted skill metadata under its current lease.
   * @param token - current operation grant, never a user-supplied identity.
   * @returns owner, validated execution target and immutable skill selection for a bounded instruction read.
   */
  async selectedSkills(token: string): Promise<{ userId: string; target: ExecutionTarget; selection: z.infer<typeof skillSelection>[] }> {
    return transaction(this.pool, async (client) => {
      const row = await this.authorized(client, token)
      const operation = await client.query<{ skill_selection: unknown }>(
        'SELECT skill_selection FROM pe_operations WHERE id=$1 AND session_id=$2', [row.operation_id, row.id])
      if (!operation.rows[0]) throw new PlatformError(409, 'lease_lost')
      return { userId: row.user_id, target: executionTarget.parse(row.execution_target),
        selection: z.array(skillSelection).max(256).parse(operation.rows[0].skill_selection) }
    })
  }

  /** Settle an Operation only after the caller has flushed and disposed its Agent.
   * The current grant must remain authorized; settlement ends its attempt and releases the Session lease atomically.
   * Native interactive settlement retires only that original Operation's bounded grant in the same transaction.
   * @param token Current execution grant for the Operation being settled.
   * @param outcome Terminal state observed by the Host.
   * @param errorCode Host failure code, or null; an aborted cancellation is recorded as turn_user.
   */
  async finish(token: string, outcome: 'completed' | 'failed', errorCode: string | null): Promise<void> {
    await transaction(this.pool, async (client) => {
      const row = await this.authorized(client, token)
      const stop = await readSessionStopInTransaction(client, row.user_id, brandString<SessionId>(row.id))
      const source = stop?.status === 'requested' ? (await client.query<{ deadline: string }>(
        'SELECT lease_until::text AS deadline FROM pe_sessions WHERE id=$1', [row.id])).rows[0] : undefined
      if (stop?.status === 'requested' && !source) throw new PlatformError(409, 'lease_lost')
      const operation = await client.query<{ error_code: string | null; source: string }>(
        'SELECT error_code,source FROM pe_operations WHERE id=$1 AND session_id=$2', [row.operation_id, row.id],
      )
      // The native turn can finish while its cancellation request is in flight.
      // A completed durable turn remains completed; cancellation only settles
      // work that the Host actually stopped.
      const cancelled = errorCode === 'turn_aborted' && operation.rows[0]?.error_code === 'cancel_requested'
      await client.query('UPDATE pe_operations SET state=$2,error_code=$3,completed_at=now() WHERE id=$1',
        [row.operation_id, outcome, cancelled ? 'turn_user' : errorCode])
      await client.query('UPDATE pe_attempts SET ended_at=now() WHERE operation_id=$1 AND epoch=$2',
        [row.operation_id, row.lease_epoch])
      await client.query('DELETE FROM pe_native_presentations WHERE session_id=$1 AND epoch=$2', [row.id, row.lease_epoch])
      const settled = await client.query(`UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL,updated_at=now()
        WHERE id=$1 AND grant_digest=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp() RETURNING id`,
      [row.id, digest(token), row.lease_epoch])
      if (!settled.rowCount) throw new PlatformError(409, 'lease_lost')
      if (operation.rows[0]?.source === 'native_interactive') {
        await client.query(`UPDATE pe_native_interactive_grants SET released_at=clock_timestamp()
          WHERE operation_id=$1 AND session_id=$2 AND user_id=$3 AND released_at IS NULL`,
        [row.operation_id, row.id, row.user_id])
      }
      if (stop?.status === 'requested') {
        const history = this.limits.archiveStopHistory
        if (!history) throw new PlatformError(503, 'native_session_stop_history_unavailable')
        await completeSessionStopInTransaction(client, row.user_id, brandString<SessionId>(row.id), stop.stopId, history)
        const live = await client.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()', [source?.deadline])
        if (live.rowCount !== 1) throw new PlatformError(409, 'lease_lost')
      }
    })
  }

  /** Require ownership without disclosing whether another user's Session exists.
   * @param client Caller database connection; this lookup does not acquire a Session lease or row lock.
   * @param user Authenticated owner whose Session is requested.
   * @param session Requested native Session identity.
   * @returns Owned Session metadata, or rejects with session_not_found for absent or foreign Sessions.
   */
  async owned(client: Pick<PoolClient, 'query'>, user: Identity, session: SessionId): Promise<SessionRow> {
    const result = await client.query<SessionRow>('SELECT * FROM pe_sessions WHERE id=$1 AND user_id=$2', [session, user.userId])
    const row = result.rows[0]
    if (!row) throw new PlatformError(404, 'session_not_found')
    return row
  }
}
