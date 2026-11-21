/** Browser-safe fixed-origin policy for the original Root's service-content launch protocol. */
import type { CloudServiceApplicationPolicy } from './types.ts'

/**
 * Validate public content origins and explicit handoff bounds, without accepting identity or credentials.
 * @param input Original public deployment manifest value.
 * @returns Detached immutable policy; Root separately enforces login, Cookie domain and service authorization.
 */
export function parseServiceApplicationPolicy(input: unknown): Readonly<CloudServiceApplicationPolicy> {
  const fail = (): never => { throw new TypeError('Invalid service application policy') }
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail()
  const row = input as Record<string, unknown>
  const numbers = ['requestTimeoutMs', 'maxRequestBytes', 'maxResponseBytes', 'maxFieldBytes'] as const
  const ip = row.mode === 'ip-render'
  const keys = ['managementOrigin', ip ? 'mode' : 'contentOrigin', ...numbers]
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return fail()
  if (typeof row.managementOrigin !== 'string') return fail()
  let management: URL
  try { management = new URL(row.managementOrigin) } catch (_invalid) { return fail() }
  if (management.origin !== row.managementOrigin) return fail()
  for (const key of numbers) {
    const value = row[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) return fail()
  }
  const limits = { managementOrigin: row.managementOrigin,
    requestTimeoutMs: row.requestTimeoutMs as number, maxRequestBytes: row.maxRequestBytes as number,
    maxResponseBytes: row.maxResponseBytes as number, maxFieldBytes: row.maxFieldBytes as number }
  if (ip) {
    const octets = management.hostname.split('.')
    if (management.protocol !== 'https:' || octets.length !== 4
      || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return fail()
    return Object.freeze({ ...limits, mode: 'ip-render' })
  }
  if (typeof row.contentOrigin !== 'string') return fail()
  let content: URL
  try { content = new URL(row.contentOrigin) } catch (_invalid) { return fail() }
  if (content.origin !== row.contentOrigin || !['http:', 'https:'].includes(content.protocol)
    || management.protocol !== content.protocol || management.hostname === content.hostname
    || !/^[a-z0-9.-]+$/.test(content.hostname)) return fail()
  return Object.freeze({ ...limits, contentOrigin: row.contentOrigin })
}
