/** Native claim barriers and committed pending-input mirrors for one exact Host operation. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Agent, InboxActivityCapture, InboxClaimBoundary } from '@deepseek-ai/dsh-agent'
import { planInboxCommand } from '@deepseek-ai/dsh-agent-loop'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { PlatformError, type Grant } from '../contracts.ts'
import type { NativeExecutionFrame } from '../native-execution-frame-contracts.ts'
import { inputCohortId,
  type InputCommandReceipt, type NativeInputAdmissionCommand, type NativeInputClaimCommand,
  type NativeInputDecodedBatch, type NativeInputQueueCommand, type NativeInputStepCommand,
  type NativeInputStorageAuthority, type NativeInputFrameExpected } from '../native-input-ledger-contracts.ts'
import { nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import { nativeAssistantBatch, type NativeAssistantBatch } from '../native-assistant-records.ts'
import type { NativeWriterIdentity } from '../native-writer-contracts.ts'
import type { NativeAssistantReceipt } from '../platform/native-assistant-store.ts'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { NativeInputPublicationPosition, NativePublicationSeal } from './native-assistant-publisher.ts'
import type RuntimeScope from './scope.ts'

/** Parsed Platform result; the original command and reserved counters are checked before mirror mutation. */
export interface NativeInputCommitResult {
  readonly input: InputCommandReceipt
  readonly presentation: NativeAssistantReceipt
  readonly frame?: NativeExecutionFrame
}

/** Actual Platform calls sharing ledger, canonical events and presentation in one transaction. */
export interface NativeInputCommitTransport {
  /** Read an immutable original browser result before planning a request whose item may already be removed. */
  queueReceipt(credential: string, command: NativeInputQueueCommand): Promise<InputCommandReceipt | null>
  /** Commit original accepted metadata and optionally prepare its first execution frame. */
  admit(command: NativeInputAdmissionCommand, authority: NativeInputStorageAuthority,
    batch: NativeInputDecodedBatch, publication: NativeAssistantBatch, prepare: boolean): Promise<NativeInputCommitResult>
  /** Commit the complete synchronous native claim, including an empty continuing cohort. */
  claim(command: NativeInputClaimCommand, authority: NativeInputStorageAuthority,
    batch: NativeInputDecodedBatch, publication: NativeAssistantBatch): Promise<NativeInputCommitResult>
  /** Commit a browser command planned under this exact native activity capture. */
  queue(credential: string, command: NativeInputQueueCommand, authority: NativeInputStorageAuthority,
    batch: NativeInputDecodedBatch, publication: NativeAssistantBatch): Promise<NativeInputCommitResult>
  /** Bind a previously published actual step to its complete durable claim. */
  bindStep(command: NativeInputStepCommand, authority: NativeInputStorageAuthority,
    seal: NativePublicationSeal): Promise<void>
}

/** One operation owns claim settlement; queued inputs retain their own original accepted origins. */
export class NativeInputCoordinator {
  private readonly events: SessionEvent[]
  private readonly authority: NativeInputStorageAuthority
  private frame: NativeInputFrameExpected | undefined
  private cohort: { command: NativeInputClaimCommand; turn: number; step: number; boundStepStartSeq?: number } | undefined
  private initialized = false

  /**
   * @param agent Exact resumed Agent, before any pending input is woken.
   * @param runtime Its current operation and ordered persistence publisher.
   * @param operation Original Platform-issued Grant, never a merged queued selection.
   * @param writer Independently acquired exact live Session Writer.
   * @param history Complete initial canonical snapshot used to resume this Agent.
   * @param transport Actual bounded Platform transaction endpoints.
   * @param onStorageFailure Marks an input or persistence failure before the native loop reports it as agent/error.
   */
  constructor(private readonly agent: Agent, private readonly runtime: RuntimeScope, private readonly operation: Grant,
    writer: NativeWriterIdentity, history: readonly SessionEvent[], private readonly transport: NativeInputCommitTransport,
    onStorageFailure?: (error: unknown) => void) {
    runtime.assertGrant(operation)
    if (agent.session.id !== operation.sessionId || writer.sessionId !== operation.sessionId
      || writer.workerId !== runtime.workerId || agent.session.seq !== history.length) {
      throw new PlatformError(409, 'native_input_owner_identity')
    }
    this.events = structuredClone([...history])
    this.authority = { writer, operationToken: operation.token }
    agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.seq !== this.events.length) {
        const error = new PlatformError(409, 'native_input_observation_prefix')
        onStorageFailure?.(error)
        throw error
      }
      this.events.push(structuredClone(event))
    })
    agent.ctx.effect(() => agent.onAfterClaim(async (boundary) => {
      try { await this.commitClaim(boundary) }
      catch (error) { onStorageFailure?.(error); throw error }
    }))
    agent.ctx.on('agent/request', async ({ agent: source, turn, step }, next) => {
      if (source !== agent) return next()
      try {
        const cohort = this.cohort
        if (!cohort || cohort.turn !== turn || cohort.step !== step) throw new PlatformError(409, 'native_input_step_missing')
        const start = this.events.findLast(event => event.type === 'step/start'
          && event.data.turn === turn && event.data.step === step)
        if (!start) throw new PlatformError(409, 'native_input_step_missing')
        await agent.ctx.sessions.flush(agent.session)
        this.assertOwner()
        // Official retries retain this step's first acknowledged binding and its original publication position.
        if (cohort.boundStepStartSeq !== start.seq) {
          const seal = await runtime.publication(operation).seal()
          await transport.bindStep({ cohortId: cohort.command.cohortId, frame: cohort.command.frame,
            stepStartSeq: start.seq }, this.authority, seal)
          this.assertOwner()
          cohort.boundStepStartSeq = start.seq
        }
        this.assertOwner()
      } catch (error) { onStorageFailure?.(error); throw error }
      // Downstream model errors retain native turn settlement semantics.
      return next()
    })
  }

  /** Adopt only a proved prepared frame belonging to this original operation and independent Writer.
   * @param frame Parsed actual PG frame, obtained from admission or an exact restored pending origin.
   */
  prepare(frame: NativeExecutionFrame): void {
    this.assertOwner()
    if (frame.phase !== 'prepared' || frame.sessionId !== this.operation.sessionId
      || frame.operationId !== this.operation.operationId || frame.operationEpoch !== this.operation.epoch
      || frame.writerEpoch !== this.authority.writer.epoch || frame.requestId !== this.operation.requestId) {
      throw new PlatformError(409, 'native_input_frame_identity')
    }
    this.frame = { sessionId: frame.sessionId, operationId: frame.operationId, operationEpoch: frame.operationEpoch,
      writerEpoch: frame.writerEpoch, frozenSnapshotDigest: frame.frozenSnapshotDigest }
  }

  /** Insert a previously accepted input under the native idle or model-streaming reservation.
   * @param command Stable original operation/input identities and retained admission nonce.
   * @param message Exact native message from the original accepted audit, with ordered content preserved.
   * @param prepare Whether this input is the current operation's initial frame candidate.
   * @returns Immutable durable admission after receipt validation and both local mirrors.
   */
  admit(command: NativeInputAdmissionCommand, message: UserMessage, prepare = false): Promise<InputCommandReceipt> {
    return this.agent.runMaintenance(async (signal) => {
      await this.initialize()
      const activity = this.capture(signal)
      if (command.sessionId !== this.operation.sessionId || command.messageId !== message.id) {
        throw new PlatformError(409, 'native_input_admission_identity')
      }
      const plan = planInboxCommand(this.detached(activity), this.agent.ctx.sessionProjections,
        { kind: 'admit', message, target: command.target, wakeup: true }, activity)
      const insertion = plan.events[0]
      if (insertion?.type !== 'agent/inbox/spliced') throw new PlatformError(409, 'native_input_admission_batch')
      const resolved = { ...command, target: insertion.data.target }
      const result = await this.commitExternal(activity, resolved, plan.events,
        (batch, publication) => this.transport.admit(resolved, this.authority, batch, publication, prepare))
      if (prepare) {
        if (!result.frame || result.frame.candidateOriginInputId !== resolved.originInputId
          || result.frame.messageId !== resolved.messageId) throw new PlatformError(502, 'native_input_frame_missing')
        this.prepare(result.frame)
      }
      this.agent.wakePending()
      return result.input
    }, { scope: 'inbox' })
  }

  /** Apply the official queue algorithm while the exact native prefix remains reserved.
   * @param credential Original browser bearer, retained only for the request lifetime.
   * @param command Original carrier nonce and native public queue payload.
   * @returns Immutable command receipt after the complete committed batch is mirrored.
   */
  async queue(credential: string, command: NativeInputQueueCommand): Promise<InputCommandReceipt> {
    const replay = await this.transport.queueReceipt(credential, command)
    if (replay) {
      const kind = command.payload.action.kind === 'steer' ? 'retarget' : command.payload.action.kind
      if (replay.kind !== kind || replay.sessionId !== this.operation.sessionId || replay.rpcNonce !== command.rpcNonce
        || replay.payloadDigest !== nativeInputRecordDigest(command) || replay.actor.kind !== 'browser'
        || replay.actor.userId !== this.operation.userId) throw new PlatformError(502, 'native_input_commit_receipt')
      return replay
    }
    return this.agent.runMaintenance(async (signal) => {
      await this.initialize()
      const activity = this.capture(signal), action = command.payload.action
      if (command.payload.sessionId !== this.operation.sessionId) throw new PlatformError(409, 'native_input_scope_conflict')
      const pending = action.kind === 'steer'
        ? { kind: 'retarget' as const, messageId: command.payload.itemId, target: 'next-step' as const, wakeup: true }
        : action.kind === 'edit'
          ? { kind: 'edit' as const, messageId: command.payload.itemId, content: action.content }
          : { kind: 'remove' as const, messageId: command.payload.itemId }
      const plan = planInboxCommand(this.detached(activity), this.agent.ctx.sessionProjections, pending, activity)
      if (!plan.found) throw new PlatformError(404, 'native_input_not_found')
      const result = await this.commitExternal(activity, command, plan.events,
        (batch, publication) => this.transport.queue(credential, command, this.authority, batch, publication))
      if (action.kind === 'steer') this.agent.wakePending()
      return result.input
    }, { scope: 'inbox' })
  }

  private assertOwner(): void {
    this.runtime.assertGrant(this.operation)
    this.runtime.publication(this.operation).assertOpen()
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    const publisher = this.runtime.publication(this.operation)
    publisher.heartbeat()
    await publisher.flush()
    this.assertOwner()
    this.initialized = true
  }

  private capture(signal: AbortSignal): InboxActivityCapture {
    this.assertOwner()
    const activity = this.agent.captureInboxActivity(signal)
    if (activity.cursor !== this.events.length) throw new PlatformError(409, 'native_input_observation_prefix')
    return activity
  }

  private detached(activity: InboxActivityCapture): Session {
    activity.assertCurrent()
    return Session.forPlanning(this.agent.session.id, this.events, this.agent.session.header, this.agent.session.inheritedEventCount,
      this.agent.ctx.sessions.messageProjections)
  }

  private publication(position: NativeInputPublicationPosition, events: readonly SessionEvent[]): NativeAssistantBatch {
    return nativeAssistantBatch.parse({ version: 1, batchId: randomUUID(), epoch: position.epoch,
      publisherId: position.publisherId, firstOrdinal: position.firstOrdinal,
      items: events.map(event => ({ type: 'event', event })) })
  }

  private verify(result: NativeInputCommitResult, position: NativeInputPublicationPosition, expected: number,
    events: readonly SessionEvent[], command: NativeInputAdmissionCommand | NativeInputClaimCommand | NativeInputQueueCommand): void {
    this.assertOwner()
    const receipt = result.presentation, input = result.input
    const kind = 'payload' in command ? command.payload.action.kind === 'steer' ? 'retarget' : command.payload.action.kind
      : 'cohortId' in command ? 'claim' : 'admission'
    const claimed = 'cohortId' in command
    const spliceSeqs = (claimed ? events.filter(event => event.type === 'agent/inbox/spliced') : events).map(event => event.seq)
    const payloadDigest = claimed ? nativeInputRecordDigest({ command, batch: { expectedEventCount: expected, events },
      operationDigest: createHash('sha256').update(this.authority.operationToken).digest('hex') }) : nativeInputRecordDigest(command)
    if (receipt.publisherId !== position.publisherId || receipt.epoch !== position.epoch
      || receipt.lastOrdinal !== position.firstOrdinal - 1 + events.length || receipt.revision !== position.revision
      || receipt.eventCount !== expected + events.length || input.eventCount !== receipt.eventCount
      || input.sessionId !== this.operation.sessionId || input.rpcNonce !== command.rpcNonce
      || input.kind !== kind || !isDeepStrictEqual(input.committedSpliceSeqs, spliceSeqs)
      || input.payloadDigest !== payloadDigest) throw new PlatformError(502, 'native_input_commit_receipt')
    if ('payload' in command) {
      if (input.actor.kind !== 'browser' || input.actor.userId !== this.operation.userId) {
        throw new PlatformError(502, 'native_input_commit_receipt')
      }
    } else if (input.actor.kind !== 'writer' || input.actor.workerId !== this.authority.writer.workerId
      || input.actor.writerEpoch !== this.authority.writer.epoch || input.actor.userId !== this.operation.userId) {
      throw new PlatformError(502, 'native_input_commit_receipt')
    }
  }

  private commitClaim(boundary: InboxClaimBoundary): Promise<void> {
    this.assertOwner()
    const frame = this.frame
    if (!frame || boundary.to !== this.events.length) throw new PlatformError(409, 'native_input_claim_prefix')
    const cohortId = inputCohortId.parse(randomUUID())
    const command: NativeInputClaimCommand = { cohortId, rpcNonce: `claim:${cohortId}`, frame,
      boundaryKind: boundary.target === 'next-turn' ? 'initial-turn-step' : 'continuing-step' }
    const publisher = this.runtime.publication(this.operation)
    return publisher.commitInput(boundary.from, boundary.events, boundary.events.length > 0, async (position) => {
      const result = await this.transport.claim(command, this.authority,
        { expectedEventCount: boundary.from, events: boundary.events }, this.publication(position, boundary.events))
      this.verify(result, position, boundary.from, boundary.events, command)
      if (result.input.result.kind !== 'claimed' || result.input.result.cohortId !== cohortId) {
        throw new PlatformError(502, 'native_input_commit_receipt')
      }
      this.cohort = { command, turn: boundary.turn, step: boundary.step }
      return { receipt: result.presentation, value: undefined }
    })
  }

  private commitExternal(activity: InboxActivityCapture,
    command: NativeInputAdmissionCommand | NativeInputQueueCommand, events: readonly SessionEvent[],
    commit: (batch: NativeInputDecodedBatch, publication: NativeAssistantBatch) => Promise<NativeInputCommitResult>,
  ): Promise<NativeInputCommitResult> {
    activity.assertCurrent()
    return this.runtime.publication(this.operation).commitInput(activity.cursor, events, false, async (position) => {
      activity.assertCurrent()
      const result = await commit({ expectedEventCount: activity.cursor, events }, this.publication(position, events))
      this.verify(result, position, activity.cursor, events, command)
      activity.synchronize(() => {
        this.runtime.synchronizeCommitted(this.operation, activity.cursor, events)
        this.agent.session.synchronizeCommitted(events)
        this.events.push(...structuredClone(events))
        return undefined
      })
      return { receipt: result.presentation, value: result }
    })
  }
}
