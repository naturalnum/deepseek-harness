/** Fixed public GET navigation policy; parsing provides no origin, login or service authority. */
import type { CloudServicePreviewPolicy } from './types.ts'

/**
 * Validate the fixed preview route, distinct HTTP(S) origins and explicit byte limits without authorizing access.
 * @param input Root public manifest value.
 * @returns Detached frozen exact GET policy, or throws for incomplete data.
 */
export function parseServicePreviewPolicy(input: unknown): Readonly<CloudServicePreviewPolicy> {
  const keys = ['managementOrigin', 'previewOrigin', 'routePath', 'maxFieldBytes', 'maxUrlBytes'] as const
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid preview navigation policy')
  const prototype: unknown = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Invalid preview navigation policy')
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError('Invalid preview navigation policy')
  const managementOrigin = value.managementOrigin, previewOrigin = value.previewOrigin, routePath = value.routePath
  const maxFieldBytes = value.maxFieldBytes, maxUrlBytes = value.maxUrlBytes
  if (typeof managementOrigin !== 'string' || typeof previewOrigin !== 'string' || typeof routePath !== 'string'
    || typeof maxFieldBytes !== 'number' || !Number.isSafeInteger(maxFieldBytes) || maxFieldBytes < 1
    || typeof maxUrlBytes !== 'number' || !Number.isSafeInteger(maxUrlBytes) || maxUrlBytes < 1) throw new TypeError('Invalid preview navigation policy')
  let management: URL, preview: URL
  try { management = new URL(managementOrigin); preview = new URL(previewOrigin) }
  catch (_error) { throw new TypeError('Invalid preview navigation policy') }
  if (management.origin !== managementOrigin || preview.origin !== previewOrigin
    || !['http:', 'https:'].includes(management.protocol) || preview.protocol !== management.protocol
    || management.hostname === preview.hostname || routePath !== '/cloud/service-preview') {
    throw new TypeError('Invalid preview navigation policy')
  }
  return Object.freeze({ managementOrigin, previewOrigin, routePath, maxFieldBytes, maxUrlBytes })
}
