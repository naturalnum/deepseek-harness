/** Durable cloud execution admission and reconciliation through Agent Sandbox. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ExecutionResolutionInspection, ExecutionResolutionReceipt, ExecutionResolutionRequest, ExecutionResolutionsList,
  ExecutionResolutionsListRequest, ExecutionResolutionStatus, ResolutionExecutionId, ResolutionRequestId } from '@power-evolve/contracts/execution-resolution'
import { CloudExecutionResolutionService } from './cloud-execution-resolution.ts'
import { cloudRunnerResult as runnerResult, cloudRequestDigest as digest, capturedRunnerRequest, nativeCloudEnvironment,
  type CloudExecutionRow as ExecutionRow, type CloudExecutionState as State } from './cloud-execution-resolution-types.ts'
import { executionTarget, PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import { lockAccountAuthorities, requireActiveAccount } from './account-authority.ts'
import { userId as executionUserId } from '../contracts.ts'
import { KubernetesError } from './kubernetes.ts'
import { MountSlotBlocked, SandboxManager, type SandboxReady, type CloudResolutionTarget } from './sandbox.ts'
import { storageBinding } from './cloud-storage-types.ts'
import type { TaskStore } from './tasks.ts'
import { isSessionBusinessBlockedInTransaction } from './native-workspace-layout.ts'
import { isSessionOperationStoppedInTransaction, requireActivityRow,
  requestCloudCommandStopInTransaction } from './native-session-activity-stop.ts'
import { digest as grantDigest } from './identity.ts'
import { cloudShellProposeRequest, cloudShellObservation, cloudShellResult,
  type CloudShellObservation } from '../cloud-shell-contracts.ts'

class ExecutionLeaseLost extends Error {}

const nativeStopTarget = z.object({ userId: z.uuid(), sessionId: z.uuid(), workspaceId: z.uuid(),
  generation: z.string().regex(/^[1-9][0-9]*$/u), name: z.string().min(1), podUid: z.uuid(),
  runnerInstanceId: z.uuid(), binding: storageBinding }).strict()

/** A platform worker is the only caller allowed to create a Sandbox or dispatch commands. */
export class ExecutionService {
  private readonly stop = new AbortController()
  private readonly workerId = randomUUID()
  private readonly active = new Set<Promise<void>>()
  private readonly activeIds = new Set<string>()
  private polling: Promise<void> | undefined
  private readonly resolutions: CloudExecutionResolutionService

  constructor(private readonly tasks: TaskStore, private readonly sandboxes: SandboxManager,
    private readonly concurrency: number, private readonly pollMs: number,
    private readonly idleMs: number, private readonly commandTimeoutMs: number,
    private readonly leaseMs = 90_000) {
    this.resolutions = new CloudExecutionResolutionService(tasks.pool, sandboxes,
      (client, row) => this.enqueueContinuation(client, row), commandTimeoutMs, leaseMs, pollMs)
  }
  /** PostgreSQL pool shared with the durable task store. */
  get pool(): Pool { return this.tasks.pool }

  /**
   * Read this owner's bounded Cloud execution-resolution list.
   * @param user Authenticated owner.
   * @param request Optional owned Session filter.
   * @returns Recent Cloud executions and their resolution receipts.
   */
  listResolutions(user: Identity, request: ExecutionResolutionsListRequest): Promise<ExecutionResolutionsList> {
    return this.resolutions.list(user, request)
  }
  /**
   * Inspect a captured uncertain execution without creating or dispatching an executor.
   * @param user Authenticated owner.
   * @param executionId Original execution identifier.
   * @returns Frozen approval identity and advisory Runner observation.
   */
  inspectResolution(user: Identity, executionId: ResolutionExecutionId): Promise<ExecutionResolutionInspection> {
    return this.resolutions.inspect(user, executionId)
  }
  /**
   * Accept one stop-and-reconcile intent under an independently issued approval credential.
   * @param user Authenticated owner, rechecked in the admission transaction.
   * @param request Stable request and inspected fingerprint.
   * @param approvalToken Raw approval bearer, never accepted from an Agent grant.
   * @returns Immutable resolution receipt.
   */
  resolveUncertain(user: Identity, request: ExecutionResolutionRequest, approvalToken: string): Promise<ExecutionResolutionReceipt> {
    return this.resolutions.resolve(user, request, approvalToken)
  }
  /**
   * Read this owner's persisted resolution status.
   * @param user Authenticated owner.
   * @param requestId Original request identifier.
   * @returns Owner receipt or null when no such owner request exists.
   */
  resolutionStatus(user: Identity, requestId: ResolutionRequestId): Promise<ExecutionResolutionStatus> {
    return this.resolutions.status(user, requestId)
  }

  /**
   * Persist one tool request before returning an accepted receipt to the Agent.
   * @param token Current operation grant.
   * @param callId Stable tool call identifier for retries.
   * @param command Shell command accepted for cloud execution.
   * @param cwd Workspace-relative working directory.
   * @returns Persisted execution receipt.
   */
  async propose(token: string, callId: string, command: string, cwd: string): Promise<unknown> {
    const request = { command, cwd, timeoutMs: this.commandTimeoutMs }
    return transaction(this.pool, async (client) => {
      const grant = await this.tasks.authorized(client, token)
      executionTarget.parse(grant.execution_target)
      const prior = await client.query<ExecutionRow>(
        "SELECT * FROM pe_cloud_executions WHERE execution_kind='legacy_command' AND operation_id=$1 AND call_id=$2", [grant.operation_id, callId])
      if (prior.rows[0]) {
        if (prior.rows[0].result_delivery === 'native_tool' || prior.rows[0].request_digest !== digest(request)) {
          throw new PlatformError(409, 'request_id_conflict')
        }
        return this.receipt(prior.rows[0])
      }
      if (await isSessionBusinessBlockedInTransaction(client, grant.user_id, grant.id)) {
        throw new PlatformError(409, 'native_session_archived')
      }
      const active = await client.query(
        `SELECT id FROM pe_cloud_executions WHERE session_id=$1
         AND state IN ('queued','starting','running','cancelling','uncertain')`, [grant.id])
      if (active.rowCount) throw new PlatformError(409, 'execution_busy')
      const instance = await client.query<{ state: string }>(
        'SELECT state FROM pe_sandbox_instances WHERE session_id=$1', [grant.id])
      if (instance.rows[0] && ['unknown', 'deleting'].includes(instance.rows[0].state)) {
        throw new PlatformError(409, 'sandbox_stop_unconfirmed')
      }
      const inserted = await client.query<ExecutionRow>(
        `INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,execution_kind,state,
          result_delivery,requested_timeout_ms,command_timeout_ms)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'legacy_command','queued','continuation',$9,$9) RETURNING *`,
        [randomUUID(), grant.user_id, grant.id, grant.operation_id, callId, command, cwd, digest(request), this.commandTimeoutMs])
      await client.query('SELECT pg_notify(\'pe_executions\',$1)', [grant.id])
      return this.receipt(requireActivityRow(inserted.rows))
    })
  }

  /** Persist a native foreground request or re-read the original receipt after transport loss.
   * @param token Current grant for admission; its captured original value can only re-read/stop an existing request after expiry.
   * @param input Native tool call identity, command, directory, timeout and optional cancellation intent.
   * @returns The original observation; replay never starts a second command or changes its timeout.
   */
  async proposeShell(token: string, input: z.infer<typeof cloudShellProposeRequest>): Promise<CloudShellObservation> {
    const request = cloudShellProposeRequest.parse(input), hashed = grantDigest(token)
    return transaction(this.pool, async (client) => {
      const captured = await client.query<ExecutionRow>(`SELECT e.* FROM pe_cloud_executions e
        JOIN pe_sessions s ON s.id=e.session_id AND s.user_id=e.user_id
        JOIN pe_operations o ON o.id=e.operation_id AND o.session_id=s.id
        WHERE e.execution_kind='legacy_command' AND e.result_delivery='native_tool'
          AND e.native_tool_grant_digest=$1 AND e.call_id=$2`, [hashed, request.callId])
      const original = captured.rows[0]
      if (original) {
        const read = await this.shellControl(client, token, original.id)
        this.sameShellRequest(read.row, request)
        const row = request.cancelRequested ? await this.requestShellStop(client, read.row, request.cancelCause ?? 'abort') : read.row
        return this.shellReceipt(row, read.outputAllowed)
      }
      // New writes always require the current native execution frame, not just a retained token.
      const grant = await this.tasks.executionAuthorized(client, token)
      executionTarget.parse(grant.execution_target)
      const prior = await client.query<ExecutionRow>(
        'SELECT * FROM pe_cloud_executions WHERE operation_id=$1 AND call_id=$2 FOR UPDATE', [grant.operation_id, request.callId])
      if (prior.rows[0]) {
        this.sameShellRequest(prior.rows[0], request)
        const read = await this.shellControl(client, token, prior.rows[0].id)
        const row = request.cancelRequested ? await this.requestShellStop(client, read.row, request.cancelCause ?? 'abort') : read.row
        return this.shellReceipt(row, read.outputAllowed)
      }
      if (await isSessionBusinessBlockedInTransaction(client, grant.user_id, grant.id)) {
        throw new PlatformError(409, 'native_session_archived')
      }
      const active = await client.query(`SELECT id FROM pe_cloud_executions WHERE session_id=$1
        AND state IN ('queued','starting','running','cancelling','uncertain')`, [grant.id])
      if (active.rowCount) throw new PlatformError(409, 'execution_busy')
      const instance = await client.query<{ state: string }>('SELECT state FROM pe_sandbox_instances WHERE session_id=$1', [grant.id])
      if (instance.rows[0] && ['unknown', 'deleting'].includes(instance.rows[0].state)) {
        throw new PlatformError(409, 'sandbox_stop_unconfirmed')
      }
      const timeoutMs = Math.min(request.timeoutMs, this.commandTimeoutMs, 300_000)
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new PlatformError(503, 'native_shell_timeout_invalid')
      const authority = requireActivityRow(await lockAccountAuthorities(client, [executionUserId.parse(grant.user_id)], 'update'))
      const admission = { command: request.command, cwd: request.cwd, timeoutMs, outputMode: 'tail',
        dshEnv: nativeCloudEnvironment(grant.id) }
      const inserted = await client.query<ExecutionRow>(`INSERT INTO pe_cloud_executions
        (id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,execution_kind,state,result_delivery,
          requested_timeout_ms,command_timeout_ms,native_tool_grant_digest,native_tool_credential_version,cancel_requested,native_tool_cancel_cause)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'legacy_command','queued','native_tool',$9,$10,$11,$12,$13,$14) RETURNING *`,
      [randomUUID(), grant.user_id, grant.id, grant.operation_id, request.callId, request.command, request.cwd,
        digest(admission), request.timeoutMs, timeoutMs, hashed, authority.credentialVersion, request.cancelRequested ?? false,
        request.cancelRequested ? request.cancelCause ?? 'abort' : null])
      await client.query("SELECT pg_notify('pe_executions',$1)", [grant.id])
      return this.shellReceipt(requireActivityRow(inserted.rows))
    })
  }

  /** Read only the original execution bound to this live or retained grant.
   * @param token Original token retained for metadata after expiry, or the current grant for the same operation.
   * @param executionId Exact native execution identity.
   * @returns Persisted bounded terminal output only while its owner authority still permits reads.
   */
  statusShell(token: string, executionId: string): Promise<CloudShellObservation> {
    return transaction(this.pool, async (client) => {
      const current = await this.shellControl(client, token, executionId)
      return this.shellReceipt(current.row, current.outputAllowed)
    })
  }

  /** Request exact cleanup without treating its acceptance as a stopped process.
   * @param token Captured original grant; account disable/expiry cannot revoke its cleanup-only capability.
   * @param executionId The original execution, never an arbitrary owner execution.
   * @param cause Original timeout or caller abort; retries preserve the first stored cause.
   * @returns Current observation; the worker still owns stop proof and terminal publication.
   */
  cancelShell(token: string, executionId: string, cause: 'timeout' | 'abort'): Promise<CloudShellObservation> {
    return transaction(this.pool, async (client) => {
      const current = await this.shellControl(client, token, executionId)
      const row = await this.requestShellStop(client, current.row, cause)
      await client.query("SELECT pg_notify('pe_executions',$1)", [current.row.session_id])
      return this.shellReceipt(row, current.outputAllowed)
    })
  }

  private async requestShellStop(client: PoolClient, row: ExecutionRow, cause: 'timeout' | 'abort'): Promise<ExecutionRow> {
    const updated = await client.query<ExecutionRow>(`UPDATE pe_cloud_executions SET cancel_requested=true,
      native_tool_cancel_cause=COALESCE(native_tool_cancel_cause,$2),updated_at=clock_timestamp()
      WHERE id=$1 AND execution_kind='legacy_command' AND result_delivery='native_tool'
        AND state IN ('queued','starting','running','cancelling','uncertain') RETURNING *`, [row.id, cause])
    return updated.rows[0] ?? row
  }

  private sameShellRequest(row: ExecutionRow, request: z.infer<typeof cloudShellProposeRequest>): void {
    const expected = { command: request.command, cwd: request.cwd,
      timeoutMs: row.command_timeout_ms, outputMode: 'tail', dshEnv: nativeCloudEnvironment(row.session_id) }
    if (row.result_delivery !== 'native_tool' || row.command !== request.command || row.cwd !== request.cwd
      || row.requested_timeout_ms !== request.timeoutMs || row.request_digest !== digest(expected)) {
      throw new PlatformError(409, 'request_id_conflict')
    }
  }

  private shellReceipt(row: ExecutionRow, outputAllowed = true): CloudShellObservation {
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(row.state)
    return cloudShellObservation.parse({ executionId: row.id, state: row.state, command: row.command, cwd: row.cwd,
      timeoutMs: row.command_timeout_ms,
      result: outputAllowed && terminal && row.result !== null ? cloudShellResult.parse(row.result) : null,
      errorCode: outputAllowed ? row.error_code : 'native_shell_output_revoked', cancelCause: row.native_tool_cancel_cause ?? null })
  }

  private async shellControl(client: PoolClient, token: string, executionId: string): Promise<{
    row: ExecutionRow
    outputAllowed: boolean
  }> {
    const hashed = grantDigest(token)
    const hint = await client.query<{ user_id: string }>(`SELECT e.user_id FROM pe_cloud_executions e
      JOIN pe_sessions s ON s.id=e.session_id AND s.user_id=e.user_id
      JOIN pe_operations o ON o.id=e.operation_id AND o.session_id=s.id
      WHERE e.id=$1 AND e.execution_kind='legacy_command' AND e.result_delivery='native_tool'
        AND (e.native_tool_grant_digest=$2 OR s.grant_digest=$2)`, [executionId, hashed])
    if (!hint.rows[0]) throw new PlatformError(404, 'execution_not_found')
    const authority = requireActivityRow(await lockAccountAuthorities(client, [executionUserId.parse(hint.rows[0].user_id)], 'update'))
    const found = await client.query<ExecutionRow>(`SELECT e.* FROM pe_cloud_executions e
      JOIN pe_sessions s ON s.id=e.session_id AND s.user_id=e.user_id
      JOIN pe_operations o ON o.id=e.operation_id AND o.session_id=s.id
      WHERE e.id=$1 AND e.execution_kind='legacy_command' AND e.result_delivery='native_tool'
        AND (e.native_tool_grant_digest=$2 OR s.grant_digest=$2) FOR UPDATE OF e`, [executionId, hashed])
    const row = found.rows[0]
    if (!row) throw new PlatformError(404, 'execution_not_found')
    if (row.native_tool_grant_digest !== hashed) {
      const current = await this.tasks.authorized(client, token)
      if (current.user_id !== row.user_id || current.id !== row.session_id || current.operation_id !== row.operation_id) {
        throw new PlatformError(404, 'execution_not_found')
      }
    }
    const outputAllowed = authority.enabled && authority.deletedAt === null
      && authority.credentialVersion === row.native_tool_credential_version && row.error_code !== 'account_disabled'
      && !await isSessionBusinessBlockedInTransaction(client, row.user_id, row.session_id)
      && !await isSessionOperationStoppedInTransaction(client,
        { userId: row.user_id, sessionId: row.session_id, operationId: row.operation_id })
    return { row, outputAllowed }
  }

  private receipt(row: ExecutionRow): unknown {
    return { executionId: row.id, state: row.state, command: row.command, cwd: row.cwd,
      result: row.result, errorCode: row.error_code }
  }

  /**
   * Read the owner's recent executions.
   * @param user Authenticated execution owner.
   * @returns Receipts ordered from newest to oldest.
   */
  async list(user: Identity): Promise<unknown> {
    const result = await this.pool.query<ExecutionRow>(
      "SELECT * FROM pe_cloud_executions WHERE execution_kind='legacy_command' AND user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100", [user.userId])
    return { items: result.rows.map(row => ({ ...this.receipt(row) as object, createdAt: row.created_at.toISOString() })) }
  }

  /**
   * Persist cancellation; terminal state waits for the runner or Pod to stop.
   * @param user Authenticated execution owner.
   * @param executionId Execution to cancel.
   * @returns Current receipt with the durable cancellation request.
   */
  async cancel(user: Identity, executionId: string): Promise<unknown> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<ExecutionRow>(
        "SELECT * FROM pe_cloud_executions WHERE execution_kind='legacy_command' AND id=$1 AND user_id=$2 FOR UPDATE", [executionId, user.userId])
      const row = result.rows[0]
      if (!row) throw new PlatformError(404, 'execution_not_found')
      if (!['succeeded', 'failed', 'cancelled', 'closed_unknown'].includes(row.state)) {
        await requestCloudCommandStopInTransaction(client, row.id)
      }
      return this.receipt(row)
    })
  }

  /** Start the execution admission and reconciliation worker. */
  start(): void { this.polling = this.poll() }
  /** Stop polling and wait for active reconciliation attempts to finish. */
  async close(): Promise<void> { this.stop.abort(); await this.polling; await Promise.allSettled(this.active) }

  private stopped(): boolean { return this.stop.signal.aborted }

  private async poll(): Promise<void> {
    while (!this.stopped()) {
      try {
        if (this.active.size < this.concurrency) {
          await this.resolutions.poll(this.stop.signal)
          if (this.stopped()) break
          const action = await this.claim()
          if (action) {
            this.activeIds.add(action.id)
            const running = this.processLeased(action).catch((_unavailable: unknown) => {
              // The row remains leased for a later reconciliation pass.
            }).finally(() => { this.active.delete(running); this.activeIds.delete(action.id) })
            this.active.add(running)
            continue
          }
          await this.recycleIdle()
        }
      } catch (_error) { /* Persisted rows are retried after service or Kubernetes recovery. */ }
      try { await delay(this.pollMs, undefined, { signal: this.stop.signal }) }
      catch (_aborted) { /* Shutdown ends the loop. */ }
    }
  }

  private async claim(): Promise<ExecutionRow | null> {
    return transaction(this.pool, async (client) => {
      // Serialize claims across Platform replicas before counting live worker leases.
      await client.query('SELECT pg_advisory_xact_lock(72819532)')
      // Foreground processes belong to their original operation generation. Receipt-style
      // executions retain their independent continuation/reconciliation lifetime.
      await client.query(`UPDATE pe_cloud_executions e SET cancel_requested=true,updated_at=clock_timestamp()
        WHERE e.result_delivery='native_tool' AND e.state IN ('queued','starting','running','cancelling','uncertain')
          AND NOT e.cancel_requested AND NOT EXISTS (
            SELECT 1 FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
              JOIN pe_users u ON u.id=s.user_id
            WHERE o.id=e.operation_id AND s.id=e.session_id AND s.user_id=e.user_id
              AND o.state='running' AND s.grant_digest=e.native_tool_grant_digest
              AND s.lease_until>clock_timestamp() AND u.enabled AND u.deleted_at IS NULL
              AND u.credential_version=e.native_tool_credential_version)`)
      const leased = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM pe_cloud_executions
         WHERE lease_owner IS NOT NULL AND lease_until>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id)
           AND state IN ('queued','starting','running','cancelling','uncertain')`)
      if (requireActivityRow(leased.rows).count >= this.concurrency) return null
      const found = await client.query<ExecutionRow>(
        `SELECT * FROM pe_cloud_executions WHERE execution_kind='legacy_command' AND state IN ('queued','starting','running','cancelling','uncertain')
         AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id)
         AND NOT (id = ANY($1::uuid[])) AND (lease_until IS NULL OR lease_until<=clock_timestamp())
         ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [[...this.activeIds]])
      const row = found.rows[0]
      if (!row) return null
      const updated = await client.query<ExecutionRow>(
        `UPDATE pe_cloud_executions SET state=CASE WHEN state='queued' THEN 'starting' ELSE state END,
         lease_owner=$2,lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',
         attempts=attempts+1,updated_at=now()
         WHERE execution_kind='legacy_command' AND id=$1 RETURNING *`, [row.id, this.workerId, this.leaseMs])
      return requireActivityRow(updated.rows)
    })
  }

  private async processLeased(row: ExecutionRow): Promise<void> {
    const done = new AbortController()
    let lost = false
    const renew = (async () => {
      while (!done.signal.aborted) {
        try { await delay(Math.max(100, Math.floor(this.leaseMs / 3)), undefined, { signal: done.signal }) }
        catch (_aborted) { return }
        try {
          const renewed = await transaction(this.pool, async (client) => {
            // An expired lease cannot regain a slot while another replica claims it.
            await client.query('SELECT pg_advisory_xact_lock(72819532)')
            const updated = await client.query(
              `UPDATE pe_cloud_executions SET lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond'
               WHERE execution_kind='legacy_command' AND id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp()
                 AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id)
                 AND state IN ('starting','running','cancelling','uncertain') RETURNING id`,
              [row.id, this.workerId, this.leaseMs])
            return !!updated.rowCount
          })
          if (!renewed) { lost = true; return }
        } catch (_databaseUnavailable) { lost = true; return }
      }
    })()
    const assertLease = async () => {
      if (lost) throw new ExecutionLeaseLost()
      const current = await this.pool.query(
        `SELECT id FROM pe_cloud_executions WHERE execution_kind='legacy_command' AND id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id)`,
        [row.id, this.workerId])
      if (!current.rowCount) throw new ExecutionLeaseLost()
    }
    try { await this.process(row, assertLease) }
    finally { done.abort(); await renew }
  }

  private async currentCancel(row: ExecutionRow): Promise<boolean> {
    const result = await this.pool.query<{ cancel_requested: boolean }>(
      "SELECT cancel_requested FROM pe_cloud_executions WHERE execution_kind='legacy_command' AND id=$1", [row.id])
    return result.rows[0]?.cancel_requested ?? true
  }

  private async process(row: ExecutionRow, assertLease: () => Promise<void>): Promise<void> {
    try {
      await assertLease()
      if (row.result_delivery === 'native_tool' && row.native_tool_stop_target !== null
        && row.native_tool_stop_target !== undefined) {
        await this.stopNativeTool(row, assertLease); return
      }
      if (await this.currentCancel(row) && !row.sandbox_name) {
        await this.sandboxes.cancelCreation(row.id, row.session_id, row.user_id, this.workerId, assertLease)
        await this.settle(row, 'cancelled', null, null); return
      }
      await assertLease()
      const sandbox = row.runner_instance_id && row.pod_uid
        ? await this.sandboxes.observeReady(row.session_id, row.user_id, row.pod_uid, row.runner_instance_id)
        : await this.sandboxes.ensureReady(row.session_id, row.user_id, assertLease)
      await assertLease()
      if (row.runner_instance_id
        && (row.runner_instance_id !== sandbox.runnerInstanceId || row.pod_uid !== sandbox.podUid)) {
        await this.sandboxes.quarantine(row.session_id, row.user_id)
        await this.defer(row, 'uncertain', 'sandbox_instance_changed'); return
      }
      // No command can reach a Runner before this first durable identity capture.
      const recorded = await this.pool.query<{ state: State }>(
        `UPDATE pe_cloud_executions SET sandbox_name=$3,pod_uid=$4,runner_instance_id=$5,
         state=CASE WHEN state='uncertain' THEN 'starting' ELSE state END
         WHERE execution_kind='legacy_command' AND id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id) AND runner_instance_id IS NULL RETURNING state`,
        [row.id, this.workerId, sandbox.name, sandbox.podUid, sandbox.runnerInstanceId])
      if (!recorded.rowCount && !row.runner_instance_id) throw new ExecutionLeaseLost()
      if (recorded.rowCount) row = { ...row, state: requireActivityRow(recorded.rows).state,
        sandbox_name: sandbox.name, pod_uid: sandbox.podUid, runner_instance_id: sandbox.runnerInstanceId }
      const cancelled = await this.currentCancel(row)
      if (cancelled && row.state === 'starting') {
        if (row.result_delivery === 'native_tool') await this.stopNativeTool(row, assertLease)
        else await this.settle(row, 'cancelled', null, null)
        return
      }
      await this.observe(row, sandbox, cancelled, assertLease)
    } catch (error) {
      if (error instanceof ExecutionLeaseLost) return
      if (row.result_delivery === 'native_tool' && await this.currentCancel(row)
        && row.sandbox_name && row.pod_uid && row.runner_instance_id) {
        try { await this.stopNativeTool(row, assertLease) }
        catch (stopError) {
          if (!(stopError instanceof ExecutionLeaseLost)) await this.defer(row, 'uncertain', 'native_tool_stop_unconfirmed')
        }
        return
      }
      if (error instanceof MountSlotBlocked) {
        await this.defer(row, error.retryable ? 'starting' : 'uncertain', error.code); return
      }
      const recorded = await this.pool.query<{ runner_instance_id: string | null }>(
        "SELECT runner_instance_id FROM pe_cloud_executions WHERE execution_kind='legacy_command' AND id=$1", [row.id])
      if (!recorded.rows[0]?.runner_instance_id) {
        // A timed-out Kubernetes creation may still have mounted the writable Home.
        await this.defer(row, 'uncertain', 'sandbox_creation_unconfirmed')
      } else if (error instanceof KubernetesError && error.status === 400 && row.result_delivery !== 'native_tool') {
        await this.settle(row, 'failed', null, 'runner_rejected_request')
      } else if (error instanceof KubernetesError && error.status === 409) {
        await this.defer(row, 'uncertain', 'sandbox_conflict')
      } else {
        await this.defer(row, 'uncertain', 'sandbox_or_runner_unavailable')
      }
    }
  }

  private async observe(row: ExecutionRow, sandbox: SandboxReady, cancelled: boolean,
    assertLease: () => Promise<void>): Promise<void> {
    const request = capturedRunnerRequest(row, this.commandTimeoutMs)
    if (!request) { await this.defer(row, 'uncertain', 'runner_request_unverifiable'); return }
    const path = `/executions/${row.id}`
    let status: z.infer<typeof runnerResult> | null = null
    await assertLease()
    await this.sandboxes.assertCurrent(sandbox)
    try { status = runnerResult.parse(await this.sandboxes.runner(sandbox.name, sandbox.token, 'GET', path)) }
    catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
    if (!status && cancelled) {
      if (row.result_delivery === 'native_tool') await this.stopNativeTool(row, assertLease)
      else await this.settle(row, 'cancelled', null, null)
      return
    }
    if (!status) {
      if (row.state !== 'starting') {
        await this.defer(row, 'uncertain', 'runner_execution_missing'); return
      }
      await assertLease()
      await this.sandboxes.assertDispatchAllowed(sandbox)
      const permitted = await transaction(this.pool, async (client) => {
        if (row.result_delivery === 'native_tool') {
          const account = requireActivityRow(await lockAccountAuthorities(client, [executionUserId.parse(row.user_id)], 'update'))
          await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
            WHERE s.id=$1 AND s.user_id=$2 AND o.id=$3 FOR UPDATE OF s,o`, [row.session_id, row.user_id, row.operation_id])
          // Re-read the database clock after all account, Session and operation lock waits.
          const owner = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
            WHERE s.id=$1 AND s.user_id=$2 AND o.id=$3 AND o.state='running'
              AND s.grant_digest=$4 AND s.lease_until>clock_timestamp()`,
          [row.session_id, row.user_id, row.operation_id, row.native_tool_grant_digest])
          if (!account.enabled || account.deletedAt !== null || account.credentialVersion !== row.native_tool_credential_version
            || !owner.rowCount || await isSessionOperationStoppedInTransaction(client,
            { userId: row.user_id, sessionId: row.session_id, operationId: row.operation_id })) {
            await requestCloudCommandStopInTransaction(client, row.id)
            return false
          }
        } else await requireActiveAccount(client, executionUserId.parse(row.user_id), 'update')
        const issued = await client.query(`UPDATE pe_cloud_executions SET state='running',dispatch_request=$3,updated_at=now()
          WHERE execution_kind='legacy_command' AND id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id)
          AND state='starting' AND cancel_requested=false RETURNING id`, [row.id, this.workerId,JSON.stringify(request)])
        return !!issued.rowCount
      })
      if (!permitted) {
        if (row.result_delivery === 'native_tool') await this.stopNativeTool(row, assertLease)
        else await this.settle(row, 'cancelled', null, null)
        return
      }
      await assertLease()
      await this.sandboxes.assertDispatchAllowed(sandbox)
      status = runnerResult.parse(await this.sandboxes.runner(sandbox.name, sandbox.token, 'POST', '/executions', request))
    }
    if (status.id !== row.id || status.instanceId !== sandbox.runnerInstanceId || status.digest !== digest(request)) {
      await this.defer(row, 'uncertain', 'runner_identity_mismatch'); return
    }
    if (cancelled && status.state === 'running') {
      await assertLease()
      await this.sandboxes.assertCurrent(sandbox)
      let input: { cause?: 'timeout' | 'abort' } = {}
      if (row.result_delivery === 'native_tool') {
        const found = await this.pool.query<Pick<ExecutionRow, 'native_tool_cancel_cause'>>(`SELECT native_tool_cancel_cause
          FROM pe_cloud_executions WHERE id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp()`, [row.id, this.workerId])
        if (!found.rows[0]) throw new ExecutionLeaseLost()
        const cause = found.rows[0].native_tool_cancel_cause
        if (cause !== 'timeout' && cause !== 'abort') throw new PlatformError(503, 'native_tool_cancel_cause_missing')
        input = { cause }
      }
      status = runnerResult.parse(await this.sandboxes.runner(sandbox.name, sandbox.token, 'POST', `${path}/cancel`, input))
      if (status.id !== row.id || status.instanceId !== sandbox.runnerInstanceId || status.digest !== digest(request)) {
        await this.defer(row, 'uncertain', 'runner_identity_mismatch'); return
      }
    }
    if (status.state === 'running') {
      await this.defer(row, cancelled ? 'cancelling' : 'running', null)
      return
    }
    await assertLease()
    await this.settle(row, status.state, {
      exitCode: status.exitCode, stdout: status.stdout, stderr: status.stderr,
      stdoutTruncated: status.stdoutTruncated, stderrTruncated: status.stderrTruncated, timedOut: status.timedOut,
    }, null)
  }

  private async defer(row: ExecutionRow, state: State, errorCode: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE pe_cloud_executions SET state=$3,
       error_code=CASE WHEN error_code='account_disabled' THEN error_code ELSE $4 END,lease_owner=NULL,
       lease_until=now()+$5::double precision*interval '1 millisecond',updated_at=now()
       WHERE execution_kind='legacy_command' AND id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id)`, [row.id, this.workerId, state, errorCode, this.pollMs])
  }

  private async stopNativeTool(row: ExecutionRow, assertLease: () => Promise<void>): Promise<void> {
    await assertLease()
    const stopped = await transaction(this.pool, async (client) => {
      await lockAccountAuthorities(client, [executionUserId.parse(row.user_id)], 'update')
      const found = await client.query<ExecutionRow>(`SELECT * FROM pe_cloud_executions
        WHERE id=$1 AND execution_kind='legacy_command' AND result_delivery='native_tool'
          AND lease_owner=$2 AND lease_until>clock_timestamp() AND cancel_requested FOR UPDATE`, [row.id, this.workerId])
      const current = found.rows[0]
      if (!current) throw new ExecutionLeaseLost()
      if (current.native_tool_stop_target !== null && current.native_tool_stop_target !== undefined) {
        if (!current.native_tool_stop_request_id) throw new PlatformError(503, 'native_tool_stop_identity_invalid')
        return { target: nativeStopTarget.parse(current.native_tool_stop_target), requestId: current.native_tool_stop_request_id }
      }
      const target = await this.sandboxes.captureExecutionResolution(client, { userId: current.user_id,
        sessionId: current.session_id, name: current.sandbox_name, podUid: current.pod_uid,
        runnerInstanceId: current.runner_instance_id })
      const requestId = randomUUID()
      await client.query(`UPDATE pe_cloud_executions SET native_tool_stop_request_id=$3,native_tool_stop_target=$4,
        updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2`, [row.id, this.workerId, requestId, target])
      return { target, requestId }
    })
    const target: CloudResolutionTarget = stopped.target
    if (target.userId !== row.user_id || target.sessionId !== row.session_id || target.name !== row.sandbox_name
      || target.podUid !== row.pod_uid || target.runnerInstanceId !== row.runner_instance_id) {
      throw new PlatformError(503, 'native_tool_stop_identity_invalid')
    }
    const guard = async (client?: PoolClient) => {
      const found = await (client ?? this.pool).query(`SELECT id FROM pe_cloud_executions
        WHERE id=$1 AND result_delivery='native_tool' AND user_id=$2 AND session_id=$3
          AND lease_owner=$4 AND lease_until>clock_timestamp() AND native_tool_stop_request_id=$5
          AND native_tool_stop_target=$6::jsonb AND cancel_requested
          AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id)`,
      [row.id, row.user_id, row.session_id, this.workerId, stopped.requestId, target])
      if (!found.rowCount) throw new ExecutionLeaseLost()
    }
    await this.sandboxes.stopForExecutionResolution(target, stopped.requestId, guard, async (client) => {
      await guard(client)
      const finished = await client.query(`UPDATE pe_cloud_executions SET state='closed_unknown',result=NULL,
        error_code=CASE WHEN error_code='account_disabled' THEN error_code ELSE 'native_tool_outcome_unknown' END,
        lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp() AND native_tool_stop_request_id=$3
          AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id) RETURNING id`,
      [row.id, this.workerId, stopped.requestId])
      if (!finished.rowCount) throw new ExecutionLeaseLost()
      // stopForExecutionResolution commits this terminal fact with exact dual stop
      // evidence and mount release. An unavailable outcome never becomes success.
    })
  }

  private async settle(row: ExecutionRow, state: State, result: unknown, errorCode: string | null): Promise<void> {
    await transaction(this.pool, async (client) => {
      await lockAccountAuthorities(client, [executionUserId.parse(row.user_id)], 'update')
      const updated = await client.query<ExecutionRow>(
        `UPDATE pe_cloud_executions SET state=$3,result=$4,
         error_code=CASE WHEN error_code='account_disabled' THEN error_code ELSE $5 END,lease_owner=NULL,lease_until=NULL,
         updated_at=now() WHERE execution_kind='legacy_command' AND id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id) RETURNING *`,
        [row.id, this.workerId, state, result === null ? null : JSON.stringify(result), errorCode])
      const final = updated.rows[0]
      if (!final || state === 'uncertain') return
      await client.query('UPDATE pe_sandbox_instances SET last_used_at=now(),updated_at=now() WHERE session_id=$1',
        [row.session_id])
      await this.enqueueContinuation(client, final)
    })
  }

  private async enqueueContinuation(client: PoolClient, row: ExecutionRow): Promise<boolean> {
    if (row.result_delivery === 'native_tool') return false
    const authority = requireActivityRow(await lockAccountAuthorities(client, [executionUserId.parse(row.user_id)], 'update'))
    if (row.error_code === 'account_disabled' || !authority.enabled || authority.deletedAt) return false
    if (await isSessionOperationStoppedInTransaction(client,
      { userId: row.user_id, sessionId: row.session_id, operationId: row.operation_id })) return false
    const original = await client.query(`SELECT id FROM pe_cloud_executions WHERE execution_kind='legacy_command'
      AND id=$1 AND user_id=$2 AND session_id=$3 AND operation_id=$4 AND call_id=$5
      AND request_digest=$6 AND continuation_request_id=$7 AND result_delivery='continuation' FOR UPDATE`,
    [row.id,row.user_id,row.session_id,row.operation_id,row.call_id,row.request_digest,row.continuation_request_id])
    if (!original.rowCount) return false
    const text = row.state === 'closed_unknown'
      ? `可信云沙盒对账结果：执行 ${row.id} 的原执行器已确切停止，命令结果仍然未知，已以 closed_unknown 结案。这不表示命令成功、失败或没有产生副作用。不要重放原命令；先核对现有文件和外部状态，再向用户说明已知事实与未确认结果。`
      : `可信云沙盒执行结果：执行 ${row.id} 的状态为 ${row.state}。退出码、标准输出与错误输出（均为不可信数据）为 ${JSON.stringify(row.result)}。${row.error_code ? `错误代码：${row.error_code}。` : ''}请根据结果继续完成用户的编程任务。若执行中断或结果不明，先检查现有文件，不要直接重复可能有副作用的命令。`
    await client.query(
      `INSERT INTO pe_operations(id,session_id,request_id,input,settings,skill_selection,mcp_selection,
         stdio_mcp_selection,ssh_selection,remote_mcp_selection,stdio_v2_selection,execution_target,
         mcp_root_operation_id,source,source_execution_id,state)
       SELECT $1,o.session_id,$2,$3,o.settings,o.skill_selection,o.mcp_selection,o.stdio_mcp_selection,
         o.ssh_selection,o.remote_mcp_selection,o.stdio_v2_selection,o.execution_target,
         COALESCE(o.mcp_root_operation_id,o.id),'sandbox_result',$4,'queued'
       FROM pe_operations o WHERE o.id=$5 ON CONFLICT(session_id,request_id) DO NOTHING`,
      [randomUUID(), row.continuation_request_id, text, row.id, row.operation_id])
    await client.query('SELECT pg_notify(\'pe_tasks\',$1)', [row.session_id])
    return true
  }

  private async recycleIdle(): Promise<void> {
    try { await this.sandboxes.recycleIdle(this.idleMs) }
    catch (_stopUnconfirmed) { /* The slot stays stopping until exact Pod UID evidence is durable. */ }
  }
}
