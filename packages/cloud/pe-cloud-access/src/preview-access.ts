/** Exact service-preview admission within the existing account and execution owners. */
import type { AccountBinding, AccountUse } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { ExactFetchExposure, ExposureManifest } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type { ApplicationReadRequest, ServicePreviewIdentity } from '@deepseek-ai/dsh-pe-opensandbox/types'

/** Untrusted request identity becomes branded only after the ingress JSON parser validates each field. */
export type PreviewSelector = ServicePreviewIdentity
/** Detached application request after platform credentials and destination selectors are removed. */
export type SanitizedPreviewRequest = ApplicationReadRequest
/** Original execution owner's live service capability, retained through actual forwarding settlement. */
export interface RegisteredPreviewService {
  /** Identity projection from the existing execution capability, never authority supplied by a selector. */
  readonly scope: PreviewSelector
  readonly manifest: ExposureManifest
  readonly port: number
  readonly lifetime: AbortSignal
  /** @returns After the original service owner confirms this capability is still current. */
  assertCurrent(): void
  /**
   * Original execution capability: recheck registration/scope/port at actual submission, no retry/redirect.
   * Own transport/body budgets and actual settlement, including abort/stop/unknown. No detached background work.
   * The fixed registered target remains inside this capability. Never add execd/agent keys to the app hop.
   * Lifecycle authentication, if needed, is only for the trusted control hop and must be stripped there.
   * Callers must apply response-header, cookie and redirect policy before browser transfer.
   * @param request Detached application request without platform credentials or target selectors.
   * @param signal Original request and service cancellation observer.
   * @returns Actual forwarding settlement; unfinished or unknown work stays with its original owner.
   */
  forward(request: SanitizedPreviewRequest, signal: AbortSignal): Promise<void>
}
/** Original execution owner's registered-service borrowing; a selector grants no execution authority. */
export interface ExecutionPreviewPort {
  /**
   * Use the original native Session authorization and current registered service/allocation owner.
   * Reject absent/stopping/unknown/stale services; never create a sandbox, service, session or new registry.
   * Retain the existing service/request reservation through actual consume/transport settlement.
   * @param binding Original admitted account graph binding.
   * @param selector Expected identity fields, verified against the original service capability.
   * @param manifest Original immutable exposure manifest.
   * @param signal Original request cancellation observer.
   * @param consume Consumer retained through actual service-request settlement.
   * @returns Actual consumer and transport settlement, retaining unknown work on failure.
   */
  withRegisteredService(binding: AccountBinding, selector: PreviewSelector, manifest: ExposureManifest,
    signal: AbortSignal, consume: (service: RegisteredPreviewService) => Promise<void>): Promise<void>
}
/** Original authenticated ingress operation and its retained account use. */
export interface ExistingPreviewAdmission {
  readonly use: Pick<AccountUse, 'binding' | 'assertCurrent'>
  readonly api: {
    readonly binding: AccountBinding
    /**
     * @param method Exact HTTP method from the admitted request.
     * @param path Exact reviewed ingress pathname.
     * @returns The original account API's audited exposure entry.
     */
    requireFetch(method: string, path: string): ExactFetchExposure
  }
  readonly signal: AbortSignal
  /** @returns After the original ingress confirms operation, login, generation and Root admission. */
  assertCurrent(): void
}
/** Explicit deployment origins, audited route and finite request limits. */
export interface PreviewPolicy {
  readonly manifest: ExposureManifest
  readonly routePath: string
  readonly handlerId: string
  readonly managementOrigin: string
  readonly previewOrigin: string
  readonly allowedServicePorts: readonly number[]
  readonly maxFieldBytes: number
  readonly maxResourceBytes: number
  readonly maxHeaderCount: number
  readonly maxHeaderBytes: number
}
/** Secret-free refusal for preview selection, current ownership or deployment configuration. */
export class PreviewAccessError extends Error {
  /** @param code Stable refusal classification for the original ingress error handler. */
  constructor(readonly code: 'cloud/forbidden' | 'cloud/invalid-config' | 'cloud/account-unavailable') {
    super('Service preview access refused.')
  }
}
function need(ok: unknown, code: PreviewAccessError['code'] = 'cloud/forbidden'): asserts ok {
  if (!ok) throw new PreviewAccessError(code)
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value))
  const prototype: unknown = Object.getPrototypeOf(value)
  need(prototype === Object.prototype || prototype === null)
  for (const key in value) need(Object.hasOwn(value, key) && keys.includes(key))
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    need(descriptor !== undefined && 'value' in descriptor)
  }
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number): string {
  need(typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u0020\u007f]/u.test(value) && Buffer.byteLength(value) <= maximum)
  return value
}
function fixedOrigin(value: string): URL {
  const url = new URL(value)
  need((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value,
    'cloud/invalid-config')
  return url
}
const scopeKeys = ['accountId', 'epoch', 'sessionId', 'allocationId', 'serviceId'] as const
const passedHeaders = new Set(['accept', 'accept-language', 'if-none-match', 'if-modified-since', 'range'])
function headers(value: unknown, policy: PreviewPolicy): SanitizedPreviewRequest['headers'] {
  need(Array.isArray(value) && value.length <= policy.maxHeaderCount)
  const rows: Array<readonly [string, string]> = [], hop = new Set<string>()
  let bytes = 0
  for (const row of value) {
    need(Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string')
    const name: string = row[0], content: string = row[1]
    need(name.length <= policy.maxHeaderBytes && content.length <= policy.maxHeaderBytes
      && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && /^[\x20-\x7e]*$/.test(content))
    bytes += Buffer.byteLength(name) + Buffer.byteLength(content) + 4
    need(bytes <= policy.maxHeaderBytes)
    const lower = name.toLowerCase()
    if (lower === 'connection') {
      for (const token of content.split(',')) {
        const key = token.trim().toLowerCase(); need(/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key)); hop.add(key)
      }
    }
    rows.push([lower, content])
  }
  const selected = rows.filter(([name]) => passedHeaders.has(name) && !hop.has(name))
  need(new Set(selected.map(([name]) => name)).size === selected.length)
  return Object.freeze(selected.map(row => Object.freeze(row)))
}
function request(input: unknown, policy: PreviewPolicy): { scope: PreviewSelector; safe: SanitizedPreviewRequest; method: string } {
  const value = record(input, ['origin', 'method', 'pathname', 'scope', 'resourcePath', 'headers'])
  need(value.origin === policy.previewOrigin && value.pathname === policy.routePath
    && (value.method === 'GET' || value.method === 'HEAD'))
  const selected = record(value.scope, scopeKeys)
  const scope: PreviewSelector = Object.freeze({
    accountId: text(selected.accountId, policy.maxFieldBytes) as PreviewSelector['accountId'],
    epoch: text(selected.epoch, policy.maxFieldBytes) as PreviewSelector['epoch'],
    sessionId: text(selected.sessionId, policy.maxFieldBytes) as PreviewSelector['sessionId'],
    allocationId: text(selected.allocationId, policy.maxFieldBytes) as PreviewSelector['allocationId'],
    serviceId: text(selected.serviceId, policy.maxFieldBytes) as PreviewSelector['serviceId'],
  })
  const path = text(value.resourcePath, policy.maxResourceBytes)
  need(path.startsWith('/') && !path.startsWith('//') && !/[\\#]/.test(path))
  const url = new URL(path, 'http://application.invalid')
  need(url.origin === 'http://application.invalid' && url.pathname + url.search === path
    && !/%(?:25|2f|5c)/i.test(url.pathname))
  return { scope, method: value.method, safe: Object.freeze({ method: value.method, resourcePath: path,
    headers: headers(value.headers, policy) }) }
}
/**
 * Forward an approved GET/HEAD within the original authenticated account operation.
 * @param input Untrusted HTTP selection, path and headers.
 * @param admission Original account use and expected-generation checks.
 * @param policy Fixed audited route, separate origin and finite limits.
 * @param execution Original registered-service owner; selection grants no authority.
 * @returns Actual forwarding settlement; cancellation does not release unfinished work.
 */
export async function forwardAuthorizedPreview(input: unknown, admission: ExistingPreviewAdmission,
  policy: PreviewPolicy, execution: ExecutionPreviewPort): Promise<void> {
  const management = fixedOrigin(policy.managementOrigin), preview = fixedOrigin(policy.previewOrigin)
  // Distinct hosts also avoid the false assumption that browser cookies are isolated by port.
  need(management.origin !== preview.origin && management.hostname !== preview.hostname, 'cloud/invalid-config')
  for (const key of ['maxFieldBytes', 'maxResourceBytes', 'maxHeaderCount', 'maxHeaderBytes'] as const) {
    need(Number.isSafeInteger(policy[key]) && policy[key] > 0 && policy[key] <= 65536, 'cloud/invalid-config')
  }
  need(policy.allowedServicePorts.length > 0 && policy.allowedServicePorts.length <= 16
    && new Set(policy.allowedServicePorts).size === policy.allowedServicePorts.length
    && policy.allowedServicePorts.every(port => Number.isInteger(port) && port >= 1024 && port <= 65535), 'cloud/invalid-config')
  const { scope, safe, method } = request(input, policy), binding = admission.use.binding
  const signal = AbortSignal.any([admission.signal, binding.lifetime])
  const row = policy.manifest.exactFetchRoutes.find(entry => entry.method === method && entry.path === policy.routePath)
  need(row !== undefined && row.handlerId === policy.handlerId && row.guard === 'account-session')
  const current = (): void => {
    signal.throwIfAborted(); admission.assertCurrent(); admission.use.assertCurrent()
    need(admission.api.binding === binding && policy.manifest.recipeVersion === binding.recipeVersion,
      'cloud/account-unavailable')
    need(scope.accountId === binding.accountId && scope.epoch === binding.epoch)
    const actual = admission.api.requireFetch(method, policy.routePath)
    need(actual.method === row.method && actual.path === row.path && actual.handlerId === row.handlerId
      && actual.guard === row.guard)
  }
  current()
  await execution.withRegisteredService(binding, scope, policy.manifest, signal, async (service) => {
    const serviceSignal = AbortSignal.any([signal, service.lifetime])
    const registeredCurrent = (): void => {
      current(); serviceSignal.throwIfAborted(); service.assertCurrent()
      need(service.manifest === policy.manifest && scopeKeys.every(key => service.scope[key] === scope[key])
        && policy.allowedServicePorts.includes(service.port))
    }
    registeredCurrent()
    await service.forward(safe, serviceSignal)
    registeredCurrent()
  })
  current()
}
