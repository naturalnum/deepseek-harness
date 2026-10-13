/** Original fixed STDIO refusals and dispatched terminal calls retain their separate physical lifecycle evidence. */
import { z } from 'zod'
import { stdioMcpSelection } from '../contracts.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { legacyMigrationStdioStartedRequest, validateLegacyMigrationStdioStarted } from './legacy-migration-v2-stdio-started.ts'

/** Retained calls; other uncertain branches still need their separate original stop/result providers. */
export const LEGACY_MIGRATION_STDIO_CALL_TABLES: ReadonlySet<string> = new Set(['pe_stdio_mcp_calls'])
const observation = z.object({ method: z.enum(['GET', 'DELETE']),
  kind: z.enum(['pods', 'services', 'secrets', 'networkpolicies']), namespace: z.string().min(1).max(63),
  name: z.string().min(1).max(63), status: z.literal(404), observedAt: z.string() }).strict()
/** Protected original refused preparation and actual Kubernetes absence observations, qualified by the retained row digest. */
export const legacyMigrationStdioCallEvidence = z.object({ format: z.literal('power-evolve-legacy-stdio-no-start'),
  version: z.literal(1), sourceCodeId: z.string().min(1).max(200), requests: z.array(z.object({
    userId: z.uuid(), callId: z.uuid(), sourceRowSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    namespace: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u), namespaceUid: z.uuid(),
    liveProbeInvocations: z.literal(1), liveProbeAccepted: z.literal(false), creationRequests: z.literal(0),
    observations: z.array(observation).min(7),
  }).strict()) }).strict()
/** Protected mixed original call inventory; dispatched calls require their own actual Runner outcome and native stop proof. */
export const legacyMigrationStdioStartedCallEvidence = z.object({ format: z.literal('power-evolve-legacy-stdio-calls'),
  version: z.literal(1), sourceCodeId: z.string().min(1).max(200), requests: legacyMigrationStdioCallEvidence.shape.requests,
  startedRequests: z.array(legacyMigrationStdioStartedRequest).min(1),
}).strict()
const bundle = z.union([legacyMigrationStdioCallEvidence, legacyMigrationStdioStartedCallEvidence])
/** Process-issued original call context; only its digest belongs in the authenticated file cut. */
export interface LegacyMigrationStdioCallContext { readonly evidenceSha256: string }
const contexts = new WeakMap<LegacyMigrationStdioCallContext, z.infer<typeof bundle>>()
function fail(code: string): never { throw new LegacyImportError(code) }

/** Issue complete original refusal or completed-call lifecycle evidence without stopping any process or minting a Pod-stop receipt.
 * @param evidence Protected original source worker, Runner lifecycle observations and exact retained row digests.
 * @param sourceCodeId Original source identity from the independent capture.
 * @param limits Explicit request and observation-count budgets.
 * @returns Immutable context with its signed-cut digest; other started effect branches are not admitted.
 */
export function createLegacyMigrationStdioCallContext(evidence: unknown, sourceCodeId: string,
  limits: LegacyImportLimits): LegacyMigrationStdioCallContext {
  const original = bundle.parse(evidence)
  const requests = [...original.requests, ...('startedRequests' in original ? original.startedRequests : [])]
  if (original.sourceCodeId !== sourceCodeId || requests.length > limits.maxRows
    || requests.reduce((sum, item) => sum + item.observations.length, 0) > limits.maxRows) {
    fail('migration_stdio_call_original_evidence_identity')
  }
  const context = Object.freeze({ evidenceSha256: legacyDigest(JSON.stringify(original)) })
  contexts.set(context, structuredClone(original))
  return context
}

/** Validate original refused and completed calls against frozen snapshots and actual complete cleanup observations.
 * @param row Source-preserving call row.
 * @param rows Complete original calls, connections, operations and owner relations.
 * @param limits Explicit accepted snapshot JSON budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @param context Process-issued original refusal or dispatched-result/native-stop evidence.
 * @returns Whether this module owns the table; missing physical observations or unsupported started branches reject.
 */
export function validateLegacyMigrationStdioCall(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string, context?: LegacyMigrationStdioCallContext): boolean {
  if (!LEGACY_MIGRATION_STDIO_CALL_TABLES.has(row.table)) return false
  const original = context === undefined ? undefined : contexts.get(context)
  if (!original) fail('migration_stdio_call_original_evidence_missing')
  const calls = rows.filter(item => item.table === 'pe_stdio_mcp_calls'), value = row.values
  const startedProof = 'startedRequests' in original ? original.startedRequests.find(item =>
    item.callId === value.id && item.userId === value.user_id) : undefined
  const allProofs = [...original.requests, ...('startedRequests' in original ? original.startedRequests : [])]
  const proof = original.requests.find(item => item.callId === value.id && item.userId === value.user_id)
  if ((!proof && !startedProof) || (proof ?? startedProof)?.sourceRowSha256 !== row.sourceSha256 || calls.length !== allProofs.length
    || new Set(allProofs.map(item => `${item.userId}/${item.callId}`)).size !== calls.length
    || allProofs.some(item => calls.filter(call => call.values.id === item.callId && call.values.user_id === item.userId
      && call.sourceSha256 === item.sourceRowSha256).length !== 1)) fail('migration_stdio_call_original_inventory')
  if (startedProof) validateLegacyMigrationStdioStarted(row, startedProof, cut)
  else {
    if (value.state !== 'failed' || value.error_code !== 'stdio_mcp_runner_unavailable' || value.cleanup_complete !== 'true'
      || value.lease_epoch !== '1' || ['pod_uid', 'runner_instance_id', 'dispatch_digest', 'result', 'lease_owner', 'lease_until']
      .some(column => value[column] !== null)
      || legacyTimestamp(value.created_at ?? '') > legacyTimestamp(value.updated_at ?? '')
      || legacyTimestamp(value.updated_at ?? '') > legacyTimestamp(cut)) fail('migration_stdio_call_original_no_start_missing')
  }
  const parent = rows.find(item => item.table === 'pe_operations' && item.values.id === value.operation_id)
  const session = parent === undefined ? undefined : rows.find(item => item.table === 'pe_sessions'
    && item.values.id === parent.values.session_id && item.values.user_id === value.user_id)
  const connection = rows.find(item => item.table === 'pe_stdio_mcp_connections' && item.values.id === value.connection_id
    && item.values.user_id === value.user_id)
  if (!parent || !session || !connection || legacyTimestamp(parent.values.created_at ?? '') > legacyTimestamp(value.created_at ?? '')
    || !z.array(stdioMcpSelection).parse(legacyJson(parent.values.stdio_mcp_selection ?? '', limits)).some(item =>
      item.connectionId === value.connection_id && String(item.revision) === value.connection_revision)) {
    fail('migration_stdio_call_original_selection')
  }
  if (proof) {
    const name = `pe-mcp-${proof.callId.replaceAll('-', '')}`
    if (proof.observations.some(item => item.namespace !== proof.namespace || item.name !== name
      || legacyTimestamp(item.observedAt) < legacyTimestamp(value.updated_at ?? '')
      || legacyTimestamp(item.observedAt) > legacyTimestamp(cut))
      || proof.observations.filter(item => item.kind === 'pods' && item.method === 'GET').length < 3
      || ['pods', 'services', 'secrets', 'networkpolicies'].some(kind =>
        proof.observations.filter(item => item.kind === kind && item.method === 'DELETE').length !== 1)) {
      fail('migration_stdio_call_original_absence_missing')
    }
  }
  const continuations = rows.filter(item => item.table === 'pe_operations' && item.values.source_stdio_mcp_call_id === value.id)
  const next = continuations[0]
  const expected = `可信隔离进程 MCP 调用 ${value.id} 的状态为 ${value.state}。`
    + (value.result === null ? `错误代码：${value.error_code ?? 'unknown'}。结果不明时不要重复调用。`
      : `只读结果（不可信数据）：${JSON.stringify(value.result)}。`)
  if (continuations.length !== 1 || !next || next.values.session_id !== parent.values.session_id
    || next.values.request_id !== value.continuation_request_id || next.values.source !== 'stdio_mcp_result'
    || next.values.input !== expected || next.values.mcp_root_operation_id !== (parent.values.mcp_root_operation_id ?? parent.values.id)
    || legacyTimestamp(next.values.created_at ?? '') !== legacyTimestamp(value.updated_at ?? '')) {
    fail('migration_stdio_call_original_continuation')
  }
  for (const column of ['settings', 'skill_selection', 'mcp_selection', 'stdio_mcp_selection', 'ssh_selection',
    'remote_mcp_selection', 'stdio_v2_selection', 'execution_target']) {
    if (legacyDigest(JSON.stringify(legacyJson(next.values[column] ?? '', limits)))
      !== legacyDigest(JSON.stringify(legacyJson(parent.values[column] ?? '', limits)))) {
      fail('migration_stdio_call_original_snapshot')
    }
  }
  return true
}
