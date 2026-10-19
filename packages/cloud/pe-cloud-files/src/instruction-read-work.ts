/** One reserved instruction snapshot; private parents authorize metadata observation, never content readers. */
import { posix } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import { createReservedReadSession } from './reserved-read.ts'
import type { ReservedReadLimits } from './reserved-read.ts'
import { nativeReadFailure } from './read-only.ts'
import type { FixedRootReader } from './read-only.ts'
import type { FdWorkerClient } from './worker-client.ts'
import type { FdRootIdentity } from './worker-protocol.ts'
import type { ResidentResult } from './work-queue.ts'

/** Existing pool limits plus its explicit ceiling for this complete logical reservation. */
export interface InstructionReadWorkConfig extends ReservedReadLimits {
  readonly replyOverheadBytes: number
  readonly maxReservationBytes: number
}

/** The outer owner supplies its original lane reservation and one exclusive client. */
export type InstructionReadExecute = <T>(
  reservationBytes: number,
  work: (client: Pick<FdWorkerClient, 'stat' | 'directory' | 'stream'>, control: AbortSignal) => Promise<T>,
  signal: AbortSignal,
) => Promise<ResidentResult<T>>

/** Only independent source readers; no reader is ever issued for the private parent. */
export interface InstructionReadReaders {
  readonly project: FixedRootReader
  readonly account?: FixedRootReader
}

/** Trusted root observations and the complete result budget, fixed before admission. */
export interface InstructionReadWorkInput<T> {
  readonly projectRoot: FdRootIdentity
  /** Omission means no account preferences source; presence requires an actual measured mount id. */
  readonly privateParent?: FdRootIdentity & { readonly rootMountId: string }
  readonly requestedResidentBytes: number
  readonly config: InstructionReadWorkConfig
  readonly assertCurrent: () => void
  readonly signal: AbortSignal
  readonly execute: InstructionReadExecute
  readonly build: (readers: InstructionReadReaders, control: AbortSignal) => Promise<T>
}

/**
 * Observe optional account instructions and build one complete snapshot inside one existing reservation.
 * Only a confirmed missing directory is omitted. No platform source is installed by this operation.
 * @param input Original storage-owner roots, finite budgets, exclusive executor and snapshot consumer.
 * @returns The executor's original resident result; the consumer releases its whole reservation after use.
 * @throws Native failures without treating unavailable metadata as absence; concurrent build/cleanup failures retain both causes.
 */
export async function runInstructionReadWork<T>(input: InstructionReadWorkInput<T>): Promise<ResidentResult<T>> {
  const { requestedResidentBytes, assertCurrent, signal, execute, build } = input
  const config = Object.freeze({ ...input.config })
  const project = Object.freeze({ ...input.projectRoot })
  const parent = input.privateParent === undefined ? undefined : Object.freeze({ ...input.privateParent })
  const accountPath = parent === undefined ? undefined : posix.join(parent.rootPath, 'instructions')
  const roots = parent === undefined ? [project] : [project, parent]
  const paths = roots.reduce((total, root) => total + Buffer.byteLength(root.rootPath)
    + root.rootDevice.length + root.rootInode.length + (root.rootMountId?.length ?? 0), 0)
    + (accountPath === undefined ? 0 : Buffer.byteLength(accountPath))
  // Match the existing directory/stream transport copy bounds; sequential sources share the scratch.
  const reservation = requestedResidentBytes + 4 * paths + 12 * (config.maxPathBytes + 1)
    + 4 * (256 + 64) + 8 * (config.readChunkBytes + 4) + 4 * config.replyOverheadBytes
  if (!Number.isSafeInteger(requestedResidentBytes) || requestedResidentBytes <= 0
    || !Number.isSafeInteger(reservation) || reservation <= 0 || reservation > config.maxReservationBytes) {
    throw new FsError('The instruction snapshot exceeds its reservation limit.', 'FS_TOO_LARGE')
  }
  if (roots.some(root => Buffer.byteLength(root.rootPath) > config.maxPathBytes)
    || accountPath !== undefined && Buffer.byteLength(accountPath) > config.maxPathBytes) {
    throw new FsError('An instruction source path exceeds its limit.', 'FS_TOO_LARGE')
  }
  const current = (control: AbortSignal): void => {
    assertCurrent()
    if (signal.aborted || control.aborted) throw new FsError('Instruction read aborted.', 'FS_ABORTED')
  }
  current(signal)
  return execute(reservation, async (client, control) => {
    current(control)
    let account: FdRootIdentity | undefined
    if (parent !== undefined && accountPath !== undefined) {
      let metadata
      try { metadata = await client.stat(parent, 'instructions', control) }
      catch (error) { throw nativeReadFailure(error) }
      current(control)
      if (metadata !== undefined) {
        if (metadata.type !== 'directory') throw new FsError('Account instructions must be a directory.', 'FS_NOT_DIRECTORY')
        const observed = await client.directory(parent, 'instructions', config.maxPathBytes, control)
        current(control)
        if (!observed.directory || observed.anchorPath !== parent.rootPath || observed.canonicalPath !== accountPath) {
          throw new FsError('Account instructions are outside their independent source root.', 'FS_PERMISSION_DENIED')
        }
        const separator = metadata.identity.indexOf(':')
        // stat's wire parser owns the device:inode format. NO_XDEV keeps this child on the measured parent mount.
        account = Object.freeze({ rootPath: accountPath, rootDevice: metadata.identity.slice(0, separator),
          rootInode: metadata.identity.slice(separator + 1), rootMountId: parent.rootMountId })
      }
    }
    const session = createReservedReadSession(client, account === undefined ? [{ root: project }]
      : [{ root: project }, { root: account }], config, () => { current(control) }, control)
    // This invocation always supplies project first and at most one account source.
    const [projectReader, accountReader] = session.readers as readonly [FixedRootReader, FixedRootReader?]
    const readers: InstructionReadReaders = Object.freeze({ project: projectReader,
      ...accountReader === undefined ? {} : { account: accountReader } })
    let failure: unknown
    let failed = false
    try {
      const value = await build(readers, control)
      current(control)
      return value
    } catch (error) {
      failed = true
      failure = nativeReadFailure(error)
      throw failure
    } finally {
      try { await session.close() }
      catch (cleanup) {
        if (!failed) throw cleanup
        const cause = new AggregateError([failure, cleanup], 'Instruction snapshot and cleanup failed.')
        if (failure instanceof FsError) throw new FsError(failure.message, failure.code, { cause })
        throw cause
      }
      if (!failed) current(control)
    }
  }, signal)
}
