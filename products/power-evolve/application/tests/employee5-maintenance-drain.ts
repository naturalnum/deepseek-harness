/** Owned maintenance fixture cleanup; acquisition stays fenced after any failed confirmation. */
import { Pool, type PoolClient } from 'pg'
import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

type Backend = { pid: number; started: string; application: string; database: string; user: string }

/** One 25-second cleanup deadline, with synchronous acquisition cancellation and retained interruption owners.
 * @param parent Actual caller cancellation.
 * @param fence Permanently records a cleanup failure in the owning test module.
 */
export class MaintenanceDrain {
  readonly signal: AbortSignal
  readonly issues: Array<{ stage: string; error: unknown }> = []
  private readonly stop = new AbortController()
  private readonly stoppers = new Set<() => void>()
  private readonly killers = new Set<() => void>()
  private expires = 0
  private timer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(parent: AbortSignal, private readonly fence: (error: unknown) => void) {
    this.signal = AbortSignal.any([parent, this.stop.signal])
    this.signal.addEventListener('abort', () => { this.begin(); this.interrupt(this.stoppers) }, { once: true })
    if (this.signal.aborted) this.begin()
  }

  /** Stop acquisitions and start the aggregate cleanup deadline exactly once. */
  begin(): void {
    this.clock()
    this.stop.abort()
  }

  private clock(): void {
    if (this.expires) return
    this.expires = performance.now() + 25000
    this.timer = setTimeout(() => {
      this.issue('cleanup deadline', new Error('Maintenance cleanup exceeded 25000 ms'))
      this.stop.abort()
      this.interrupt(this.killers)
    }, 25000)
  }

  /** Retain interruption actions until every required resource has been confirmed absent.
   * @param stop Requests ordinary cancellation.
   * @param kill Forces owned work to stop when a cleanup bound expires.
   */
  register(stop: () => void, kill: () => void): void {
    this.stoppers.add(stop); this.killers.add(kill)
    if (this.signal.aborted) this.interrupt(new Set([stop]))
  }

  /** Preserve a failure; later completion never removes this fence.
   * @param stage Cleanup operation.
   * @param error Original cause.
   */
  issue(stage: string, error: unknown): void { this.issues.push({ stage, error }); this.fence(error) }

  private interrupt(actions: Set<() => void>): void {
    for (const action of actions) {
      try { action() }
      catch (error) { this.issue('cleanup interruption', error) }
    }
  }

  /** Admit cleanup only before the shared deadline, and interrupt the loser on timeout.
   * @param stage Cleanup operation.
   * @param bound Maximum milliseconds for this operation, capped by the shared deadline.
   * @param operation Starts only after deadline admission.
   * @returns Actual completion; a rejected or timed-out operation permanently fences acquisition.
   */
  async step<T>(stage: string, bound: number, operation: () => Promise<T>): Promise<T> {
    this.clock()
    const remaining = this.expires - performance.now()
    if (remaining <= 0) {
      const error = new Error(`${stage} cannot start after the cleanup deadline`)
      this.issue(stage, error); this.interrupt(this.killers); throw error
    }
    let timer: NodeJS.Timeout | undefined
    try {
      const observed = Promise.resolve().then(() => { this.guardCleanup(); return operation() })
      return await Promise.race([observed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { this.interrupt(this.killers); reject(new Error(`${stage} exceeded its cleanup bound`)) }, Math.min(bound, remaining))
      })])
    } catch (error) { this.issue(stage, error); throw error }
    finally { clearTimeout(timer) }
  }

  /** Reject new cleanup SQL after the common deadline. */
  guardCleanup(): void { if (this.expires && performance.now() >= this.expires) throw new Error('Maintenance cleanup deadline expired') }

  /** Attempt one independent cleanup operation without skipping later operations.
   * @param stage Cleanup operation.
   * @param bound Maximum milliseconds.
   * @param operation Actual owned cleanup.
   */
  async attempt(stage: string, bound: number, operation: () => Promise<void>): Promise<void> {
    try { await this.step(stage, bound, operation) }
    catch (_recordedCleanupFailure) { /* step retains the error and the permanent acquisition fence. */ }
  }

  /** Release the deadline only after all resource absence checks succeeded. */
  confirmed(): void {
    if (this.issues.length) throw new AggregateError(this.issues.map(issue => issue.error), 'Maintenance cleanup failed')
    this.disposed = true; clearTimeout(this.timer); this.stoppers.clear(); this.killers.clear()
  }

  /** Read the positive cleanup confirmation.
   * @returns True only after every required resource check succeeded.
   */
  isConfirmed(): boolean { return this.disposed }
}

/** Join actual close and a dedicated POSIX process group, including descendants retaining inherited pipes.
 * @param child Already spawned detached child; ownership is installed synchronously.
 * @param signal Caller and Profile deadline cancellation.
 * @param drain Aggregate cleanup owner.
 * @returns Bounded completion and a retained TERM, five-second KILL and ten-second actual group join.
 */
export function maintenanceProcessGroup(child: ChildProcess, signal: AbortSignal, drain: MaintenanceDrain) {
  let closed = false, stopped = false, killTimer: NodeJS.Timeout | undefined
  let pending: Promise<void> | undefined
  let finish: (() => void) | undefined, fail: ((error: unknown) => void) | undefined
  let actual: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    finish = () => { if (actual !== undefined) resolve(actual) }; fail = reject
  })
  result.catch((_callerObservesFailure: unknown) => undefined)
  const alive = (): boolean => {
    if (child.pid === undefined) return false
    try { process.kill(-child.pid, 0); return true }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error }
  }
  const kill = (actualSignal: NodeJS.Signals): void => {
    if (stopped || child.pid === undefined) return
    try { process.kill(-child.pid, actualSignal) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) drain.issue('Profile group signal', error) }
  }
  const stop = (): void => {
    if (!stopped) {
      kill('SIGTERM')
      killTimer ??= setTimeout(() => { killTimer = undefined; kill('SIGKILL') }, 5000)
    }
  }
  const join = (): Promise<void> => {
    if (pending) return pending
    stop()
    pending = (async () => {
      const expires = performance.now() + 10000
      while (!closed || alive()) {
        if (performance.now() >= expires) { kill('SIGKILL'); throw new Error('Profile close or process group remains after 10000 ms') }
        await delay(25)
      }
      stopped = true; clearTimeout(killTimer); signal.removeEventListener('abort', cancelled)
      finish?.()
    })()
    pending.catch((error: unknown) => { drain.issue('Profile group join', error); fail?.(error) })
    return pending
  }
  const cancelled = (): void => { stop(); join().catch((_recordedJoinFailure: unknown) => undefined) }
  child.once('close', (code, actualSignal) => { closed = true; actual = { code, signal: actualSignal }; cancelled() })
  child.once('exit', cancelled)
  child.once('error', cancelled)
  signal.addEventListener('abort', cancelled, { once: true })
  drain.register(cancelled, () => { kill('SIGKILL') })
  if (signal.aborted) cancelled()
  return { result, join, stopped: () => stopped }
}

/** Parent business PG pools with verified server deadlines and exact backend cancellation identities.
 * @param source Existing readonly source; only its uniquely tagged owned connections are cancelled.
 * @param target Unique target database URL.
 * @param admin Administrative URL for the owned target database and role.
 * @param tag Unique application-name prefix, shorter than PostgreSQL's 63-byte name limit.
 * @param drain Aggregate cleanup deadline and permanent fence.
 */
export class MaintenancePg {
  readonly admin: Pool
  readonly target: Pool
  readonly sourceUrl: URL
  readonly targetUrl: URL
  readonly backends: Backend[] = []
  readonly cancellations: Array<Backend & { cancelled: boolean }> = []
  readonly absent: string[] = []
  private readonly clients = new Set<PoolClient>()
  private readonly businessClients = new Set<PoolClient>()
  private readonly borrowers = new Map<PoolClient, { done: Promise<void>; released: () => void }>()
  private readonly queries = new Set<Promise<void>>()
  private readonly closing = new Map<PoolClient, Promise<void>>()
  private readonly ending = new Map<Pool, Promise<void>>()
  private readonly control: Pool
  private readonly sourceControl: Pool
  private readonly sourceNames: [string]
  private readonly targetNames: [string, string]
  private cancelled: Promise<void> | undefined

  constructor(source: URL, target: URL, admin: URL, tag: string, private readonly drain: MaintenanceDrain) {
    this.sourceNames = [tag + '-source']; this.targetNames = [tag + '-admin', tag + '-target']
    this.sourceUrl = this.tagged(source, this.sourceNames[0]); this.targetUrl = this.tagged(target, this.targetNames[1])
    this.admin = this.pool(admin, this.targetNames[0], true, 1)
    this.target = this.pool(target, this.targetNames[1], true, 2)
    this.control = this.pool(admin, tag + '-control', false, 1)
    this.sourceControl = this.pool(source, tag + '-read-control', false, 1)
    drain.register(() => { this.cancelBusiness().catch((_recordedCancellation: unknown) => undefined) }, () => {
      this.closeBusiness()
      void this.endPool(this.control); void this.endPool(this.sourceControl)
      for (const client of this.clients) client.connection.stream.destroy()
    })
  }

  private tagged(url: URL, application: string): URL {
    if (Buffer.byteLength(application) > 63) throw new Error('Owned PG application name exceeds 63 bytes')
    const copy = new URL(url); copy.searchParams.set('application_name', application); return copy
  }

  private pool(url: URL, application: string, business: boolean, max: number): Pool {
    const pool = new Pool({ connectionString: this.tagged(url, application).href, max,
      statement_timeout: 4000, query_timeout: 5000, connectionTimeoutMillis: 5000,
      verify: (client, done) => {
        this.clients.add(client)
        if (business) this.businessClients.add(client)
        if (business && this.drain.signal.aborted) {
          void this.closeClient(client); done(new Error('Maintenance business acquisition was cancelled')); return
        }
        const checked = client.query<Backend & { timeout: number }>(`SELECT pid,backend_start::text AS started,
          application_name::text AS application,datname::text AS database,usename::text AS user,
          (SELECT setting::int FROM pg_settings WHERE name='statement_timeout') AS timeout
          FROM pg_stat_activity WHERE pid=pg_backend_pid()`)
        checked.then((result) => {
          const row = result.rows[0]
          if (!row || row.timeout !== 4000 || row.application !== application) {
            void this.closeClient(client); done(new Error('Owned PG server deadline or identity was not applied')); return
          }
          this.backends.push(row)
          if (business) this.guardQueries(client)
          if (business && this.drain.signal.aborted) {
            void this.closeClient(client); done(new Error('Maintenance business acquisition was cancelled'))
          } else done()
        }, (error: unknown) => {
          void this.closeClient(client); done(new Error('Owned PG backend verification failed', { cause: error }))
        }).catch((error: unknown) => { this.drain.issue('PG verification callback', error) })
      },
    })
    pool.on('error', (error: Error) => { this.drain.issue('PG pool error', error) })
    pool.on('acquire', (client: PoolClient) => {
      let released: () => void = () => undefined
      const done = new Promise<void>((resolve) => { released = resolve })
      this.borrowers.set(client, { done, released })
    })
    pool.on('release', (_error: Error, client: PoolClient) => {
      this.borrowers.get(client)?.released(); this.borrowers.delete(client)
    })
    pool.query = new Proxy(pool.query.bind(pool), { apply: (query, receiver, args) => {
      if (business) this.drain.signal.throwIfAborted()
      else this.drain.guardCleanup()
      return Reflect.apply(query, receiver, args) as ReturnType<typeof query>
    } })
    pool.connect = new Proxy(pool.connect.bind(pool), { apply: (connect, receiver, args) => {
      if (business) this.drain.signal.throwIfAborted()
      else this.drain.guardCleanup()
      return Reflect.apply(connect, receiver, args) as ReturnType<typeof connect>
    } })
    return pool
  }

  private guardQueries(client: PoolClient): void {
    client.query = new Proxy(client.query.bind(client), { apply: (query, receiver, args) => {
      this.drain.signal.throwIfAborted()
      let settle: () => void = () => undefined
      const joined = new Promise<void>((resolve) => { settle = resolve })
      this.queries.add(joined)
      void joined.then(() => { this.queries.delete(joined) })
      const callback: unknown = args.at(-1)
      if (typeof callback === 'function') {
        const deliver = callback as (...values: unknown[]) => void
        args[args.length - 1] = (...values: unknown[]) => { try { deliver(...values) } finally { settle() } }
      }
      try {
        const result: unknown = Reflect.apply(query, receiver, args)
        if (result instanceof Promise) void result.then(settle, settle)
        else if (typeof callback !== 'function') settle()
        return result as ReturnType<typeof query>
      } catch (error) { settle(); throw error }
    } })
  }

  private closeClient(client: PoolClient): Promise<void> {
    const previous = this.closing.get(client)
    if (previous) return previous
    const pending = client.end(); this.closing.set(client, pending)
    // The original borrower owns release, including after this owner closes the socket.
    pending.catch((error: unknown) => { this.drain.issue('PG client close', error) })
    return pending
  }

  private endPool(pool: Pool): Promise<void> {
    const previous = this.ending.get(pool)
    if (previous) return previous
    const pending = pool.end(); this.ending.set(pool, pending)
    pending.catch((error: unknown) => { this.drain.issue('PG pool close', error) })
    return pending
  }

  private closeBusiness(): void {
    void this.endPool(this.admin); void this.endPool(this.target)
    for (const client of this.businessClients) void this.closeClient(client)
  }

  /** Warm cancellation connections before any business SQL.
   * @returns Completion after both observer deadlines and backend identities are verified.
   */
  async prepare(): Promise<void> {
    this.drain.signal.throwIfAborted()
    const checked = await Promise.allSettled([this.control.connect(), this.sourceControl.connect()])
    for (const result of checked) if (result.status === 'fulfilled') result.value.release()
    const errors = checked.filter(result => result.status === 'rejected').map((result) => { const error: unknown = result.reason; return error })
    if (errors.length) throw new AggregateError(errors, 'PG cancellation connections failed')
    this.drain.signal.throwIfAborted()
  }

  private async cancel(pool: Pool, names: string[]): Promise<void> {
    const observed = await pool.query<Backend>(`SELECT pid,backend_start::text AS started,
      application_name::text AS application,datname::text AS database,usename::text AS user
      FROM pg_stat_activity WHERE application_name=ANY($1::text[]) AND pid<>pg_backend_pid()`, [names])
    this.backends.push(...observed.rows)
    if (!observed.rows.length) return
    const result = await pool.query<Backend & { cancelled: boolean }>(`SELECT a.pid,a.backend_start::text AS started,
      a.application_name::text AS application,a.datname::text AS database,a.usename::text AS user,
      pg_cancel_backend(a.pid) AS cancelled FROM pg_stat_activity a
      JOIN jsonb_to_recordset($1::jsonb) AS o(pid int,started text,application text,database text,"user" text)
      ON a.pid=o.pid AND a.backend_start::text=o.started AND a.application_name=o.application
      AND a.datname=o.database AND a.usename=o."user"`, [JSON.stringify(observed.rows)])
    this.cancellations.push(...result.rows)
  }

  /** Cancel in-flight SQL by exact observed backend identity, then close business sockets and pools.
   * @returns Actual cancellation completion; final cleanup repeats discovery after the child group is absent.
   */
  cancelBusiness(): Promise<void> {
    this.drain.begin()
    void this.endPool(this.admin); void this.endPool(this.target)
    this.cancelled ??= this.drain.step('cancel owned SQL', 5000, async () => {
      const results = await Promise.allSettled([
        this.cancel(this.control, this.targetNames), this.cancel(this.sourceControl, this.sourceNames),
      ])
      const errors = results.filter(result => result.status === 'rejected').map((result) => { const error: unknown = result.reason; return error })
      if (errors.length) throw new AggregateError(errors, 'Owned PG cancellation failed')
      await Promise.all([...this.queries])
    }).finally(() => { this.closeBusiness() })
    this.cancelled.catch((_stepRecordsFailure: unknown) => undefined)
    return this.cancelled
  }

  private async join(pool: Pool, names: string[]): Promise<void> {
    for (;;) {
      this.drain.guardCleanup()
      const remaining = await pool.query<Backend>(`SELECT pid,backend_start::text AS started,
        application_name::text AS application,datname::text AS database,usename::text AS user
        FROM pg_stat_activity WHERE application_name=ANY($1::text[])`, [names])
      this.backends.push(...remaining.rows)
      if (!remaining.rows.length) { this.absent.push(...names); return }
      await delay(25)
    }
  }

  /** Independently attempt every physical cleanup step under the shared deadline.
   * @param database Exact unique fixture database.
   * @param role Exact unique fixture role.
   * @param profileStopped Positive actual close and process group absence confirmation.
   * @returns Completion after all possible cleanup operations; issues stay permanently fenced.
   */
  async cleanup(database: string, role: string, profileStopped: boolean): Promise<void> {
    this.drain.begin()
    await this.drain.attempt('initial SQL cancellation', 5000, () => this.cancelBusiness())
    await this.drain.attempt('final SQL cancellation', 5000, async () => {
      await Promise.all([this.cancel(this.control, this.targetNames), this.cancel(this.sourceControl, this.sourceNames)])
    })
    await this.drain.attempt('business PG close', 5000, async () => {
      this.closeBusiness()
      await Promise.all([
        ...this.ending.values(), ...this.closing.values(), ...[...this.borrowers.values()].map(borrower => borrower.done),
      ])
    })
    await Promise.all([
      this.drain.attempt('source backend absence', 5000, () => this.join(this.sourceControl, this.sourceNames)),
      this.drain.attempt('target backend absence', 5000, () => this.join(this.control, this.targetNames)),
    ])
    if (profileStopped) {
      await this.drain.attempt('target database drop', 5000, async () => { await this.control.query(`DROP DATABASE IF EXISTS "${database}"`) })
      await this.drain.attempt('target role drop', 5000, async () => { await this.control.query(`DROP ROLE IF EXISTS "${role}"`) })
    } else this.drain.issue('Profile absence', new Error('Cannot drop target while its Profile group is unconfirmed'))
    await this.drain.attempt('target resource absence', 5000, async () => {
      const result = await this.control.query(`SELECT 1 FROM pg_database WHERE datname=$1
        UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$2`, [database, role])
      if (result.rows.length) throw new Error('Owned target database or role remains')
    })
    await this.drain.attempt('PG observer close', 5000, async () => {
      const pending = [this.endPool(this.control), this.endPool(this.sourceControl)]
      for (const client of this.clients) pending.push(this.closeClient(client))
      pending.push(...[...this.borrowers.values()].map(borrower => borrower.done))
      await Promise.all(pending)
    })
  }
}
