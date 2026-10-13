/** Bounded HTTP transport for the actual Platform input transaction services. */
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { PlatformError, type Grant } from '../contracts.ts'
import { inputCommandReceipt, type NativeInputAdmissionCommand, type NativeInputClaimCommand,
  type NativeInputDecodedBatch, type NativeInputQueueCommand, type NativeInputStepCommand,
  type NativeInputStorageAuthority } from '../native-input-ledger-contracts.ts'
import { nativeInputAcceptedCommit, nativeInputClaimCommit, nativeInputCommitReceipt,
  nativeInputQueueCommit, nativeInputStepCommit } from '../native-input-commit-contracts.ts'
import { nativeInputFrameRequest, nativeInputPendingRequest, nativeInputPendingResponse } from '../native-input-commit-contracts.ts'
import { nativeExecutionFrame } from '../native-execution-frame-contracts.ts'
import { nativePreparedInputRecovery } from '../native-prepared-input-recovery-contracts.ts'
import { nativeConsumedInputRecovery } from '../native-consumed-input-recovery-contracts.ts'
import { nativePreparedCancelCommit, nativePreparedCancelReceipt, nativePreparedCancelIntentDigest,
  type NativePreparedCancelCommit, type NativePreparedCancelReceipt } from '../native-prepared-cancel-contracts.ts'
import { nativeArchiveInputCancelCommit, nativeArchiveInputCancelReceipt, nativeArchiveInputCancelIntentDigest,
  type NativeArchiveInputCancelCommit, type NativeArchiveInputCancelReceipt } from '../native-archive-input-contracts.ts'
import { nativeTurnTransitionV2, nativeTurnResponseV2, type NativeTurnTransitionV2 } from '../native-turn-continuation-v2-contracts.ts'
import type { NativeWriterIdentity } from '../native-writer-contracts.ts'
import { nativeTurnMessageId } from '../native-turn-contracts.ts'
import { ledgerFrozenSnapshotDigest, nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import type { NativeAssistantBatch } from '../native-assistant-records.ts'
import type { NativePublicationSeal } from './native-assistant-publisher.ts'
import type { NativeInputCommitResult, NativeInputCommitTransport } from './native-input-coordinator.ts'
import type RuntimeScope from './scope.ts'

/** Compare the whole acknowledged publication and splice position; family authority stays with each caller. */
function matchingCancellationPresentation(operation: Grant,
  input: NativePreparedCancelCommit | NativeArchiveInputCancelCommit,
  result: NativePreparedCancelReceipt | NativeArchiveInputCancelReceipt): boolean {
  return result.presentation.epoch === operation.epoch
    && result.presentation.publisherId === input.presentation.publisherId
    && result.presentation.lastOrdinal === input.presentation.firstOrdinal + input.events.length - 1
    && result.presentation.revision === input.seal.revision
    && result.presentation.eventCount === input.expectedEventCount + input.events.length
    && result.input.eventCount === result.presentation.eventCount
    && isDeepStrictEqual(result.input.committedSpliceSeqs, [input.expectedEventCount])
}

/** All input and presentation acknowledgements come from the configured Platform endpoint. */
export class NativeInputHttp implements NativeInputCommitTransport {
  /** @param runtime Current Host's bounded authenticated Platform transport. */
  constructor(private readonly runtime: RuntimeScope) {}

  /** Read a bounded creation-order batch of actual accepted inputs for the current owner.
   * @param operation Exact current Platform Grant installed in RuntimeScope.
   * @param writer Independently acquired Session Writer.
   * @param limit Explicit maximum number of original pending operations.
   * @param signal Scheduler admission lifetime.
   * @returns Original messages and acceptance records; no queued capability is installed.
   */
  async pending(operation: Grant, writer: NativeWriterIdentity, limit: number, signal?: AbortSignal) {
    this.runtime.assertGrant(operation)
    const input = nativeInputPendingRequest.parse({ version: 1, writer, limit })
    const response = nativeInputPendingResponse.parse(await this.runtime.call('/runtime/native-input/pending', operation.token, input, signal))
    this.runtime.assertGrant(operation)
    if (writer.sessionId !== operation.sessionId || response.items.some(item => item.acceptedInputAudit.sessionId !== operation.sessionId
      || item.acceptedInputAudit.userId !== operation.userId || item.acceptedInputAudit.operationId !== item.originOperationId
      || item.acceptedInputAudit.requestId !== item.requestId || item.message.id !== nativeTurnMessageId.parse(item.originOperationId))) {
      throw new PlatformError(502, 'native_input_pending_receipt')
    }
    return response
  }

  /** Read the current actual frame before restoring its pending native message.
   * @param operation Exact current operation, never a historical receipt.
   * @param writer Exact independently acquired Session Writer.
   * @param signal Scheduler admission lifetime.
   * @returns Parsed original current frame; the Coordinator separately checks prepared identity.
   */
  async currentFrame(operation: Grant, writer: NativeWriterIdentity, signal?: AbortSignal) {
    this.runtime.assertGrant(operation)
    const result = nativeExecutionFrame.parse(await this.runtime.call('/runtime/native-input/frame', operation.token,
      nativeInputFrameRequest.parse({ version: 1, writer }), signal))
    this.runtime.assertGrant(operation)
    if (result.sessionId !== operation.sessionId || result.operationId !== operation.operationId
      || result.operationEpoch !== operation.epoch || result.writerEpoch !== writer.epoch || result.requestId !== operation.requestId) {
      throw new PlatformError(502, 'native_input_frame_identity')
    }
    return result
  }

  /** Restore only a previously admitted unconsumed input under current storage authority.
   * @param operation Current separately issued operation bearer, installed before this call.
   * @param writer Current independently acquired Writer; old occupancy is never reconstructed.
   * @param signal Admission lifetime kept renewable until the restored generation is installed.
   * @returns Fresh admission or a proved prepared frame and its original selections under this current bearer.
   */
  async recoverPrepared(operation: Grant, writer: NativeWriterIdentity, signal?: AbortSignal) {
    this.runtime.assertGrant(operation)
    const result = nativePreparedInputRecovery.parse(await this.runtime.call('/runtime/native-input/recover-prepared', operation.token,
      nativeInputFrameRequest.parse({ version: 1, writer }), signal))
    this.runtime.assertGrant(operation)
    if (result.kind === 'prepared' && (result.grant.token !== operation.token || result.grant.operationId !== operation.operationId
      || result.grant.sessionId !== operation.sessionId || result.grant.userId !== operation.userId
      || result.grant.requestId !== operation.requestId || result.grant.epoch !== operation.epoch
      || result.frame.writerEpoch !== writer.epoch || result.frame.sessionId !== writer.sessionId)) {
      throw new PlatformError(502, 'native_input_recovery_identity')
    }
    return result
  }

  /** Read original consumption under a later storage attempt without permitting another model or tool execution.
   * @param operation Independently issued current storage Grant installed in RuntimeScope.
   * @param writer Current independently acquired Session Writer.
   * @param signal Admission lifetime kept renewable while native repair is prepared.
   * @returns Historical claimed frame and its unchanged accepted metadata with only the current epoch and bearer replaced.
   */
  async recoverConsumed(operation: Grant, writer: NativeWriterIdentity, signal?: AbortSignal) {
    this.runtime.assertGrant(operation)
    const result = nativeConsumedInputRecovery.parse(await this.runtime.call('/runtime/native-input/recover-consumed', operation.token,
      nativeInputFrameRequest.parse({ version: 1, writer }), signal))
    this.runtime.assertGrant(operation)
    if (result.grant.token !== operation.token || result.grant.operationId !== operation.operationId
      || result.grant.sessionId !== operation.sessionId || result.grant.userId !== operation.userId
      || result.grant.requestId !== operation.requestId || result.grant.epoch !== operation.epoch
      || result.frame.sessionId !== writer.sessionId) throw new PlatformError(502, 'native_input_recovery_identity')
    return result
  }

  /** Retire one original prepared input with an unchanged request, including retries after its source operation ended.
   * @param operation Original locally installed storage Grant whose bearer is bound into the retained intent.
   * @param request Exact native removal, prepared frame, Writer and publication identities retained before the first call.
   * @param signal Whole cancellation lifetime; an uncertain response retries the same request.
   * @returns Original tokenless removal, publication acknowledgement and exact retired frame.
   */
  async cancelPrepared(operation: Grant, request: NativePreparedCancelCommit, signal?: AbortSignal) {
    this.runtime.assertGrant(operation)
    const input = nativePreparedCancelCommit.parse(request)
    if (input.frame.sessionId !== operation.sessionId
      || input.frame.operationId !== operation.operationId || input.frame.operationEpoch !== operation.epoch
      || input.frame.requestId !== operation.requestId || input.frame.writerEpoch !== input.writer.epoch) {
      throw new PlatformError(409, 'native_input_cancellation_identity')
    }
    const raw = await this.runtime.commitNativeMutation(operation.token, { family: 'prepared-cancel', request: input }, signal)
    const result = nativePreparedCancelReceipt.parse(raw)
    this.runtime.assertGrant(operation)
    if (nativeInputRecordDigest(raw) !== nativeInputRecordDigest(result)
      || result.input.actor.kind !== 'writer' || result.input.actor.userId !== operation.userId
      || result.input.actor.workerId !== input.writer.workerId || result.input.actor.writerEpoch !== input.writer.epoch
      || result.input.sessionId !== operation.sessionId || result.input.kind !== 'remove'
      || result.input.rpcNonce !== input.command.rpcNonce
      || result.input.payloadDigest !== nativePreparedCancelIntentDigest(operation.token, input)
      || result.input.result.kind !== 'removed' || result.input.result.originInputId !== input.frame.candidateOriginInputId
      || !isDeepStrictEqual(result.frame, { ...input.frame, phase: 'retired', reason: 'user_cancel',
        requeued: false, eventCount: input.expectedEventCount + input.events.length })
      || !matchingCancellationPresentation(operation, input, result)) {
      throw new PlatformError(502, 'native_input_cancellation_receipt')
    }
    return result
  }

  /** Cancel one archival sibling using its unchanged original request and actual publication acknowledgement.
   * @param operation Current locally installed storage Grant; cold frames retain their original epochs.
   * @param request Original stop, frame, latest pending removal and current Writer/publication intent.
   * @param signal Whole archival maintenance lifetime, also used for exact uncertain-response retries.
   * @returns Historical tokenless acknowledgement granting no replacement operation or execution authority.
   */
  async cancelArchiveInput(operation: Grant, request: NativeArchiveInputCancelCommit, signal?: AbortSignal) {
    this.runtime.assertGrant(operation)
    const input = nativeArchiveInputCancelCommit.parse(request)
    if (input.frame.sessionId !== operation.sessionId || input.frame.operationId !== operation.operationId
      || input.frame.requestId !== operation.requestId || input.presentation.epoch !== operation.epoch
      || input.frame.operationEpoch > operation.epoch || input.writer.sessionId !== operation.sessionId) {
      throw new PlatformError(409, 'native_input_cancellation_identity')
    }
    const raw = await this.runtime.commitNativeMutation(operation.token, { family: 'archive-cancel', request: input }, signal)
    const result = nativeArchiveInputCancelReceipt.parse(raw)
    this.runtime.assertGrant(operation)
    if (nativeInputRecordDigest(raw) !== nativeInputRecordDigest(result) || result.stopId !== input.stopId
      || result.input.actor.kind !== 'writer' || result.input.actor.userId !== operation.userId
      || result.input.actor.workerId !== input.writer.workerId || result.input.actor.writerEpoch !== input.writer.epoch
      || result.input.sessionId !== operation.sessionId || result.input.kind !== 'remove'
      || result.input.rpcNonce !== input.command.rpcNonce
      || result.input.payloadDigest !== nativeArchiveInputCancelIntentDigest(operation.token, input)
      || result.input.result.kind !== 'removed' || result.input.result.retirement !== undefined
      || !matchingCancellationPresentation(operation, input, result)) {
      throw new PlatformError(502, 'native_input_cancellation_receipt')
    }
    return result
  }

  /** Prepare a retained transition from the actual closed PG turn while native progress is quiet.
   * @param operation Original current Grant whose publisher supplied the seal.
   * @param writer Current independent Session Writer.
   * @param seal Exact acknowledged closed-turn watermark.
   * @param retained Caller-generated transition identity and candidate bearer retained before this call.
   * @param signal Caller lifetime, including a quiet before-turn preparation.
   * @param reconcile Derive historical consumption using the actual provider and current storage epoch.
   * @returns Complete actual PG intent; retry its settlement unchanged after an uncertain response.
   */
  async prepareAdvance(operation: Grant, writer: NativeWriterIdentity, seal: NativePublicationSeal,
    retained: Pick<NativeTurnTransitionV2, 'transitionId' | 'candidateToken'>, signal?: AbortSignal,
    reconcile = false): Promise<NativeTurnTransitionV2> {
    this.runtime.assertGrant(operation)
    const result = nativeTurnTransitionV2.parse(await this.runtime.call('/runtime/native-turn/prepare', operation.token,
      { writer, seal, ...retained, ...reconcile ? { kind: 'reconcile' } : {} }, signal))
    this.runtime.assertGrant(operation)
    if (result.from.operationToken !== operation.token || result.from.frame.operationId !== operation.operationId
      || (reconcile ? result.kind !== 'reconcile' || result.storageOperationEpoch !== operation.epoch
        : result.kind !== 'advance' || result.from.frame.operationEpoch !== operation.epoch) || !isDeepStrictEqual(result.writer, writer)
      || !isDeepStrictEqual(result.seal, seal) || result.transitionId !== retained.transitionId
      || result.candidateToken !== retained.candidateToken) throw new PlatformError(502, 'native_turn_transition_receipt')
    return result
  }

  /** Settle or reconcile one unchanged retained closed-turn transition.
   * @param operation Original local Grant remains installed until the returned result is proved and retired.
   * @param request Full prepared intent, including the original retained candidate token.
   * @param signal Caller lifetime; an uncertain request retains its entire original intent.
   * @returns Exact receipt and only its separately verified current successor authority.
   */
  async advance(operation: Grant, request: NativeTurnTransitionV2, signal?: AbortSignal) {
    this.runtime.assertGrant(operation)
    if (request.from.operationToken !== operation.token || request.from.frame.operationId !== operation.operationId
      || (request.kind === 'reconcile' ? request.storageOperationEpoch !== operation.epoch
        : request.from.frame.operationEpoch !== operation.epoch)) throw new PlatformError(409, 'native_turn_transition_identity')
    const raw = await this.runtime.commitNativeMutation(operation.token, { family: 'turn-transition', request }, signal)
    const response = nativeTurnResponseV2.parse(raw)
    if (nativeInputRecordDigest(raw) !== nativeInputRecordDigest(response)) throw new PlatformError(502, 'native_turn_transition_receipt')
    this.runtime.assertGrant(operation)
    const { operationToken: _operationToken, ...from } = request.from
    const receipt = response.receipt
    if (receipt.sessionId !== operation.sessionId || receipt.writerEpoch !== request.writer.epoch
      || receipt.transitionId !== request.transitionId || receipt.eventCount !== request.expectedEventCount
      || receipt.queueRevision !== request.expectedQueueRevision || !isDeepStrictEqual(receipt.from, from)) {
      throw new PlatformError(502, 'native_turn_transition_receipt')
    }
    if (response.current.kind === 'live') {
      const live = response.current
      if (receipt.result.kind !== 'prepared') throw new PlatformError(502, 'native_turn_transition_receipt')
      const { token: _token, ...frozen } = live.grant
      if (live.grant.token !== request.candidateToken || !isDeepStrictEqual(frozen, receipt.result.grant)
        || ledgerFrozenSnapshotDigest(frozen) !== live.frame.frozenSnapshotDigest
        || live.frame.operationId !== receipt.result.frame.operationId || live.frame.operationEpoch !== receipt.result.frame.operationEpoch
        || live.frame.sessionId !== receipt.sessionId || live.frame.writerEpoch !== receipt.writerEpoch
        || live.frame.frozenSnapshotDigest !== receipt.result.frame.frozenSnapshotDigest
        || live.grant.operationId !== live.frame.operationId || live.grant.epoch !== live.frame.operationEpoch
        || live.grant.sessionId !== receipt.sessionId || live.grant.userId !== operation.userId) {
        throw new PlatformError(502, 'native_turn_transition_receipt')
      }
    } else if (response.current.kind === 'parked' && receipt.result.kind !== 'parked') {
      throw new PlatformError(502, 'native_turn_transition_receipt')
    }
    return response
  }

  /** Look up an original browser result before attempting another pending mutation.
   * @param credential Original current browser bearer.
   * @param command Original carrier request and nonce.
   * @returns Parsed historical receipt, or null when no such command committed.
   */
  async queueReceipt(credential: string, command: NativeInputQueueCommand) {
    return inputCommandReceipt.nullable().parse(await this.runtime.call('/native/input/queue-receipt', credential, command))
  }

  /** Commit accepted input and its native presentation in one actual Platform transaction.
   * @param command Stable original accepted operation identity.
   * @param authority Exact independent Writer and original operation bearer.
   * @param batch Complete native canonical suffix.
   * @param publication Reserved existing publisher counters and retained batch identity.
   * @param prepare Whether this is the storage operation's original bootstrap input.
   * @returns The strict receipt and any actual prepared frame.
   */
  async admit(command: NativeInputAdmissionCommand, authority: NativeInputStorageAuthority,
    batch: NativeInputDecodedBatch, publication: NativeAssistantBatch, prepare: boolean): Promise<NativeInputCommitResult> {
    const input = nativeInputAcceptedCommit.parse({ ...this.batch(authority, batch, publication), command, prepareFrame: prepare })
    const result = nativeInputCommitReceipt.parse(await this.runtime.commitNativeMutation(authority.operationToken,
      { family: 'admission', request: input }))
    if (result.kind !== 'admission') throw new PlatformError(502, 'native_input_commit_receipt')
    return { input: result.input, presentation: result.presentation, ...result.frame ? { frame: result.frame } : {} }
  }

  /** Commit the entire actual native claim before prompt assembly proceeds.
   * @param command Retained cohort and exact frame coordinates.
   * @param authority Original operation and current Writer.
   * @param batch Complete removal batch, including an empty continuing cohort.
   * @param publication Exact reserved publisher generation and batch identity.
   * @returns Strict tokenless transaction acknowledgements.
   */
  async claim(command: NativeInputClaimCommand, authority: NativeInputStorageAuthority,
    batch: NativeInputDecodedBatch, publication: NativeAssistantBatch): Promise<NativeInputCommitResult> {
    const input = nativeInputClaimCommit.parse({ ...this.batch(authority, batch, publication), command })
    const result = nativeInputCommitReceipt.parse(await this.runtime.commitNativeMutation(authority.operationToken,
      { family: 'claim', request: input }))
    if (result.kind !== 'claim') throw new PlatformError(502, 'native_input_commit_receipt')
    return result
  }

  /** Commit a native queue mutation under both its original browser and current storage authorities.
   * @param credential Original browser bearer for this request only.
   * @param command Existing public payload and retained carrier nonce.
   * @param authority Exact current Writer and storage operation.
   * @param batch Entire detached native plan.
   * @param publication Exact reserved publisher generation and batch identity.
   * @returns Strict tokenless transaction acknowledgements.
   */
  async queue(credential: string, command: NativeInputQueueCommand, authority: NativeInputStorageAuthority,
    batch: NativeInputDecodedBatch, publication: NativeAssistantBatch): Promise<NativeInputCommitResult> {
    const input = nativeInputQueueCommit.parse({ ...this.batch(authority, batch, publication), command })
    const result = nativeInputCommitReceipt.parse(await this.runtime.commitNativeMutation(authority.operationToken,
      { family: 'queue', request: { credential, request: input } }))
    if (result.kind !== 'queue') throw new PlatformError(502, 'native_input_commit_receipt')
    return result
  }

  /** Bind the actual published step before any model or business tool uses the original Grant.
   * @param command Current durable cohort and real step/start sequence.
   * @param authority Exact current storage operation and Writer.
   * @param seal Acknowledged ordinary publication watermark.
   */
  async bindStep(command: NativeInputStepCommand, authority: NativeInputStorageAuthority, seal: NativePublicationSeal): Promise<void> {
    const input = nativeInputStepCommit.parse({ version: 1, writer: authority.writer, command, seal })
    const result = nativeInputCommitReceipt.parse(await this.runtime.commitNativeMutation(authority.operationToken,
      { family: 'step', request: input }))
    if (result.kind !== 'step' || result.cohort.cohortId !== command.cohortId
      || result.cohort.stepStartSeq !== command.stepStartSeq || result.presentation.epoch !== command.frame.operationEpoch
      || result.presentation.publisherId !== seal.publisherId || result.presentation.eventCount !== seal.eventCount
      || result.presentation.lastOrdinal !== seal.lastOrdinal || result.presentation.revision !== seal.revision) {
      throw new PlatformError(502, 'native_input_commit_receipt')
    }
  }

  private batch(authority: NativeInputStorageAuthority, batch: NativeInputDecodedBatch, publication: NativeAssistantBatch) {
    return { version: 1, writer: authority.writer, expectedEventCount: batch.expectedEventCount,
      events: z.array(z.json()).parse(batch.events), presentation: { epoch: publication.epoch,
        publisherId: publication.publisherId, batchId: publication.batchId, firstOrdinal: publication.firstOrdinal } }
  }
}
