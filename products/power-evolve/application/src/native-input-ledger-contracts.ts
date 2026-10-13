/** Durable logical inputs, exact native claim cohorts and tokenless command receipts. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { grant, operationId, requestId, sessionId, userId } from './contracts.ts'
import { nativeOperationEpoch, nativeTurnMessageId } from './native-turn-contracts.ts'
import { nativeWriterEpoch, nativeWriterIdentity, nativeWriterToken } from './native-writer-contracts.ts'
import { nativeFileAttachment } from './native-attachment-contracts.ts'
import { nativeSessionStopId } from './native-session-stop-contracts.ts'
import { legacyMigrationImage } from './platform/legacy-migration-v2-media-contracts.ts'
import { MAX_INPUT_JSON_BYTES } from './continuation-input.ts'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PoolClient } from 'pg'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { InboxActivityCapture } from '@deepseek-ai/dsh-agent'

/** Identity survives text replacement, retargeting, epoch changes and reloads. */
export type OriginInputId = Branded<'PowerEvolveOriginInputId'>
/** One complete native claim boundary, which may contain two removal splices or no new input. */
export type InputCohortId = Branded<'PowerEvolveInputCohortId'>
/** Server receipt identity, separate from the preserved transport RPC identity. */
export type InputCommandId = Branded<'PowerEvolveInputCommandId'>
/** Canonical durable origin identity. */
export const originInputId = z.uuid().transform(value => brandString<OriginInputId>(value.toLowerCase()))
/** Canonical durable cohort identity. */
export const inputCohortId = z.uuid().transform(value => brandString<InputCohortId>(value.toLowerCase()))
/** Canonical durable command identity. */
export const inputCommandId = z.uuid().transform(value => brandString<InputCommandId>(value.toLowerCase()))
/** Current native carrier accepts RPC ids as bounded strings, not necessarily UUIDs. */
export const transportNonce = z.string().min(1).max(128)
/** Canonical JSON SHA-256 computed from actual database records after strict decoding. */
export const recordDigest = z.string().regex(/^[a-f0-9]{64}$/u)
/** Sequence and revision bounds match the existing integer event and operation schema. */
export const eventSeq = z.number().int().min(0).max(2_147_483_647)
/** One immutable content revision; retargeting alone does not create another revision. */
export const inputRevisionNumber = eventSeq.min(1)
const ordinal = eventSeq
const target = z.enum(['next-step', 'next-turn'])

/** Original admitted blocks preserve maintained image references; unsupported block kinds refuse. */
export const ledgerNativeContent = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(MAX_INPUT_JSON_BYTES) }).strict(),
  z.object({ type: z.literal('file'), attachment: nativeFileAttachment }).strict(),
  z.object({ type: z.literal('image'), attachment: legacyMigrationImage }).strict(),
])).min(1).max(32)

/** Original content and source references retained by accepted audits and stored native frame snapshots. */
export const nativeInputSnapshotFields = {
  nativeContent: ledgerNativeContent.nullable(), attachments: grant.shape.attachments.unwrap(),
  source: grant.shape.source.unwrap(), sourceActionId: grant.shape.sourceActionId.unwrap(),
  sourceExecutionId: grant.shape.sourceExecutionId.unwrap(),
  sourceStdioMcpCallId: grant.shape.sourceStdioMcpCallId.unwrap(),
  sourceSshExecuteActionId: grant.shape.sourceSshExecuteActionId.unwrap(),
  sourceMcpActionId: grant.shape.sourceMcpActionId.unwrap(),
  sourceStdioV2ActionId: grant.shape.sourceStdioV2ActionId.unwrap(),
  sourceStdioV2NoStartActionId: grant.shape.sourceStdioV2NoStartActionId.unwrap(),
  sourceStdioV2Phase: grant.shape.sourceStdioV2Phase.unwrap(), target: grant.shape.target.unwrap(),
}

/** Original admission metadata, without a fabricated execution epoch, bearer or runtime-loaded skills. */
export const acceptedInputAudit = z.object(grant.shape).omit({
  token: true, epoch: true, executionEnabled: true, skills: true,
}).extend({
  // Complete original PG text is audit data; it is not the bounded continuationInput excerpt.
  text: z.string(), ...nativeInputSnapshotFields,
  selection: grant.shape.selection.unwrap(), mcpConnections: grant.shape.mcpConnections.unwrap(),
  remoteMcpTools: grant.shape.remoteMcpTools.unwrap(), stdioV2Connections: grant.shape.stdioV2Connections.unwrap(),
  stdioMcpConnections: grant.shape.stdioMcpConnections.unwrap(), sshConnections: grant.shape.sshConnections.unwrap(),
}).strict().superRefine((value, context) => {
  const refs = {
    platform_action: value.sourceActionId, sandbox_result: value.sourceExecutionId,
    stdio_mcp_result: value.sourceStdioMcpCallId, ssh_execute_result: value.sourceSshExecuteActionId,
    remote_mcp_result: value.sourceMcpActionId, stdio_v2_result: value.sourceStdioV2ActionId,
    stdio_v2_no_start: value.sourceStdioV2NoStartActionId,
  }
  const present = Object.values(refs).filter(ref => ref !== null)
  if (value.source === 'user' ? present.length !== 0 : present.length !== 1 || refs[value.source] === null) {
    context.addIssue({ code: 'custom', message: 'Original accepted source must select exactly its own reference' })
  }
  const stdio = value.source === 'stdio_v2_result' || value.source === 'stdio_v2_no_start'
  if ((stdio && value.sourceStdioV2Phase !== 'call') || (!stdio && value.sourceStdioV2Phase !== null)) {
    context.addIssue({ code: 'custom', message: 'Original accepted source phase is inconsistent' })
  }
  if (value.source === 'user' && value.text.length > 16_384) {
    context.addIssue({ code: 'custom', message: 'Original user input exceeds the current admission bound' })
  }
})
/** Audit comes from original operation fields and immutable selected versions; it does not freeze new settings. */
export type AcceptedInputAudit = z.infer<typeof acceptedInputAudit>

const nativeSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), rpcId: z.uuid().transform(value => brandString<SessionRequestId>(value)),
    clientTimeZone: z.string().max(128).optional() }).strict(),
  z.object({ kind: z.literal('power-evolve-action'), actionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('power-evolve-execution'), executionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('power-evolve-stdio-mcp'), callId: z.uuid() }).strict(),
  z.object({ kind: z.literal('power-evolve-ssh-execute'), actionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('power-evolve-remote-mcp'),
    actionId: grant.shape.sourceMcpActionId.unwrap().unwrap() }).strict(),
  z.object({ kind: z.literal('power-evolve-stdio-v2-result'),
    actionId: grant.shape.sourceStdioV2ActionId.unwrap().unwrap(), phase: z.literal('call') }).strict(),
  z.object({ kind: z.literal('power-evolve-stdio-v2-no-start'),
    actionId: grant.shape.sourceStdioV2NoStartActionId.unwrap().unwrap(), phase: z.literal('call') }).strict(),
])
/** Product-admitted input, not a pre-step decision message or model-added context. */
export const admittedInputMessage = z.object({ id: nativeTurnMessageId, role: z.literal('user'), source: nativeSource,
  content: ledgerNativeContent,
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= MAX_INPUT_JSON_BYTES,
  { message: 'Input message exceeds the product JSON byte budget' })
/** Logical input with its original operation and immutable admission audit. */
export const inputOrigin = z.object({ originInputId, sessionId, originOperationId: operationId, originalRequestId: requestId,
  messageId: nativeTurnMessageId, acceptedSnapshotDigest: recordDigest, acceptedAudit: acceptedInputAudit }).strict()
  .superRefine((value, context) => {
    if (value.acceptedAudit.operationId !== value.originOperationId || value.acceptedAudit.sessionId !== value.sessionId
      || value.acceptedAudit.requestId !== value.originalRequestId) {
      context.addIssue({ code: 'custom', message: 'Origin must reference its own original operation and request' })
    }
  })
/** Admission or text replacement event; each content digest includes stable id, source, role and ordered content. */
export const inputRevision = z.object({ originInputId, sessionId, inputRevision: inputRevisionNumber,
  previousRevision: inputRevisionNumber.nullable(), cause: z.enum(['admission', 'edit']), message: admittedInputMessage,
  inputDigest: recordDigest, committedSpliceSeq: eventSeq, commandId: inputCommandId,
}).strict().superRefine((value, context) => {
  if (value.inputRevision === 1
    ? value.previousRevision !== null || value.cause !== 'admission'
    : value.previousRevision !== value.inputRevision - 1 || value.cause !== 'edit') {
    context.addIssue({ code: 'custom', message: 'A revision must follow its own immediate predecessor' })
  }
  if (value.cause === 'edit' && (!value.message.content.every(block => block.type === 'text')
    || !value.message.content.some(block => block.text.trim().length > 0))) {
    context.addIssue({ code: 'custom', message: 'Public edit replaces the entire content with visible text only' })
  }
})
/** One exact current execution frame; its snapshot digest covers the tokenless actual frozen Grant. */
export const executionFrameRef = z.object({ sessionId, operationId, operationEpoch: nativeOperationEpoch,
  writerEpoch: nativeWriterEpoch, frozenSnapshotDigest: recordDigest,
  ownerInput: z.object({ originInputId, inputRevision: inputRevisionNumber, inputDigest: recordDigest }).strict(),
}).strict()
/** Claim owner is chosen before flattening: actual next-turn head, otherwise explicit current frame. */
export const cohortOwner = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('next-turn-head'), originInputId }).strict(),
  z.object({ kind: z.literal('first-next-step'), originInputId }).strict(),
  z.object({ kind: z.literal('current-frame'), originInputId }).strict(),
])
/** Removal coordinates identify each input even when one splice consumes many. */
export const inputClaim = z.object({ originInputId, sessionId, inputRevision: inputRevisionNumber,
  inputDigest: recordDigest, cohortId: inputCohortId, claimSpliceSeq: eventSeq,
  spliceItemOrdinal: ordinal, cohortOrdinal: ordinal, target }).strict()
/** The claim boundary exists before step/start, including blocked, aborted and rewritten-empty outcomes. */
export const inputCohort = z.object({ cohortId: inputCohortId, frame: executionFrameRef,
  commandId: inputCommandId, owner: cohortOwner, turnStartSeq: eventSeq, turn: eventSeq.min(1),
  boundaryOrdinal: ordinal, stepStartSeq: eventSeq.nullable(), claimCount: ordinal,
  claimSpliceSeqs: z.array(eventSeq).max(2),
}).strict()

/** Original publication and terminal prepared frame retained in one immutable cancellation receipt. */
export const nativePreparedCancellationRetirement = z.object({ purpose: z.literal('prepared-user-cancel'),
  presentation: z.object({ epoch: nativeOperationEpoch, publisherId: z.uuid(),
    lastOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), eventCount: eventSeq,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  frame: z.object({ version: z.literal(2), phase: z.literal('retired'), sessionId, operationId,
    operationEpoch: nativeOperationEpoch, writerEpoch: nativeWriterEpoch, requestId, messageId: nativeTurnMessageId,
    candidateOriginInputId: originInputId, frozenSnapshotDigest: recordDigest, preparedEventCount: eventSeq,
    reason: z.literal('user_cancel'), eventCount: eventSeq, requeued: z.literal(false) }).strict(),
}).strict()

/** Original archival purpose and real publisher acknowledgement, without new execution authority. */
export const nativeArchiveInputCancellation = z.object({ purpose: z.literal('archive'), stopId: nativeSessionStopId,
  presentation: nativePreparedCancellationRetirement.shape.presentation,
}).strict()

/** Immutable original result; a replay never grants execution or chooses another revision. */
export const inputCommandReceipt = z.object({ version: z.literal(1), commandId: inputCommandId, sessionId,
  actor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('browser'), userId }).strict(),
    z.object({ kind: z.literal('writer'), userId, workerId: z.uuid(), writerEpoch: nativeWriterEpoch }).strict(),
  ]),
  rpcNonce: transportNonce, payloadDigest: recordDigest, kind: z.enum(['admission', 'edit', 'remove', 'retarget', 'claim']),
  eventCount: eventSeq, committedSpliceSeqs: z.array(eventSeq).max(2),
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pending'), originInputId, inputRevision: inputRevisionNumber, inputDigest: recordDigest, target }).strict(),
    z.object({ kind: z.literal('removed'), originInputId, inputRevision: inputRevisionNumber, inputDigest: recordDigest,
      retirement: nativePreparedCancellationRetirement.optional(), archive: nativeArchiveInputCancellation.optional() }).strict(),
    z.object({ kind: z.literal('claimed'), cohortId: inputCohortId }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  if (value.result.kind !== 'removed') return
  const archive = value.result.archive
  if (archive !== undefined && (value.result.retirement !== undefined || value.kind !== 'remove' || value.actor.kind !== 'writer'
    || archive.presentation.eventCount !== value.eventCount || value.committedSpliceSeqs.length !== 1
    || value.committedSpliceSeqs[0] !== value.eventCount - 1)) {
    context.addIssue({ code: 'custom', message: 'Archival cancellation must retain one exact removal and original publication' })
  }
  if (value.result.retirement === undefined) return
  const { frame, presentation } = value.result.retirement
  if (value.kind !== 'remove' || value.actor.kind !== 'writer' || frame.sessionId !== value.sessionId
    || frame.writerEpoch !== value.actor.writerEpoch || frame.candidateOriginInputId !== value.result.originInputId
    || frame.eventCount !== value.eventCount || presentation.eventCount !== value.eventCount
    || presentation.epoch !== frame.operationEpoch || frame.preparedEventCount >= value.eventCount
    || value.committedSpliceSeqs.length !== 1 || value.committedSpliceSeqs[0] !== value.eventCount - 1) {
    context.addIssue({ code: 'custom', message: 'Prepared cancellation must retain one exact removal and terminal publication' })
  }
})

const textReplacement = z.array(z.object({ type: z.literal('text'), text: z.string().max(MAX_INPUT_JSON_BYTES) }).strict())
  .min(1).max(32).refine(content => content.some(block => block.text.trim().length > 0))
/** Existing public queue payload plus its retained carrier nonce; no client revision/CAS extension. */
export const nativeInputQueueCommand = z.object({ rpcNonce: transportNonce, payload: z.object({ sessionId,
  itemId: nativeTurnMessageId, action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('edit'), content: textReplacement }).strict(),
    z.object({ kind: z.literal('remove') }).strict(), z.object({ kind: z.literal('steer') }).strict(),
  ]),
}).strict() }).strict()
/** One exact removal command used by prepared and archival cancellation, with unchanged strict queue fields. */
export const nativeInputRemovalCommand = nativeInputQueueCommand.extend({ payload: nativeInputQueueCommand.shape.payload.extend({
  action: z.object({ kind: z.literal('remove') }).strict(),
}).strict() }).strict()
/** Bind a real already accepted operation to its stable native identity without fabricating a new Grant. */
export const nativeInputAdmissionCommand = z.object({ rpcNonce: transportNonce, sessionId, originInputId,
  originOperationId: operationId, messageId: nativeTurnMessageId, target }).strict()
/** Internal storage authority remains independent of the browser command body. */
export const nativeInputStorageAuthority = z.object({ writer: nativeWriterIdentity, operationToken: nativeWriterToken }).strict()
/** Frame coordinates sent to the installed provider; owner revision is proved from the native PG pre-state. */
export const nativeInputFrameExpected = z.object({ sessionId, operationId, operationEpoch: nativeOperationEpoch,
  writerEpoch: nativeWriterEpoch, frozenSnapshotDigest: recordDigest }).strict()
/** Retained identity of a complete first or subsequent native claim boundary. */
export const nativeInputClaimCommand = z.object({ rpcNonce: transportNonce, cohortId: inputCohortId,
  frame: nativeInputFrameExpected, boundaryKind: z.enum(['initial-turn-step', 'continuing-step']),
}).strict()
/** One actual future step binds only to the original cohort and current exact frame. */
export const nativeInputStepCommand = z.object({ cohortId: inputCohortId, stepStartSeq: eventSeq,
  frame: nativeInputFrameExpected }).strict()
/** Native input origin decoded from a durable record. */
export type InputOrigin = z.infer<typeof inputOrigin>
/** Accurate immutable input revision. */
export type InputRevision = z.infer<typeof inputRevision>
/** Permanent logical input consumption coordinates. */
export type InputClaim = z.infer<typeof inputClaim>
/** One complete native claim proposal. */
export type InputCohort = z.infer<typeof inputCohort>
/** Historical tokenless result scoped by Session, actor and nonce. */
export type InputCommandReceipt = z.infer<typeof inputCommandReceipt>
/** Validated current internal authority, never part of a browser payload or durable receipt. */
export type NativeInputStorageAuthority = z.infer<typeof nativeInputStorageAuthority>
/** Validated admission command. */
export type NativeInputAdmissionCommand = z.infer<typeof nativeInputAdmissionCommand>
/** Validated public queue command. */
export type NativeInputQueueCommand = z.infer<typeof nativeInputQueueCommand>
/** Validated complete native claim command. */
export type NativeInputClaimCommand = z.infer<typeof nativeInputClaimCommand>
/** Validated one-time step binding. */
export type NativeInputStepCommand = z.infer<typeof nativeInputStepCommand>
/** Exact frame coordinates, independent of the original operation bearer. */
export type NativeInputFrameExpected = z.infer<typeof nativeInputFrameExpected>
/** Whole official native event batch decoded against the current header before entering the service. */
export interface NativeInputDecodedBatch {
  readonly expectedEventCount: number
  readonly events: readonly SessionEvent[]
}
/** Deployment bounds are mandatory and apply before PG record reads and writes. */
export interface NativeInputLedgerLimits {
  readonly maxAcceptedAuditBytes: number
  readonly maxRevisionBytes: number
  readonly maxCohortInputs: number
  readonly maxHistoryEvents: number
  readonly maxHistoryBytes: number
  readonly maxCommandBytes: number
  readonly maxEventBytes: number
}
/** The original model/tool snapshot remains immutable when input content is edited. */
export type NativeInputFrozenSnapshot = Omit<z.infer<typeof grant>, 'token' | 'nativeContent'> & {
  readonly nativeContent: z.infer<typeof ledgerNativeContent> | null
}
/** Once claimed, one owner stays bound to the exact current frame and turn. */
export interface NativeInputOwnerBinding {
  readonly originInputId: OriginInputId
  readonly inputRevision: number
  readonly inputDigest: string
  readonly cohortId: InputCohortId
  readonly claimSpliceSeq: number
  readonly spliceItemOrdinal: number
  readonly target: 'next-step' | 'next-turn'
  readonly turnStartSeq: number
  readonly turn: number
}
/** The Root-owned provider reads the current PG frame and exact frozen metadata on this transaction. */
export interface NativeInputVerifiedFrame extends NativeInputFrameExpected {
  readonly candidateOriginInputId: OriginInputId
  readonly messageId: MessageId
  readonly frozenSnapshot: NativeInputFrozenSnapshot
  readonly owner: NativeInputOwnerBinding | null
}
/** Provider reads first, then may bind the owner atomically with the already proved complete cohort. */
export type NativeInputFrameVerification = {
  readonly authority: NativeInputStorageAuthority
  readonly expected: NativeInputFrameExpected | null
} & ({ readonly kind: 'read' } | { readonly kind: 'bind-owner'; readonly owner: NativeInputOwnerBinding })
/** Required frame provider; its absence is a refusal, never a v1 or permissive fallback.
 * @param client Caller transaction holding account, Session, Writer and current attempt locks.
 * @param request Current authority plus read or exact owner binding purpose.
 * @returns Actual current frame and original frozen snapshot after the provider's PG checks.
 */
export type NativeInputFrameVerifier = (client: PoolClient, request: NativeInputFrameVerification) => Promise<NativeInputVerifiedFrame>
/** Actual official native phase capture; callers retain its exact maintenance signal until commit. */
export type NativeInputPlanningActivity = InboxActivityCapture
/** The planner uses official detached native APIs and performs no live Agent mutation or network work. */
export interface NativeInputPlannerPort {
  /** Plan one real public queue command before any event or mirror is published.
   * @param header Actual PG native header.
   * @param events Complete validated PG history.
   * @param command Existing public request plus retained RPC nonce.
   * @param activity Protected current native phase capture.
   * @returns Complete canonical batch and the native-resolved target.
   */
  planQueue(header: SessionHeader, events: readonly SessionEvent[], command: NativeInputQueueCommand,
    activity?: NativeInputPlanningActivity): Promise<NativeInputDecodedBatch & { readonly resolvedTarget: 'next-step' | 'next-turn' | null }>
}
