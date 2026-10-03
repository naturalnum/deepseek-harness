/** Browser-safe requests for trusted Cloud execution reconciliation; parsing grants no authority. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Original Cloud execution identity; never a replacement command or process identity. */
export type ResolutionExecutionId = Branded<'PowerEvolveResolutionExecutionId'>
/** Owner-scoped identity of one durable reconciliation intent. */
export type ResolutionRequestId = Branded<'PowerEvolveResolutionRequestId'>
/** Original Session receiving a reconciled result. */
export type ResolutionSessionId = Branded<'PowerEvolveResolutionSessionId'>
/** Parse an execution identity without granting access to the execution. */
export const resolutionExecutionId = z.uuid().transform(value => brandString<ResolutionExecutionId>(value))
/** Parse the stable retry identity retained after a lost acceptance response. */
export const resolutionRequestId = z.uuid().transform(value => brandString<ResolutionRequestId>(value))
/** Parse the original Session identity without authorizing a subscription. */
export const resolutionSessionId = z.uuid().transform(value => brandString<ResolutionSessionId>(value))
/** Platform-calculated digest of the exact original writer and binding being stopped. */
export const executionIdentityFingerprint = z.string().regex(/^[a-f0-9]{64}$/u)
/** Terminal facts retain unknown side effects even after the writer is confirmed stopped. */
export const resolvedExecutionState = z.enum(['succeeded', 'failed', 'cancelled', 'closed_unknown'])
const code = z.string().min(1).max(100)

/** Only a separately authenticated approval request may submit this intent. */
export const executionResolutionRequest = z.object({
  requestId: resolutionRequestId, executionId: resolutionExecutionId, target: z.literal('cloud'),
  fingerprint: executionIdentityFingerprint,
  note: z.string().trim().max(500).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)),
}).strict()
/** Read progress using the same identity after refresh, replica failure or a lost response. */
export const executionResolutionStatusRequest = z.object({ requestId: resolutionRequestId }).strict()
/** Inspection addresses an existing execution; it does not request cleanup. */
export const executionResolutionInspectRequest = z.object({ executionId: resolutionExecutionId }).strict()
/** The authenticated owner can restrict the bounded list to one original Session. */
export const executionResolutionsListRequest = z.object({ sessionId: resolutionSessionId.optional() }).strict()

/** Completion requires a stopped writer; a known result and a stopped writer are distinct facts. */
export const executionResolutionReceipt = z.object({
  requestId: resolutionRequestId, executionId: resolutionExecutionId, sessionId: resolutionSessionId,
  target: z.literal('cloud'), state: z.enum(['accepted', 'stopping', 'completed', 'blocked']),
  finalState: resolvedExecutionState.nullable(), stopConfirmed: z.boolean(), continuationQueued: z.boolean(),
  errorCode: code.nullable(),
}).strict().refine(value => value.state === 'completed'
  ? value.finalState !== null && value.stopConfirmed && value.errorCode === null
  : value.finalState === null && !value.continuationQueued
    && (value.state === 'blocked' ? value.errorCode !== null : value.errorCode === null))
/** Read-only execution metadata; command text is displayed as untrusted data. */
export const executionResolutionItem = z.object({
  executionId: resolutionExecutionId, sessionId: resolutionSessionId, target: z.literal('cloud'),
  executionState: z.enum(['queued', 'starting', 'running', 'cancelling', 'uncertain',
    'succeeded', 'failed', 'cancelled', 'closed_unknown']),
  command: z.string().min(1).max(8192), cwd: z.string().min(1).max(4096),
  createdAt: z.iso.datetime({ offset: true }), errorCode: code.nullable(),
  resolution: executionResolutionReceipt.nullable(),
}).strict().refine(value => value.resolution === null
  || value.resolution.executionId === value.executionId && value.resolution.sessionId === value.sessionId
    && (value.resolution.state === 'completed'
      ? value.executionState === value.resolution.finalState : value.executionState === 'uncertain'))
/** Unknown executions and existing reconciliation receipts remain owner-scoped and bounded. */
export const executionResolutionsList = z.object({
  available: z.boolean(), items: z.array(executionResolutionItem).max(100),
}).strict()
/** A fingerprint selects exact recorded identities; it is never evidence that they have stopped. */
export const executionResolutionInspection = z.object({
  item: executionResolutionItem, fingerprint: executionIdentityFingerprint.nullable(),
  canStop: z.boolean(), blockedReason: code.nullable(),
  runnerObservation: z.enum(['not_observed', 'unavailable', 'identity_changed',
    'running', 'succeeded', 'failed', 'cancelled']),
}).strict().refine(value => value.canStop
  ? value.item.executionState === 'uncertain' && value.item.resolution === null
    && value.fingerprint !== null && value.blockedReason === null
  : value.blockedReason !== null)
/** Missing requests stay distinguishable from accepted reconciliation work. */
export const executionResolutionStatus = z.object({ receipt: executionResolutionReceipt.nullable() }).strict()

/** Read-only native Host RPC mapping; no confirmation route is exposed to the Host. */
export const EXECUTION_RESOLUTION_ROUTES = {
  executionResolutionsList: '/executions/resolutions/list',
  executionResolutionInspect: '/executions/resolutions/inspect',
  executionResolutionStatus: '/executions/resolutions/status',
} as const
/** Independent approval-audience routes; the Platform must recheck current resource ownership. */
export const EXECUTION_RESOLUTION_APPROVAL_ROUTES = {
  list: '/approvals/executions/list', inspect: '/approvals/executions/inspect',
  resolve: '/approvals/executions/resolve', status: '/approvals/executions/status',
} as const

/** Validated trusted stop-and-reconcile intent; it supplies no result or stop evidence. */
export type ExecutionResolutionRequest = z.infer<typeof executionResolutionRequest>
/** Validated read-only Session filter. */
export type ExecutionResolutionsListRequest = z.infer<typeof executionResolutionsListRequest>
/** Validated durable reconciliation result. */
export type ExecutionResolutionReceipt = z.infer<typeof executionResolutionReceipt>
/** Validated owner-scoped execution metadata. */
export type ExecutionResolutionItem = z.infer<typeof executionResolutionItem>
/** Validated bounded reconciliation list. */
export type ExecutionResolutionsList = z.infer<typeof executionResolutionsList>
/** Validated read-only inspection of a captured writer. */
export type ExecutionResolutionInspection = z.infer<typeof executionResolutionInspection>
/** Validated progress query response. */
export type ExecutionResolutionStatus = z.infer<typeof executionResolutionStatus>
