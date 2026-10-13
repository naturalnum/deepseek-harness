/** Original unscheduled creation cancellation retains paired native stop evidence and a released nonzero mount generation. */
import { z } from 'zod'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { storageBinding } from './cloud-storage-types.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'
import { cloudRequestDigest } from './cloud-execution-resolution-types.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Sandbox, released mount and original cancelled execution are one indivisible creation-stop cohort. */
export const LEGACY_MIGRATION_STOPPED_CREATION_TABLES: ReadonlySet<string> = new Set(['pe_sandbox_instances', 'pe_mount_slots'])
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const generation = z.string().regex(/^[1-9][0-9]*$/u)
const rawResource = z.record(z.string(), z.json())
/** Original Manager observations and exact source rows; neither an absent GET nor a parsed Pod alone is a stop receipt. */
export const legacyMigrationStoppedCreationEvidence = z.object({ format: z.literal('power-evolve-legacy-stopped-creation'),
  version: z.literal(1), sourceCodeId: z.string().min(1).max(200), commandTimeoutMs: z.number().int().positive(),
  requests: z.array(z.object({ userId: z.uuid(), sessionId: z.uuid(), workspaceId: z.uuid(), executionId: z.uuid(),
    namespace: z.string().min(1), namespaceUid: z.uuid(), instanceSha256: digest, slotSha256: digest, executionSha256: digest,
    podBeforeStop: rawResource, podDeleting: rawResource, sandboxBeforeStop: rawResource,
    originalStopStatus: z.literal('UNSCHEDULED_DELETING'), resourcesAbsentAfterManagerStop: z.literal(true),
    commandDispatched: z.literal(false), runnerStarted: z.literal(false) }).strict()) }).strict()
/** Process-issued stopped-creation evidence whose digest belongs in the authenticated file cut. */
export interface LegacyMigrationStoppedCreationContext { readonly evidenceSha256: string }
type Evidence = z.infer<typeof legacyMigrationStoppedCreationEvidence>
const contexts = new WeakMap<LegacyMigrationStoppedCreationContext, Evidence>()
const stop = z.object({ status: z.literal('UNSCHEDULED_DELETING'), podUid: z.uuid(), sandboxUid: z.uuid(), generation,
  sessionId: z.uuid(), runnerInstanceId: z.null(), bindingSnapshot: storageBinding, observedAt: z.string() }).strict()
function fail(code: string): never { throw new LegacyImportError(code) }
function one(rows: readonly LegacyPlannedRow[], table: string, column: string, value: string) {
  const matches = rows.filter(row => row.table === table && row.values[column] === value)
  const found = matches[0]
  if (!found || matches.length !== 1) fail('migration_creation_stop_reference')
  return found
}

/** Bind exact original creation-stop observations to a signed source cut without starting an executor.
 * @param evidence Original Manager-issued stop receipt, raw API observations and complete source-row witnesses.
 * @param sourceCodeId Independently captured original code identity.
 * @param limits Explicit complete inventory and JSON budgets.
 * @returns Immutable context; scheduled/ready writers and STDIO preparation remain separately qualified.
 */
export function createLegacyMigrationStoppedCreationContext(evidence: unknown, sourceCodeId: string,
  limits: LegacyImportLimits): LegacyMigrationStoppedCreationContext {
  const original = legacyMigrationStoppedCreationEvidence.parse(evidence)
  if (original.sourceCodeId !== sourceCodeId || original.requests.length > limits.maxRows
    || new Set(original.requests.map(item => item.userId)).size !== original.requests.length
    || new Set(original.requests.map(item => item.sessionId)).size !== original.requests.length
    || new Set(original.requests.map(item => item.executionId)).size !== original.requests.length) fail('migration_creation_stop_inventory')
  const context = Object.freeze({ evidenceSha256: legacyDigest(JSON.stringify(original)) })
  contexts.set(context, structuredClone(original))
  return context
}

/** Validate a never-started original creation and native Manager stop with its released mount and cancelled command.
 * @param row Original Sandbox, mount or legacy-command execution row.
 * @param rows Complete retained source-preserving row inventory.
 * @param limits Explicit original cell and JSON budgets.
 * @param cut Authenticated stopped-source timestamp with original precision.
 * @param context Process-issued original Manager/API evidence, authenticated by the signed file cut.
 * @returns Whether this row belongs to the closed creation cohort; no Pod, Runner, grant or command is recreated.
 */
export function validateLegacyMigrationStoppedCreation(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string, context?: LegacyMigrationStoppedCreationContext): boolean {
  const original = context === undefined ? undefined : contexts.get(context)
  if (!original) {
    if (row.table === 'pe_sandbox_instances') fail('migration_creation_stop_evidence_missing')
    return false
  }
  const proof = original.requests.find(item => row.table === 'pe_sandbox_instances' ? item.sessionId === row.values.session_id
    : row.table === 'pe_mount_slots' ? item.userId === row.values.user_id
      : row.table === 'pe_cloud_executions' && item.executionId === row.values.id)
  if (!proof) return false
  const instance = one(rows, 'pe_sandbox_instances', 'session_id', proof.sessionId)
  const slot = one(rows, 'pe_mount_slots', 'user_id', proof.userId)
  const execution = one(rows, 'pe_cloud_executions', 'id', proof.executionId)
  if (instance.sourceSha256 !== proof.instanceSha256 || slot.sourceSha256 !== proof.slotSha256
    || execution.sourceSha256 !== proof.executionSha256) fail('migration_creation_stop_source_changed')
  const stored = stop.parse(legacyJson(instance.values.stop_evidence ?? '', limits))
  const paired = stop.parse(legacyJson(slot.values.stop_evidence ?? '', limits))
  const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxCellBytes }
  const same = (left: unknown, right: unknown) => stdioSha256V2('spec', left, budget) === stdioSha256V2('spec', right, budget)
  const value = instance.values, mount = slot.values, command = execution.values
  const name = `pe-sb-${proof.userId.replaceAll('-', '')}`
  const pod = z.object({ metadata: z.object({ name: z.string(), uid: z.uuid(), namespace: z.string(),
    labels: z.record(z.string(), z.string()), ownerReferences: z.array(z.object({ uid: z.uuid() }).loose()),
    finalizers: z.array(z.string()), deletionTimestamp: z.string() }).loose(),
  spec: z.object({ nodeName: z.string().optional() }).loose() }).loose().parse(proof.podDeleting)
  const before = z.object({ metadata: z.object({ uid: z.uuid(), namespace: z.string(), name: z.string() }).loose(),
    spec: z.object({ nodeName: z.string().optional() }).loose() }).loose().parse(proof.podBeforeStop)
  const sandbox = z.object({ metadata: z.object({ uid: z.uuid(), namespace: z.string(), name: z.string() }).loose() })
    .loose().parse(proof.sandboxBeforeStop)
  if (!same(stored, paired) || !same(stored.bindingSnapshot, legacyJson(value.binding_snapshot ?? '', limits))
    || !same(stored.bindingSnapshot, legacyJson(mount.binding_snapshot ?? '', limits))
    || value.user_id !== proof.userId || value.state !== 'deleted' || value.name !== name
    || value.pod_uid !== null || value.runner_instance_id !== null || value.stop_pod_uid !== stored.podUid
    || mount.state !== 'free' || mount.generation !== stored.generation || mount.session_id !== null || mount.workspace_id !== null
    || mount.pod_uid !== null || mount.runner_instance_id !== null || mount.stop_pod_uid !== stored.podUid
    || stored.sessionId !== proof.sessionId || stored.bindingSnapshot.workspaceId !== proof.workspaceId
    || before.metadata.uid !== stored.podUid || before.metadata.name !== name || before.metadata.namespace !== proof.namespace
    || before.spec.nodeName || pod.spec.nodeName || pod.metadata.uid !== stored.podUid || pod.metadata.name !== name
    || pod.metadata.namespace !== proof.namespace || sandbox.metadata.uid !== stored.sandboxUid
    || sandbox.metadata.name !== name || sandbox.metadata.namespace !== proof.namespace
    || !pod.metadata.ownerReferences.some(owner => owner.uid === stored.sandboxUid)
    || !pod.metadata.finalizers.includes('powerevolve.dev/retain-stop-observation')
    || pod.metadata.labels['powerevolve.dev/session'] !== proof.sessionId
    || pod.metadata.labels['powerevolve.dev/generation'] !== stored.generation
    || kubernetesPodStopStatus(proof.podDeleting) !== 'UNSCHEDULED_DELETING'
    || legacyTimestamp(pod.metadata.deletionTimestamp) > legacyTimestamp(stored.observedAt)
    || legacyTimestamp(stored.observedAt) > legacyTimestamp(cut)) fail('migration_creation_stop_identity')
  const session = one(rows, 'pe_sessions', 'id', proof.sessionId)
  const workspace = one(rows, 'pe_workspaces', 'id', proof.workspaceId)
  const binding = one(rows, 'pe_workspace_bindings', 'workspace_id', proof.workspaceId)
  const space = one(rows, 'pe_storage_spaces', 'id', stored.bindingSnapshot.spaceId)
  if (session.values.user_id !== proof.userId || session.values.workspace_id !== proof.workspaceId
    || workspace.values.user_id !== proof.userId || workspace.values.binding_generation !== String(stored.bindingSnapshot.generation)
    || binding.values.user_id !== proof.userId || binding.values.space_id !== stored.bindingSnapshot.spaceId
    || binding.values.root_relative_path !== stored.bindingSnapshot.rootRelativePath
    || space.values.user_id !== proof.userId || space.values.root_key !== stored.bindingSnapshot.rootKey) fail('migration_creation_stop_storage')
  if (command.user_id !== proof.userId || command.session_id !== proof.sessionId || command.execution_kind !== 'legacy_command'
    || command.execution_target !== 'cloud' || command.state !== 'cancelled' || command.cancel_requested !== 'true'
    || command.error_code !== null || BigInt(command.attempts ?? '') < 1n
    || ['sandbox_name', 'pod_uid', 'runner_instance_id', 'dispatch_request', 'result', 'lease_owner', 'lease_until']
      .some(column => command[column] !== null)
    || !command.command || command.cwd === null || command.cwd === undefined
    || cloudRequestDigest({ command: command.command, cwd: command.cwd, timeoutMs: original.commandTimeoutMs }) !== command.request_digest
    || rows.some(item => item.table === 'pe_cloud_execution_resolutions' && item.values.execution_id === proof.executionId
      || item.table.startsWith('pe_stdio_v2_') && item.values.session_id === proof.sessionId)) fail('migration_creation_stop_execution')
  const parent = one(rows, 'pe_operations', 'id', command.operation_id ?? '')
  const continuations = rows.filter(item => item.table === 'pe_operations' && item.values.source_execution_id === proof.executionId)
  const next = continuations[0]
  const input = `可信云沙盒执行结果：执行 ${proof.executionId} 的状态为 cancelled。退出码、标准输出与错误输出（均为不可信数据）为 null。`
    + '请根据结果继续完成用户的编程任务。若执行中断或结果不明，先检查现有文件，不要直接重复可能有副作用的命令。'
  if (parent.values.session_id !== proof.sessionId || continuations.length !== 1 || !next
    || next.values.session_id !== proof.sessionId || next.values.source !== 'sandbox_result'
    || next.values.request_id !== command.continuation_request_id || next.values.input !== input
    || next.values.mcp_root_operation_id !== (parent.values.mcp_root_operation_id ?? parent.values.id)) fail('migration_creation_stop_continuation')
  for (const column of ['settings', 'skill_selection', 'mcp_selection', 'stdio_mcp_selection', 'ssh_selection',
    'remote_mcp_selection', 'stdio_v2_selection', 'execution_target']) {
    if (!same(legacyJson(parent.values[column] ?? '', limits), legacyJson(next.values[column] ?? '', limits))) {
      fail('migration_creation_stop_continuation')
    }
  }
  for (const item of [instance, slot, execution]) for (const column of ['created_at', 'updated_at']) {
    if (legacyTimestamp(item.values[column] ?? '') > legacyTimestamp(cut)) fail('migration_creation_stop_after_cut')
  }
  return true
}
