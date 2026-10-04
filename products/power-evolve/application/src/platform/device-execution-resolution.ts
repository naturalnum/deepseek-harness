/** Independent approval closes only Device executions with durable exact-container stop facts. */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { executionResolutionInspection, executionResolutionReceipt, executionResolutionRequest,
  executionResolutionsList, executionResolutionsListRequest, executionResolutionStatus,
  type ExecutionResolutionInspection, type ExecutionResolutionReceipt, type ExecutionResolutionRequest,
  type ExecutionResolutionsList, type ExecutionResolutionsListRequest, type ExecutionResolutionStatus,
  type ResolutionExecutionId, type ResolutionRequestId } from '@power-evolve/contracts/execution-resolution'
import { PlatformError, type Identity } from '../contracts.ts'
import { requireActiveAccount, requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { captureDeviceResolutionSnapshot, deviceResolutionDigest, validateDeviceResolutionSnapshot,
  type DeviceExecutionRow } from './device-execution-resolution-types.ts'

interface ResolutionRow {
  id: string; request_id: string; user_id: string; session_id: string; execution_id: string
  request_digest: string; fingerprint: string; snapshot: unknown; note: string
  state: 'completed'; final_execution_state: 'closed_unknown'; continuation_request_id: string
  continuation_queued: boolean
}
type EnqueueContinuation = (client: PoolClient, row: DeviceExecutionRow) => Promise<boolean>
function receipt(row: ResolutionRow): ExecutionResolutionReceipt {
  const snapshot = validateDeviceResolutionSnapshot(row.snapshot)
  const request = executionResolutionRequest.safeParse({ requestId: row.request_id, executionId: row.execution_id,
    target: 'desktop', fingerprint: row.fingerprint, note: row.note })
  if (!request.success || deviceResolutionDigest(request.data) !== row.request_digest
    || deviceResolutionDigest(snapshot) !== row.fingerprint || snapshot.userId !== row.user_id
    || snapshot.executionId !== row.execution_id || snapshot.sessionId !== row.session_id
    || snapshot.continuationRequestId !== row.continuation_request_id) {
    throw new PlatformError(409, 'device_resolution_record_unavailable')
  }
  return executionResolutionReceipt.parse({ requestId: row.request_id, executionId: row.execution_id,
    sessionId: row.session_id, target: 'desktop', state: row.state, finalState: row.final_execution_state,
    stopConfirmed: true, continuationQueued: row.continuation_queued, errorCode: null })
}
function item(row: DeviceExecutionRow, resolution: ResolutionRow | null) {
  return { executionId: row.id, sessionId: row.session_id, target: 'desktop' as const,
    executionState: row.state, command: row.command, cwd: row.cwd || '.',
    createdAt: row.created_at.toISOString(), errorCode: row.error_code, resolution: resolution ? receipt(resolution) : null }
}
/** Verify a completed closure before acknowledging the original unchanged cleanup request.
 * @param client Caller transaction holding the owner, Device and execution locks.
 * @param row Original stopped execution, now closed_unknown.
 * @returns Resolves only when the completed closure retained exactly these original stop facts.
 */
export async function assertClosedDeviceResolution(client: PoolClient, row: DeviceExecutionRow): Promise<void> {
  const resolution = (await client.query<ResolutionRow>(`SELECT * FROM pe_device_execution_resolutions
    WHERE execution_id=$1 AND user_id=$2 AND session_id=$3`, [row.id, row.user_id, row.session_id])).rows[0]
  if (!resolution) throw new PlatformError(409, 'device_resolution_record_unavailable')
  receipt(resolution)
  if (deviceResolutionDigest(captureDeviceResolutionSnapshot(row)) !== resolution.fingerprint) {
    throw new PlatformError(409, 'device_resolution_identity_changed')
  }
}

/** A complete stored stop record permits synchronous PG closure; it never creates or stops a replacement executor. */
export class DeviceExecutionResolutionService {
  constructor(private readonly pool: Pool, private readonly enqueue: EnqueueContinuation) {}

  private async owned(client: PoolClient, owner: string, id: string): Promise<DeviceExecutionRow & { current_instance_id: string }> {
    const hint = (await client.query<{ device_id: string }>(
      'SELECT device_id FROM pe_desktop_executions WHERE id=$1 AND user_id=$2', [id, owner])).rows[0]
    if (!hint) throw new PlatformError(404, 'execution_not_found')
    const device = await client.query('SELECT id FROM pe_devices WHERE id=$1 AND user_id=$2 FOR UPDATE', [hint.device_id, owner])
    if (!device.rowCount) throw new PlatformError(404, 'execution_not_found')
    const row = (await client.query<DeviceExecutionRow & { current_instance_id: string }>(
      `SELECT e.*,d.instance_id AS current_instance_id FROM pe_desktop_executions e
       JOIN pe_devices d ON d.id=e.device_id AND d.user_id=e.user_id
       JOIN pe_device_directories dir ON dir.id=e.directory_id AND dir.user_id=e.user_id AND dir.device_id=d.id
       JOIN pe_sessions s ON s.id=e.session_id AND s.user_id=e.user_id
       JOIN pe_operations o ON o.id=e.operation_id AND o.session_id=e.session_id
       WHERE e.id=$1 AND e.user_id=$2 AND e.device_id=$3 FOR UPDATE OF e`, [id, owner, hint.device_id])).rows[0]
    if (!row) throw new PlatformError(404, 'execution_not_found')
    return row
  }
  private async resolution(client: PoolClient, id: string): Promise<ResolutionRow | null> {
    return (await client.query<ResolutionRow>('SELECT * FROM pe_device_execution_resolutions WHERE execution_id=$1', [id])).rows[0] ?? null
  }
  private capture(row: DeviceExecutionRow & { current_instance_id: string }) {
    const snapshot = captureDeviceResolutionSnapshot(row)
    if (snapshot.enrollmentId !== row.current_instance_id) throw new PlatformError(409, 'device_resolution_identity_changed')
    return snapshot
  }

  /** Read at most one hundred owner-scoped executions without granting local start authority.
   * @param user Authenticated current owner.
   * @param request Optional owned Session filter.
   * @returns Original execution metadata and any completed closure receipts.
   */
  async list(user: Identity, request: ExecutionResolutionsListRequest): Promise<ExecutionResolutionsList> {
    const input = executionResolutionsListRequest.parse(request)
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId)
      if (input.sessionId && !(await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2',
        [input.sessionId, user.userId])).rowCount) throw new PlatformError(404, 'session_not_found')
      const rows = await client.query<DeviceExecutionRow>(`SELECT * FROM pe_desktop_executions WHERE user_id=$1
        AND ($2::uuid IS NULL OR session_id=$2) ORDER BY created_at DESC,id DESC LIMIT 100`, [user.userId, input.sessionId ?? null])
      const resolutions = await client.query<ResolutionRow>(`SELECT * FROM pe_device_execution_resolutions
        WHERE user_id=$1 AND execution_id=ANY($2::uuid[])`, [user.userId, rows.rows.map(row => row.id)])
      return executionResolutionsList.parse({ available: true,
        items: rows.rows.map(row => item(row, resolutions.rows.find(r => r.execution_id === row.id) ?? null)) })
    })
  }
  /** Inspect frozen original identities; missing or inconsistent stop facts block closure.
   * @param user Authenticated current owner.
   * @param executionId Original owned execution.
   * @returns Stopped-unknown facts or a bounded refusal reason; the fingerprint is not new stop evidence.
   */
  async inspect(user: Identity, executionId: ResolutionExecutionId): Promise<ExecutionResolutionInspection> {
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId, 'update')
      const row = await this.owned(client, user.userId, executionId), existing = await this.resolution(client, row.id)
      let fingerprint: string | null = existing?.fingerprint ?? null
      let blockedReason: string | null = existing ? 'execution_resolution_exists' : row.state !== 'uncertain' ? 'execution_not_uncertain' : null
      if (blockedReason === null) {
        try { fingerprint = deviceResolutionDigest(this.capture(row)) }
        catch (error) {
          if (!(error instanceof PlatformError)) throw error
          blockedReason = error.code
        }
      }
      return executionResolutionInspection.parse({ item: item(row, existing), fingerprint, canStop: blockedReason === null,
        blockedReason, runnerObservation: blockedReason === null || existing ? 'stopped_unknown' : 'not_observed' })
    })
  }
  /** Close only a fully captured unknown execution under independent, current approval authority.
   * @param user Authenticated owner, compared with the locked approval bearer.
   * @param request Stable request identity and exact inspected fingerprint; no result or proof fields are accepted.
   * @param approvalToken Independently issued approval-audience credential.
   * @returns One durable completed receipt; retries neither modify original facts nor enqueue again.
   */
  async resolve(user: Identity, request: ExecutionResolutionRequest, approvalToken: string): Promise<ExecutionResolutionReceipt> {
    const input = executionResolutionRequest.parse(request)
    if (input.target !== 'desktop') throw new PlatformError(403, 'wrong_execution_target')
    const requestDigest = deviceResolutionDigest(input)
    return transaction(this.pool, async client => {
      const actor = await requireBrowserAccount(client, approvalToken, { audience: 'approval', lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const prior = (await client.query<ResolutionRow>(`SELECT * FROM pe_device_execution_resolutions
        WHERE user_id=$1 AND request_id=$2`, [user.userId, input.requestId])).rows[0]
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new PlatformError(409, 'request_id_conflict')
        return receipt(prior)
      }
      const row = await this.owned(client, user.userId, input.executionId)
      if (await this.resolution(client, row.id)) throw new PlatformError(409, 'execution_resolution_exists')
      if (row.state !== 'uncertain') throw new PlatformError(409, 'execution_not_uncertain')
      const snapshot = this.capture(row), fingerprint = deviceResolutionDigest(snapshot)
      if (fingerprint !== input.fingerprint) throw new PlatformError(409, 'execution_identity_changed')
      const updated = (await client.query<DeviceExecutionRow>(`UPDATE pe_desktop_executions SET state='closed_unknown',
        error_code=CASE WHEN error_code='account_disabled' THEN error_code ELSE NULL END,updated_at=now()
        WHERE id=$1 AND state='uncertain' RETURNING *`, [row.id])).rows[0]
      if (!updated) throw new PlatformError(409, 'execution_identity_changed')
      const continued = await this.enqueue(client, updated)
      const result = await client.query<ResolutionRow>(`INSERT INTO pe_device_execution_resolutions
        (id,request_id,user_id,session_id,execution_id,request_digest,fingerprint,snapshot,note,state,
         final_execution_state,continuation_request_id,continuation_queued)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed','closed_unknown',$10,$11) RETURNING *`,
      [randomUUID(), input.requestId, row.user_id, row.session_id, row.id, requestDigest, fingerprint,
        JSON.stringify(snapshot), input.note, row.continuation_request_id, continued])
      return receipt(result.rows[0]!)
    })
  }
  /** Read only this owner's original closure request.
   * @param user Authenticated current owner.
   * @param requestId Stable closure request identity.
   * @returns Completed receipt or null without disclosing another owner's record.
   */
  async status(user: Identity, requestId: ResolutionRequestId): Promise<ExecutionResolutionStatus> {
    return transaction(this.pool, async client => {
      await requireActiveAccount(client, user.userId)
      const row = (await client.query<ResolutionRow>(`SELECT * FROM pe_device_execution_resolutions
        WHERE user_id=$1 AND request_id=$2`, [user.userId, requestId])).rows[0]
      return executionResolutionStatus.parse({ receipt: row ? receipt(row) : null })
    })
  }
}
