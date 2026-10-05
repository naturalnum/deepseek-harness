/** Product endpoint protection for credential-free sidebar guest Sessions. */
import type { CloudDesktopConfig } from './config.ts'

function loopback(hostname: string): boolean {
  return ['localhost', '[::1]', '0.0.0.0', '[::]'].includes(hostname)
    || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(hostname)
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/iu.test(hostname)
}

function port(url: URL): string {
  return url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80')
}

/**
 * Deny Host, Platform and Device HTTP/WebSocket endpoints, including loopback aliases.
 * This predicate does not resolve DNS or provide an OS network sandbox.
 * @param config - Main-selected deployment origins.
 * @param deviceOrigin - Separately configured local Device endpoint, if enabled.
 * @returns Guest policy independent of user input or cookie contents.
 */
export function browserRejectsUrl(config: CloudDesktopConfig, deviceOrigin?: string): (url: URL) => boolean {
  const endpoints = [config.hostOrigin, config.platformOrigin, ...(deviceOrigin === undefined ? [] : [deviceOrigin])].map(value => new URL(value))
  return url => {
    // Absolute DNS names with a trailing dot name the same configured host.
    const hostname = url.hostname.replace(/\.$/u, '')
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && endpoints.some(endpoint => {
      const target = endpoint.hostname.replace(/\.$/u, '')
      return port(url) === port(endpoint) && (hostname === target || loopback(hostname) && loopback(target))
    })
  }
}
