/** Pure validation of original account receipts, audit, bootstrap and idempotent preference mutations; no authority is replayed. */
import { z } from 'zod'
import { accountMutationReceipt, accountRole } from '../account-contracts.ts'
import { settings } from '../contracts.ts'
import { LegacyImportError, legacyDigest, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Retained account metadata owners with explicit current-consumer validation. */
export const LEGACY_MIGRATION_ACCOUNT_OWNER_TABLES: ReadonlySet<string> = new Set([
  'pe_account_bootstrap', 'pe_account_mutations', 'pe_account_audit', 'pe_settings_mutations', 'pe_plugin_mutations',
])
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const verifier = /^[a-f0-9]{32}:[a-f0-9]{128}$/u
const auditState = z.object({ revision: z.number().int().positive().max(2_147_483_647),
  enabled: z.boolean(), role: accountRole }).strict()
const bootstrapState = z.object({ mode: z.enum(['create', 'existing']) }).strict()
function account(rows: readonly LegacyPlannedRow[], id: string | null | undefined): LegacyPlannedRow {
  const row = rows.find(row => row.table === 'pe_users' && row.values.id === id)
  if (!row) throw new LegacyImportError('migration_account_reference_missing')
  return row
}
function receipt(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[], limits: LegacyImportLimits, cut: string) {
  const value = accountMutationReceipt.parse(legacyJson(row.values.receipt ?? '', limits)), target = account(rows, row.values.target_user_id)
  if (value.requestId !== row.values.request_id || value.kind !== row.values.kind || value.account.userId !== row.values.target_user_id
    || value.account.username !== target.values.username || BigInt(value.account.revision) > BigInt(target.values.account_revision ?? '')
    || legacyTimestamp(value.completedAt) > legacyTimestamp(cut)
    || legacyTimestamp(value.account.createdAt) > legacyTimestamp(value.account.updatedAt)
    || legacyTimestamp(value.account.updatedAt) > legacyTimestamp(value.completedAt)) {
    throw new LegacyImportError('migration_account_receipt_identity')
  }
  if (row.values.kind === 'change-password') {
    if (row.values.actor_user_id !== row.values.target_user_id || !verifier.test(row.values.password_verifier ?? '')) {
      throw new LegacyImportError('migration_account_password_receipt')
    }
  } else if (row.values.password_verifier !== null) throw new LegacyImportError('migration_account_password_receipt')
  digest.parse(row.values.request_digest)
  account(rows, row.values.actor_user_id)
  return value
}

/** Validate one supported original account row against the complete selected metadata inventory.
 * @param row Original source-preserving target row, after fixed-layout cell validation.
 * @param rows Complete selected rows for actor, target, audit and mutation references.
 * @param limits Explicit JSON depth, node and byte budgets.
 * @param cut Authenticated stopped-source cut.
 * @returns Whether this module owns the table; unsupported owners remain rejected by the caller.
 */
export function validateLegacyMigrationAccountOwner(row: LegacyPlannedRow, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string): boolean {
  if (!LEGACY_MIGRATION_ACCOUNT_OWNER_TABLES.has(row.table)) return false
  const value = row.values
  if (value.created_at !== undefined && legacyTimestamp(value.created_at ?? '') > legacyTimestamp(cut)) {
    throw new LegacyImportError('migration_account_row_future')
  }
  switch (row.table) {
    case 'pe_account_bootstrap': {
      const user = account(rows, value.user_id)
      if (value.singleton !== 'true' || user.values.username !== value.username || !['create', 'existing'].includes(value.mode ?? '')
        || legacyTimestamp(value.completed_at ?? '') > legacyTimestamp(cut)) throw new LegacyImportError('migration_account_bootstrap_invalid')
      if (!rows.some(audit => audit.table === 'pe_account_audit' && audit.values.kind === 'bootstrap'
        && audit.values.actor_user_id === value.user_id && audit.values.target_user_id === value.user_id)) {
        throw new LegacyImportError('migration_account_bootstrap_audit_missing')
      }
      break
    }
    case 'pe_account_mutations': {
      const result = receipt(row, rows, limits, cut)
      const audits = rows.filter(audit => audit.table === 'pe_account_audit' && audit.values.actor_user_id === value.actor_user_id
        && audit.values.request_id === value.request_id && audit.values.target_user_id === value.target_user_id
        && audit.values.kind === value.kind)
      if (audits.length !== 1 || !audits[0]) throw new LegacyImportError('migration_account_mutation_audit_missing')
      const metadata = auditState.parse(legacyJson(audits[0].values.metadata ?? '', limits))
      if (metadata.revision !== result.account.revision || metadata.enabled !== result.account.enabled
        || metadata.role !== result.account.role) {
        throw new LegacyImportError('migration_account_audit_receipt_mismatch')
      }
      break
    }
    case 'pe_account_audit': {
      account(rows, value.actor_user_id); account(rows, value.target_user_id)
      if (legacyTimestamp(value.created_at ?? '') > legacyTimestamp(cut)) throw new LegacyImportError('migration_account_audit_future')
      if (value.kind === 'bootstrap') {
        const metadata = bootstrapState.parse(legacyJson(value.metadata ?? '', limits))
        if (value.actor_user_id !== value.target_user_id || !rows.some(bootstrap => bootstrap.table === 'pe_account_bootstrap'
          && bootstrap.values.user_id === value.target_user_id && bootstrap.values.mode === metadata.mode)) {
          throw new LegacyImportError('migration_account_bootstrap_audit_invalid')
        }
      } else {
        auditState.parse(legacyJson(value.metadata ?? '', limits))
        const mutation = rows.find(mutation => mutation.table === 'pe_account_mutations'
          && mutation.values.actor_user_id === value.actor_user_id && mutation.values.request_id === value.request_id
          && mutation.values.target_user_id === value.target_user_id && mutation.values.kind === value.kind)
        if (!mutation) throw new LegacyImportError('migration_account_audit_mutation_missing')
        receipt(mutation, rows, limits, cut)
      }
      break
    }
    case 'pe_settings_mutations': {
      const user = account(rows, value.user_id), result = settings.parse(legacyJson(value.result_settings ?? '', limits))
      const current = settings.parse(legacyJson(user.values.settings ?? '', limits))
      if (result.revision < 2 || result.revision > current.revision || value.request_digest !== legacyDigest(JSON.stringify([
        result.revision - 1, result.model, result.maxTokens,
      ]))) throw new LegacyImportError('migration_settings_mutation_invalid')
      break
    }
    case 'pe_plugin_mutations': {
      account(rows, value.user_id)
      const revision = Number(value.result_revision), enabled = value.result_enabled === 'true'
      const current = rows.find(choice => choice.table === 'pe_user_plugins' && choice.values.user_id === value.user_id
        && choice.values.plugin_id === value.plugin_id)
      if (value.plugin_id !== 'notes' || !current || revision < 2 || revision > Number(current.values.revision)
        || value.request_digest !== legacyDigest(JSON.stringify({ pluginId: 'notes', expectedRevision: revision - 1, enabled }))) {
        throw new LegacyImportError('migration_plugin_mutation_invalid')
      }
      break
    }
    default: throw new LegacyImportError('migration_account_owner_dispatch')
  }
  return true
}
