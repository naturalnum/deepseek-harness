/** Original remote-worker outcomes and owned peer process closure qualify terminal actions without dispatching again. */
import { z } from 'zod'
import { mcpActionLease, mcpActionReceipt } from '../mcp-action-contracts.ts'
import { mcpOperationTool } from '../mcp-operation-contracts.ts'
import { validateMcpJsonSchemaValue } from '../mcp-json-schema.ts'
import { mcpCanonicalJson } from './mcp-credentials.ts'
import { LegacyImportError, legacyJson, type LegacyImportLimits } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'

const observedAt = z.string()
const pid = z.number().int().positive()
/** Protected actual original callbacks, unique dispatch, authenticated peer invocation and exited source process. */
export const legacyMigrationMcpStartedActionEvidence = z.object({ actionId: z.uuid(), userId: z.uuid(),
  sourceRowSha256: z.string().regex(/^[a-f0-9]{64}$/u), lease: mcpActionLease,
  limits: z.object({ maxArgumentBytes: z.number().int().positive(), maxResultBytes: z.number().int().positive() }).strict(),
  preparation: z.object({ lease: mcpActionLease, owner: z.object({ userId: z.uuid() }).strict(),
    tool: mcpOperationTool, arguments: z.record(z.string(), z.json()) }).strict(),
  dispatch: z.object({ lease: mcpActionLease, observedCatalogDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    allowed: z.literal(true), dispatchId: z.uuid(), dispatchAt: observedAt, observedAt }).strict(),
  finish: z.object({ lease: mcpActionLease, outcome: z.union([
    z.object({ result: z.record(z.string(), z.json()) }).strict(), z.object({ errorCode: z.literal('mcp_timeout') }).strict(),
  ]),
  completed: mcpActionReceipt, observedAt }).strict(),
  snapshot: z.object({ actionId: z.uuid(), serverUrl: z.url(), headerNames: z.array(z.string()).max(16), observedAt }).strict(),
  peer: z.object({ ready: z.object({ pid, url: z.url(), instanceId: z.uuid() }).strict(),
    invocation: z.object({ pid, instanceId: z.uuid(), accountId: z.uuid(), authorizedUser: z.uuid(), observedAt }).strict(),
    closure: z.object({ pid, code: z.literal(0), signal: z.null(), closedAt: observedAt }).strict() }).strict(),
  workerStoppedAt: observedAt,
  replyWithheld: z.object({ kind: z.literal('reply_withheld'), pid, instanceId: z.uuid(), observedAt }).strict().optional(),
  sourceProcess: z.object({ code: z.literal(0), signal: z.null(), startedAt: observedAt, endedAt: observedAt }).strict(),
}).strict()

function fail(code: string): never { throw new LegacyImportError(code) }
function milliseconds(value: string): bigint { return legacyTimestamp(value) / 1000n * 1000n }

/** Validate a row-bound original outcome, exact callback and closed owned transport producer without resolving source uncertainty.
 * @param row Original selected action with its source row digest.
 * @param proof Protected original callback and process observations, already included in the signed file cut.
 * @param rows Complete original immutable configuration and catalog relation.
 * @param limits Explicit JSON and result budgets.
 * @param cut Authenticated stopped-source timestamp, after original workers and peer have exited.
 * @returns Nothing for qualified success, tool-error reply or timeout after actual invocation; other outcomes are refused.
 */
export function validateLegacyMigrationMcpStartedAction(row: LegacyPlannedRow,
  proof: z.infer<typeof legacyMigrationMcpStartedActionEvidence>, rows: readonly LegacyPlannedRow[],
  limits: LegacyImportLimits, cut: string): void {
  const value = row.values, lease = proof.lease, tool = mcpOperationTool.parse(legacyJson(value.tool ?? '', limits))
  const args = legacyJson(value.arguments ?? '', limits), result = value.result === null ? null : legacyJson(value.result ?? '', limits)
  const catalog = rows.find(item => item.table === 'pe_mcp_catalog_versions' && item.values.id === tool.catalogId
    && item.values.user_id === value.user_id && item.values.connection_id === tool.connectionId)
  const configuration = rows.find(item => item.table === 'pe_mcp_configuration_versions'
    && item.values.connection_id === tool.connectionId && item.values.user_id === value.user_id
    && item.values.configuration_revision === String(tool.configurationRevision))
  const metadata = z.object({ serverUrl: z.url(), authentication: z.enum(['none', 'bearer', 'headers']),
    headerNames: z.array(z.string()) }).loose().parse(legacyJson(configuration?.values.configuration ?? '', limits))
  const headerNames = metadata.authentication === 'bearer' ? ['authorization'] : metadata.headerNames.map(name => name.toLowerCase()).sort()
  if (proof.actionId !== value.id || proof.userId !== value.user_id || proof.sourceRowSha256 !== row.sourceSha256
    || lease.actionId !== value.id || String(lease.epoch) !== value.lease_epoch
    || [proof.preparation.lease, proof.dispatch.lease, proof.finish.lease].some(item => mcpCanonicalJson(item) !== mcpCanonicalJson(lease))
    || proof.preparation.owner.userId !== value.user_id || mcpCanonicalJson(proof.preparation.tool) !== mcpCanonicalJson(tool)
    || mcpCanonicalJson(proof.preparation.arguments) !== mcpCanonicalJson(args)
    || Buffer.byteLength(JSON.stringify(args)) > proof.limits.maxArgumentBytes
    || proof.dispatch.dispatchId !== value.dispatch_id || proof.dispatch.observedCatalogDigest !== catalog?.values.catalog_digest
    || legacyTimestamp(proof.dispatch.dispatchAt) !== milliseconds(value.dispatch_at ?? '')
    || proof.snapshot.actionId !== value.id || proof.snapshot.serverUrl !== metadata.serverUrl
    || mcpCanonicalJson(proof.snapshot.headerNames.map(name => name.toLowerCase()).sort()) !== mcpCanonicalJson(headerNames)
    || new URL(proof.snapshot.serverUrl).origin !== new URL(proof.peer.ready.url).origin) {
    fail('migration_mcp_action_started_identity')
  }
  const completed = proof.finish.completed, outcome = proof.finish.outcome
  if (value.lease_owner !== null || value.lease_until !== null || value.decision !== 'once' || value.permission_id !== null
    || completed.actionId !== value.id || completed.state !== value.state || completed.fingerprint !== value.request_digest
    || completed.errorCode !== value.error_code) {
    fail('migration_mcp_action_started_outcome')
  }
  if ('result' in outcome) {
    const reply = outcome.result, failed = reply.isError === true
    if (proof.replyWithheld !== undefined || value.state !== (failed ? 'failed' : 'succeeded')
      || value.error_code !== (failed ? 'mcp_tool_error' : null) || value.result === null
      || mcpCanonicalJson(reply) !== mcpCanonicalJson(result)
      || Buffer.byteLength(JSON.stringify(reply)) > Math.min(limits.maxCellBytes, proof.limits.maxResultBytes)
      || !Array.isArray(reply.content) || !failed && tool.raw.outputSchema !== undefined
        && !validateMcpJsonSchemaValue(tool.raw.outputSchema, reply.structuredContent)) fail('migration_mcp_action_started_outcome')
  } else if (value.state !== 'uncertain' || value.error_code !== outcome.errorCode || value.result !== null || !proof.replyWithheld) {
    fail('migration_mcp_action_started_outcome')
  }
  const peer = proof.peer
  if (peer.ready.pid !== peer.invocation.pid || peer.ready.pid !== peer.closure.pid
    || peer.ready.instanceId !== peer.invocation.instanceId
    || peer.invocation.accountId !== proof.preparation.arguments.accountId
    || peer.invocation.authorizedUser !== value.user_id) fail('migration_mcp_action_started_process_identity')
  if (proof.replyWithheld && (proof.replyWithheld.pid !== peer.ready.pid || proof.replyWithheld.instanceId !== peer.ready.instanceId
    || legacyTimestamp(proof.replyWithheld.observedAt) < legacyTimestamp(peer.invocation.observedAt)
    || legacyTimestamp(proof.replyWithheld.observedAt) >= milliseconds(value.updated_at ?? ''))) {
    fail('migration_mcp_action_started_outcome')
  }
  const ordered = [legacyTimestamp(proof.sourceProcess.startedAt), legacyTimestamp(value.created_at ?? ''),
    legacyTimestamp(value.decided_at ?? ''), legacyTimestamp(proof.snapshot.observedAt),
    legacyTimestamp(value.dispatch_at ?? ''), legacyTimestamp(proof.dispatch.observedAt),
    legacyTimestamp(peer.invocation.observedAt), milliseconds(value.updated_at ?? ''),
    legacyTimestamp(proof.finish.observedAt), legacyTimestamp(peer.closure.closedAt),
    legacyTimestamp(proof.workerStoppedAt), legacyTimestamp(proof.sourceProcess.endedAt), legacyTimestamp(cut)]
  if (ordered.some((time, index) => index > 0 && time < (ordered[index - 1] ?? time))
    || legacyTimestamp(value.updated_at ?? '') >= legacyTimestamp(value.expires_at ?? '')) {
    fail('migration_mcp_action_started_timeline')
  }
}
