/** Accepted cloud commands use independently owned native ranges and retain their original receipt semantics. */
import { isDeepStrictEqual } from 'node:util'
import { posix } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, sessionId, workspaceId } from '../contracts.ts'
import { nativeExecutionServiceWorld } from '../native-execution/types.ts'
import { storageBinding } from './cloud-storage-types.ts'
import type { CloudResolutionCapture, CloudResolutionTransport } from './cloud-execution-resolution.ts'
import type { CloudResolutionTarget } from './sandbox.ts'
import { transaction } from './database.ts'
import { requireActiveAccount } from './account-authority.ts'
import { capturedRunnerRequest, cloudRunnerRequest, cloudRequestDigest, nativeCloudEnvironment,
  type CloudExecutionRow } from './cloud-execution-resolution-types.ts'
import type { NativeExecutionPlatform } from './native-execution-platform.ts'
import { NativeExecutionServiceAuthority, nativeExecutionServiceOwner,
  type NativeExecutionServiceReader } from './native-execution-service-authority.ts'
import { readNativeSessionExecutionPolicy } from './native-runtime-policy.ts'
import { isSessionOperationStoppedInTransaction } from './native-session-activity-stop.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'

const source = z.object({ id: z.uuid(), user_id: z.uuid(), session_id: z.uuid(), workspace_id: z.uuid(), operation_id: z.uuid(),
  request_digest: z.string(), command: z.string(), cwd: z.string(), result_delivery: z.enum(['continuation', 'native_tool']),
  command_timeout_ms: z.number().nullable(), native_tool_grant_digest: z.string().nullable(),
  native_tool_credential_version: z.number().nullable(), lease_owner: z.uuid().nullable(), lease_until: z.date().nullable(),
  state: z.string(), cancel_requested: z.boolean(), sandbox_name: z.string().nullable(), pod_uid: z.string().nullable(),
  runner_instance_id: z.uuid().nullable(), dispatch_request: z.unknown() })

/** Original physical command outcome; a lost SDK/process result remains a stopped unknown effect. */
export interface NativeCloudCommandResult {
  state: 'succeeded' | 'failed' | 'cancelled' | 'closed_unknown'
  result: {
    exitCode: number | null
    stdout: string
    stderr: string
    stdoutTruncated: boolean
    stderrTruncated: boolean
    timedOut: boolean
  } | null
  errorCode: string | null
}

/** One accepted command owns its native service marker before its admission transaction commits. */
export class NativeCloudCommands {
  private readonly owned = new Map<string, import('./native-execution-pods.ts').NativeExecutionPod>()
  private readonly broker
  private readonly authority: NativeExecutionServiceAuthority
  constructor(private readonly pool: Pool, physical: Pick<NativeExecutionPlatform, 'service'>, key: Uint8Array,
    private readonly defaultTimeoutMs: number, private readonly leaseMs: number) {
    this.broker = physical.service(this.read, key)
    if (!(this.broker.authority instanceof NativeExecutionServiceAuthority)) throw new Error('Native cloud command authority unavailable')
    this.authority = this.broker.authority
  }

  private deny(): never { throw new PlatformError(409, 'native_cloud_command_authority_lost') }
  private async original(client: Pool | PoolClient, id: string) {
    const row = (await client.query<Record<string, unknown>>(`SELECT e.*,s.workspace_id FROM pe_cloud_executions e
      JOIN pe_sessions s ON s.id=e.session_id AND s.user_id=e.user_id
      WHERE e.id=$1 AND e.execution_kind='legacy_command'`, [id])).rows[0]
    return source.parse(row)
  }
  private readonly read: NativeExecutionServiceReader = async (client, owner, purpose) => {
    if (owner.kind !== 'cloud-command' || owner.epoch !== 1 || String(owner.workerId) !== String(owner.id)) this.deny()
    const row = await this.original(client, owner.id)
    const account = await requireActiveAccount(client, owner.userId, 'update')
    if (row.user_id !== owner.userId || row.cancel_requested && purpose !== 'provision'
      || !['queued', 'starting', 'running', 'uncertain'].includes(row.state)
      || await isSessionOperationStoppedInTransaction(client, { userId: row.user_id, sessionId: row.session_id,
        operationId: row.operation_id })) this.deny()
    const admission = { command: row.command, cwd: row.cwd, timeoutMs: row.command_timeout_ms ?? this.defaultTimeoutMs,
      ...(row.result_delivery === 'native_tool' ? { outputMode: 'tail', dshEnv: nativeCloudEnvironment(row.session_id) } : {}) }
    if (cloudRequestDigest(admission) !== row.request_digest) this.deny()
    let expiry = row.lease_until
    if (purpose === 'provision' && row.state === 'queued' && row.lease_owner === null) {
      expiry = (await client.query<{ until: Date }>("SELECT clock_timestamp()+$1::double precision*interval '1 millisecond' AS until",
        [this.leaseMs])).rows[0]?.until ?? null
    } else {
      const lease = await client.query('SELECT id FROM pe_cloud_executions WHERE id=$1 AND lease_owner IS NOT NULL AND lease_until>clock_timestamp()',
        [row.id])
      if (!lease.rowCount) this.deny()
    }
    if (!expiry) this.deny()
    if (row.result_delivery === 'native_tool') {
      const grant = await client.query(`SELECT s.id FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id
        WHERE s.id=$1 AND s.user_id=$2 AND o.id=$3 AND o.state='running' AND s.grant_digest=$4
        AND s.lease_until>clock_timestamp()`, [row.session_id, row.user_id, row.operation_id, row.native_tool_grant_digest])
      if (account.credentialVersion !== row.native_tool_credential_version || !grant.rowCount) this.deny()
    }
    const policy = await readNativeSessionExecutionPolicy(client, row.session_id, row.operation_id)
    return { sessionId: sessionId.parse(row.session_id), workspaceId: workspaceId.parse(row.workspace_id), ...policy,
      expiresAt: expiry, source: { formatVersion: 1, executionId: row.id, requestDigest: row.request_digest,
        resultDelivery: row.result_delivery, nativeGrant: row.native_tool_grant_digest,
        credentialVersion: row.native_tool_credential_version } }
  }

  /** Retain provider choice and its exact permission/storage source in the original acceptance transaction.
   * @param client Original account, Session and execution admission transaction.
   * @param row Just-accepted immutable command; no worker or program is started.
   */
  async admit(client: PoolClient, row: CloudExecutionRow): Promise<void> {
    await this.authority.issueInTransaction(client, nativeExecutionServiceOwner.parse({ userId: row.user_id,
      kind: 'cloud-command', id: row.id, epoch: 1, workerId: row.id }))
  }

  /** Distinguish an explicitly admitted native command from retained historical Runner identities.
   * @param row Original durable execution selected by the command worker.
   * @returns True only for its committed native service marker; old identities stay on original reconciliation.
   */
  async owns(row: CloudExecutionRow): Promise<boolean> {
    const found = await this.pool.query(`SELECT id FROM pe_native_execution_services
      WHERE authority_kind='cloud-command' AND authority_id=$1`, [row.id])
    return found.rowCount === 1
  }

  private async resolutionResource(client: PoolClient, execution: CloudResolutionCapture) {
    const found = await client.query<Record<string, unknown>>(`SELECT p.id,p.pod_name,p.pod_uid,p.namespace,
      w.binding_snapshot AS binding,jsonb_build_object('worldId',w.id,'userId',w.user_id,'sessionId',w.session_id,
      'workspaceId',w.workspace_id,'mode',w.mode,'storageGeneration',w.storage_generation,
      'permissionGeneration',w.permission_generation,'workspaceRoot','/workspace','homeRoot','/home/agent',
      'serviceId',w.service_id,'serviceEpoch',w.service_epoch,'authorityKind',w.authority_kind) AS world
      FROM pe_native_execution_services s JOIN pe_native_execution_worlds w ON w.service_id=s.id
      JOIN pe_native_execution_processes p ON p.world_id=w.id AND p.id=s.authority_id
      WHERE s.authority_kind='cloud-command' AND s.authority_id=$1 FOR UPDATE OF s,w,p`, [execution.executionId])
    const value = z.object({ id: z.uuid(), pod_name: z.string(), pod_uid: z.uuid(), namespace: z.string(),
      world: nativeExecutionServiceWorld, binding: storageBinding }).safeParse(found.rows[0])
    if (!value.success) throw new PlatformError(409, 'native_cloud_resolution_identity_incomplete')
    const original = value.data, world = original.world
    if (world.userId !== execution.userId || String(world.sessionId) !== execution.sessionId
      || original.id !== execution.executionId || execution.runnerInstanceId !== original.id
      || original.pod_uid !== execution.podUid || original.pod_name !== execution.name
      || original.namespace !== this.broker.pods.config.namespace) {
      throw new PlatformError(409, 'native_cloud_resolution_identity_changed')
    }
    const target: CloudResolutionTarget = { userId: world.userId, sessionId: world.sessionId,
      workspaceId: world.workspaceId, generation: String(world.storageGeneration), name: original.pod_name,
      podUid: original.pod_uid, runnerInstanceId: original.id, binding: original.binding }
    return { target, range: { id: original.id, uid: original.pod_uid, name: original.pod_name, world } }
  }

  /** Keep the existing independent approval and receipt API over the exact native process rather than a mount slot.
   * @param legacy Historical captured Sandbox reconciliation; native ownership is selected only by its immutable marker.
   * @returns Cleanup-only transport; missing native command output remains unknown and no invocation is dispatched.
   */
  resolutionTransport(legacy: CloudResolutionTransport): CloudResolutionTransport {
    const owns = async (client: Pool | PoolClient, id: string) => (await client.query(`SELECT id FROM pe_native_execution_services
      WHERE authority_kind='cloud-command' AND authority_id=$1`, [id])).rowCount === 1
    return {
      captureExecutionResolution: async (client, execution) => await owns(client, execution.executionId)
        ? (await this.resolutionResource(client, execution)).target : legacy.captureExecutionResolution(client, execution),
      observeExecutionResolution: async (target, id) => await owns(this.pool, id)
        ? null : legacy.observeExecutionResolution(target, id),
      stopForExecutionResolution: async (target, requestId, fence, finalize) => {
        if (!await owns(this.pool, target.runnerInstanceId)) {
          return legacy.stopForExecutionResolution(target, requestId, fence, finalize)
        }
        const capture = async (client: PoolClient) => {
          await fence(client)
          const original = await this.resolutionResource(client, { executionId: target.runnerInstanceId,
            userId: target.userId, sessionId: target.sessionId, name: target.name,
            podUid: target.podUid, runnerInstanceId: target.runnerInstanceId })
          if (!isDeepStrictEqual(original.target, target)) throw new PlatformError(409, 'native_cloud_resolution_identity_changed')
          const intent = await client.query(`SELECT id FROM pe_cloud_execution_resolutions WHERE execution_id=$1
            AND request_id=$2 AND user_id=$3 AND session_id=$4 AND pod_uid=$5 AND runner_instance_id=$1
            AND sandbox_name=$6 AND binding_snapshot=$7::jsonb`, [target.runnerInstanceId, requestId,
            target.userId, target.sessionId, target.podUid, target.name, target.binding])
          if (intent.rowCount !== 1) throw new PlatformError(409, 'native_cloud_resolution_identity_changed')
          return original
        }
        const original = await transaction(this.pool, capture)
        await fence()
        await this.broker.pods.stop(original.range, 'abort')
        await transaction(this.pool, async (client) => {
          await capture(client)
          const found = await client.query<{ state: string; stop_evidence: unknown }>(
            'SELECT state,stop_evidence FROM pe_native_execution_processes WHERE id=$1 AND world_id=$2 FOR UPDATE',
            [original.range.id, original.range.world.worldId])
          const process = found.rows[0], proof = z.object({ processId: z.literal(original.range.id),
            worldId: z.literal(original.range.world.worldId), podUid: z.literal(original.range.uid),
            resourceReleased: z.literal(true), observation: z.unknown(), status: z.string() }).loose().safeParse(process?.stop_evidence)
          if (process?.state !== 'stopped' || !proof.success
            || kubernetesPodStopStatus(proof.data.observation) !== proof.data.status) this.deny()
          await finalize(client, proof.data)
        })
        this.owned.delete(original.range.id)
      },
    }
  }

  /** Execute only the original accepted command or reconcile its original native admission without replay.
   * @param row Original immutable cloud execution.
   * @param worker Original current command worker.
   * @param fence Original worker lease, rechecked before every physical action and lifecycle observation.
   * @param signal Supervisor shutdown; completion joins the entire original native range.
   * @returns Bounded process facts after positive exact stop, or a stopped unknown effect after output loss.
   */
  async run(row: CloudExecutionRow, worker: string, fence: () => Promise<void>, signal: AbortSignal): Promise<NativeCloudCommandResult> {
    const interrupted = () => signal.aborted
    await fence()
    const saved = await this.pool.query<{ world: unknown }>(`SELECT jsonb_build_object('worldId',w.id,'userId',w.user_id,
      'sessionId',w.session_id,'workspaceId',w.workspace_id,'mode',w.mode,'storageGeneration',w.storage_generation,
      'permissionGeneration',w.permission_generation,'workspaceRoot','/workspace','homeRoot','/home/agent',
      'serviceId',w.service_id,'serviceEpoch',w.service_epoch,'authorityKind',w.authority_kind) AS world
      FROM pe_native_execution_worlds w JOIN pe_native_execution_services s ON s.id=w.service_id
      WHERE s.authority_kind='cloud-command' AND s.authority_id=$1`, [row.id])
    const world = nativeExecutionServiceWorld.parse(saved.rows[0]?.world)
    const prior = await this.broker.pods.original(world, row.id)
    const unknown = (): NativeCloudCommandResult => ({ state: 'closed_unknown', result: null,
      errorCode: 'native_cloud_command_outcome_unknown' })
    if (prior) {
      await this.broker.pods.stop(prior, 'failure')
      return unknown()
    }
    const initial = await this.original(this.pool, row.id)
    if (initial.cancel_requested || interrupted()) return { state: 'cancelled', result: null, errorCode: null }
    const issued = await this.authority.issue(nativeExecutionServiceOwner.parse({ userId: row.user_id,
      kind: 'cloud-command', id: row.id, epoch: 1, workerId: row.id }))
    const range = await this.broker.pods.create(world, issued.binding, 'process', { kind: 'cloud-command-preparation',
      executionId: row.id, requestDigest: row.request_digest }, async () => { await fence()
      return this.authority.assert(issued.token, world, 'storage-read') }, row.id, true)
    this.owned.set(range.id, range)
    await fence()
    const timeoutMs = row.command_timeout_ms ?? this.defaultTimeoutMs
    const request = cloudRunnerRequest.parse({ id: row.id, command: row.command, cwd: row.cwd, timeoutMs, instanceId: row.id,
      ...(row.result_delivery === 'native_tool' ? { outputMode: 'tail', dshEnv: nativeCloudEnvironment(row.session_id) } : {}) })
    const captured = { ...row, runner_instance_id: row.id, dispatch_request: request }
    if (!capturedRunnerRequest(captured, this.defaultTimeoutMs)) this.deny()
    const recorded = await this.pool.query(`UPDATE pe_cloud_executions SET sandbox_name=$3,pod_uid=$4,runner_instance_id=$1,
      dispatch_request=$5,state='running',updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2
      AND lease_until>clock_timestamp() AND cancel_requested=false AND sandbox_name IS NULL AND dispatch_request IS NULL RETURNING id`,
    [row.id, worker, range.name, range.uid, request])
    if (recorded.rowCount !== 1) { await this.broker.pods.stop(range, 'abort'); return unknown() }
    let timedOut = false
    const deadline = new AbortController(), timer = setTimeout(() => { timedOut = true; deadline.abort() }, timeoutMs)
    try {
      const handle = this.broker.spawn(issued.token, world, { argv: ['/bin/bash', '-c', request.command],
        cwd: posix.resolve('/workspace', request.cwd), graceMs: this.broker.config.transportGraceMs,
        env: request.dshEnv, signal: AbortSignal.any([signal, deadline.signal]),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } } },
      'process', false, row.id, range, fence)
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0), stderr = handle.collected.stderr?.readFrom(0)
      const current = await this.original(this.pool, row.id)
      return { state: current.cancel_requested || interrupted() ? 'cancelled' : outcome.exitCode === 0 ? 'succeeded' : 'failed',
        result: { exitCode: outcome.exitCode, stdout: stdout?.text ?? '', stderr: stderr?.text ?? '',
          stdoutTruncated: stdout?.lossy ?? false, stderrTruncated: stderr?.lossy ?? false, timedOut }, errorCode: null }
    } catch (error) {
      const found = await this.pool.query<{ state: string; stop_evidence: unknown }>('SELECT state,stop_evidence FROM pe_native_execution_processes WHERE id=$1', [row.id])
      const original = found.rows[0]
      const proof = z.object({ podUid: z.literal(range.uid), worldId: z.literal(world.worldId), processId: z.literal(row.id),
        status: z.string(), resourceReleased: z.literal(true), observation: z.unknown() }).loose().safeParse(original?.stop_evidence)
      if (!original || original.state !== 'stopped' || !proof.success
        || kubernetesPodStopStatus(proof.data.observation) !== proof.data.status) throw error
      return unknown()
    } finally { clearTimeout(timer)
      const stopped = await this.pool.query("SELECT id FROM pe_native_execution_processes WHERE id=$1 AND state='stopped' AND stop_evidence->>'resourceReleased'='true'", [row.id])
      if (stopped.rowCount) this.owned.delete(row.id) }
  }

  /** Join every original preparation after the command supervisor has stopped admitting and joined its workers.
   * @returns Completion after positive native stop and finalizer release for every retained original UID.
   */
  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.owned.values()].map(range => this.broker.pods.stop(range, 'dispose')))
    const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Native cloud command disposal failed')
    this.owned.clear()
  }

}
