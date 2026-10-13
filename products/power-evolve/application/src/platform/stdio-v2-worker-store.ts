/** Short ordered Cloud worker transactions retain original writers through cancellation and uncertainty. */
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioApprovalBindingV2, stdioDigestV2, stdioDispatchV2, stdioExecutionRefV2, stdioInvocationV2, stdioJsonV2,
  stdioLimitsV2, stdioPreparedV2, stdioStartPermitV2, stdioTaskSchemasV2,
  type StdioDigestV2, type StdioDispatchV2, type StdioExecutionRefV2, type StdioLimitsV2, type StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioActionLeaseV2, stdioWorkerIdV2, type StdioActionLeaseV2, type StdioWorkerIdV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioCatalogFingerprintV2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { accountUserId } from '../account-contracts.ts'
import { PlatformError } from '../contracts.ts'
import { transaction } from './database.ts'
import type { SandboxReady } from './sandbox.ts'
import type { StdioPreparationViewV2 } from './stdio-v2-authorization.ts'
import type { StdioCallContinuationV2 } from './stdio-v2-continuations.ts'
import { readStdioCallRootAuthorityV2, stdioRecordDigestsV2, lockStdioActionAccountV2 } from './stdio-v2-call-authority.ts'
import { assertStdioActionLeaseV2 } from './stdio-v2-leases.ts'
import { storageBinding } from './cloud-storage-types.ts'
import { parseStdioNoStartReceiptV2, stdioCreationStopEvidenceV2,
  type StdioNoStartReceiptV2, type StdioNoStartResourceV2 } from './stdio-v2-no-start.ts'

const uuid = z.uuid(), digest = stdioDigestV2, text = z.string().min(1).refine(value => !value.includes('\0'))
const actionRow = z.object({ id: uuid, user_id: accountUserId, session_id: uuid, connection_id: uuid,
  config_revision: z.number().int().positive(), config_digest: digest, execution_target: z.literal('cloud'), execution_id: uuid,
  phase: z.enum(['discover', 'call']), task: z.unknown(), task_digest: digest, state: text, cancel_requested: z.boolean(),
  request_id: uuid.nullable(), root_operation_id: uuid.nullable(), operation_id: uuid.nullable(), call_id: text.nullable(),
  continuation_request_id: uuid.nullable(), lease_owner: uuid.nullable(), lease_until: z.date().nullable(),
  lease_epoch: z.coerce.number().int().nonnegative() })
const executionRow = z.object({ id: uuid, user_id: accountUserId, session_id: uuid, execution_kind: z.literal('stdio_v2'),
  execution_target: z.literal('cloud'), task_version: z.literal(2), stdio_action_id: uuid, stdio_phase: z.enum(['discover', 'call']),
  stdio_task: z.unknown(), request_digest: digest, origin_kind: z.enum(['operation', 'stdio_discovery']),
  operation_id: uuid.nullable(), call_id: text.nullable(), continuation_request_id: uuid.nullable(), command: z.null(), cwd: z.null(),
  state: text, cancel_requested: z.boolean(), sandbox_name: text.nullable(), pod_uid: uuid.nullable(), runner_instance_id: uuid.nullable(),
  lease_owner: uuid.nullable(), lease_until: z.date().nullable() })
const connectionRow = z.object({ id: uuid, user_id: accountUserId, revision: z.number().int().positive(),
  enabled: z.boolean(), current_catalog_id: uuid.nullable(), deleted_at: z.date().nullable() })
const activeExecutions = ['queued', 'starting', 'running', 'cancelling', 'uncertain']
const workStates = ['queued', 'preparing', 'pending', 'approved', 'dispatch-intent', 'running', 'stopping', 'blocked', 'rejected', 'expired']
const guard = `EXISTS(SELECT 1 FROM pe_stdio_v2_actions a WHERE a.id=$1 AND a.lease_owner=$2
  AND a.lease_epoch=$3 AND a.lease_until>clock_timestamp())`

/** Original task and writer for one internal Cloud worker; this view grants no executor start. */
export interface StdioCloudWorkerSnapshotV2 {
  readonly task: StdioTaskV2
  readonly taskDigest: StdioDigestV2
  readonly executionRef: Extract<StdioExecutionRefV2, { kind: 'cloud' }>
  readonly state: string
  readonly cancelRequested: boolean
  readonly prepared: StdioPreparationViewV2 | null
  readonly dispatch: StdioDispatchV2 | null
  readonly writer: { readonly name: string; readonly podUid: string; readonly runnerInstanceId: string } | null
}

/** Trusted worker storage; Kube observation callbacks stay bounded inside the original locked transaction. */
export class StdioCloudWorkerStoreV2 {
  private readonly digests: ReturnType<typeof stdioRecordDigestsV2>
  private readonly limits: StdioLimitsV2
  private readonly schemas: ReturnType<typeof stdioTaskSchemasV2>
  private readonly options: { leaseMs: number; maxActive: number; maxCandidates: number }
  private readonly continuation: Pick<StdioCallContinuationV2, 'enqueueLeased'> | undefined
  constructor(private readonly pool: Pool, options: { limits: StdioLimitsV2
    leaseMs: number
    maxActive: number
    maxCandidates: number
    continuation?: Pick<StdioCallContinuationV2, 'enqueueLeased'> }) {
    this.limits = stdioLimitsV2.parse(options.limits)
    this.digests = stdioRecordDigestsV2(this.limits)
    for (const value of [options.leaseMs, options.maxActive, options.maxCandidates]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new TypeError('stdio_v2_worker_options_invalid')
    }
    this.options = { leaseMs: options.leaseMs, maxActive: options.maxActive, maxCandidates: options.maxCandidates }
    this.continuation = options.continuation
    this.schemas = stdioTaskSchemasV2(this.limits)
  }
  private deny(code: string): never { throw new PlatformError(409, code) }
  private async write(client: PoolClient, lease: StdioActionLeaseV2, sql: string, values: readonly unknown[]): Promise<void> {
    const changed = await client.query<Record<string, unknown>>(sql, [lease.actionId, lease.workerId, lease.leaseEpoch, ...values])
    if (changed.rowCount !== 1) this.deny('stdio_v2_lease_lost')
    await assertStdioActionLeaseV2(client, lease)
  }
  private async read(client: PoolClient, id: StdioActionLeaseV2['actionId']) {
    const hint = z.object({ user_id: accountUserId, session_id: uuid, connection_id: uuid }).parse(
      (await client.query<Record<string, unknown>>(
        'SELECT user_id,session_id,connection_id FROM pe_stdio_v2_actions WHERE id=$1', [id])).rows[0])
    const account = await lockStdioActionAccountV2(client, hint.user_id)
    const session = z.object({ id: uuid, user_id: accountUserId, workspace_id: uuid }).parse((await client.query<Record<string, unknown>>(
      'SELECT id,user_id,workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [hint.session_id, hint.user_id])).rows[0])
    const connection = connectionRow.parse((await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_connections WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [hint.connection_id, hint.user_id])).rows[0])
    const action = actionRow.parse((await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_actions WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, hint.user_id])).rows[0])
    const execution = executionRow.parse((await client.query<Record<string, unknown>>('SELECT * FROM pe_cloud_executions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [action.execution_id, hint.user_id])).rows[0])
    const task = this.schemas.task.parse(action.task), executionRef = stdioExecutionRefV2.options[0].parse({ kind: 'cloud', executionId: execution.id })
    if (action.id !== id || action.user_id !== account.userId || action.session_id !== session.id || session.user_id !== account.userId
      || action.connection_id !== connection.id || connection.user_id !== account.userId
      || task.actionId !== action.id || task.userId !== account.userId
        || task.sessionId !== session.id || task.connectionId !== connection.id
      || task.configRevision !== action.config_revision || task.configDigest !== action.config_digest || task.phase !== action.phase
      || task.scopeBinding.workspaceId !== session.workspace_id || this.digests.sha('task', task) !== action.task_digest
      || execution.id !== action.execution_id || execution.user_id !== account.userId || execution.session_id !== session.id
      || execution.stdio_action_id !== action.id || execution.stdio_phase !== task.phase || execution.request_digest !== action.task_digest
      || !this.digests.same(execution.stdio_task, task) || execution.operation_id !== action.operation_id
      || execution.call_id !== action.call_id
      || execution.continuation_request_id !== action.continuation_request_id) this.deny('stdio_v2_original_changed')
    if (task.phase === 'discover' ? action.request_id !== task.origin.requestId || execution.origin_kind !== 'stdio_discovery'
      || action.root_operation_id !== null || action.operation_id !== null
        || action.call_id !== null || action.continuation_request_id !== null
      : action.request_id !== null || action.root_operation_id !== task.origin.rootOperationId
        || action.operation_id !== task.origin.operationId
        || action.call_id !== task.origin.callKey || action.continuation_request_id === null || execution.origin_kind !== 'operation'
        || stdioCatalogFingerprintV2(task.selection.rawCatalog, this.limits) !== task.selection.catalogDigest) this.deny('stdio_v2_origin_changed')
    const configuration = z.object({ configuration: stdioJsonV2(this.digests.budget).pipe(z.object({ name: text,
      invocation: stdioInvocationV2 }).strict()),
    config_digest: digest }).parse((await client.query<Record<string, unknown>>('SELECT configuration,config_digest FROM pe_stdio_v2_configurations WHERE connection_id=$1 AND user_id=$2 AND revision=$3',
      [connection.id, account.userId, action.config_revision])).rows[0])
    if (configuration.config_digest !== action.config_digest || this.digests.sha('configuration', configuration.configuration) !== action.config_digest
      || !this.digests.same(configuration.configuration.invocation, task.invocation)) this.deny('stdio_v2_configuration_changed')
    const parts = [execution.sandbox_name, execution.pod_uid, execution.runner_instance_id]
    if (parts.some(value => value !== null) && parts.some(value => value === null)) this.deny('stdio_v2_writer_changed')
    const writer = execution.sandbox_name && execution.pod_uid && execution.runner_instance_id
      ? { name: execution.sandbox_name, podUid: execution.pod_uid, runnerInstanceId: execution.runner_instance_id } : null
    const rawPreparation = (await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_preparations WHERE action_id=$1', [id])).rows[0]
    let prepared: StdioPreparationViewV2 | null = null
    if (rawPreparation) {
      const p = z.object({ action_id: uuid, user_id: accountUserId, session_id: uuid, phase: z.enum(['discover', 'call']), execution_target: z.literal('cloud'),
        execution_id: uuid, task_digest: digest, prepared: stdioJsonV2(this.digests.budget).pipe(stdioPreparedV2), prepared_digest: digest,
        approval_binding: stdioApprovalBindingV2, fingerprint: digest,
        approval_epoch: z.literal(1), expires_at: z.date() }).parse(rawPreparation)
      const value = p.prepared, binding = p.approval_binding
      if (p.action_id !== id || p.user_id !== account.userId || p.session_id !== session.id || p.phase !== task.phase
        || p.execution_id !== execution.id || p.task_digest !== action.task_digest
          || value.actionId !== id || value.taskDigest !== action.task_digest
        || !this.digests.same(value.executionRef, executionRef) || !this.digests.same(value.scopeBinding, task.scopeBinding)
        || !this.digests.same(value.expectedDeploymentPin, task.expectedDeploymentPin) || this.digests.sha('prepared', value) !== p.prepared_digest
        || binding.actionId !== id || binding.taskDigest !== action.task_digest || binding.preparedDigest !== p.prepared_digest
        || binding.expiresAt !== p.expires_at.toISOString() || !writer
        || value.capture.podName !== writer.name || value.capture.podUid !== writer.podUid
          || value.capture.runnerInstanceId !== writer.runnerInstanceId
        || value.fullScopeDigest !== this.digests.sha('scope', { scopeBinding: value.scopeBinding, workspaceMount: value.capture.workspaceMount, homeMount: value.capture.homeMount })
        || task.phase === 'call' && !this.digests.same(value.actualExecutorImage, task.selection.catalogImageExpectation)) this.deny('stdio_v2_preparation_changed')
      prepared = { prepared: value, taskDigest: p.task_digest,
        preparedDigest: p.prepared_digest, fingerprint: p.fingerprint,
        approvalEpoch: 1, expiresAt: binding.expiresAt }
    }
    const rawPermit = (await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_start_permits WHERE action_id=$1', [id])).rows[0]
    const rawDispatch = (await client.query<Record<string, unknown>>('SELECT dispatch,dispatch_digest FROM pe_stdio_v2_dispatches WHERE action_id=$1', [id])).rows[0]
    let dispatch: StdioDispatchV2 | null = null
    if (rawPermit || rawDispatch) {
      if (!rawPermit || !rawDispatch || !prepared || !writer) this.deny('stdio_v2_dispatch_changed')
      const row = z.object({ action_id: uuid, permit_id: uuid, authorization_request_id: uuid, execution_id: uuid,
        task_digest: digest, prepared_digest: digest, fingerprint: digest, decision: z.literal('once'),
        permit: stdioStartPermitV2, executor_owner: stdioStartPermitV2.shape.executorOwner,
        issued_at: z.date(), expires_at: z.date() }).parse(rawPermit)
      const p = row.permit, decision = z.object({ user_id: accountUserId, fingerprint: digest, decision: z.literal('once') }).parse(
        (await client.query<Record<string, unknown>>('SELECT user_id,fingerprint,decision FROM pe_stdio_v2_decisions WHERE action_id=$1', [id])).rows[0])
      if (decision.user_id !== account.userId || decision.fingerprint !== prepared.fingerprint
        || row.action_id !== id || row.execution_id !== execution.id
        || row.permit_id !== p.permitId || row.authorization_request_id !== p.authorizationRequestId
          || row.task_digest !== prepared.taskDigest
        || row.prepared_digest !== prepared.preparedDigest || row.fingerprint !== prepared.fingerprint || p.actionId !== id
        || p.taskDigest !== prepared.taskDigest || p.preparedDigest !== prepared.preparedDigest
          || p.approvalFingerprint !== prepared.fingerprint
        || !this.digests.same(p.executionRef, executionRef) || !this.digests.same(p.executorOwner, row.executor_owner)
        || p.executorOwner.runnerInstanceId !== writer.runnerInstanceId
        || p.expiresAt !== prepared.expiresAt || p.expiresAt !== row.expires_at.toISOString() || p.issuedAt !== row.issued_at.toISOString()) this.deny('stdio_v2_permit_changed')
      const saved = z.object({ dispatch: stdioDispatchV2(this.limits), dispatch_digest: digest }).parse(rawDispatch)
      if (this.digests.sha('dispatch', saved.dispatch) !== saved.dispatch_digest || !this.digests.same(saved.dispatch.task, task)
        || saved.dispatch.taskDigest !== action.task_digest || saved.dispatch.preparedDigest !== prepared.preparedDigest
        || !this.digests.same(saved.dispatch.executionRef, executionRef) || !this.digests.same(saved.dispatch.permit, p)) this.deny('stdio_v2_dispatch_changed')
      dispatch = saved.dispatch
    } else if (['dispatch-intent', 'running'].includes(action.state)) this.deny('stdio_v2_dispatch_missing')
    const now = z.date().parse((await client.query<Record<string, unknown>>('SELECT clock_timestamp() AS now')).rows[0]?.now)
    const root = await readStdioCallRootAuthorityV2(client, task)
    const cancelRequested = action.cancel_requested || execution.cancel_requested || !account.enabled || !!account.deletedAt
      || !!connection.deleted_at || connection.revision !== action.config_revision || ['rejected', 'expired'].includes(action.state)
      || !dispatch && prepared !== null && Date.parse(prepared.expiresAt) <= now.getTime()
      || task.phase === 'call' && (!connection.enabled || connection.current_catalog_id !== task.selection.catalogId)
      || root !== null && !root.active
    return { account, action, execution, task, executionRef, connection, prepared, dispatch, writer, cancelRequested }
  }
  private async current(client: PoolClient, lease: StdioActionLeaseV2) {
    const original = await this.read(client, lease.actionId)
    await assertStdioActionLeaseV2(client, lease)
    if (activeExecutions.includes(original.execution.state) && (original.execution.lease_owner !== lease.workerId
      || !original.execution.lease_until || original.execution.lease_until.getTime() !== original.action.lease_until?.getTime())) this.deny('stdio_v2_lease_lost')
    return original
  }
  private async mirror(client: PoolClient, lease: StdioActionLeaseV2, executionId: string): Promise<void> {
    await this.write(client, lease, `UPDATE pe_cloud_executions SET lease_owner=$2,
      lease_until=(SELECT lease_until FROM pe_stdio_v2_actions WHERE id=$1),updated_at=clock_timestamp()
      WHERE id=$4 AND execution_kind='stdio_v2' AND stdio_action_id=$1
        AND (lease_owner IS NULL OR lease_owner=$2 OR lease_until<=clock_timestamp()) AND ${guard}`, [executionId])
  }
  private startable(original: Awaited<ReturnType<StdioCloudWorkerStoreV2['read']>>) {
    const recovering = original.action.state === 'blocked' && original.execution.state === 'uncertain'
      && !original.prepared && !original.dispatch
    if (original.cancelRequested || !recovering && (!['queued', 'preparing'].includes(original.action.state)
      || !['queued', 'starting'].includes(original.execution.state))) this.deny('stdio_v2_action_not_startable')
  }
  private async ready(client: PoolClient, original: Awaited<ReturnType<StdioCloudWorkerStoreV2['read']>>, ready: SandboxReady): Promise<void> {
    const scope = original.task.scopeBinding
    const slot = z.object({ user_id: accountUserId, session_id: uuid,
      workspace_id: uuid, generation: z.coerce.string().regex(/^(0|[1-9][0-9]*)$/u),

      state: z.literal('ready'), pod_uid: uuid, runner_instance_id: uuid, binding_snapshot: storageBinding }).parse(
      (await client.query<Record<string, unknown>>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [original.account.userId])).rows[0])
    const instance = z.object({ session_id: uuid, user_id: accountUserId, name: text, state: z.literal('ready'), pod_uid: uuid,
      runner_instance_id: uuid, binding_snapshot: storageBinding }).parse((await client.query<Record<string, unknown>>(
      'SELECT * FROM pe_sandbox_instances WHERE session_id=$1 AND user_id=$2 FOR UPDATE', [original.action.session_id, original.account.userId])).rows[0])
    const binding = storageBinding.parse(ready.binding)
    if (ready.userId !== original.account.userId || ready.sessionId !== original.action.session_id || !text.safeParse(ready.name).success
      || !uuid.safeParse(ready.podUid).success || !uuid.safeParse(ready.runnerInstanceId).success
      || slot.user_id !== ready.userId || slot.session_id !== ready.sessionId || slot.workspace_id !== scope.workspaceId
      || slot.generation !== ready.generation || slot.pod_uid !== ready.podUid || slot.runner_instance_id !== ready.runnerInstanceId
      || instance.user_id !== ready.userId || instance.session_id !== ready.sessionId || instance.name !== ready.name
      || instance.pod_uid !== ready.podUid || instance.runner_instance_id !== ready.runnerInstanceId
      || binding.workspaceId !== scope.workspaceId || binding.generation !== scope.bindingGeneration
      || binding.spaceId !== scope.target.spaceId || binding.rootRelativePath !== scope.target.rootRelativePath
      || !this.digests.same(binding, slot.binding_snapshot) || !this.digests.same(binding, instance.binding_snapshot)
      || original.prepared
        && original.prepared.prepared.capture.mountGeneration !== ready.generation
      || original.writer && (original.writer.name !== ready.name || original.writer.podUid !== ready.podUid
        || original.writer.runnerInstanceId !== ready.runnerInstanceId)) this.deny('stdio_v2_writer_changed')
  }
  private async noStartResult(client: PoolClient, id: StdioActionLeaseV2['actionId']): Promise<void> {
    if ((await client.query<Record<string, unknown>>('SELECT action_id FROM pe_stdio_v2_results WHERE action_id=$1', [id])).rowCount) {
      this.deny('stdio_v2_start_already_authorized')
    }
  }
  private async storedClosure(client: PoolClient, o: Awaited<ReturnType<StdioCloudWorkerStoreV2['read']>>): Promise<StdioNoStartReceiptV2 | null> {
    const raw = (await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_no_start_closures WHERE action_id=$1', [o.task.actionId])).rows[0]
    if (!raw) return null
    const row = z.object({ action_id: uuid, user_id: accountUserId, session_id: uuid, phase: z.enum(['discover', 'call']),
      execution_target: z.literal('cloud'), execution_id: uuid, task_digest: digest, prepared_digest: digest.nullable(),
      worker_id: stdioWorkerIdV2, lease_epoch: z.coerce.number().int().positive(), receipt: z.unknown(),
      receipt_digest: digest, closed_at: z.date() }).parse(raw)
    const receipt = parseStdioNoStartReceiptV2(row.receipt, this.limits)
    if (row.action_id !== o.task.actionId || row.user_id !== o.task.userId || row.session_id !== o.task.sessionId
      || row.execution_id !== o.execution.id || row.phase !== o.task.phase || row.task_digest !== o.action.task_digest
      || row.prepared_digest !== (o.prepared?.preparedDigest ?? null) || receipt.actionId !== row.action_id
      || receipt.userId !== row.user_id || receipt.sessionId !== row.session_id || receipt.phase !== row.phase
      || !this.digests.same(receipt.executionRef, o.executionRef) || receipt.taskDigest !== row.task_digest
      || receipt.preparedDigest !== row.prepared_digest || this.digests.sha('no_start', receipt) !== row.receipt_digest
      || o.dispatch || o.action.state !== 'cancelled' || o.execution.state !== 'cancelled'
      || !o.action.cancel_requested || !o.execution.cancel_requested) this.deny('stdio_v2_no_start_receipt_changed')
    const resource = receipt.resource
    if (resource.kind !== 'unallocated' && !this.scopeBinding(o, resource.bindingSnapshot)
      || resource.kind === 'creation_stopped' && (resource.stopEvidence.sessionId !== o.task.sessionId
        || resource.stopEvidence.generation !== resource.mountGeneration
        || !this.digests.same(resource.stopEvidence.bindingSnapshot, resource.bindingSnapshot))) this.deny('stdio_v2_no_start_receipt_changed')
    if (resource.kind === 'ready_retained') {
      if (!o.writer || resource.name !== o.writer.name || resource.podUid !== o.writer.podUid
        || resource.runnerInstanceId !== o.writer.runnerInstanceId || o.prepared !== null
          && o.prepared.prepared.capture.mountGeneration !== resource.mountGeneration) {
        this.deny('stdio_v2_no_start_receipt_changed')
      }
    } else if (o.writer !== null || o.prepared !== null) this.deny('stdio_v2_no_start_receipt_changed')
    await this.noStartResult(client, o.task.actionId)
    return receipt
  }
  private scopeBinding(o: Awaited<ReturnType<StdioCloudWorkerStoreV2['read']>>, binding: z.infer<typeof storageBinding>): boolean {
    const scope = o.task.scopeBinding
    return binding.workspaceId === scope.workspaceId && binding.generation === scope.bindingGeneration
      && binding.spaceId === scope.target.spaceId && binding.rootRelativePath === scope.target.rootRelativePath
  }
  private async noStartResource(client: PoolClient, o: Awaited<ReturnType<StdioCloudWorkerStoreV2['read']>>): Promise<StdioNoStartResourceV2> {
    const scope = o.task.scopeBinding
    if (!(await client.query<Record<string, unknown>>('SELECT id FROM pe_workspaces WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [scope.workspaceId, o.task.userId])).rowCount) this.deny('stdio_v2_no_start_resources_unavailable')
    const rawSlot = (await client.query<Record<string, unknown>>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [o.task.userId])).rows[0]
    const rawInstance = (await client.query<Record<string, unknown>>('SELECT * FROM pe_sandbox_instances WHERE session_id=$1 AND user_id=$2 FOR UPDATE',
      [o.task.sessionId, o.task.userId])).rows[0]
    const slotSchema = z.object({ user_id: accountUserId, session_id: uuid.nullable(), workspace_id: uuid.nullable(),
      generation: z.coerce.string().regex(/^(0|[1-9][0-9]*)$/u), state: z.enum(['free', 'reserved', 'ready', 'stopping', 'unknown']),
      pod_uid: uuid.nullable(), runner_instance_id: uuid.nullable(), binding_snapshot: z.unknown(),
      stop_pod_uid: uuid.nullable(), stop_evidence: z.unknown() })
    const instanceSchema = z.object({ session_id: uuid, user_id: accountUserId, name: text, state: text,
      pod_uid: uuid.nullable(), runner_instance_id: uuid.nullable(), binding_snapshot: z.unknown(),
      stop_pod_uid: uuid.nullable(), stop_evidence: z.unknown() })
    const slot = rawSlot ? slotSchema.safeParse(rawSlot) : null, instance = rawInstance ? instanceSchema.safeParse(rawInstance) : null
    if (slot && !slot.success || instance && !instance.success) this.deny('stdio_v2_no_start_resources_unavailable')
    const s = slot?.data, i = instance?.data
    if (s && s.user_id !== o.task.userId || i && (i.user_id !== o.task.userId || i.session_id !== o.task.sessionId)) {
      this.deny('stdio_v2_no_start_resources_unavailable')
    }
    if (!i && (!s || s.session_id !== o.task.sessionId) && !o.writer && !o.prepared) return { kind: 'unallocated' }
    if (!s || !i) this.deny('stdio_v2_no_start_resources_unavailable')
    const binding = storageBinding.safeParse(s.binding_snapshot), priorBinding = storageBinding.safeParse(i.binding_snapshot)
    if (!binding.success || !priorBinding.success || !this.scopeBinding(o, binding.data)
      || !this.digests.same(binding.data, priorBinding.data)) this.deny('stdio_v2_no_start_resources_unavailable')
    if (s.state === 'ready' && i.state === 'ready' && s.session_id === o.task.sessionId && s.workspace_id === scope.workspaceId
      && s.pod_uid && s.runner_instance_id && i.pod_uid === s.pod_uid && i.runner_instance_id === s.runner_instance_id) {
      const current = (await client.query<Record<string, unknown>>(`SELECT b.workspace_id,b.space_id,s.root_key,b.root_relative_path,w.binding_generation
        FROM pe_workspaces w JOIN pe_workspace_bindings b ON b.workspace_id=w.id AND b.user_id=w.user_id
        JOIN pe_storage_spaces s ON s.id=b.space_id AND s.user_id=b.user_id WHERE w.id=$1 AND w.user_id=$2`,
      [scope.workspaceId, o.task.userId])).rows[0]
      const saved = storageBinding.safeParse(current && { workspaceId: current.workspace_id, spaceId: current.space_id,
        rootKey: current.root_key, rootRelativePath: current.root_relative_path, generation: Number(current.binding_generation) })
      if (!saved.success || !this.digests.same(saved.data, binding.data)
        || o.writer && (o.writer.name !== i.name || o.writer.podUid !== s.pod_uid || o.writer.runnerInstanceId !== s.runner_instance_id)
        || o.prepared && o.prepared.prepared.capture.mountGeneration !== s.generation) {
        this.deny('stdio_v2_no_start_resources_unavailable')
      }
      return { kind: 'ready_retained', name: i.name, podUid: s.pod_uid, runnerInstanceId: s.runner_instance_id,
        mountGeneration: s.generation, bindingSnapshot: binding.data }
    }
    const first = stdioCreationStopEvidenceV2.safeParse(s.stop_evidence), second = stdioCreationStopEvidenceV2.safeParse(i.stop_evidence)
    if (s.state !== 'free' || s.session_id !== null || s.workspace_id !== null || s.pod_uid !== null || s.runner_instance_id !== null
      || i.state !== 'deleted' || i.pod_uid !== null || i.runner_instance_id !== null || o.writer || o.prepared
      || !first.success || !second.success || !this.digests.same(first.data, second.data)
      || first.data.sessionId !== o.task.sessionId || first.data.generation !== s.generation
      || first.data.podUid !== s.stop_pod_uid || first.data.podUid !== i.stop_pod_uid
      || !this.digests.same(first.data.bindingSnapshot, binding.data)) this.deny('stdio_v2_no_start_resources_unavailable')
    return { kind: 'creation_stopped', name: i.name, mountGeneration: s.generation,
      bindingSnapshot: binding.data, stopEvidence: first.data }
  }

  /** Claim bounded fair candidates within the shared live Cloud worker lease capacity; this does not limit Pod or program count.
   * @param workerId Authenticated internal worker generation; a UUID alone provides no authentication.
   * @returns New original action lease or null at capacity or when no eligible candidate is available.
   */
  async claimNext(workerId: StdioWorkerIdV2): Promise<StdioActionLeaseV2 | null> {
    const owner = stdioWorkerIdV2.parse(workerId)
    return transaction(this.pool, async (client) => {
      await client.query<Record<string, unknown>>('SELECT pg_advisory_xact_lock(72819532)')
      const count = z.number().int().nonnegative().parse((await client.query<Record<string, unknown>>(`SELECT count(*)::integer AS count FROM pe_cloud_executions
        WHERE lease_owner IS NOT NULL AND lease_until>clock_timestamp() AND state IN ('queued','starting','running','cancelling','uncertain')
        AND NOT EXISTS(SELECT 1 FROM pe_cloud_execution_resolutions r WHERE r.execution_id=pe_cloud_executions.id)`)).rows[0]?.count)
      if (count >= this.options.maxActive) return null
      const candidates = await client.query<Record<string, unknown>>(`SELECT a.id FROM pe_stdio_v2_actions a JOIN pe_users u ON u.id=a.user_id
        WHERE execution_target='cloud' AND a.state=ANY($1::text[])
        AND (a.lease_owner IS NULL OR a.lease_until<=clock_timestamp())
        AND EXISTS(SELECT 1 FROM pe_cloud_executions e WHERE e.id=a.execution_id AND e.stdio_action_id=a.id
          AND e.execution_kind='stdio_v2' AND e.state=ANY($2::text[]))
        AND (a.state<>'pending' OR a.cancel_requested OR NOT u.enabled OR u.deleted_at IS NOT NULL
          OR EXISTS(SELECT 1 FROM pe_cloud_executions e WHERE e.id=a.execution_id AND e.cancel_requested)
          OR EXISTS(SELECT 1 FROM pe_stdio_v2_connections c WHERE c.id=a.connection_id
            AND (c.deleted_at IS NOT NULL OR c.revision<>a.config_revision))
          OR a.phase='call' AND EXISTS(SELECT 1 FROM pe_operations o
            JOIN pe_operations r ON r.id=COALESCE(o.mcp_root_operation_id,o.id)
            JOIN pe_mcp_action_chains chain ON chain.root_operation_id=r.id WHERE o.id=a.operation_id
              AND (r.mcp_chain_cancelled_at IS NOT NULL OR o.error_code IN ('cancel_requested','turn_user','account_disabled')
                OR chain.stopped_at IS NOT NULL OR chain.expires_at<=clock_timestamp()))
          OR EXISTS(SELECT 1 FROM pe_stdio_v2_preparations p WHERE p.action_id=a.id AND p.expires_at<=clock_timestamp()))
        ORDER BY u.last_claim_at NULLS FIRST,a.created_at,a.id LIMIT $3`,
      [workStates, activeExecutions, this.options.maxCandidates])
      for (const candidate of candidates.rows) {
        const id = stdioActionLeaseV2.shape.actionId.parse(candidate.id)
        // Rollback releases candidate row locks before acquiring the next owner's locks.
        await client.query<Record<string, unknown>>('SAVEPOINT stdio_cloud_candidate')
        let original: Awaited<ReturnType<StdioCloudWorkerStoreV2['read']>>
        try { original = await this.read(client, id) }
        catch (error) {
          if (!(error instanceof PlatformError) && !(error instanceof z.ZodError)) throw error
          await client.query<Record<string, unknown>>('ROLLBACK TO SAVEPOINT stdio_cloud_candidate')
          await client.query<Record<string, unknown>>('RELEASE SAVEPOINT stdio_cloud_candidate')
          continue
        }
        if (!workStates.includes(original.action.state) || !activeExecutions.includes(original.execution.state)) {
          await client.query<Record<string, unknown>>('ROLLBACK TO SAVEPOINT stdio_cloud_candidate')
          await client.query<Record<string, unknown>>('RELEASE SAVEPOINT stdio_cloud_candidate')
          continue
        }
        const row = (await client.query<Record<string, unknown>>(`UPDATE pe_stdio_v2_actions SET lease_owner=$2,lease_epoch=lease_epoch+1,
          lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',updated_at=clock_timestamp()
          WHERE id=$1 AND (lease_owner IS NULL OR lease_until<=clock_timestamp()) AND lease_epoch<9007199254740991 RETURNING lease_epoch`,
        [id, owner, this.options.leaseMs])).rows[0]
        if (!row) {
          await client.query<Record<string, unknown>>('ROLLBACK TO SAVEPOINT stdio_cloud_candidate')
          await client.query<Record<string, unknown>>('RELEASE SAVEPOINT stdio_cloud_candidate')
          continue
        }
        const lease = stdioActionLeaseV2.parse({ actionId: id, workerId: owner, leaseEpoch: z.coerce.number().parse(row.lease_epoch) })
        await this.mirror(client, lease, original.execution.id)
        await this.write(client, lease, `UPDATE pe_users SET last_claim_at=clock_timestamp() WHERE id=$4 AND ${guard}`, [original.account.userId])
        return lease
      }
      return null
    })
  }
  /** Extend both original leases atomically without changing the action epoch.
   * @param lease Current unexpired original generation.
   * @returns The same action worker and epoch after both database expiries have been extended.
   */
  async renew(lease: StdioActionLeaseV2): Promise<StdioActionLeaseV2> {
    const selected = stdioActionLeaseV2.parse(lease)
    return transaction(this.pool, async (client) => {
      const original = await this.current(client, selected)
      await this.write(client, selected, `UPDATE pe_stdio_v2_actions SET lease_until=clock_timestamp()+$4::double precision*interval '1 millisecond',
        updated_at=clock_timestamp() WHERE id=$1 AND ${guard}`, [this.options.leaseMs])
      if (activeExecutions.includes(original.execution.state)) await this.mirror(client, selected, original.execution.id)
      return selected
    })
  }
  /** Read the complete original task, capture and dispatch; stale grants or inactive original root chains request cancellation
   * without replacing the writer.
   * @param lease Current original worker generation.
   * @returns Original immutable fields and logical cancellation status; no resource or start permission is created.
   */
  async snapshot(lease: StdioActionLeaseV2): Promise<StdioCloudWorkerSnapshotV2> {
    const selected = stdioActionLeaseV2.parse(lease)
    return transaction(this.pool, async (client) => {
      const o = await this.current(client, selected)
      return structuredClone({ task: o.task, taskDigest: o.action.task_digest, executionRef: o.executionRef, state: o.action.state,
        cancelRequested: o.cancelRequested, prepared: o.prepared, dispatch: o.dispatch, writer: o.writer })
    })
  }
  /** Fence one Manager provisioning transaction using its supplied client and the full original action locks.
   * @param client Manager client already holding the owner lock, before locking the Workspace or mount slot; no pool access is used.
   * @param lease Current action and mirrored execution generation, rechecked against the database clock.
   * @param sessionId Exact original Session; an identifier alone grants no provisioning authority.
   * @param userId Exact original owner; cancellation may retain creation identity only in record mode.
   * @param mode Acquire and mutation require current grants; record retains known identity for active cancellation cleanup.
   */
  async assertProvisioning(client: PoolClient, lease: StdioActionLeaseV2, sessionId: string, userId: string,
    mode: 'acquire' | 'record' | 'mutation'): Promise<void> {
    const selected = stdioActionLeaseV2.parse(lease), selectedMode = z.enum(['acquire', 'record', 'mutation']).parse(mode)
    const o = await this.current(client, selected)
    if (o.task.userId !== userId || o.task.sessionId !== sessionId) this.deny('stdio_v2_original_changed')
    if (o.dispatch) this.deny('stdio_v2_start_already_authorized')
    if ((await client.query<Record<string, unknown>>('SELECT action_id FROM pe_stdio_v2_no_start_closures WHERE action_id=$1', [selected.actionId])).rowCount
      || !workStates.includes(o.action.state) || !activeExecutions.includes(o.execution.state)) this.deny('stdio_v2_action_not_startable')
    await this.noStartResult(client, selected.actionId)
    if (selectedMode !== 'record') this.startable(o)
    await assertStdioActionLeaseV2(client, selected)
  }
  private async continueNoStart(client: PoolClient, lease: StdioActionLeaseV2, phase: StdioTaskV2['phase']): Promise<void> {
    if (phase !== 'call') return
    if (!this.continuation) this.deny('stdio_v2_no_start_call_unavailable')
    await assertStdioActionLeaseV2(client, lease)
    await this.continuation.enqueueLeased(client, lease)
    await assertStdioActionLeaseV2(client, lease)
  }
  /** Close a cancelled task that never received start permission; call continuation shares this transaction and original action lease.
   * Calls require a configured continuation; its failure rolls back the receipt and both terminal writes.
   * @param lease Current original generation; replay still requires its live action lease and never reclaims a slot.
   * @returns The first immutable no-start receipt after both original records become cancelled; no SDK result is minted.
   */
  async closeUnstarted(lease: StdioActionLeaseV2): Promise<StdioNoStartReceiptV2> {
    const selected = stdioActionLeaseV2.parse(lease)
    return transaction(this.pool, async (client) => {
      const o = await this.current(client, selected)
      if (o.task.phase === 'call' && !this.continuation) this.deny('stdio_v2_no_start_call_unavailable')
      const prior = await this.storedClosure(client, o)
      if (prior) {
        await this.continueNoStart(client, selected, o.task.phase)
        return prior
      }
      if (o.dispatch) this.deny('stdio_v2_start_already_authorized')
      await this.noStartResult(client, selected.actionId)
      if (!o.cancelRequested || !workStates.includes(o.action.state) || !activeExecutions.includes(o.execution.state)) {
        this.deny('stdio_v2_action_not_startable')
      }
      const resource = await this.noStartResource(client, o)
      const receipt = parseStdioNoStartReceiptV2({ formatVersion: 2, kind: 'unstarted_closed', actionId: o.task.actionId,
        executionRef: o.executionRef, taskDigest: o.action.task_digest, preparedDigest: o.prepared?.preparedDigest ?? null,
        userId: o.task.userId, sessionId: o.task.sessionId, phase: o.task.phase, state: 'cancelled', startNeverAuthorized: true, resource }, this.limits)
      if (resource.kind === 'ready_retained' && !o.writer) {
        await this.write(client, selected, `UPDATE pe_cloud_executions SET sandbox_name=$4,pod_uid=$5,runner_instance_id=$6,updated_at=clock_timestamp()
          WHERE id=$7 AND execution_kind='stdio_v2' AND stdio_action_id=$1 AND sandbox_name IS NULL AND pod_uid IS NULL
            AND runner_instance_id IS NULL AND ${guard}`, [resource.name, resource.podUid, resource.runnerInstanceId, o.execution.id])
      }
      await this.write(client, selected, `INSERT INTO pe_stdio_v2_no_start_closures(action_id,user_id,session_id,phase,execution_target,
        execution_id,task_digest,prepared_digest,worker_id,lease_epoch,receipt,receipt_digest)
        SELECT $1,$4,$5,$11,'cloud',$6,$7,$8,$2,$3,$9,$10 WHERE ${guard} RETURNING action_id`,
      [o.task.userId, o.task.sessionId, o.execution.id, o.action.task_digest, receipt.preparedDigest, JSON.stringify(receipt), this.digests.sha('no_start', receipt), o.task.phase])
      await this.write(client, selected, `UPDATE pe_stdio_v2_actions SET state='cancelled',cancel_requested=true,
        updated_at=clock_timestamp() WHERE id=$1 AND ${guard}`, [])
      await this.write(client, selected, `UPDATE pe_cloud_executions SET state='cancelled',cancel_requested=true,updated_at=clock_timestamp()
        WHERE id=$4 AND execution_kind='stdio_v2' AND stdio_action_id=$1 AND ${guard}`, [o.execution.id])
      await this.continueNoStart(client, selected, o.task.phase)
      return receipt
    })
  }
  /** Read the first internal no-start receipt after commit, including a lost reply; this never creates a new lease or start grant.
   * @param actionId Original internal action identity; all original owner, task, configuration and cancelled records are revalidated.
   * @returns Original immutable receipt or null before closure; historical live mount changes do not rebuild the receipt.
   */
  async readNoStart(actionId: StdioActionLeaseV2['actionId']): Promise<StdioNoStartReceiptV2 | null> {
    const id = stdioActionLeaseV2.shape.actionId.parse(actionId)
    return transaction(this.pool, async client => this.storedClosure(client, await this.read(client, id)))
  }
  /** Persist or recover preparation intent without replacing an original writer; existing captures, permits and cancellation
   * do not restart preparation.
   * @param lease Current original worker generation.
   */
  async beginPreparation(lease: StdioActionLeaseV2): Promise<void> {
    const selected = stdioActionLeaseV2.parse(lease)
    return transaction(this.pool, async (client) => {
      const o = await this.current(client, selected); this.startable(o)
      if (o.dispatch || o.prepared) this.deny('stdio_v2_action_not_startable')
      await this.write(client, selected, `UPDATE pe_stdio_v2_actions SET state='preparing',updated_at=clock_timestamp() WHERE id=$1 AND ${guard}`, [])
      await this.write(client, selected, `UPDATE pe_cloud_executions SET state='starting',updated_at=clock_timestamp()
        WHERE id=$4 AND execution_kind='stdio_v2' AND stdio_action_id=$1 AND ${guard}`, [o.execution.id])
    })
  }
  /** Attach only the first ready original writer, including revoked creation cleanup; this grants no start or replacement.
   * @param lease Current original worker generation.
   * @param ready Private Manager observations for the exact owned Session, mount slot and binding generation.
   */
  async attach(lease: StdioActionLeaseV2, ready: SandboxReady): Promise<void> {
    const selected = stdioActionLeaseV2.parse(lease), captured = structuredClone(ready)
    return transaction(this.pool, async (client) => {
      const o = await this.current(client, selected)
      if (!workStates.includes(o.action.state) || !activeExecutions.includes(o.execution.state)) this.deny('stdio_v2_action_not_startable')
      await this.ready(client, o, captured)
      await assertStdioActionLeaseV2(client, selected)
      if (o.writer) return
      if (o.prepared || o.dispatch || !['preparing', 'blocked', 'stopping', 'rejected', 'expired'].includes(o.action.state)
        || !['starting', 'cancelling', 'uncertain'].includes(o.execution.state)) this.deny('stdio_v2_writer_changed')
      await this.write(client, selected, `UPDATE pe_cloud_executions SET sandbox_name=$4,pod_uid=$5,runner_instance_id=$6,updated_at=clock_timestamp()
        WHERE id=$7 AND execution_kind='stdio_v2' AND stdio_action_id=$1 AND sandbox_name IS NULL AND pod_uid IS NULL
          AND runner_instance_id IS NULL AND ${guard}`, [captured.name, captured.podUid, captured.runnerInstanceId, o.execution.id])
    })
  }
  /** Run bounded private observation under the same ordered locks; actual Runner execution belongs after commit.
   * @param lease Current original worker generation, rechecked before and after the bounded callback.
   * @param mode Dispatch requires current grants; observe retains revoked original writer reconciliation.
   * @param operation Private Kube/Manager observation using only the supplied transaction client; never an executor start.
   * @returns Original ready writer after the transaction commits and releases its client.
   */
  async capture(lease: StdioActionLeaseV2, mode: 'dispatch' | 'observe', operation: (client: PoolClient) => Promise<SandboxReady>): Promise<SandboxReady> {
    const selected = stdioActionLeaseV2.parse(lease), selectedMode = z.enum(['dispatch', 'observe']).parse(mode)
    return transaction(this.pool, async (client) => {
      const o = await this.current(client, selected)
      if (!o.writer) this.deny('stdio_v2_writer_changed')
      if (selectedMode === 'dispatch' && (o.cancelRequested || !o.dispatch || o.action.state !== 'dispatch-intent'
        || !['queued', 'starting'].includes(o.execution.state))) this.deny('stdio_v2_action_not_startable')
      const observed = structuredClone(await operation(client))
      await assertStdioActionLeaseV2(client, selected)
      await this.ready(client, o, observed)
      await assertStdioActionLeaseV2(client, selected)
      return observed
    })
  }
  /** Retain the original writer after failure; an unissued approval remains pending or approved, while cancellation mirrors both flags.
   * @param lease Current original worker generation.
   * @param code Bounded diagnostic code; stdio_v2_cancel_requested requests cancellation of both original records.
   */
  async defer(lease: StdioActionLeaseV2, code: string): Promise<void> {
    const selected = stdioActionLeaseV2.parse(lease), reason = z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u).parse(code)
    return transaction(this.pool, async (client) => {
      const o = await this.current(client, selected)
      if (!workStates.includes(o.action.state) || !activeExecutions.includes(o.execution.state)) this.deny('stdio_v2_action_not_startable')
      const cancel = reason === 'stdio_v2_cancel_requested'
      // An unissued start may retry the same immutable approval after a temporary capture failure.
      const retryApproval = !cancel && !o.cancelRequested && !o.dispatch && o.prepared !== null
        && ['pending', 'approved'].includes(o.action.state) && ['queued', 'starting'].includes(o.execution.state)
      await this.write(client, selected, `UPDATE pe_stdio_v2_actions SET state=$6,error_code=$4,
        cancel_requested=cancel_requested OR $5,updated_at=clock_timestamp() WHERE id=$1 AND ${guard}`,
      [reason, cancel, retryApproval ? o.action.state : 'blocked'])
      await this.write(client, selected, `UPDATE pe_cloud_executions SET state=$7,error_code=$4,
        cancel_requested=cancel_requested OR $5,updated_at=clock_timestamp() WHERE id=$6
        AND execution_kind='stdio_v2' AND stdio_action_id=$1 AND ${guard}`,
      [reason, cancel, o.execution.id, retryApproval ? o.execution.state : 'uncertain'])
    })
  }
  /** End only this original worker lease; resource reservations and immutable start records remain intact.
   * @param lease Current original worker generation; a stale worker cannot clear a successor's lease.
   */
  async release(lease: StdioActionLeaseV2): Promise<void> {
    const selected = stdioActionLeaseV2.parse(lease)
    return transaction(this.pool, async (client) => {
      const o = await this.current(client, selected)
      await this.write(client, selected, `UPDATE pe_cloud_executions SET lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE id=$4 AND execution_kind='stdio_v2' AND stdio_action_id=$1 AND ${guard}`, [o.execution.id])
      const result = await client.query<Record<string, unknown>>(`UPDATE pe_stdio_v2_actions SET lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp()`, [selected.actionId, selected.workerId, selected.leaseEpoch])
      if (result.rowCount !== 1) this.deny('stdio_v2_lease_lost')
    })
  }
}
