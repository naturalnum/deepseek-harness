/** Desktop device enrollment and durable commands for locally authorized directories. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { deviceClaim, deviceContainerRegistered, deviceDispatchRequest, deviceFinishRequest, deviceFinishReceipt,
  deviceClaimClosureRequest, deviceClaimClosureReceipt,
  deviceJob, ownedContainerReceipt, deviceStopObservation, deviceExecutionResult,
  type DeviceMaterialRequest, type DeviceMaterialBinding, type DeviceSkillMaterial,
  type DeviceClaim, type DeviceClaimClosureRequest, type DeviceClaimClosureReceipt, type DeviceContainerRegistration, type DeviceFinishRequest,
  type OwnedContainerReceipt } from '@power-evolve/contracts/device-execution'
import { executionTarget, identity, skillSelection, PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import { lockAccountAuthorities, requireActiveAccount, requireBrowserAccount } from './account-authority.ts'
import { userId as executionUserId } from '../contracts.ts'
import { digest } from './identity.ts'
import type { FileService } from './files.ts'
import type { TaskStore } from './tasks.ts'
import type { SkillService } from './skills.ts'
import type { ExecutionResolutionInspection, ExecutionResolutionReceipt, ExecutionResolutionRequest, ExecutionResolutionsList,
  ExecutionResolutionsListRequest, ExecutionResolutionStatus, ResolutionExecutionId, ResolutionRequestId } from '@power-evolve/contracts/execution-resolution'
import { DeviceExecutionResolutionService, assertClosedDeviceResolution } from './device-execution-resolution.ts'
import type { DeviceExecutionRow as Row } from './device-execution-resolution-types.ts'

interface Device { id: string; user_id: string; instance_id: string; revoked_at: Date | null; accountActive: boolean }
interface ClaimClosureRow {
  request_id: string; user_id: string; session_id: string; execution_id: string; device_id: string
  request_digest: string; request: unknown; receipt: unknown; continuation_request_id: string
}
const dispatchIdentity = z.object({
  device_instance_id: z.uuid(), dispatch_id: z.uuid(), dispatch_process_id: z.uuid(),
})
const stopIdentity = z.object({
  stop_request_id: z.uuid().nullable(), stop_record_digest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  continuation_queued: z.boolean(),
})
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Credentials and local paths never pass through the shared Agent host. */
export class DeviceService {
  private readonly resolutions: DeviceExecutionResolutionService
  constructor(private readonly tasks: TaskStore, private readonly commandTimeoutMs: number,
    private readonly files: FileService, private readonly skills?: SkillService) {
    this.resolutions = new DeviceExecutionResolutionService(tasks.pool, (client, row) => this.continue(client, row))
  }
  private get pool(): Pool { return this.tasks.pool }

  /** Read owner-scoped Device executions and completed closure receipts.
   * @param user Authenticated owner.
   * @param request Optional original Session filter.
   * @returns Bounded original execution records.
   */
  listResolutions(user: Identity, request: ExecutionResolutionsListRequest): Promise<ExecutionResolutionsList> {
    return this.resolutions.list(user, request)
  }
  /** Inspect exact recorded stop facts without granting a new execution.
   * @param user Authenticated owner.
   * @param executionId Original execution identity.
   * @returns Frozen fingerprint or a reason closure is blocked.
   */
  inspectResolution(user: Identity, executionId: ResolutionExecutionId): Promise<ExecutionResolutionInspection> {
    return this.resolutions.inspect(user, executionId)
  }
  /** Close a stopped unknown outcome only under independent approval authority.
   * @param user Authenticated owner.
   * @param request Stable request and exact inspected fingerprint.
   * @param approvalToken Current independent approval credential.
   * @returns Completed idempotent closure receipt.
   */
  resolveUncertain(user: Identity, request: ExecutionResolutionRequest, approvalToken: string): Promise<ExecutionResolutionReceipt> {
    return this.resolutions.resolve(user, request, approvalToken)
  }
  /** Read the owner's original closure after response loss or refresh.
   * @param user Authenticated owner.
   * @param requestId Stable closure request identity.
   * @returns Original receipt or null.
   */
  resolutionStatus(user: Identity, requestId: ResolutionRequestId): Promise<ExecutionResolutionStatus> {
    return this.resolutions.status(user, requestId)
  }

  /** Create one short-lived pairing after checking the current browser credential.
   * @param user Authenticated pairing owner.
   * @param credentialToken Raw agent-audience browser bearer.
   * @returns Secret pairing code and its expiration time.
   */
  async pair(user: Identity, credentialToken: string): Promise<{ code: string; expiresAt: string }> {
    const code = randomBytes(24).toString('base64url')
    const expiresAt = new Date(Date.now() + 10 * 60_000)
    await transaction(this.pool, async client => {
      const actor = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      await client.query('INSERT INTO pe_device_pairings(digest,user_id,expires_at) VALUES($1,$2,$3)',
        [digest(code), user.userId, expiresAt])
    })
    return { code, expiresAt: expiresAt.toISOString() }
  }

  /** Consume an unexpired pairing under its active owner lock.
   * @param code Secret one-use pairing code.
   * @param name Human-visible device label.
   * @param instanceId Persistent local enrollment identity.
   * @returns Device identity and private worker credential.
   */
  async enroll(code: string, name: string, instanceId: string): Promise<{ deviceId: string; token: string }> {
    return transaction(this.pool, async client => {
      const owner = await client.query<{ user_id: string }>('SELECT user_id FROM pe_device_pairings WHERE digest=$1', [digest(code)])
      if (!owner.rows[0]) throw new PlatformError(401, 'pairing_invalid')
      await requireActiveAccount(client, executionUserId.parse(owner.rows[0].user_id), 'update')
      const paired = await client.query<{ user_id: string }>(
        'DELETE FROM pe_device_pairings WHERE digest=$1 AND expires_at>clock_timestamp() RETURNING user_id', [digest(code)])
      if (!paired.rows[0]) throw new PlatformError(401, 'pairing_invalid')
      const deviceId = randomUUID(), token = randomBytes(32).toString('base64url')
      await client.query(
        'INSERT INTO pe_devices(id,user_id,name,token_digest,instance_id) VALUES($1,$2,$3,$4,$5)',
        [deviceId, paired.rows[0].user_id, name, digest(token), instanceId])
      return { deviceId, token }
    })
  }

  private async authenticated(client: PoolClient, token: string, allowRevoked = false): Promise<Device> {
    const owner = await client.query<{ user_id: string }>('SELECT user_id FROM pe_devices WHERE token_digest=$1', [digest(token)])
    if (!owner.rows[0]) throw new PlatformError(401, 'device_unauthorized')
    const account = (await lockAccountAuthorities(client, [executionUserId.parse(owner.rows[0].user_id)], 'update'))[0]!
    const result = await client.query<Device>(
      'SELECT id,user_id,instance_id,revoked_at FROM pe_devices WHERE token_digest=$1 FOR UPDATE', [digest(token)])
    if (!result.rows[0] || (result.rows[0].revoked_at && !allowRevoked)) throw new PlatformError(401, 'device_unauthorized')
    await client.query('UPDATE pe_devices SET last_seen_at=now() WHERE id=$1', [result.rows[0].id])
    return { ...result.rows[0], accountActive: account.enabled && account.deletedAt === null }
  }

  /** Authorize a new local directory only for an active account.
   * @param token Private enrolled device credential.
   * @param label Human-visible directory label.
   * @returns New directory identity.
   */
  async directory(token: string, label: string): Promise<{ directoryId: string }> {
    return transaction(this.pool, async client => {
      const device = await this.authenticated(client, token)
      await requireActiveAccount(client, executionUserId.parse(device.user_id), 'update')
      const directoryId = randomUUID()
      await client.query(
        'INSERT INTO pe_device_directories(id,device_id,user_id,label) VALUES($1,$2,$3,$4)',
        [directoryId, device.id, device.user_id, label])
      return { directoryId }
    })
  }

  private async transfer<T>(token: string, directoryId: string, action: (user: Identity) => Promise<T>): Promise<T> {
    const user = await transaction(this.pool, async client => {
      const device = await this.authenticated(client, token)
      await requireActiveAccount(client, executionUserId.parse(device.user_id), 'update')
      const directory = await client.query(
        `SELECT id FROM pe_device_directories WHERE id=$1 AND device_id=$2 AND user_id=$3
         AND revoked_at IS NULL FOR UPDATE`, [directoryId, device.id, device.user_id])
      if (!directory.rowCount) throw new PlatformError(403, 'desktop_directory_unavailable')
      return identity.parse({ userId: device.user_id, username: 'local-device' })
    })
    return action(user)
  }

  /** Read the owner's cloud file through an active Device directory grant.
   * @param token Enrolled Device credential.
   * @param directoryId Owned, unrevoked local directory identity.
   * @param path Relative cloud file path.
   * @returns Bounded encoded file bytes from the owner's cloud space.
   */
  async readCloud(token: string, directoryId: string, path: string): Promise<unknown> {
    return this.transfer(token, directoryId, user => this.files.read(user, path))
  }

  /** Upload through an active Device directory grant without overwriting existing cloud files.
   * @param token Enrolled Device credential.
   * @param directoryId Owned, unrevoked local directory identity.
   * @param requestId Stable upload identity.
   * @param path Relative cloud file path.
   * @param data Bounded base64-encoded file bytes.
   * @returns Durable file receipt.
   */
  async putCloud(token: string, directoryId: string, requestId: string, path: string, data: string): Promise<unknown> {
    return this.transfer(token, directoryId, user => this.files.put(user, requestId, path, null, data))
  }

  /** List only this owner's enrolled Devices and directory labels.
   * @param user Independently authenticated owner.
   * @returns Device and directory metadata without private local paths or credentials.
   */
  async list(user: Identity): Promise<unknown> {
    const result = await this.pool.query(
      `SELECT d.id AS "deviceId",d.name,d.instance_id AS "instanceId",d.last_seen_at AS "lastSeenAt",
       dir.id AS "directoryId",dir.label,dir.revoked_at AS "directoryRevokedAt"
       FROM pe_devices d LEFT JOIN pe_device_directories dir ON dir.device_id=d.id
       WHERE d.user_id=$1 AND d.revoked_at IS NULL ORDER BY d.created_at DESC,dir.created_at DESC`, [user.userId])
    return { items: result.rows }
  }

  /** Revoke a device and reconcile its existing execution cancellation.
   * @param user Independently authenticated owner.
   * @param deviceId Exact owned device to revoke.
   */
  async revoke(user: Identity, deviceId: string): Promise<void> {
    await transaction(this.pool, async client => {
      await lockAccountAuthorities(client, [executionUserId.parse(user.userId)], 'update')
      const updated = await client.query(
        'UPDATE pe_devices SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id',
        [deviceId, user.userId])
      if (!updated.rowCount) throw new PlatformError(404, 'device_not_found')
      await client.query('UPDATE pe_device_directories SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL', [deviceId])
      const queued = await client.query<Row>(
        `UPDATE pe_desktop_executions SET state='cancelled',cancel_requested=true,updated_at=now()
         WHERE device_id=$1 AND state='queued' RETURNING *`, [deviceId])
      for (const row of queued.rows) await this.continue(client, row)
      await client.query(
        `UPDATE pe_desktop_executions SET cancel_requested=true,state='uncertain',
         error_code=CASE WHEN error_code='account_disabled' THEN error_code WHEN stop_observation IS NULL THEN 'device_revoked_stop_unconfirmed' ELSE 'desktop_result_uncertain' END,updated_at=now()
         WHERE device_id=$1 AND state IN ('running','cancelling','uncertain')`, [deviceId])
    })
  }

  /** Revoke a directory and preserve any existing account cancellation marker.
   * @param user Independently authenticated owner.
   * @param directoryId Exact owned directory to revoke.
   */
  async revokeDirectory(user: Identity, directoryId: string): Promise<void> {
    await transaction(this.pool, async client => {
      await lockAccountAuthorities(client, [executionUserId.parse(user.userId)], 'update')
      const updated = await client.query(
        'UPDATE pe_device_directories SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id',
        [directoryId, user.userId])
      if (!updated.rowCount) throw new PlatformError(404, 'directory_not_found')
      const queued = await client.query<Row>(
        `UPDATE pe_desktop_executions SET state='cancelled',cancel_requested=true,updated_at=now()
         WHERE directory_id=$1 AND state='queued' RETURNING *`, [directoryId])
      for (const row of queued.rows) await this.continue(client, row)
      await client.query(
        `UPDATE pe_desktop_executions SET cancel_requested=true,state='uncertain',
         error_code=CASE WHEN error_code='account_disabled' THEN error_code WHEN stop_observation IS NULL THEN 'directory_revoked_stop_unconfirmed' ELSE 'desktop_result_uncertain' END,updated_at=now()
         WHERE directory_id=$1 AND state IN ('running','cancelling','uncertain')`, [directoryId])
    })
  }

  /** Freeze accepted command inputs and enrollment before acknowledging one Device execution.
   * @param token Current Session execution grant.
   * @param callId Original model tool call identity.
   * @param command Command selected by the authorized operation.
   * @param cwd Relative directory within the selected local grant.
   * @returns Original receipt on an identical retry, including after a timeout configuration change.
   */
  async propose(token: string, callId: string, command: string, cwd: string): Promise<unknown> {
    return transaction(this.pool, async client => {
      const grant = await this.tasks.authorized(client, token)
      const target = executionTarget.parse(grant.execution_target)
      if (target.kind !== 'desktop') throw new PlatformError(403, 'wrong_execution_target')
      const prior = await client.query<Row>(
        'SELECT * FROM pe_desktop_executions WHERE operation_id=$1 AND call_id=$2', [grant.operation_id, callId])
      if (prior.rows[0]) {
        const frozen = this.dispatch(prior.rows[0])
        if (prior.rows[0].request_digest !== hash({ command, cwd, timeoutMs: frozen.timeoutMs,
          deviceId: target.deviceId, directoryId: target.directoryId,
          ...(frozen.materials ? { materials: frozen.materials } : {}) })) throw new PlatformError(409, 'request_id_conflict')
        return this.receipt(prior.rows[0])
      }
      const operation = await client.query<{ skill_selection: unknown }>(`SELECT o.skill_selection
        FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
        WHERE o.id=$1 AND o.session_id=$2 AND s.user_id=$3`, [grant.operation_id, grant.id, grant.user_id])
      if (!operation.rows[0]) throw new PlatformError(409, 'device_operation_unavailable')
      const selected = z.array(skillSelection).max(256).safeParse(operation.rows[0].skill_selection)
      if (!selected.success) throw new PlatformError(409, 'device_operation_unavailable')
      const selection = selected.data
      if (selection.some(selected => selected.kind === 'package') && !this.skills) throw new PlatformError(503, 'device_material_service_unavailable')
      const materials = this.skills ? await this.skills.deviceBindings(grant.user_id, selection, client) : []
      const request = deviceDispatchRequest.parse({ command, cwd, timeoutMs: this.commandTimeoutMs,
        deviceId: target.deviceId, directoryId: target.directoryId, ...(materials.length ? { materials } : {}) })
      const available = await client.query<{ instance_id: string }>(
        `SELECT d.instance_id FROM pe_devices d JOIN pe_device_directories dir ON dir.device_id=d.id
         WHERE d.id=$1 AND dir.id=$2 AND d.user_id=$3 AND dir.user_id=$3
           AND d.revoked_at IS NULL AND dir.revoked_at IS NULL`,
        [target.deviceId, target.directoryId, grant.user_id])
      if (!available.rowCount) throw new PlatformError(403, 'desktop_target_unavailable')
      const busy = await client.query(
        `SELECT id FROM pe_desktop_executions WHERE session_id=$1
         AND state IN ('queued','running','cancelling','uncertain')
         UNION ALL SELECT id FROM pe_cloud_executions WHERE session_id=$1
         AND state IN ('queued','starting','running','cancelling','uncertain')`, [grant.id])
      if (busy.rowCount) throw new PlatformError(409, 'execution_busy')
      const directoryBusy = await client.query(`SELECT id FROM pe_desktop_executions
        WHERE user_id=$1 AND device_id=$2 AND directory_id=$3
          AND state IN ('queued','running','cancelling','uncertain') LIMIT 1`,
      [grant.user_id, target.deviceId, target.directoryId])
      if (directoryBusy.rowCount) throw new PlatformError(409, 'desktop_directory_busy')
      const inserted = await client.query<Row>(
        `INSERT INTO pe_desktop_executions(id,user_id,session_id,operation_id,device_id,directory_id,
         call_id,command,cwd,request_digest,state,dispatch_request,device_instance_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12) RETURNING *`,
        [randomUUID(), grant.user_id, grant.id, grant.operation_id, target.deviceId, target.directoryId,
          callId, command, cwd, hash(request), JSON.stringify(request), available.rows[0]!.instance_id])
      return this.receipt(inserted.rows[0]!)
    })
  }

  private dispatch(row: Row): z.infer<typeof deviceDispatchRequest> {
    const parsed = deviceDispatchRequest.safeParse(row.dispatch_request)
    if (!parsed.success || !z.uuid().safeParse(row.device_instance_id).success
      || parsed.data.command !== row.command || parsed.data.cwd !== row.cwd
      || parsed.data.deviceId !== row.device_id || parsed.data.directoryId !== row.directory_id
      || hash(parsed.data) !== row.request_digest) throw new PlatformError(409, 'device_dispatch_unavailable')
    return parsed.data
  }

  private async assertClaimOpen(client: PoolClient, row: Row): Promise<void> {
    if ((await client.query('SELECT id FROM pe_device_claim_closures WHERE execution_id=$1', [row.id])).rowCount) {
      throw new PlatformError(409, 'device_claim_closed')
    }
  }

  private assertUnstartedClaim(row: Row, device: Device, input: DeviceClaimClosureRequest): void {
    const frozen = this.dispatch(row)
    if (device.instance_id !== input.instanceId || row.device_instance_id !== input.instanceId
      || frozen.directoryId !== input.directoryId || row.request_digest !== input.digest
      || (row.dispatch_id === null) !== (row.dispatch_process_id === null)
      || row.dispatch_process_id !== null && row.dispatch_process_id !== input.processId) {
      throw new PlatformError(409, 'device_claim_identity_changed')
    }
    if (row.container_receipt !== null || row.start_authorized_at !== null || row.result !== null
      || row.stop_request_id !== null || row.stop_record_digest !== null || row.stop_observation !== null) {
      throw new PlatformError(409, 'device_claim_start_unconfirmed')
    }
    if (!['queued', 'running', 'cancelling', 'uncertain', 'cancelled'].includes(row.state)) {
      throw new PlatformError(409, 'device_claim_unavailable')
    }
  }

  private claimClosure(row: ClaimClosureRow, execution: Row, device: Device): DeviceClaimClosureReceipt {
    const request = deviceClaimClosureRequest.safeParse(row.request), receipt = deviceClaimClosureReceipt.safeParse(row.receipt)
    if (!request.success || !receipt.success) throw new PlatformError(409, 'device_claim_closure_unavailable')
    const r = receipt.data
    if (hash(request.data) !== row.request_digest || hash({ instanceId: r.instanceId, executionId: r.executionId,
      processId: r.processId, directoryId: r.directoryId, digest: r.digest, requestId: r.requestId }) !== row.request_digest
      || row.request_id !== r.requestId || row.execution_id !== execution.id || r.executionId !== execution.id
      || row.user_id !== execution.user_id || row.session_id !== execution.session_id
      || row.device_id !== device.id || r.deviceId !== device.id || execution.device_id !== device.id
      || row.continuation_request_id !== execution.continuation_request_id || r.dispatchId !== execution.dispatch_id
      || r.continuationQueued !== execution.continuation_queued || execution.state !== 'cancelled' || !execution.cancel_requested) {
      throw new PlatformError(409, 'device_claim_closure_unavailable')
    }
    this.assertUnstartedClaim(execution, device, request.data)
    return r
  }

  /** Permanently close an interrupted claim or creation that never received start permission.
   * @param token Original Device credential; revocation permits only this exact existing claim's cleanup.
   * @param input Stable original intent verified by the trusted Worker under its private journal lock.
   * @returns Durable no-start receipt; no Docker stop, output, or replacement dispatch is invented.
   */
  async closeUnstartedClaim(token: string, input: DeviceClaimClosureRequest): Promise<DeviceClaimClosureReceipt> {
    const request = deviceClaimClosureRequest.parse(input), requestDigest = hash(request)
    return transaction(this.pool, async client => {
      const device = await this.authenticated(client, token, true)
      const prior = (await client.query<ClaimClosureRow>(`SELECT * FROM pe_device_claim_closures
        WHERE user_id=$1 AND request_id=$2`, [device.user_id, request.requestId])).rows[0]
      if (prior && prior.device_id !== device.id) throw new PlatformError(404, 'execution_not_found')
      if (prior && prior.request_digest !== requestDigest) throw new PlatformError(409, 'request_id_conflict')
      const row = (await client.query<Row>(`SELECT e.* FROM pe_desktop_executions e
        JOIN pe_device_directories dir ON dir.id=e.directory_id AND dir.device_id=e.device_id AND dir.user_id=e.user_id
        WHERE e.id=$1 AND e.device_id=$2 AND e.user_id=$3 FOR UPDATE OF e`,
      [request.executionId, device.id, device.user_id])).rows[0]
      if (!row) throw new PlatformError(404, 'execution_not_found')
      if (prior) return this.claimClosure(prior, row, device)
      if ((await client.query('SELECT id FROM pe_device_claim_closures WHERE execution_id=$1', [row.id])).rowCount) {
        throw new PlatformError(409, 'device_claim_closure_exists')
      }
      this.assertUnstartedClaim(row, device, request)
      const updated = (await client.query<Row>(`UPDATE pe_desktop_executions SET state='cancelled',cancel_requested=true,
        error_code=CASE WHEN error_code='account_disabled' OR $2 THEN 'account_disabled'
          ELSE 'device_claim_closed_without_start' END,updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, !device.accountActive])).rows[0]!
      await this.continue(client, updated)
      const completed = (await client.query<Row>('SELECT * FROM pe_desktop_executions WHERE id=$1', [row.id])).rows[0]!
      const receipt = deviceClaimClosureReceipt.parse({ ...request, kind: 'unstarted_claim_closed', deviceId: device.id,
        dispatchId: row.dispatch_id, state: 'cancelled', startNeverAuthorized: true,
        continuationQueued: completed.continuation_queued })
      const saved = (await client.query<ClaimClosureRow>(`INSERT INTO pe_device_claim_closures
        (id,request_id,user_id,session_id,execution_id,device_id,request_digest,request,receipt,continuation_request_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [randomUUID(), request.requestId,
        row.user_id, row.session_id, row.id, device.id, requestDigest, JSON.stringify(request), JSON.stringify(receipt),
        row.continuation_request_id])).rows[0]!
      return this.claimClosure(saved, completed, device)
    })
  }

  private receipt(row: Row): unknown {
    return { executionId: row.id, state: row.state, command: row.command, cwd: row.cwd,
      target: { kind: 'desktop', deviceId: row.device_id, directoryId: row.directory_id },
      result: row.result, errorCode: row.error_code }
  }

  /** List bounded execution metadata and original output for the requesting owner.
   * @param user Independently authenticated owner.
   * @returns Up to one hundred execution receipts ordered by acceptance time.
   */
  async executions(user: Identity): Promise<unknown> {
    const result = await this.pool.query<Row & { device_name: string; directory_label: string }>(
      `SELECT e.*,d.name AS device_name,dir.label AS directory_label
       FROM pe_desktop_executions e JOIN pe_devices d ON d.id=e.device_id
       JOIN pe_device_directories dir ON dir.id=e.directory_id
       WHERE e.user_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 100`, [user.userId])
    return { items: result.rows.map(row => ({ ...this.receipt(row) as object,
      targetLabel: `${row.device_name} / ${row.directory_label}`, createdAt: row.created_at.toISOString() })) }
  }

  /** Request cancellation while preserving original results and account revocation.
   * @param user Independently authenticated execution owner.
   * @param id Owned execution identity.
   * @returns Current durable execution receipt.
   */
  async cancel(user: Identity, id: string): Promise<unknown> {
    return transaction(this.pool, async client => {
      await lockAccountAuthorities(client, [executionUserId.parse(user.userId)], 'update')
      const result = await client.query<Row>(
        'SELECT * FROM pe_desktop_executions WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.userId])
      const row = result.rows[0]
      if (!row) throw new PlatformError(404, 'execution_not_found')
      if (row.state === 'queued') {
        const updated = await client.query<Row>(
          `UPDATE pe_desktop_executions SET state='cancelled',cancel_requested=true,updated_at=now()
           WHERE id=$1 RETURNING *`, [id])
        await this.continue(client, updated.rows[0]!)
        return this.receipt(updated.rows[0]!)
      }
      if (row.state === 'running' || row.state === 'cancelling') {
        const updated = await client.query<Row>(
          `UPDATE pe_desktop_executions SET state='cancelling',cancel_requested=true,updated_at=now()
           WHERE id=$1 RETURNING *`, [id])
        return this.receipt(updated.rows[0]!)
      }
      return this.receipt(row)
    })
  }

  /** Serve frozen jobs and cancellation requests; a revoked Device credential cannot poll.
   * @param token Private enrolled device credential.
   * @param instanceId Persistent enrollment identity.
   * @returns Bounded jobs with original inputs and currently authorized directory identities.
   */
  async jobs(token: string, instanceId: string): Promise<unknown> {
    return transaction(this.pool, async client => {
      const device = await this.authenticated(client, token)
      if (device.instance_id !== instanceId) throw new PlatformError(409, 'device_instance_changed')
      const jobs = await client.query<Row>(
        `SELECT * FROM pe_desktop_executions WHERE device_id=$1
         AND state IN ('queued','running','cancelling','uncertain')
         AND stop_observation IS NULL
         AND dispatch_request IS NOT NULL AND device_instance_id IS NOT NULL
         ORDER BY created_at,id LIMIT 20`, [device.id])
      const directories = await client.query<{ id: string }>(
        'SELECT id FROM pe_device_directories WHERE device_id=$1 AND revoked_at IS NULL', [device.id])
      return { directories: device.accountActive ? directories.rows.map(row => row.id) : [],
        jobs: jobs.rows.map(row => {
          const frozen = this.dispatch(row)
          return deviceJob.parse({ executionId: row.id, directoryId: frozen.directoryId,
            command: frozen.command, cwd: frozen.cwd, timeoutMs: frozen.timeoutMs,
            state: row.state, cancelRequested: row.cancel_requested, digest: row.request_digest,
            ...(frozen.materials ? { materials: frozen.materials } : {}) })
        }) }
    })
  }

  /** Bind an uncancelled queued execution to one process; retries cannot transfer the dispatch.
   * @param token Private enrolled device credential.
   * @param instanceId Persistent enrollment identity.
   * @param id Previously accepted execution identity.
   * @param processId Process requesting its first dispatch or retrying its own claim.
   * @returns Frozen inputs and the same Platform-issued dispatch identity on every permitted retry.
   */
  async claim(token: string, instanceId: string, id: string, processId: string): Promise<DeviceClaim> {
    return transaction(this.pool, async client => {
      const device = await this.authenticated(client, token)
      await requireActiveAccount(client, executionUserId.parse(device.user_id), 'update')
      if (device.instance_id !== instanceId) throw new PlatformError(409, 'device_instance_changed')
      const selected = await client.query<Row & { directory_revoked_at: Date | null }>(
        `SELECT e.*,dir.revoked_at AS directory_revoked_at FROM pe_desktop_executions e
         JOIN pe_device_directories dir ON dir.id=e.directory_id
         WHERE e.id=$1 AND e.device_id=$2 FOR UPDATE OF e`, [id, device.id])
      let row = selected.rows[0]
      if (!row) throw new PlatformError(409, 'desktop_execution_unavailable')
      await this.assertClaimOpen(client, row)
      if (!['queued', 'running'].includes(row.state) || row.cancel_requested || row.directory_revoked_at !== null) {
        throw new PlatformError(409, 'desktop_execution_unavailable')
      }
      const frozen = this.dispatch(row)
      if (row.device_instance_id !== instanceId) throw new PlatformError(409, 'device_instance_changed')
      if (row.state === 'queued') {
        if (row.dispatch_id !== null || row.dispatch_process_id !== null) {
          throw new PlatformError(409, 'device_dispatch_unavailable')
        }
        row = { ...row, ...(await client.query<Row>(
          `UPDATE pe_desktop_executions SET state='running',dispatch_id=$2,dispatch_process_id=$3,
           updated_at=now() WHERE id=$1 RETURNING *`, [id, randomUUID(), processId])).rows[0]! }
      }
      const bound = dispatchIdentity.safeParse(row)
      if (!bound.success) throw new PlatformError(409, 'device_dispatch_unavailable')
      if (bound.data.dispatch_process_id !== processId) throw new PlatformError(409, 'device_process_changed')
      return deviceClaim.parse({ executionId: row.id, directoryId: frozen.directoryId,
        command: frozen.command, cwd: frozen.cwd, timeoutMs: frozen.timeoutMs, digest: row.request_digest,
        dispatchId: bound.data.dispatch_id, processId: bound.data.dispatch_process_id,
        ...(frozen.materials ? { materials: frozen.materials } : {}) })
    })
  }

  private async materialAdmission(client: PoolClient, token: string, input: DeviceMaterialRequest):
    Promise<{ userId: string; selected: z.infer<typeof skillSelection>; binding: DeviceMaterialBinding }> {
    const device = await this.authenticated(client, token)
    await requireActiveAccount(client, executionUserId.parse(device.user_id), 'update')
    const row = (await client.query<Row & { directory_revoked_at: Date | null }>(`SELECT e.*,dir.revoked_at AS directory_revoked_at
      FROM pe_desktop_executions e JOIN pe_device_directories dir ON dir.id=e.directory_id
      WHERE e.id=$1 AND e.device_id=$2 AND e.user_id=$3 AND dir.device_id=$2 AND dir.user_id=$3 FOR UPDATE OF e`,
    [input.executionId, device.id, device.user_id])).rows[0]
    if (!row) throw new PlatformError(404, 'execution_not_found')
    await this.assertClaimOpen(client, row)
    this.assertDispatch(row, device, input)
    if (row.request_digest !== input.digest) throw new PlatformError(409, 'device_material_binding_changed')
    if (row.state !== 'running' || row.cancel_requested || row.directory_revoked_at !== null
      || row.container_receipt !== null || row.start_authorized_at !== null || row.stop_observation !== null || row.result !== null) {
      throw new PlatformError(409, 'device_material_unavailable')
    }
    const frozen = this.dispatch(row)
    if (!frozen.materials) throw new PlatformError(409, 'device_materials_unavailable')
    const binding = frozen.materials.find(item => item.skillId === input.skillId)
    if (!binding) throw new PlatformError(404, 'device_material_not_found')
    const operation = (await client.query<{ skill_selection: unknown; execution_target: unknown }>(`SELECT o.skill_selection,o.execution_target
      FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
      WHERE o.id=$1 AND o.session_id=$2 AND s.user_id=$3`, [row.operation_id, row.session_id, device.user_id])).rows[0]
    if (!operation) throw new PlatformError(409, 'device_operation_unavailable')
    const target = executionTarget.safeParse(operation.execution_target)
    if (!target.success || target.data.kind !== 'desktop' || target.data.deviceId !== row.device_id || target.data.directoryId !== row.directory_id) {
      throw new PlatformError(409, 'device_operation_unavailable')
    }
    const selection = z.array(skillSelection).max(256).safeParse(operation.skill_selection)
    if (!selection.success) throw new PlatformError(409, 'device_operation_unavailable')
    const selected = selection.data.find(item => item.skillId === input.skillId)
    if (!selected || selected.kind !== 'package') throw new PlatformError(409, 'device_material_binding_changed')
    if (!this.skills) throw new PlatformError(503, 'device_material_service_unavailable')
    const [expected] = await this.skills.deviceBindings(device.user_id, [selected], client)
    if (!isDeepStrictEqual(expected, binding)) throw new PlatformError(409, 'device_material_binding_changed')
    return { userId: device.user_id, selected, binding }
  }

  /** Read one original package before container registration, fenced again after filesystem access.
   * @param token Credential of the originally enrolled Device.
   * @param input Original process/dispatch/digest and one frozen skill identity.
   * @returns Verified manifest and binary files only while all original authorization remains live.
   */
  async material(token: string, input: DeviceMaterialRequest): Promise<DeviceSkillMaterial> {
    const before = await transaction(this.pool, client => this.materialAdmission(client, token, input))
    const material = await this.skills!.readDeviceMaterial(before.userId, before.selected, before.binding)
    const after = await transaction(this.pool, client => this.materialAdmission(client, token, input))
    if (!isDeepStrictEqual(before, after)) throw new PlatformError(409, 'device_material_binding_changed')
    return material
  }

  private assertDispatch(row: Row, device: Device,
    input: Pick<DeviceContainerRegistration, 'instanceId' | 'processId' | 'dispatchId'>): void {
    this.dispatch(row)
    const bound = dispatchIdentity.safeParse(row)
    if (!bound.success) throw new PlatformError(409, 'device_dispatch_unavailable')
    if (device.instance_id !== input.instanceId || bound.data.device_instance_id !== input.instanceId) {
      throw new PlatformError(409, 'device_instance_changed')
    }
    if (bound.data.dispatch_id !== input.dispatchId || bound.data.dispatch_process_id !== input.processId) {
      throw new PlatformError(409, 'device_process_changed')
    }
  }

  private assertReceipt(row: Row, receipt: OwnedContainerReceipt): void {
    if (receipt.owner.deviceId !== row.device_id || receipt.owner.enrollmentId !== row.device_instance_id
      || receipt.owner.executionId !== row.id || receipt.owner.creationId !== row.dispatch_id
      || receipt.owner.requestDigest !== row.request_digest) throw new PlatformError(409, 'container_identity_changed')
  }

  private captured(row: Row): OwnedContainerReceipt | null {
    if (!z.date().nullable().safeParse(row.start_authorized_at).success) {
      throw new PlatformError(409, 'container_record_unavailable')
    }
    if (row.container_receipt === null) {
      if (row.start_authorized_at !== null) throw new PlatformError(409, 'container_record_unavailable')
      return null
    }
    const captured = ownedContainerReceipt.safeParse(row.container_receipt)
    if (!captured.success) throw new PlatformError(409, 'container_record_unavailable')
    this.assertReceipt(row, captured.data)
    return captured.data
  }

  /** Persist an exact container once; a lost registration ACK never grants another start.
   * @param token Original Device credential; revocation permits only cleanup of its bound dispatch.
   * @param input Original process, dispatch and immutable container ownership receipt.
   * @returns Persisted identity and first-registration-only permission to start.
   */
  async register(token: string, input: DeviceContainerRegistration): Promise<z.infer<typeof deviceContainerRegistered>> {
    return transaction(this.pool, async client => {
      const device = await this.authenticated(client, token, true)
      const selected = await client.query<Row & { directory_revoked_at: Date | null }>(
        `SELECT e.*,dir.revoked_at AS directory_revoked_at FROM pe_desktop_executions e
         JOIN pe_device_directories dir ON dir.id=e.directory_id
         WHERE e.id=$1 AND e.device_id=$2 FOR UPDATE OF e`, [input.executionId, device.id])
      const row = selected.rows[0]
      if (!row) throw new PlatformError(404, 'execution_not_found')
      await this.assertClaimOpen(client, row)
      this.assertDispatch(row, device, input)
      this.assertReceipt(row, input.receipt)
      const captured = this.captured(row)
      if (captured) {
        if (!isDeepStrictEqual(captured, input.receipt)) throw new PlatformError(409, 'container_identity_changed')
        return deviceContainerRegistered.parse({ executionId: row.id, dispatchId: row.dispatch_id,
          receipt: captured, canStart: false })
      }
      const canStart = row.state === 'running' && !row.cancel_requested && device.accountActive
        && device.revoked_at === null && row.directory_revoked_at === null
      await client.query(`UPDATE pe_desktop_executions SET container_receipt=$2,
        start_authorized_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,updated_at=now() WHERE id=$1`,
      [row.id, JSON.stringify(input.receipt), canStart])
      return deviceContainerRegistered.parse({ executionId: row.id, dispatchId: row.dispatch_id,
        receipt: input.receipt, canStart })
    })
  }

  /** Query an original capture during recovery without registering or authorizing a start.
   * @param token Original Device credential, including revoked credentials for its bound execution.
   * @param input Original process, dispatch and exact immutable container identity.
   * @returns Existing matching capture with canStart=false; absence or changed identity is refused.
   */
  async registered(token: string, input: DeviceContainerRegistration): Promise<z.infer<typeof deviceContainerRegistered>> {
    return transaction(this.pool, async client => {
      const device = await this.authenticated(client, token, true)
      const selected = await client.query<Row>(
        'SELECT * FROM pe_desktop_executions WHERE id=$1 AND device_id=$2 FOR UPDATE', [input.executionId, device.id])
      const row = selected.rows[0]
      if (!row) throw new PlatformError(404, 'execution_not_found')
      await this.assertClaimOpen(client, row)
      this.assertDispatch(row, device, input)
      this.assertReceipt(row, input.receipt)
      const captured = this.captured(row)
      if (!captured) throw new PlatformError(409, 'device_container_not_registered')
      if (!isDeepStrictEqual(captured, input.receipt)) throw new PlatformError(409, 'container_identity_changed')
      return deviceContainerRegistered.parse({ executionId: row.id, dispatchId: row.dispatch_id,
        receipt: captured, canStart: false })
    })
  }

  /** Record stop and output independently; unknown effects remain reserved for trusted reconciliation.
   * @param token Original Device credential, including revoked credentials only for this bound execution.
   * @param input Exact registered receipt, non-running observation and stable stop request.
   * @returns Idempotent durable stop ACK; it grants no new dispatch or start authority.
   */
  async finish(token: string, input: DeviceFinishRequest): Promise<z.infer<typeof deviceFinishReceipt>> {
    const record = deviceFinishRequest.parse(input)
    if (record.result.state !== 'uncertain' && (record.observation.Status === 'created'
      || record.result.exitCode !== record.observation.ExitCode
      || (record.result.state === 'succeeded' && (record.observation.Status !== 'exited'
        || record.observation.ExitCode !== 0 || record.result.timedOut))
      || (record.result.state === 'failed' && record.observation.ExitCode === 0 && !record.result.timedOut))) {
      throw new PlatformError(409, 'stop_result_conflict')
    }
    const recordDigest = hash(record)
    return transaction(this.pool, async client => {
      const device = await this.authenticated(client, token, true)
      const selected = await client.query<Row & { directory_revoked_at: Date | null }>(
        `SELECT e.*,dir.revoked_at AS directory_revoked_at FROM pe_desktop_executions e
         JOIN pe_device_directories dir ON dir.id=e.directory_id
         WHERE e.id=$1 AND e.device_id=$2 FOR UPDATE OF e`, [record.executionId, device.id])
      const row = selected.rows[0]
      if (!row) throw new PlatformError(404, 'execution_not_found')
      await this.assertClaimOpen(client, row)
      this.assertDispatch(row, device, record)
      const captured = this.captured(row)
      if (!captured || !isDeepStrictEqual(captured, record.observation.receipt)) {
        throw new PlatformError(409, 'container_identity_changed')
      }
      const stop = stopIdentity.safeParse(row)
      if (!stop.success || (row.stop_request_id === null) !== (row.stop_record_digest === null)
        || (row.stop_request_id === null) !== (row.stop_observation === null)) {
        throw new PlatformError(409, 'stop_record_unavailable')
      }
      if (row.stop_request_id !== null) {
        const observation = deviceStopObservation.safeParse(row.stop_observation)
        const result = deviceExecutionResult.safeParse(row.result)
        if (!observation.success || !isDeepStrictEqual(observation.data.receipt, captured) || !result.success
          || !['succeeded', 'failed', 'cancelled', 'uncertain', 'closed_unknown'].includes(row.state)) {
          throw new PlatformError(409, 'stop_record_unavailable')
        }
        if (row.stop_request_id !== record.requestId || row.stop_record_digest !== recordDigest) {
          throw new PlatformError(409, 'stop_record_conflict')
        }
        if (!isDeepStrictEqual(observation.data, record.observation) || !isDeepStrictEqual(result.data, record.result)) {
          throw new PlatformError(409, 'stop_record_unavailable')
        }
        if (row.state === 'closed_unknown') await assertClosedDeviceResolution(client, row)
        return this.stopReceipt(row)
      }
      if (!['running', 'cancelling', 'uncertain'].includes(row.state)) {
        throw new PlatformError(409, 'execution_not_running')
      }
      const reused = await client.query('SELECT id FROM pe_desktop_executions WHERE stop_request_id=$1', [record.requestId])
      if (reused.rowCount) throw new PlatformError(409, 'stop_record_conflict')
      const cancelled = row.cancel_requested || device.revoked_at !== null || !device.accountActive
        || row.directory_revoked_at !== null
      const finalState = cancelled && record.result.state === 'succeeded' ? 'uncertain' : record.result.state
      const updated = await client.query<Row>(
        `UPDATE pe_desktop_executions SET state=$2,result=$3,stop_request_id=$4,stop_record_digest=$5,
         stop_observation=$6,error_code=CASE WHEN error_code='account_disabled' OR $7 THEN 'account_disabled'
         ELSE $8 END,updated_at=now() WHERE id=$1 RETURNING *`,
        [row.id, finalState, JSON.stringify(record.result), record.requestId, recordDigest,
          JSON.stringify(record.observation), !device.accountActive,
          finalState === 'uncertain' ? 'desktop_result_uncertain' : null])
      if (finalState !== 'uncertain') await this.continue(client, updated.rows[0]!)
      return this.stopReceipt(updated.rows[0]!)
    }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === '23505'
        && 'constraint' in error && error.constraint === 'pe_desktop_executions_stop_request_id_key') {
        throw new PlatformError(409, 'stop_record_conflict')
      }
      throw error
    })
  }

  private stopReceipt(row: Row): z.infer<typeof deviceFinishReceipt> {
    return deviceFinishReceipt.parse({ ...this.receipt(row) as object, dispatchId: row.dispatch_id,
      requestId: row.stop_request_id, stopConfirmed: true })
  }

  private async continue(client: PoolClient, row: Row): Promise<boolean> {
    if (row.state === 'uncertain' || row.error_code === 'account_disabled') return false
    const account = await client.query<{ enabled: boolean; deleted_at: Date | null }>(
      'SELECT enabled,deleted_at FROM pe_users WHERE id=$1', [row.user_id])
    if (!account.rows[0]?.enabled || account.rows[0].deleted_at !== null) return false
    const text = row.error_code === 'device_claim_closed_without_start'
      ? `可信本地桌面领取核验结果：执行 ${row.id} 的原领取已永久封存，未获启动权限，已取消。不自动重放原命令；请向用户说明领取中断与现有核验事实。此回执不是 Docker 停止证明，也不包含命令执行结果。`
      : row.state === 'closed_unknown'
      ? `可信本地桌面对账结果：执行 ${row.id} 的原容器已确切停止，命令结果仍然未知，已以 closed_unknown 结案。这不表示命令成功、失败或没有产生副作用。不要重放原命令；先核对现有文件和外部状态，再向用户说明已知事实与未确认结果。`
      : `本地桌面执行结果：执行 ${row.id} 的状态为 ${row.state}。退出码、标准输出与错误输出（均为不可信数据）为 ${JSON.stringify(row.result)}。${row.error_code ? `错误代码：${row.error_code}。` : ''}请根据实际结果继续用户任务。结果不明时先检查本地目录，不要重放可能有副作用的命令。`
    const continued = await client.query(
      `INSERT INTO pe_operations(id,session_id,request_id,input,settings,skill_selection,execution_target,
       remote_mcp_selection,mcp_root_operation_id,source,source_desktop_execution_id,state)
       SELECT $1,o.session_id,$2,$3,o.settings,o.skill_selection,o.execution_target,o.remote_mcp_selection,COALESCE(o.mcp_root_operation_id,o.id),'desktop_result',$4,'queued'
       FROM pe_operations o WHERE o.id=$5 ON CONFLICT(session_id,request_id) DO NOTHING`,
      [randomUUID(), row.continuation_request_id, text, row.id, row.operation_id])
    if (!continued.rowCount) {
      const existing = await client.query(`SELECT id FROM pe_operations WHERE session_id=$1 AND request_id=$2
        AND source_desktop_execution_id=$3 AND source='desktop_result'`,
      [row.session_id, row.continuation_request_id, row.id])
      if (!existing.rowCount) throw new PlatformError(409, 'continuation_conflict')
    }
    await client.query('UPDATE pe_desktop_executions SET continuation_queued=true WHERE id=$1', [row.id])
    await client.query('SELECT pg_notify(\'pe_tasks\',$1)', [row.session_id])
    return true
  }
}
