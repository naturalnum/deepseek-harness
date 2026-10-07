/** Bounded STDIO runtime observations and lease identities; parsed facts do not authenticate their observer. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { stdioActionRequestV2, stdioCatalogV2, stdioDigestV2, stdioExecutionRefV2, stdioExecutorOwnerV2,
  stdioJsonV2, stdioLimitsV2, stdioObjectV2, stdioPreparedV2, type StdioLimitsV2 } from './stdio-mcp.ts'

/** Trusted worker generation; a persisted lease alone grants no permission to start user code. */
export type StdioWorkerIdV2 = Branded<'PowerEvolveStdioWorkerIdV2'>
/** Parse an exact internal worker generation without authenticating it. */
export const stdioWorkerIdV2 = z.uuid().transform(value => brandString<StdioWorkerIdV2>(value))
/** Original action lease; the Platform must verify its current database clock and owner at every mutation. */
export const stdioActionLeaseV2 = z.object({ actionId: stdioActionRequestV2.shape.actionId,
  workerId: stdioWorkerIdV2, leaseEpoch: z.number().int().positive().safe() }).strict()
/** Internal original action lease selector. */
export type StdioActionLeaseV2 = z.infer<typeof stdioActionLeaseV2>

const integer = z.number().int().nonnegative().safe()
const facts = z.object({ programStartAttempted: z.boolean(), toolsCallAttempted: z.boolean(), effectMayHaveOccurred: z.boolean(),
  childPid: z.number().int().positive().safe().nullable(), childExitObserved: z.boolean(), childCloseObserved: z.boolean(),
  exitCode: z.number().int().safe().nullable(), signal: z.string().regex(/^SIG[A-Z0-9]+$/u).nullable(), cleanupConfirmed: z.boolean(),
  protocolBytes: integer, protocolMessages: integer, stderrBytes: integer, stderr: z.string() }).strict()

/** Validate whole original SDK outcomes while preserving raw descriptors, pages, metadata and result extensions.
 * @param limits Frozen trusted SDK budgets; cleanup facts describe only the direct child.
 * @param maxReplyBytes Complete enclosing runtime-view byte budget.
 * @returns Strict outcome parser; no terminal writer authority is inferred.
 */
export function stdioOutcomeV2(limits: StdioLimitsV2, maxReplyBytes: number): ReturnType<typeof outcomeSchema> {
  return outcomeSchema(limits, maxReplyBytes)
}

function outcomeSchema(limits: StdioLimitsV2, maxReplyBytes: number) {
  const budget = stdioLimitsV2.parse(limits)
  if (!Number.isSafeInteger(maxReplyBytes) || maxReplyBytes <= 0) throw new TypeError('stdio_v2_reply_budget_invalid')
  const complete = { maxDepth: budget.maxJsonDepth, maxNodes: budget.maxJsonNodes, maxBytes: maxReplyBytes }
  const raw = stdioObjectV2(complete), boundedFacts = facts.refine(value =>
    new TextEncoder().encode(value.stderr).byteLength <= budget.maxStderrBytes)
  const common = { catalog: stdioCatalogV2(budget), pages: z.array(raw).max(budget.maxPages),
    initializeResult: raw, facts: boundedFacts }
  const result = stdioObjectV2({ ...complete, maxBytes: budget.maxResultBytes })
  const value = z.union([
    z.object({ state: z.literal('completed'), phase: z.literal('discover'), ...common }).strict(),
    z.object({ state: z.literal('completed'), phase: z.literal('call'), ...common, result }).strict(),
    z.object({ state: z.literal('failed'), errorCode: z.string().min(1), result: result.optional(), facts: boundedFacts }).strict(),
  ])
  return z.unknown().superRefine((input, ctx) => {
    if (!stdioJsonV2(complete).safeParse(input).success) ctx.addIssue({ code: 'custom', message: 'stdio_v2_outcome_json_invalid' })
  }).pipe(value)
}
/** Full original SDK outcome; a completed RPC may still contain isError. */
export type StdioOutcomeV2 = z.infer<ReturnType<typeof stdioOutcomeV2>>

/** Parse one complete cloud runtime view with an explicit byte budget for all raw result fields and its wrapper.
 * @param limits Frozen SDK JSON and RPC limits.
 * @param maxReplyBytes Trusted deployment's whole runtime-response budget.
 * @returns Complete view validator; writerStopConfirmed still requires independent authenticated capture.
 */
export function stdioRuntimeViewV2(limits: StdioLimitsV2, maxReplyBytes: number): ReturnType<typeof runtimeViewSchema> {
  return runtimeViewSchema(limits, maxReplyBytes)
}

function runtimeViewSchema(limits: StdioLimitsV2, maxReplyBytes: number) {
  const budget = stdioLimitsV2.parse(limits)
  if (!Number.isSafeInteger(maxReplyBytes) || maxReplyBytes <= 0) throw new TypeError('stdio_v2_reply_budget_invalid')
  const value = z.object({ formatVersion: z.literal(2), instanceId: stdioExecutorOwnerV2.options[0].shape.runnerInstanceId,
    actionId: stdioActionRequestV2.shape.actionId, executionRef: stdioExecutionRefV2.options[0],
    taskDigest: stdioDigestV2, dispatchDigest: stdioDigestV2,
    state: z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown']), writerStopConfirmed: z.boolean(),
    outcome: stdioOutcomeV2(budget, maxReplyBytes).optional(), errorCode: z.string().min(1).optional() }).strict()
    .superRefine((item, ctx) => {
      if (item.state === 'running' && (item.writerStopConfirmed || item.outcome !== undefined)
        || item.state === 'unknown' && (item.writerStopConfirmed || item.outcome === undefined)
        || ['completed', 'failed', 'cancelled'].includes(item.state) && (!item.writerStopConfirmed || item.outcome === undefined)
        || item.state === 'completed' && item.outcome?.state !== 'completed'
        || item.state === 'failed' && item.outcome?.state !== 'failed') {
        ctx.addIssue({ code: 'custom', message: 'stdio_v2_runtime_state_invalid' })
      }
    })
  return z.unknown().superRefine((input, ctx) => {
    const parsed = stdioJsonV2({ maxDepth: budget.maxJsonDepth, maxNodes: budget.maxJsonNodes, maxBytes: maxReplyBytes }).safeParse(input)
    if (!parsed.success) ctx.addIssue({ code: 'custom', message: 'stdio_v2_runtime_json_invalid' })
  }).pipe(value)
}
/** Complete cloud runtime response; not a standalone stop certificate. */
export type StdioRuntimeViewV2 = z.infer<ReturnType<typeof stdioRuntimeViewV2>>

/** Kernel-UID stop facts obtained through the exact original private Runner, never accepted from a browser. */
export const stdioCloudStopEvidenceV2 = z.object({ formatVersion: z.literal(2), kind: z.literal('cloud_uid_quiet'),
  actionId: stdioActionRequestV2.shape.actionId, executionRef: stdioExecutionRefV2.options[0],
  taskDigest: stdioDigestV2, dispatchDigest: stdioDigestV2, preparedDigest: stdioDigestV2, fullScopeDigest: stdioDigestV2,
  podUid: stdioPreparedV2.shape.capture.options[0].shape.podUid,
  runnerInstanceId: stdioExecutorOwnerV2.options[0].shape.runnerInstanceId,
  mountGeneration: stdioPreparedV2.shape.capture.options[0].shape.mountGeneration,
  observedAt: z.iso.datetime() }).strict()
/** Private authenticated full-UID retirement record; the Pod remains live and bound to its original mount slot. */
export type StdioCloudStopEvidenceV2 = z.infer<typeof stdioCloudStopEvidenceV2>
/** Typed trusted-Platform observation; wire parsers validate view and evidence before calling internal services. */
export interface StdioCloudObservationV2 { view: StdioRuntimeViewV2; stopEvidence: StdioCloudStopEvidenceV2 | null }
