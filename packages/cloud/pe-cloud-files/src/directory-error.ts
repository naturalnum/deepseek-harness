/** Private directory observations distinguish confirmed target facts from unavailable operations. */

/** A missing target and a non-directory ancestor are the only deterministic failure classes. */
export type DirectoryFailureReason = 'missing' | 'not-directory' | 'unavailable'
/** Failure location prevents a missing anchor from masquerading as a missing target. */
export type DirectoryFailurePhase = 'input' | 'admission' | 'anchor' | 'target' | 'verify' | 'transport'

/** Internal backend failure; the complete native Workspace adapter is intentionally not installed. */
export class DirectoryMetadataFailure extends Error {
  /** Confirmed target fact, or inability to complete the operation. */
  readonly reason: DirectoryFailureReason
  /** Stage that owns the failure. */
  readonly phase: DirectoryFailurePhase
  /** Bounded native errno when the worker supplied one. */
  readonly syscallCode: string | undefined

  /**
   * Preserve the backend cause without exposing private paths in the message.
   * @param reason Confirmed target failure or operation unavailability.
   * @param phase Failed parser, scheduler, transport, or kernel stage.
   * @param options Original cause and optional bounded syscall code.
   */
  constructor(reason: DirectoryFailureReason, phase: DirectoryFailurePhase, options?: ErrorOptions & { syscallCode?: string }) {
    super(`Directory metadata ${reason}.`, options)
    this.reason = reason
    this.phase = phase
    this.syscallCode = options?.syscallCode
  }
}
