/** Original Cloud STDIO discovery cancelled before preparation retains its formal unallocated no-start receipt. */
import { z } from 'zod'
import { stdioCheckRequestV2, stdioCloudDeploymentV2, stdioLimitsV2, stdioTaskSchemasV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioManagementLimitsV2, stdioManagementSchemasV2 } from '@power-evolve/contracts/stdio-management'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { parseStdioNoStartReceiptV2 } from './stdio-v2-no-start.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Only original cancelled discovery actions and formal unallocated closure rows; all started branches remain separate. */
export const LEGACY_MIGRATION_STDIO_NO_START_TABLES: ReadonlySet<string> = new Set([
  'pe_stdio_v2_actions', 'pe_stdio_v2_no_start_closures',
])
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
/** Protected original parser/deployment policy and complete original action, execution, request and closure witnesses. */
export const legacyMigrationStdioNoStartEvidence = z.object({ format: z.literal('power-evolve-legacy-stdio-v2-no-start'),
  version: z.literal(1), sourceCodeId: z.string().min(1).max(200), limits: stdioLimitsV2,
  management: stdioManagementLimitsV2, deploymentPin: stdioCloudDeploymentV2,
  requests: z.array(z.object({ userId: z.uuid(), actionId: z.uuid(), executionId: z.uuid(), requestId: z.uuid(),
    actionSha256: digest, executionSha256: digest, requestSha256: digest, closureSha256: digest,
    cancellationBeforeWorker: z.literal(true), preparationCreated: z.literal(false),
    approvalIssued: z.literal(false), transportRequests: z.literal(0) }).strict()),
}).strict()
/** Process-issued original no-start context whose full digest belongs in the signed file cut. */
export interface LegacyMigrationStdioNoStartContext { readonly evidenceSha256: string }
type Evidence = z.infer<typeof legacyMigrationStdioNoStartEvidence>
const contexts = new WeakMap<LegacyMigrationStdioNoStartContext, Evidence>()
function fail(code: string): never { throw new LegacyImportError(code) }
function find(rows: readonly LegacyPlannedRow[], table: string, fields: Readonly<Record<string, string>>) {
  const matches = rows.filter(item => item.table === table && Object.entries(fields).every(([key, value]) => item.values[key] === value))
  const match = matches[0]
  if (matches.length !== 1 || !match) fail('migration_stdio_no_start_reference_missing')
  return match
}

/** Issue original Cloud discovery policy and source-row evidence without authorizing any executor.
 * @param evidence Protected original parser limits, unused deployment descriptor and complete no-start source inventory.
 * @param sourceCodeId Independently captured original source identity.
 * @param limits Explicit inventory budget; descriptor parsing does not establish OCI qualification.
 * @returns Immutable signed-cut context; prepared, call, catalog, result and started branches remain unsupported.
 */
export function createLegacyMigrationStdioNoStartContext(evidence: unknown, sourceCodeId: string,
  limits: LegacyImportLimits): LegacyMigrationStdioNoStartContext {
  const original = legacyMigrationStdioNoStartEvidence.parse(evidence)
  if (original.sourceCodeId !== sourceCodeId || original.requests.length > limits.maxRows) {
    fail('migration_stdio_no_start_original_identity')
  }
  const context = Object.freeze({ evidenceSha256: legacyDigest(JSON.stringify(original)) })
  contexts.set(context, structuredClone(original))
  return context
}

/** Validate original cancelled Cloud discovery, its admission and its unique formal unallocated closure.
 * @param row Source-preserving action, closure, STDIO execution or discovery-request row.
 * @param rows Complete retained configuration, storage and execution inventory.
 * @param limits Explicit cell and JSON work budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @param context Process-issued original no-start evidence.
 * @returns Whether this row belongs to the unallocated discovery branch; no executor, permission or SDK result is created.
 */
export function validateLegacyMigrationStdioNoStart(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string, context?: LegacyMigrationStdioNoStartContext): boolean {
  if (!LEGACY_MIGRATION_STDIO_NO_START_TABLES.has(row.table)
    && !(row.table === 'pe_cloud_executions' && row.values.execution_kind === 'stdio_v2')
    && !(row.table === 'pe_stdio_v2_management_requests' && row.values.purpose === 'check')) return false
  const original = context === undefined ? undefined : contexts.get(context)
  if (!original) fail('migration_stdio_no_start_original_evidence_missing')
  const proof = original.requests.find(item => row.table === 'pe_stdio_v2_actions' ? item.actionId === row.values.id
    : row.table === 'pe_stdio_v2_no_start_closures' ? item.actionId === row.values.action_id
      : row.table === 'pe_cloud_executions' ? item.executionId === row.values.id
        : item.userId === row.values.user_id && item.requestId === row.values.request_id)
  const inventories = [
    rows.filter(item => item.table === 'pe_stdio_v2_actions'),
    rows.filter(item => item.table === 'pe_cloud_executions' && item.values.execution_kind === 'stdio_v2'),
    rows.filter(item => item.table === 'pe_stdio_v2_management_requests' && item.values.purpose === 'check'),
    rows.filter(item => item.table === 'pe_stdio_v2_no_start_closures'),
  ] as const
  if (!proof || inventories.some(items => items.length !== original.requests.length)
    || new Set(original.requests.map(item => item.actionId)).size !== original.requests.length
    || new Set(original.requests.map(item => item.executionId)).size !== original.requests.length
    || new Set(original.requests.map(item => `${item.userId}/${item.requestId}`)).size !== original.requests.length
    || original.requests.some(item => !inventories[0].some(entry => entry.values.id === item.actionId
      && entry.sourceSha256 === item.actionSha256)
      || !inventories[1].some(entry => entry.values.id === item.executionId && entry.sourceSha256 === item.executionSha256)
      || !inventories[2].some(entry => entry.values.user_id === item.userId && entry.values.request_id === item.requestId
        && entry.sourceSha256 === item.requestSha256)
      || !inventories[3].some(entry => entry.values.action_id === item.actionId && entry.sourceSha256 === item.closureSha256))) {
    fail('migration_stdio_no_start_original_inventory')
  }
  const action = row.table === 'pe_stdio_v2_actions' ? row : find(rows, 'pe_stdio_v2_actions', { id: proof.actionId, user_id: proof.userId })
  const execution = row.table === 'pe_cloud_executions' ? row : find(rows, 'pe_cloud_executions', { id: proof.executionId, user_id: proof.userId })
  const request = row.table === 'pe_stdio_v2_management_requests' ? row
    : find(rows, 'pe_stdio_v2_management_requests', { request_id: proof.requestId, user_id: proof.userId })
  const closure = row.table === 'pe_stdio_v2_no_start_closures' ? row
    : find(rows, 'pe_stdio_v2_no_start_closures', { action_id: proof.actionId, user_id: proof.userId })
  const value = action.values, executed = execution.values, closed = closure.values
  const budget = { maxDepth: original.limits.maxJsonDepth, maxNodes: original.limits.maxJsonNodes, maxBytes: original.limits.maxInputBytes }
  const same = (left: unknown, right: unknown) => stdioSha256V2('spec', left, budget) === stdioSha256V2('spec', right, budget)
  const task = stdioTaskSchemasV2(original.limits).task.parse(legacyJson(value.task ?? '', limits))
  if (task.phase !== 'discover'
    || task.actionId !== proof.actionId || task.userId !== proof.userId || task.sessionId !== value.session_id
    || task.connectionId !== value.connection_id || String(task.configRevision) !== value.config_revision
    || task.configDigest !== value.config_digest || task.origin.requestId !== proof.requestId
    || !same(task.limits, original.limits) || !same(task.expectedDeploymentPin, original.deploymentPin)
    || stdioSha256V2('task', task, budget) !== value.task_digest
    || !same(legacyJson(executed.stdio_task ?? '', limits), task)
    || executed.request_digest !== value.task_digest || executed.stdio_action_id !== proof.actionId
    || executed.session_id !== task.sessionId || executed.execution_kind !== 'stdio_v2' || executed.execution_target !== 'cloud'
    || executed.origin_kind !== 'stdio_discovery' || executed.task_version !== '2' || executed.stdio_phase !== 'discover'
    || value.execution_id !== proof.executionId || value.execution_target !== 'cloud' || value.phase !== 'discover'
    || value.request_id !== proof.requestId) fail('migration_stdio_no_start_original_task')
  if (value.state !== 'cancelled' || executed.state !== 'cancelled' || value.cancel_requested !== 'true'
    || executed.cancel_requested !== 'true' || value.lease_epoch !== '1' || executed.attempts !== '0'
    || value.error_code !== 'stdio_v2_cancel_requested' || executed.error_code !== 'stdio_v2_cancel_requested'
    || value.continuation_queued !== 'false'
    || ['lease_owner', 'lease_until', 'operation_id', 'root_operation_id', 'call_id', 'continuation_request_id']
      .some(column => value[column] !== null)
    || ['lease_owner', 'lease_until', 'operation_id', 'call_id', 'command', 'cwd', 'continuation_request_id',
      'sandbox_name', 'pod_uid', 'runner_instance_id', 'dispatch_request', 'result'].some(column => executed[column] !== null)
    || rows.some(item => ['pe_stdio_v2_preparations', 'pe_stdio_v2_decisions', 'pe_stdio_v2_start_permits',
      'pe_stdio_v2_dispatches', 'pe_stdio_v2_results', 'pe_stdio_v2_catalogs', 'pe_stdio_v2_observations'].includes(item.table)
      && item.values.action_id === proof.actionId
      || item.table === 'pe_sandbox_instances' && item.values.session_id === task.sessionId
      || item.table === 'pe_mount_slots' && item.values.user_id === task.userId
      || item.table === 'pe_cloud_execution_resolutions' && item.values.execution_id === proof.executionId
      || item.table === 'pe_operations' && (item.values.source_stdio_v2_action_id === proof.actionId
        || item.values.source_stdio_v2_no_start_action_id === proof.actionId))) {
    fail('migration_stdio_no_start_original_unallocated')
  }
  const session = find(rows, 'pe_sessions', { id: task.sessionId, user_id: task.userId })
  const workspace = find(rows, 'pe_workspaces', { id: task.scopeBinding.workspaceId, user_id: task.userId })
  const binding = find(rows, 'pe_workspace_bindings', { workspace_id: task.scopeBinding.workspaceId, user_id: task.userId })
  find(rows, 'pe_storage_spaces', { id: task.scopeBinding.target.spaceId, user_id: task.userId })
  const configuration = find(rows, 'pe_stdio_v2_configurations', { connection_id: task.connectionId,
    user_id: task.userId, revision: String(task.configRevision) })
  const schemas = stdioManagementSchemasV2(original.limits, original.management)
  const configured = schemas.configuration.parse(legacyJson(configuration.values.configuration ?? '', limits))
  const input = stdioCheckRequestV2.parse(legacyJson(request.values.request ?? '', limits))
  const admitted = schemas.checkReceipt.parse(legacyJson(request.values.receipt ?? '', limits))
  if (session.values.workspace_id !== task.scopeBinding.workspaceId
    || workspace.values.binding_generation !== String(task.scopeBinding.bindingGeneration)
    || binding.values.space_id !== task.scopeBinding.target.spaceId
    || binding.values.root_relative_path !== task.scopeBinding.target.rootRelativePath
    || configuration.values.config_digest !== task.configDigest || stdioSha256V2('configuration', configured, budget) !== task.configDigest
    || !same(configured.invocation, task.invocation) || input.requestId !== proof.requestId || input.connectionId !== task.connectionId
    || input.expectedRevision !== task.configRevision || input.sessionId !== task.sessionId
    || admitted.actionId !== proof.actionId || admitted.executionRef.executionId !== proof.executionId
    || admitted.connectionId !== task.connectionId
    || admitted.revision !== task.configRevision || admitted.requestId !== proof.requestId
    || request.values.request_digest !== stdioSha256V2('management', { purpose: 'check', input }, budget)
    || legacyTimestamp(request.values.created_at ?? '') !== legacyTimestamp(value.created_at ?? '')
    || legacyTimestamp(executed.created_at ?? '') !== legacyTimestamp(value.created_at ?? '')) {
    fail('migration_stdio_no_start_original_admission')
  }
  const receipt = parseStdioNoStartReceiptV2(legacyJson(closed.receipt ?? '', limits), original.limits)
  if (receipt.phase !== 'discover' || receipt.resource.kind !== 'unallocated' || receipt.preparedDigest !== null
    || receipt.actionId !== proof.actionId || receipt.executionRef.executionId !== proof.executionId
    || receipt.userId !== task.userId || receipt.sessionId !== task.sessionId || receipt.taskDigest !== value.task_digest
    || closed.execution_target !== 'cloud' || closed.execution_id !== proof.executionId || closed.phase !== 'discover'
    || closed.session_id !== task.sessionId || closed.task_digest !== value.task_digest || closed.prepared_digest !== null
    || closed.lease_epoch !== value.lease_epoch || !z.uuid().safeParse(closed.worker_id).success
    || stdioSha256V2('no_start', receipt, budget) !== closed.receipt_digest
    || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(closed.closed_at ?? '')
    || legacyTimestamp(closed.closed_at ?? '') > legacyTimestamp(value.updated_at ?? '')
    || legacyTimestamp(closed.closed_at ?? '') > legacyTimestamp(executed.updated_at ?? '')
    || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)
    || legacyTimestamp(executed.updated_at ?? '') > legacyTimestamp(cut)) fail('migration_stdio_no_start_original_closure')
  return true
}
