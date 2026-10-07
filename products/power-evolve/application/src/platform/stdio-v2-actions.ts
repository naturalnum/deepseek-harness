/** Owner-scoped Cloud STDIO action reads and cancellation requests; no browser assertion retires a writer. */
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioActionRequestV2, stdioDigestV2, stdioExecutionRefV2, stdioInvocationV2, stdioJsonV2,
  stdioLimitsV2, stdioTaskSchemasV2, type StdioLimitsV2, type StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCloudStopEvidenceV2, stdioRuntimeViewV2, type StdioOutcomeV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioSha256V2, type StdioDigestDomainV2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { accountUserId } from '../account-contracts.ts'
import { PlatformError, type UserId } from '../contracts.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import { parseStdioNoStartReceiptV2 } from './stdio-v2-no-start.ts'
import { readStdioCallRootAuthorityV2 } from './stdio-v2-call-authority.ts'

const uuid = z.uuid(), integer = z.number().int().nonnegative().safe(), digest = stdioDigestV2
const state = z.enum(['queued', 'preparing', 'pending', 'approved', 'dispatch-intent', 'running', 'stopping',
  'blocked', 'succeeded', 'failed', 'cancelled', 'rejected', 'expired'])
const actionRow = z.object({ id: uuid, user_id: accountUserId, session_id: uuid, connection_id: uuid,
  config_revision: z.number().int().positive(), config_digest: digest, execution_target: z.literal('cloud'), execution_id: uuid,
  phase: z.enum(['discover', 'call']), task: z.unknown(), task_digest: digest, state, cancel_requested: z.boolean(),
  request_id: uuid.nullable(), operation_id: uuid.nullable(), root_operation_id: uuid.nullable(), call_id: z.string().nullable(),
  continuation_request_id: uuid.nullable(), created_at: z.date(), updated_at: z.date() })
const executionRow = z.object({ id: uuid, user_id: accountUserId, session_id: uuid, execution_kind: z.literal('stdio_v2'),
  execution_target: z.literal('cloud'), task_version: z.literal(2), stdio_phase: z.enum(['discover', 'call']),
  stdio_task: z.unknown(), stdio_action_id: uuid, request_digest: digest,
  origin_kind: z.enum(['operation', 'stdio_discovery']), command: z.null(), cwd: z.null(),
  operation_id: uuid.nullable(), call_id: z.string().nullable(), continuation_request_id: uuid.nullable(),
  state: z.enum(['queued', 'starting', 'running', 'cancelling', 'uncertain', 'succeeded', 'failed', 'cancelled']),
  cancel_requested: z.boolean(), sandbox_name: z.string().nullable(), pod_uid: uuid.nullable(), runner_instance_id: uuid.nullable() })
const terminal = new Set(['succeeded', 'failed', 'cancelled'])

/** Explicit deployment budgets; pagination and complete replies never default or truncate. */
export interface StdioActionOptionsV2 {
  readonly limits: StdioLimitsV2
  readonly maxReplyBytes: number
  readonly maxPageSize: number
}
/** Logical persisted status, not a new observation of the executor or its processes. */
export interface StdioActionSummaryV2 {
  readonly formatVersion: 2
  readonly actionId: StdioTaskV2['actionId']
  readonly executionRef: z.infer<typeof stdioExecutionRefV2.options[0]>
  readonly sessionId: StdioTaskV2['sessionId']
  readonly connectionId: StdioTaskV2['connectionId']
  readonly configRevision: number
  readonly phase: 'discover' | 'call'
  readonly taskDigest: StdioTaskV2['configDigest']
  readonly state: z.infer<typeof state>
  readonly executionState: z.infer<typeof executionRow>['state']
  readonly cancelRequested: boolean
  readonly createdAt: string
  readonly updatedAt: string
}
/** Complete original logical task and formal result, excluding private capture, permits and resource paths. */
export interface StdioActionDetailV2 extends StdioActionSummaryV2 {
  readonly task: StdioTaskV2
  readonly outcome: StdioOutcomeV2 | null
  readonly noStart: { readonly kind: 'unstarted_closed'; readonly startNeverAuthorized: true;
    readonly resourceDisposition: 'unallocated' | 'ready_retained' | 'creation_stopped' } | null
}
/** Bounded persisted action page; approval pages are candidates for the separate Authorization.inspect operation. */
export interface StdioActionListV2 {
  readonly items: readonly StdioActionSummaryV2[]
  readonly nextOffset: number | null
}
type Original = { action: z.infer<typeof actionRow>; execution: z.infer<typeof executionRow>; task: StdioTaskV2 }

/** Fixed browser audiences and original durable identities guard every query and cancellation transaction. */
export class StdioActionServiceV2 {
  private readonly options: StdioActionOptionsV2
  private readonly task: ReturnType<typeof stdioTaskSchemasV2>['task']
  private readonly runtime: ReturnType<typeof stdioRuntimeViewV2>
  private readonly page: z.ZodType<{ offset: number; limit: number }>

  constructor(private readonly pool: Pool, options: StdioActionOptionsV2) {
    this.options = { limits: stdioLimitsV2.parse(options.limits),
      maxReplyBytes: z.number().int().positive().safe().parse(options.maxReplyBytes),
      maxPageSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1).parse(options.maxPageSize) }
    this.task = stdioTaskSchemasV2(this.options.limits).task
    this.runtime = stdioRuntimeViewV2(this.options.limits, this.options.maxReplyBytes)
    this.page = z.object({ offset: integer, limit: z.number().int().positive().max(this.options.maxPageSize) }).strict()
      .refine(value => Number.isSafeInteger(value.offset + value.limit))
  }
  private budget(maxBytes = this.options.limits.maxInputBytes) {
    return { maxDepth: this.options.limits.maxJsonDepth, maxNodes: this.options.limits.maxJsonNodes, maxBytes }
  }
  private sha(domain: StdioDigestDomainV2, value: unknown) { return stdioSha256V2(domain, value, this.budget()) }
  private stored<T>(parse: () => T): T {
    try { return parse() }
    catch (_invalidRecord) { throw new PlatformError(409, 'stdio_v2_record_invalid') }
  }
  private reply<T>(value: T): T {
    if (!stdioJsonV2(this.budget(this.options.maxReplyBytes)).safeParse(value).success) {
      throw new PlatformError(413, 'stdio_v2_reply_limit')
    }
    return value
  }

  private async original(client: PoolClient, userId: UserId, id: string): Promise<Original> {
    const hint = (await client.query('SELECT session_id,connection_id FROM pe_stdio_v2_actions WHERE id=$1 AND user_id=$2 AND execution_target=\'cloud\'',
      [id, userId])).rows[0]
    if (!hint) throw new PlatformError(404, 'stdio_v2_action_not_found')
    const identity = this.stored(() => z.object({ session_id: uuid, connection_id: uuid }).parse(hint))
    const session = (await client.query('SELECT id,workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [identity.session_id, userId])).rows[0]
    const connection = (await client.query('SELECT id,user_id FROM pe_stdio_v2_connections WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [identity.connection_id, userId])).rows[0]
    const rawAction = (await client.query('SELECT * FROM pe_stdio_v2_actions WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])).rows[0]
    const action = this.stored(() => actionRow.parse(rawAction))
    const rawExecution = (await client.query('SELECT * FROM pe_cloud_executions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [action.execution_id, userId])).rows[0]
    const rawConfiguration = (await client.query('SELECT configuration,config_digest FROM pe_stdio_v2_configurations WHERE connection_id=$1 AND user_id=$2 AND revision=$3',
      [action.connection_id, userId, action.config_revision])).rows[0]
    const original = this.stored(() => {
      const execution = executionRow.parse(rawExecution), task = this.task.parse(action.task)
      const configuration = z.object({ config_digest: digest, configuration: stdioJsonV2(this.budget()).pipe(
        z.object({ name: z.string().min(1), invocation: stdioInvocationV2 }).strict()) }).parse(rawConfiguration)
      const s = z.object({ id: uuid, workspace_id: uuid }).parse(session)
      const c = z.object({ id: uuid, user_id: accountUserId }).parse(connection)
      if (action.id !== id || action.user_id !== userId || action.session_id !== s.id || action.connection_id !== c.id || c.user_id !== userId
        || task.actionId !== id || task.userId !== userId || task.sessionId !== s.id || task.connectionId !== c.id
        || task.phase !== action.phase || task.configRevision !== action.config_revision || task.configDigest !== action.config_digest
        || task.scopeBinding.kind !== 'cloud' || task.scopeBinding.workspaceId !== s.workspace_id || this.sha('task', task) !== action.task_digest
        || configuration.config_digest !== action.config_digest || this.sha('configuration', configuration.configuration) !== action.config_digest
        || !isDeepStrictEqual(configuration.configuration.invocation, task.invocation)
        || execution.id !== action.execution_id || execution.user_id !== userId || execution.session_id !== s.id
        || execution.stdio_action_id !== id || execution.stdio_phase !== task.phase || execution.request_digest !== action.task_digest
        || !isDeepStrictEqual(this.task.parse(execution.stdio_task), task) || execution.operation_id !== action.operation_id
        || execution.call_id !== action.call_id || execution.continuation_request_id !== action.continuation_request_id
        || (task.phase === 'discover' ? execution.origin_kind !== 'stdio_discovery' || action.request_id !== task.origin.requestId
          || action.operation_id !== null || action.root_operation_id !== null || action.call_id !== null || action.continuation_request_id !== null
          : execution.origin_kind !== 'operation' || action.request_id !== null || action.operation_id !== task.origin.operationId
            || action.root_operation_id !== task.origin.rootOperationId || action.call_id !== task.origin.callKey || action.continuation_request_id === null)) {
        throw new Error('Original action binding changed')
      }
      return { action, execution, task }
    })
    // Historical root cancellation/expiry does not hide a result or prevent local cancellation.
    // This existing reader still rejects a forged operation/root/owner relationship.
    await readStdioCallRootAuthorityV2(client, original.task)
    return original
  }
  private summary({ action, execution, task }: Original): StdioActionSummaryV2 {
    return { formatVersion: 2, actionId: task.actionId,
      executionRef: stdioExecutionRefV2.options[0].parse({ kind: 'cloud', executionId: execution.id }),
      sessionId: task.sessionId, connectionId: task.connectionId, configRevision: action.config_revision, phase: action.phase,
      taskDigest: stdioDigestV2.parse(action.task_digest), state: action.state, executionState: execution.state,
      cancelRequested: action.cancel_requested || execution.cancel_requested,
      createdAt: action.created_at.toISOString(), updatedAt: action.updated_at.toISOString() }
  }

  private async listing(token: string, input: { offset: number; limit: number; sessionId?: string }, audience: 'agent' | 'approval'): Promise<StdioActionListV2> {
    const parsed = z.object({ offset: integer, limit: z.number().int().positive(), sessionId: uuid.optional() }).strict()
      .parse(stdioJsonV2(this.budget()).parse(input)), page = this.page.parse({ offset: parsed.offset, limit: parsed.limit })
    return transaction(this.pool, async client => {
      const { userId } = await requireBrowserAccount(client, token, { audience, lock: 'update' })
      if (parsed.sessionId && !(await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [parsed.sessionId, userId])).rowCount) throw new PlatformError(404, 'session_not_found')
      const rows = (await client.query(`SELECT id FROM pe_stdio_v2_actions WHERE user_id=$1 AND execution_target='cloud'
        AND ($2::uuid IS NULL OR session_id=$2) ORDER BY created_at DESC,id DESC LIMIT $3::bigint OFFSET $4::bigint`,
      [userId, parsed.sessionId ?? null, page.limit + 1, page.offset])).rows
      const items = []
      for (const row of rows.slice(0, page.limit)) items.push(this.summary(await this.original(client, userId, this.stored(() => uuid.parse(row.id)))))
      return this.reply({ items, nextOffset: rows.length > page.limit ? page.offset + page.limit : null })
    })
  }
  /** List bounded persisted summaries under the current browser's Agent credential.
   * @param token Current agent-audience browser bearer, rechecked under the account lock.
   * @param input Explicit page and optional owned Session; no target or user assertion is accepted.
   * @returns One complete page without executor capture, permits or resource paths.
   */
  async list(token: string, input: { sessionId?: string; offset: number; limit: number }): Promise<StdioActionListV2> {
    return this.listing(token, input, 'agent')
  }
  /** List candidates for the independent approval console without opening nested inspect transactions.
   * @param token Current approval-audience bearer; Agent, operation and Device credentials cannot substitute.
   * @param input Explicit bounded page; selecting an action subsequently calls Authorization.inspect.
   * @returns Logical summaries, not approval fingerprints, new approvals or current executor observations.
   */
  async approvalList(token: string, input: { offset: number; limit: number }): Promise<StdioActionListV2> {
    const page = this.page.parse(stdioJsonV2(this.budget()).parse(input))
    return this.listing(token, page, 'approval')
  }

  /** Read an original task and any formal immutable outcome or no-start closure.
   * @param token Current agent-audience browser bearer, never an execution grant.
   * @param input Exact owned Cloud action identity.
   * @returns Complete persisted logical details; stop facts are historical and no live executor query occurs.
   */
  async detail(token: string, input: z.infer<typeof stdioActionRequestV2>): Promise<StdioActionDetailV2> {
    const request = stdioActionRequestV2.parse(stdioJsonV2(this.budget()).parse(input))
    return transaction(this.pool, async client => {
      const { userId } = await requireBrowserAccount(client, token, { audience: 'agent', lock: 'update' })
      const o = await this.original(client, userId, request.actionId), summary = this.summary(o)
      const result = (await client.query('SELECT * FROM pe_stdio_v2_results WHERE action_id=$1', [request.actionId])).rows[0]
      const closure = (await client.query('SELECT * FROM pe_stdio_v2_no_start_closures WHERE action_id=$1', [request.actionId])).rows[0]
      const details = this.stored(() => {
        if (result && closure || terminal.has(o.action.state) && !result && !closure) throw new Error('Invalid terminal evidence')
        let outcome: StdioOutcomeV2 | null = null, noStart: StdioActionDetailV2['noStart'] = null
        if (result) {
          const row = z.object({ action_id: uuid, result: z.unknown(), result_digest: digest,
            observation: this.runtime, stop_evidence: stdioCloudStopEvidenceV2 }).parse(result)
          const view = row.observation, proof = row.stop_evidence
          if (!view.outcome || !terminal.has(o.action.state) || o.execution.state !== o.action.state
            || (view.state === 'completed' ? 'succeeded' : view.state) !== o.action.state || !view.writerStopConfirmed
            || row.action_id !== request.actionId || !isDeepStrictEqual(row.result, view.outcome) || this.sha('result', row.result) !== row.result_digest
            || view.actionId !== request.actionId || view.taskDigest !== o.action.task_digest || !isDeepStrictEqual(view.executionRef, summary.executionRef)
            || view.instanceId !== o.execution.runner_instance_id || proof.actionId !== request.actionId || proof.taskDigest !== view.taskDigest
            || !isDeepStrictEqual(proof.executionRef, summary.executionRef) || proof.dispatchDigest !== view.dispatchDigest
            || proof.runnerInstanceId !== view.instanceId || proof.podUid !== o.execution.pod_uid
            || view.outcome.state === 'completed' && view.outcome.phase !== o.task.phase) throw new Error('Formal result binding changed')
          outcome = view.outcome
        } else if (closure) {
          const row = z.object({ action_id: uuid, user_id: accountUserId, session_id: uuid, phase: z.enum(['discover', 'call']),
            execution_target: z.literal('cloud'), execution_id: uuid, task_digest: digest, prepared_digest: digest.nullable(),
            receipt: z.unknown(), receipt_digest: digest }).parse(closure)
          const receipt = parseStdioNoStartReceiptV2(row.receipt, this.options.limits)
          if (row.action_id !== request.actionId || row.user_id !== userId || row.session_id !== o.task.sessionId || row.phase !== o.task.phase
            || row.execution_id !== o.execution.id || row.task_digest !== o.action.task_digest || this.sha('no_start', receipt) !== row.receipt_digest
            || receipt.actionId !== request.actionId || receipt.userId !== userId || receipt.sessionId !== o.task.sessionId
            || receipt.phase !== o.task.phase || receipt.taskDigest !== o.action.task_digest || receipt.preparedDigest !== row.prepared_digest
            || !isDeepStrictEqual(receipt.executionRef, summary.executionRef) || o.action.state !== 'cancelled' || o.execution.state !== 'cancelled'
            || !o.action.cancel_requested || !o.execution.cancel_requested) throw new Error('Formal closure binding changed')
          noStart = { kind: receipt.kind, startNeverAuthorized: true, resourceDisposition: receipt.resource.kind }
        }
        return { ...summary, task: o.task, outcome, noStart }
      })
      return this.reply(details)
    })
  }

  /** Request cancellation of both original records; only the leased worker can stop or finalize them.
   * @param token Current agent-audience browser bearer, rechecked before durable writes.
   * @param input Exact original owned Cloud action; retries are idempotent flag requests.
   * @returns Persisted summary without clearing writer/lease, fabricating a result or cancelling the root chain.
   */
  async cancel(token: string, input: z.infer<typeof stdioActionRequestV2>): Promise<StdioActionSummaryV2> {
    const request = stdioActionRequestV2.parse(stdioJsonV2(this.budget()).parse(input))
    return transaction(this.pool, async client => {
      const { userId } = await requireBrowserAccount(client, token, { audience: 'agent', lock: 'update' })
      const o = await this.original(client, userId, request.actionId)
      if (!terminal.has(o.execution.state)) {
        const changed = await client.query(`UPDATE pe_stdio_v2_actions SET cancel_requested=true,updated_at=clock_timestamp()
          WHERE id=$1 AND user_id=$2 AND NOT cancel_requested RETURNING updated_at`, [request.actionId, userId])
        await client.query(`UPDATE pe_cloud_executions SET cancel_requested=true,updated_at=clock_timestamp()
          WHERE id=$1 AND user_id=$2 AND execution_kind='stdio_v2' AND stdio_action_id=$3 AND NOT cancel_requested`,
        [o.execution.id, userId, request.actionId])
        o.action.cancel_requested = true; o.execution.cancel_requested = true
        if (changed.rows[0]) o.action.updated_at = z.date().parse(changed.rows[0].updated_at)
        await client.query("SELECT pg_notify('pe_stdio_v2_actions',$1)", [request.actionId])
      }
      return this.reply(this.summary(o))
    })
  }
}
