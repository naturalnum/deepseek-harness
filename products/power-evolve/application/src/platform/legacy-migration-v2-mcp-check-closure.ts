/** Original cancelled or expired discovery retains the fencing rejection and actual worker/peer process closure. */
import { z } from 'zod'
import { mcpDiscoveredTool } from '../mcp-contracts.ts'
import { mcpCanonicalJson } from './mcp-credentials.ts'
import { LegacyImportError, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

const time = z.string()
const lease = z.object({ checkId: z.uuid(), ownerId: z.uuid(), epoch: z.number().int().positive() }).strict()
const pid = z.number().int().positive()
const catalogObservation = z.object({ catalogs: z.array(z.json()), currentCatalogId: z.uuid().nullable(), observedAt: time }).strict()
/** Row-bound real discovery, original terminal transition and rejected stale completion, with no replacement catalog. */
export const legacyMigrationMcpCheckClosureEvidence = z.object({ checkId: z.uuid(), userId: z.uuid(),
  sourceRowSha256: z.string().regex(/^[a-f0-9]{64}$/u), lease,
  snapshot: z.object({ lease, userId: z.uuid(), resourceId: z.uuid(), configurationRevision: z.number().int().positive(),
    credentialRevision: z.number().int().positive().nullable(), serverUrl: z.url(), headerNames: z.array(z.string()).max(16),
    observedAt: time }).strict(),
  finishAttempt: z.object({ lease, outcome: z.object({ tools: z.array(mcpDiscoveredTool) }).strict(), observedAt: time }).strict(),
  finishRejection: z.object({ lease, errorCode: z.literal('mcp_check_lease_lost'), observedAt: time }).strict(),
  transition: z.union([
    z.object({ kind: z.literal('cancel'), before: z.json(), completed: z.json(), observedAt: time }).strict(),
    z.object({ kind: z.literal('expire'), ownerId: z.uuid(), claim: z.null(), completed: z.json(), observedAt: time }).strict(),
  ]),
  workerStoppedAt: time,
  peer: z.object({ ready: z.object({ pid, url: z.url(), instanceId: z.uuid() }).strict(),
    closure: z.object({ pid, code: z.literal(0), signal: z.null(), closedAt: time }).strict(),
    http: z.array(z.object({ method: z.enum(['POST', 'GET', 'DELETE']), path: z.literal('/mcp'), pid,
      instanceId: z.uuid(), observedAt: time }).strict()).min(2) }).strict(),
  sourceProcess: z.object({ code: z.literal(0), signal: z.null(), startedAt: time, endedAt: time }).strict(),
  catalogHistory: z.object({ before: catalogObservation, after: catalogObservation }).strict().optional(),
}).strict()

function fail(code: string): never { throw new LegacyImportError(code) }
function millis(value: string): bigint { return legacyTimestamp(value) / 1000n * 1000n }

/** Check the stopped original discovery, original cancellation/expiry and stale-finish rejection without publishing late tools.
 * @param row Exact original check row with its source SHA.
 * @param proof Protected original callback, terminal transition and process observations.
 * @param rows Complete original configuration and catalog relation.
 * @param limits Explicit JSON and descriptor budgets.
 * @param cut Authenticated stopped-source timestamp.
 * @returns Nothing when the source's terminal and execution observations agree; stale results never create a catalog.
 */
export function validateLegacyMigrationMcpCheckClosure(row: LegacyPlannedRow,
  proof: z.infer<typeof legacyMigrationMcpCheckClosureEvidence>, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string): void {
  const value = row.values, snapshot = proof.snapshot, peer = proof.peer
  const configuration = rows.find(item => (value.draft_id === null
    ? item.table === 'pe_mcp_configuration_versions' && item.values.connection_id === value.connection_id
    : item.table === 'pe_mcp_drafts' && item.values.id === value.draft_id) && item.values.user_id === value.user_id
    && item.values.configuration_revision === value.configuration_revision)
  const metadata = z.object({ serverUrl: z.url(), authentication: z.enum(['none', 'bearer', 'headers']),
    headerNames: z.array(z.string()) }).loose().parse(legacyJson(configuration?.values.configuration ?? '', limits))
  const expectedHeaders = metadata.authentication === 'bearer' ? ['authorization'] : metadata.headerNames.map(name => name.toLowerCase()).sort()
  if (proof.checkId !== value.id || proof.userId !== value.user_id || proof.sourceRowSha256 !== row.sourceSha256
    || proof.lease.checkId !== value.id || String(proof.lease.epoch) !== value.lease_epoch
    || [snapshot.lease, proof.finishAttempt.lease, proof.finishRejection.lease]
      .some(item => mcpCanonicalJson(item) !== mcpCanonicalJson(proof.lease))
    || snapshot.userId !== value.user_id || snapshot.resourceId !== (value.connection_id ?? value.draft_id)
    || String(snapshot.configurationRevision) !== value.configuration_revision
    || (snapshot.credentialRevision === null ? null : String(snapshot.credentialRevision)) !== value.credential_revision
    || snapshot.serverUrl !== metadata.serverUrl || snapshot.serverUrl !== new URL('/mcp', peer.ready.url).href
    || mcpCanonicalJson(snapshot.headerNames.map(name => name.toLowerCase()).sort()) !== mcpCanonicalJson(expectedHeaders)) {
    fail('migration_mcp_check_closure_identity')
  }
  if (value.lease_owner !== null || value.lease_until !== null || value.catalog_id !== null || value.discovered_tools !== null
    || proof.transition.kind === 'cancel' && (value.state !== 'cancelled' || value.cancel_requested !== 'true' || value.error_code !== null)
    || proof.transition.kind === 'expire' && (value.state !== 'expired' || value.cancel_requested !== 'false'
      || value.error_code !== 'mcp_check_expired' || legacyTimestamp(value.updated_at ?? '') < legacyTimestamp(value.expires_at ?? ''))
    || proof.finishAttempt.outcome.tools.length > limits.maxRows) {
    fail('migration_mcp_check_closure_terminal')
  }
  const catalogs = rows.filter(item => item.table === 'pe_mcp_catalog_versions' && item.values.user_id === value.user_id
    && item.values.connection_id === value.connection_id && item.values.draft_id === value.draft_id)
  const current = value.connection_id === null ? null : rows.find(item => item.table === 'pe_mcp_remote_connections'
    && item.values.id === value.connection_id && item.values.user_id === value.user_id)?.values.current_catalog_id
  if (catalogs.length && !proof.catalogHistory) fail('migration_mcp_check_catalog_history_missing')
  if (proof.catalogHistory) {
    const history = proof.catalogHistory, expected = catalogs.map(item => ({ catalogId: item.values.id,
      connectionId: item.values.connection_id, draftId: item.values.draft_id,
      configurationRevision: Number(item.values.configuration_revision),
      credentialRevision: item.values.credential_revision === null ? null : Number(item.values.credential_revision),
      catalogDigest: item.values.catalog_digest, tools: legacyJson(item.values.tools ?? '', limits),
      createdAt: new Date(item.values.created_at ?? '').toISOString() }))
    const sorted = (items: readonly unknown[]) => items.map(item => mcpCanonicalJson(item)).sort()
    if (history.before.catalogs.length > limits.maxRows || history.after.catalogs.length > limits.maxRows
      || mcpCanonicalJson(sorted(history.before.catalogs)) !== mcpCanonicalJson(sorted(expected))
      || mcpCanonicalJson(sorted(history.after.catalogs)) !== mcpCanonicalJson(sorted(expected))
      || history.before.currentCatalogId !== current || history.after.currentCatalogId !== current
      || legacyTimestamp(history.before.observedAt) > legacyTimestamp(snapshot.observedAt)
      || legacyTimestamp(history.after.observedAt) < legacyTimestamp(proof.finishRejection.observedAt)
      || legacyTimestamp(history.after.observedAt) > legacyTimestamp(proof.sourceProcess.endedAt)
      || catalogs.some(item => legacyTimestamp(item.values.created_at ?? '') > millis(history.before.observedAt) + 999n)) {
      fail('migration_mcp_check_catalog_history')
    }
  }
  if (proof.transition.kind === 'cancel') {
    const before = z.object({ checkId: z.uuid(), state: z.literal('running'), cancelRequested: z.literal(false) }).loose()
      .parse(proof.transition.before)
    if (before.checkId !== value.id) fail('migration_mcp_check_closure_identity')
  }
  const ordered = [legacyTimestamp(proof.sourceProcess.startedAt), legacyTimestamp(value.created_at ?? ''),
    legacyTimestamp(snapshot.observedAt), legacyTimestamp(proof.finishAttempt.observedAt),
    legacyTimestamp(value.updated_at ?? ''), legacyTimestamp(proof.transition.observedAt),
    legacyTimestamp(proof.finishRejection.observedAt), legacyTimestamp(proof.workerStoppedAt),
    legacyTimestamp(peer.closure.closedAt), legacyTimestamp(proof.sourceProcess.endedAt), legacyTimestamp(cut)]
  if (ordered.some((value, index) => index > 0 && value < (ordered[index - 1] ?? value))
    || peer.closure.pid !== peer.ready.pid || peer.http.filter(item => item.method === 'POST').length < 2
    || peer.http.some(item => item.pid !== peer.ready.pid || item.instanceId !== peer.ready.instanceId
      || legacyTimestamp(item.observedAt) < millis(snapshot.observedAt)
      || legacyTimestamp(item.observedAt) > legacyTimestamp(proof.workerStoppedAt))
    || peer.http.filter(item => item.method === 'POST').some(item =>
      legacyTimestamp(item.observedAt) > legacyTimestamp(proof.finishAttempt.observedAt))) {
    fail('migration_mcp_check_closure_process')
  }
}
