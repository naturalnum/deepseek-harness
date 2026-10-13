/** Atomic generic STDIO discovery admission; accepted records never start a user program. */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioCheckRequestV2, stdioCloudDeploymentV2, stdioDigestV2,
  stdioJsonV2, stdioLimitsV2, stdioScopeV2, stdioTaskSchemasV2,
  type StdioLimitsV2, type StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioManagementLimitsV2, stdioManagementSchemasV2, type StdioCheckReceiptV2,
  type StdioManagementLimitsV2 } from '@power-evolve/contracts/stdio-management'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { PlatformError, type UserId } from '../contracts.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'
import type { FileService } from './files.ts'

const positive = z.number().int().positive()
const deployments = z.object({ cloud: stdioCloudDeploymentV2.nullable() }).strict()

/** Operator-reviewed pins and finite admission budgets; no browser supplies these selections. */
export interface StdioAdmissionOptionsV2 {
  readonly limits: StdioLimitsV2
  readonly management: StdioManagementLimitsV2
  readonly maxPendingPerUser: number
  readonly deployments: z.infer<typeof deployments>
}
type RequestRow = { purpose: unknown; request: unknown; request_digest: unknown; receipt: unknown }
type ConfigurationRow = { revision: number; configuration: unknown; config_digest: unknown }
type SessionRow = { id: string; workspace_id: string }

/** Admission authenticates the browser, reserves its original writer and commits task/execution together. */
export class StdioAdmissionServiceV2 {
  private readonly options: StdioAdmissionOptionsV2
  private readonly schemas: ReturnType<typeof stdioManagementSchemasV2>
  private readonly task: ReturnType<typeof stdioTaskSchemasV2>['task']

  constructor(private readonly pool: Pool, private readonly files: Pick<FileService, 'bindingForId'>,
    options: StdioAdmissionOptionsV2) {
    this.options = { limits: stdioLimitsV2.parse(options.limits), management: stdioManagementLimitsV2.parse(options.management),
      maxPendingPerUser: positive.parse(options.maxPendingPerUser), deployments: deployments.parse(options.deployments) }
    this.schemas = stdioManagementSchemasV2(this.options.limits, this.options.management)
    this.task = stdioTaskSchemasV2(this.options.limits).task
  }

  private get jsonLimits() {
    const { maxJsonDepth, maxJsonNodes, maxInputBytes } = this.options.limits
    return { maxDepth: maxJsonDepth, maxNodes: maxJsonNodes, maxBytes: maxInputBytes }
  }

  private stored<T>(parse: () => T): T {
    try { return parse() }
    catch (_invalidRecord) { throw new PlatformError(409, 'stdio_v2_record_invalid') }
  }

  private prior(row: RequestRow, input: z.infer<typeof stdioCheckRequestV2>, requestDigest: string): StdioCheckReceiptV2 {
    if (row.purpose !== 'check' || row.request_digest !== requestDigest) throw new PlatformError(409, 'stdio_v2_request_conflict')
    return this.stored(() => {
      const saved = stdioCheckRequestV2.parse(stdioJsonV2(this.jsonLimits).parse(row.request))
      const receipt = this.schemas.checkReceipt.parse(row.receipt)
      if (stdioSha256V2('management', { purpose: 'check', input: saved }, this.jsonLimits) !== requestDigest
        || receipt.requestId !== input.requestId || receipt.connectionId !== input.connectionId
        || receipt.revision !== input.expectedRevision) {
        throw new Error('Stored discovery receipt mismatch')
      }
      return receipt
    })
  }

  private async configuration(client: PoolClient, userId: UserId,
    input: z.infer<typeof stdioCheckRequestV2>): Promise<ConfigurationRow> {
    const row = (await client.query<ConfigurationRow>(`SELECT c.revision,f.configuration,f.config_digest
      FROM pe_stdio_v2_connections c JOIN pe_stdio_v2_configurations f ON f.connection_id=c.id
        AND f.user_id=c.user_id AND f.revision=c.revision
      WHERE c.id=$1 AND c.user_id=$2 AND c.deleted_at IS NULL FOR UPDATE OF c`, [input.connectionId, userId])).rows[0]
    if (!row) throw new PlatformError(404, 'stdio_v2_connection_not_found')
    if (row.revision !== input.expectedRevision) throw new PlatformError(409, 'stdio_v2_revision_conflict')
    return row
  }

  private async scope(client: PoolClient, userId: UserId, session: SessionRow) {
    const deployment = this.options.deployments.cloud
    if (!deployment) throw new PlatformError(503, 'stdio_v2_deployment_unavailable')
    const binding = await this.files.bindingForId(userId, session.workspace_id, client)
    const scopeBinding = stdioScopeV2.parse({ kind: 'cloud', userId, workspaceId: binding.workspaceId,
      bindingGeneration: binding.generation, target: { spaceId: binding.spaceId, rootRelativePath: binding.rootRelativePath },
      home: { kind: 'user', userId } })
    const instance = (await client.query<{ state: string }>('SELECT state FROM pe_sandbox_instances WHERE session_id=$1', [session.id])).rows[0]
    if (instance && ['unknown', 'deleting'].includes(instance.state)) throw new PlatformError(409, 'sandbox_stop_unconfirmed')
    return { scopeBinding, expectedDeploymentPin: deployment }
  }

  private async reserve(client: PoolClient, userId: UserId, session: SessionRow): Promise<void> {
    const full = (await client.query<{ full: boolean }>(`SELECT count(*) >= $2::bigint AS full FROM pe_stdio_v2_actions a
      WHERE a.user_id=$1 AND (a.state IN ('queued','preparing','pending','approved','dispatch-intent','running','stopping','blocked')
        OR EXISTS(SELECT 1 FROM pe_cloud_executions e WHERE e.stdio_action_id=a.id AND e.execution_kind='stdio_v2'
          AND e.state IN ('queued','starting','running','cancelling','uncertain')))`,
    [userId, this.options.maxPendingPerUser])).rows[0]
    if (this.stored(() => z.boolean().parse(full?.full))) throw new PlatformError(409, 'stdio_v2_action_limit')
    const busy = await client.query<Record<string, unknown>>(`SELECT id FROM pe_cloud_executions WHERE session_id=$1
      AND state IN ('queued','starting','running','cancelling','uncertain')`, [session.id])
    if (busy.rowCount) throw new PlatformError(409, 'execution_busy')
  }

  private async execution(client: PoolClient, task: StdioTaskV2, receipt: StdioCheckReceiptV2, digest: string): Promise<void> {
    if (task.phase !== 'discover') throw new Error('Discovery admission requires discovery origin')
    const common = [receipt.executionRef.executionId, task.userId, task.sessionId, digest, JSON.stringify(task), task.actionId]

    await client.query<Record<string, unknown>>(`INSERT INTO pe_cloud_executions(id,user_id,session_id,request_digest,state,execution_kind,
        origin_kind,task_version,stdio_phase,stdio_task,stdio_action_id,operation_id,call_id,command,cwd,continuation_request_id)
        VALUES($1,$2,$3,$4,'queued','stdio_v2','stdio_discovery',2,'discover',$5::json,$6,NULL,NULL,NULL,NULL,NULL)`, common)

  }

  /** Accept one explicit discovery without an Agent operation or a program start.
   * @param token Browser agent bearer, rechecked in the resource transaction.
   * @param request Exact connection revision, owned Session, explicit target and stable retry ID.
   * @returns Original committed action/execution receipt; duplicate content cannot reserve another writer.
   */
  async check(token: string, request: z.infer<typeof stdioCheckRequestV2>): Promise<StdioCheckReceiptV2> {
    const input = stdioCheckRequestV2.parse(stdioJsonV2(this.jsonLimits).parse(request))
    const requestDigest = stdioSha256V2('management', { purpose: 'check', input }, this.jsonLimits)
    return transaction(this.pool, async (client) => {
      const { userId } = await requireBrowserAccount(client, token, { audience: 'agent', lock: 'update' })
      const prior = (await client.query<RequestRow>(`SELECT purpose,request,request_digest,receipt
        FROM pe_stdio_v2_management_requests WHERE user_id=$1 AND request_id=$2`, [userId, input.requestId])).rows[0]
      if (prior) return this.prior(prior, input, requestDigest)
      const session = (await client.query<SessionRow>('SELECT id,workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [input.sessionId, userId])).rows[0]
      if (!session) throw new PlatformError(404, 'session_not_found')
      const current = await this.configuration(client, userId, input)
      const configuration = this.stored(() => this.schemas.configuration.parse(current.configuration))
      const configDigest = this.stored(() => stdioDigestV2.parse(current.config_digest))
      if (configDigest !== stdioSha256V2('configuration', configuration, this.jsonLimits)) throw new PlatformError(409, 'stdio_v2_record_invalid')
      await this.reserve(client, userId, session)
      const scope = await this.scope(client, userId, session)
      const task = this.task.parse({ formatVersion: 2, actionId: randomUUID(), userId, sessionId: input.sessionId,
        connectionId: input.connectionId, configRevision: input.expectedRevision, configDigest, ...scope,
        invocation: configuration.invocation, limits: this.options.limits, phase: 'discover',
        origin: { kind: 'stdio_discovery', requestId: input.requestId } })
      const taskDigest = stdioSha256V2('task', task, this.jsonLimits)
      const receipt = this.schemas.checkReceipt.parse({ purpose: 'check', requestId: input.requestId,
        connectionId: input.connectionId, revision: input.expectedRevision, actionId: task.actionId,
        executionRef: { kind: input.target.kind, executionId: randomUUID() } })
      await client.query<Record<string, unknown>>(`INSERT INTO pe_stdio_v2_management_requests(user_id,request_id,purpose,request,request_digest,receipt)
        VALUES($1,$2,'check',$3::json,$4,$5::json)`, [userId, input.requestId, JSON.stringify(input), requestDigest, JSON.stringify(receipt)])
      await client.query<Record<string, unknown>>(`INSERT INTO pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,
        phase,execution_target,execution_id,request_id,task,task_digest,state)
        VALUES($1,$2,$3,$4,$5,$6,'discover',$7,$8,$9,$10::json,$11,'queued')`,
      [task.actionId, userId, input.sessionId, input.connectionId, input.expectedRevision, configDigest,
        input.target.kind, receipt.executionRef.executionId, input.requestId, JSON.stringify(task), taskDigest])
      await this.execution(client, task, receipt, taskDigest)
      await client.query<Record<string, unknown>>("SELECT pg_notify('pe_stdio_v2_actions',$1)", [task.actionId])
      return receipt
    })
  }
}
