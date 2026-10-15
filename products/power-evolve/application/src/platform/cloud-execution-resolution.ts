/** Durable independent-approval resolution of captured uncertain Cloud executions. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { executionResolutionInspection, executionResolutionReceipt, executionResolutionRequest,
  executionResolutionsList, executionResolutionsListRequest, executionResolutionStatus,
  type ExecutionResolutionInspection, type ExecutionResolutionReceipt, type ExecutionResolutionRequest,
  type ExecutionResolutionsList, type ExecutionResolutionsListRequest, type ExecutionResolutionStatus,
  type ResolutionExecutionId, type ResolutionRequestId } from '@power-evolve/contracts/execution-resolution'
import { PlatformError, userId, type Identity } from '../contracts.ts'
import { lockAccountAuthorities, requireActiveAccount, requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { MountSlotBlocked, type SandboxManager, type CloudResolutionTarget } from './sandbox.ts'
import { storageBinding } from './cloud-storage-types.ts'
import { capturedRunnerRequest, cloudRunnerResult, cloudRequestDigest, type CloudExecutionRow } from './cloud-execution-resolution-types.ts'

interface ResolutionRow {
  id: string
  request_id: string
  user_id: string
  session_id: string
  execution_id: string
  request_digest: string
  fingerprint: string
  workspace_id: string
  mount_generation: string
  sandbox_name: string
  pod_uid: string
  runner_instance_id: string
  binding_snapshot: unknown
  execution_request_digest: string
  runner_request_digest: string | null
  note: string
  state: 'accepted' | 'stopping' | 'completed' | 'blocked'
  observed_result: unknown
  stop_evidence: unknown
  final_execution_state: 'succeeded' | 'failed' | 'cancelled' | 'closed_unknown' | null
  continuation_request_id: string
  continuation_queued: boolean
  error_code: string | null
  lease_owner: string | null
  lease_epoch: string
}
class ResolutionLeaseLost extends Error {}
/** Captured provider identity for one explicitly addressed durable command. */
export interface CloudResolutionCapture {
  executionId: string
  userId: string
  sessionId: string
  name: string | null
  podUid: string | null
  runnerInstanceId: string | null
}
/** Cleanup providers retain the same independent approval and original resolution lease. */
export interface CloudResolutionTransport {
  captureExecutionResolution(client: PoolClient, execution: CloudResolutionCapture): Promise<CloudResolutionTarget>
  observeExecutionResolution: SandboxManager['observeExecutionResolution']
  stopForExecutionResolution: SandboxManager['stopForExecutionResolution']
}
type EnqueueContinuation = (client: PoolClient, row: CloudExecutionRow) => Promise<boolean>
function receipt(row: ResolutionRow): ExecutionResolutionReceipt {
  return executionResolutionReceipt.parse({ requestId: row.request_id, executionId: row.execution_id,
    sessionId: row.session_id, target: 'cloud', state: row.state, finalState: row.final_execution_state,
    stopConfirmed: row.stop_evidence !== null, continuationQueued: row.continuation_queued, errorCode: row.error_code })
}
function item(row: CloudExecutionRow, resolution: ResolutionRow | null) {
  return { executionId: row.id, sessionId: row.session_id, target: 'cloud' as const, executionState: row.state,
    command: row.command, cwd: row.cwd || '.', createdAt: row.created_at.toISOString(), errorCode: row.error_code,
    resolution: resolution ? receipt(resolution) : null }
}
function target(row: ResolutionRow): CloudResolutionTarget {
  return { userId: row.user_id, sessionId: row.session_id, workspaceId: row.workspace_id,
    generation: row.mount_generation, name: row.sandbox_name, podUid: row.pod_uid,
    runnerInstanceId: row.runner_instance_id, binding: storageBinding.parse(row.binding_snapshot) }
}
function fingerprint(row: CloudExecutionRow, writer: CloudResolutionTarget): string {
  return cloudRequestDigest({ userId: row.user_id, sessionId: row.session_id, executionId: row.id,
    executionRequestDigest: row.request_digest, workspaceId: writer.workspaceId, sandboxName: writer.name,
    podUid: writer.podUid, runnerInstanceId: writer.runnerInstanceId, mountGeneration: writer.generation,
    bindingSnapshot: writer.binding })
}
const permanentCodes = new RegExp(
  '(?:identity_changed|identity_incomplete|generation_changed|binding_snapshot_invalid|'
  + 'workspace_recovering|instance_changed|version_missing)$', 'u',
)
const permanent = (error: unknown): boolean => error instanceof MountSlotBlocked && permanentCodes.test(error.code)

/** The worker reuses strict Sandbox stop evidence; no browser can supply a result or a stopped-writer assertion. */
export class CloudExecutionResolutionService {
  private readonly ownerId = randomUUID()
  constructor(private readonly pool: Pool, private readonly sandboxes: CloudResolutionTransport,
    private readonly enqueue: EnqueueContinuation, private readonly legacyTimeoutMs: number,
    private readonly leaseMs: number, private readonly pollMs: number) {}

  private async owned(client: PoolClient, owner: string, id: string): Promise<CloudExecutionRow> {
    const row = (await client.query<CloudExecutionRow>("SELECT * FROM pe_cloud_executions WHERE execution_kind='legacy_command' AND id=$1 AND user_id=$2 FOR UPDATE", [id, owner])).rows[0]
    if (!row) throw new PlatformError(404, 'execution_not_found')
    return row
  }
  private async resolution(client: PoolClient, id: string): Promise<ResolutionRow | null> {
    return (await client.query<ResolutionRow>('SELECT * FROM pe_cloud_execution_resolutions WHERE execution_id=$1', [id])).rows[0] ?? null
  }
  /**
   * Read up to 100 owner executions without creating an executor.
   * @param user Authenticated owner.
   * @param request Optional owned Session filter.
   * @returns Recent receipts and durable resolution status.
   */
  async list(user: Identity, request: ExecutionResolutionsListRequest): Promise<ExecutionResolutionsList> {
    const input = executionResolutionsListRequest.parse(request)
    return transaction(this.pool, async (client) => {
      await requireActiveAccount(client, user.userId)
      if (input.sessionId && !(await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2', [input.sessionId,user.userId])).rowCount) {
        throw new PlatformError(404, 'session_not_found')
      }
      const rows = await client.query<CloudExecutionRow>(`SELECT * FROM pe_cloud_executions WHERE execution_kind='legacy_command' AND user_id=$1
        AND ($2::uuid IS NULL OR session_id=$2) ORDER BY created_at DESC,id DESC LIMIT 100`, [user.userId,input.sessionId ?? null])
      const resolutions = await client.query<ResolutionRow>('SELECT * FROM pe_cloud_execution_resolutions WHERE user_id=$1 AND execution_id=ANY($2::uuid[])',
        [user.userId,rows.rows.map(row => row.id)])
      return executionResolutionsList.parse({ available: true,
        items: rows.rows.map(row => item(row,resolutions.rows.find(r => r.execution_id === row.id)
        ?? null)) })
    })
  }
  private async observation(writer: CloudResolutionTarget, row: CloudExecutionRow) {
    try {
      const raw = await this.sandboxes.observeExecutionResolution(writer, row.id)
      if (raw === null) return { state: 'not_observed' as const, result: null }
      const parsed = cloudRunnerResult.safeParse(raw), request = capturedRunnerRequest(row, this.legacyTimeoutMs)
      if (!parsed.success || !request) return { state: 'unavailable' as const, result: null }
      const result = parsed.data
      if (result.id !== row.id || result.instanceId !== writer.runnerInstanceId || result.digest !== cloudRequestDigest(request)) {
        return { state: 'identity_changed' as const, result: null }
      }
      return { state: result.state, result }
    } catch (error) {
      return { state: permanent(error) ? 'identity_changed' as const : 'unavailable' as const, result: null }
    }
  }
  /**
   * Inspect the exact command and frozen identity; Runner observations are advisory until the fenced worker captures them.
   * @param user Authenticated owner.
   * @param executionId Owner's original execution.
   * @returns Approval inspection; unavailable observations never imply a stopped process.
   */
  async inspect(user: Identity, executionId: ResolutionExecutionId): Promise<ExecutionResolutionInspection> {
    const selected = await transaction(this.pool, async (client) => {
      await requireActiveAccount(client,user.userId,'update')
      const row = await this.owned(client,user.userId,executionId), existing = await this.resolution(client,row.id)
      if (existing || row.state !== 'uncertain') return { row, existing, writer: null, reason: existing ? 'execution_resolution_exists' : 'execution_not_uncertain' }
      try {
        const writer = await this.sandboxes.captureExecutionResolution(client, { executionId: row.id,
          userId: row.user_id, sessionId: row.session_id,
          name: row.sandbox_name, podUid: row.pod_uid, runnerInstanceId: row.runner_instance_id })
        return { row, existing, writer, reason: null }
      } catch (error) {
        if (!(error instanceof MountSlotBlocked || error instanceof PlatformError)) throw error
        return { row, existing, writer: null, reason: error.code }
      }
    })
    const observed = selected.writer ? await this.observation(selected.writer,selected.row) : { state: 'not_observed' as const }
    const changed = observed.state === 'identity_changed'
    return executionResolutionInspection.parse({ item: item(selected.row,selected.existing),
      fingerprint: selected.writer ? fingerprint(selected.row,selected.writer) : selected.existing?.fingerprint ?? null,
      canStop: !!selected.writer && !changed, blockedReason: changed ? 'runner_identity_mismatch' : selected.reason,
      runnerObservation: observed.state })
  }
  /**
   * Persist independent approval and revoke the ordinary worker lease atomically.
   * @param user Authenticated owner, rechecked against the approval credential.
   * @param request Stable request ID and inspected fingerprint; no result or proof fields are accepted.
   * @param approvalToken Raw independently issued approval bearer, rechecked under the user lock.
   * @returns Original immutable receipt on an identical retry.
   */
  async resolve(user: Identity, request: ExecutionResolutionRequest, approvalToken: string): Promise<ExecutionResolutionReceipt> {
    const input = executionResolutionRequest.parse(request), requestDigest = cloudRequestDigest(input)
    return transaction(this.pool, async (client) => {
      const actor = await requireBrowserAccount(client,approvalToken,{ audience: 'approval', lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401,'unauthorized')
      const prior = (await client.query<ResolutionRow>('SELECT * FROM pe_cloud_execution_resolutions WHERE user_id=$1 AND request_id=$2', [user.userId,input.requestId])).rows[0]
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new PlatformError(409,'request_id_conflict')
        return receipt(prior)
      }
      const row = await this.owned(client,user.userId,input.executionId)
      if (await this.resolution(client,row.id)) throw new PlatformError(409,'execution_resolution_exists')
      if (row.state !== 'uncertain') throw new PlatformError(409,'execution_not_uncertain')
      const writer = await this.sandboxes.captureExecutionResolution(client,{ executionId: row.id,
        userId: row.user_id, sessionId: row.session_id,
        name: row.sandbox_name, podUid: row.pod_uid, runnerInstanceId: row.runner_instance_id })
      if (fingerprint(row,writer) !== input.fingerprint) throw new PlatformError(409,'execution_identity_changed')
      const dispatched = capturedRunnerRequest(row,this.legacyTimeoutMs)
      const inserted = await client.query<ResolutionRow>(`INSERT INTO pe_cloud_execution_resolutions(id,request_id,user_id,session_id,execution_id,
        request_digest,fingerprint,workspace_id,mount_generation,sandbox_name,pod_uid,runner_instance_id,binding_snapshot,
        execution_request_digest,runner_request_digest,note,state,continuation_request_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'accepted',$17) RETURNING *`,
      [randomUUID(),input.requestId,row.user_id,row.session_id,row.id,requestDigest,input.fingerprint,writer.workspaceId,writer.generation,
        writer.name,writer.podUid,writer.runnerInstanceId,JSON.stringify(writer.binding),row.request_digest,
        dispatched ? cloudRequestDigest(dispatched) : null,input.note,row.continuation_request_id])
      await client.query("UPDATE pe_cloud_executions SET lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE execution_kind='legacy_command' AND id=$1", [row.id])
      await client.query("SELECT pg_notify('pe_executions',$1)", [row.session_id])
      const insertedRow = inserted.rows[0]
      assert(insertedRow)
      return receipt(insertedRow)
    })
  }
  /**
   * Read only the authenticated owner's receipt; unknown IDs disclose no other owner.
   * @param user Authenticated owner.
   * @param requestId Stable resolution request identifier.
   * @returns Existing receipt or null.
   */
  async status(user: Identity, requestId: ResolutionRequestId): Promise<ExecutionResolutionStatus> {
    return transaction(this.pool, async (client) => {
      await requireActiveAccount(client,user.userId)
      const row = (await client.query<ResolutionRow>('SELECT * FROM pe_cloud_execution_resolutions WHERE user_id=$1 AND request_id=$2', [user.userId,requestId])).rows[0]
      return executionResolutionStatus.parse({ receipt: row ? receipt(row) : null })
    })
  }
  private async lease(client: PoolClient, row: ResolutionRow, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const live = await client.query(`SELECT r.id FROM pe_cloud_execution_resolutions r JOIN pe_cloud_executions e ON e.id=r.execution_id
      WHERE r.id=$1 AND r.lease_owner=$2 AND r.lease_epoch=$3 AND r.lease_until>clock_timestamp()
      AND r.state='stopping' AND e.execution_kind='legacy_command' AND e.state='uncertain' AND e.user_id=r.user_id AND e.session_id=r.session_id
      AND e.request_digest=r.execution_request_digest AND e.sandbox_name=r.sandbox_name AND e.pod_uid=r.pod_uid
      AND e.runner_instance_id=r.runner_instance_id AND e.continuation_request_id=r.continuation_request_id FOR UPDATE OF r,e`,
    [row.id,this.ownerId,row.lease_epoch])
    if (!live.rowCount) throw new ResolutionLeaseLost()
  }
  /**
   * Claim and reconcile one durable intent; shutdown retains identity/proof and releases only this epoch's lease.
   * @param signal Worker shutdown; no new intent is claimed after abort.
   * @returns Whether one intent was claimed, including a retained retry or permanent block.
   */
  async poll(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    const hint = (await this.pool.query<ResolutionRow>(`SELECT r.* FROM pe_cloud_execution_resolutions r
      JOIN pe_cloud_executions e ON e.id=r.execution_id AND e.execution_kind='legacy_command'
      WHERE r.state IN ('accepted','stopping') AND (r.lease_until IS NULL OR r.lease_until<=clock_timestamp()) ORDER BY r.updated_at,r.id LIMIT 1`)).rows[0]
    if (!hint) return false
    const row = await transaction(this.pool,async (client) => {
      await lockAccountAuthorities(client,[userId.parse(hint.user_id)],'update')
      const claimed = await client.query<ResolutionRow>(`UPDATE pe_cloud_execution_resolutions SET state='stopping',lease_owner=$2,
        lease_epoch=lease_epoch+1,lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',attempts=attempts+1,updated_at=now()
        WHERE id=$1 AND state IN ('accepted','stopping') AND (lease_until IS NULL OR lease_until<=clock_timestamp())
        AND EXISTS(SELECT 1 FROM pe_cloud_executions e WHERE e.id=execution_id AND e.execution_kind='legacy_command') RETURNING *`,
      [hint.id,this.ownerId,this.leaseMs])
      return claimed.rows[0] ?? null
    })
    if (!row) return false
    const guard = async (client?: PoolClient) => {
      const check = async (locked: PoolClient) => {
        await lockAccountAuthorities(locked,[userId.parse(row.user_id)],'update')
        await this.lease(locked,row,signal)
      }
      if (client) await check(client); else await transaction(this.pool,async (locked) => {
        await check(locked)
        await locked.query(`UPDATE pe_cloud_execution_resolutions SET lease_until=clock_timestamp()+$2::double precision*interval '1 millisecond'
          WHERE id=$1`, [row.id,this.leaseMs])
      })
    }
    try {
      await guard()
      const original = await transaction(this.pool,async (client) => {
        await guard(client)
        return this.owned(client,row.user_id,row.execution_id)
      })
      if (row.observed_result === null) {
        const observed = await this.observation(target(row),original)
        if (observed.state === 'identity_changed') throw new MountSlotBlocked('mount_resolution_identity_changed',false)
        if (observed.result && observed.result.state !== 'running' && observed.result.digest === row.runner_request_digest) {
          await transaction(this.pool,async (client) => {
            await guard(client)
            await client.query('UPDATE pe_cloud_execution_resolutions SET observed_result=$2,updated_at=now() WHERE id=$1', [row.id,JSON.stringify(observed.result)])
          })
        }
      }
      await this.sandboxes.stopForExecutionResolution(target(row),row.request_id,guard,async (client,evidence) => {
        await guard(client)
        const persisted = (await client.query<ResolutionRow>(
          'SELECT * FROM pe_cloud_execution_resolutions WHERE id=$1 FOR UPDATE', [row.id])).rows[0]
        assert(persisted)
        const verified = cloudRunnerResult.safeParse(persisted.observed_result)
        const result = verified.success && verified.data.state !== 'running' && verified.data.id === row.execution_id
          && verified.data.instanceId === row.runner_instance_id
            && verified.data.digest === row.runner_request_digest ? verified.data : null
        const finalState = result?.state ?? 'closed_unknown'
        const value = result ? { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
          stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,timedOut: result.timedOut,
          verifiedFiles: { status: 'unavailable', files: [], reasons: ['execution_unavailable'] } } : null
        const updated = await client.query<CloudExecutionRow>(`UPDATE pe_cloud_executions SET state=$2,result=$3,
          error_code=CASE WHEN error_code='account_disabled' THEN error_code ELSE NULL END,lease_owner=NULL,lease_until=NULL,updated_at=now()
          WHERE execution_kind='legacy_command' AND id=$1 AND state='uncertain' RETURNING *`, [row.execution_id,finalState,value === null ? null : JSON.stringify(value)])
        if (!updated.rows[0]) throw new ResolutionLeaseLost()
        const continuation = await this.enqueue(client,updated.rows[0])
        await client.query(`UPDATE pe_cloud_execution_resolutions SET state='completed',stop_evidence=$2,final_execution_state=$3,
          continuation_queued=$4,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,
        [row.id,JSON.stringify(evidence),finalState,continuation])
        signal.throwIfAborted()
      })
    } catch (error) {
      if (error instanceof ResolutionLeaseLost) return true
      await transaction(this.pool,async (client) => {
        await lockAccountAuthorities(client,[userId.parse(row.user_id)],'update')
        const current = await client.query(`SELECT id FROM pe_cloud_execution_resolutions WHERE id=$1 AND lease_owner=$2
          AND lease_epoch=$3 AND lease_until>clock_timestamp() AND state='stopping' FOR UPDATE`, [row.id,this.ownerId,row.lease_epoch])
        if (!current.rowCount) return
        if (permanent(error)) {
          await client.query(`UPDATE pe_cloud_execution_resolutions SET state='blocked',error_code=$2,
            lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [row.id,error instanceof MountSlotBlocked ? error.code : 'execution_identity_changed'])
        } else {
          await client.query(`UPDATE pe_cloud_execution_resolutions SET lease_owner=CASE WHEN $3 THEN NULL ELSE lease_owner END,
            lease_until=CASE WHEN $3 THEN NULL ELSE clock_timestamp()+$2::double precision*interval '1 millisecond' END,
            updated_at=now() WHERE id=$1`, [row.id,this.pollMs,signal.aborted])
        }
      })
    }
    return true
  }
}
