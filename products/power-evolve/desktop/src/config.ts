/** Trusted local deployment choices for the Cloud carrier, without provider or device credentials. */

/** Fixed shared Host and trusted Platform origins, independent of renderer input. */
export interface CloudDesktopConfig {
  readonly hostOrigin: string
  readonly platformOrigin: string
}

function origin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('PowerEvolve desktop: expected an origin')
  const url = new URL(value)
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('PowerEvolve desktop: deployment origin must not contain credentials, paths or query parameters')
  }
  const local = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if (!local && url.protocol !== 'https:') throw new Error('PowerEvolve desktop: remote deployments require HTTPS')
  return url.origin
}

/**
 * Validate an on-disk deployment document before creating windows.
 * @param value - Parsed local configuration; unknown fields are rejected.
 * @returns Two distinct normalized origins; no fallback deployment is selected.
 */
export function parseCloudDesktopConfig(value: unknown): CloudDesktopConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('PowerEvolve desktop: invalid configuration')
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('hostOrigin') || !keys.includes('platformOrigin')
    || !('hostOrigin' in value) || !('platformOrigin' in value)) throw new Error('PowerEvolve desktop: invalid configuration fields')
  const hostOrigin = origin(value.hostOrigin), platformOrigin = origin(value.platformOrigin)
  if (hostOrigin === platformOrigin) throw new Error('PowerEvolve desktop: Host and Platform origins must be distinct')
  return { hostOrigin, platformOrigin }
}

function parsed(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.username === '' && url.password === '' ? url : undefined
  } catch (_invalidUrl) { return undefined }
}

/**
 * Recognize the native Host document, excluding its earlier slice test page.
 * @param config - Validated local deployment.
 * @param value - Current frame URL.
 * @returns Whether this document may receive native window capabilities.
 */
export function allowsCloudHost(config: CloudDesktopConfig, value: string): boolean {
  const url = parsed(value)
  return url?.origin === config.hostOrigin && url.pathname.startsWith('/native/')
}

/**
 * Permit owned main-window navigation through product login and account management.
 * @param config - Fixed deployment origins.
 * @param value - Proposed destination, never a new deployment configuration.
 * @returns Whether the carrier can load this document.
 */
export function allowsCloudNavigation(config: CloudDesktopConfig, value: string): boolean {
  const url = parsed(value)
  if (url === undefined) return false
  if (url.origin === config.hostOrigin) return url.pathname === '/' || url.pathname === '/native' || url.pathname.startsWith('/native/')
  return url.origin === config.platformOrigin && ['/login', '/account', '/approval'].includes(url.pathname)
}

/**
 * Map login's fixed Host root back to the native application.
 * @param config - Validated deployment.
 * @param value - Allowed main-window URL.
 * @returns Native Host URL for its root; otherwise the original URL.
 */
export function nativeCloudDestination(config: CloudDesktopConfig, value: string): string {
  const url = parsed(value)
  return url?.origin === config.hostOrigin && (url.pathname === '/' || url.pathname === '/native')
    ? `${config.hostOrigin}/native/` : value
}
