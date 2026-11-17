/** Host deployment policy, preserving Node IP semantics before authentication or root activation. */
import { DeploymentConfigError } from '@deepseek-ai/dsh-pe-cloud-runtime/schema'
import { isIP } from 'node:net'
import { AccessConfigSchema } from './config-schema.ts'
import type { AccessConfig } from './types.ts'

export { AccessConfigSchema } from './config-schema.ts'

/**
 * Parse deployment inputs before installing any request handler.
 * @param input - Loader configuration or another untrusted configuration source.
 * @returns Validated fixed management origin and optional isolated preview origin/cookie suffix.
 * @throws Error when origin, proxy addresses, field names, or finite limits are invalid.
 */
export function parseAccessConfig(input: unknown): AccessConfig {
  const config = AccessConfigSchema(input as AccessConfig)
  const origin = parseOrigin(config.publicOrigin, config.deploymentMode, config.servicePreview !== undefined, '$.publicOrigin')
  if (config.servicePreview !== undefined) {
    const preview = parseOrigin(config.servicePreview.origin, config.deploymentMode, true, '$.servicePreview.origin')
    const domain = config.servicePreview.cookieDomain
    if (Object.keys(config.servicePreview).some(name => name !== 'origin' && name !== 'cookieDomain')
      || origin.origin === preview.origin || origin.hostname === preview.hostname || origin.protocol !== preview.protocol
      || !asciiDnsName(domain) || !domain.includes('.') || isIP(domain) !== 0
      || !asciiDnsName(origin.hostname) || !asciiDnsName(preview.hostname)
      || isIP(origin.hostname) !== 0 || isIP(preview.hostname) !== 0
      || !origin.hostname.endsWith(`.${domain}`) || !preview.hostname.endsWith(`.${domain}`)) {
      throw new DeploymentConfigError('$.servicePreview: requires distinct same-scheme DNS origins strictly below its exact cookieDomain')
    }
  }
  if (config.trustedProxyAddresses.some(address => isIP(address) === 0)) {
    throw new DeploymentConfigError('$.trustedProxyAddresses: must contain exact IP addresses')
  }
  if (config.bindingFields.accountHeader === config.bindingFields.generationHeader
    || config.bindingFields.accountQuery === config.bindingFields.generationQuery) {
    throw new DeploymentConfigError('$.bindingFields: account and generation carrier fields must be distinct')
  }
  if (config.maxPeersPerAccount > config.maxPeers) {
    throw new DeploymentConfigError('$.maxPeersPerAccount: must not exceed maxPeers')
  }
  if (config.maxTrackedLoginsPerAccount > config.maxTrackedLogins) {
    throw new DeploymentConfigError('$.maxTrackedLoginsPerAccount: must not exceed maxTrackedLogins')
  }
  if (config.maxPeerWaitersPerAccount > config.maxPeerWaiters
    || config.maxPeerCarriersPerAccount > config.maxPeerCarriers
    || config.maxPeerCarriersPerLogin > config.maxPeerCarriersPerAccount) {
    throw new DeploymentConfigError('$.maxPeerCarriersPerLogin: per-scope waiter/carrier limits must not exceed their parent limits')
  }
  return config
}

function asciiDnsName(value: string): boolean {
  return value.length <= 253 && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

function parseOrigin(value: string, mode: AccessConfig['deploymentMode'], allowLocalSubdomains: boolean, path: string): URL {
  let origin: URL
  try { origin = new URL(value) }
  catch (_invalidUrl) { throw new DeploymentConfigError(`${path}: requires a canonical HTTP(S) origin`) }
  if (origin.origin !== value) {
    throw new DeploymentConfigError(`${path}: requires a canonical origin without credentials, path, query, or fragment`)
  }
  const hostname = origin.hostname
  const loopback = hostname === 'localhost' || hostname === '[::1]'
    || (isIP(hostname) === 4 && hostname.startsWith('127.'))
    || (allowLocalSubdomains && asciiDnsName(hostname) && hostname.endsWith('.localhost'))
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && mode === 'development' && loopback)) {
    throw new DeploymentConfigError(`${path}: requires HTTPS except for development loopback`)
  }
  return origin
}
