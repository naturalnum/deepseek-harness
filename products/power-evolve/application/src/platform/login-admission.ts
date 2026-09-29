/** PostgreSQL-backed login admission shared by every Platform replica. */
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { PlatformError } from '../contracts.ts'
import { transaction } from './database.ts'

/** The deployment must configure the same admission limits on every Platform replica. */
export interface PlatformAdmissionLimits {
  readonly loginWindowMs: number
  readonly loginAttemptsPerWindow: number
  readonly loginTrackedAccounts: number
  readonly loginGlobalAttemptsPerWindow: number
  readonly sandboxConcurrency: number
}

type Policy = { login_window_ms: number; login_attempts_per_window: number;
  login_tracked_accounts: number; login_global_attempts_per_window: number;
  sandbox_concurrency: number }

/** A high-capacity global overload guard and a separate limit for each exact account name. */
export class LoginAdmission {
  constructor(private readonly pool: Pool, private readonly limits: PlatformAdmissionLimits) {}

  /** Install or verify the shared deployment policy before serving requests. */
  async initialize(): Promise<void> {
    await transaction(this.pool, async client => {
      await client.query(
        `INSERT INTO pe_platform_admission_policy(singleton,login_window_ms,
           login_attempts_per_window,login_tracked_accounts,login_global_attempts_per_window,
           sandbox_concurrency)
         VALUES(true,$1,$2,$3,$4,$5) ON CONFLICT(singleton) DO NOTHING`,
        [this.limits.loginWindowMs, this.limits.loginAttemptsPerWindow,
          this.limits.loginTrackedAccounts, this.limits.loginGlobalAttemptsPerWindow,
          this.limits.sandboxConcurrency])
      const policy = await client.query<Policy>('SELECT * FROM pe_platform_admission_policy WHERE singleton=true')
      const row = policy.rows[0]
      if (!row || row.login_window_ms !== this.limits.loginWindowMs
        || row.login_attempts_per_window !== this.limits.loginAttemptsPerWindow
        || row.login_tracked_accounts !== this.limits.loginTrackedAccounts
        || row.login_global_attempts_per_window !== this.limits.loginGlobalAttemptsPerWindow
        || row.sandbox_concurrency !== this.limits.sandboxConcurrency) {
        throw new Error('Platform replicas disagree on global admission limits')
      }
    })
  }

  /** Count every request, including malformed JSON, before reading its body. */
  async chargeGlobal(): Promise<void> {
    // One atomic statement keeps the row lock for a single server-side update.
    // Concurrent UPDATEs recheck the predicate after waiting for the latest row.
    const charged = await this.pool.query(
      `UPDATE pe_login_global_window AS g SET
         window_since=CASE WHEN statement_timestamp()>g.window_since
           +p.login_window_ms*interval '1 millisecond' THEN statement_timestamp() ELSE g.window_since END,
         attempts=CASE WHEN statement_timestamp()>g.window_since
           +p.login_window_ms*interval '1 millisecond' THEN 1 ELSE g.attempts+1 END
       FROM pe_platform_admission_policy AS p
       WHERE g.singleton=true AND p.singleton=true
         AND (statement_timestamp()>g.window_since+p.login_window_ms*interval '1 millisecond'
           OR g.attempts<p.login_global_attempts_per_window)
       RETURNING g.attempts`)
    if (!charged.rowCount) {
      const availability = await this.pool.query<{ policy: boolean; window: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pe_platform_admission_policy WHERE singleton=true) AS policy,
          EXISTS(SELECT 1 FROM pe_login_global_window WHERE singleton=true) AS window`)
      if (!availability.rows[0]?.policy || !availability.rows[0].window) {
        throw new PlatformError(503, 'login_rate_limit_unavailable')
      }
      throw new PlatformError(429, 'login_rate_limit')
    }
  }

  /** Limit guesses for one exact account name independently of the proxy peer address. */
  async chargeAccount(username: string): Promise<void> {
    const accountDigest = createHash('sha256').update('power-evolve-login-account-v1\0')
      .update(username).digest('hex')
    await transaction(this.pool, async client => {
      const policy = await client.query<Policy>(
        'SELECT * FROM pe_platform_admission_policy WHERE singleton=true')
      const limits = policy.rows[0]
      if (!limits) throw new PlatformError(503, 'login_rate_limit_unavailable')
      // The global row serializes account insertion and its bounded live count.
      const counter = await client.query<{ tracked_accounts: number }>(
        'SELECT tracked_accounts FROM pe_login_global_window WHERE singleton=true FOR UPDATE')
      if (!counter.rows[0]) throw new PlatformError(503, 'login_rate_limit_unavailable')
      const instant = (await client.query<{ time: Date }>('SELECT clock_timestamp() AS time')).rows[0]!.time
      const expired = await client.query<{ count: number }>(
        `WITH deleted AS (DELETE FROM pe_login_attempt_windows
           WHERE window_since < $1::timestamptz-$2::double precision*interval '1 millisecond'
           RETURNING 1) SELECT count(*)::integer AS count FROM deleted`,
        [instant, limits.login_window_ms])
      const tracked = counter.rows[0].tracked_accounts - expired.rows[0]!.count
      if (expired.rows[0]!.count) await client.query(
        'UPDATE pe_login_global_window SET tracked_accounts=$1 WHERE singleton=true', [tracked])
      const prior = await client.query<{ attempts: number }>(
        'SELECT window_since,attempts FROM pe_login_attempt_windows WHERE account_digest=$1', [accountDigest])
      if (prior.rows[0]) {
        if (prior.rows[0].attempts >= limits.login_attempts_per_window) {
          throw new PlatformError(429, 'login_rate_limit')
        }
        await client.query('UPDATE pe_login_attempt_windows SET attempts=attempts+1 WHERE account_digest=$1',
          [accountDigest])
        return
      }
      if (tracked >= limits.login_tracked_accounts) {
        throw new PlatformError(429, 'login_rate_limit')
      }
      await client.query(
        'INSERT INTO pe_login_attempt_windows(account_digest,window_since,attempts) VALUES($1,$2,1)',
        [accountDigest, instant])
      await client.query('UPDATE pe_login_global_window SET tracked_accounts=tracked_accounts+1 WHERE singleton=true')
    })
  }
}
