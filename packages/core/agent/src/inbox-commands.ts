/** Shared native pending-input commands; storage and activity belong to the driver.
 * @module @deepseek-ai/dsh-agent/inbox-commands
 */
import type { MessageId, TextBlock } from '@deepseek-ai/dsh-llm'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionLogOffset, UserMessage } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Inbox } from './runtime-types.ts'
import type { InboxTarget } from './types.ts'

/** Pending mutation preserving native message identity, role and source. */
export type PendingInputCommand =
  | { readonly kind: 'edit'; readonly messageId: MessageId; readonly content: readonly TextBlock[] }
  | { readonly kind: 'remove'; readonly messageId: MessageId }
  | { readonly kind: 'retarget'; readonly messageId: MessageId; readonly target: InboxTarget; readonly wakeup: boolean }

/** Native activity captured under the exact Agent maintenance signal. */
export interface InboxActivityCapture {
  /** Exact live Session captured by the native maintenance owner. */
  readonly sessionId: SessionId
  /** Full authoritative prefix length at capture. */
  readonly cursor: SessionLogOffset
  /** Phase protected by the caller's exact maintenance signal. */
  readonly phase: 'maintenance' | 'running'
  /** Exact running position; absent for whole-agent maintenance. */
  readonly position?: { readonly turn: number; readonly step: number }
  /** Cancellation state used by the shared send target resolver. */
  readonly aborted: boolean
  /** Reject after phase retirement, cancellation change or any live log append. */
  assertCurrent(): void
  /**
   * Synchronize an already committed canonical batch while retaining the native
   * append reservation. Cancellation does not erase a committed receipt; the
   * owner/prefix must still match. This callback grants no external authority.
   * @param operation - synchronous committed mirror update, returning undefined.
   */
  synchronize(operation: () => undefined): void
}

/** Complete proposed step claim, before prompt assembly or live claimed notifications. */
export interface InboxClaimBoundary {
  /** Native boundary that determines whether one next-turn head joins the claim. */
  readonly target: InboxTarget
  /** Open turn owning the complete claim. */
  readonly turn: number
  /** Proposed step; step/start has not been appended. */
  readonly step: number
  /** Cursor immediately before the first claim splice. */
  readonly from: SessionLogOffset
  /** Cursor immediately after the complete claim. */
  readonly to: SessionLogOffset
  /** Deeply frozen native input, all next-step items before any next-turn head. */
  readonly messages: readonly UserMessage[]
  /** Exact immutable canonical append results in native order. */
  readonly events: readonly Extract<SessionEvent, { type: 'agent/inbox/spliced' }>[]
  /** Live cancellation signal; listeners finish cleanup before settling. */
  readonly signal: AbortSignal
}

/**
 * Resolve the same target as Agent.send before an insertion can notify observers.
 * @param target - requested queue.
 * @param wakeup - whether the input wakes activity.
 * @param activeAborted - native activity cancellation captured by the driver.
 * @returns actual queue used for this insertion.
 */
export function resolveInboxTarget(target: InboxTarget, wakeup: boolean, activeAborted: boolean): InboxTarget {
  return wakeup && activeAborted ? 'next-turn' : target
}

/**
 * Apply the controller's pending mutation through the native Inbox implementation.
 * Edits replace all content; retargeting cancels the occurrence before admission.
 * @param inbox - native pending-input store.
 * @param command - mutation of one still-pending identity.
 * @param send - driver admission, retaining its native target resolution and wake semantics.
 * @returns original pending message, or undefined when already removed or claimed.
 */
export function updatePendingInput(
  inbox: Inbox, command: PendingInputCommand,
  send: (message: UserMessage, target: InboxTarget, wakeup: boolean) => void,
): UserMessage | undefined {
  const message = inbox.nextTurn.find(item => item.id === command.messageId)
    ?? inbox.nextStep.find(item => item.id === command.messageId)
  if (message === undefined) return undefined
  switch (command.kind) {
    case 'edit':
      inbox.replace(command.messageId, freezeMessage<UserMessage>({ ...message, content: [...command.content] }))
      break
    case 'remove':
      inbox.remove(command.messageId)
      break
    case 'retarget':
      inbox.remove(command.messageId)
      send(message, command.target, command.wakeup)
      break
    /* v8 ignore next 2 -- closed PendingInputCommand exhaustiveness guard */
    default:
      assertNever(command)
  }
  return message
}
