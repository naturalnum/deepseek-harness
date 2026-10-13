/** Earlier original unallocated discovery may coexist with later started records for the same owned Session. */
import { z } from 'zod'
import { stdioCheckRequestV2, stdioCloudDeploymentV2, stdioTaskSchemasV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioManagementSchemasV2, type StdioManagementLimitsV2 } from '@power-evolve/contracts/stdio-management'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { parseStdioNoStartReceiptV2 } from './stdio-v2-no-start.ts'
import { LegacyImportError, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Validate a source-qualified unallocated discovery without treating later owner resources as the original executor.
 * @param row Source-preserving candidate row already matched by the issued completed-STDIO context.
 * @param rows Complete retained inventory, including later stopped writers.
 * @param action Exact original action from its signed source-row witness.
 * @param execution Exact original execution from the same witness.
 * @param closure Original formal no-start closure from that witness.
 * @param policy Original trusted SDK/management/deployment policy, validated by the context issuer.
 * @param limits Bounded cells and JSON inventory.
 * @param cut Authenticated stopped-source timestamp preserving microseconds.
 * @returns Whether the row is the exact action, execution, check or unallocated closure; no stop or start authority is issued.
 */
export function validateLegacyMigrationStdioUnallocated(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  action: LegacyPlannedRow, execution: LegacyPlannedRow, closure: LegacyPlannedRow,
  policy: { limits: StdioLimitsV2; management: StdioManagementLimitsV2; deploymentPin: z.infer<typeof stdioCloudDeploymentV2> },
  limits: LegacyImportLimits, cut: string): boolean {
  const fail = (): never => { throw new LegacyImportError('migration_stdio_unallocated_changed') }
  const one = (table: string, fields: Record<string, string>) => {
    const matches = rows.filter(item => item.table === table && Object.entries(fields).every(([key, value]) => item.values[key] === value))
    const match = matches[0]
    if (matches.length !== 1 || !match) return fail()
    return match
  }
  const budget = { maxDepth: policy.limits.maxJsonDepth, maxNodes: policy.limits.maxJsonNodes, maxBytes: policy.limits.maxInputBytes }
  const sha = (domain: Parameters<typeof stdioSha256V2>[0], value: unknown) => stdioSha256V2(domain, value, budget)
  const json = (item: LegacyPlannedRow, field: string) => legacyJson(item.values[field] ?? '', limits)
  const same = (left: unknown, right: unknown) => sha('spec', left) === sha('spec', right)
  const a = action.values, e = execution.values, c = closure.values, task = stdioTaskSchemasV2(policy.limits).task.parse(json(action, 'task'))
  if (task.phase !== 'discover') return fail()
  if (task.actionId !== a.id || task.userId !== a.user_id || task.sessionId !== a.session_id || a.phase !== 'discover'
    || task.connectionId !== a.connection_id || String(task.configRevision) !== a.config_revision || task.configDigest !== a.config_digest
    || task.origin.requestId !== a.request_id || !same(task.expectedDeploymentPin, policy.deploymentPin)
    || !same(task.limits, policy.limits) || sha('task', task) !== a.task_digest || !same(json(execution, 'stdio_task'), task)
    || e.id !== a.execution_id || a.cloud_execution_id !== e.id || e.request_digest !== a.task_digest
    || e.user_id !== a.user_id || e.session_id !== a.session_id || e.stdio_action_id !== a.id || e.stdio_phase !== 'discover'
    || e.execution_kind !== 'stdio_v2' || e.execution_target !== 'cloud' || a.execution_target !== 'cloud'
    || e.origin_kind !== 'stdio_discovery' || e.task_version !== '2'
    || a.state !== 'cancelled' || e.state !== 'cancelled' || a.cancel_requested !== 'true' || e.cancel_requested !== 'true'
    || a.error_code !== 'stdio_v2_cancel_requested' || e.error_code !== a.error_code || a.continuation_queued !== 'false'
    || e.attempts !== '0' || a.lease_epoch !== c.lease_epoch || !z.uuid().safeParse(c.worker_id).success
    || ['operation_id', 'root_operation_id', 'call_id', 'continuation_request_id', 'lease_owner', 'lease_until'].some(field => a[field] !== null)
    || ['operation_id', 'call_id', 'continuation_request_id', 'lease_owner', 'lease_until', 'command', 'cwd',
      'sandbox_name', 'pod_uid', 'runner_instance_id', 'dispatch_request', 'result'].some(field => e[field] !== null)
    || rows.some(item => ['pe_stdio_v2_preparations', 'pe_stdio_v2_decisions', 'pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches',
      'pe_stdio_v2_results', 'pe_stdio_v2_observations', 'pe_stdio_v2_catalogs'].includes(item.table) && item.values.action_id === a.id)) fail()
  const receipt = parseStdioNoStartReceiptV2(json(closure, 'receipt'), policy.limits)
  if (receipt.phase !== 'discover' || receipt.resource.kind !== 'unallocated' || receipt.preparedDigest !== null
    || receipt.actionId !== task.actionId || receipt.userId !== task.userId || receipt.sessionId !== task.sessionId
    || receipt.executionRef.executionId !== e.id || receipt.taskDigest !== a.task_digest || c.prepared_digest !== null
    || c.action_id !== a.id || c.user_id !== task.userId || c.session_id !== task.sessionId || c.phase !== 'discover'
    || c.execution_target !== 'cloud' || c.lease_epoch !== '1'
    || c.execution_id !== e.id || c.task_digest !== a.task_digest || sha('no_start', receipt) !== c.receipt_digest
    || legacyTimestamp(c.closed_at ?? '') < legacyTimestamp(a.created_at ?? '')
    || legacyTimestamp(c.closed_at ?? '') < legacyTimestamp(e.created_at ?? '')
    || legacyTimestamp(c.closed_at ?? '') > legacyTimestamp(a.updated_at ?? '')
    || legacyTimestamp(c.closed_at ?? '') > legacyTimestamp(e.updated_at ?? '')
    || legacyTimestamp(a.updated_at ?? '') > legacyTimestamp(cut) || legacyTimestamp(e.updated_at ?? '') > legacyTimestamp(cut)) fail()
  const request = one('pe_stdio_v2_management_requests', { user_id: task.userId, request_id: task.origin.requestId })
  const schemas = stdioManagementSchemasV2(policy.limits, policy.management)
  const input = stdioCheckRequestV2.parse(json(request, 'request')), admitted = schemas.checkReceipt.parse(json(request, 'receipt'))
  const configuration = one('pe_stdio_v2_configurations', { user_id: task.userId, connection_id: task.connectionId,
      revision: String(task.configRevision) }), configured = schemas.configuration.parse(json(configuration, 'configuration'))
  const session = one('pe_sessions', { id: task.sessionId, user_id: task.userId })
  const workspace = one('pe_workspaces', { id: task.scopeBinding.workspaceId, user_id: task.userId })
  const binding = one('pe_workspace_bindings', { workspace_id: task.scopeBinding.workspaceId, user_id: task.userId })
  one('pe_storage_spaces', { id: task.scopeBinding.target.spaceId, user_id: task.userId })
  if (request.values.purpose !== 'check' || input.requestId !== task.origin.requestId || admitted.requestId !== input.requestId
    || input.connectionId !== task.connectionId || input.sessionId !== task.sessionId || input.expectedRevision !== task.configRevision
    || admitted.actionId !== task.actionId || admitted.connectionId !== task.connectionId || admitted.revision !== task.configRevision
    || admitted.executionRef.executionId !== e.id || sha('management', { purpose: 'check', input }) !== request.values.request_digest
    || sha('configuration', configured) !== task.configDigest || configuration.values.config_digest !== task.configDigest
    || !same(configured.invocation, task.invocation) || session.values.workspace_id !== task.scopeBinding.workspaceId
    || workspace.values.binding_generation !== String(task.scopeBinding.bindingGeneration)
    || binding.values.space_id !== task.scopeBinding.target.spaceId
    || binding.values.root_relative_path !== task.scopeBinding.target.rootRelativePath
    || rows.some(item => item.table === 'pe_operations' && (item.values.source_stdio_v2_action_id === task.actionId
      || item.values.source_stdio_v2_no_start_action_id === task.actionId))) fail()
  return [action, execution, closure, request].includes(row)
}
