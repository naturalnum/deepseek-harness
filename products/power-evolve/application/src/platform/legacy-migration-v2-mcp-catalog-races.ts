/** Original overlapping discoveries retain their immutable catalogs and the newest check's publication authority. */
import { z } from 'zod'
import { LegacyImportError, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

/** Original creation order, actual completion order and public connection observations for two overlapping checks. */
export const legacyMigrationMcpCatalogRaceEvidence = z.object({ olderCheckId: z.uuid(), newerCheckId: z.uuid(),
  firstCheckId: z.uuid(), secondCheckId: z.uuid(), firstFinishedAt: z.string(), secondFinishedAt: z.string(),
  before: z.json(), afterFirst: z.json(), afterSecond: z.json(), observedAt: z.string() }).strict()
const connection = z.object({ connectionId: z.uuid(), revision: z.number().int().positive(),
  configurationRevision: z.number().int().positive(), credentialRevision: z.number().int().positive().nullable(),
  currentCatalogId: z.uuid().nullable(), updatedAt: z.string() }).loose()
function fail(code: string): never { throw new LegacyImportError(code) }
function same(left: LegacyPlannedRow, right: LegacyPlannedRow): boolean {
  return ['user_id', 'connection_id', 'connection_revision', 'configuration_revision', 'credential_revision']
    .every(field => left.values[field] === right.values[field])
}
function compare(left: LegacyPlannedRow, right: LegacyPlannedRow): number {
  const first = legacyTimestamp(left.values.created_at ?? ''), second = legacyTimestamp(right.values.created_at ?? '')
  return first < second ? -1 : first > second ? 1 : (left.values.id ?? '').localeCompare(right.values.id ?? '')
}
function millis(value: string): bigint { return legacyTimestamp(value) / 1000n * 1000n }

/** Require complete original overlap observations and retain the publisher selected by original check creation order.
 * @param rows Complete source-preserving checks, connection authority and catalogs.
 * @param proofs Original stopped-source observations for every pair of overlapping successful formal checks.
 * @param limits Explicit pair and observation budgets.
 * @param cut Authenticated source cut after both workers and the source process stop.
 * @returns Nothing when completion order, immutable catalogs and the final publisher agree.
 */
export function validateLegacyMigrationMcpCatalogRaces(rows: readonly LegacyPlannedRow[],
  proofs: readonly z.infer<typeof legacyMigrationMcpCatalogRaceEvidence>[], limits: LegacyImportLimits, cut: string): void {
  const checks = rows.filter(row => row.table === 'pe_mcp_checks' && row.values.connection_id !== null
    && row.values.state === 'succeeded').sort(compare)
  const pairs: Array<{ older: LegacyPlannedRow; newer: LegacyPlannedRow }> = []
  for (const [index, older] of checks.entries()) for (const newer of checks.slice(index + 1)) {
    if (same(older, newer) && legacyTimestamp(newer.values.created_at ?? '') < legacyTimestamp(older.values.updated_at ?? '')) {
      pairs.push({ older, newer })
      if (pairs.length > limits.maxRows) fail('migration_mcp_catalog_race_budget')
    }
  }
  if (proofs.length !== pairs.length
    || new Set(proofs.map(proof => `${proof.olderCheckId}/${proof.newerCheckId}`)).size !== proofs.length) {
    fail('migration_mcp_catalog_race_inventory')
  }
  for (const { older, newer } of pairs) {
    const proof = proofs.find(item => item.olderCheckId === older.values.id && item.newerCheckId === newer.values.id)
    if (!proof) fail('migration_mcp_catalog_race_inventory')
    const first = proof.firstCheckId === older.values.id ? older : proof.firstCheckId === newer.values.id ? newer : undefined
    const second = first === older ? newer : older
    if (!first || proof.secondCheckId !== second.values.id) fail('migration_mcp_catalog_race_identity')
    const before = connection.parse(proof.before), afterFirst = connection.parse(proof.afterFirst)
    const afterSecond = connection.parse(proof.afterSecond)
    for (const observed of [before, afterFirst, afterSecond]) {
      if (observed.connectionId !== older.values.connection_id || String(observed.revision) !== older.values.connection_revision
        || String(observed.configurationRevision) !== older.values.configuration_revision
        || (observed.credentialRevision === null ? null : String(observed.credentialRevision)) !== older.values.credential_revision) {
        fail('migration_mcp_catalog_race_identity')
      }
    }
    if (before.currentCatalogId !== null && !rows.some(row => row.table === 'pe_mcp_catalog_versions'
      && row.values.id === before.currentCatalogId && row.values.user_id === older.values.user_id
      && row.values.connection_id === older.values.connection_id
      && legacyTimestamp(row.values.created_at ?? '') <= legacyTimestamp(older.values.created_at ?? ''))) {
      fail('migration_mcp_catalog_race_publisher')
    }
    const firstCatalog = first === newer ? newer.values.catalog_id : before.currentCatalogId
    if (afterFirst.currentCatalogId !== firstCatalog || afterSecond.currentCatalogId !== newer.values.catalog_id
      || first === older && afterFirst.updatedAt !== before.updatedAt
      || first === newer && afterSecond.updatedAt !== afterFirst.updatedAt) fail('migration_mcp_catalog_race_publisher')
    const times = [legacyTimestamp(newer.values.created_at ?? ''), legacyTimestamp(first.values.updated_at ?? ''),
      millis(proof.firstFinishedAt), legacyTimestamp(second.values.updated_at ?? ''), millis(proof.secondFinishedAt),
      legacyTimestamp(proof.observedAt), legacyTimestamp(cut)]
    if (times.some((time, index) => index > 0 && time + (index === 2 || index === 4 ? 999n : 0n) < (times[index - 1] ?? time))) {
      fail('migration_mcp_catalog_race_timeline')
    }
  }
  const resources = new Set(pairs.map(pair => pair.older.values.connection_id))
  for (const id of resources) {
    const current = rows.find(row => row.table === 'pe_mcp_remote_connections' && row.values.id === id)
    if (!current) fail('migration_mcp_catalog_race_identity')
    const candidates = rows.filter(row => row.table === 'pe_mcp_checks' && row.values.connection_id === id
      && row.values.user_id === current.values.user_id && row.values.connection_revision === current.values.revision
      && row.values.configuration_revision === current.values.configuration_revision
      && ['succeeded', 'failed'].includes(row.values.state ?? ''))
    const published = candidates.filter(check => !rows.some(other => other.table === 'pe_mcp_checks'
      && same(check, other) && compare(check, other) < 0
      && legacyTimestamp(other.values.created_at ?? '') <= legacyTimestamp(check.values.updated_at ?? '')))
      .sort((left, right) => legacyTimestamp(left.values.updated_at ?? '') < legacyTimestamp(right.values.updated_at ?? '') ? -1 : 1).at(-1)
    if (!published || current.values.current_catalog_id !== published.values.catalog_id) fail('migration_mcp_catalog_race_publisher')
  }
}
