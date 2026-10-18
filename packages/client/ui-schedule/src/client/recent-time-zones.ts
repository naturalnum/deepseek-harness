/** Browser-local recently selected IANA time zones. */
import { resolveClientPersistence, type ClientPersistence } from '@deepseek-ai/dsh-client-store'

const STORAGE_KEY = 'dsh.schedule.recent-time-zones.v1'
const LIMIT = 5

/** First-run choices follow the device rather than guessing location from UI language. */
function defaults(system: string): readonly string[] {
  return [...new Set([system, 'UTC'])]
}

/**
 * Load up to five recent zones, or the system-zone/UTC first-run seed.
 * @param system - the host's current IANA zone.
 * @param persistence - captured page port; omitted uses ordinary browser storage.
 * @returns recent IANA zones in most-recent-first order.
 */
export function loadRecentTimeZones(system: string, persistence?: ClientPersistence): readonly string[] {
  const raw = resolveClientPersistence(persistence).getItem(STORAGE_KEY)
  try {
    if (raw === null) return defaults(system)
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return defaults(system)
    const zones = [...new Set(parsed.filter((value): value is string => typeof value === 'string' && value !== ''))]
    return zones.length === 0 ? defaults(system) : zones.slice(0, LIMIT)
  } catch {
    return defaults(system)
  }
}

/**
 * Promote one exact IANA id and persist the bounded list when storage is available.
 * @param recent - current most-recent-first IANA zones.
 * @param zone - exact IANA zone to promote.
 * @param persistence - captured page port; omitted uses ordinary browser storage.
 * @returns the updated bounded most-recent-first list.
 */
export function rememberTimeZone(recent: readonly string[], zone: string, persistence?: ClientPersistence): readonly string[] {
  const next = [zone, ...recent.filter(value => value !== zone)].slice(0, LIMIT)
  resolveClientPersistence(persistence).setItem(STORAGE_KEY, JSON.stringify(next))
  return next
}
