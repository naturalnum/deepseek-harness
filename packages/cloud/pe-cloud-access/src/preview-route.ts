/** Fixed service-preview routing and bounded task selection; authentication stays with the original ingress. */
import type { IncomingMessage } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExactFetchExposure } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type { ApplicationReadRequest, ApplicationServiceSelection } from '@deepseek-ai/dsh-pe-opensandbox/types'
import { AuthAccessError } from './auth-error.ts'
import type { AccessConfig } from './types.ts'
import type { ServicePreviewIngressLimits } from './root-config.ts'

/** Protocol-fixed read entry; it accepts no application path, server or port selector. */
export const SERVICE_PREVIEW_ROUTE: ExactFetchExposure = Object.freeze({ method: 'GET', path: '/cloud/service-preview',
  handlerId: 'cloud:servicePreview', guard: 'account-session' })

/**
 * Parse only the task selection and bounded original headers; values confer no identity or execution authority.
 * @param request Original HTTP request, whose transport is independently checked by ingress and authentication.
 * @param config Validated fixed deployment origin and dedicated C02 field names.
 * @param limits Explicit preview input limits.
 * @param requestId Original server correlation id.
 * @returns Native Session/service identifiers and original header pairs for the existing sanitizer.
 */
export function readServicePreviewSelection(request: IncomingMessage, config: AccessConfig,
  limits: ServicePreviewIngressLimits, requestId: AuthAccessError['requestId']): {
  readonly selection: ApplicationServiceSelection
  readonly headers: ApplicationReadRequest['headers']
} {
  function refuse(): never { throw new AuthAccessError('cloud/forbidden', requestId) }
  const preview = config.servicePreview, raw = request.url
  if (preview === undefined || request.method !== 'GET' || raw === undefined || raw.length > limits.maxUrlBytes
    || Buffer.byteLength(raw) > limits.maxUrlBytes || request.headers['transfer-encoding'] !== undefined
    || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') refuse()
  const url = new URL(raw, preview.origin)
  if (url.origin !== preview.origin || url.pathname !== SERVICE_PREVIEW_ROUTE.path || url.pathname + url.search !== raw) refuse()
  const names = ['sessionId', 'serviceHandle', config.bindingFields.accountQuery, config.bindingFields.generationQuery]
  if (new Set(names).size !== names.length) refuse()
  for (const name of url.searchParams.keys()) if (!names.includes(name)) refuse()
  for (const name of names) if (url.searchParams.getAll(name).length !== 1) refuse()
  const field = (name: string): string => {
    const value = url.searchParams.get(name)
    if (value === null || value.length === 0 || value.length > limits.maxFieldBytes
      || Buffer.byteLength(value) > limits.maxFieldBytes || /[\u0000-\u0020\u007f]/u.test(value)) refuse()
    return value
  }
  const sessionId = field('sessionId'), serviceId = field('serviceHandle')
  field(config.bindingFields.accountQuery); field(config.bindingFields.generationQuery)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serviceId) || request.rawHeaders.length % 2 !== 0
    || request.rawHeaders.length > 2 * limits.maxRequestHeaderCount) refuse()
  const headers: Array<readonly [string, string]> = []
  let bytes = 0
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i], value = request.rawHeaders[i + 1]
    if (name === undefined || value === undefined) refuse()
    if (name.length > limits.maxRequestHeaderBytes || value.length > limits.maxRequestHeaderBytes) refuse()
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    if (bytes > limits.maxRequestHeaderBytes) refuse()
    headers.push(Object.freeze([name, value]))
  }
  return Object.freeze({ selection: Object.freeze({ sessionId: brandString<ApplicationServiceSelection['sessionId']>(sessionId),
    serviceId: brandString<ApplicationServiceSelection['serviceId']>(serviceId) }), headers: Object.freeze(headers) })
}
