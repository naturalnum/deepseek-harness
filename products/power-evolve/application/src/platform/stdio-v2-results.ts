/** Persist original private Cloud STDIO observations; only independent full-UID proof permits final writer retirement. */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioSavedConfigurationV2 } from '@power-evolve/contracts/stdio-management'
import { stdioApprovalBindingV2, stdioDigestV2, stdioDispatchV2, stdioExecutorOwnerV2,
  stdioJsonV2, stdioLimitsV2, stdioPreparedV2, stdioStartPermitV2, stdioTaskSchemasV2,
  type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioActionLeaseV2, stdioCloudStopEvidenceV2, stdioRuntimeViewV2,
  type StdioActionLeaseV2, type StdioCloudObservationV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioCatalogFingerprintV2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { accountUserId } from '../account-contracts.ts'
import { PlatformError } from '../contracts.ts'
import { transaction } from './database.ts'
import { stdioRecordDigestsV2, lockStdioActionAccountV2 } from './stdio-v2-call-authority.ts'
import type { StdioCallContinuationV2 } from './stdio-v2-continuations.ts'

const uuid = z.uuid(), digest = stdioDigestV2
const epoch = z.union([z.number().int().nonnegative(), z.string().regex(/^(0|[1-9][0-9]*)$/u)
  .transform(Number).pipe(z.number().int().nonnegative())])
const actionRow = z.object({ id: uuid, user_id: accountUserId, session_id: uuid, connection_id: uuid,
  config_revision: z.number().int().positive(), config_digest: digest, phase: z.enum(['discover', 'call']),
  execution_target: z.literal('cloud'), execution_id: uuid, task: z.unknown(), task_digest: digest, state: z.string(),
  cancel_requested: z.boolean(), request_id: uuid.nullable(), operation_id: uuid.nullable(), root_operation_id: uuid.nullable(),
  call_id: z.string().nullable(), continuation_request_id: uuid.nullable(), lease_owner: uuid.nullable(),
  lease_epoch: epoch, lease_until: z.date().nullable() })
const executionRow = z.object({ id: uuid, user_id: accountUserId, session_id: uuid, execution_kind: z.literal('stdio_v2'),
  execution_target: z.literal('cloud'), task_version: z.literal(2), stdio_action_id: uuid, stdio_phase: z.enum(['discover', 'call']),
  stdio_task: z.unknown(), request_digest: digest, origin_kind: z.enum(['operation', 'stdio_discovery']),
  operation_id: uuid.nullable(), call_id: z.string().nullable(), continuation_request_id: uuid.nullable(),
  command: z.null(), cwd: z.null(), state: z.string(), cancel_requested: z.boolean(),
  sandbox_name: z.string().min(1), pod_uid: uuid, runner_instance_id: uuid })
const connectionRow = z.object({ id: uuid, user_id: accountUserId, revision: z.number().int().positive(),
  current_catalog_id: uuid.nullable(), deleted_at: z.date().nullable() })
const preparationRow = z.object({ user_id: accountUserId, session_id: uuid, phase: z.enum(['discover', 'call']),
  execution_target: z.literal('cloud'), execution_id: uuid, task_digest: digest, prepared: stdioPreparedV2,
  prepared_digest: digest, approval_binding: stdioApprovalBindingV2, fingerprint: digest,
  approval_epoch: z.literal(1), expires_at: z.date() })
const permitRow = z.object({ action_id: uuid, permit_id: uuid, authorization_request_id: uuid, execution_id: uuid,
  task_digest: digest, prepared_digest: digest, fingerprint: digest, decision: z.literal('once'),
  executor_owner: stdioExecutorOwnerV2.options[0], permit: stdioStartPermitV2, issued_at: z.date(), expires_at: z.date() })
const leaseGuard = `EXISTS(SELECT 1 FROM pe_stdio_v2_actions lease WHERE lease.id=$1 AND lease.lease_owner=$2
  AND lease.lease_epoch=$3 AND lease.lease_until>clock_timestamp())`

/** Private worker result persistence retains writer reservations until independently authenticated UID quiet facts arrive. */
export class StdioResultServiceV2 {
  private readonly digests: ReturnType<typeof stdioRecordDigestsV2>
  private readonly limits: StdioLimitsV2
  private readonly view: ReturnType<typeof stdioRuntimeViewV2>
  private readonly task: ReturnType<typeof stdioTaskSchemasV2>['task']
  private readonly continuation: Pick<StdioCallContinuationV2, 'enqueueLeased'> | undefined
  constructor(private readonly pool: Pool, options: { limits: StdioLimitsV2
    maxReplyBytes: number
    continuation?: Pick<StdioCallContinuationV2, 'enqueueLeased'> }) {
    this.limits = stdioLimitsV2.parse(options.limits)
    this.digests = stdioRecordDigestsV2(this.limits)
    this.view = stdioRuntimeViewV2(this.limits, options.maxReplyBytes)
    this.task = stdioTaskSchemasV2(this.limits).task
    this.continuation = options.continuation
  }
  private deny(code: string): never { throw new PlatformError(409, code) }
  private observation(value: unknown) {
    const bounded = stdioJsonV2(this.digests.budget).parse(value)
    return z.object({ view: this.view, stopEvidence: stdioCloudStopEvidenceV2.nullable() }).strict().parse(bounded)
  }
  private proofSame(left: z.infer<typeof stdioCloudStopEvidenceV2>, right: z.infer<typeof stdioCloudStopEvidenceV2>) {
    const { observedAt: _oldTime, ...oldFacts } = left, { observedAt: _newTime, ...newFacts } = right
    return this.digests.same(oldFacts, newFacts)
  }
  private async live(client: PoolClient, lease: StdioActionLeaseV2, action: z.infer<typeof actionRow>) {
    const now = z.date().parse((await client.query<Record<string, unknown>>('SELECT clock_timestamp() AS now')).rows[0]?.now)
    if (action.lease_owner !== lease.workerId || action.lease_epoch !== lease.leaseEpoch
      || !action.lease_until || action.lease_until.getTime() <= now.getTime()) this.deny('stdio_v2_lease_lost')
  }
  private async write(client: PoolClient, lease: StdioActionLeaseV2, sql: string, values: readonly unknown[]) {
    const changed = await client.query<Record<string, unknown>>(sql, [lease.actionId, lease.workerId, lease.leaseEpoch, ...values])
    if (changed.rowCount !== 1) this.deny('stdio_v2_lease_lost')
  }

  /** Record a full immutable runtime observation under the current original action lease.
   * @param lease Internal worker and epoch, verified against the database clock at each mutation.
   * @param observation Private authenticated original Runner view and optional full-UID quiet proof; never a browser assertion.
   * @returns Current action state, whether a final result exists, and the once-minted discovery catalog identity if any.
   * @throws Changed originals, invalid proof, exceeded budgets, lost lease or missing/failed call continuation rejects atomically;
   * discovery needs no continuation.
   */
  async record(lease: StdioActionLeaseV2, observation: StdioCloudObservationV2): Promise<{
    actionId: StdioActionLeaseV2['actionId']
    state: string
    finalized: boolean
    catalogId: string | null
  }> {
    lease = stdioActionLeaseV2.parse(lease)
    const incoming = structuredClone(this.observation(observation)), observationDigest = this.digests.sha('observation', incoming)
    return transaction(this.pool, async (client) => {
      const selected = (await client.query<Record<string, unknown>>('SELECT user_id,session_id,connection_id FROM pe_stdio_v2_actions WHERE id=$1', [lease.actionId])).rows[0]
      if (!selected) throw new PlatformError(404, 'stdio_v2_action_not_found')
      const hint = z.object({ user_id: accountUserId, session_id: uuid, connection_id: uuid }).parse(selected)
      const account = await lockStdioActionAccountV2(client, hint.user_id)
      const session = z.object({ id: uuid, workspace_id: uuid }).parse((await client.query<Record<string, unknown>>(
        'SELECT id,workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [hint.session_id, hint.user_id])).rows[0])
      const connection = connectionRow.parse((await client.query<Record<string, unknown>>(
        'SELECT * FROM pe_stdio_v2_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [hint.connection_id, hint.user_id])).rows[0])
      const action = actionRow.parse((await client.query<Record<string, unknown>>(
        'SELECT * FROM pe_stdio_v2_actions WHERE id=$1 AND user_id=$2 FOR UPDATE', [lease.actionId, hint.user_id])).rows[0])
      const task = this.task.parse(action.task)
      const execution = executionRow.parse((await client.query<Record<string, unknown>>(
        'SELECT * FROM pe_cloud_executions WHERE id=$1 AND user_id=$2 FOR UPDATE', [action.execution_id, hint.user_id])).rows[0])
      if (action.id !== lease.actionId || action.user_id !== hint.user_id || action.session_id !== session.id
        || action.connection_id !== connection.id || connection.user_id !== action.user_id
        || task.actionId !== action.id || task.userId !== action.user_id || task.sessionId !== action.session_id
        || task.connectionId !== action.connection_id || task.configRevision !== action.config_revision
        || task.configDigest !== action.config_digest || task.phase !== action.phase
        || task.scopeBinding.workspaceId !== session.workspace_id || this.digests.sha('task', task) !== action.task_digest
        || execution.id !== action.execution_id || execution.session_id !== action.session_id || execution.user_id !== action.user_id
        || execution.stdio_action_id !== action.id || execution.stdio_phase !== action.phase
        || execution.request_digest !== action.task_digest || !this.digests.same(execution.stdio_task, task)
        || execution.operation_id !== action.operation_id || execution.call_id !== action.call_id
        || execution.continuation_request_id !== action.continuation_request_id) this.deny('stdio_v2_original_changed')
      if (task.phase === 'discover' ? action.request_id !== task.origin.requestId || execution.origin_kind !== 'stdio_discovery'
        || action.operation_id !== null || action.root_operation_id !== null
          || action.call_id !== null || action.continuation_request_id !== null
        : execution.origin_kind !== 'operation' || action.operation_id !== task.origin.operationId || action.root_operation_id !== task.origin.rootOperationId
          || action.call_id !== task.origin.callKey || action.request_id !== null || action.continuation_request_id === null
          || stdioCatalogFingerprintV2(task.selection.rawCatalog, this.limits) !== task.selection.catalogDigest) this.deny('stdio_v2_origin_changed')
      const configuration = z.object({ config_digest: digest, configuration: stdioSavedConfigurationV2 })
        .parse((await client.query<Record<string, unknown>>('SELECT configuration,config_digest FROM pe_stdio_v2_configurations WHERE connection_id=$1 AND user_id=$2 AND revision=$3',
          [action.connection_id, action.user_id, action.config_revision])).rows[0])
      if (configuration.config_digest !== action.config_digest || this.digests.sha('configuration', configuration.configuration) !== action.config_digest
        || !this.digests.same(configuration.configuration.invocation, task.invocation)) this.deny('stdio_v2_configuration_changed')
      const preparation = preparationRow.parse((await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_preparations WHERE action_id=$1', [action.id])).rows[0])
      const prepared = preparation.prepared, approval = preparation.approval_binding
      if (preparation.user_id !== action.user_id || preparation.session_id !== action.session_id || preparation.phase !== action.phase
        || preparation.execution_id !== execution.id || preparation.task_digest !== action.task_digest
        || prepared.actionId !== action.id || prepared.taskDigest !== action.task_digest
        || !this.digests.same(prepared.executionRef, { kind: 'cloud', executionId: execution.id }) || !this.digests.same(prepared.scopeBinding, task.scopeBinding)
        || !this.digests.same(prepared.expectedDeploymentPin, task.expectedDeploymentPin) || this.digests.sha('prepared', prepared) !== preparation.prepared_digest
        || prepared.fullScopeDigest !== this.digests.sha('scope', { scopeBinding: prepared.scopeBinding,
          workspaceMount: prepared.capture.workspaceMount, homeMount: prepared.capture.homeMount })
        || approval.actionId !== action.id || approval.taskDigest !== action.task_digest
          || approval.preparedDigest !== preparation.prepared_digest
        || approval.expiresAt !== preparation.expires_at.toISOString()
        || prepared.capture.podName !== execution.sandbox_name || prepared.capture.podUid !== execution.pod_uid
        || prepared.capture.runnerInstanceId !== execution.runner_instance_id
        || task.phase === 'call' && !this.digests.same(prepared.actualExecutorImage, task.selection.catalogImageExpectation)) this.deny('stdio_v2_preparation_changed')
      const decision = z.object({ user_id: accountUserId, fingerprint: digest, decision: z.literal('once') }).parse((await client.query<Record<string, unknown>>(
        'SELECT user_id,fingerprint,decision FROM pe_stdio_v2_decisions WHERE action_id=$1', [action.id])).rows[0])
      const originalPermit = permitRow.parse((await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_start_permits WHERE action_id=$1', [action.id])).rows[0])
      const permit = originalPermit.permit
      if (decision.user_id !== action.user_id || decision.fingerprint !== preparation.fingerprint || originalPermit.action_id !== action.id
        || originalPermit.permit_id !== permit.permitId || originalPermit.authorization_request_id !== permit.authorizationRequestId
        || originalPermit.execution_id !== execution.id || originalPermit.task_digest !== action.task_digest
        || originalPermit.prepared_digest !== preparation.prepared_digest || originalPermit.fingerprint !== preparation.fingerprint
        || permit.actionId !== action.id || permit.taskDigest !== action.task_digest
          || permit.preparedDigest !== preparation.prepared_digest
        || permit.approvalFingerprint !== preparation.fingerprint || permit.expiresAt !== approval.expiresAt
        || permit.issuedAt !== originalPermit.issued_at.toISOString() || permit.expiresAt !== originalPermit.expires_at.toISOString()
        || !this.digests.same(permit.executionRef, prepared.executionRef)
        || !this.digests.same(permit.executorOwner, originalPermit.executor_owner)
        || permit.executorOwner.runnerInstanceId !== execution.runner_instance_id) this.deny('stdio_v2_permit_changed')
      const archived = z.object({ dispatch: stdioDispatchV2(this.limits), dispatch_digest: digest }).parse(
        (await client.query<Record<string, unknown>>(
          'SELECT dispatch,dispatch_digest FROM pe_stdio_v2_dispatches WHERE action_id=$1', [action.id])).rows[0])
      if (this.digests.sha('dispatch', archived.dispatch) !== archived.dispatch_digest || !this.digests.same(archived.dispatch.task, task)
        || archived.dispatch.taskDigest !== action.task_digest || archived.dispatch.preparedDigest !== preparation.prepared_digest
        || !this.digests.same(archived.dispatch.executionRef, prepared.executionRef) || !this.digests.same(archived.dispatch.permit, permit)) this.deny('stdio_v2_dispatch_changed')
      const { view, stopEvidence } = incoming
      if (view.actionId !== action.id || !this.digests.same(view.executionRef,
        prepared.executionRef) || view.instanceId !== execution.runner_instance_id
        || view.taskDigest !== action.task_digest || view.dispatchDigest !== archived.dispatch_digest
        || view.outcome?.state === 'completed' && (view.outcome.phase !== task.phase || task.phase === 'call'
          && stdioCatalogFingerprintV2(view.outcome.catalog, this.limits) !== task.selection.catalogDigest)) this.deny('stdio_v2_observation_changed')
      if (stopEvidence && (stopEvidence.actionId !== action.id || !this.digests.same(stopEvidence.executionRef, prepared.executionRef)
        || stopEvidence.taskDigest !== action.task_digest || stopEvidence.dispatchDigest !== archived.dispatch_digest
        || stopEvidence.preparedDigest !== preparation.prepared_digest || stopEvidence.fullScopeDigest !== prepared.fullScopeDigest
        || stopEvidence.podUid !== execution.pod_uid || stopEvidence.runnerInstanceId !== execution.runner_instance_id
        || stopEvidence.mountGeneration !== prepared.capture.mountGeneration)) this.deny('stdio_v2_stop_evidence_changed')
      const stored = (await client.query<Record<string, unknown>>('SELECT result,result_digest,observation,stop_evidence FROM pe_stdio_v2_results WHERE action_id=$1', [action.id])).rows[0]
      const catalog = (await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_catalogs WHERE action_id=$1', [action.id])).rows[0]
      if (stored) {
        const first = this.observation({ view: stored.observation, stopEvidence: stored.stop_evidence })
        const finalState = first.view.state === 'completed' ? 'succeeded' : first.view.state === 'cancelled' ? 'cancelled' : 'failed'
        if (!['completed', 'failed', 'cancelled'].includes(first.view.state) || action.state !== finalState || execution.state !== finalState
          || !first.stopEvidence || !stopEvidence
          || this.digests.sha('result', stored.result) !== stored.result_digest || !this.digests.same(stored.result, first.view.outcome)
          || !this.digests.same(first.view, view) || !this.proofSame(first.stopEvidence, stopEvidence)) this.deny('stdio_v2_result_conflict')
        if (catalog) {
          const savedCatalog = z.object({ id: uuid, user_id: accountUserId,
            connection_id: uuid, config_revision: z.number().int().positive(),

            config_digest: digest, action_id: uuid, session_id: uuid, phase: z.literal('discover'), raw_catalog: z.unknown(),
            image_expectation: stdioPreparedV2.shape.actualExecutorImage, catalog_digest: digest }).parse(catalog)
          if (task.phase !== 'discover' || view.state !== 'completed' || view.outcome?.state !== 'completed'
            || savedCatalog.user_id !== action.user_id || savedCatalog.connection_id !== connection.id
            || savedCatalog.config_revision !== action.config_revision || savedCatalog.config_digest !== action.config_digest
            || savedCatalog.action_id !== action.id || savedCatalog.session_id !== action.session_id
            || !this.digests.same(savedCatalog.raw_catalog, view.outcome.catalog)
            || stdioCatalogFingerprintV2(savedCatalog.raw_catalog, this.limits) !== savedCatalog.catalog_digest
            || !this.digests.same(savedCatalog.image_expectation, prepared.actualExecutorImage)) this.deny('stdio_v2_result_conflict')
        }
        await this.live(client, lease, action)
        if (task.phase === 'call') {
          if (!this.continuation) this.deny('stdio_v2_continuation_unavailable')
          await this.continuation.enqueueLeased(client, lease)
        }
        return { actionId: lease.actionId, state: action.state, finalized: true, catalogId: catalog ? z.uuid().parse(catalog.id) : null }
      }
      await this.live(client, lease, action)
      if (!['dispatch-intent', 'running', 'stopping', 'blocked'].includes(action.state)
        || !['queued', 'starting', 'running', 'cancelling', 'uncertain'].includes(execution.state) || catalog) this.deny('stdio_v2_result_conflict')
      const prior = (await client.query<Record<string, unknown>>('SELECT observation,observation_digest,stop_evidence FROM pe_stdio_v2_observations WHERE action_id=$1 AND observation_digest=$2',
        [action.id, observationDigest])).rows[0]
      if (prior) {
        const previous = this.observation({ view: prior.observation, stopEvidence: prior.stop_evidence })
        if (prior.observation_digest !== this.digests.sha('observation', previous) || !this.digests.same(previous, incoming)) this.deny('stdio_v2_observation_changed')
      } else await this.write(client, lease, `INSERT INTO pe_stdio_v2_observations
        (id,action_id,worker_id,lease_epoch,observation,observation_digest,stop_evidence)
        SELECT $4,$1,$2,$3,$5,$6,$7 WHERE ${leaseGuard}`, [randomUUID(), JSON.stringify(view), observationDigest, stopEvidence ? JSON.stringify(stopEvidence) : null])
      const final = !!stopEvidence && ['completed', 'failed', 'cancelled'].includes(view.state)
      const state = final ? view.state === 'completed' ? 'succeeded' : view.state === 'cancelled' ? 'cancelled' : 'failed'
        : view.state === 'running' ? 'running' : view.state === 'unknown' ? 'blocked' : 'stopping'
      const executionState = final ? state : view.state === 'running' ? 'running' : view.state === 'unknown' ? 'uncertain' : 'cancelling'
      let catalogId: string | null = null
      if (final) {
        await this.write(client, lease, `INSERT INTO pe_stdio_v2_results(action_id,result,result_digest,observation,stop_evidence)
          SELECT $1,$4,$5,$6,$7 WHERE ${leaseGuard}`, [JSON.stringify(view.outcome), this.digests.sha('result', view.outcome), JSON.stringify(view), JSON.stringify(stopEvidence)])
        if (task.phase === 'discover' && view.state === 'completed' && view.outcome?.state === 'completed'
          && account.enabled && !account.deletedAt && !connection.deleted_at && connection.revision === action.config_revision
          && !action.cancel_requested && !execution.cancel_requested) {
          catalogId = randomUUID()
          await this.write(client, lease, `INSERT INTO pe_stdio_v2_catalogs
            (id,user_id,connection_id,config_revision,config_digest,action_id,session_id,phase,raw_catalog,image_expectation,catalog_digest)
            SELECT $4,$5,$6,$7,$8,$1,$9,'discover',$10,$11,$12 WHERE ${leaseGuard}`,
          [catalogId, action.user_id, connection.id, action.config_revision, action.config_digest, action.session_id,
            JSON.stringify(view.outcome.catalog), JSON.stringify(prepared.actualExecutorImage),
            stdioCatalogFingerprintV2(view.outcome.catalog, this.limits)])
          await this.write(client, lease, `UPDATE pe_stdio_v2_connections SET current_catalog_id=$4,updated_at=clock_timestamp()
            WHERE id=$5 AND user_id=$6 AND revision=$7 AND deleted_at IS NULL AND ${leaseGuard}`,
          [catalogId, connection.id, action.user_id, action.config_revision])
        }
      }
      await this.write(client, lease, `UPDATE pe_cloud_executions SET state=$4,lease_owner=CASE WHEN $5 THEN NULL ELSE lease_owner END,
        lease_until=CASE WHEN $5 THEN NULL ELSE lease_until END,updated_at=clock_timestamp()
        WHERE id=$6 AND user_id=$7 AND execution_kind='stdio_v2' AND stdio_action_id=$1 AND ${leaseGuard}`,
      [executionState, final, execution.id, action.user_id])
      await this.write(client, lease, `UPDATE pe_stdio_v2_actions SET state=$4,updated_at=clock_timestamp()
        WHERE id=$1 AND ${leaseGuard}`, [state])
      if (final && task.phase === 'call') {
        if (!this.continuation) this.deny('stdio_v2_continuation_unavailable')
        await this.continuation.enqueueLeased(client, lease)
      }
      return { actionId: lease.actionId, state, finalized: final, catalogId }
    })
  }
}
