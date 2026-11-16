/** Dedicated service-content transport parsing; selectors come only from the original preview credential. */
import type { IncomingMessage } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExactFetchExposure } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type { ApplicationHttpRequest, ApplicationServiceSelection } from '@deepseek-ai/dsh-pe-opensandbox/types'
import type { AccessConfig } from './types.ts'
import type { ServiceApplicationConfig } from './application-policy.ts'
import { serviceApplicationOrigin } from './application-policy.ts'
import { AuthAccessError } from './auth-error.ts'
import { OWNER_HOP_HEADER } from './owner-hop.ts'

/** Actual account-authorized management registration issuing a scoped service-content credential. */
export const SERVICE_APPLICATION_LAUNCH_ROUTE: ExactFetchExposure = Object.freeze({ method: 'POST',
  path: '/cloud/service-application', handlerId: 'cloud:serviceApplication', guard: 'account-session' })
/** Reserved private proof handoff on the dedicated content listener. */
export const SERVICE_APPLICATION_AUTHORIZE_PATH = '/.well-known/dsh-service-preview/authorize'
/** Reserved credential confirmation before opening the clean Browser URL. */
export const SERVICE_APPLICATION_READY_PATH = '/.well-known/dsh-service-preview/ready'
/** Host-only credential name; it is never forwarded to the selected SDK or tenant. */
export const SERVICE_APPLICATION_COOKIE = 'dsh-service-preview'

const headersAllowed = new Set(['accept', 'accept-language', 'if-none-match', 'if-modified-since', 'range', 'content-type'])
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Parse only the management operation's two selectors; identity remains the original Cookie and C02 binding.
 * @param input Bounded JSON body decoded by the original ingress.
 * @param maximum Original Root field-byte limit.
 * @param requestId Original management request id.
 * @returns Session/service selection, never an allocation or destination.
 */
export function readApplicationSelection(input: unknown, maximum: number, requestId: AuthAccessError['requestId']): ApplicationServiceSelection {
  const fail = (): never => { throw new AuthAccessError('cloud/forbidden', requestId) }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail()
  const row = input as Record<string, unknown>
  if (Object.keys(row).length !== 2 || typeof row.sessionId !== 'string' || typeof row.serviceHandle !== 'string') return fail()
  const sessionId = row.sessionId, serviceHandle = row.serviceHandle
  if (sessionId.length === 0 || /[\u0000-\u0020\u007f]/u.test(sessionId) || Buffer.byteLength(sessionId) > maximum
    || !/^[A-Za-z0-9_-]{1,64}$/.test(serviceHandle) || Buffer.byteLength(serviceHandle) > maximum) return fail()
  return { sessionId: brandString<ApplicationServiceSelection['sessionId']>(sessionId),
    serviceId: brandString<ApplicationServiceSelection['serviceId']>(serviceHandle) }
}

/** Parsed original content request; no field can select a backend, account, Session or port. */
export interface ServiceApplicationRequest {
  readonly id: string
  readonly origin: string
  readonly path: string
  readonly headers: ApplicationHttpRequest['headers']
  readonly control: 'authorize' | 'ready' | undefined
}

/**
 * Validate the exact content Host, direct transport, canonical service path and finite headers before credential lookup.
 * @param request Original Node request on the isolated Native WebServer.
 * @param config Root service-content policy.
 * @param access Original parsed authentication policy.
 * @param requestId Original ingress request id.
 * @returns Bounded wire inputs for this public view id; authentication remains with the original view/login owner.
 */
export function readServiceApplicationRequest(request: IncomingMessage, config: ServiceApplicationConfig,
  access: AccessConfig, requestId: AuthAccessError['requestId']): ServiceApplicationRequest {
  const fail = (): never => { throw new AuthAccessError('cloud/forbidden', requestId) }
  const host = request.headers.host, raw = request.url
  if (host === undefined || raw === undefined || Buffer.byteLength(raw) > config.maxUrlBytes
    || request.rawHeaders.length % 2 !== 0 || request.rawHeaders.length / 2 > config.maxRequestHeaderCount) return fail()
  const id = host.slice(0, 32)
  if (!/^[a-f0-9]{32}$/.test(id)) return fail()
  const origin = serviceApplicationOrigin(config, id), expected = new URL(origin)
  if (host !== expected.host || ('encrypted' in request.socket && request.socket.encrypted === true) !== (expected.protocol === 'https:')) return fail()
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\#\u0000-\u0020\u007f]/u.test(raw)) return fail()
  const url = new URL(raw, origin)
  if (url.origin !== origin || url.pathname + url.search !== raw || Buffer.byteLength(url.pathname) > config.maxPathBytes
    || /%(?:25|2f|5c)/i.test(url.pathname)) return fail()
  const control = url.pathname === SERVICE_APPLICATION_AUTHORIZE_PATH ? 'authorize'
    : url.pathname === SERVICE_APPLICATION_READY_PATH ? 'ready' : undefined
  let bytes = 0, hostCount = 0, originCount = 0
  const selected: Array<readonly [string, string]> = [], seen = new Set<string>()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const rawName = request.rawHeaders[index], value = request.rawHeaders[index + 1]
    if (rawName === undefined || value === undefined || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName)
      || !/^[\x20-\x7e]*$/.test(value)) return fail()
    bytes += Buffer.byteLength(rawName) + Buffer.byteLength(value) + 4
    if (bytes > config.maxRequestHeaderBytes) return fail()
    const name = rawName.toLowerCase()
    if (name === 'host') hostCount++
    if (name === 'origin') originCount++
    if (name === 'forwarded' || name.startsWith('x-forwarded-') || name === OWNER_HOP_HEADER
      || name === 'authorization' || name === 'proxy-authorization' || name === 'upgrade' || name.startsWith('sec-websocket-')
      || name === 'connection' && /(?:^|,)\s*upgrade\s*(?:,|$)/i.test(value)) return fail()
    if (headersAllowed.has(name)) {
      if (seen.has(name)) return fail()
      seen.add(name); selected.push([name, value])
    }
  }
  if (hostCount !== 1 || originCount > 1) return fail()
  const suppliedOrigin = request.headers.origin
  if (control !== undefined) {
    if (url.search !== '' || suppliedOrigin !== access.publicOrigin
      || !(request.method === 'OPTIONS' || control === 'authorize' && request.method === 'POST'
        || control === 'ready' && request.method === 'GET')) return fail()
  } else if (request.method === undefined || !methods.has(request.method)
    || suppliedOrigin !== undefined && suppliedOrigin !== origin
    || request.method !== 'GET' && suppliedOrigin !== origin) return fail()
  return { id, origin, path: raw, headers: selected, control }
}

/**
 * Read only the one reserved credential; duplicate or malformed copies never authenticate.
 * @param request Original bounded content request.
 * @param requestId Original ingress request id.
 * @returns Private host-only cookie value; callers must never log or forward it.
 */
export function readServiceApplicationCookie(request: IncomingMessage, requestId: AuthAccessError['requestId']): string {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(SERVICE_APPLICATION_COOKIE + '='))
  const value = values[0]?.slice(SERVICE_APPLICATION_COOKIE.length + 1)
  if (values.length !== 1 || value === undefined || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AuthAccessError('cloud/unauthenticated', requestId)
  }
  return value
}
