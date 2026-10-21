/** Browser-safe structural deployment schema; full origin/IP policy remains Host-owned. */
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
  servicePreview: z.object({
    origin: z.string().required(),
    cookieDomain: z.string().required(),
  }).default(undefined as never),
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
