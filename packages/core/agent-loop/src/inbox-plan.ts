/** Detached canonical input planning over an official Session and projection registry.
 * @module @deepseek-ai/dsh-agent-loop/inbox-plan
 */
import type { InboxActivityCapture, InboxTarget, PendingInputCommand } from '@deepseek-ai/dsh-agent'
import { resolveInboxTarget, updatePendingInput } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ReactLoopInbox } from './inbox.ts'

/** An admission or pending mutation; phase-sensitive insertions require a native capture. */
export type InboxPlanCommand = PendingInputCommand
  | { readonly kind: 'admit'; readonly message: UserMessage; readonly target: InboxTarget; readonly wakeup: boolean }
  | { readonly kind: 'claim'; readonly target: InboxTarget; readonly turn: number }

/**
 * Generate canonical events with the same Inbox algorithm as the live Agent.
 * The supplied Session must be detached and its exact Inbox projection active.
 * Capture validation precedes mutation; callers recheck it before external commit.
 * No live notification or driver wake is emitted. This does not publish a plan,
 * import it into a live Session, or authorize database/execution ownership.
 * @param session - disposable detached Session carrying the authoritative prefix.
 * @param projections - registry with inboxProjectionDefinition registered.
 * @param command - one canonical mutation or complete claim.
 * @param activity - protected native capture required for admission and retarget.
 * @returns appended events, complete claimed messages and whether input was found.
 */
export function planInboxCommand(
  session: Session, projections: SessionProjectionRegistry, command: InboxPlanCommand,
  activity?: InboxActivityCapture,
): { readonly events: readonly SessionEvent[]; readonly messages: readonly UserMessage[]; readonly found: boolean } {
  if (command.kind === 'admit' || command.kind === 'retarget') {
    if (activity === undefined || activity.sessionId !== session.id || activity.cursor !== session.seq) {
      throw new Error('Phase-sensitive Inbox planning requires an exact native activity capture')
    }
    activity.assertCurrent()
  }
  const events: SessionEvent[] = []
  const inbox = new ReactLoopInbox(projections, session, undefined, (event) => { events.push(event) })
  // Session append results are the source of truth; no deprecated event reads.
  {
    if (command.kind === 'claim') {
      const batch = inbox.claimBatch(command.target)
      return Object.freeze({ events: Object.freeze([...batch.events]), messages: Object.freeze(batch.messages), found: true })
    }
    const send = (message: UserMessage, target: InboxTarget, wakeup: boolean): void => {
      /* v8 ignore next -- admission and retarget validate capture before creating send; other commands never invoke it */
      if (activity === undefined) throw new Error('Missing native activity capture')
      inbox.append(resolveInboxTarget(target, wakeup, activity.aborted), message)
    }
    const found = command.kind === 'admit'
      ? (send(command.message, command.target, command.wakeup), true)
      : updatePendingInput(inbox, command, send) !== undefined
    return Object.freeze({ events: Object.freeze(events), messages: Object.freeze([]), found })
  }
}
