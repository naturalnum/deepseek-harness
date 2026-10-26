/** Host-only authentication database and secret budgets; browser configuration stays separate. */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccessConfigSchema } from './config-schema.ts'
import { parseAccessConfig } from './config.ts'
import type { AccessConfig } from './types.ts'
import type { ApplicationReadLimits } from '@deepseek-ai/dsh-pe-opensandbox/types'
import type { ForwardLimits } from './forward-types.ts'
import { OWNER_HOP_HEADER } from './owner-hop.ts'

/** Fixed deployment entries; PG metadata can select only an exact reviewed HTTPS address. */
export interface OwnerForwardingConfig {
  readonly maxIdentities: number
  readonly maxPemBytes: number
  readonly maxPemPathBytes: number
  readonly maxPeerPins: number
  readonly maxHopBytes: number
  readonly peerCertificateSha256: string[]
  readonly identities: {
    readonly id: string
    readonly caFile: string
    readonly certFile: string
    readonly keyFile: string
    readonly serverCertificateSha256: string
    readonly servername?: string
  }[]
  readonly targets: { readonly id: string; readonly origin: string; readonly serviceIdentityRef: string }[]
  readonly limits: ForwardLimits & { readonly maxTlsIdentityBytes: number }
}

/** Explicit bounds for the fixed isolated GET preview; no field chooses an upstream target or application path. */
export interface ServicePreviewIngressLimits {
  readonly maxUrlBytes: number
  readonly maxFieldBytes: number
  readonly maxRequestHeaderCount: number
  readonly maxRequestHeaderBytes: number
  readonly response: ApplicationReadLimits
}

/** Optional shared-Web registration inputs; none grants recipe, account or transport readiness. */
export interface AuthIngressConfig {
  /** Omission keeps local acquisition only and accepts no internal marker. */
  readonly ownerForwarding?: OwnerForwardingConfig
  /** Start the original Cookie recheck this many milliseconds before the maximum login age. */
  readonly sessionRecheckLeadMs: number
  /** Absence registers no application preview route, independently of cookie-domain configuration. */
  readonly servicePreview?: ServicePreviewIngressLimits
  readonly maxOperations: number
  readonly maxOperationsPerAccount: number
  readonly requestTimeoutMs: number
  readonly maxAuthRequestBodyBytes: number
  readonly maxRequestBodyBytes: number
  readonly maxBootstrapResponseBytes: number
  readonly maxGenerationBindings: number
  readonly maxFrameBytes: number
  readonly maxLogicalStreams: number
  readonly maxLogicalStreamsPerAccount: number
  readonly maxLogicalStreamsPerPeer: number
}

/** Explicit root resources; SSL enables certificate verification with the system trust store. */
export interface AuthRootConfig extends AccessConfig {
  /** Omission retains component compatibility; first-trial deployment explicitly disables library sign-up. */
  readonly disableSignUp?: boolean
  readonly database: {
    readonly host: string
    readonly port: number
    readonly user: string
    readonly database: string
    readonly passwordRef: string
    readonly ssl: boolean
  }
  readonly pool: {
    readonly maxConnections: number
    readonly connectionTimeoutMs: number
    readonly statementTimeoutMs: number
    readonly lockTimeoutMs: number
    readonly idleTimeoutMs: number
    readonly idleTransactionTimeoutMs: number
    readonly maxLifetimeSeconds: number
  }
  readonly startupTimeoutMs: number
  readonly secretResolveTimeoutMs: number
  readonly maxSecretOperations: number
  readonly maxSecretBytes: number
  /** Omission initializes authentication resources only, preserving deployment schema verification. */
  readonly ingress?: AuthIngressConfig
}

const positive = () => z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required()
const timer = () => z.natural().min(1).max(2_147_483_647).required()
const text = () => z.string().pattern(/^\S+$/).required()
const fingerprint = () => z.string().pattern(/^[a-f0-9]{64}$/).required()
const ownerForwarding: z<OwnerForwardingConfig> = z.object({
  maxIdentities: positive(), maxPemBytes: positive(), maxPemPathBytes: positive(), maxPeerPins: positive(), maxHopBytes: positive(),
  peerCertificateSha256: z.array(fingerprint()).required(),
  identities: z.array(z.object({ id: text(), caFile: text(), certFile: text(), keyFile: text(),
    serverCertificateSha256: fingerprint(), servername: z.string().pattern(/^\S+$/) })).required(),
  targets: z.array(z.object({ id: text(), origin: text(), serviceIdentityRef: text() })).required(),
  limits: z.object({ maxTargets: positive(), maxTargetBytes: positive(), maxTlsIdentityBytes: positive(), maxPathBytes: positive(),
    maxConcurrent: positive(), maxQueued: positive(), maxConnections: positive(),
    maxHeaderPairs: z.natural().min(1).max(0x3fff_fffe).required(), maxHeaderBytes: positive(), maxHeadBytes: positive(),
    maxChunkBytes: positive(), maxBufferedBytes: positive(), maxPendingBytes: positive(),
    maxBodyBytes: positive(), maxTunnelBytes: positive(),
    queueTimeoutMs: timer(), connectTimeoutMs: timer(), operationTimeoutMs: timer(), closeTimeoutMs: timer() }).required(),
})

/** Root Loader inputs have no connection, secret or timeout defaults. */
export const AuthRootConfigSchema: z<AuthRootConfig> = z.intersect([
  AccessConfigSchema,
  z.object({
    disableSignUp: z.boolean(),
    database: z.object({
      host: text(), port: z.natural().min(1).max(65535).required(), user: text(), database: text(),
      passwordRef: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).required(), ssl: z.boolean().required(),
    }).required(),
    pool: z.object({
      maxConnections: positive(), connectionTimeoutMs: timer(), statementTimeoutMs: timer(), lockTimeoutMs: timer(),
      idleTimeoutMs: timer(), idleTransactionTimeoutMs: timer(),
      maxLifetimeSeconds: z.natural().min(1).max(2_147_483).required(),
    }).required(),
    startupTimeoutMs: timer(), secretResolveTimeoutMs: timer(), maxSecretOperations: positive(), maxSecretBytes: positive(),
    ingress: z.object({
      ownerForwarding: ownerForwarding.default(undefined as never),
      sessionRecheckLeadMs: timer(),
      servicePreview: z.object({
        maxUrlBytes: z.natural().min(1).max(65536).required(),
        maxFieldBytes: z.natural().min(1).max(65536).required(),
        maxRequestHeaderCount: z.natural().min(1).max(128).required(),
        maxRequestHeaderBytes: z.natural().min(1).max(65536).required(),
        response: z.object({
          maxBodyBytes: z.natural().min(1).max(1048576).required(),
          maxChunkBytes: z.natural().min(1).max(1048576).required(),
          maxChunks: z.natural().min(1).max(1048576).required(),
          maxHeaderCount: z.natural().min(1).max(128).required(),
          maxHeaderBytes: z.natural().min(1).max(1048576).required(),
        }).required(),
      }).default(undefined as never),
      maxOperations: positive(), maxOperationsPerAccount: positive(), requestTimeoutMs: timer(),
      maxAuthRequestBodyBytes: positive(), maxRequestBodyBytes: positive(),
      maxBootstrapResponseBytes: positive(), maxGenerationBindings: positive(),
      maxFrameBytes: positive(), maxLogicalStreams: positive(),
      maxLogicalStreamsPerAccount: positive(), maxLogicalStreamsPerPeer: positive(),
    }).default(undefined as never),
  }),
])

/**
 * Validate Host deployment inputs before allocating resources.
 * @param input - Root Loader configuration.
 * @returns A detached configuration with valid official credential references.
 * @throws TypeError with a fixed diagnostic; values and references are not echoed.
 */
export function parseAuthRootConfig(input: AuthRootConfig): AuthRootConfig {
  try {
    const config = structuredClone(AuthRootConfigSchema(input))
    parseAccessConfig(config)
    if ([config.bindingFields.accountHeader, config.bindingFields.generationHeader]
      .some(name => name.toLowerCase() === OWNER_HOP_HEADER)) throw new TypeError()
    credentialRef(config.authSecretRef)
    credentialRef(config.database.passwordRef)
    if (config.maxSecretBytes < 32 || config.pool.lockTimeoutMs > config.pool.statementTimeoutMs) throw new TypeError()
    if (config.ingress !== undefined && (config.ingress.sessionRecheckLeadMs >= config.sessionRecheckMs
      || config.ingress.maxOperationsPerAccount > config.ingress.maxOperations)) throw new TypeError()
    if (config.ingress !== undefined && (config.ingress.maxLogicalStreamsPerAccount > config.ingress.maxLogicalStreams
      || config.ingress.maxLogicalStreamsPerPeer > config.ingress.maxLogicalStreamsPerAccount)) throw new TypeError()
    const preview = config.ingress?.servicePreview
    const forwarding = config.ingress?.ownerForwarding
    if (forwarding !== undefined && (forwarding.identities.length === 0 || forwarding.identities.length > forwarding.maxIdentities
      || forwarding.targets.length === 0 || forwarding.targets.length > forwarding.limits.maxTargets
      || forwarding.peerCertificateSha256.length === 0 || forwarding.peerCertificateSha256.length > forwarding.maxPeerPins
      || new Set(forwarding.peerCertificateSha256).size !== forwarding.peerCertificateSha256.length
      || forwarding.maxHopBytes > forwarding.limits.maxHeaderBytes)) throw new TypeError()
    if (preview !== undefined && (config.servicePreview === undefined
      || preview.response.maxChunkBytes > preview.response.maxBodyBytes + 1
      || Object.keys(preview).some(name => !['maxUrlBytes', 'maxFieldBytes', 'maxRequestHeaderCount', 'maxRequestHeaderBytes', 'response'].includes(name))
      || Object.keys(preview.response).some(name => !['maxBodyBytes', 'maxChunkBytes', 'maxChunks', 'maxHeaderCount', 'maxHeaderBytes'].includes(name))
      || [config.bindingFields.accountQuery, config.bindingFields.generationQuery]
        .some(name => name === 'sessionId' || name === 'serviceHandle'))) throw new TypeError()
    return config
  } catch (_error) {
    // Schema diagnostics can contain supplied configuration; root exposes only this fixed deployment error.
    throw new TypeError('Cloud authentication root requires explicit valid database, secret references and finite resource limits.')
  }
}
