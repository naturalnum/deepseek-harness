/** Fixed management or exact GET preview transport; forwarded headers never supply identity. */
import type { IncomingHttpHeaders } from 'node:http'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccessConfig } from './types.ts'
import { AuthAccessError } from './auth-error.ts'

/**
 * Check the original Host, Origin, TLS and explicitly trusted reverse proxy.
 * @param headers - Original incoming headers, before any library conversion.
 * @param rawHeaders - Node header pairs, retaining duplicate Host/Origin occurrences.
 * @param remoteAddress - Actual socket address, never a client identity header.
 * @param secure - Whether the actual socket uses TLS.
 * @param config - Validated fixed-origin deployment inputs.
 * @param requestId - Server-generated correlation id.
 * @param transport - Management HTTP by omission; websocket requires management Origin. Explicit preview
 * input checks only GET /cloud/service-preview with its original URL, without authorizing auth or other APIs.
 * @throws AuthAccessError when the request crosses an unapproved origin or transport.
 */
export function assertAuthTransport(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[],
  remoteAddress: string | undefined,
  secure: boolean,
  config: AccessConfig,
  requestId: Branded<'pe-request-id'>,
  transport: 'http' | 'websocket' | Readonly<{ kind: 'service-preview'; method: string | undefined; url: string | undefined }> = 'http',
): void {
  let selectedOrigin = config.publicOrigin
  if (typeof transport === 'object') {
    const preview = config.servicePreview
    if (preview === undefined || transport.method !== 'GET' || transport.url === undefined
      || headers.upgrade !== undefined || Object.keys(headers).some(name => name.startsWith('sec-websocket-'))
      || headers.connection?.split(',').some(token => token.trim().toLowerCase() === 'upgrade') === true) {
      throw new AuthAccessError('cloud/forbidden', requestId)
    }
    const raw = transport.url
    try {
      const url = new URL(raw, preview.origin)
      if (url.origin !== preview.origin || url.pathname !== '/cloud/service-preview' || url.pathname + url.search !== raw
        || /[\\#\u0000-\u0020\u007f]/u.test(raw)) throw new AuthAccessError('cloud/forbidden', requestId)
    } catch (_error) { throw new AuthAccessError('cloud/forbidden', requestId) }
    selectedOrigin = preview.origin
  }
  const origin = new URL(selectedOrigin)
  const hostCount = rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length
  const originCount = rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'origin').length
  const trustedProxy = remoteAddress !== undefined && config.trustedProxyAddresses.includes(remoteAddress)
  const forwardedHost = headers['x-forwarded-host']
  const forwardedProto = headers['x-forwarded-proto']
  if (hostCount !== 1 || headers.host !== origin.host || originCount > 1
    || (transport === 'websocket' && (originCount !== 1 || headers.origin !== selectedOrigin))
    || (headers.origin !== undefined && headers.origin !== selectedOrigin)
    || ((forwardedHost !== undefined || forwardedProto !== undefined || headers.forwarded !== undefined) && !trustedProxy)
    || (forwardedHost !== undefined && forwardedHost !== origin.host)
    || (forwardedProto !== undefined && forwardedProto !== origin.protocol.slice(0, -1))
    || (origin.protocol === 'https:' && !secure && !(trustedProxy && forwardedProto === 'https'))) {
    throw new AuthAccessError('cloud/forbidden', requestId)
  }
}
