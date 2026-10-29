/** One-shot cold session read through the handle-based persistence seam. */

import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset, SessionSeedEventState } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandleReadResult } from '@deepseek-ai/dsh-session-persistence'

/** An observation's cold read handle did not confirm its close. */
export class ColdSessionReadCleanupError extends AggregateError {
  override readonly name = 'ColdSessionReadCleanupError'

  /** @param closeError - actual handle close failure.
   * @param readFailure - any preceding read failure.
   */
  constructor(closeError: unknown, readFailure?: { readonly error: unknown }) {
    super(readFailure === undefined ? [closeError] : [readFailure.error, closeError],
      'Cold Session read handle cleanup failed', { cause: closeError })
  }
}

/** A stored session log balanced for read-only viewing. */
export interface ColdSessionLog {
  /** Aliasing state of the persisted events; synthetic closers are locally owned. */
  readonly eventState: SessionSeedEventState
  /** The stored header, fixed when the read handle opened. */
  readonly header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffset
  /** Stored events plus deterministic in-memory closers for an interrupted final turn; nothing is written back. */
  readonly events: SessionEvent[]
}

/**
 * Read one complete stored session log without taking ownership or mutating
 * storage: open a read handle, read the validated contiguous log, close the
 * handle, and append `interruptedTurnClosers` so a log whose writer crashed
 * mid-turn folds as a balanced transcript. Backend failures propagate
 * unmapped — each caller owns its error taxonomy.
 * @param persistence - the mounted persistence service.
 * @param sessionId - the stored session to read.
 * @param signal - optional cancellation for the open and read work.
 * @returns an adoptable seed in a caller-owned outer array, ready for in-place Session restoration.
 */
export async function readColdSessionLog(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<ColdSessionLog> {
  return readColdSessionLogActual(persistence, sessionId, signal, false)
}

/** Read for an observation that must retain failed handle cleanup. */
export async function readColdSessionLogForObservation(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<ColdSessionLog> {
  return readColdSessionLogActual(persistence, sessionId, signal, true)
}

async function readColdSessionLogActual(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal: AbortSignal | undefined,
  preserveCleanupFailure: boolean,
): Promise<ColdSessionLog> {
  const options = signal === undefined ? undefined : { signal }
  const handle = await persistence.open(sessionId, 'read', options)
  let read: SessionHandleReadResult
  try {
    read = await handle.read(0, undefined, options)
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch (closeError: unknown) {
      if (preserveCleanupFailure) throw new ColdSessionReadCleanupError(closeError, { error })
    }
    throw error
  }
  try { await handle.close() } catch (error: unknown) {
    if (preserveCleanupFailure) throw new ColdSessionReadCleanupError(error)
    throw error
  }
  const { events } = read
  return {
    eventState: read.eventState,
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events, ...interruptedTurnClosers(events)],
  }
}
