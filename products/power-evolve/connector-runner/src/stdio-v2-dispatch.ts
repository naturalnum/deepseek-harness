/** SDK start-message validation and literal dispatch; trusted control authentication and writer stop remain external. */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { stdioDispatchV2, stdioExecutorOwnerV2, stdioJsonV2, stdioLimitsV2, stdioStartAuthorizationV2,
  type StdioDispatchV2, type StdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCanonicalJsonV2 } from '@power-evolve/contracts/stdio-mcp-json'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from './stdio-v2-digest.ts'
import { runStdioV2, type StdioV2Identity, type StdioV2Outcome } from './stdio-v2.ts'

/** Executor-owned paths, environment and process identity; no task-selected physical root or ambient variables. */
export interface StdioExecutionEnvironmentV2 {
  workspaceRoot: string
  env: { HOME: string; PATH: string; LANG: string }
  identity: StdioV2Identity
}
/** Independent snapshot of a dispatch and its exact original authorization receipt. */
export interface StdioStartV2 {
  dispatch: StdioDispatchV2
  authorization: z.infer<typeof stdioStartAuthorizationV2>
}
type StdioExecutorOwnerV2 = z.infer<typeof stdioExecutorOwnerV2>

function budget(limits: StdioLimitsV2) {
  return { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
}

function verifiedDispatch(value: unknown, limits: StdioLimitsV2): StdioDispatchV2 {
  const dispatch = stdioDispatchV2(limits).parse(value), task = dispatch.task
  if (stdioSha256V2('task', task, budget(limits)) !== dispatch.taskDigest) throw new TypeError('stdio_v2_task_digest_mismatch')
  if (task.phase === 'call' && stdioCatalogFingerprintV2(task.selection.rawCatalog, limits) !== task.selection.catalogDigest) {
    throw new TypeError('stdio_v2_catalog_digest_mismatch')
  }
  return dispatch
}

/** Parse a complete bounded start packet, preserving raw JSON and a false receipt without granting execution.
 * @param value Queued or control-wire dispatch and authorization, including their complete same permit.
 * @param limits Trusted executor SDK limits; the immutable task must carry exactly these limits.
 * @returns An independent snapshot with verified whole-task and ordered raw-catalog digests.
 */
export function parseStdioStartV2(value: unknown, limits: StdioLimitsV2): StdioStartV2 {
  limits = stdioLimitsV2.parse(limits)
  const packet = stdioJsonV2(budget(limits)).pipe(z.object({ dispatch: stdioDispatchV2(limits),
    authorization: stdioStartAuthorizationV2 }).strict()).parse(value)
  if (stdioCanonicalJsonV2(packet.dispatch.permit, budget(limits))
    !== stdioCanonicalJsonV2(packet.authorization.permit, budget(limits))) throw new TypeError('stdio_v2_start_permit_mismatch')
  verifiedDispatch(packet.dispatch, limits)
  return structuredClone(packet)
}

/** Verify the original true start reply for the exact executor owner and current time.
 * @param value Complete start packet; a queried false receipt cannot authorize a start.
 * @param limits Trusted executor SDK limits used for the entire packet and raw JSON.
 * @param executorOwner Independently authenticated original runner or enrolled Device process.
 * @param now Trusted epoch milliseconds for issuedAt <= now < expiresAt.
 * @returns The validated independent snapshot; control token, live capture and PG once consumption remain caller obligations.
 */
export function validateStdioStartV2(value: unknown, limits: StdioLimitsV2,
  executorOwner: StdioExecutorOwnerV2, now: number): StdioStartV2 {
  const packet = parseStdioStartV2(value, limits), owner = stdioExecutorOwnerV2.parse(executorOwner)
  if (!packet.authorization.grantOnce) throw new TypeError('stdio_v2_start_denied')
  if (stdioCanonicalJsonV2(owner, budget(limits)) !== stdioCanonicalJsonV2(packet.dispatch.permit.executorOwner, budget(limits))) {
    throw new TypeError('stdio_v2_executor_owner_mismatch')
  }
  if (!Number.isSafeInteger(now) || now < 0 || now < Date.parse(packet.dispatch.permit.issuedAt)
    || now >= Date.parse(packet.dispatch.permit.expiresAt)) throw new TypeError('stdio_v2_start_expired')
  return packet
}

/** Run the frozen invocation through the single-child SDK provider without rebuilding its selection or retrying.
 * @param dispatch Original validated dispatch; the caller must have consumed its authenticated true start reply.
 * @param environment Trusted executor paths, credential-free environment and configured process identity.
 * @param signal Cancellation of this invocation; provider cleanup retains its independent configured deadlines.
 * @returns Complete provider outcome and direct-child facts; thrown validation failures remain thrown.
 */
export function runStdioDispatchV2(dispatch: StdioDispatchV2, environment: StdioExecutionEnvironmentV2,
  signal: AbortSignal): Promise<StdioV2Outcome> {
  const limits = stdioLimitsV2.parse(dispatch.task.limits)
  const original = structuredClone(verifiedDispatch(dispatch, limits)), task = original.task
  if (typeof environment.workspaceRoot !== 'string' || !isAbsolute(environment.workspaceRoot)
    || environment.workspaceRoot.includes('\0')) throw new TypeError('stdio_v2_workspace_root_invalid')
  const root = resolve(environment.workspaceRoot), cwd = resolve(root, task.invocation.cwd), path = relative(root, cwd)
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new TypeError('stdio_v2_cwd_invalid')
  // The dropped-privilege helper must still verify filesystem traversal and stop the complete configured UID.
  return runStdioV2({ ...task.invocation, cwd, ...(task.phase === 'discover' ? { phase: 'discover' }
    : { phase: 'call', catalogExpectation: task.selection.rawCatalog, rawName: task.selection.rawName,
      arguments: task.selection.arguments }) }, { env: { ...environment.env }, identity: { ...environment.identity }, limits,
    fingerprintCatalog: tools => stdioCatalogFingerprintV2(tools, limits) }, signal)
}
