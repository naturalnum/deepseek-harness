/** Decode original approval metadata without admitting an unqualified Prepared, decision or executor into import. */
import { z } from 'zod'
import { stdioApprovalBindingV2, stdioDigestV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioApprovalFingerprintV2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { LegacyImportError, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Original preparation approval fields; complete Prepared/task/storage/image/stop qualification remains separate. */
export interface LegacyMigrationStdioPreparationApproval {
  readonly actionId: string
  readonly userId: string
  readonly sessionId: string
  readonly phase: 'discover' | 'call'
  readonly executionId: string
  readonly taskDigest: string
  readonly preparedDigest: string
  readonly fingerprint: string
  readonly binding: z.infer<typeof stdioApprovalBindingV2>
  readonly createdAt: string
  readonly expiresAt: string
}

/** Original stored decision metadata; this value grants no permission to start or reapprove. */
export interface LegacyMigrationStdioDecisionMetadata {
  readonly actionId: string
  readonly userId: string
  readonly fingerprint: string
  readonly decision: 'once' | 'reject'
  readonly decidedAt: string
}

const preparationColumns = z.object({ action_id: z.uuid(), user_id: z.uuid(), session_id: z.uuid(),
  phase: z.enum(['discover', 'call']), execution_target: z.literal('cloud'), execution_id: z.uuid(),
  task_digest: stdioDigestV2, prepared_digest: stdioDigestV2, approval_binding: z.string(),
  fingerprint: stdioDigestV2, approval_epoch: z.literal('1'), expires_at: z.string(), created_at: z.string() })
const decisionColumns = z.object({ action_id: z.uuid(), user_id: z.uuid(), fingerprint: stdioDigestV2,
  decision: z.enum(['once', 'reject']), decided_at: z.string() })

/** Decode Cloud preparation approval columns with the existing original key and frozen SDK encoding limits.
 * @param row Original pe_stdio_v2_preparations row; all source cells remain unchanged.
 * @param originalKey Existing original 32-byte key; a different key rejects the stored fingerprint.
 * @param sdkLimits Explicit original approval-envelope budgets.
 * @param limits Offline source JSON work limits.
 * @param cut Authenticated source timestamp; expires_at may precede created_at and is preserved without renewal.
 * @returns Original metadata only; the prepared JSON, accepted task, image, storage and physical closure are not validated here.
 */
export function readLegacyMigrationStdioPreparationApproval(row: LegacyPlannedRow, originalKey: Uint8Array,
  sdkLimits: StdioLimitsV2, limits: LegacyImportLimits, cut: string): LegacyMigrationStdioPreparationApproval {
  if (row.table !== 'pe_stdio_v2_preparations') throw new LegacyImportError('migration_stdio_approval_table')
  const value = preparationColumns.parse(row.values)
  const binding = stdioApprovalBindingV2.parse(legacyJson(value.approval_binding, limits))
  const budget = { maxDepth: sdkLimits.maxJsonDepth, maxNodes: sdkLimits.maxJsonNodes, maxBytes: sdkLimits.maxInputBytes }
  if (binding.actionId !== value.action_id || binding.taskDigest !== value.task_digest
    || binding.preparedDigest !== value.prepared_digest
    || legacyTimestamp(binding.expiresAt) !== legacyTimestamp(value.expires_at)
    || stdioApprovalFingerprintV2(originalKey, binding, budget) !== value.fingerprint) {
    throw new LegacyImportError('migration_stdio_approval_binding_changed')
  }
  if (legacyTimestamp(value.created_at) > legacyTimestamp(cut)) throw new LegacyImportError('migration_stdio_approval_after_cut')
  return { actionId: value.action_id, userId: value.user_id, sessionId: value.session_id, phase: value.phase,
    executionId: value.execution_id, taskDigest: value.task_digest, preparedDigest: value.prepared_digest,
    fingerprint: value.fingerprint, binding, createdAt: value.created_at, expiresAt: value.expires_at }
}

/** Decode one immutable decision against its original preparation metadata without issuing authority.
 * @param row Original pe_stdio_v2_decisions row; once and reject are retained verbatim.
 * @param preparation Original approval metadata decoded with its matching existing key.
 * @param cut Authenticated source timestamp; transaction-start timestamps do not establish write order.
 * @returns Original decision metadata; full owner/task/terminal/stop validation is still required before import.
 */
export function readLegacyMigrationStdioDecisionMetadata(row: LegacyPlannedRow,
  preparation: LegacyMigrationStdioPreparationApproval, cut: string): LegacyMigrationStdioDecisionMetadata {
  if (row.table !== 'pe_stdio_v2_decisions') throw new LegacyImportError('migration_stdio_decision_table')
  const value = decisionColumns.parse(row.values)
  if (value.action_id !== preparation.actionId || value.user_id !== preparation.userId
    || value.fingerprint !== preparation.fingerprint) throw new LegacyImportError('migration_stdio_decision_binding_changed')
  if (legacyTimestamp(value.decided_at) > legacyTimestamp(cut)) throw new LegacyImportError('migration_stdio_decision_after_cut')
  return { actionId: value.action_id, userId: value.user_id, fingerprint: value.fingerprint,
    decision: value.decision, decidedAt: value.decided_at }
}
