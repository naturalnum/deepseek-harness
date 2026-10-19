/** Trusted native-source bridge; one reserved batch and one borrowed worker own both sides to actual settlement. */
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FdRootIdentity, FdStageFile, FdStageResult, FdStagingLimits } from './worker-protocol.ts'
import { validStageName } from './worker-protocol.ts'
import { FdStageFailure } from './worker-client.ts'
import type { FdStageSink } from './worker-client.ts'

/** Only trusted account composition supplies this closure; no caller-provided iterator is admitted. */
export interface StageSource {
  readonly ref: FileAttachmentRef
  open(this: void, signal: AbortSignal): AsyncIterable<Uint8Array>
}

/** Cold-ref collection may be deferred until the original positive reservation is actually running. */
export type StageSources = readonly StageSource[] | (() => readonly StageSource[])

/** Native reference beside its verified project copy; metadata alone grants no authority. */
export interface StageFileResult extends FdStageResult {
  readonly ref: FileAttachmentRef
  readonly relativePath: string
}

/** Earlier closed publications survive a later batch failure; they are never represented as rolled back. */
export class StageBatchFailure extends FdStageFailure {
  constructor(failure: FdStageFailure, readonly completed: readonly StageFileResult[]) {
    super(failure.outcome, failure.code, failure.facts, { cause: failure })
  }
}

/** Complete positive reservation and copied, bounded input descriptors fixed before queue admission. */
export interface StageBatchPlan {
  readonly reservationBytes: number
  readonly modeledBytes: number
  readonly overheadAllowanceBytes: number
  readonly files: readonly { readonly source: StageSource; readonly file: FdStageFile; readonly relativePath: string }[]
}

/** Validate every field before optional staging is enabled; there are no inferred deployment capacities. */
export function validateStagingLimits(limits: FdStagingLimits, pathLimit: number, chunkBytes: number): void {
  if (typeof limits.helperPath !== 'string' || !limits.helperPath.startsWith('/') || !limits.helperPath.endsWith('.node')
    || limits.helperPath.includes('\0') || Buffer.byteLength(limits.helperPath) > pathLimit
    || [limits.maxFileBytes, limits.maxBatchRefs, limits.maxBatchBytes,
      limits.maxSourceChunkBytes, limits.operationTimeoutMs, limits.reservationBytes]
      .some(value => !Number.isSafeInteger(value) || value < 1)
    || limits.operationTimeoutMs > 2_147_483_647 || limits.maxSourceChunkBytes > 2_147_483_647
    || chunkBytes > limits.maxFileBytes || chunkBytes > limits.maxSourceChunkBytes) {
    throw new FdStageFailure('not-published', 'FS_PERMISSION_DENIED')
  }
}

/**
 * Bound input, all copies, retained results and abort scratch before a source or sink is opened.
 * @param sources Authorized native refs and fixed original-provider closures.
 * @param root Original project anchor; mount identity is mandatory for staging.
 * @param limits Explicit staging capacities.
 * @param bounds Original path/chunk/reply/lane capacities.
 * @returns Frozen copied descriptors and one complete positive batch reservation.
 */
export function planStageBatch(
  sources: readonly StageSource[], root: Pick<FdRootIdentity, 'rootPath' | 'rootMountId'>, limits: FdStagingLimits,
  bounds: {
    readonly maxPathBytes: number
    readonly readChunkBytes: number
    readonly replyOverheadBytes: number
    readonly maxResidentBytesPerLane: number
  },
): StageBatchPlan {
  validateStagingLimits(limits, bounds.maxPathBytes, bounds.readChunkBytes)
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > limits.maxBatchRefs
    || sources.length * 2048 > bounds.maxResidentBytesPerLane || root.rootMountId === undefined
    || Buffer.byteLength(root.rootPath) > bounds.maxPathBytes) throw new FdStageFailure('not-published', 'FS_TOO_LARGE')
  let total = 0, strings = 2 * bounds.maxPathBytes
  const files = sources.map((source: StageSource) => {
    const { ref } = source
    const match = /^sha256:([a-f0-9]{64})$/.exec(String(ref.attachmentId))
    const digest = match?.[1]
    if (digest === undefined || typeof ref.name !== 'string' || !validStageName(ref.name) || typeof source.open !== 'function') {
      throw new FdStageFailure('not-published', 'FS_PERMISSION_DENIED')
    }
    total += ref.bytes
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > limits.maxFileBytes
      || !Number.isSafeInteger(total) || total > limits.maxBatchBytes) throw new FdStageFailure('not-published', 'FS_TOO_LARGE')
    const relativePath = `.pe/attachments/${digest}/${ref.name}`
    if (Buffer.byteLength(`${root.rootPath}/${relativePath}`) > bounds.maxPathBytes) throw new FdStageFailure('not-published', 'FS_TOO_LARGE')
    const copied = Object.freeze({ attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes })
    const file = Object.freeze({ digest, name: ref.name, expectedBytes: ref.bytes })
    // Input/output metadata must fit their complete frame ceiling, including bounded native facts.
    if (Buffer.byteLength(JSON.stringify({ file, relativePath, ref: copied })) + 1024 > bounds.replyOverheadBytes) {
      throw new FdStageFailure('not-published', 'FS_TOO_LARGE')
    }
    strings += Buffer.byteLength(digest) + Buffer.byteLength(ref.name) + Buffer.byteLength(relativePath)
    return Object.freeze({ source: Object.freeze({ ref: copied, open: source.open }), file, relativePath })
  })
  const modeledBytes = 3 * limits.maxSourceChunkBytes + 2 * bounds.readChunkBytes + 12 * (bounds.maxPathBytes + 1)
    + 8 * strings + 8 * files.length * bounds.replyOverheadBytes + bounds.replyOverheadBytes
  const reservationBytes = limits.reservationBytes
  if (!Number.isSafeInteger(modeledBytes) || modeledBytes >= reservationBytes || reservationBytes > bounds.maxResidentBytesPerLane) {
    throw new FdStageFailure('not-published', 'FS_TOO_LARGE')
  }
  return Object.freeze({ reservationBytes, modeledBytes,
    overheadAllowanceBytes: reservationBytes - modeledBytes, files: Object.freeze(files) })
}

/** The original client owns all transport state; this face cannot create another lane or worker. */
export interface StageTransport {
  beginStage(root: FdRootIdentity, file: FdStageFile, chunkBytes: number, signal: AbortSignal): FdStageSink
}

/**
 * Sequentially consume native sources under one existing mutation reservation and slot.
 * @param transport Original borrowed worker client.
 * @param root Original selected project anchor.
 * @param plan Already admitted complete batch.
 * @param limits Explicit source capacity and actual transaction deadline.
 * @param chunkBytes Original worker chunk bound; every transfer owns an exact backing buffer.
 * @param current Captured provider/account/Workspace guard.
 * @param signal Original actual work signal, separate from the observer.
 * @returns Complete closed publication facts; failures join both sides before rejecting.
 */
export async function executeStageBatch(
  transport: StageTransport, root: FdRootIdentity, plan: StageBatchPlan, limits: FdStagingLimits,
  chunkBytes: number, current: () => void, signal: AbortSignal,
): Promise<readonly StageFileResult[]> {
  const results: StageFileResult[] = []
  for (const entry of plan.files) {
    try {
      current()
      if (signal.aborted) throw signal.reason
    } catch (error) {
      throw new StageBatchFailure(new FdStageFailure('not-published', signal.aborted ? 'FS_ABORTED' : 'FS_PERMISSION_DENIED', undefined,
        { cause: error }), Object.freeze([...results]))
    }
    const sourceControl = new AbortController()
    const actualSignal = AbortSignal.any([sourceControl.signal, signal])
    let sink: FdStageSink
    try { sink = transport.beginStage(root, entry.file, chunkBytes, actualSignal) } catch (error) {
      throw new StageBatchFailure(error instanceof FdStageFailure ? error : new FdStageFailure('unknown', 'FS_IO_ERROR', undefined,
        { cause: error }), Object.freeze([...results]))
    }
    // A failed/closed worker must also stop a source currently waiting inside next().
    void sink.settled.catch((error: unknown) => { sourceControl.abort(error) })
    const timer = setTimeout(() => {
      sink.abort()
      sourceControl.abort(new FdStageFailure('not-published', 'FS_ABORTED'))
    }, limits.operationTimeoutMs)
    let iterator: AsyncIterator<Uint8Array> | undefined
    try {
      const mode = await sink.ready
      if (mode === 'write') {
        current()
        iterator = entry.source.open(actualSignal)[Symbol.asyncIterator]()
        let total = 0
        while (true) {
          current()
          actualSignal.throwIfAborted()
          const next = await iterator.next()
          current()
          actualSignal.throwIfAborted()
          if (next.done === true) break
          const bytes = next.value
          if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength < 1
            || bytes.byteLength > limits.maxSourceChunkBytes || bytes.buffer.byteLength > limits.maxSourceChunkBytes
            || total + bytes.byteLength > entry.file.expectedBytes) throw new FdStageFailure('not-published', 'FS_TOO_LARGE')
          total += bytes.byteLength
          for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
            current()
            actualSignal.throwIfAborted()
            const frame = new Uint8Array(Math.min(chunkBytes, bytes.byteLength - offset))
            frame.set(bytes.subarray(offset, offset + frame.byteLength))
            await sink.write(frame)
          }
        }
        if (total !== entry.file.expectedBytes) throw new FdStageFailure('not-published', 'FS_IO_ERROR')
        // Worker6's native iterator done includes actual source close and final integrity verification.
        await sink.finishSource()
      }
      const result = await sink.settled
      results.push(Object.freeze({ ...result, ref: entry.source.ref, relativePath: entry.relativePath }))
    } catch (error) {
      const cancelled = actualSignal.aborted
      // Request sink cleanup before waiting on a possibly blocked native source return.
      sink.abort()
      sourceControl.abort(error)
      const sourceClosed = iterator?.return === undefined ? Promise.resolve() : iterator.return()
      const [source, destination] = await Promise.allSettled([sourceClosed, sink.settled])
      if (source.status === 'rejected' || destination.status === 'rejected'
        && (!(destination.reason instanceof FdStageFailure) || destination.reason.outcome === 'unknown')) {
        throw new StageBatchFailure(new FdStageFailure('unknown', 'FS_IO_ERROR', destination.status === 'rejected'
          && destination.reason instanceof FdStageFailure ? destination.reason.facts : undefined,
        { cause: error }), Object.freeze([...results]))
      }
      if (destination.status === 'fulfilled') {
        // A closed durable result stays committed even if observation cancellation arrives afterwards.
        results.push(Object.freeze({ ...destination.value, ref: entry.source.ref, relativePath: entry.relativePath }))
        if (results.length === plan.files.length) return Object.freeze(results)
      }
      const failure = error instanceof FdStageFailure ? error : new FdStageFailure('not-published',
        cancelled ? 'FS_ABORTED' : 'FS_IO_ERROR', destination.status === 'rejected'
          && destination.reason instanceof FdStageFailure ? destination.reason.facts : undefined, { cause: error })
      throw new StageBatchFailure(failure, Object.freeze([...results]))
    } finally { clearTimeout(timer) }
  }
  return Object.freeze(results)
}
