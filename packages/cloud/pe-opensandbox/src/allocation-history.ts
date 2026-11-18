/** Root-owned read projection used by the bounded Access allocation diagnostics. */
import type { RootMetadataDatabase } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { allocationDatabase } from './allocation-database.ts'
import { PROVIDER_CREATE_REFUSAL_CODE, PROVIDER_EXECUTION_REJECTION_CODE } from './bootstrap/recovery-witness.ts'

const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000
const MAX_LIMIT = 51
const MAX_DATE_MS = Date.parse('9999-12-31T23:59:59.999Z')
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const safeReasons = Object.freeze([
  'cancelled-before-provider-create', 'startup-expired', PROVIDER_CREATE_REFUSAL_CODE, PROVIDER_EXECUTION_REJECTION_CODE,
] as const)
type SafeReason = typeof safeReasons[number]

interface Selection {
  readonly accountId: string
  readonly sessionId: string
  readonly fromMs: number
  readonly toMs: number
  readonly limit: number
}

/** Read the bounded durable history for one already-authorized Account and Session. */
export type AllocationHistoryReader = (selection: Readonly<Selection>) => Promise<readonly AllocationHistoryRow[]>

/** Last durable observation of the original allocation, with closed reason projection. */
export interface AllocationHistoryRow {
  readonly accountId: string
  readonly sessionId: string
  readonly allocationId: string
  readonly lastCheckedAt: string
  readonly state: 'failed' | 'released' | 'uncertain' | 'stopping'
  readonly failureCode: SafeReason | null
}

const sql = `SELECT account_id AS "accountId", session_id AS "sessionId", allocation_id AS "allocationId",
  to_char(last_checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastCheckedAt",
  state, CASE WHEN failure_code IN ($6,$7,$8,$9) THEN failure_code ELSE NULL END AS "failureCode"
FROM public.pe_sandbox_allocations
WHERE account_id=$1 AND session_id=$2 AND last_checked_at >= $3::timestamptz AND last_checked_at < $4::timestamptz
  AND (state IN ('failed','released') OR (state IN ('uncertain','stopping') AND failure_code IS NOT NULL))
ORDER BY date_trunc('milliseconds', last_checked_at) DESC, allocation_id COLLATE "C" ASC
LIMIT $5::integer`

function isReason(value: unknown): value is SafeReason {
  return safeReasons.some(reason => value === reason)
}

function decode(value: unknown, selection: Selection): AllocationHistoryRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid allocation history row.')
  const { accountId, sessionId, allocationId, lastCheckedAt, state, failureCode } = value as Record<string, unknown>
  const at = typeof lastCheckedAt === 'string' ? Date.parse(lastCheckedAt) : NaN
  if (accountId !== selection.accountId || sessionId !== selection.sessionId
    || typeof allocationId !== 'string' || !identifier.test(allocationId)
    || typeof lastCheckedAt !== 'string' || !(at >= selection.fromMs && at < selection.toMs)
    || new Date(at).toISOString() !== lastCheckedAt
    || (state !== 'failed' && state !== 'released' && state !== 'uncertain' && state !== 'stopping')
    || (failureCode !== null && !isReason(failureCode))) {
    throw new Error('Invalid allocation history row.')
  }
  return Object.freeze({ accountId: selection.accountId, sessionId: selection.sessionId, allocationId, lastCheckedAt, state, failureCode })
}

/**
 * Bind one bounded reader to the original registered allocation owner.
 * @param database Root-issued metadata capability with actual queue, connection, statement and lock budgets.
 * @param maxInFlight Positive limit for this diagnostic reader's actual statements; no waiting queue is introduced.
 * @returns A single-statement read callback for the Access adapter's already-verified account and Session.
 */
export function allocationHistoryReader(
  database: RootMetadataDatabase, maxInFlight: number,
): AllocationHistoryReader {
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new RangeError('Invalid allocation history concurrency.')
  const driver = allocationDatabase(database)
  let inFlight = 0
  return async (input) => {
    const selection = { ...input }
    const { accountId, sessionId, fromMs, toMs, limit } = selection
    if (!identifier.test(accountId) || !identifier.test(sessionId)
      || !Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0
      || fromMs >= toMs || toMs > MAX_DATE_MS || toMs - fromMs > MAX_WINDOW_MS
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('Invalid allocation history scope.')
    if (inFlight >= maxInFlight) throw new Error('Allocation history concurrency is full.')
    inFlight++
    try {
      const { rows } = await driver.query(sql, [accountId, sessionId, new Date(fromMs).toISOString(),
        new Date(toMs).toISOString(), String(limit), ...safeReasons])
      if (!Array.isArray(rows) || rows.length > limit) throw new Error('Invalid allocation history row count.')
      const result: AllocationHistoryRow[] = []
      const seen = new Set<string>()
      for (const value of rows) {
        const row = decode(value, selection)
        const previous = result.at(-1)
        if (seen.has(row.allocationId) || previous !== undefined && (row.lastCheckedAt > previous.lastCheckedAt
          || row.lastCheckedAt === previous.lastCheckedAt && row.allocationId <= previous.allocationId)) {
          throw new Error('Invalid allocation history order.')
        }
        seen.add(row.allocationId)
        result.push(row)
      }
      return Object.freeze(result)
    } finally { inFlight-- }
  }
}
