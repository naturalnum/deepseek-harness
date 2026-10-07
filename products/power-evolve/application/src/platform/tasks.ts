/** Durable acceptance, per-session leases, and operation attempts. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { executionTarget, grant, mcpSelection, stdioMcpSelection, sshSelection, skillSelection, PlatformError, settings,
  userId as executionUserId, type ExecutionTarget, type Grant, type Identity, type RequestId, type WorkspaceId } from '../contracts.ts'
import { z } from 'zod'
import { digest } from './identity.ts'
import { transaction } from './database.ts'
import { requireModelGrant } from './account-settings.ts'
import { continuationInput } from '../continuation-input.ts'
import { mcpOperationTools } from '../mcp-operation-contracts.ts'
import { selectMcpOperationTools, type McpOperationAdmissionLimits } from './mcp-admission.ts'
import { requireActiveAccount, requireBrowserAccount } from './account-authority.ts'

interface SessionRow {
  id: string
  user_id: string
  header: SessionHeader
  event_count: number
  event_bytes: string
  lease_epoch: number
}

/** Limits are deployment inputs, applied atomically during acceptance and claiming. */
export interface TaskLimits {
  readonly maxEventBytes: number
  readonly leaseMs: number
  readonly maxPendingPerUser: number
  readonly maxActivePerUser: number
  readonly executionEnabled?: boolean
  readonly mcpEnabled?: boolean
  readonly remoteMcpAdmission?: McpOperationAdmissionLimits
  readonly stdioMcpEnabled?: boolean
  readonly sshEnabled?: boolean
}

/** Platform-owned state machine. Host callers never choose a task's user identity. */
export class TaskStore {
  constructor(readonly pool: Pool, private readonly limits: TaskLimits) {}

  /** Create a durable empty native Session, deduplicated within one authenticated user.
   * @param user Owner authenticated by the route.
   * @param requestId Stable Session creation request identity.
   * @param credentialToken Original Agent bearer rechecked inside the acceptance transaction.
   * @param workspaceId Optional owned workspace to bind permanently.
   * @returns The new or previously accepted native Session identity.
   */
  async create(user: Identity, requestId: RequestId, credentialToken: string,
    workspaceId?: WorkspaceId): Promise<{ sessionId: SessionId }> {
    const id = randomUUID()
    const header: SessionHeader = { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false }
    return transaction(this.pool, async client => {
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
        return { sessionId: SessionId(previous.rows[0].id) }
      }
      const target = await client.query<{ id: string }>(
        `SELECT id FROM pe_workspaces WHERE id=COALESCE($2::uuid,
           (SELECT id FROM pe_workspaces WHERE user_id=$1 AND is_default)) AND user_id=$1`,
        [user.userId, workspaceId ?? null])
      const chosen = target.rows[0]?.id
      if (!chosen) throw new PlatformError(404, 'workspace_not_found')
      if (previous.rows[0]) {
        if (previous.rows[0].workspace_id !== chosen) throw new PlatformError(409, 'request_id_conflict')
        return { sessionId: SessionId(previous.rows[0].id) }
      }
      await client.query(
        `INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header)
         VALUES ($1,$2,$3,$4,$5)`, [id, user.userId, chosen, requestId, header])
      return { sessionId: SessionId(id) }
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
   * @param target Explicit cloud or owned desktop placement.
   * @returns Durable acceptance and the original operation state on replay.
   */
  async accept(user: Identity, session: SessionId, requestId: RequestId, text: string,
    credentialToken: string, target: ExecutionTarget = { kind: 'cloud' }): Promise<unknown> {
    return transaction(this.pool, async client => {
      const actor = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const current = await client.query<{ settings: unknown }>(
        'SELECT settings FROM pe_users WHERE id=$1', [user.userId])
      if (!current.rows[0]) throw new PlatformError(401, 'unauthorized')
      await this.owned(client, user, session)
      const prior = await client.query<{ id: string; input: string; state: string; execution_target: unknown }>(
        'SELECT id,input,state,execution_target FROM pe_operations WHERE session_id=$1 AND request_id=$2', [session, requestId],
      )
      const found = prior.rows[0]
      if (found) {
        const existingTarget = executionTarget.parse(found.execution_target)
        if (found.input !== text || existingTarget.kind !== target.kind
          || existingTarget.kind === 'desktop' && target.kind === 'desktop'
            && (existingTarget.deviceId !== target.deviceId || existingTarget.directoryId !== target.directoryId)) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        return { accepted: true, operationId: found.id, state: found.state }
      }
      const config = settings.parse(current.rows[0].settings)
      await requireModelGrant(client, user.userId, config.model, config.maxTokens)
      if (target.kind === 'desktop') {
        const available = await client.query(
          `SELECT d.id FROM pe_devices d JOIN pe_device_directories dir ON dir.device_id=d.id
           WHERE d.id=$1 AND dir.id=$2 AND d.user_id=$3 AND dir.user_id=$3
             AND d.revoked_at IS NULL AND dir.revoked_at IS NULL`,
          [target.deviceId, target.directoryId, user.userId])
        if (!available.rowCount) throw new PlatformError(403, 'desktop_target_unavailable')
      }
      const count = await client.query<{ count: string }>(
        `SELECT count(*) FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
         WHERE s.user_id=$1 AND o.state IN ('queued','running')`, [user.userId],
      )
      if (Number(count.rows[0]!.count) >= this.limits.maxPendingPerUser) throw new PlatformError(429, 'pending_limit')
      const selected = await client.query(
        `SELECT s.id AS "skillId",s.name,s.description,s.digest,s.revision,s.kind,
          v.version,v.archive_digest AS "packageDigest",v.manifest_digest AS "manifestDigest"
         FROM pe_user_skills s LEFT JOIN pe_skill_package_versions v ON v.id=s.package_version_id
         WHERE s.user_id=$1 AND s.enabled=true AND s.revoked_at IS NULL
           ORDER BY s.name,s.id`, [user.userId],
      )
      const selection = z.array(skillSelection).max(256).parse(selected.rows)
      const mcpRows = this.limits.mcpEnabled && target.kind === 'cloud'
        ? await client.query<{ connectionId: string; revision: number }>(
          'SELECT id AS "connectionId",revision FROM pe_mcp_connections WHERE user_id=$1 AND enabled=true', [user.userId])
        : { rows: [] }
      const mcp = z.array(mcpSelection).max(1).parse(mcpRows.rows)
      const remoteMcp = this.limits.remoteMcpAdmission && target.kind === 'cloud'
        ? await selectMcpOperationTools(client, user.userId, this.limits.remoteMcpAdmission) : []
      const stdioRows = this.limits.stdioMcpEnabled && target.kind === 'cloud'
        ? await client.query<{ connectionId: string; revision: number }>(
          'SELECT id AS "connectionId",revision FROM pe_stdio_mcp_connections WHERE user_id=$1 AND enabled=true',
          [user.userId]) : { rows: [] }
      const stdio = z.array(stdioMcpSelection).max(1).parse(stdioRows.rows)
      const sshRows = this.limits.sshEnabled && target.kind === 'cloud'
        ? await client.query<{ connectionId: string; revision: number; credentialRevision: number;
            displayName: string; host: string; port: number; username: string }>(
          `SELECT c.id AS "connectionId",v.revision,v.credential_revision AS "credentialRevision",
            v.display_name AS "displayName",v.host,v.port,v.username
           FROM pe_ssh_connections c JOIN pe_ssh_configuration_versions v
             ON v.connection_id=c.id AND v.user_id=c.user_id AND v.revision=c.revision
               AND v.credential_revision=c.credential_revision
           WHERE c.user_id=$1 AND c.enabled=true AND c.deleted_at IS NULL ORDER BY c.created_at,c.id`, [user.userId])
        : { rows: [] }
      const ssh = z.array(sshSelection).max(8).parse(sshRows.rows)
      const id = randomUUID()
      await client.query(
        `INSERT INTO pe_operations(id,session_id,request_id,input,settings,skill_selection,mcp_selection,
          stdio_mcp_selection,ssh_selection,execution_target,remote_mcp_selection,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued')`,
        [id, session, requestId, text, config, JSON.stringify(selection), JSON.stringify(mcp),
          JSON.stringify(stdio), JSON.stringify(ssh), JSON.stringify(target), JSON.stringify(remoteMcp)],
      )
      await client.query('SELECT pg_notify(\'pe_tasks\',$1)', [session])
      return { accepted: true, operationId: id, state: 'queued' }
    })
  }

  /** Cancel the current turn or its pending generic call; a later unclaimed user input stays independent.
   * @param user Owner authenticated by the route.
   * @param session Owned native Session to cancel.
   * @param credentialToken Original Agent bearer rechecked inside the cancellation transaction.
   * @returns A durable acknowledgement, including when no turn is active.
   */
  async cancel(user: Identity, session: SessionId, credentialToken: string): Promise<{ accepted: true }> {
    return transaction(this.pool, async client => {
      // Remote dispatch takes the same owner lock before checking cancellation.
      const actor = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [session, user.userId])
      if (!owned.rowCount) throw new PlatformError(404, 'session_not_found')
      type CancellableOperation = { id: string; state: 'queued' | 'running' | 'completed' | 'failed' }
      const running = await client.query<CancellableOperation>(
        `SELECT id,state FROM pe_operations WHERE session_id=$1 AND state='running'
         ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [session])
      const call = !running.rowCount ? await client.query<CancellableOperation>(
        `SELECT r.id,r.state FROM pe_stdio_v2_actions a JOIN pe_operations r ON r.id=a.root_operation_id
         WHERE a.session_id=$1 AND a.user_id=$2 AND a.phase='call' AND r.session_id=$1
           AND (EXISTS(SELECT 1 FROM pe_cloud_executions e WHERE e.stdio_action_id=a.id AND e.user_id=$2
             AND e.state IN ('queued','starting','running','cancelling','uncertain'))
             OR EXISTS(SELECT 1 FROM pe_desktop_executions e WHERE e.stdio_action_id=a.id AND e.user_id=$2
               AND e.state IN ('queued','running','cancelling','uncertain')))
         ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF r`, [session, user.userId]) : { rows: [] }
      const queued = !running.rowCount && !call.rows.length ? await client.query<CancellableOperation>(
        `SELECT id,state FROM pe_operations WHERE session_id=$1 AND state='queued'
         ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [session]) : { rows: [] }
      const operation = running.rows[0] ?? call.rows[0] ?? queued.rows[0]
      if (!operation) return { accepted: true }
      // Native turn completion may clear error_code; a stopped MCP chain remains stopped.
      await client.query(`UPDATE pe_operations SET mcp_chain_cancelled_at=COALESCE(mcp_chain_cancelled_at,clock_timestamp())
        WHERE id=(SELECT COALESCE(mcp_root_operation_id,id) FROM pe_operations WHERE id=$1)`, [operation.id])
      await client.query(`UPDATE pe_mcp_action_chains SET stopped_at=COALESCE(stopped_at,clock_timestamp()),
        error_code=COALESCE(error_code,'mcp_operation_cancelled') WHERE root_operation_id=
        (SELECT COALESCE(mcp_root_operation_id,id) FROM pe_operations WHERE id=$1)`, [operation.id])
      await client.query(`UPDATE pe_stdio_v2_actions SET cancel_requested=true,updated_at=clock_timestamp()
        WHERE user_id=$2 AND session_id=$3 AND phase='call' AND root_operation_id=
          (SELECT COALESCE(mcp_root_operation_id,id) FROM pe_operations WHERE id=$1) AND NOT cancel_requested`,
      [operation.id, user.userId, session])
      for (const table of ['pe_cloud_executions', 'pe_desktop_executions']) {
        await client.query(`UPDATE ${table} e SET cancel_requested=true,updated_at=clock_timestamp()
          FROM pe_stdio_v2_actions a WHERE a.id=e.stdio_action_id AND a.user_id=$2 AND a.session_id=$3
          AND a.phase='call' AND a.root_operation_id=(SELECT COALESCE(mcp_root_operation_id,id) FROM pe_operations WHERE id=$1)
          AND e.execution_kind='stdio_v2' AND NOT e.cancel_requested`, [operation.id, user.userId, session])
      }
      if (operation.state === 'queued') {
        await client.query(
          `UPDATE pe_operations SET state='failed',error_code='turn_user',completed_at=now() WHERE id=$1`, [operation.id],
        )
      } else if (operation.state === 'running') {
        await client.query(
          `UPDATE pe_operations SET error_code='cancel_requested' WHERE id=$1 AND error_code IS DISTINCT FROM 'cancel_requested'`,
          [operation.id],
        )
      }
      return { accepted: true }
    })
  }

  /** Claim accepted work from an active account after serializing its capacity and Session lease.
   * @param workerId Trusted Host worker identity.
   * @returns One execution grant, or null when eligible work is unavailable.
   */
  async claim(workerId: string): Promise<Grant | null> {
    return transaction(this.pool, async client => {
      const candidate = await client.query<{
        id: string; session_id: string; user_id: string; request_id: string; input: string; settings: unknown;
        skill_selection: unknown; mcp_selection: unknown; stdio_mcp_selection: unknown; ssh_selection: unknown;
        remote_mcp_selection: unknown;
        execution_target: unknown;
        source: 'user' | 'platform_action' | 'sandbox_result' | 'desktop_result' | 'stdio_mcp_result'
          | 'ssh_execute_result' | 'remote_mcp_result';
        source_action_id: string | null; source_execution_id: string | null; source_desktop_execution_id: string | null;
        source_stdio_mcp_call_id: string | null;
        source_ssh_execute_action_id: string | null; source_mcp_action_id: string | null;
      }>(
        `SELECT o.id,o.session_id,s.user_id,o.request_id,o.input,o.settings,o.skill_selection,o.mcp_selection,o.remote_mcp_selection,
         o.stdio_mcp_selection,o.ssh_selection,o.source,o.source_action_id,o.source_execution_id,
         o.source_desktop_execution_id,o.source_stdio_mcp_call_id,o.source_ssh_execute_action_id,o.source_mcp_action_id,o.execution_target
         FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id JOIN pe_users u ON u.id=s.user_id
         WHERE u.enabled=true AND u.deleted_at IS NULL AND o.state IN ('queued','running')
         AND (s.lease_until IS NULL OR s.lease_until<=now())
         AND (SELECT count(*) FROM pe_sessions active WHERE active.user_id=s.user_id AND active.lease_until>clock_timestamp())<$1
         AND NOT EXISTS (SELECT 1 FROM pe_operations earlier WHERE earlier.session_id=s.id
           AND earlier.state IN ('queued','running') AND (earlier.created_at,earlier.id)<(o.created_at,o.id))
         ORDER BY u.last_claim_at NULLS FIRST,o.created_at,o.id LIMIT 1 FOR NO KEY UPDATE OF u SKIP LOCKED`, [this.limits.maxActivePerUser],
      )
      const row = candidate.rows[0]
      if (!row) return null
      // Serialize a user's capacity check across otherwise independent Session rows.
      await requireActiveAccount(client, executionUserId.parse(row.user_id), 'update')
      const resource = await client.query(`SELECT o.id FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
        WHERE o.id=$1 AND s.user_id=$2 AND o.state IN ('queued','running')
        AND (s.lease_until IS NULL OR s.lease_until<=clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM pe_operations earlier WHERE earlier.session_id=s.id
          AND earlier.state IN ('queued','running') AND (earlier.created_at,earlier.id)<(o.created_at,o.id))
        FOR UPDATE OF s,o`, [row.id, row.user_id])
      if (!resource.rowCount) return null
      const active = await client.query<{ count: string }>(
        'SELECT count(*) FROM pe_sessions WHERE user_id=$1 AND lease_until>clock_timestamp()', [row.user_id],
      )
      if (Number(active.rows[0]!.count) >= this.limits.maxActivePerUser) return null
      await client.query('UPDATE pe_users SET last_claim_at=clock_timestamp() WHERE id=$1', [row.user_id])
      const token = randomBytes(32).toString('base64url')
      const updated = await client.query<{ lease_epoch: number }>(
        `UPDATE pe_sessions SET lease_epoch=lease_epoch+1,grant_digest=$2,
         lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE id=$1 RETURNING lease_epoch`,
        [row.session_id, digest(token), this.limits.leaseMs],
      )
      const epoch = updated.rows[0]!.lease_epoch
      await client.query('UPDATE pe_operations SET state=\'running\',attempts=attempts+1 WHERE id=$1', [row.id])
      await client.query('INSERT INTO pe_attempts(operation_id,epoch,worker_id) VALUES($1,$2,$3)', [row.id, epoch, workerId])
      return grant.parse({
        operationId: row.id, sessionId: row.session_id, userId: row.user_id, requestId: row.request_id,
        text: row.source === 'user' ? row.input : continuationInput(row.input, this.limits.maxEventBytes),
        settings: settings.parse(row.settings), selection: z.array(skillSelection).max(256).parse(row.skill_selection),
        mcpConnections: z.array(mcpSelection).max(1).parse(row.mcp_selection),
        remoteMcpTools: mcpOperationTools.parse(row.remote_mcp_selection),
        stdioMcpConnections: z.array(stdioMcpSelection).max(1).parse(row.stdio_mcp_selection),
        sshConnections: z.array(sshSelection).max(8).parse(row.ssh_selection),
        source: row.source, sourceActionId: row.source_action_id,
        sourceExecutionId: row.source_execution_id, sourceDesktopExecutionId: row.source_desktop_execution_id,
        sourceStdioMcpCallId: row.source_stdio_mcp_call_id,
        sourceSshExecuteActionId: row.source_ssh_execute_action_id,
        sourceMcpActionId: row.source_mcp_action_id,
        target: executionTarget.parse(row.execution_target), executionEnabled: this.limits.executionEnabled ?? false,
        token, epoch,
      })
    })
  }

  /** Lock the grant owner before the Session, then recheck expiry against the current PG clock.
   * @param client Caller transaction; acquire this authority before resource locks.
   * @param token Current Session execution grant, independent of browser credential rotation.
   * @returns Current owned Session and operation; required password change does not revoke this grant.
   */
  async authorized(client: PoolClient, token: string): Promise<SessionRow & { operation_id: string; settings: unknown; execution_target: unknown }> {
    const owner = await client.query<{ user_id: string }>('SELECT user_id FROM pe_sessions WHERE grant_digest=$1', [digest(token)])
    if (!owner.rows[0]) throw new PlatformError(409, 'lease_lost')
    await requireActiveAccount(client, executionUserId.parse(owner.rows[0].user_id), 'update')
    const result = await client.query<SessionRow & { operation_id: string; settings: unknown; execution_target: unknown }>(
      `SELECT s.*,o.id AS operation_id,o.settings,o.execution_target FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
       WHERE s.grant_digest=$1 AND s.lease_until>clock_timestamp() AND o.state='running' FOR UPDATE OF s`, [digest(token)],
    )
    const row = result.rows[0]
    if (!row) throw new PlatformError(409, 'lease_lost')
    // PG can test WHERE before a row lock wait without rechecking an unchanged tuple afterward.
    const live = await client.query(`SELECT id FROM pe_sessions WHERE id=$1
      AND grant_digest=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()`,
      [row.id, digest(token), row.lease_epoch])
    if (!live.rowCount) throw new PlatformError(409, 'lease_lost')
    return row
  }

  /** Renew only a grant still live at the lease update, after any authorization lock waits.
   * @param token Current execution grant, independent of browser credential rotation.
   * @returns Cancellation status after extending the live lease from the current PG clock.
   */
  async renew(token: string): Promise<{ cancelRequested: boolean }> {
    return transaction(this.pool, async client => {
      const row = await this.authorized(client, token)
      const renewed = await client.query(`UPDATE pe_sessions
        SET lease_until=clock_timestamp()+$2::double precision*interval '1 millisecond'
        WHERE id=$1 AND grant_digest=$3 AND lease_epoch=$4 AND lease_until>clock_timestamp() RETURNING id`,
        [row.id, this.limits.leaseMs, digest(token), row.lease_epoch])
      if (!renewed.rowCount) throw new PlatformError(409, 'lease_lost')
      const operation = await client.query<{ error_code: string | null }>(
        'SELECT error_code FROM pe_operations WHERE id=$1', [row.operation_id],
      )
      return { cancelRequested: operation.rows[0]?.error_code === 'cancel_requested' }
    })
  }

  /** Read the operation's accepted skill metadata under its current lease.
   * @param token - current operation grant, never a user-supplied identity.
   * @returns owner, validated execution target and immutable skill selection for a bounded instruction read.
   */
  async selectedSkills(token: string): Promise<{ userId: string; target: ExecutionTarget; selection: z.infer<typeof skillSelection>[] }> {
    return transaction(this.pool, async client => {
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
   * @param token Current execution grant for the Operation being settled.
   * @param outcome Terminal state observed by the Host.
   * @param errorCode Host failure code, or null; an aborted cancellation is recorded as turn_user.
   */
  async finish(token: string, outcome: 'completed' | 'failed', errorCode: string | null): Promise<void> {
    await transaction(this.pool, async client => {
      const row = await this.authorized(client, token)
      const operation = await client.query<{ error_code: string | null }>(
        'SELECT error_code FROM pe_operations WHERE id=$1', [row.operation_id],
      )
      // The native turn can finish while its cancellation request is in flight.
      // A completed durable turn remains completed; cancellation only settles
      // work that the Host actually stopped.
      const cancelled = errorCode === 'turn_aborted' && operation.rows[0]?.error_code === 'cancel_requested'
      await client.query('UPDATE pe_operations SET state=$2,error_code=$3,completed_at=now() WHERE id=$1',
        [row.operation_id, outcome, cancelled ? 'turn_user' : errorCode])
      await client.query('UPDATE pe_attempts SET ended_at=now() WHERE operation_id=$1 AND epoch=$2',
        [row.operation_id, row.lease_epoch])
      await client.query('UPDATE pe_sessions SET grant_digest=NULL,lease_until=NULL,updated_at=now() WHERE id=$1', [row.id])
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
