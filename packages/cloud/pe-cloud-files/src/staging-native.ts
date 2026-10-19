/** Private worker-only staging ABI1 adapter; it grants no account, ref, path or Loader authority. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { isMainThread } from 'node:worker_threads'

/** Every bound is supplied by the admitting worker; none is a deployment default. */
export interface StagingInput {
  readonly rootPath: string
  readonly device: string
  readonly inode: string
  readonly mountId: string
  readonly digest: string
  readonly name: string
  readonly expectedBytes: number
  readonly maxBytes: number
  readonly maxChunkBytes: number
  readonly maxPathBytes: number
  readonly timeoutMs: number
  readonly cancel: Int32Array<SharedArrayBuffer>
}

/**
 * Independent native sink facts; unknown remains owned even when all known FDs closed.
 * Clean settles only owned sink FDs/temporary cleanup, never the source or budget.
 * Retained created directories are persistent storage facts whose inode charge remains with the storage owner.
 */
export interface StagingFacts {
  readonly kind: 'write' | 'written' | 'existing' | 'existing-chunk' | 'published' | 'reused' | 'aborted' | 'failed' | 'unknown'
  readonly code: string
  readonly publication: 'none' | 'published' | 'unknown'
  readonly closed: boolean
  readonly clean: boolean
  readonly temporaryPresent: boolean
  readonly writtenBytes: number
  readonly readBytes: number
  readonly sequence: number
  readonly retainedCreatedDirectories: number
}

/** Worker-owned error retains the native cleanup/publication facts instead of converting unknown into rejection-as-clean. */
export class StagingFailure extends Error {
  constructor(readonly reason: string, readonly facts: StagingFacts, options?: ErrorOptions) {
    super(reason, options)
  }
}

interface Companion {
  readonly stagingAbiVersion: 1
  begin(input: StagingInput): unknown
  write(handle: object, sequence: number, bytes: Uint8Array): unknown
  readExisting(handle: object, sequence: number, scratch: Uint8Array<ArrayBuffer>): unknown
  finalize(handle: object): unknown
  abort(handle: object): unknown
}

/**
 * Original worker's closure over this operation's internal source-completion promise.
 * The main native-stream bridge may send this operation's dedicated source-complete message only after
 * its authorized native iterator genuinely returned done without error AND its actual source FD close settled.
 * The worker correlates that one message to this same transaction; it never substitutes a generic verified flag.
 * The promise rejects incomplete, extra-byte, trailing-error, cancellation and unknown-close outcomes.
 * This callback stays in the worker; the source stream stays in its original main bridge.
 */
export type WorkerSourceCompletion = () => Promise<void>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFacts(value: unknown): value is StagingFacts {
  return record(value) && typeof value.kind === 'string'
    && ['write', 'written', 'existing', 'existing-chunk', 'published', 'reused', 'aborted', 'failed', 'unknown'].includes(value.kind)
    && typeof value.code === 'string' && typeof value.publication === 'string'
    && ['none', 'published', 'unknown'].includes(value.publication)
    && !['closed', 'clean', 'temporaryPresent'].some(key => typeof value[key] !== 'boolean')
    && !['writtenBytes', 'readBytes', 'sequence', 'retainedCreatedDirectories'].some(key =>
      typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0)
    && !(value.clean && !value.closed) && !(value.kind === 'unknown' && value.clean)
}

function facts(value: unknown): StagingFacts {
  if (!isFacts(value)) {
    throw new Error('Invalid private staging ABI1 reply; settlement is unknown')
  }
  return value
}

function isCompanion(value: unknown): value is Companion {
  return record(value) && value.stagingAbiVersion === 1
    && ['begin', 'write', 'readExisting', 'finalize', 'abort'].every(key => typeof value[key] === 'function')
}

function checkedInput(input: StagingInput): StagingInput {
  if (!isAbsolute(input.rootPath) || !/^[a-f0-9]{64}$/u.test(input.digest)
    || [input.device, input.inode, input.mountId].some(value => !/^(?:0|[1-9][0-9]{0,19})$/u.test(value))
    || BigInt(input.mountId) === 0n || typeof input.name !== 'string'
    || !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 0 || input.expectedBytes > input.maxBytes
    || [input.maxBytes, input.maxChunkBytes, input.maxPathBytes, input.timeoutMs].some(value => !Number.isSafeInteger(value) || value < 1)
    || input.maxChunkBytes > input.maxBytes || input.maxChunkBytes > 2_147_483_647
    || input.maxPathBytes > 16384 || input.timeoutMs > 2_147_483_647
    || !(input.cancel instanceof Int32Array) || !(input.cancel.buffer instanceof SharedArrayBuffer)
    || input.cancel.length !== 1 || input.cancel.byteOffset !== 0 || input.cancel.buffer.byteLength !== 4) {
    throw new Error('Invalid explicit staging input')
  }
  return { ...input }
}

/**
 * Load the separately reviewed companion asset inside an already borrowed worker.
 * This adapter never creates a worker, queue, account owner, path grant or source stream.
 * @param asset Absolute staging ABI1 asset selected by Root, independent of ABI6/7/8.
 * @returns One worker-private transaction factory; native code also enforces one active transaction per environment.
 */
export function loadStagingNative(asset: string): {
  begin(input: StagingInput, sourceCompletion: WorkerSourceCompletion): StagingTransaction
} {
  if (isMainThread || !isAbsolute(asset) || !asset.endsWith('.node')) throw new Error('Staging companion requires the original worker and an explicit asset')
  const native: unknown = createRequire(import.meta.url)(asset)
  if (!isCompanion(native)) {
    throw new Error('Staging ABI1 companion required')
  }
  const companion = native
  return {
    begin(input, sourceCompletion) {
      if (typeof sourceCompletion !== 'function') throw new Error('Worker-owned source completion capability required')
      const bounded = checkedInput(input)
      const result = companion.begin(bounded)
      const receipt = facts(result)
      if (receipt.kind !== 'write' && receipt.kind !== 'existing') throw new StagingFailure(receipt.code, receipt)
      if (!record(result) || !record(result.handle)) throw new Error('Missing private staging handle; settlement is unknown')
      return new StagingTransaction(companion, result.handle, bounded, sourceCompletion, receipt)
    },
  }
}

/** One transaction's write/read/hash/cleanup state, retained by its original worker until actual settlement. */
export class StagingTransaction {
  private hash = createHash('sha256')
  private sequence = 0
  private total = 0
  private eof = false
  private finalizing = false
  private sourceSettled = false
  private receipt: StagingFacts
  private existingScratch: Uint8Array<ArrayBuffer> | undefined

  /** Constructed only by the worker-private factory after native begin succeeds. */
  constructor(
    private readonly native: Companion,
    private readonly handle: object,
    private readonly input: StagingInput,
    private readonly sourceCompletion: WorkerSourceCompletion,
    receipt: StagingFacts,
  ) {
    this.receipt = receipt
  }

  /** Current native mode/facts; an existing result requires full readExisting EOF/hash verification. */
  get state(): StagingFacts { return this.receipt }

  private active(kind: 'write' | 'existing'): void {
    if (this.finalizing || this.receipt.closed || this.receipt.kind !== kind) throw new Error('Staging transaction is not in the required phase')
  }

  private settled(): boolean {
    return this.receipt.closed || this.receipt.kind === 'unknown' || this.receipt.kind === 'failed'
  }

  private accept(value: unknown): StagingFacts {
    const result = facts(value)
    this.receipt = result
    if (result.kind === 'failed' || result.kind === 'unknown') throw new StagingFailure(result.code, result)
    return result
  }

  private reject(reason: string): never {
    const receipt = this.abort()
    throw new StagingFailure(reason, receipt)
  }

  /**
   * Accept one bounded chunk; return is its sole credit ACK, after every short write settled.
   * Bytes and SHA-256 are independently accumulated here, never supplied by the main thread.
   * @param bytes Actual bytes delivered by this worker's bounded original-source bridge.
   * @returns Native write/FD facts after the complete chunk was written.
   */
  write(bytes: Uint8Array): StagingFacts {
    this.active('write')
    if (!(bytes instanceof Uint8Array) || bytes.buffer instanceof SharedArrayBuffer
      || bytes.byteLength < 1 || bytes.byteLength > this.input.maxChunkBytes
      || this.total + bytes.byteLength > this.input.expectedBytes) return this.reject('SOURCE_SIZE_EXCEEDED')
    const result = this.accept(this.native.write(this.handle, this.sequence, bytes))
    if (result.kind !== 'written' || result.writtenBytes !== this.total + bytes.byteLength || result.sequence !== this.sequence + 1) {
      return this.reject('SINK_ACK_MISMATCH')
    }
    this.hash.update(bytes)
    this.total += bytes.byteLength
    this.sequence++
    this.receipt = { ...result, kind: 'write' }
    return result
  }

  /**
   * Read one bounded chunk from the existing FD. Only a real zero-length read establishes EOF.
   * One reusable worker buffer is filled by native code and hashed here without a per-read native/Buffer copy.
   * @returns Actual bytes and EOF; the view expires at the next read and must not be retained or transferred.
   */
  readExisting(): { readonly bytes: Uint8Array; readonly eof: boolean } {
    this.active('existing')
    if (this.eof) throw new Error('Existing copy already reached actual EOF')
    const scratch = this.existingScratch ??= new Uint8Array(this.input.maxChunkBytes)
    const value = this.native.readExisting(this.handle, this.sequence, scratch)
    const result = this.accept(value)
    if (!record(value) || typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength)
      || value.byteLength < 0 || value.byteLength > scratch.length || typeof value.eof !== 'boolean'
      || result.readBytes !== this.total + value.byteLength || result.sequence !== this.sequence + 1
      || value.eof !== (value.byteLength === 0)) return this.reject('EXISTING_ACK_MISMATCH')
    const bytes = scratch.subarray(0, value.byteLength)
    this.hash.update(bytes)
    this.total += bytes.byteLength
    this.sequence++
    this.eof = value.eof
    this.receipt = { ...result, kind: 'existing' }
    return { bytes, eof: this.eof }
  }

  /**
   * Validate this worker's size/hash and original-source completion, then ask native code to settle.
   * A publication EEXIST returns existing, resets the hash and requires complete reread plus another finalize.
   * No boolean, claimed hash, main-thread completion message or source byte count is accepted here.
   * @returns Published/reused only after all native FDs closed, or existing requiring complete reread.
   */
  async finalize(): Promise<StagingFacts> {
    const mode = this.receipt.kind
    if (this.finalizing || this.receipt.closed || (mode !== 'write' && mode !== 'existing')) throw new Error('Staging transaction cannot finalize')
    if (this.total !== this.input.expectedBytes || (mode === 'existing' && !this.eof)) return this.reject('INCOMPLETE_BYTES_OR_EOF')
    if (this.hash.digest('hex') !== this.input.digest) return this.reject('CONTENT_HASH_MISMATCH')
    this.finalizing = true
    try {
      if (mode === 'write' && !this.sourceSettled) {
        await this.sourceCompletion()
        this.sourceSettled = true
      }
      if (this.settled()) throw new StagingFailure('ABORTED_WHILE_SOURCE_SETTLING', this.receipt)
      const result = this.accept(this.native.finalize(this.handle))
      if (result.kind === 'existing') {
        this.hash = createHash('sha256'); this.sequence = 0; this.total = 0; this.eof = false
      } else if ((result.kind !== 'published' && result.kind !== 'reused') || !result.closed || !result.clean) {
        throw new StagingFailure('FINAL_SETTLEMENT_UNKNOWN', result)
      }
      return result
    } catch (error) {
      if (error instanceof StagingFailure && this.settled()) throw error
      const receipt = this.abort()
      throw new StagingFailure('SOURCE_OR_NATIVE_FINALIZE_FAILED', receipt, { cause: error })
    } finally {
      this.finalizing = false
    }
  }

  /**
   * Remove only this transaction's temporary identity and eligible empty created directories; close every owned FD.
   * Unknown cleanup/close/publication stays unknown and poisons further native begin calls in this environment.
   * Source iteration/FD closure is a separate worker obligation; abort here never settles that source or its budget.
   * @returns Actual native settlement facts; calling after settlement preserves those same facts.
   */
  abort(): StagingFacts {
    if (this.receipt.closed || this.receipt.kind === 'unknown' || this.receipt.kind === 'failed') return this.receipt
    this.receipt = facts(this.native.abort(this.handle))
    return this.receipt
  }
}
