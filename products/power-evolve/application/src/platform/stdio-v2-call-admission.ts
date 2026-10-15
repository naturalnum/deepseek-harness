import { readNativeReservedToolNames } from './native-tool-catalog.ts'
/** Admit one frozen generic Cloud tool call without granting program start authority. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { stdioActionRequestV2, stdioCloudDeploymentV2, stdioDigestV2, stdioExecutionRefV2, stdioJsonV2, stdioLimitsV2,
  stdioObjectV2, stdioScopeV2, stdioTaskSchemasV2, type StdioLimitsV2, type StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { executionTarget, PlatformError, userId as accountUserId, type UserId } from '../contracts.ts'
import { mcpOperationTools } from '../mcp-operation-contracts.ts'
import { assertStdioToolArgumentsV2 } from '../stdio-v2-model-tools.ts'
import type { StdioOperationConnectionV2 } from '../stdio-v2-operation-contracts.ts'
import { transaction } from './database.ts'
import type { FileService } from './files.ts'
import type { StdioOperationAdmissionV2 } from './stdio-v2-operation-admission.ts'
import type { TaskStore } from './tasks.ts'

const positive = z.number().int().positive().max(2_147_483_647)
const uuid = z.uuid()
const row = z.object({ id: stdioActionRequestV2.shape.actionId,
  user_id: uuid, session_id: uuid, operation_id: uuid, root_operation_id: uuid,

  call_id: z.string(), connection_id: uuid, config_revision: positive, config_digest: stdioDigestV2,
  phase: z.literal('call'), execution_target: z.literal('cloud'), execution_id: uuid,
  continuation_request_id: uuid, task: z.unknown(), task_digest: stdioDigestV2, state: z.string().min(1).max(100) })

/** Trusted Cloud pin and root request budgets, shared with remote MCP through the persisted chain. */
export interface StdioCallAdmissionOptionsV2 {
  readonly limits: StdioLimitsV2
  readonly cloudDeployment: z.infer<typeof stdioCloudDeploymentV2>
  readonly maxPendingPerUser: number
  readonly maxCallsPerChain: number
  readonly chainLifetimeMs: number
  readonly reservedNames: readonly string[]
}

/** A committed execution identity; this receipt neither contains a command nor authorizes a start. */
export interface StdioCallReceiptV2 {
  readonly actionId: StdioTaskV2['actionId']
  readonly executionRef: z.infer<typeof stdioExecutionRefV2>
  readonly taskDigest: z.infer<typeof stdioDigestV2>
  readonly state: string
}

/** Native call IDs deduplicate before consuming root capacity; only persisted original selections resolve names. */
export class StdioCallAdmissionV2 {
  private readonly options: StdioCallAdmissionOptionsV2
  constructor(private readonly tasks: Pick<TaskStore, 'pool' | 'authorized'>,
    private readonly selection: Pick<StdioOperationAdmissionV2, 'restore'>,
    private readonly files: Pick<FileService, 'bindingForId'>, options: StdioCallAdmissionOptionsV2) {
    this.options = { limits: stdioLimitsV2.parse(options.limits), cloudDeployment: stdioCloudDeploymentV2.parse(options.cloudDeployment),
      maxPendingPerUser: positive.parse(options.maxPendingPerUser), maxCallsPerChain: positive.parse(options.maxCallsPerChain),
      chainLifetimeMs: positive.parse(options.chainLifetimeMs), reservedNames: z.array(z.string().min(1)).parse(options.reservedNames) }
    if (new Set(this.options.reservedNames).size !== this.options.reservedNames.length) throw new TypeError('stdio_v2_tool_name_conflict')
  }
  private budget() {
    return { maxDepth: this.options.limits.maxJsonDepth, maxNodes: this.options.limits.maxJsonNodes,
      maxBytes: this.options.limits.maxInputBytes }
  }
  private sha(domain: 'task' | 'configuration' | 'spec', value: unknown) { return stdioSha256V2(domain, value, this.budget()) }
  private same(left: unknown, right: unknown) { return this.sha('spec', left) === this.sha('spec', right) }
  private deny(code: string): never { throw new PlatformError(409, code) }
  private receipt(value: z.infer<typeof row>): StdioCallReceiptV2 {
    return { actionId: value.id, executionRef: stdioExecutionRefV2.parse({ kind: 'cloud', executionId: value.execution_id }),
      taskDigest: value.task_digest, state: value.state }
  }
  private async live(client: PoolClient, userId: UserId, sessionId: string, selected: StdioOperationConnectionV2) {
    const connection = (await client.query<Record<string, unknown>>(`SELECT revision,enabled,deleted_at,current_catalog_id FROM pe_stdio_v2_connections
      WHERE id=$1 AND user_id=$2 FOR UPDATE`, [selected.connectionId, userId])).rows[0]
    const current = z.object({ revision: positive, enabled: z.boolean(),
      deleted_at: z.date().nullable(), current_catalog_id: uuid.nullable() }).safeParse(connection)
    if (!current.success || !current.data.enabled || current.data.deleted_at || current.data.revision !== selected.configRevision
      || current.data.current_catalog_id !== selected.catalogId) throw new PlatformError(403, 'stdio_v2_connection_revoked')
    const catalog = (await client.query<Record<string, unknown>>(`SELECT f.configuration,f.config_digest,c.raw_catalog,c.catalog_digest,c.image_expectation
      FROM pe_stdio_v2_configurations f JOIN pe_stdio_v2_catalogs c ON c.connection_id=f.connection_id AND c.user_id=f.user_id
      AND c.config_revision=f.revision WHERE f.connection_id=$1 AND f.user_id=$2 AND f.revision=$3 AND c.id=$4`,
    [selected.connectionId, userId, selected.configRevision, selected.catalogId])).rows[0]
    if (!catalog || catalog.config_digest !== selected.configDigest || this.sha('configuration', catalog.configuration) !== selected.configDigest
      || !this.same(catalog.configuration, selected.configuration) || catalog.catalog_digest !== selected.catalogDigest
      || stdioCatalogFingerprintV2(catalog.raw_catalog, this.options.limits) !== selected.catalogDigest
      || !this.same(catalog.raw_catalog, selected.rawCatalog) || !this.same(catalog.image_expectation, selected.catalogImageExpectation)) {
      this.deny('stdio_v2_catalog_changed')
    }
    const workspace = z.object({ workspace_id: uuid }).parse((await client.query<Record<string, unknown>>(
      'SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId])).rows[0])
    const binding = await this.files.bindingForId(userId, workspace.workspace_id, client)
    const scope = stdioScopeV2.parse({ kind: 'cloud', userId, workspaceId: binding.workspaceId, bindingGeneration: binding.generation,
      target: { spaceId: binding.spaceId, rootRelativePath: binding.rootRelativePath }, home: { kind: 'user', userId } })
    if (!this.same(scope, selected.scopeBinding) || !this.same(selected.expectedDeploymentPin, this.options.cloudDeployment)) {
      this.deny('stdio_v2_scope_changed')
    }
  }
  private async reserve(client: PoolClient, userId: UserId, sessionId: string) {
    const capacity = (await client.query<Record<string, unknown>>(`SELECT count(*) >= $2::bigint AS full FROM pe_stdio_v2_actions a
      WHERE a.user_id=$1 AND (a.state IN ('queued','preparing','pending','approved','dispatch-intent','running','stopping','blocked')
        OR EXISTS(SELECT 1 FROM pe_cloud_executions e WHERE e.stdio_action_id=a.id AND e.execution_kind='stdio_v2'
          AND e.state IN ('queued','starting','running','cancelling','uncertain')))`, [userId, this.options.maxPendingPerUser])).rows[0]
    if (z.boolean().parse(capacity?.full)) throw new PlatformError(429, 'stdio_v2_action_limit')
    const busy = await client.query<Record<string, unknown>>(`SELECT id FROM pe_cloud_executions WHERE session_id=$1
      AND state IN ('queued','starting','running','cancelling','uncertain')`, [sessionId])
    if (busy.rowCount) this.deny('execution_busy')
  }

  /** Persist a native tool call, sharing the original root budget with all later continuations.
   * @param token Current Session grant authenticated by TaskStore; the model supplies no owner or target.
   * @param value Stable call key, original public tool name and complete argument JSON.
   * @returns One original committed receipt on identical retry, before later revocation or capacity checks.
   */
  async propose(token: string, value: unknown): Promise<StdioCallReceiptV2> {
    const input = stdioJsonV2(this.budget()).pipe(z.object({
      callKey: z.string().min(1).max(100).refine(key => !key.includes('\0')),
      toolName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), arguments: stdioObjectV2(this.budget()),
    }).strict()).parse(value)
    return transaction(this.tasks.pool, async (client) => {
      const grant = await this.tasks.authorized(client, token)
      executionTarget.parse(grant.execution_target)
      const operation = z.object({ stdio_v2_selection: z.unknown(), remote_mcp_selection: z.unknown(),
        root_id: uuid, root_session_id: uuid, root_user_id: uuid,
        root_source: z.string(), root_parent: uuid.nullable(), error_code: z.string().nullable(),

        mcp_chain_cancelled_at: z.date().nullable() }).parse((await client.query<Record<string, unknown>>(`SELECT o.stdio_v2_selection,o.remote_mcp_selection,
          r.id AS root_id,r.session_id AS root_session_id,s.user_id AS root_user_id,r.source AS root_source,
          r.mcp_root_operation_id AS root_parent,o.error_code,r.mcp_chain_cancelled_at
          FROM pe_operations o JOIN pe_operations r ON r.id=COALESCE(o.mcp_root_operation_id,o.id)
          JOIN pe_sessions s ON s.id=r.session_id WHERE o.id=$1 AND o.session_id=$2`, [grant.operation_id, grant.id])).rows[0])
      if (operation.root_session_id !== grant.id || operation.root_user_id !== grant.user_id) this.deny('stdio_v2_origin_changed')
      const reserved = [...await readNativeReservedToolNames(client, grant.user_id, this.options.reservedNames),
        ...mcpOperationTools.parse(operation.remote_mcp_selection).map(tool => tool.model.name)]
      const groups = this.selection.restore(operation.stdio_v2_selection, reserved)
      const selected = groups.find(group => group.tools.some(tool => tool.model.name === input.toolName))
      const name = selected?.tools.find(tool => tool.model.name === input.toolName)?.rawName
      const descriptor = selected?.rawCatalog.find(tool => tool.name === name)
      if (!selected || !descriptor) throw new PlatformError(403, 'stdio_v2_tool_not_in_operation')
      if (selected.scopeBinding.userId !== grant.user_id) this.deny('stdio_v2_origin_changed')
      const previous = (await client.query<Record<string, unknown>>('SELECT * FROM pe_stdio_v2_actions WHERE operation_id=$1 AND call_id=$2',
        [grant.operation_id, input.callKey])).rows[0]
      const prior = previous ? row.parse(previous) : null
      const task = stdioTaskSchemasV2(this.options.limits).task.parse({ formatVersion: 2, actionId: prior?.id ?? randomUUID(),
        userId: grant.user_id, sessionId: grant.id, connectionId: selected.connectionId, configRevision: selected.configRevision,
        configDigest: selected.configDigest, scopeBinding: selected.scopeBinding, expectedDeploymentPin: selected.expectedDeploymentPin,
        invocation: selected.configuration.invocation, limits: selected.limits, phase: 'call',
        origin: { kind: 'operation', operationId: grant.operation_id, rootOperationId: operation.root_id, callKey: input.callKey },
        selection: { catalogId: selected.catalogId, catalogDigest: selected.catalogDigest, rawCatalog: selected.rawCatalog,
          catalogImageExpectation: selected.catalogImageExpectation,
          rawName: name, rawDescriptor: descriptor, arguments: input.arguments } })
      const taskDigest = this.sha('task', task)
      if (prior) {
        const original = stdioTaskSchemasV2(this.options.limits).task.parse(prior.task)
        if (prior.user_id !== grant.user_id || prior.session_id !== grant.id || prior.root_operation_id !== operation.root_id
          || prior.connection_id !== task.connectionId || prior.config_revision !== task.configRevision
            || prior.config_digest !== task.configDigest
          || prior.task_digest !== taskDigest || this.sha('task', original) !== taskDigest || !this.same(original, task)) {
          this.deny('stdio_v2_request_conflict')
        }
        const execution = (await client.query<Record<string, unknown>>(`SELECT id FROM pe_cloud_executions WHERE id=$1 AND user_id=$2 AND session_id=$3
          AND operation_id=$4 AND call_id=$5 AND execution_kind='stdio_v2' AND stdio_phase='call' AND stdio_action_id=$6
          AND continuation_request_id=$7 AND request_digest=$8 AND stdio_task::text=$9`, [prior.execution_id, grant.user_id, grant.id,
          grant.operation_id, input.callKey, prior.id, prior.continuation_request_id, taskDigest, JSON.stringify(original)])).rows[0]
        if (!execution) this.deny('stdio_v2_origin_changed')
        return this.receipt(prior)
      }
      if (operation.root_source !== 'user' || operation.root_parent !== null) this.deny('stdio_v2_origin_changed')
      assertStdioToolArgumentsV2(descriptor, input.arguments, this.options.limits)
      if (operation.mcp_chain_cancelled_at || ['cancel_requested', 'turn_user'].includes(operation.error_code ?? '')) this.deny('mcp_chain_stopped')
      await this.live(client, accountUserId.parse(grant.user_id), grant.id, selected)
      await client.query<Record<string, unknown>>(`INSERT INTO pe_mcp_action_chains(root_operation_id,user_id,session_id,max_calls,expires_at)
        SELECT id,$2,session_id,$3,created_at+$4::double precision*interval '1 millisecond' FROM pe_operations WHERE id=$1
        ON CONFLICT DO NOTHING`, [operation.root_id, grant.user_id, this.options.maxCallsPerChain, this.options.chainLifetimeMs])
      const chain = z.object({ user_id: uuid, session_id: uuid, calls: z.number().int().nonnegative(), max_calls: positive,
        stopped_at: z.date().nullable(), expires_at: z.date(), live: z.boolean() }).parse((await client.query<Record<string, unknown>>(`SELECT *,
          expires_at>clock_timestamp() AS live FROM pe_mcp_action_chains WHERE root_operation_id=$1 FOR UPDATE`, [operation.root_id])).rows[0])
      if (chain.user_id !== grant.user_id || chain.session_id !== grant.id) this.deny('stdio_v2_origin_changed')
      if (chain.stopped_at || !chain.live) this.deny('mcp_chain_stopped')
      if (chain.calls >= chain.max_calls) throw new PlatformError(429, 'mcp_chain_call_limit')
      await this.reserve(client, accountUserId.parse(grant.user_id), grant.id)
      const fresh = await this.tasks.authorized(client, token)
      if (fresh.operation_id !== grant.operation_id || fresh.lease_epoch !== grant.lease_epoch) this.deny('lease_lost')
      if (!(await client.query<Record<string, unknown>>('SELECT root_operation_id FROM pe_mcp_action_chains WHERE root_operation_id=$1 AND stopped_at IS NULL AND expires_at>clock_timestamp()', [operation.root_id])).rowCount) this.deny('mcp_chain_stopped')
      const executionId = randomUUID(), continuationId = randomUUID()
      await client.query<Record<string, unknown>>(`INSERT INTO pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,phase,
        execution_target,execution_id,operation_id,root_operation_id,call_id,continuation_request_id,task,task_digest,state)
        VALUES($1,$2,$3,$4,$5,$6,'call','cloud',$7,$8,$9,$10,$11,$12::json,$13,'queued')`,
      [task.actionId, grant.user_id, grant.id, task.connectionId, task.configRevision, task.configDigest, executionId,
        grant.operation_id, operation.root_id, input.callKey, continuationId, JSON.stringify(task), taskDigest])
      await client.query<Record<string, unknown>>(`INSERT INTO pe_cloud_executions(id,user_id,session_id,operation_id,call_id,request_digest,state,execution_kind,
        origin_kind,task_version,stdio_phase,stdio_task,stdio_action_id,continuation_request_id,command,cwd)
        VALUES($1,$2,$3,$4,$5,$6,'queued','stdio_v2','operation',2,'call',$7::json,$8,$9,NULL,NULL)`,
      [executionId, grant.user_id, grant.id, grant.operation_id,
        input.callKey, taskDigest, JSON.stringify(task), task.actionId,
        continuationId])
      await client.query<Record<string, unknown>>('UPDATE pe_mcp_action_chains SET calls=calls+1 WHERE root_operation_id=$1', [operation.root_id])
      await client.query<Record<string, unknown>>("SELECT pg_notify('pe_stdio_v2_actions',$1)", [task.actionId])
      return { actionId: task.actionId, executionRef: stdioExecutionRefV2.parse({ kind: 'cloud', executionId }), taskDigest, state: 'queued' }
    })
  }
}
