/** Bounded private diagnostics; the original startup owner retains every result and cleanup. */
export type StartupPhase = 'prepare' | 'storage-prepare' | 'storage-before-read' | 'nativeboot' | 'required-entry' | 'audit-provider'
  | 'bootstrap-policy' | 'nativeinventory' | 'ready'

/** Original-owner notification; no Context, capability, or readiness value is carried. */
export type StartupObservation =
  | Readonly<{ phase: StartupPhase }>
  | Readonly<{ settled: true }>
  | Readonly<{ expired: true }>
  | Readonly<{ nativeError: unknown }>
  | Readonly<{ failure: unknown; requiredEntryId?: string }>

/** Private callback supplied by the original startup owner, never Loader or request JSON. */
export type StartupObserver = (observation: StartupObservation) => void

const codes = new Set([
  'cloud/invalid-config', 'cloud/capacity', 'cloud/account-starting', 'cloud/account-unavailable',
  'cloud/account-quarantined', 'cloud/stop-unconfirmed', 'cloud/config-conflict', 'cloud/config-busy',
  'cloud/stale-generation', 'cloud/forbidden', 'cloud/model-not-allowed', 'cloud/invalid-project-title',
  'ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ETIMEDOUT', 'ECONNREFUSED', 'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', '23505', '40001', '40P01', '55P03', '57014',
])
const names = new Set([
  'Error', 'TypeError', 'SyntaxError', 'AggregateError', 'StartupError', 'AccountRuntimeError',
  'CloudApiError', 'OwnerPgNotSubmittedError', 'AccountMountPrerequisiteError',
])

function data(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch (_cause) { return undefined } // A diagnostic must not invoke accessors or replace the original failure.
}

function approved(value: unknown, ids: ReadonlySet<string>): string | undefined {
  if (typeof value !== 'string') return undefined
  if (ids.has(value)) return value
  if (value.startsWith('include:') && ids.has(value.slice(8))) return value.slice(8)
  return undefined
}

/**
 * Contain an optional observer without changing the original operation or cause.
 * @param observer Original startup owner's private callback.
 * @param observation Fixed phase or the original failure, retained only by the caller.
 */
export function observeStartup(observer: StartupObserver | undefined, observation: StartupObservation): void {
  try { observer?.(observation) }
  catch (_cause) { /* Observation failure cannot change startup, settlement, or cleanup. */ }
}

/**
 * Emit at most one fixed JSON record through private stderr for this original startup.
 * @param requiredIds Original Root-approved required entry ids; diagnostics examine at most 512.
 * @param write Private sink; omission uses stderr. A sink failure never retries or replaces the original result.
 * @returns A bounded callback owning no account state, work, retry, or release authority.
 */
export function startupFailureObserver(
  requiredIds: readonly string[], write: (record: string) => void = (record) => { console.error(record) },
): StartupObserver {
  const ids = new Set(requiredIds.slice(0, 512).filter(id => /^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(id)))
  let phase: StartupPhase = 'prepare', recorded = false
  return (observation) => {
    if ('settled' in observation) { recorded = true; return }
    if ('phase' in observation) { phase = observation.phase; return }
    if (recorded) return
    recorded = true
    try {
      if ('expired' in observation) {
        write(JSON.stringify({ kind: 'observation-expired', phase, causes: [] }))
        return
      }
      const failure = 'nativeError' in observation ? observation.nativeError : observation.failure
      let entry = approved('requiredEntryId' in observation ? observation.requiredEntryId : undefined, ids)
      const entries = data(failure, 'entries'), count = data(entries, 'length')
      if (entry === undefined && Array.isArray(entries) && typeof count === 'number') {
        for (let i = 0; i < Math.min(count, 512); i++) {
          entry = approved(data(data(entries, String(i)), 'id'), ids)
          if (entry !== undefined) break
        }
      }
      const causes: { code: string; name: string }[] = []
      let current: unknown = failure
      for (let i = 0; i < 3; i++) {
        const code = data(current, 'code'), name = data(current, 'name')
        causes.push({ code: typeof code === 'string' && codes.has(code) ? code : 'unknown',
          name: typeof name === 'string' && names.has(name) ? name : 'unknown' })
        const errors = data(current, 'errors')
        const next = data(current, 'cause') ?? (Array.isArray(errors) ? data(errors, '0') : undefined)
        if (next === undefined) break
        current = next
      }
      const kind = 'nativeError' in observation ? 'native-error-event' : 'cloud/startup-failure'
      const record = JSON.stringify({ kind, phase, ...entry === undefined ? {} : { requiredEntryId: entry }, causes })
      if (Buffer.byteLength(record, 'utf8') <= 512) write(record)
    } catch (_cause) { /* Private diagnostic transport must not alter the original startup failure. */ }
  }
}
