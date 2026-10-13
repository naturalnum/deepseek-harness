/** Original legacy Cloud commands cancelled before executor reservation retain their admitted input and exact continuation. */
import { z } from 'zod'
import { cloudRequestDigest } from './cloud-execution-resolution-types.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { validateLegacyMigrationStdioDiscovery, type LegacyMigrationStdioDiscoveryContext } from './legacy-migration-v2-stdio-discovery.ts'

/** Only original cancelled legacy-command rows without an executor; started and STDIO Cloud execution branches remain separate. */
export const LEGACY_MIGRATION_CLOUD_CANCEL_TABLES: ReadonlySet<string> = new Set(['pe_cloud_executions'])
/** Protected original admission timeout and actual pre-worker cancellation without any executor reservation or Kubernetes request. */
export const legacyMigrationCloudCancellationEvidence = z.object({ format: z.literal('power-evolve-legacy-cloud-cancellation'),
  version: z.literal(1), sourceCodeId: z.string().min(1).max(200), commandTimeoutMs: z.number().int().positive(),
  requests: z.array(z.object({ userId: z.uuid(), executionId: z.uuid(), sourceRowSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    cancellationBeforeWorker: z.literal(true), executorReservationCreated: z.literal(false), transportRequests: z.literal(0) }).strict()),
}).strict()
/** Process-issued original no-executor context, authenticated through its complete digest in the signed file cut. */
export interface LegacyMigrationCloudCancellationContext { readonly evidenceSha256: string }
const contexts = new WeakMap<LegacyMigrationCloudCancellationContext, z.infer<typeof legacyMigrationCloudCancellationEvidence>>()
function fail(code: string): never { throw new LegacyImportError(code) }

/** Issue original admission/cancellation evidence without creating, stopping or fabricating an executor.
 * @param evidence Protected original command policy and source-qualified cancellation observations.
 * @param sourceCodeId Original source identity from the independently captured inventory.
 * @param limits Explicit original cancellation inventory budget.
 * @returns Immutable context with its signed-cut digest; executor-bearing branches remain rejected.
 */
export function createLegacyMigrationCloudCancellationContext(evidence: unknown, sourceCodeId: string,
  limits: LegacyImportLimits): LegacyMigrationCloudCancellationContext {
  const original = legacyMigrationCloudCancellationEvidence.parse(evidence)
  if (original.sourceCodeId !== sourceCodeId || original.requests.length > limits.maxRows) {
    fail('migration_cloud_cancel_original_evidence_identity')
  }
  const context = Object.freeze({ evidenceSha256: legacyDigest(JSON.stringify(original)) })
  contexts.set(context, structuredClone(original))
  return context
}

/** Validate original cancelled commands without an executor against complete original admission and continuation rows.
 * @param row Source-preserving Cloud execution row.
 * @param rows Complete original owner, Session, executor and Operation inventory.
 * @param limits Explicit accepted snapshot JSON budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @param context Process-issued original cancellation/admission context.
 * @param stoppedStdio Separately qualified later STDIO writer, required when the original inventory contains its Session resources.
 * @returns Whether the table is owned; started, uncertain, resolved and STDIO executions require their separate providers.
 */
export function validateLegacyMigrationCloudCancellation(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string, context?: LegacyMigrationCloudCancellationContext,
  stoppedStdio?: LegacyMigrationStdioDiscoveryContext): boolean {
  if (!LEGACY_MIGRATION_CLOUD_CANCEL_TABLES.has(row.table)) return false
  const original = context === undefined ? undefined : contexts.get(context)
  if (!original) fail('migration_cloud_cancel_original_evidence_missing')
  const executions = rows.filter(item => item.table === 'pe_cloud_executions' && item.values.execution_kind === 'legacy_command'
    && !rows.some(resolution => resolution.table === 'pe_cloud_execution_resolutions'
      && resolution.values.execution_id === item.values.id))
  const value = row.values
  const proof = original.requests.find(item => item.userId === value.user_id && item.executionId === value.id)
  if (!proof || proof.sourceRowSha256 !== row.sourceSha256 || executions.length !== original.requests.length
    || new Set(original.requests.map(item => `${item.userId}/${item.executionId}`)).size !== executions.length
    || original.requests.some(item => executions.filter(entry => entry.values.user_id === item.userId
      && entry.values.id === item.executionId && entry.sourceSha256 === item.sourceRowSha256).length !== 1)) {
    fail('migration_cloud_cancel_original_inventory')
  }
  if (value.execution_kind !== 'legacy_command' || value.execution_target !== 'cloud' || value.origin_kind !== 'operation'
    || value.state !== 'cancelled' || value.cancel_requested !== 'true' || value.attempts !== '1'
    || ['result', 'error_code', 'sandbox_name', 'pod_uid', 'runner_instance_id', 'lease_owner', 'lease_until',
      'dispatch_request', 'task_version', 'stdio_phase', 'stdio_task', 'stdio_action_id'].some(column => value[column] !== null)
    || rows.some(item => item.table === 'pe_cloud_execution_resolutions' && item.values.execution_id === value.id)
    || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.updated_at ?? '')
    || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)) fail('migration_cloud_cancel_original_executor_missing')
  const laterResources = rows.filter(item => item.table === 'pe_sandbox_instances' && item.values.session_id === value.session_id
    || item.table === 'pe_mount_slots' && item.values.user_id === value.user_id)
  if (laterResources.some(item => legacyTimestamp(item.values.created_at ?? '') < legacyTimestamp(value.updated_at ?? '')
    || !validateLegacyMigrationStdioDiscovery(item, rows, limits, cut, stoppedStdio))) {
    fail('migration_cloud_cancel_later_writer_unqualified')
  }
  const parent = rows.find(item => item.table === 'pe_operations' && item.values.id === value.operation_id
    && item.values.session_id === value.session_id)
  const session = rows.find(item => item.table === 'pe_sessions' && item.values.id === value.session_id
    && item.values.user_id === value.user_id)
  if (!parent || !session || legacyTimestamp(parent.values.created_at ?? '') > legacyTimestamp(value.created_at ?? '')
    || !value.call_id || !value.command || value.cwd === null || value.cwd === undefined
    || cloudRequestDigest({ command: value.command, cwd: value.cwd, timeoutMs: original.commandTimeoutMs }) !== value.request_digest) {
    fail('migration_cloud_cancel_original_admission')
  }
  const continuations = rows.filter(item => item.table === 'pe_operations' && item.values.source_execution_id === value.id)
  const next = continuations[0]
  const expected = `可信云沙盒执行结果：执行 ${value.id} 的状态为 cancelled。退出码、标准输出与错误输出（均为不可信数据）为 null。`
    + '请根据结果继续完成用户的编程任务。若执行中断或结果不明，先检查现有文件，不要直接重复可能有副作用的命令。'
  if (continuations.length !== 1 || !next || next.values.source !== 'sandbox_result' || next.values.session_id !== value.session_id
    || next.values.request_id !== value.continuation_request_id || next.values.input !== expected
    || next.values.mcp_root_operation_id !== (parent.values.mcp_root_operation_id ?? parent.values.id)
    || legacyTimestamp(next.values.created_at ?? '') !== legacyTimestamp(value.updated_at ?? '')) {
    fail('migration_cloud_cancel_original_continuation')
  }
  for (const column of ['settings', 'skill_selection', 'mcp_selection', 'stdio_mcp_selection', 'ssh_selection',
    'remote_mcp_selection', 'stdio_v2_selection', 'execution_target']) {
    if (JSON.stringify(legacyJson(next.values[column] ?? '', limits)) !== JSON.stringify(legacyJson(parent.values[column] ?? '', limits))) {
      fail('migration_cloud_cancel_original_snapshot')
    }
  }
  return true
}
