/** Secret-free data-carrier failures; physical cleanup authority remains with Root. */
import type { OperationRef, Route } from './types.ts'

/** Local validation or admission refusal; no remote execution outcome is implied. */
export class LocalRefusal extends Error {
  /**
   * Create a secret-free local refusal.
   * @param code - Stable local validation or admission classification.
   */
  constructor(readonly code: string) { super(code); this.name = 'LocalRefusal' } }
/** Uncertain remote control outcome carrying only the original route/reference and no raw transport error. */
export class ControlUncertain extends Error {
  /**
   * Retain the identity required to query or stop the original operation without replay.
   * @param route - Fixed route whose response could not be trusted.
   * @param ref - Original operation reference, absent for allocation-wide reads or seal.
   */
  constructor(readonly route: Route, readonly ref?: OperationRef) { super('agent control outcome uncertain; retain original operation reference'); this.name = 'ControlUncertain' }
}
/** Authenticated bound HTTP refusal which does not prove absence of remote execution. */
export class RemoteRefusal extends Error {
  /** A refusal is never evidence that a remote range is empty. */
  readonly remoteStateProvenEmpty = false
  /**
   * Record a bounded HTTP refusal without retaining arbitrary response text.
   * @param status - Bound agent HTTP status.
   * @param code - Sanitized local classification rather than the remote body text.
   */
  constructor(readonly status: number, readonly code: string) { super('bound agent refusal; no execution-absence proof'); this.name = 'RemoteRefusal' }
}
