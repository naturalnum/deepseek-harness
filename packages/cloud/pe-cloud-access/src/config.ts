/** Host deployment policy, preserving Node IP semantics before authentication or root activation. */
import { isIP } from 'node:net'
import { AccessConfigSchema } from './config-schema.ts'
import type { AccessConfig } from './types.ts'

export { AccessConfigSchema } from './config-schema.ts'

/**
 * Parse deployment inputs before installing any request handler.
 * @param input - Loader configuration or another untrusted configuration source.
 * @returns validated settings with a canonical, fixed public origin.
 * @throws Error when origin, proxy addresses, field names, or finite limits are invalid.
 */
export function parseAccessConfig(input: unknown): AccessConfig {
  const config = AccessConfigSchema(input as AccessConfig)
  const origin = new URL(config.publicOrigin)
  if (origin.origin !== config.publicOrigin) {
    throw new Error('cloud access publicOrigin must be a canonical origin without credentials, path, query, or fragment')
  }
  const hostname = origin.hostname
  const loopback = hostname === 'localhost' || hostname === '[::1]'
    || (isIP(hostname) === 4 && hostname.startsWith('127.'))
  if (origin.protocol !== 'https:'
    && !(origin.protocol === 'http:' && config.deploymentMode === 'development' && loopback)) {
    throw new Error('cloud access requires HTTPS except for development loopback')
  }
  if (config.trustedProxyAddresses.some(address => isIP(address) === 0)) {
    throw new Error('cloud access trustedProxyAddresses must contain exact IP addresses')
  }
  if (config.bindingFields.accountHeader === config.bindingFields.generationHeader
    || config.bindingFields.accountQuery === config.bindingFields.generationQuery) {
    throw new Error('cloud access account and generation carrier fields must be distinct')
  }
  if (config.maxPeersPerAccount > config.maxPeers) {
    throw new Error('cloud access maxPeersPerAccount must not exceed maxPeers')
  }
  if (config.maxTrackedLoginsPerAccount > config.maxTrackedLogins) {
    throw new Error('cloud access maxTrackedLoginsPerAccount must not exceed maxTrackedLogins')
  }
  if (config.maxPeerWaitersPerAccount > config.maxPeerWaiters
    || config.maxPeerCarriersPerAccount > config.maxPeerCarriers
    || config.maxPeerCarriersPerLogin > config.maxPeerCarriersPerAccount) {
    throw new Error('cloud access per-scope waiter/carrier limits must not exceed their parent limits')
  }
  return config
}
