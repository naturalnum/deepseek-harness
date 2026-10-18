/** Host-only authentication database and secret budgets; browser configuration stays separate. */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccessConfigSchema } from './config-schema.ts'
import { parseAccessConfig } from './config.ts'
import type { AccessConfig } from './types.ts'

/** Optional shared-Web registration inputs; none grants recipe, account or transport readiness. */
export interface AuthIngressConfig {
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

/** Root Loader inputs have no connection, secret or timeout defaults. */
export const AuthRootConfigSchema: z<AuthRootConfig> = z.intersect([
  AccessConfigSchema,
  z.object({
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
    credentialRef(config.authSecretRef)
    credentialRef(config.database.passwordRef)
    if (config.maxSecretBytes < 32 || config.pool.lockTimeoutMs > config.pool.statementTimeoutMs) throw new TypeError()
    if (config.ingress !== undefined && config.ingress.maxOperationsPerAccount > config.ingress.maxOperations) throw new TypeError()
    if (config.ingress !== undefined && (config.ingress.maxLogicalStreamsPerAccount > config.ingress.maxLogicalStreams
      || config.ingress.maxLogicalStreamsPerPeer > config.ingress.maxLogicalStreamsPerAccount)) throw new TypeError()
    return config
  } catch (_error) {
    // Schema diagnostics can contain supplied configuration; root exposes only this fixed deployment error.
    throw new TypeError('Cloud authentication root requires explicit valid database, secret references and finite resource limits.')
  }
}
