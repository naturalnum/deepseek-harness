/** Private durable mutation requests and tokenless reconciliation; neither records nor receipts grant execution. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { operationId, sessionId, userId } from './contracts.ts'
import { nativeAssistantBatch } from './native-assistant-records.ts'
import { nativeInputAcceptedCommit, nativeInputClaimCommit, nativeInputQueueCommit,
  nativeInputStepCommit, nativeInputCommitReceipt, nativeInputPresentationReceipt } from './native-input-commit-contracts.ts'
import { nativePreparedCancelCommit, nativePreparedCancelReceipt } from './native-prepared-cancel-contracts.ts'
import { nativeArchiveInputCancelCommit, nativeArchiveInputCancelReceipt } from './native-archive-input-contracts.ts'
import { recordDigest } from './native-input-ledger-contracts.ts'
import { nativeTurnTransitionV2, nativeTurnReceiptV2, nativeTurnResponseV2 } from './native-turn-continuation-v2-contracts.ts'
import { nativeWriterWorkerId } from './native-writer-contracts.ts'
import { nativeOperationEpoch } from './native-turn-contracts.ts'

/** Platform-keyed complete request identity, including its original operation bearer. */
export type NativeRetainedIntentId = Branded<'PowerEvolveNativeRetainedIntentId'>
/** Canonical identity never includes a raw bearer in a path or log. */
export const nativeRetainedIntentId = z.string().regex(/^[a-f0-9]{64}$/u)
  .transform(brandString<NativeRetainedIntentId>)
/** Closed set of native mutations eligible for durable original-request reconciliation. */
export const nativeRetainedFamily = z.enum(['publication', 'admission', 'claim', 'queue', 'step',
  'prepared-cancel', 'archive-cancel', 'turn-transition'])

/** Existing native transaction requests stay intact, including original queue credentials and all publication counters. */
export const nativeRetainedMutation = z.discriminatedUnion('family', [
  z.object({ family: z.literal('publication'), request: nativeAssistantBatch }).strict(),
  z.object({ family: z.literal('admission'), request: nativeInputAcceptedCommit }).strict(),
  z.object({ family: z.literal('claim'), request: nativeInputClaimCommit }).strict(),
  z.object({ family: z.literal('queue'), request: z.object({ credential: z.string().min(1),
    request: nativeInputQueueCommit }).strict() }).strict(),
  z.object({ family: z.literal('step'), request: nativeInputStepCommit }).strict(),
  z.object({ family: z.literal('prepared-cancel'), request: nativePreparedCancelCommit }).strict(),
  z.object({ family: z.literal('archive-cancel'), request: nativeArchiveInputCancelCommit }).strict(),
  z.object({ family: z.literal('turn-transition'), request: nativeTurnTransitionV2 }).strict(),
])
/** Complete request persisted by Platform before any native mutation is dispatched. */
export const nativeRetainedPrepare = z.object({ version: z.literal(1), workerId: nativeWriterWorkerId,
  mutation: nativeRetainedMutation }).strict()
/** Platform response to an unchanged prepare or its retry; no secret or grant is returned. */
export const nativeRetainedPrepared = z.object({ version: z.literal(1), intentId: nativeRetainedIntentId,
  family: nativeRetainedFamily, state: z.enum(['prepared', 'committed', 'abandoned']) }).strict()
/** Execute only one retained original request; the original operation bearer remains the HTTP credential. */
export const nativeRetainedExecute = z.object({ version: z.literal(1), workerId: nativeWriterWorkerId,
  intentId: nativeRetainedIntentId }).strict()

const inputReceipt = (kind: 'admission' | 'claim' | 'queue' | 'step') =>
  nativeInputCommitReceipt.refine(value => value.kind === kind,
    { message: 'Retained input receipt must match its mutation family' })
const inputResults = [
  z.object({ family: z.literal('publication'), result: nativeInputPresentationReceipt }).strict(),
  z.object({ family: z.literal('admission'), result: inputReceipt('admission') }).strict(),
  z.object({ family: z.literal('claim'), result: inputReceipt('claim') }).strict(),
  z.object({ family: z.literal('queue'), result: inputReceipt('queue') }).strict(),
  z.object({ family: z.literal('step'), result: inputReceipt('step') }).strict(),
  z.object({ family: z.literal('prepared-cancel'), result: nativePreparedCancelReceipt }).strict(),
  z.object({ family: z.literal('archive-cancel'), result: nativeArchiveInputCancelReceipt }).strict(),
] as const
/** Immutable results saved in the same PG transaction as their native facts; all variants are tokenless. */
export const nativeRetainedReceipt = z.discriminatedUnion('family', [
  ...inputResults, z.object({ family: z.literal('turn-transition'), result: nativeTurnReceiptV2 }).strict(),
])
/** Warm replies may carry a successor only through the original v2 provider's independent live proof. */
export const nativeRetainedExecutionResult = z.discriminatedUnion('family', [
  ...inputResults,
  z.object({ family: z.literal('turn-transition'), result: nativeTurnResponseV2 }).strict(),
])
/** Private bounded maintenance request; routed workers never receive another worker's stored credentials. */
export const nativeRetainedReconcile = z.object({ version: z.literal(1), workerId: nativeWriterWorkerId,
  limit: z.number().int().positive().max(2_147_483_647) }).strict()
/** Historical reconciliation is separate from live grant installation and original model/tool execution. */
export const nativeRetainedReconciled = z.object({ version: z.literal(1), items: z.array(z.object({
  intentId: nativeRetainedIntentId, userId, sessionId, operationId,
  operationEpoch: nativeOperationEpoch, workerId: nativeWriterWorkerId,
  outcome: z.discriminatedUnion('state', [
    z.object({ state: z.literal('blocked') }).strict(),
    z.object({ state: z.literal('committed'), receipt: nativeRetainedReceipt, retired: z.boolean() }).strict(),
    z.object({ state: z.literal('abandoned') }).strict(),
  ]),
}).strict()), more: z.boolean() }).strict()
/** Confirm a validated original receipt after local synchronization; only sealed credentials may be cleared. */
export const nativeRetainedResolve = nativeRetainedExecute.extend({ receiptDigest: recordDigest }).strict()
/** Resolution preserves the permanent identity and tokenless receipt; it cannot alter native facts or authority. */
export const nativeRetainedResolved = z.object({ version: z.literal(1), intentId: nativeRetainedIntentId,
  receiptDigest: recordDigest, resolved: z.literal(true) }).strict()

/** Complete parsed mutation body; raw operation and browser secrets remain private. */
export type NativeRetainedMutation = z.infer<typeof nativeRetainedMutation>
/** Tokenless historical journal result, never a source of a new operation capability. */
export type NativeRetainedReceipt = z.infer<typeof nativeRetainedReceipt>
/** Live-proof-aware original execution result. */
export type NativeRetainedExecutionResult = z.infer<typeof nativeRetainedExecutionResult>

/** Versioned private routes shared by Host and trusted Platform. */
export const NATIVE_RETAINED_ROUTES = {
  prepare: '/runtime/native-intents/prepare', execute: '/runtime/native-intents/execute',
  reconcile: '/runtime/native-intents/reconcile', resolve: '/runtime/native-intents/resolve',
} as const
