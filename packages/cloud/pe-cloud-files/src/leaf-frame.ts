/** Fixed ABI5 leaf facts; only validated actual completion can end temporary creation responsibility. */
import type { FdRootIdentity } from './worker-protocol.ts'
import type { DirectoryCreatedIdentity, DirectoryPrepareOutcome } from './directory-responsibility.ts'

/** Bounded syscall metadata; no supplied paths, stacks or arbitrary error messages. */
export interface LeafFailureDetails { readonly errno: number; readonly phase: number }

/** A failed business preparation remains distinct from its actual creation fact. */
export class DirectoryPreparationFailure extends Error {
  constructor(readonly fact: 'not-created' | 'created-known' | 'unknown', readonly details: LeafFailureDetails) {
    super('Directory preparation failed.', { cause: Object.freeze({ ...details }) })
  }
}

/** Parsed fixed frame, after closure and parent/identity consistency checks. */
export interface LeafFrame {
  readonly tag: number
  readonly flags: number
  readonly failure: LeafFailureDetails
  readonly identity?: DirectoryCreatedIdentity
}

/**
 * Validate one exact-backed fixed frame without accepting a partial or pooled buffer.
 * @param value Raw helper/worker result.
 * @param operation Expected prepare or cleanup operation.
 * @param parent Fixed expected parent identity.
 * @param expected Exact created identity, required for cleanup success.
 * @returns Parsed bounded facts, or undefined for a fatal protocol failure.
 */
export function parseLeafFrame(
  value: unknown, operation: 1 | 2, parent: FdRootIdentity, expected?: DirectoryCreatedIdentity,
): LeafFrame | undefined {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)
    || value.byteLength !== 64 || value.byteOffset !== 0 || value.buffer.byteLength !== 64) return undefined
  const view = new DataView(value.buffer)
  if (view.getUint32(0, false) !== 0x44534635 || value[4] !== 1 || value[5] !== operation
    || value.subarray(52).some(byte => byte !== 0)) return undefined
  const tag = view.getUint8(6)
  const phase = view.getUint8(7)
  const errno = view.getUint32(8, true)
  const flags = view.getUint32(12, true)
  const mkdirErrno = view.getUint32(48, true)
  if (phase > 8 || errno > 4095 || mkdirErrno > 4095 || flags > 127 || (flags & 32) === 0) return undefined
  if ((flags & 64) !== 0) {
    if (view.getBigUint64(32, true).toString() !== BigInt(parent.rootDevice).toString()
      || view.getBigUint64(40, true).toString() !== BigInt(parent.rootInode).toString()) return undefined
  } else if (view.getBigUint64(32, true) !== 0n || view.getBigUint64(40, true) !== 0n) return undefined
  const identity = (flags & 4) === 0 ? undefined : Object.freeze({
    device: view.getBigUint64(16, true).toString(), inode: view.getBigUint64(24, true).toString(),
  })
  if (identity !== undefined && (flags & 64) === 0) return undefined
  if (identity === undefined && (view.getBigUint64(16, true) !== 0n || view.getBigUint64(24, true) !== 0n)) return undefined
  if ((flags & 2) !== 0 && (flags & 1) === 0) return undefined
  if (((flags & 1) === 0 || (flags & 2) !== 0) && mkdirErrno !== 0) return undefined
  if ((flags & 16) !== 0 && (flags & 8) === 0) return undefined
  if (operation === 1) {
    if (tag < 1 || tag > 5 || (flags & 24) !== 0) return undefined
    if ((tag === 1 || tag === 2) !== (errno === 0)) return undefined
    if ((tag === 1 || tag === 2) && phase !== 5) return undefined
    if (tag === 1 && ((flags & 6) !== 0 || (flags & 64) === 0)) return undefined
    if ((tag === 2 || tag === 4) && ((flags & 67) !== 67 || identity === undefined)) return undefined
    if (tag === 4 && phase !== 4 && phase !== 5) return undefined
    if (tag === 3 && ((flags & 6) !== 0
      || ((flags & 1) !== 0 && (![3, 4, 5].includes(phase)
        || ![1, 13, 17, 20, 22, 28, 30, 36, 122].includes(mkdirErrno)))
      || ((flags & 1) === 0 && (phase === 3 || phase === 6 || phase === 7)))) return undefined
    if (tag === 5 && (identity !== undefined || (flags & 1) === 0 || (phase !== 3 && phase !== 4))) return undefined
  } else {
    if ((tag !== 6 && tag !== 7) || (flags & 3) !== 0 || phase === 3 || (tag === 6) !== (errno === 0)) return undefined
    if (tag === 6 && ((flags & 92) !== 92 || identity === undefined || expected === undefined
      || phase !== 5 || identity.device !== expected.device || identity.inode !== expected.inode)) return undefined
  }
  return { tag, flags, failure: Object.freeze({ errno, phase }), ...identity === undefined ? {} : { identity } }
}

/**
 * Convert validated prepare facts into independent business/ownership outcomes.
 * @param frame Validated prepare frame.
 * @returns A real existing/created result or a typed failing creation fact.
 */
export function leafPreparation(frame: LeafFrame): DirectoryPrepareOutcome {
  if (frame.tag === 1) return { kind: 'unchanged' }
  if (frame.tag === 2 && frame.identity !== undefined) return { kind: 'created', identity: frame.identity }
  if (frame.tag === 3) return { kind: 'not-created-failure', failure: frame.failure }
  // An observed inode does not restore a namespace window whose post-create verification failed.
  // Only cancellation after the fully verified CREATED frame may retain private cleanup eligibility.
  return { kind: 'created-unknown-failure', failure: frame.failure }
}

/**
 * Represent cancellation known to precede any helper invocation.
 * @param operation Expected worker operation.
 * @returns Exact closed-FD failure frame; cleanup remains unknown rather than clean.
 */
export function cancelledLeafFrame(operation: 1 | 2): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(64)
  const view = new DataView(frame.buffer)
  view.setUint32(0, 0x44534635, false)
  frame[4] = 1; frame[5] = operation; frame[6] = operation === 1 ? 3 : 7; frame[7] = 8
  view.setUint32(8, 125, true)
  view.setUint32(12, 32, true)
  return frame
}
