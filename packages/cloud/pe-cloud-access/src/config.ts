/** Required deployment configuration for C-02 admission and authentication rechecks. */
import { isIP } from 'node:net'
import z from '@deepseek-ai/schemastery'
import type { AccessConfig, BindingFieldNames } from './types.ts'

const MAX_TIMER_MS = 2_147_483_647

/** Dedicated headers cannot replace Cookie, Host, Origin, or authorization headers. */
const BindingFieldsSchema: z<BindingFieldNames> = z.object({
  accountHeader: z.string().pattern(/^x-[a-z0-9-]+$/).required(),
  generationHeader: z.string().pattern(/^x-[a-z0-9-]+$/).required(),
  accountQuery: z.string().pattern(/^[A-Za-z][A-Za-z0-9_-]*$/).required(),
  generationQuery: z.string().pattern(/^[A-Za-z][A-Za-z0-9_-]*$/).required(),
})

/** Required finite values have no example-derived production defaults. */
export const AccessConfigSchema: z<AccessConfig> = z.object({
  publicOrigin: z.string().required(),
  deploymentMode: z.union(['development', 'production']).required(),
  trustedProxyAddresses: z.array(String).required(),
  authSecretRef: z.string().pattern(/\S/).required(),
  sessionRecheckMs: z.natural().min(1).max(MAX_TIMER_MS).required(),
  authCheckTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).required(),
  maxPeers: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxPeersPerAccount: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxPeerWaiters: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxPeerWaitersPerAccount: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxPeerCarriers: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxPeerCarriersPerAccount: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxPeerCarriersPerLogin: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  peerCloseTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).required(),
  maxAuthOperations: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxTrackedLogins: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxTrackedLoginsPerAccount: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxAuthInvalidations: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  bindingFields: BindingFieldsSchema.required(),
})

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
