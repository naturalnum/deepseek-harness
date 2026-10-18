/** Private single-leaf accounting; valid names and layout addresses do not issue storage authority. */
import { posix } from 'node:path'
import type { FdRootIdentity } from './worker-protocol.ts'
import { FilesFailure } from './error.ts'

/** Trusted preparation input, not a capability issuer or a client naming API. */
export interface DirectoryIntent {
  readonly parent: FdRootIdentity
  readonly leaf: string
}

/** Existing deployment bounds used to reserve preparation and future cleanup buffers. */
export interface DirectoryBudgetLimits {
  readonly maxPathBytes: number
  readonly replyOverheadBytes: number
}

/** Retained responsibility includes one complete cleanup scratch reservation. */
export interface DirectoryWorkBudget {
  readonly responsibilityBytes: number
  readonly ioBytes: number
  readonly totalBytes: number
}

function capacity(): never {
  throw new FilesFailure('cloud/capacity', 'directory reservation exceeds finite byte limits')
}

/**
 * Reserve intent copies, four identities, fixed records, bounded outcomes, one observer and cleanup scratch.
 * The backend must obey these bounds; arbitrary callbacks are not allocation-limited by the queue.
 * @param intent Fixed parent and server-selected default or UUID leaf; no authority is inferred here.
 * @param limits Existing path and reply limits; arithmetic rejects before any backend dispatch.
 * @returns Positive safe reservations for retained responsibility and independently settled preparation I/O.
 */
export function directoryWorkBudget(intent: DirectoryIntent, limits: DirectoryBudgetLimits): DirectoryWorkBudget {
  const { maxPathBytes: pathLimit, replyOverheadBytes: overhead } = limits
  if (!Number.isSafeInteger(pathLimit) || pathLimit < 1 || pathLimit > 16384
    || !Number.isSafeInteger(overhead) || overhead < 1) capacity()
  const { rootPath, rootDevice, rootInode, rootMountId } = intent.parent
  if (rootPath.length > pathLimit || intent.leaf.length > 36 || rootDevice.length > 20 || rootInode.length > 20) {
    throw new FilesFailure('files/prerequisite-missing', 'directory intent exceeds its character bounds')
  }
  const parentBytes = Buffer.byteLength(rootPath)
  const leafBytes = Buffer.byteLength(intent.leaf)
  const serverLeaf = intent.leaf === 'default-workspace'
    || /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(intent.leaf)
  if (!posix.isAbsolute(rootPath) || rootPath.includes('\0') || rootPath.split('/').includes('..')
    || !/^\d{1,20}$/.test(rootDevice) || !/^\d{1,20}$/.test(rootInode)
    || (rootMountId !== undefined && !/^[1-9]\d{0,19}$/.test(rootMountId))
    || !serverLeaf || parentBytes + leafBytes + (rootPath === '/' ? 0 : 1) > pathLimit) {
    throw new FilesFailure('files/prerequisite-missing', 'directory intent requires a bounded parent and server-selected leaf')
  }
  // Two UTF-16 copies of parent/leaf, separators and optional mount id, independent of Latin-1 optimization.
  const intentBytes = 4 * (parentBytes + leafBytes + 2 + (rootMountId?.length ?? 0))
  // Four 20-digit device/inode fields, with two UTF-16 copies and bounded framing.
  const identityBytes = 4 * 4 * 20 + 128
  const recordBytes = 2048 // Responsibility, controls and one queue-entry/object allowance.
  const observerBytes = 1024 // One pending observer, timer, abort listener and fixed completion state.
  const frameBytes = 64
  const nativeScratchBytes = 2048 // stat/statfs/statx, bounded arguments and nested identity verification calls.
  const outcomeBytes = 4 * overhead + 256 + 2 * frameBytes // Fixed facts; no retained raw error or stack.
  // Four native path buffers, raw/UTF-16/clone peaks, one I/O record, input and reply copies.
  const ioBytes = 12 * (pathLimit + 1) + intentBytes + 4 * overhead + 2048 + 4 * frameBytes + nativeScratchBytes
  const responsibilityBytes = intentBytes + identityBytes + recordBytes + observerBytes + outcomeBytes + ioBytes
  const totalBytes = responsibilityBytes + ioBytes
  if (![ioBytes, responsibilityBytes, totalBytes].every(value => Number.isSafeInteger(value) && value > 0)) capacity()
  return Object.freeze({ responsibilityBytes, ioBytes, totalBytes })
}
