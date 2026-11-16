/** Executable service responses confined to the credential's dedicated content origin. */
import type { ApplicationReadLimits, ApplicationReadResponse } from '@deepseek-ai/dsh-pe-opensandbox/types'
import { PreviewResponseError, readBoundedApplicationBody } from './preview-response.ts'

/** Bounded application bytes whose original service and ingress owners still retain transfer responsibility. */
export interface ServiceApplicationReply {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

const passedHeaders = new Set(['content-type', 'content-language', 'content-encoding', 'content-range',
  'accept-ranges', 'last-modified', 'etag', 'vary', 'location'])

function need(value: unknown, code: 'cloud/forbidden' | 'cloud/capacity' = 'cloud/forbidden'): asserts value {
  if (!value) throw new PreviewResponseError(code)
}

function location(value: string, origin: string): string {
  // The selected SDK prepends this fixed proxy route to root-relative application redirects.
  const path = value.replace(/^\/v1\/sandboxes\/[A-Za-z0-9_-]{1,256}\/proxy\/8000(?=\/|\?|$)/, '') || '/'
  const url = new URL(path, origin)
  need(url.origin === origin && !url.username && !url.password)
  return url.pathname + url.search + url.hash
}

/**
 * Preserve bounded application status/MIME while keeping scripts, requests, forms and resources on the service's own origin.
 * @param response Original selected-server response; its close is joined through the existing body reader.
 * @param limits Original service-owned response reservation.
 * @param origin Exact credential-bound content origin.
 * @param managementOrigin Only permitted embedding origin; authentication cookies are outside the content hostname.
 * @param signal Original request and credential cancellation.
 * @param current Original view, login, account, generation and service checks.
 * @returns Complete response for the original ingress's actual write/close owner.
 */
export async function readServiceApplicationReply(response: ApplicationReadResponse, limits: ApplicationReadLimits,
  origin: string, managementOrigin: string, signal: AbortSignal, current: () => void): Promise<ServiceApplicationReply> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff',
    'cache-control': 'no-store, max-age=0', pragma: 'no-cache',
    'content-security-policy': "sandbox allow-scripts allow-forms allow-same-origin; default-src 'none'; "
      + "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
      + "font-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'self'; "
      + "object-src 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors " + managementOrigin,
    'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  }
  let declared: number | undefined
  const metadata = (): number | undefined => {
    need(Number.isInteger(response.status) && response.status >= 200 && response.status <= 599)
    need(response.headers.length <= limits.maxHeaderCount, 'cloud/capacity')
    let bytes = 0, transfer = false
    const seen = new Set<string>()
    for (const [rawName, value] of response.headers) {
      need(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName) && /^[\x20-\x7e]*$/.test(value))
      bytes += Buffer.byteLength(rawName) + Buffer.byteLength(value) + 4
      need(bytes <= limits.maxHeaderBytes, 'cloud/capacity')
      const name = rawName.toLowerCase()
      if (name === 'content-length') {
        need(declared === undefined && /^(?:0|[1-9][0-9]{0,15})$/.test(value))
        declared = Number(value)
        need(Number.isSafeInteger(declared) && declared <= limits.maxBodyBytes, 'cloud/capacity')
      } else if (name === 'transfer-encoding') {
        need(!transfer && value.toLowerCase() === 'chunked'); transfer = true
      } else if (passedHeaders.has(name)) {
        need(!seen.has(name)); seen.add(name)
        headers[name] = name === 'location' ? location(value, origin) : value
      }
    }
    need(!transfer || declared === undefined)
    return declared
  }
  const head = response.status === 204 || response.status === 304
  const result = await readBoundedApplicationBody(response, head, limits, signal, current, metadata)
  if (!head) headers['content-length'] = String(result.body.byteLength)
  return { status: response.status, headers: Object.freeze(headers), body: result.body }
}
