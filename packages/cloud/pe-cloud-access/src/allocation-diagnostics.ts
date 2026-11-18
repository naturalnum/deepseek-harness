/** Read-only diagnostics boundary for persisted sandbox allocation observations. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AuthenticatedPrincipal } from './types.ts'
import type { AccountRole } from './account-administration.ts'
import { AuthAccessError } from './auth-error.ts'

type RequestId = Branded<'pe-request-id'>

const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000
const MAX_ROWS = 50
const MAX_DATE_MS = Date.parse('9999-12-31T23:59:59.999Z')
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const reasons = {
  'cancelled-before-provider-create': 'before-provider-create',
  'startup-expired': 'startup-recovery',
  'provider-create-refused-before-create': 'provider-create',
  'provider-rejected-before-execution-resource': 'provider-execution',
} as const

type Reason = keyof typeof reasons
type AllocationState = 'creating' | 'ready' | 'uncertain' | 'stopping' | 'failed' | 'released'

interface Selection {
  readonly accountId: string
  readonly sessionId: string
  readonly fromMs: number
  readonly toMs: number
  readonly limit: number
}

/** Projection of the original allocation row. The timestamp is the last durable observation. */
export interface AllocationDiagnosticRow {
  readonly accountId: string
  readonly sessionId: string
  readonly allocationId: string
  readonly lastCheckedAt: string
  readonly state: AllocationState
  readonly failureCode: string | null
}

interface AllocationDiagnostic {
  readonly accountId: string
  readonly sessionId: string
  readonly allocationId: string
  readonly observedAt: string
  readonly state: AllocationState
  readonly reasonCode: Reason | null
  readonly stage: typeof reasons[Reason] | null
}

interface Dependencies {
  /** Recheck the original login and authorization for both requested identities. */
  authorize(selection: Readonly<Pick<Selection, 'accountId' | 'sessionId'>>): Promise<{
    readonly role: AccountRole
    readonly actorId: string
    readonly authSessionId: string
    readonly accountId: string
    readonly sessionId: string
  } | null>
  /** Filter before reading and cap at limit rows, ordered by last observation descending then allocation id ascending. */
  read(selection: Readonly<Selection>): Promise<readonly AllocationDiagnosticRow[]>
}

/** Root authorization owner for private diagnostics. */
export interface AllocationDiagnosticsAuthority {
  /**
   * Check the authenticated administrator's grant and the exact durable Account/Session relationship.
   * @param actor Original verified Access login.
   * @param target Account and Session selected by the administrator.
   * @param signal Request cancellation. Read metadata without mounting or starting the target.
   * @returns Whether the exact target is currently eligible for this actor.
   */
  allows(actor: AuthenticatedPrincipal, target: Readonly<Pick<Selection, 'accountId' | 'sessionId'>>, signal: AbortSignal): Promise<boolean>
}

/** Package-private combination of the authorization owner and the original execution reader. */
export interface AllocationDiagnosticsPort extends AllocationDiagnosticsAuthority {
  /** Bounded read from the original Root-owned allocation history. */
  read: Dependencies['read']
}

function parse(input: unknown, requestId: RequestId): Readonly<Selection> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new AuthAccessError('cloud/forbidden', requestId)
  const { accountId, sessionId, fromMs, toMs, limit } = input as Record<string, unknown>
  if (Object.keys(input).length !== 5
    || typeof accountId !== 'string' || !identifier.test(accountId)
    || typeof sessionId !== 'string' || !identifier.test(sessionId)
    || typeof fromMs !== 'number' || !Number.isSafeInteger(fromMs) || fromMs < 0
    || typeof toMs !== 'number' || !Number.isSafeInteger(toMs) || toMs > MAX_DATE_MS
    || fromMs >= toMs || toMs - fromMs > MAX_WINDOW_MS
    || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS) {
    throw new AuthAccessError('cloud/forbidden', requestId)
  }
  return Object.freeze({ accountId, sessionId, fromMs, toMs, limit })
}

function isReason(value: string | null): value is Reason {
  return value !== null && Object.hasOwn(reasons, value)
}

/**
 * Return terminal and refusal observations for an explicitly authorized account and Session.
 * @param input Untrusted parsed request with a half-open UTC millisecond range and a bounded row limit.
 * @param requestId Original server request correlation used only in public errors.
 * @param dependencies Original login/Session authority and a filtered, read-only source of durable allocation rows.
 * @returns Redacted rows and whether at least one more matching record exists.
 */
export async function queryAllocationDiagnostics(
  input: unknown, requestId: RequestId, dependencies: Dependencies,
): Promise<Readonly<{ entries: readonly AllocationDiagnostic[]; more: boolean }>> {
  const selection = parse(input, requestId)
  const target = Object.freeze({ accountId: selection.accountId, sessionId: selection.sessionId })
  const check = async () => {
    const actor = await dependencies.authorize(target)
    if (actor === null) throw new AuthAccessError('cloud/unauthenticated', requestId)
    if (actor.role !== 'admin' || actor.accountId !== target.accountId || actor.sessionId !== target.sessionId) {
      throw new AuthAccessError('cloud/forbidden', requestId)
    }
    return actor
  }
  const { actorId, authSessionId } = await check()
  const readSelection = Object.freeze({ ...selection, limit: selection.limit + 1 })
  let rows: readonly AllocationDiagnosticRow[]
  try { rows = await dependencies.read(readSelection) }
  catch (_sourceFailure) { throw new AuthAccessError('cloud/account-unavailable', requestId) }
  const current = await check()
  if (current.actorId !== actorId || current.authSessionId !== authSessionId) {
    throw new AuthAccessError('cloud/unauthenticated', requestId)
  }
  if (rows.length > readSelection.limit) throw new AuthAccessError('cloud/account-unavailable', requestId)
  const entries: AllocationDiagnostic[] = []
  const seen = new Set<string>()
  let previousTime = Infinity
  let previousId = ''
  for (const row of rows) {
    if (row.accountId !== target.accountId || row.sessionId !== target.sessionId) {
      throw new AuthAccessError('cloud/forbidden', requestId)
    }
    const at = Date.parse(row.lastCheckedAt)
    if (!identifier.test(row.allocationId) || seen.has(row.allocationId) || !Number.isSafeInteger(at)
      || new Date(at).toISOString() !== row.lastCheckedAt || at < selection.fromMs || at >= selection.toMs
      || at > previousTime || (at === previousTime && row.allocationId <= previousId)
      || (row.state !== 'uncertain' && row.state !== 'stopping' && row.state !== 'failed' && row.state !== 'released')) {
      throw new AuthAccessError('cloud/account-unavailable', requestId)
    }
    seen.add(row.allocationId)
    previousTime = at
    previousId = row.allocationId
    const reasonCode = isReason(row.failureCode) ? row.failureCode : null
    entries.push(Object.freeze({ ...target, allocationId: row.allocationId, observedAt: row.lastCheckedAt,
      state: row.state, reasonCode, stage: reasonCode === null ? null : reasons[reasonCode] }))
  }
  return Object.freeze({ entries: Object.freeze(entries.slice(0, selection.limit)), more: entries.length > selection.limit })
}
