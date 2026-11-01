/** Temporary, Root-owned numerical timings; no request, path, configuration or identity is retained. */
import { performance } from 'node:perf_hooks'

type TimingKey = 'root-full' | 'root-captured' | 'root-plan-api' | 'root-plan-runtime'
  | 'root-plan-access' | 'root-plan-files' | 'root-plan-execution' | 'root-plan-other'
  | 'root-health-auth' | 'root-health-files' | 'root-health-execution'
  | 'account-current' | 'account-plan' | 'file-inventory'
type Bucket = { calls: number; totalUs: number; maxUs: number }
type TimingReport = { nominalIntervalMs: number; rows: readonly (Bucket & { stage: TimingKey })[] }
const keys: readonly TimingKey[] = ['root-full', 'root-captured', 'root-plan-api', 'root-plan-runtime',
  'root-plan-access', 'root-plan-files', 'root-plan-execution', 'root-plan-other',
  'root-health-auth', 'root-health-files', 'root-health-execution', 'account-current', 'account-plan', 'file-inventory']

/** One original Root's optional synchronous guard observations, independent of admission. */
export interface FileReadTiming {
  /**
   * Time one synchronous guard, preserving its return value or original exception.
   * @param key Fixed diagnostic stage; no caller data is used as a label.
   * @param action Original synchronous guard.
   * @returns The original result, or the original exception is rethrown.
   */
  measure<T>(key: TimingKey, action: () => T): T
  /** Flush the tail once and stop collection; later guards still execute normally. */
  close(): void
}

/**
 * Constructed only by the original Root when its trusted config explicitly opts in.
 * @param report Root-owned numerical sink; its failures cannot replace business outcomes.
 * @returns An instance-owned collector with an idempotent close and no request data.
 */
export function createFileReadTiming(report: (value: TimingReport) => void): FileReadTiming {
  let closed = false
  const buckets = new Map<TimingKey, Bucket>(keys.map(key => [key, { calls: 0, totalUs: 0, maxUs: 0 }]))
  const flush = (): void => {
    try {
      const rows = [...buckets].flatMap(([key, value]) => {
        if (value.calls === 0) return []
        const row = { stage: key, ...value }
        value.calls = 0; value.totalUs = 0; value.maxUs = 0
        return [row]
      })
      if (rows.length !== 0) report({ nominalIntervalMs: 5000, rows })
    } catch (_error) { /* Observations cannot change admission. */ }
  }
  const timer = setInterval(flush, 5000)
  timer.unref()
  return Object.freeze({
    measure<T>(key: TimingKey, action: () => T): T {
      if (closed) return action()
      let start: number
      try { start = performance.now() } catch (_error) { return action() }
      try { return action() } finally {
        try {
          const value = buckets.get(key), elapsed = Math.max(0, Math.round((performance.now() - start) * 1000))
          if (value !== undefined && Number.isSafeInteger(elapsed)) {
            value.calls = Math.min(Number.MAX_SAFE_INTEGER, value.calls + 1)
            value.totalUs = Math.min(Number.MAX_SAFE_INTEGER, value.totalUs + elapsed)
            value.maxUs = Math.max(value.maxUs, elapsed)
          }
        } catch (_error) { /* Never replace the original result or failure. */ }
      }
    },
    close(): void {
      if (closed) return
      closed = true
      clearInterval(timer)
      flush()
    },
  })
}
