/** Active PostgreSQL cancellation evidence separates local settlement from server quiescence. */
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldToCarrier } from 'node:timers/promises'
import { expect, test } from 'vitest'
import { searchNativeSessions, type NativeSessionSearchLimits } from '../src/platform/native-session-search.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits: NativeSessionSearchLimits = { maxEventBytes: 524_288, maxHistoryBytes: 4_194_304, maxHistoryEvents: 1000,
  searchResultLimit: 2, searchSnippetChars: 100, searchDeadlineMs: 1000,
  searchMaxSessions: 256, searchMaxEvents: 100_000, searchMaxBytes: 67_108_864 }

for (const mode of ['abort', 'deadline'] as const) {
  test(`active PG ${mode} closes the owned client and bounds the independently observed backend`, () => cloudFixture(async (fixture) => {
    const blocker = await fixture.pool.connect(), controller = new AbortController()
    const duration = mode === 'abort' ? 1000 : 400
    let pending: Promise<unknown> | undefined
    const evidence: Record<string, unknown> = { mode, deadlineMs: duration, ownedDatabaseOnly: true }
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE pe_sessions IN ACCESS EXCLUSIVE MODE')
      const started = performance.now()
      pending = searchNativeSessions(fixture.pool, fixture.alice.user, 'needle', { ...limits, searchDeadlineMs: duration }, controller.signal)
      // Install failure observation immediately while waiting for the actual relation-lock wait.
      const settled = pending.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))
      let pid: number | undefined
      while (performance.now() - started < duration) {
        const rows = (await fixture.pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='relation'
          AND query LIKE 'SELECT id,header,event_count,event_bytes%'`)).rows
        if (rows[0]) { pid = rows[0].pid; break }
        await yieldToCarrier()
      }
      expect(pid).toBeDefined()
      evidence.backendPid = pid
      evidence.lockWaitObservedAtMs = performance.now() - started
      if (mode === 'abort') controller.abort()
      const result = await settled
      evidence.localSettledAtMs = performance.now() - started
      expect(result.value).toBeUndefined()
      expect(result.error).toMatchObject({ status: mode === 'abort' ? 499 : 504,
        code: mode === 'abort' ? 'native_search_cancelled' : 'native_search_timeout' })
      let state: string | undefined, first = true
      while (performance.now() - started < duration + 1000) {
        const rows = (await fixture.pool.query<{ state: string }>('SELECT state FROM pg_stat_activity WHERE pid=$1', [pid])).rows
        state = rows[0]?.state
        if (first) { evidence.backendStateAtLocalSettlement = state ?? 'absent'; first = false }
        if (state === undefined || state === 'idle') break
        await yieldToCarrier()
      }
      evidence.backendSettledAtMs = performance.now() - started
      evidence.backendFinalState = state ?? 'absent'
      expect(state === undefined || state === 'idle').toBe(true)
      expect(performance.now() - started).toBeLessThan(duration + 1000)
      // The lock remains held until after the independent backend observation.
    } finally {
      controller.abort()
      await pending?.catch(() => undefined)
      await blocker.query('ROLLBACK')
      blocker.release()
      const directory = process.env.PE_EMPLOYEE6_SEARCH_EVIDENCE_DIR
      if (directory) await writeFile(join(directory, `pg-active-${mode}-${randomUUID()}.json`), JSON.stringify(evidence, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 })
    }
    expect((await fixture.pool.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }])
  }))
}
