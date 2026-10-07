/** Persistent independent STDIO approvals; the original reply alone may grant one executor start. */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioActionRequestV2, stdioApprovalBindingV2, stdioApprovalRequestV2, stdioDispatchV2,
  stdioExecutorOwnerV2, stdioInvocationV2, stdioJsonV2, stdioLimitsV2, stdioPreparedV2,
  stdioReceiptRequestV2, stdioStartAuthorizationV2, stdioStartPermitV2, stdioTaskSchemasV2,
  type StdioActionIdV2, type StdioDigestV2, type StdioExecutionRefV2, type StdioLimitsV2,
  type StdioPreparedV2, type StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioApprovalFingerprintV2, stdioCatalogFingerprintV2, stdioSha256V2,
  type StdioDigestDomainV2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { stdioActionLeaseV2, type StdioActionLeaseV2 } from '@power-evolve/contracts/stdio-runtime'
import { accountUserId } from '../account-contracts.ts'
import { PlatformError, type UserId } from '../contracts.ts'
import { assertActiveAccount, lockAccountAuthorities, requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { assertStdioActionLeaseV2 } from './stdio-v2-leases.ts'

/** Trusted deployment configuration; capture observes resources and rechecks their original live grants. */
export interface StdioAuthorizationOptionsV2 {
  readonly limits: StdioLimitsV2
  readonly approvalKey: Uint8Array
  readonly approvalLifetimeMs: number
  /** Called under account -> Session -> connection -> action -> execution locks; it grants no start. */
  readonly capture: (client: PoolClient, task: StdioTaskV2, executionRef: StdioExecutionRefV2) => Promise<StdioPreparedV2>
}

/** Private immutable observations; only the authenticated original executor router may receive this view. */
export interface StdioPreparationViewV2 {
  readonly prepared: StdioPreparedV2
  readonly taskDigest: StdioDigestV2
  readonly preparedDigest: StdioDigestV2
  readonly fingerprint: StdioDigestV2
  readonly approvalEpoch: 1
  readonly expiresAt: string
}

/** Independent approval display retains the exact invocation/arguments but excludes physical capture paths. */
export interface StdioApprovalViewV2 {
  readonly task: StdioTaskV2
  readonly actualExecutorImage: StdioPreparedV2['actualExecutorImage']
  readonly taskDigest: StdioDigestV2
  readonly preparedDigest: StdioDigestV2
  readonly fingerprint: StdioDigestV2
  readonly approvalEpoch: 1
  readonly expiresAt: string
  readonly state: string
  readonly expired: boolean
  readonly decision: 'once' | 'reject' | null
}

const uuid = z.uuid(), digest = stdioApprovalBindingV2.shape.taskDigest
const actionRow = z.object({ id: uuid, user_id: accountUserId, session_id: uuid, connection_id: uuid,
  config_revision: z.number().int().positive(), config_digest: digest, phase: z.enum(['discover', 'call']),
  execution_target: z.enum(['cloud', 'desktop']), execution_id: uuid, task: z.unknown(), task_digest: digest,
  state: z.enum(['queued', 'preparing', 'pending', 'approved', 'dispatch-intent', 'running', 'stopping',
    'blocked', 'succeeded', 'failed', 'cancelled', 'rejected', 'expired']), cancel_requested: z.boolean(),
  request_id: uuid.nullable(), operation_id: uuid.nullable(), root_operation_id: uuid.nullable(),
  call_id: z.string().nullable(), continuation_request_id: uuid.nullable(),
})
type ActionRow = z.infer<typeof actionRow>
const connectionRow = z.object({ id: uuid, user_id: accountUserId, revision: z.number().int().positive(),
  enabled: z.boolean(), current_catalog_id: uuid.nullable(), deleted_at: z.date().nullable() })
const executionRow = z.object({ id: uuid, user_id: accountUserId, session_id: uuid, execution_kind: z.literal('stdio_v2'),
  execution_target: z.enum(['cloud', 'desktop']), origin_kind: z.enum(['operation', 'stdio_discovery']),
  task_version: z.literal(2), stdio_phase: z.enum(['discover', 'call']), stdio_action_id: uuid,
  stdio_task: z.unknown(), request_digest: digest, operation_id: uuid.nullable(), call_id: z.string().nullable(),
  command: z.null(), cwd: z.null(), continuation_request_id: uuid.nullable(), state: z.string(), cancel_requested: z.boolean(),
  device_id: uuid.optional(), directory_id: uuid.optional(), device_instance_id: uuid.nullable().optional(),
})
type Locked = { action: ActionRow; task: StdioTaskV2; executionRef: StdioExecutionRefV2;
  execution: z.infer<typeof executionRow>; connection: z.infer<typeof connectionRow> }
const preparationRow = z.object({ user_id: accountUserId, session_id: uuid, phase: z.enum(['discover', 'call']),
  execution_target: z.enum(['cloud', 'desktop']), execution_id: uuid, task_digest: digest,
  prepared: stdioPreparedV2, prepared_digest: digest, approval_binding: stdioApprovalBindingV2,
  fingerprint: digest, approval_epoch: z.literal(1), expires_at: z.date() })
const decisionRow = z.object({ user_id: accountUserId, fingerprint: digest, decision: z.enum(['once', 'reject']) })
const permitRow = z.object({ action_id: uuid, permit_id: uuid, authorization_request_id: uuid, execution_id: uuid,
  task_digest: digest, prepared_digest: digest, fingerprint: digest, decision: z.literal('once'),
  executor_owner: stdioExecutorOwnerV2, permit: stdioStartPermitV2, issued_at: z.date(), expires_at: z.date() })

/** The private capture adapter and executor authentication belong to Root's router, never to a browser. */
export class StdioAuthorizationServiceV2 {
  private readonly limits: StdioLimitsV2
  private readonly key: Uint8Array
  private readonly schemas: ReturnType<typeof stdioTaskSchemasV2>
  constructor(private readonly pool: Pool, private readonly options: StdioAuthorizationOptionsV2) {
    this.limits = stdioLimitsV2.parse(options.limits)
    if (!(options.approvalKey instanceof Uint8Array) || options.approvalKey.byteLength !== 32
      || !Number.isSafeInteger(options.approvalLifetimeMs) || options.approvalLifetimeMs <= 0
      || options.approvalLifetimeMs > 2_147_483_647 || typeof options.capture !== 'function') {
      throw new TypeError('stdio_v2_authorization_options_invalid')
    }
    this.key = Uint8Array.from(options.approvalKey)
    this.schemas = stdioTaskSchemasV2(this.limits)
  }
  private budget() {
    return { maxDepth: this.limits.maxJsonDepth, maxNodes: this.limits.maxJsonNodes, maxBytes: this.limits.maxInputBytes }
  }
  private sha(domain: StdioDigestDomainV2, value: unknown) { return stdioSha256V2(domain, value, this.budget()) }
  private same(left: unknown, right: unknown) { return this.sha('spec', left) === this.sha('spec', right) }
  private deny(code: string): never { throw new PlatformError(409, code) }
  private async clock(client: PoolClient) {
    return z.date().parse((await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now)
  }
  private async guard(client: PoolClient, lease?: StdioActionLeaseV2): Promise<void> {
    if (lease) await assertStdioActionLeaseV2(client, lease)
  }
  private async write(client: PoolClient, lease: StdioActionLeaseV2 | undefined, sql: string, values: readonly unknown[]): Promise<void> {
    await this.guard(client, lease)
    const changed = await client.query(sql, [...values])
    if (changed.rowCount !== 1) this.deny('stdio_v2_record_invalid')
    await this.guard(client, lease)
  }
  private async hint(client: PoolClient, actionId: StdioActionIdV2) {
    const row = (await client.query('SELECT user_id,session_id,connection_id FROM pe_stdio_v2_actions WHERE id=$1', [actionId])).rows[0]
    if (!row) throw new PlatformError(404, 'stdio_v2_action_not_found')
    return z.object({ user_id: accountUserId, session_id: uuid, connection_id: uuid }).parse(row)
  }
  private async locked(client: PoolClient, actionId: StdioActionIdV2, userId: UserId): Promise<Locked> {
    const hint = await this.hint(client, actionId)
    if (hint.user_id !== userId) throw new PlatformError(404, 'stdio_v2_action_not_found')
    const session = (await client.query('SELECT id,workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [hint.session_id, userId])).rows[0]
    if (!session) this.deny('stdio_v2_session_changed')
    const connection = connectionRow.parse((await client.query('SELECT * FROM pe_stdio_v2_connections WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [hint.connection_id, userId])).rows[0])
    const action = actionRow.parse((await client.query('SELECT * FROM pe_stdio_v2_actions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [actionId, userId])).rows[0])
    if (action.session_id !== hint.session_id || action.connection_id !== connection.id) this.deny('stdio_v2_action_changed')
    const task = this.schemas.task.parse(action.task)
    const executionRef = stdioStartPermitV2.shape.executionRef.parse({ kind: action.execution_target, executionId: action.execution_id })
    const table = action.execution_target === 'cloud' ? 'pe_cloud_executions' : 'pe_desktop_executions'
    const execution = executionRow.parse((await client.query(`SELECT * FROM ${table} WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [action.execution_id, userId])).rows[0])
    if (task.actionId !== action.id || task.userId !== userId || task.sessionId !== action.session_id
      || task.connectionId !== action.connection_id || task.configRevision !== action.config_revision
      || task.configDigest !== action.config_digest || task.phase !== action.phase
      || task.scopeBinding.kind !== action.execution_target || this.sha('task', task) !== action.task_digest
      || execution.session_id !== action.session_id || execution.stdio_action_id !== action.id
      || execution.execution_target !== action.execution_target || execution.stdio_phase !== action.phase
      || execution.request_digest !== action.task_digest || !this.same(execution.stdio_task, task)
      || execution.operation_id !== action.operation_id || execution.call_id !== action.call_id
      || execution.continuation_request_id !== action.continuation_request_id) this.deny('stdio_v2_original_changed')
    if (task.scopeBinding.kind === 'cloud' ? task.scopeBinding.workspaceId !== session.workspace_id
      : task.scopeBinding.deviceId !== execution.device_id || task.scopeBinding.directoryId !== execution.directory_id
        || task.scopeBinding.enrollmentId !== execution.device_instance_id) this.deny('stdio_v2_scope_changed')
    if (task.phase === 'discover' ? action.request_id !== task.origin.requestId || execution.origin_kind !== 'stdio_discovery'
      || action.operation_id !== null || action.root_operation_id !== null || action.call_id !== null || action.continuation_request_id !== null
      : action.operation_id !== task.origin.operationId || action.root_operation_id !== task.origin.rootOperationId
        || action.call_id !== task.origin.callKey || execution.origin_kind !== 'operation' || action.request_id !== null
        || action.continuation_request_id === null) this.deny('stdio_v2_origin_changed')
    const config = (await client.query(`SELECT configuration,config_digest FROM pe_stdio_v2_configurations
      WHERE connection_id=$1 AND user_id=$2 AND revision=$3`, [action.connection_id, userId, action.config_revision])).rows[0]
    const parsed = z.object({ configuration: stdioJsonV2(this.budget()).pipe(z.object({
      name: z.string().min(1).refine(value => !value.includes('\0')), invocation: stdioInvocationV2 }).strict()), config_digest: digest }).parse(config)
    if (this.sha('configuration', parsed.configuration) !== action.config_digest || parsed.config_digest !== action.config_digest
      || !this.same(task.invocation, parsed.configuration.invocation)) this.deny('stdio_v2_configuration_changed')
    return { action, task, executionRef, execution, connection }
  }
  private async live(client: PoolClient, original: Locked) {
    const { action, task, connection, execution } = original
    if (connection.deleted_at || connection.revision !== action.config_revision) this.deny('stdio_v2_configuration_stale')
    if (action.cancel_requested || execution.cancel_requested || !['queued', 'preparing', 'pending', 'approved'].includes(action.state)
      || !['queued', 'starting'].includes(execution.state)) this.deny('stdio_v2_action_not_startable')
    if (task.phase === 'call') {
      if (!connection.enabled || connection.current_catalog_id !== task.selection.catalogId) this.deny('stdio_v2_catalog_stale')
      const row = (await client.query(`SELECT c.*,a.state AS action_state,r.result,r.result_digest FROM pe_stdio_v2_catalogs c
        JOIN pe_stdio_v2_actions a ON a.id=c.action_id JOIN pe_stdio_v2_results r ON r.action_id=c.action_id
        WHERE c.id=$1 AND c.user_id=$2 AND c.connection_id=$3 AND c.config_revision=$4`,
      [task.selection.catalogId, action.user_id, action.connection_id, action.config_revision])).rows[0]
      const catalog = z.object({ config_digest: digest, raw_catalog: this.schemas.selection.shape.rawCatalog,
        image_expectation: stdioPreparedV2.shape.actualExecutorImage, catalog_digest: digest,
        action_state: z.literal('succeeded'), result: z.unknown(), result_digest: digest }).parse(row)
      if (catalog.config_digest !== action.config_digest || catalog.catalog_digest !== task.selection.catalogDigest
        || stdioCatalogFingerprintV2(catalog.raw_catalog, this.limits) !== catalog.catalog_digest
        || !this.same(catalog.raw_catalog, task.selection.rawCatalog)
        || !this.same(catalog.image_expectation, task.selection.catalogImageExpectation)
        || this.sha('result', catalog.result) !== catalog.result_digest) this.deny('stdio_v2_catalog_changed')
    }
  }
  private validatePrepared(original: Locked, value: unknown) {
    const prepared = stdioPreparedV2.parse(value)
    if (prepared.actionId !== original.action.id || prepared.taskDigest !== original.action.task_digest
      || !this.same(prepared.executionRef, original.executionRef) || !this.same(prepared.scopeBinding, original.task.scopeBinding)
      || !this.same(prepared.expectedDeploymentPin, original.task.expectedDeploymentPin)
      || prepared.fullScopeDigest !== this.sha('scope', { scopeBinding: prepared.scopeBinding,
        workspaceMount: prepared.capture.workspaceMount, homeMount: prepared.capture.homeMount })
      || original.task.phase === 'call' && !this.same(prepared.actualExecutorImage, original.task.selection.catalogImageExpectation)) {
      this.deny('stdio_v2_capture_changed')
    }
    return prepared
  }
  private async preparation(client: PoolClient, original: Locked): Promise<StdioPreparationViewV2 | null> {
    const row = (await client.query('SELECT * FROM pe_stdio_v2_preparations WHERE action_id=$1', [original.action.id])).rows[0]
    if (!row) return null
    const p = preparationRow.parse(row), prepared = this.validatePrepared(original, p.prepared)
    const binding = p.approval_binding
    if (p.user_id !== original.action.user_id || p.session_id !== original.action.session_id || p.phase !== original.action.phase
      || p.execution_target !== original.executionRef.kind || p.execution_id !== original.executionRef.executionId
      || p.task_digest !== original.action.task_digest || p.prepared_digest !== this.sha('prepared', prepared)
      || binding.actionId !== original.action.id || binding.taskDigest !== p.task_digest || binding.preparedDigest !== p.prepared_digest
      || binding.expiresAt !== p.expires_at.toISOString() || p.fingerprint !== stdioApprovalFingerprintV2(this.key, binding, this.budget())) {
      this.deny('stdio_v2_preparation_changed')
    }
    return { prepared, taskDigest: p.task_digest, preparedDigest: p.prepared_digest, fingerprint: p.fingerprint,
      approvalEpoch: 1, expiresAt: binding.expiresAt }
  }
  private async decision(client: PoolClient, original: Locked, preparation: StdioPreparationViewV2) {
    const row = (await client.query('SELECT user_id,fingerprint,decision FROM pe_stdio_v2_decisions WHERE action_id=$1',
      [original.action.id])).rows[0]
    if (!row) return null
    const parsed = decisionRow.parse(row)
    if (parsed.user_id !== original.action.user_id || parsed.fingerprint !== preparation.fingerprint) this.deny('stdio_v2_decision_changed')
    return parsed.decision
  }
  private async view(client: PoolClient, original: Locked, prepared: StdioPreparationViewV2): Promise<StdioApprovalViewV2> {
    return { task: original.task, actualExecutorImage: prepared.prepared.actualExecutorImage,
      taskDigest: prepared.taskDigest, preparedDigest: prepared.preparedDigest, fingerprint: prepared.fingerprint,
      approvalEpoch: 1, expiresAt: prepared.expiresAt, state: original.action.state,
      expired: (await this.clock(client)).getTime() >= Date.parse(prepared.expiresAt),
      decision: await this.decision(client, original, prepared) }
  }

  /** Freeze the first exact resource observations; a second preparation cannot renew its approval epoch.
   * @param actionId Already admitted action, selected by the authenticated original executor router.
   * @returns Private original preparation after transaction commit; this method never starts or stops resources.
   */
  async prepare(actionId: StdioActionIdV2): Promise<StdioPreparationViewV2> {
    return this.prepareOriginal(actionId)
  }

  /** Freeze observations only while the original Cloud worker generation remains live.
   * @param lease Original claimed action, worker and epoch, rechecked before and after capture and every write.
   * @returns The immutable first preparation; lease loss rolls back and never replaces a captured writer.
   */
  async prepareLeased(lease: StdioActionLeaseV2): Promise<StdioPreparationViewV2> {
    const selected = stdioActionLeaseV2.parse(lease)
    return this.prepareOriginal(selected.actionId, selected)
  }
  private async prepareOriginal(actionId: StdioActionIdV2, lease?: StdioActionLeaseV2): Promise<StdioPreparationViewV2> {
    const id = stdioActionRequestV2.parse({ actionId }).actionId
    return transaction(this.pool, async client => {
      const hint = await this.hint(client, id)
      const account = (await lockAccountAuthorities(client, [hint.user_id], 'update'))[0]!
      assertActiveAccount(account)
      const original = await this.locked(client, id, account.userId)
      await this.guard(client, lease)
      await this.live(client, original)
      const existing = await this.preparation(client, original)
      const fresh = this.validatePrepared(original, await this.options.capture(client, original.task, original.executionRef))
      await this.guard(client, lease)
      if (existing) {
        if (!this.same(existing.prepared, fresh)) this.deny('stdio_v2_capture_changed')
        return existing
      }
      if (!['queued', 'preparing'].includes(original.action.state)) this.deny('stdio_v2_preparation_missing')
      const now = await this.clock(client)
      const binding = stdioApprovalBindingV2.parse({ actionId: id, taskDigest: original.action.task_digest,
        preparedDigest: this.sha('prepared', fresh), approvalEpoch: 1,
        expiresAt: new Date(now.getTime() + this.options.approvalLifetimeMs).toISOString() })
      const fingerprint = stdioApprovalFingerprintV2(this.key, binding, this.budget())
      await this.write(client, lease, `INSERT INTO pe_stdio_v2_preparations
        (action_id,user_id,session_id,phase,execution_target,execution_id,task_digest,prepared,prepared_digest,
         approval_binding,fingerprint,approval_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12)`,
      [id, account.userId, original.action.session_id, original.action.phase, original.executionRef.kind,
        original.executionRef.executionId, binding.taskDigest, JSON.stringify(fresh), binding.preparedDigest,
        JSON.stringify(binding), fingerprint, binding.expiresAt])
      await this.write(client, lease, "UPDATE pe_stdio_v2_actions SET state='pending',updated_at=clock_timestamp() WHERE id=$1", [id])
      return { prepared: fresh, taskDigest: binding.taskDigest, preparedDigest: binding.preparedDigest,
        fingerprint, approvalEpoch: 1, expiresAt: binding.expiresAt }
    })
  }

  /** Inspect an owned pending decision using its independent approval credential.
   * @param token Approval-audience bearer, rechecked under its current account lock.
   * @param actionId Original owned action; no replacement task or capture is accepted.
   * @returns Logical approval details without private executor capture paths.
   */
  async inspect(token: string, actionId: StdioActionIdV2): Promise<StdioApprovalViewV2> {
    const id = stdioActionRequestV2.parse({ actionId }).actionId
    return transaction(this.pool, async client => {
      const actor = await requireBrowserAccount(client, token, { audience: 'approval', lock: 'update' })
      const original = await this.locked(client, id, actor.userId), prepared = await this.preparation(client, original)
      if (!prepared) this.deny('stdio_v2_not_prepared')
      return this.view(client, original, prepared)
    })
  }

  /** Persist one immutable independent decision; rejection requests cancellation without releasing a writer.
   * @param token Approval-audience bearer, never an Agent grant or stale Identity DTO.
   * @param input Original action fingerprint and once/reject decision.
   * @returns The stored decision view; a conflicting second decision fails.
   */
  async decide(token: string, input: z.infer<typeof stdioApprovalRequestV2>): Promise<StdioApprovalViewV2> {
    const request = stdioApprovalRequestV2.parse(input)
    return transaction(this.pool, async client => {
      const actor = await requireBrowserAccount(client, token, { audience: 'approval', lock: 'update' })
      const original = await this.locked(client, request.actionId, actor.userId), prepared = await this.preparation(client, original)
      if (!prepared) this.deny('stdio_v2_not_prepared')
      if (prepared.fingerprint !== request.fingerprint) this.deny('stdio_v2_fingerprint_changed')
      const existing = await this.decision(client, original, prepared)
      if (existing) {
        if (existing !== request.decision) this.deny('stdio_v2_decision_conflict')
        return this.view(client, original, prepared)
      }
      await this.live(client, original)
      if (original.action.state !== 'pending' || (await this.clock(client)).getTime() >= Date.parse(prepared.expiresAt)) {
        this.deny('stdio_v2_approval_expired_or_closed')
      }
      await client.query('INSERT INTO pe_stdio_v2_decisions(action_id,user_id,fingerprint,decision) VALUES($1,$2,$3,$4)',
        [request.actionId, actor.userId, prepared.fingerprint, request.decision])
      const state = request.decision === 'once' ? 'approved' : 'rejected'
      await client.query('UPDATE pe_stdio_v2_actions SET state=$2,cancel_requested=$3,updated_at=clock_timestamp() WHERE id=$1',
        [request.actionId, state, request.decision === 'reject'])
      original.action.state = state
      return this.view(client, original, prepared)
    })
  }

  private owner(prepared: StdioPreparedV2): z.infer<typeof stdioExecutorOwnerV2> {
    return stdioExecutorOwnerV2.parse(prepared.capture.kind === 'cloud'
      ? { kind: 'cloud', runnerInstanceId: prepared.capture.runnerInstanceId }
      : { kind: 'desktop', enrollmentId: prepared.capture.receipt.owner.enrollmentId,
        processId: prepared.capture.processId, dispatchId: prepared.capture.receipt.owner.creationId })
  }
  /** Commit permit and dispatch intent before the sole true reply; later queries always return false.
   * @param actionId Original action selected by the authenticated internal executor router.
   * @param requestId Original authorization retry identity; changing it never grants another start.
   * @param owner Router-authenticated original runner or Device process, compared with private capture.
   * @returns Once authorization after commit; lost commit/reply is reconciled as false, never replayed true.
   */
  async authorize(actionId: StdioActionIdV2, requestId: z.infer<typeof stdioReceiptRequestV2>['requestId'],
    owner: z.infer<typeof stdioExecutorOwnerV2>): Promise<z.infer<typeof stdioStartAuthorizationV2>> {
    return this.authorizeOriginal(actionId, requestId, owner)
  }

  /** Authorize only the live original worker; a takeover can query an existing permit but cannot replay its true grant.
   * @param lease Current original action worker and epoch, fenced around capture and every durable start-intent write.
   * @param requestId Original authorization receipt identity; replacement IDs never reissue start authority.
   * @param owner Authenticated original executor identity, compared against its immutable private capture.
   * @returns Sole true authorization after commit, or the original false receipt on every existing-permit readback.
   */
  async authorizeLeased(lease: StdioActionLeaseV2, requestId: z.infer<typeof stdioReceiptRequestV2>['requestId'],
    owner: z.infer<typeof stdioExecutorOwnerV2>): Promise<z.infer<typeof stdioStartAuthorizationV2>> {
    const selected = stdioActionLeaseV2.parse(lease)
    return this.authorizeOriginal(selected.actionId, requestId, owner, selected)
  }
  private async authorizeOriginal(actionId: StdioActionIdV2, requestId: z.infer<typeof stdioReceiptRequestV2>['requestId'],
    owner: z.infer<typeof stdioExecutorOwnerV2>, lease?: StdioActionLeaseV2): Promise<z.infer<typeof stdioStartAuthorizationV2>> {
    const id = stdioActionRequestV2.parse({ actionId }).actionId
    const request = stdioReceiptRequestV2.parse({ requestId }), caller = stdioExecutorOwnerV2.parse(owner)
    return transaction(this.pool, async client => {
      const hint = await this.hint(client, id)
      const account = (await lockAccountAuthorities(client, [hint.user_id], 'update'))[0]!
      const original = await this.locked(client, id, account.userId), prepared = await this.preparation(client, original)
      await this.guard(client, lease)
      if (!prepared) this.deny('stdio_v2_not_prepared')
      if (!this.same(caller, this.owner(prepared.prepared))) throw new PlatformError(403, 'stdio_v2_executor_owner_changed')
      const decision = await this.decision(client, original, prepared)
      const existing = (await client.query('SELECT * FROM pe_stdio_v2_start_permits WHERE action_id=$1', [id])).rows[0]
      if (existing) {
        const row = permitRow.parse(existing), p = row.permit
        if (decision !== 'once' || row.action_id !== id || row.permit_id !== p.permitId
          || row.authorization_request_id !== p.authorizationRequestId || row.execution_id !== original.executionRef.executionId
          || row.task_digest !== prepared.taskDigest || row.prepared_digest !== prepared.preparedDigest
          || row.fingerprint !== prepared.fingerprint || p.actionId !== id || p.taskDigest !== prepared.taskDigest
          || p.preparedDigest !== prepared.preparedDigest || p.approvalFingerprint !== prepared.fingerprint
          || p.expiresAt !== prepared.expiresAt || p.expiresAt !== row.expires_at.toISOString()
          || p.issuedAt !== row.issued_at.toISOString() || !this.same(p.executionRef, original.executionRef)
          || !this.same(row.executor_owner, caller) || !this.same(p.executorOwner, caller)) this.deny('stdio_v2_permit_changed')
        await this.checkDispatch(client, original, prepared, p)
        await this.guard(client, lease)
        return stdioStartAuthorizationV2.parse({ grantOnce: false, permit: p })
      }
      assertActiveAccount(account)
      await this.live(client, original)
      const now = await this.clock(client)
      if (decision !== 'once' || original.action.state !== 'approved' || now.getTime() >= Date.parse(prepared.expiresAt)) {
        this.deny('stdio_v2_not_approved_or_expired')
      }
      const fresh = this.validatePrepared(original, await this.options.capture(client, original.task, original.executionRef))
      await this.guard(client, lease)
      if (!this.same(fresh, prepared.prepared)) this.deny('stdio_v2_capture_changed')
      const issued = await this.clock(client)
      if (issued.getTime() >= Date.parse(prepared.expiresAt)) this.deny('stdio_v2_approval_expired_or_closed')
      const permit = stdioStartPermitV2.parse({ actionId: id, taskDigest: prepared.taskDigest,
        preparedDigest: prepared.preparedDigest, approvalEpoch: 1, expiresAt: prepared.expiresAt,
        permitId: randomUUID(), authorizationRequestId: request.requestId, executionRef: original.executionRef,
        executorOwner: caller, approvalFingerprint: prepared.fingerprint, issuedAt: issued.toISOString() })
      const dispatch = stdioDispatchV2(this.limits).parse({ formatVersion: 2, task: original.task, taskDigest: prepared.taskDigest,
        executionRef: original.executionRef, preparedDigest: prepared.preparedDigest, permit })
      await this.write(client, lease, `INSERT INTO pe_stdio_v2_start_permits
        (action_id,permit_id,authorization_request_id,execution_id,task_digest,prepared_digest,fingerprint,
         decision,executor_owner,permit,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'once',$8,$9,$10,$11)`,
      [id, permit.permitId, request.requestId, original.executionRef.executionId, prepared.taskDigest, prepared.preparedDigest,
        prepared.fingerprint, JSON.stringify(caller), JSON.stringify(permit), permit.issuedAt, permit.expiresAt])
      await this.write(client, lease, 'INSERT INTO pe_stdio_v2_dispatches(action_id,dispatch,dispatch_digest) VALUES($1,$2,$3)',
        [id, JSON.stringify(dispatch), this.sha('dispatch', dispatch)])
      await this.write(client, lease, "UPDATE pe_stdio_v2_actions SET state='dispatch-intent',updated_at=clock_timestamp() WHERE id=$1", [id])
      return stdioStartAuthorizationV2.parse({ grantOnce: true, permit })
    })
  }
  private async checkDispatch(client: PoolClient, original: Locked, preparation: StdioPreparationViewV2,
    permit: z.infer<typeof stdioStartPermitV2>) {
    const row = (await client.query('SELECT dispatch,dispatch_digest FROM pe_stdio_v2_dispatches WHERE action_id=$1',
      [original.action.id])).rows[0]
    const parsed = z.object({ dispatch: stdioDispatchV2(this.limits), dispatch_digest: digest }).parse(row)
    if (this.sha('dispatch', parsed.dispatch) !== parsed.dispatch_digest || !this.same(parsed.dispatch.task, original.task)
      || parsed.dispatch.taskDigest !== preparation.taskDigest || parsed.dispatch.preparedDigest !== preparation.preparedDigest
      || !this.same(parsed.dispatch.executionRef, original.executionRef) || !this.same(parsed.dispatch.permit, permit)) {
      this.deny('stdio_v2_dispatch_changed')
    }
  }
}
