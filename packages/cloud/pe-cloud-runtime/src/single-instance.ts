/** Dedicated PostgreSQL session owns opt-in process exclusion and startup-only owner takeover. */
import { Client, defaults } from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import { AccountRuntimeError } from './errors.ts'
import type { OwnerPgConnection, OwnerPgLimits } from './owner-pg-executor.ts'
import type { InstanceId } from './types.ts'

// A short database restart may need several connections; lock contention never permits a retry.
const MAX_RECONNECT_ATTEMPTS = 5

class SingleInstanceConnectionError extends AccountRuntimeError {
  constructor(cause: unknown) {
    super('cloud/account-unavailable', 'Single-instance database connection failed', { cause })
  }
}

/** Single-instance lock and takeover share a retained session; reconnect never resets live owners. */
export class SingleInstanceControl {
  private client: Client | undefined
  private held = false
  private started = false
  private readonly stop = new AbortController()
  private starting: Promise<void> | undefined
  private reconnecting: Promise<void> | undefined
  private shutdown: Promise<void> | undefined

  /**
   * @param connection Existing Root-selected database and credential resolver.
   * @param limits Existing database budgets, reused without additional deployment settings.
   * @param instanceId New process identity, excluded from closing stale instance registrations.
   * @param observe Safe event names, row counts and attempt numbers only; the Root owns diagnostic delivery.
   * @param failure Root control failure handler when reacquisition cannot confirm exclusion.
   */
  constructor(private readonly connection: OwnerPgConnection, private readonly limits: OwnerPgLimits,
    private readonly instanceId: InstanceId, private readonly observe: (row: Readonly<Record<string, string | number>>) => void,
    private readonly failure: (cause: unknown) => void) {}

  private get closing(): boolean { return this.stop.signal.aborted }

  /** True only while the dedicated session holds the lock; false during reconnect and closure. */
  get active(): boolean { return this.held && !this.closing }

  /**
   * Acquire immediately and atomically reset stale owners and registrations, preserving owner epochs.
   * @returns Actual startup settlement; contention rejects without changing persisted rows.
   */
  start(): Promise<void> {
    this.starting ??= this.connect(true).then(() => { this.started = true })
    return this.starting
  }

  /**
   * Stop supervision and join retained connections; ending the session releases its advisory lock.
   * @returns Cached actual closure, called by Root after closing its instance registration.
   */
  close(): Promise<void> {
    this.stop.abort()
    this.held = false
    this.shutdown ??= (async () => {
      await Promise.allSettled([this.starting, this.reconnecting])
      await this.client?.end()
      this.client = undefined
    })()
    return this.shutdown
  }

  private async connect(takeover: boolean): Promise<void> {
    if (defaults.query_timeout) {
      throw new AccountRuntimeError('cloud/invalid-config', 'Single-instance database requires pg query timeout to stay disabled')
    }
    const password = this.connection.password
    const client = new Client({
      host: this.connection.host, port: this.connection.port, user: this.connection.user,
      database: this.connection.database, ssl: this.connection.ssl,
      password: typeof password === 'string' ? () => password : password,
      connectionTimeoutMillis: this.limits.connectionTimeoutMs, query_timeout: 0,
      statement_timeout: this.limits.statementTimeoutMs, lock_timeout: this.limits.lockTimeoutMs,
      options: `-c statement_timeout=${this.limits.statementTimeoutMs} -c lock_timeout=${this.limits.lockTimeoutMs}`,
    })
    this.client = client
    client.on('error', () => { this.disconnected(client) })
    client.once('end', () => { this.disconnected(client) })
    let connected = false
    try {
      await client.connect()
      connected = true
      if (this.closing) throw new AccountRuntimeError('cloud/account-unavailable', 'Single-instance startup closed before lock acquisition')
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('pe-cloud/single-instance', 0)) AS locked")
      if (result.rows.length !== 1 || result.rows[0]?.locked !== true) {
        throw new AccountRuntimeError('cloud/config-conflict', 'Another process holds the single-instance lock')
      }
      this.held = true
      if (takeover) {
        await client.query('BEGIN')
        const owners = await client.query(`UPDATE public.pe_account_owners
          SET owner_instance_id = NULL, phase = 'unowned', updated_at = statement_timestamp()
          WHERE phase <> 'unowned'`)
        const instances = await client.query(`UPDATE public.pe_instances
          SET phase = 'closed', heartbeat_at = statement_timestamp()
          WHERE phase = 'registered' AND instance_id <> $1`, [this.instanceId])
        await client.query('COMMIT')
        this.observe({ event: 'single-instance-takeover', ownerRows: owners.rowCount ?? 0, instanceRows: instances.rowCount ?? 0 })
      }
      if (!this.active) throw new AccountRuntimeError('cloud/account-unavailable', 'Single-instance lock was lost during startup')
    } catch (cause) {
      this.held = false
      // Session closure also rolls back an incomplete takeover transaction.
      await client.end()
      if (this.client === client) this.client = undefined
      throw connected ? cause : new SingleInstanceConnectionError(cause)
    }
  }

  private disconnected(client: Client): void {
    if (this.client !== client) return
    this.held = false
    if (this.closing || !this.started || this.reconnecting !== undefined) return
    this.observe({ event: 'single-instance-lock-lost' })
    const actual = this.reconnect(client)
    this.reconnecting = actual
    void actual.then(() => {
      this.reconnecting = undefined
      if (!this.closing) this.observe({ event: 'single-instance-lock-reacquired' })
    }, (cause: unknown) => {
      this.reconnecting = undefined
      if (!this.closing) this.failure(cause)
    })
  }

  private async reconnect(client: Client): Promise<void> {
    await client.end()
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS && !this.closing; attempt++) {
      try { await this.connect(false); return }
      catch (cause) {
        if (!(cause instanceof SingleInstanceConnectionError)) throw cause
        this.observe({ event: 'single-instance-lock-reconnect-failed', attempt })
        if (attempt === MAX_RECONNECT_ATTEMPTS) throw cause
      }
      try { await delay(this.limits.connectionTimeoutMs, undefined, { signal: this.stop.signal, ref: false }) }
      catch (cause) { if (!this.closing) throw cause }
    }
  }
}
