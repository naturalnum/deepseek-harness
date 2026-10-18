/** Bounded pg connections and observation, separate from the store's account/epoch authority. */
import { Client, defaults, type ClientConfig } from 'pg'
import { AccountRuntimeError } from './errors.ts'
import { OwnerPgNotSubmittedError } from './owner-pg-errors.ts'
import type { OwnerPgExecutor } from './owner-types.ts'

/** Explicit root-owned connection configuration; no ambient credential or database selection. */
export interface OwnerPgConnection {
  readonly host: string
  readonly port: number
  readonly user: string
  /** Resolve again for each actual connection; a fixed value remains available to direct component consumers. */
  readonly password: string | (() => Promise<string>)
  readonly database: string
  readonly ssl: NonNullable<ClientConfig['ssl']>
}

/** Finite deployment budgets; queue slots and observer records own no account state. */
export interface OwnerPgLimits {
  readonly maxConnections: number
  readonly maxQueued: number
  readonly queueTimeoutMs: number
  readonly connectionTimeoutMs: number
  readonly statementTimeoutMs: number
  readonly lockTimeoutMs: number
  readonly maxObservedOperations: number
  readonly maxObservers: number
}

/** Waiting results never replace or cancel the actual operation Promise. */
export type OwnerPgObservation =
  | Readonly<{ status: 'settled'; outcome: 'fulfilled' | 'rejected' }>
  | Readonly<{ status: 'pending'; reason: 'deadline' | 'observer-cancelled' }>

type Rows = Awaited<ReturnType<OwnerPgExecutor['query']>>
interface Work {
  readonly text: string
  readonly values: (string | null)[]
  readonly result: PromiseWithResolvers<Rows>
  phase: 'queued' | 'connecting' | 'querying' | 'closing'
  timer?: ReturnType<typeof setTimeout>
  client?: Client
}
interface Observed {
  readonly waiters: Set<(outcome: 'fulfilled' | 'rejected') => void>
}

const MAX_DELAY = 2_147_483_647

function validate(connection: OwnerPgConnection, limits: OwnerPgLimits): void {
  if ([connection.host, connection.user, connection.database].some(value => value.length === 0)
    || !Number.isSafeInteger(connection.port) || connection.port < 1 || connection.port > 65535) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Owner database connection fields must be explicit')
  }
  for (const value of [limits.maxConnections, limits.maxObservedOperations, limits.maxObservers]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new AccountRuntimeError('cloud/invalid-config', 'Owner database capacities must be positive finite integers')
  }
  if (!Number.isSafeInteger(limits.maxQueued) || limits.maxQueued < 0) {
    throw new AccountRuntimeError('cloud/invalid-config', 'Owner database queue capacity must be a finite nonnegative integer')
  }
  for (const value of [limits.queueTimeoutMs, limits.connectionTimeoutMs, limits.statementTimeoutMs, limits.lockTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DELAY) throw new AccountRuntimeError('cloud/invalid-config', 'Owner database time budgets must be positive finite timer values')
  }
}

/**
 * One SQL statement per connection, with no hidden pg pool or connection reuse.
 * SQL and parameters are store-owned; this is not a general database SDK.
 */
export class PgOwnerExecutor implements OwnerPgExecutor {
  private readonly connection: OwnerPgConnection
  private readonly limits: OwnerPgLimits
  private readonly queue: Work[] = []
  private readonly running = new Set<Work>()
  private readonly observed = new Map<Promise<unknown>, Observed>()
  private readonly closed = Promise.withResolvers<undefined>()
  private observers = 0
  private closing = false

  /**
   * @param connection Root-selected target and TLS policy, never a client-selected connection string.
   * @param limits Explicit finite connection, queue, execution and observation budgets.
   */
  constructor(connection: OwnerPgConnection, limits: OwnerPgLimits) {
    validate(connection, limits)
    this.connection = Object.freeze({ ...connection })
    this.limits = Object.freeze({ ...limits })
  }

  /**
   * Submit fixed owner SQL; retain its connection until driver settlement and actual end.
   * query_timeout is disabled. An observation deadline never rejects this Promise.
   * @param text Store-owned single statement, including the atomic migration DO block.
   * @param values Bound text/null parameters, copied before queue admission.
   * @returns Actual SQL result after its connection ends; submitted failures remain unknown to the store.
   */
  query(text: string, values: readonly (string | null)[]): Promise<Rows> {
    if (this.closing) return Promise.reject(new OwnerPgNotSubmittedError('cloud/account-unavailable', 'Owner database admission is closed before SQL submission'))
    if (this.running.size >= this.limits.maxConnections && this.queue.length >= this.limits.maxQueued) {
      return Promise.reject(new OwnerPgNotSubmittedError('cloud/capacity', 'Owner database queue capacity is exhausted before SQL submission'))
    }
    const work: Work = { text, values: [...values], result: Promise.withResolvers<Rows>(), phase: 'queued' }
    // Resource ownership observes rejection even when the external waiting observer has left.
    void work.result.promise.catch((_cause: unknown) => {})
    if (this.running.size < this.limits.maxConnections) this.start(work)
    else {
      this.queue.push(work)
      work.timer = setTimeout(() => {
        const index = this.queue.indexOf(work)
        if (index === -1) return
        this.queue.splice(index, 1)
        work.result.reject(new OwnerPgNotSubmittedError('cloud/capacity', 'Owner database queue deadline expired before SQL submission'))
      }, this.limits.queueTimeoutMs)
    }
    return work.result.promise
  }

  /**
   * Observe the caller-retained actual Promise without cancelling SQL or releasing its slot.
   * One settlement subscription per actual Promise prevents expired waits accumulating callbacks.
   * @param actual Exact actual operation, such as the store's coalesced claim Promise.
   * @param deadlineAtMs Finite absolute server deadline.
   * @param signal Optional cancellation of this observer only.
   * @returns Settled classification or a pending observation; actual values/errors remain on actual.
   */
  observe(actual: Promise<unknown>, deadlineAtMs: number, signal?: AbortSignal): Promise<OwnerPgObservation> {
    const remaining = deadlineAtMs - Date.now()
    if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 0 || remaining > MAX_DELAY) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Owner database observation requires a finite absolute deadline')
    }
    const stopped = signal?.aborted ? 'observer-cancelled' : remaining <= 0 ? 'deadline' : undefined
    if (stopped === undefined && this.observers >= this.limits.maxObservers) {
      throw new AccountRuntimeError('cloud/capacity', 'Owner database observer capacity is exhausted')
    }
    let record = this.observed.get(actual)
    if (record === undefined) {
      if (this.observed.size >= this.limits.maxObservedOperations) throw new AccountRuntimeError('cloud/capacity', 'Owner database actual-observation capacity is exhausted')
      record = { waiters: new Set() }
      this.observed.set(actual, record)
      const retained = record
      const settle = (outcome: 'fulfilled' | 'rejected'): void => {
        this.observed.delete(actual)
        for (const waiter of retained.waiters) waiter(outcome)
        retained.waiters.clear()
      }
      void actual.then(() => { settle('fulfilled') }, () => { settle('rejected') })
    }
    if (stopped !== undefined) return Promise.resolve({ status: 'pending', reason: stopped })
    const retained = record
    const result = Promise.withResolvers<OwnerPgObservation>()
    this.observers++
    const finish = (observation: OwnerPgObservation): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      retained.waiters.delete(settled)
      this.observers--
      result.resolve(observation)
    }
    const settled = (outcome: 'fulfilled' | 'rejected'): void => { finish({ status: 'settled', outcome }) }
    const aborted = (): void => { finish({ status: 'pending', reason: 'observer-cancelled' }) }
    const timer = setTimeout(() => { finish({ status: 'pending', reason: 'deadline' }) }, remaining)
    retained.waiters.add(settled)
    signal?.addEventListener('abort', aborted, { once: true })
    return result.promise
  }

  /**
   * Close admission and reject never-submitted queued SQL; actual work keeps its connection.
   * @returns The same actual close Promise until every started driver connection has ended.
   */
  close(): Promise<void> {
    this.closing = true
    for (const work of this.queue.splice(0)) {
      clearTimeout(work.timer)
      work.result.reject(new OwnerPgNotSubmittedError('cloud/account-unavailable', 'Owner database closed before queued SQL submission'))
    }
    if (this.running.size === 0) this.closed.resolve(undefined)
    return this.closed.promise
  }

  /**
   * Report retained connection and observer resources.
   * @returns Bounded counts without SQL, parameters, targets or credentials.
   */
  inspect(): Readonly<{
    connections: number
    querying: number
    queued: number
    observedOperations: number
    observers: number
    closing: boolean
  }> {
    return Object.freeze({
      connections: this.running.size, querying: [...this.running].filter(work => work.phase === 'querying').length,
      queued: this.queue.length, observedOperations: this.observed.size, observers: this.observers, closing: this.closing,
    })
  }

  private start(work: Work): void {
    clearTimeout(work.timer)
    work.phase = 'connecting'
    this.running.add(work)
    // An unexpected cleanup defect retains the slot/client rather than reporting connection release.
    void this.run(work).catch((cause: unknown) => { work.result.reject(cause) })
  }

  private async run(work: Work): Promise<void> {
    let submitted = false
    let result: Rows | undefined
    let failure: { cause: unknown } | undefined
    try {
      // pg resolves zero through its shared defaults; never inherit an early callback timer.
      if (defaults.query_timeout) {
        throw new OwnerPgNotSubmittedError('cloud/account-unavailable', 'Owner database requires pg client query timeout to stay disabled')
      }
      const password = this.connection.password
      const client = new Client({
        host: this.connection.host,
        port: this.connection.port,
        user: this.connection.user,
        database: this.connection.database,
        ssl: this.connection.ssl,
        password: typeof password === 'string' ? () => password : password,
        connectionTimeoutMillis: this.limits.connectionTimeoutMs,
        query_timeout: 0,
        statement_timeout: this.limits.statementTimeoutMs,
        lock_timeout: this.limits.lockTimeoutMs,
        options: `-c statement_timeout=${this.limits.statementTimeoutMs} -c lock_timeout=${this.limits.lockTimeoutMs}`,
      })
      work.client = client
      // connect/query carry their original errors; the listener contains additional socket error events.
      client.on('error', (_cause: unknown) => {})
      await client.connect()
      if (this.closing) throw new OwnerPgNotSubmittedError('cloud/account-unavailable', 'Owner database closed before connected SQL submission')
      work.phase = 'querying'
      submitted = true
      result = await client.query<Record<string, unknown>>({ text: work.text, values: work.values })
    } catch (cause) {
      failure = { cause: submitted || cause instanceof OwnerPgNotSubmittedError ? cause
        : new OwnerPgNotSubmittedError('cloud/account-unavailable', 'Owner database connection failed before SQL submission', { cause }) }
    }
    work.phase = 'closing'
    await work.client?.end()
    this.running.delete(work)
    if (failure !== undefined) work.result.reject(failure.cause)
    else if (result !== undefined) work.result.resolve(result)
    else work.result.reject(new AccountRuntimeError('cloud/account-unavailable', 'Owner database returned no actual result'))
    while (!this.closing && this.running.size < this.limits.maxConnections) {
      const next = this.queue.shift()
      if (next === undefined) break
      this.start(next)
    }
    if (this.closing && this.running.size === 0) this.closed.resolve(undefined)
  }
}
