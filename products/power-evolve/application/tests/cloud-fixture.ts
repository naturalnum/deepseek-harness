/** Owned PostgreSQL and filesystem fixture; infrastructure absence fails before any case runs. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool, type PoolClient, type PoolConfig } from 'pg'
import { initializeDatabase } from '../src/platform/database.ts'
import { seedNewUser } from '../src/platform/account-settings.ts'
import { hashPassword, IdentityService } from '../src/platform/identity.ts'
import { FileService } from '../src/platform/files.ts'

const urlFile = process.env.PE_TEST_DATABASE_URL_FILE
if (!urlFile) throw new Error('Cloud tests require PE_TEST_DATABASE_URL_FILE')
const address = new URL((await readFile(urlFile, 'utf8')).trim())
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
const observe = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then<Outcome<T>, Outcome<T>>(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))

/** Nonsecret ownership and phase diagnostics for the optional subprocess lifetime. */
export interface CloudFixturePhase {
  phase: string
  state: string
  database: string
  elapsedMs?: number
  backendPid?: number
  applicationName?: string
}
/** Optional bounded ownership; existing callers keep the original database and service setup. */
export interface CloudFixtureLifetime {
  signal: AbortSignal
  setupTimeoutMs: number
  cleanupTimeoutMs: number
  queryTimeoutMs: number
  onPhase?: (event: CloudFixturePhase) => void
  onOwned?: (owned: { database: string; root: string }) => void
  onAbort?: (reason: unknown) => void
  onUnsafe?: (error: unknown) => void
}

function poolOwner(pool: Pool, report: (event: CloudFixturePhase) => void,
  identity?: { application: string; database: string }, guardian?: Pool) {
  const clients = new Set<PoolClient>(), observations: Promise<Outcome<void>>[] = [], poolErrors: unknown[] = []
  let closing: Promise<Outcome<void>> | undefined, interruption: Promise<Outcome<void>> | undefined
  pool.on('error', (error: unknown) => { poolErrors.push(error) })
  pool.on('connect', (client) => {
    clients.add(client)
    if (identity) observations.push(observe(client.query<{ pid: number; database: string; application: string }>(
      "SELECT pg_backend_pid() AS pid,current_database() AS database,current_setting('application_name') AS application")
      .then((result) => {
        const row = result.rows[0]
        if (!row || row.database !== identity.database || row.application !== identity.application) {
          throw new Error('Owned PostgreSQL backend identity changed')
        }
        report({ phase: 'postgres-backend', state: 'owned', database: row.database,
          backendPid: row.pid, applicationName: row.application })
      })))
  })
  pool.on('remove', (client) => { clients.delete(client) })
  return {
    close(interrupt: boolean): Promise<void> {
      // Calling close again may escalate an already pending pool.end().
      if (!closing) closing = observe(pool.end())
      if (interrupt && !interruption) interruption = observe((async () => {
        const failures: unknown[] = []
        const ended = [...clients].map(client => observe(client.end()))
        if (guardian && identity) {
          try {
            // Discover actual server identities before cancelling only these owned backend PIDs.
            const found = await guardian.query<{ pid: number; application_name: string; datname: string }>(
              `SELECT pid,application_name,datname FROM pg_stat_activity
               WHERE application_name=$1 AND datname=$2 AND usename=current_user`,
              [identity.application, identity.database])
            for (const row of found.rows) report({ phase: 'postgres-backend', state: 'cancelling',
              database: row.datname, backendPid: row.pid, applicationName: row.application_name })
            if (found.rows.length) await guardian.query(
              `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
               WHERE pid=ANY($1::int[]) AND application_name=$2 AND datname=$3 AND usename=current_user`,
              [found.rows.map(row => row.pid), identity.application, identity.database])
          } catch (error) { failures.push(error) }
        }
        for (const outcome of await Promise.all(ended)) if (!outcome.ok) failures.push(outcome.error)
        if (failures.length) throw new AggregateError(failures, 'Owned PostgreSQL cancellation failed')
      })())
      const closed = closing, cancelled = interruption
      return (async () => {
        const failures = [...poolErrors]
        for (const outcome of await Promise.all([...observations, closed, ...(cancelled ? [cancelled] : [])])) {
          if (!outcome.ok) failures.push(outcome.error)
        }
        if (failures.length) throw new AggregateError(failures, 'Owned PostgreSQL connections did not settle')
      })()
    },
  }
}

/** Run one isolated cloud case and remove only its database and storage.
 * @param run Case that settles before fixture disposal.
 * @param lifetime Optional cancellation and PostgreSQL limits for subprocess cases.
 * @returns The case result after owned resources have been released.
 */
export async function cloudFixture<T>(run: (fixture: {
  pool: Pool
  root: string
  files: FileService
  identities: IdentityService
  alice: Awaited<ReturnType<IdentityService['login']>>
  bob: Awaited<ReturnType<IdentityService['login']>>
}) => Promise<T>, lifetime?: CloudFixtureLifetime): Promise<T> {
  const name = `pe_cloud_case_${randomUUID().replaceAll('-', '')}`
  const limits: PoolConfig = lifetime ? { connectionTimeoutMillis: lifetime.queryTimeoutMs,
    statement_timeout: lifetime.queryTimeoutMs, query_timeout: lifetime.queryTimeoutMs + 1000,
    options: `-c lock_timeout=${lifetime.queryTimeoutMs} -c idle_in_transaction_session_timeout=${lifetime.queryTimeoutMs}` } : {}
  const report = (event: CloudFixturePhase): void => { lifetime?.onPhase?.(event) }
  const controller = new AbortController()
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) { controller.abort(reason); lifetime?.onAbort?.(reason) }
  }
  const stop = (): void => { abort(lifetime?.signal.reason) }
  const setupStart = Date.now()
  const setupTimer = lifetime ? setTimeout(() => { abort(new Error('Cloud fixture setup deadline exceeded')) },
    lifetime.setupTimeoutMs) : undefined
  if (lifetime?.signal.aborted) stop()
  else lifetime?.signal.addEventListener('abort', stop, { once: true })
  let root: string | undefined
  let result: Outcome<T> | undefined
  const failures: unknown[] = []
  const adminTag = name + '_admin', mainTag = name + '_main'
  const admin = new Pool({ connectionString: address.href, max: 1, ...limits,
    ...(lifetime ? { application_name: adminTag } : {}) })
  const databaseUrl = new URL(address); databaseUrl.pathname = `/${name}`
  const pool = new Pool({ connectionString: databaseUrl.href, max: 8, ...limits,
    ...(lifetime ? { application_name: mainTag } : {}) })
  const guardian = lifetime ? new Pool({ connectionString: address.href, max: 1,
    connectionTimeoutMillis: 1000, statement_timeout: 1000, query_timeout: 1500,
    options: '-c lock_timeout=1000 -c idle_in_transaction_session_timeout=1000' }) : undefined
  const owners = lifetime ? {
    guardianOwner: guardian ? poolOwner(guardian, report) : undefined,
    mainOwner: poolOwner(pool, report, { application: mainTag, database: name }, guardian),
    adminOwner: poolOwner(admin, report, { application: adminTag, database: address.pathname.slice(1) }, guardian),
  } : undefined
  let interrupted: Promise<PromiseSettledResult<void>[]> | undefined
  const interrupt = (): void => {
    if (owners) interrupted = Promise.allSettled([owners.mainOwner.close(true), owners.adminOwner.close(true)])
  }
  controller.signal.addEventListener('abort', interrupt, { once: true })
  if (controller.signal.aborted) interrupt()
  report({ phase: 'fixture-setup', state: 'start', database: name })
  if (!lifetime) root = await mkdtemp(join(tmpdir(), 'pe-cloud-case-'))
  try {
    controller.signal.throwIfAborted()
    if (lifetime) root = await mkdtemp(join(tmpdir(), 'pe-cloud-case-'))
    if (!root) throw new Error('Cloud fixture has no owned root')
    // Record ownership before CREATE; even cancellation during setup reaches this same cleanup.
    lifetime?.onOwned?.({ database: name, root })
    controller.signal.throwIfAborted()
    await admin.query(`CREATE DATABASE "${name}"`)
    controller.signal.throwIfAborted()
    await initializeDatabase(pool)
    controller.signal.throwIfAborted()
    const password = randomUUID()
    const initial = { model: 'trial-model', maxTokens: 1000, revision: 1 }
    const hash = await hashPassword(password)
    controller.signal.throwIfAborted()
    await seedNewUser(pool, 'alice', hash, initial)
    controller.signal.throwIfAborted()
    await seedNewUser(pool, 'bob', hash, initial)
    controller.signal.throwIfAborted()
    const identities = new IdentityService(pool, 60_000)
    const alice = await identities.login('alice', password)
    controller.signal.throwIfAborted()
    const bob = await identities.login('bob', password)
    controller.signal.throwIfAborted()
    const files = new FileService(pool, root)
    await files.init()
    controller.signal.throwIfAborted()
    if (setupTimer) clearTimeout(setupTimer)
    report({ phase: 'fixture-setup', state: 'complete', elapsedMs: Date.now() - setupStart, database: name })
    result = { ok: true, value: await run({ pool, root, files, identities, alice, bob }) }
    controller.signal.throwIfAborted()
  } catch (error) {
    if (!lifetime) throw error
    result = { ok: false, error }
    failures.push(error)
    if (controller.signal.aborted && controller.signal.reason !== error) failures.push(controller.signal.reason)
  } finally {
    if (setupTimer) clearTimeout(setupTimer)
    lifetime?.signal.removeEventListener('abort', stop)
    controller.signal.removeEventListener('abort', interrupt)
    if (!lifetime) {
      await pool.end()
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.end()
      if (root) await rm(root, { recursive: true, force: true })
    } else if (owners) {
      const { mainOwner, adminOwner, guardianOwner } = owners
      const cleanupStart = Date.now()
      report({ phase: 'fixture-cleanup', state: 'start', database: name })
      const cleanupLimits: PoolConfig = { connectionTimeoutMillis: 1000, statement_timeout: 1000,
        query_timeout: 1500, options: '-c lock_timeout=1000 -c idle_in_transaction_session_timeout=1000' }
      const cleanup = lifetime ? new Pool({ connectionString: address.href, max: 1, ...cleanupLimits }) : admin
      const cleanupOwner = lifetime ? poolOwner(cleanup, report) : adminOwner
      const cleanupFailures: unknown[] = []
      const tasks: { name: string; settled: boolean; delivered: boolean; outcome: Promise<Outcome<unknown>> }[] = []
      let cleanupExpired = false
      let expire!: (outcome: Outcome<never>) => void
      const expired = new Promise<Outcome<never>>((resolve) => { expire = resolve })
      const cleanupTimer = lifetime ? setTimeout(() => {
        cleanupExpired = true
        const error = new Error('Owned fixture cleanup deadline exceeded')
        lifetime.onUnsafe?.(error)
        expire({ ok: false, error })
        // Every escalation remains owned by the corresponding close task below.
        void cleanupOwner.close(true).catch((_closeFailure: unknown) => undefined)
        void mainOwner.close(true).catch((_closeFailure: unknown) => undefined)
        void adminOwner.close(true).catch((_closeFailure: unknown) => undefined)
        if (guardianOwner) void guardianOwner.close(true).catch((_closeFailure: unknown) => undefined)
      }, lifetime.cleanupTimeoutMs) : undefined
      const attempt = async <V>(phase: string, milliseconds: number, runCleanup: () => Promise<V>): Promise<Outcome<V>> => {
        const task = { name: phase, settled: false, delivered: false, outcome: observe(Promise.resolve().then(runCleanup)) }
        tasks.push(task)
        const observed = task.outcome.then((outcome) => { task.settled = true; return outcome })
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const deadline = new Promise<Outcome<never>>((resolve) => {
            if (lifetime) timer = setTimeout(() => {
              const error = new Error('Owned fixture cleanup phase deadline exceeded: ' + phase)
              lifetime.onUnsafe?.(error)
              resolve({ ok: false, error })
            }, milliseconds)
          })
          const outcome = await Promise.race([observed, deadline, ...(lifetime ? [expired] : [])])
          task.delivered = task.settled
          if (!outcome.ok) cleanupFailures.push(outcome.error)
          return outcome
        } finally { if (timer) clearTimeout(timer) }
      }
      // A failed or overdue pool close cannot prevent the independent drop/close/rm attempts.
      const postgresClose = attempt('postgres-cancel-and-close', 5000, async () => {
        const outcomes = await Promise.allSettled([
          ...(interrupted ? [interrupted.then((results) => {
            const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
            if (errors.length) throw new AggregateError(errors, 'Owned PostgreSQL cancellation failed')
          })] : []),
          mainOwner.close(controller.signal.aborted), ...(lifetime ? [adminOwner.close(controller.signal.aborted)] : []),
        ])
        const errors = outcomes.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
        if (errors.length) throw new AggregateError(errors, 'Owned PostgreSQL close failed')
      })
      if (!lifetime) await postgresClose
      const postgresCleanup = (async () => {
        if (lifetime) await attempt('postgres-connection-audit', 2500, async () => {
          const until = Date.now() + 2500
          while (true) {
            const connected = await cleanup.query<{ count: string }>('SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1', [name])
            if (Number(connected.rows[0]?.count) === 0) return
            if (Date.now() >= until) throw new Error('Owned fixture database still has connections')
            await new Promise<void>(resolve => setTimeout(resolve, 25))
          }
        })
        await attempt('postgres-drop', 1500, async () => { await cleanup.query(`DROP DATABASE IF EXISTS "${name}"`) })
        if (lifetime) await attempt('postgres-removal-audit', 1500, async () => {
          const remaining = await cleanup.query<{ count: string }>('SELECT count(*) AS count FROM pg_database WHERE datname=$1', [name])
          if (Number(remaining.rows[0]?.count) !== 0) throw new Error('Owned fixture database survived cleanup')
        })
        await attempt('cleanup-pool-close', 1000, () => cleanupOwner.close(cleanupExpired))
      })()
      const guardianCleanup = (async () => {
        await postgresClose
        if (guardianOwner) await attempt('guardian-close', 1000, () => guardianOwner.close(cleanupExpired))
      })()
      // Directory removal and PostgreSQL removal have independent owners. Their joined
      // critical path is <= 6.5s; PG cancel/close + guardian close is <= 6s, within 10s.
      if (!lifetime) await postgresCleanup
      const rootCleanup = (async () => {
        if (root) {
          const ownedRoot = root
          await attempt('temporary-root-remove', 1000, () => rm(ownedRoot, { recursive: true, force: true }))
          if (lifetime) await attempt('temporary-root-audit', 1000, async () => {
            try { await stat(ownedRoot); throw new Error('Owned fixture root survived cleanup') }
            catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
            }
          })
        }
      })()
      // Observe all independent workflows, including a rejected undefined reason.
      for (const outcome of await Promise.allSettled([postgresClose, postgresCleanup, guardianCleanup, rootCleanup])) {
        if (outcome.status === 'rejected') cleanupFailures.push(outcome.reason)
      }
      // Race losers stay owned and observed. If one never joins, the caller's single 40s
      // abort-to-quiescence deadline latches fileUnsafe before its 45s completion hook ends.
      const joined = await Promise.all(tasks.map(task => task.outcome))
      for (let index = 0; index < joined.length; index++) {
        const task = tasks[index], outcome = joined[index]
        if (task && outcome && !task.delivered && !outcome.ok) cleanupFailures.push(outcome.error)
      }
      if (cleanupTimer) clearTimeout(cleanupTimer)
      // The timer can escalate a close that was already pending. Join that later escalation too.
      const finalCloses = await Promise.allSettled([
        mainOwner.close(controller.signal.aborted || cleanupExpired),
        adminOwner.close(controller.signal.aborted || cleanupExpired),
        cleanupOwner.close(cleanupExpired), ...(guardianOwner ? [guardianOwner.close(cleanupExpired)] : []),
      ])
      for (const outcome of finalCloses) if (outcome.status === 'rejected') cleanupFailures.push(outcome.reason)
      if (lifetime && (cleanupExpired || Date.now() - cleanupStart >= lifetime.cleanupTimeoutMs)) {
        cleanupFailures.push(new Error('Cloud fixture cleanup deadline exceeded'))
      }
      report({ phase: 'fixture-cleanup', state: cleanupFailures.length ? 'failed' : 'complete',
        elapsedMs: Date.now() - cleanupStart, database: name })
      failures.push(...cleanupFailures)
      if (cleanupFailures.length) lifetime?.onUnsafe?.(new AggregateError(cleanupFailures, 'Owned fixture cleanup failed'))
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Cloud fixture operation or cleanup failed')
  if (!result) throw new Error('Cloud fixture completed without a case result')
  if (!result.ok) throw new AggregateError([result.error], 'Cloud fixture operation rejected')
  return result.value
}
