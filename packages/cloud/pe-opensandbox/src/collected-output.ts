/** Private byte-tail storage; process, scope admission and stop observation remain with its execution owner. */
import type { SubprocessCollect, SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/** Local collection failures; none establishes that a remote process or scope has stopped. */
export type CollectedOutputFailureReason = 'observed-byte-limit' | 'scope-released' | 'output-after-seal' | 'spill-unavailable' | 'invalid-snapshot'

const failures = {
  'observed-byte-limit': { code: 'cloud/capacity', message: 'Collected output exceeded its observed-byte budget; the execution owner must stop and observe its range.' },
  'scope-released': { code: 'cloud/stale-generation', message: 'The collected output scope has been released.' },
  'output-after-seal': { code: 'cloud/execution-unavailable', message: 'Output arrived after collection was sealed; the execution owner must reconcile the stream.' },
  'spill-unavailable': { code: 'cloud/execution-unavailable', message: 'Collected output spill requires an approved project storage capability.' },
  'invalid-snapshot': { code: 'cloud/execution-unavailable', message: 'Collected output snapshot changed an observed byte or stream coordinate.' },
} as const

/** Typed refusal retaining byte counts without command data, paths or a fabricated stop result. */
export class CollectedOutputFailure extends Error {
  /** Stable public error code selected by the collection failure reason; it carries no stop confirmation. */
  readonly code: typeof failures[CollectedOutputFailureReason]['code']

  /**
   * @param reason - collection failure independently handled by the future execution owner.
   * @param acceptedBytes - stream bytes accepted before this failure.
   * @param rejectedChunkBytes - bytes in the refused chunk; zero for a non-ingestion refusal.
   * @param maxObservedBytes - configured whole-stream budget.
   */
  constructor(
    readonly reason: CollectedOutputFailureReason,
    readonly acceptedBytes: number,
    readonly rejectedChunkBytes: number,
    readonly maxObservedBytes: number,
  ) {
    super(failures[reason].message)
    this.name = 'CollectedOutputFailure'
    this.code = failures[reason].code
  }
}

interface LiveStorage {
  state: 'open' | 'sealed'
  readonly bytes: Buffer
}

/**
 * One bounded tail-only native reader. Bytes are copied on ingestion; no caller buffer is retained.
 * The owner reserves storage before construction and budgets returned text/snapshot copies separately.
 * An ingestion failure is terminal and retains storage until explicit scope release. There is no spill,
 * cancellation listener, process handle or implicit release on seal/consumer completion.
 */
export class CollectedOutputMirror implements SubprocessOutputReader {
  private storage: LiveStorage | { readonly state: 'released'; readonly failure: CollectedOutputFailure }
  private readonly maxTailBytes: number
  private readonly maxObservedBytes: number
  private accepted = 0
  private retainedFrom = 0
  private ingestionFailure: CollectedOutputFailure | undefined

  /**
   * @param collect - native tail-only configuration; spill requests reject before allocation.
   * @param maxObservedBytes - finite positive whole-stream byte budget, at least the tail capacity.
   * @throws RangeError for unrepresentable limits; CollectedOutputFailure for ungranted spill.
   */
  constructor(collect: SubprocessCollect, maxObservedBytes: number) {
    if (!Number.isSafeInteger(collect.maxBytes) || collect.maxBytes < 1
      || !Number.isSafeInteger(maxObservedBytes) || maxObservedBytes < collect.maxBytes) {
      throw new RangeError('Collection requires positive safe byte limits with observed bytes at least the tail capacity.')
    }
    if (collect.spill !== undefined) throw new CollectedOutputFailure('spill-unavailable', 0, 0, maxObservedBytes)
    this.maxTailBytes = collect.maxBytes
    this.maxObservedBytes = maxObservedBytes
    this.storage = { state: 'open', bytes: Buffer.alloc(this.maxTailBytes) }
  }

  /** Actual retained storage reservation; returned text and snapshots belong to their caller's budget. */
  get residentBytes(): number { return this.storage.state === 'released' ? 0 : this.storage.bytes.byteLength }

  /** Bytes accepted before any failed chunk; a budget failure never advances the byte coordinate. */
  get acceptedBytes(): number { return this.accepted }

  /** First ingestion failure, retained through seal and release for the owner's error accounting. */
  get failure(): CollectedOutputFailure | undefined { return this.ingestionFailure }

  /**
   * Accept a whole raw chunk or fail before changing storage/offsets. Empty chunks retain no references.
   * After failure no native read can report incomplete output as a successful collection.
   * @param chunk - raw output bytes, including a Uint8Array view into a larger caller buffer.
   * @throws CollectedOutputFailure on released/sealed collection or an exceeded byte budget;
   * the owner retains process and memory responsibility until actual scope termination.
   */
  push(chunk: Uint8Array): void {
    const storage = this.readableStorage()
    if (this.storage.state === 'sealed') this.fail('output-after-seal', chunk.byteLength)
    if (chunk.byteLength > this.maxObservedBytes - this.accepted) this.fail('observed-byte-limit', chunk.byteLength)
    if (chunk.byteLength === 0) return
    const tail = chunk.subarray(Math.max(0, chunk.byteLength - this.maxTailBytes))
    const start = (this.accepted + chunk.byteLength - tail.byteLength) % this.maxTailBytes
    const first = Math.min(tail.byteLength, this.maxTailBytes - start)
    storage.set(tail.subarray(0, first), start)
    storage.set(tail.subarray(first), 0)
    this.accepted += chunk.byteLength
  }

  /**
   * Replace the available tail from one authenticated remote full-tail snapshot.
   * @param bytes Current raw tail, whose first byte is totalBytes minus its length; never a decoded string.
   * @param totalBytes Whole-stream coordinate, including upstream bytes already evicted before this observer read.
   * @throws CollectedOutputFailure on retreating coordinates, rewritten overlap, quota overflow or closed collection.
   */
  replaceTail(bytes: Uint8Array, totalBytes: number): void {
    const storage = this.readableStorage()
    if (this.storage.state === 'sealed') this.fail('output-after-seal', bytes.byteLength)
    if (!Number.isSafeInteger(totalBytes) || totalBytes < this.accepted || bytes.byteLength > totalBytes) {
      this.fail('invalid-snapshot', bytes.byteLength)
    }
    if (totalBytes > this.maxObservedBytes) this.fail('observed-byte-limit', bytes.byteLength)
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - this.maxTailBytes))
    const start = totalBytes - tail.byteLength
    const overlap = Math.max(start, this.retainedFrom, this.accepted - this.maxTailBytes)
    if (overlap < this.accepted
      && !this.copyBytes(overlap).equals(tail.subarray(overlap - start, this.accepted - start))) {
      this.fail('invalid-snapshot', bytes.byteLength)
    }
    const position = start % this.maxTailBytes
    const first = Math.min(tail.byteLength, this.maxTailBytes - position)
    storage.fill(0)
    storage.set(tail.subarray(0, first), position)
    storage.set(tail.subarray(first), 0)
    this.accepted = totalBytes
    this.retainedFrom = start
  }

  /**
   * Read a native text projection without consuming another reader's position.
   * UTF-8 decoding applies only to this slice: invalid or partial code points can render U+FFFD;
   * nextOffset always counts original bytes, never re-encoded text. Use snapshot for raw bytes.
   * @param fromByte - nonnegative safe whole-stream offset, no greater than acceptedBytes.
   * @returns current delta/tail and byte coordinate; no spillPath is ever advertised.
   * @throws RangeError for an invalid coordinate; CollectedOutputFailure after ingestion failure or release.
   */
  readFrom(fromByte: number): SubprocessOutputRead {
    this.readableStorage()
    if (!Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > this.accepted) {
      throw new RangeError('Collection offset must be a nonnegative safe byte coordinate within the observed stream.')
    }
    const start = Math.max(this.retainedFrom, this.accepted - this.maxTailBytes)
    const lossy = fromByte < start
    const bytes = this.copyBytes(Math.max(fromByte, start))
    return { text: bytes.toString('utf8'), nextOffset: this.accepted, lossy }
  }

  /**
   * Copy the exact retained bytes, including partial or invalid UTF-8. The caller owns the copy.
   * @returns raw tail and whole-stream byte count; the tail starts at totalBytes minus bytes.length.
   * @throws CollectedOutputFailure after ingestion failure or actual scope release.
   */
  snapshot(): { bytes: Uint8Array; totalBytes: number } {
    this.readableStorage()
    return { bytes: this.copyBytes(Math.max(this.retainedFrom, this.accepted - this.maxTailBytes)), totalBytes: this.accepted }
  }

  /**
   * Record collection EOF without releasing output or clearing a prior ingestion failure.
   * Repeated seal is harmless; this observes neither process exit nor managed-range quiescence.
   */
  seal(): void {
    this.liveStorage().state = 'sealed'
  }

  /**
   * Wipe and release only this storage after its execution owner has actually ended the owning scope.
   * Observer cancellation, process done or a request deadline must not call this on their own.
   * Repeated release is harmless; all later reads/ingestion reject and prior failure facts remain.
   */
  release(): void {
    if (this.storage.state === 'released') return
    const releasedFailure = new CollectedOutputFailure('scope-released', this.accepted, 0, this.maxObservedBytes)
    this.storage.bytes.fill(0)
    this.storage = { state: 'released', failure: releasedFailure }
  }

  private copyBytes(fromByte: number): Buffer {
    const storage = this.readableStorage()
    const length = this.accepted - fromByte
    const result = Buffer.allocUnsafe(length)
    const start = fromByte % this.maxTailBytes
    const first = Math.min(length, this.maxTailBytes - start)
    storage.copy(result, 0, start, start + first)
    storage.copy(result, first, 0, length - first)
    return result
  }

  private readableStorage(): Buffer {
    const storage = this.liveStorage()
    if (this.ingestionFailure !== undefined) throw this.ingestionFailure
    return storage.bytes
  }

  private liveStorage(): LiveStorage {
    if (this.storage.state === 'released') throw this.storage.failure
    return this.storage
  }

  private fail(reason: 'observed-byte-limit' | 'output-after-seal' | 'invalid-snapshot', rejectedChunkBytes: number): never {
    this.ingestionFailure = new CollectedOutputFailure(reason, this.accepted, rejectedChunkBytes, this.maxObservedBytes)
    throw this.ingestionFailure
  }
}
