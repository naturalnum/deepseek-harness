/** Select historical STDIO catalogs for an owned Cloud operation; no resource or program starts here. */
import type { PoolClient } from 'pg'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { stdioCloudDeploymentV2, stdioDigestV2, stdioExecutorImageV2, stdioJsonV2, stdioLimitsV2,
  stdioPreparedV2, stdioScopeV2, stdioTaskSchemasV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCanonicalJsonV2 } from '@power-evolve/contracts/stdio-mcp-json'
import { stdioOutcomeV2 } from '@power-evolve/contracts/stdio-runtime'
import { PlatformError, type ExecutionTarget, type UserId } from '../contracts.ts'
import { stdioOperationAdmissionLimitsV2, stdioOperationSchemasV2,
  type StdioOperationAdmissionLimitsV2, type StdioOperationConnectionInputV2,
  type StdioOperationConnectionV2 } from '../stdio-v2-operation-contracts.ts'
import { compileStdioOperationToolsV2, StdioOperationToolErrorV2 } from '../stdio-v2-model-tools.ts'
import { requireActiveAccount } from './account-authority.ts'
import type { FileService } from './files.ts'

/** Trusted complete selection budgets and one reviewed Cloud deployment; Device selection remains unavailable. */
export interface StdioOperationAdmissionOptionsV2 {
  readonly limits: StdioLimitsV2
  readonly admission: StdioOperationAdmissionLimitsV2
  readonly maxReplyBytes: number
  readonly cloudDeployment: z.infer<typeof stdioCloudDeploymentV2>
}
const uuid = z.uuid()
const rowSchema = z.object({ connection_id: uuid, user_id: uuid, config_revision: z.number().int().positive(),
  config_digest: stdioDigestV2, configuration: z.unknown(), catalog_id: uuid, raw_catalog: z.unknown(),
  image_expectation: stdioExecutorImageV2, catalog_digest: stdioDigestV2,
  action_id: uuid, producer_session_id: uuid, producer_workspace_id: uuid,
  action_state: z.literal('succeeded'), action_phase: z.literal('discover'), action_target: z.enum(['cloud','desktop']),
  action_execution_id: uuid, action_revision: z.number().int().positive(), action_config_digest: stdioDigestV2,
  task: z.unknown(), task_digest: stdioDigestV2, result: z.unknown(), result_digest: stdioDigestV2,
  prepared: z.unknown(), prepared_digest: stdioDigestV2 })

/** PG readers validate original producer facts; saved selections grant no authority for later execution. */
export class StdioOperationAdmissionV2 {
  private readonly options: StdioOperationAdmissionOptionsV2
  constructor(private readonly files: Pick<FileService,'bindingForId'>, options: StdioOperationAdmissionOptionsV2) {
    this.options = { limits: stdioLimitsV2.parse(options.limits), admission: stdioOperationAdmissionLimitsV2.parse(options.admission),
      maxReplyBytes: z.number().int().positive().safe().parse(options.maxReplyBytes),
      cloudDeployment: stdioCloudDeploymentV2.parse(options.cloudDeployment) }
  }
  private budget() {
    return { maxDepth: this.options.limits.maxJsonDepth, maxNodes: this.options.limits.maxJsonNodes,
      maxBytes: this.options.limits.maxInputBytes }
  }
  private same(left: unknown, right: unknown): boolean {
    return stdioCanonicalJsonV2(left,this.budget()) === stdioCanonicalJsonV2(right,this.budget())
  }
  private invalid(): never { throw new PlatformError(409,'stdio_v2_record_invalid') }
  private compile(value: unknown, names: readonly string[]): StdioOperationConnectionV2[] {
    try { return compileStdioOperationToolsV2(value,this.options.limits,this.options.admission,names) }
    catch (error) {
      if(error instanceof StdioOperationToolErrorV2) throw new PlatformError(409,error.code)
      throw error
    }
  }

  /** Revalidate and recompile only the stored input fields, retaining the exact accepted model map.
   * @param value Complete original PG selection; no current catalog or label is consulted.
   * @param reservedNames Original other tool names fixed by the same operation.
   * @returns Detached original groups, after full model-map and digest equality checks.
   */
  restore(value: unknown, reservedNames: readonly string[]): StdioOperationConnectionV2[] {
    const original=stdioOperationSchemasV2(this.options.limits,this.options.admission).selection.parse(value)
    const compiled=this.compile(original.map(({tools:_tools,...input})=>input),reservedNames)
    const budget={...this.budget(),maxBytes:this.options.admission.maxSnapshotBytes}
    if(stdioCanonicalJsonV2(original,budget)!==stdioCanonicalJsonV2(compiled,budget)) this.invalid()
    return structuredClone(original)
  }

  /** Select complete current catalogs with matching logical storage, deployment and frozen SDK budgets.
   * @param client Admission transaction; account and Session locks precede connection locks.
   * @param userId Authenticated owner, never selected by tool JSON.
   * @param sessionId Exact owned Session whose current binding supplies the logical scope.
   * @param target Original requested placement; Device returns no generic STDIO selection.
   * @param reservedNames Other original operation tool names; any collision rejects admission.
   * @returns Complete compiled groups to insert as PG JSON with the operation; no Sandbox is allocated.
   */
  async select(client: PoolClient,userId: UserId,sessionId: SessionId,target: ExecutionTarget,
    reservedNames: readonly string[]): Promise<StdioOperationConnectionV2[]> {
    await requireActiveAccount(client,userId,'update')
    const selected=(await client.query('SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [sessionId,userId])).rows[0]
    if(!selected) throw new PlatformError(404,'session_not_found')
    const session=z.object({workspace_id:uuid}).parse(selected)
    if(target.kind==='desktop') return []
    const binding=await this.files.bindingForId(userId,session.workspace_id,client)
    const scope=stdioScopeV2.parse({kind:'cloud',userId,workspaceId:binding.workspaceId,
      bindingGeneration:binding.generation,target:{spaceId:binding.spaceId,rootRelativePath:binding.rootRelativePath},
      home:{kind:'user',userId}})
    const rows=await client.query(`SELECT c.id AS connection_id,c.user_id,c.revision AS config_revision,
      f.config_digest,f.configuration,cat.id AS catalog_id,cat.raw_catalog,cat.image_expectation,cat.catalog_digest,
      a.id AS action_id,a.session_id AS producer_session_id,s.workspace_id AS producer_workspace_id,
      a.state AS action_state,a.phase AS action_phase,a.execution_target AS action_target,
      a.execution_id AS action_execution_id,a.config_revision AS action_revision,a.config_digest AS action_config_digest,
      a.task,a.task_digest,r.result,r.result_digest,p.prepared,p.prepared_digest
      FROM pe_stdio_v2_connections c
      LEFT JOIN pe_stdio_v2_configurations f ON f.connection_id=c.id AND f.user_id=c.user_id AND f.revision=c.revision
      LEFT JOIN pe_stdio_v2_catalogs cat ON cat.id=c.current_catalog_id AND cat.user_id=c.user_id
        AND cat.connection_id=c.id AND cat.config_revision=c.revision
      LEFT JOIN pe_stdio_v2_actions a ON a.id=cat.action_id AND a.user_id=c.user_id
      LEFT JOIN pe_sessions s ON s.id=a.session_id AND s.user_id=c.user_id
      LEFT JOIN pe_stdio_v2_results r ON r.action_id=a.id
      LEFT JOIN pe_stdio_v2_preparations p ON p.action_id=a.id
      WHERE c.user_id=$1 AND c.enabled AND c.deleted_at IS NULL AND c.current_catalog_id IS NOT NULL
      ORDER BY c.id FOR SHARE OF c`,[userId])
    const inputs:StdioOperationConnectionInputV2[]=[]
    for(const raw of rows.rows) {
      let input
      try {
        const row=rowSchema.parse(raw), boundedTask=stdioJsonV2(this.budget()).parse(row.task)
        if(stdioSha256V2('task',boundedTask,this.budget())!==row.task_digest) this.invalid()
        const frozen=z.object({limits:stdioLimitsV2}).parse(boundedTask)
        // Limits from an older deployment never choose the current parser's work or byte budget.
        if(!this.same(frozen.limits,this.options.limits)) continue
        const task=stdioTaskSchemasV2(this.options.limits).task.parse(boundedTask)
        const outcome=stdioOutcomeV2(this.options.limits,this.options.maxReplyBytes).parse(row.result)
        const prepared=stdioJsonV2(this.budget()).pipe(stdioPreparedV2).parse(row.prepared)
        if(task.phase!=='discover'||outcome.state!=='completed'||outcome.phase!=='discover'
          ||task.userId.toString()!==userId||task.sessionId.toString()!==row.producer_session_id
          ||task.actionId.toString()!==row.action_id||task.connectionId.toString()!==row.connection_id
          ||task.configRevision!==row.config_revision||row.action_revision!==row.config_revision
          ||row.action_config_digest!==row.config_digest||task.configDigest!==row.config_digest
          ||task.scopeBinding.kind!==row.action_target
          ||task.scopeBinding.kind==='cloud'&&task.scopeBinding.workspaceId.toString()!==row.producer_workspace_id
          ||stdioSha256V2('task',task,this.budget())!==row.task_digest
          ||stdioSha256V2('prepared',prepared,this.budget())!==row.prepared_digest
          ||prepared.actionId.toString()!==row.action_id||prepared.taskDigest!==row.task_digest
          ||prepared.executionRef.kind!==row.action_target||prepared.executionRef.executionId.toString()!==row.action_execution_id
          ||!this.same(task.scopeBinding,prepared.scopeBinding)||!this.same(task.expectedDeploymentPin,prepared.expectedDeploymentPin)
          ||prepared.capture.kind==='cloud'&&prepared.fullScopeDigest!==stdioSha256V2('scope',{
            scopeBinding:prepared.scopeBinding,workspaceMount:prepared.capture.workspaceMount,homeMount:prepared.capture.homeMount},this.budget())
          ||!this.same(prepared.actualExecutorImage,row.image_expectation)
          ||!this.same(row.raw_catalog,outcome.catalog)
          ||stdioCatalogFingerprintV2(outcome.catalog,this.options.limits)!==row.catalog_digest
          ||stdioSha256V2('result',outcome,{...this.budget(),maxBytes:this.options.maxReplyBytes})!==row.result_digest) this.invalid()
        const selected=stdioOperationSchemasV2(this.options.limits,this.options.admission).input.parse({formatVersion:2,
          connectionId:row.connection_id,configRevision:row.config_revision,configDigest:row.config_digest,
          configuration:row.configuration,limits:task.limits,scopeBinding:task.scopeBinding,
          expectedDeploymentPin:task.expectedDeploymentPin,catalogId:row.catalog_id,catalogDigest:row.catalog_digest,
          rawCatalog:row.raw_catalog,catalogImageExpectation:row.image_expectation})
        if(stdioSha256V2('configuration',selected.configuration,this.budget())!==selected.configDigest
          ||!this.same(selected.configuration.invocation,task.invocation)) this.invalid()
        if(!this.same(task.scopeBinding,scope)||!this.same(task.expectedDeploymentPin,this.options.cloudDeployment)) continue
        input=selected
      } catch(error) {
        if(error instanceof PlatformError) throw error
        this.invalid()
      }
      inputs.push(input)
    }
    return this.compile(inputs,reservedNames)
  }
}
