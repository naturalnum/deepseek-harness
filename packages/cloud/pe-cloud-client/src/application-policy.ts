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
  const keys = ['managementOrigin', 'contentOrigin', 'requestTimeoutMs', 'maxRequestBytes', 'maxResponseBytes', 'maxFieldBytes']
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return fail()
  if (typeof row.managementOrigin !== 'string' || typeof row.contentOrigin !== 'string') return fail()
  let management: URL, content: URL
  try { management = new URL(row.managementOrigin); content = new URL(row.contentOrigin) } catch (_invalid) { return fail() }
  if (management.origin !== row.managementOrigin || content.origin !== row.contentOrigin
    || !['http:', 'https:'].includes(content.protocol) || management.protocol !== content.protocol
    || management.hostname === content.hostname || !/^[a-z0-9.-]+$/.test(content.hostname)) return fail()
  for (const key of keys.slice(2)) {
    const value = row[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) return fail()
  }
  return Object.freeze({ managementOrigin: row.managementOrigin, contentOrigin: row.contentOrigin,
    requestTimeoutMs: row.requestTimeoutMs as number, maxRequestBytes: row.maxRequestBytes as number,
    maxResponseBytes: row.maxResponseBytes as number, maxFieldBytes: row.maxFieldBytes as number })
}
