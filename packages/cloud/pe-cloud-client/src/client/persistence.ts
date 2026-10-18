/** Bounded page cache captured from one decoded bootstrap account and generation. */
import type { ClientPersistence } from '@deepseek-ai/dsh-client-store'
import type { RequestExpectation } from '@deepseek-ai/dsh-pe-cloud-access/types'

/** Explicit finite UTF-8 budgets; total includes the physical key and serialized envelope. */
export interface CloudPersistenceLimits {
  readonly maxKeys: number
  readonly maxKeyBytes: number
  readonly maxValueBytes: number
  readonly maxTotalBytes: number
  readonly maxNamespaceBytes: number
}

/** Owner-supplied browser storage; never replaced on window or Storage.prototype. */
export interface CloudPersistenceStorage {
  /**
   * @param key - physical key.
   * @returns the complete value or null.
   */
  getItem(key: string): string | null
  /**
   * @param key - physical key.
   * @param value - atomic replacement value.
   */
  setItem(key: string, value: string): void
  /** @param key - physical key to remove. */
  removeItem(key: string): void
}

/** Stable failure identities; messages contain no account or cached content. */
export type CloudPersistenceFailureCode =
  | 'invalid-limits' | 'budget-exceeded' | 'invalid-data' | 'storage-unavailable'
  | 'revoked' | 'active-cleanup' | 'cleanup-unconfirmed'

/** A failed operation seals its port; cleanup remains the page owner's responsibility. */
export class CloudPersistenceError extends Error {
  /**
   * @param code - machine-readable disposition.
   * @param cause - original storage/parser failure when present.
   */
  constructor(readonly code: CloudPersistenceFailureCode, cause?: unknown) {
    super(`Cloud page persistence: ${code}`, { cause })
    this.name = 'CloudPersistenceError'
  }
}

/** Local port and cleanup facts; no claim about server account drain or other pages. */
export interface CloudPersistenceSnapshot {
  readonly phase: 'active' | 'revoked' | 'failed'
  readonly cleanup: 'not-requested' | 'confirmed' | 'unconfirmed'
  readonly failure: CloudPersistenceFailureCode | undefined
}

/** Captured identity and limits; no mutable current-account resolver is accepted. */
export interface CloudPersistenceInput {
  readonly expectation: RequestExpectation
  readonly storage: CloudPersistenceStorage
  readonly limits: CloudPersistenceLimits
  /** Synchronous notification after sealing; the page owner stops dependent UI. */
  readonly onFailure?: (error: CloudPersistenceError) => void
}

/**
 * Own one collision-free namespace. Each mutation replaces one bounded envelope
 * atomically; same-generation concurrent pages use last-writer-wins snapshots.
 * Revocation is local to this issued port and does not rely on storage events.
 */
export class CloudPagePersistence {
  private readonly key: string
  private readonly keyBytes: number
  private readonly storage: CloudPersistenceStorage
  private readonly limits: Readonly<CloudPersistenceLimits>
  private readonly onFailure: CloudPersistenceInput['onFailure']
  private phase: CloudPersistenceSnapshot['phase'] = 'active'
  private cleanup: CloudPersistenceSnapshot['cleanup'] = 'not-requested'
  private failure: CloudPersistenceError | undefined
  /** Native consumers receive only logical I/O, without owner cleanup or rebinding authority. */
  readonly port: ClientPersistence

  /** @param input - validated bootstrap identity, browser storage and explicit finite limits. */
  constructor(input: CloudPersistenceInput) {
    for (const limit of [input.limits.maxKeys, input.limits.maxKeyBytes, input.limits.maxValueBytes,
      input.limits.maxTotalBytes, input.limits.maxNamespaceBytes]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new CloudPersistenceError('invalid-limits')
    }
    this.limits = Object.freeze({ ...input.limits })
    const { accountId, connectionGeneration } = input.expectation
    if (accountId === '' || connectionGeneration === ''
      || accountId.length + connectionGeneration.length > this.limits.maxNamespaceBytes) {
      throw new CloudPersistenceError('budget-exceeded')
    }
    this.key = `dsh.cloud.page.v1:${JSON.stringify([accountId, connectionGeneration])}`
    this.keyBytes = new TextEncoder().encode(this.key).byteLength
    if (this.keyBytes > this.limits.maxNamespaceBytes || this.keyBytes >= this.limits.maxTotalBytes) {
      throw new CloudPersistenceError('budget-exceeded')
    }
    this.storage = input.storage
    this.onFailure = input.onFailure
    this.port = Object.freeze({
      getItem: (key: string) => { this.assertActive(); this.checkKey(key); return this.read().get(key) ?? null },
      setItem: (key: string, value: string) => {
        this.assertActive()
        this.checkKey(key)
        this.bytes(value, this.limits.maxValueBytes)
        const entries = this.read()
        entries.set(key, value)
        this.write(entries)
      },
      removeItem: (key: string) => {
        this.assertActive()
        this.checkKey(key)
        const entries = this.read()
        if (entries.delete(key)) this.write(entries)
      },
      keys: () => { this.assertActive(); return [...this.read().keys()] },
    })
  }

  /**
   * Read port revocation and namespace cleanup state.
   * @returns the local disposition without identity or cached values.
   */
  getSnapshot(): CloudPersistenceSnapshot {
    return { phase: this.phase, cleanup: this.cleanup, failure: this.failure?.code }
  }

  /** Permanently revoke this port before stopping carriers, subscriptions or native stores. */
  revoke(): void {
    if (this.phase === 'active') this.phase = 'revoked'
  }

  /**
   * Remove and verify only this captured namespace, after the owner joins native cleanup.
   * Failed cleanup remains unconfirmed and can be explicitly retried on this owner.
   * @throws CloudPersistenceError if still active, storage fails, or removal is unconfirmed.
   */
  clear(): void {
    if (this.phase === 'active') throw new CloudPersistenceError('active-cleanup')
    this.cleanup = 'unconfirmed'
    try {
      this.storage.removeItem(this.key)
      if (this.storage.getItem(this.key) !== null) throw new CloudPersistenceError('cleanup-unconfirmed')
      this.cleanup = 'confirmed'
    } catch (cause) {
      throw this.seal('cleanup-unconfirmed', cause)
    }
  }

  private assertActive(): void {
    if (this.phase !== 'active') throw this.failure ?? new CloudPersistenceError('revoked')
  }

  private seal(code: CloudPersistenceFailureCode, cause?: unknown): CloudPersistenceError {
    const error = new CloudPersistenceError(code, cause)
    if (this.failure === undefined) {
      this.failure = error
      this.phase = 'failed'
      try { this.onFailure?.(error) } catch (reportError) {
        console.error('Cloud page persistence failure reporting failed:', reportError)
      }
    }
    return error
  }

  private bytes(value: string, limit: number): void {
    if (value.length > limit || new TextEncoder().encode(value).byteLength > limit) {
      throw this.seal('budget-exceeded')
    }
  }

  private checkKey(key: string): void { this.bytes(key, this.limits.maxKeyBytes) }

  private read(): Map<string, string> {
    let raw: string | null
    try { raw = this.storage.getItem(this.key) } catch (cause) {
      throw this.seal('storage-unavailable', cause)
    }
    if (raw === null) return new Map()
    this.bytes(raw, this.limits.maxTotalBytes - this.keyBytes)
    let value: unknown
    try { value = JSON.parse(raw) } catch (cause) { throw this.seal('invalid-data', cause) }
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
      || !('entries' in value) || !Array.isArray(value.entries)) throw this.seal('invalid-data')
    if (value.entries.length > this.limits.maxKeys) throw this.seal('budget-exceeded')
    const entries = new Map<string, string>()
    for (const entry of value.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
        || entries.has(entry[0])) throw this.seal('invalid-data')
      this.checkKey(entry[0])
      this.bytes(entry[1], this.limits.maxValueBytes)
      entries.set(entry[0], entry[1])
    }
    return entries
  }

  private write(entries: Map<string, string>): void {
    if (entries.size > this.limits.maxKeys) throw this.seal('budget-exceeded')
    const raw = JSON.stringify({ version: 1, entries: [...entries] })
    this.bytes(raw, this.limits.maxTotalBytes - this.keyBytes)
    try { this.storage.setItem(this.key, raw) } catch (cause) {
      throw this.seal('storage-unavailable', cause)
    }
  }
}
