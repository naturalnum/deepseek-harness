/** Fixed-origin authentication transport checks; forwarded headers never supply identity. */
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
 * @param transport - HTTP by omission; websocket requires exactly one original Origin equal to publicOrigin.
 * @throws AuthAccessError when the request crosses an unapproved origin or transport.
 */
export function assertAuthTransport(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[],
  remoteAddress: string | undefined,
  secure: boolean,
  config: AccessConfig,
  requestId: Branded<'pe-request-id'>,
  transport: 'http' | 'websocket' = 'http',
): void {
  const origin = new URL(config.publicOrigin)
  const hostCount = rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length
  const originCount = rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'origin').length
  const trustedProxy = remoteAddress !== undefined && config.trustedProxyAddresses.includes(remoteAddress)
  const forwardedHost = headers['x-forwarded-host']
  const forwardedProto = headers['x-forwarded-proto']
  if (hostCount !== 1 || headers.host !== origin.host || originCount > 1
    || (transport === 'websocket' && (originCount !== 1 || headers.origin !== config.publicOrigin))
    || (headers.origin !== undefined && headers.origin !== config.publicOrigin)
    || ((forwardedHost !== undefined || forwardedProto !== undefined || headers.forwarded !== undefined) && !trustedProxy)
    || (forwardedHost !== undefined && forwardedHost !== origin.host)
    || (forwardedProto !== undefined && forwardedProto !== origin.protocol.slice(0, -1))
    || (origin.protocol === 'https:' && !secure && !(trustedProxy && forwardedProto === 'https'))) {
    throw new AuthAccessError('cloud/forbidden', requestId)
  }
}
