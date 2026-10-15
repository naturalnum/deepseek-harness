/** Operator-owned HTTP egress and remote MCP settings; personal metadata cannot change network policy. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isIP } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { McpCredentialCipher } from './mcp-credentials.ts'
import { McpNetworkOperation, McpTransportError, validateMcpBudgets, type McpNetworkPolicy } from './mcp-network.ts'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timer = positive.max(2_147_483_647)
const filePath = z.string().min(1).refine(isAbsolute)
const configuration = z.object({
  credentialKeyFile: filePath,
  requireOriginException: z.boolean().optional(),
  pollMs: timer, renewMs: timer, cleanupMs: timer, cleanupBatchSize: positive,
  management: z.object({ maxConnections: positive, maxPendingTickets: positive, maxActiveChecks: positive,
    maxDrafts: positive, maxDraftsPerHour: positive, maxTools: positive, maxCatalogBytes: positive,
    maxToolBytes: positive, ticketLifetimeMs: timer, checkLifetimeMs: timer, draftLifetimeMs: timer,
    retentionMs: timer, checkLeaseMs: timer }).strict(),
  admission: z.object({ maxTools: positive, maxSnapshotBytes: positive, maxToolBytes: positive,
    maxDescriptionBytes: positive }).strict(),
  actions: z.object({ maxArgumentBytes: positive, maxResultBytes: positive, maxCallsPerChain: positive,
    maxPendingPerUser: positive, chainLifetimeMs: timer, approvalLifetimeMs: timer,
    leaseMs: timer, listLimit: positive }).strict(),
  transport: z.object({ timeoutMs: timer, idleTimeoutMs: timer, maxRequestBytes: positive,
    maxResponseBytes: positive, maxTotalResponseBytes: positive, maxResponseHeaderBytes: positive,
    maxRequests: positive, maxHeaderBytes: positive, maxHeaders: positive, maxPages: positive,
    maxTools: positive, maxCatalogBytes: positive }).strict(),
  internalExceptions: z.array(z.object({ origin: z.url(),
    addresses: z.array(z.string().refine(value => isIP(value) !== 0 && !value.includes('%'))).min(1),
    allowHttp: z.boolean().optional(), caFile: filePath.optional() }).strict()),
}).strict()

const networkConfiguration = configuration.pick({ requireOriginException: true, internalExceptions: true })
async function readNetworkPolicy(settings: z.infer<typeof networkConfiguration>,
  readText: (filename: string) => Promise<string>): Promise<McpNetworkPolicy> {
  const origins = new Set<string>()
  const internalExceptions = []
  for (const exception of settings.internalExceptions) {
    const url = new URL(exception.origin)
    if (url.origin !== exception.origin || url.username || url.password
      || !['http:', 'https:'].includes(url.protocol) || origins.has(url.origin)
      || url.protocol === 'http:' && !exception.allowHttp) throw new Error('Invalid network exception')
    origins.add(url.origin)
    let ca: string | undefined
    if (exception.caFile) {
      ca = await readText(exception.caFile)
      const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu)
      if (!certificates?.length || certificates.some(pem => !new X509Certificate(pem).ca)) {
        throw new Error('Invalid CA bundle')
      }
    }
    internalExceptions.push({ origin: url.origin, addresses: exception.addresses,
      ...(exception.allowHttp === undefined ? {} : { allowHttp: exception.allowHttp }),
      ...(ca === undefined ? {} : { ca }) })
  }
  return { internalExceptions,
    ...(settings.requireOriginException === undefined ? {} : { requireOriginException: settings.requireOriginException }) }
}

/** Fully validated deployment configuration and resolved Platform-private key and CA material. */
export interface McpPlatformConfig {
  settings: z.infer<typeof configuration>
  credentialKey: string
  networkPolicy: McpNetworkPolicy
}

/** Read required limits and trusted network exceptions before opening platform resources.
 * @param path Absolute configuration filename; an empty string disables generic remote MCP.
 * @param readText Trusted text reader; deployment preflight supplies only explicitly projected Secret/CA paths.
 * @returns Validated private settings, or null when this feature is disabled.
 */
export async function loadMcpPlatformConfig(path: string,
  readText: (filename: string) => Promise<string> = filename => readFile(filename, 'utf8')): Promise<McpPlatformConfig | null> {
  if (!path) return null
  try {
    filePath.parse(path)
    const settings = configuration.parse(JSON.parse(await readText(path)))
    validateMcpBudgets(settings.transport)
    if (settings.renewMs >= Math.min(settings.management.checkLeaseMs, settings.actions.leaseMs)
      || settings.management.checkLeaseMs > settings.management.checkLifetimeMs
      || settings.actions.leaseMs > settings.actions.approvalLifetimeMs) throw new Error('Invalid lease timing')
    const credentialKey = (await readText(settings.credentialKeyFile)).trim()
    new McpCredentialCipher(credentialKey)
    return { settings, credentialKey, networkPolicy: await readNetworkPolicy(settings, readText) }
  } catch {
    // Filenames, parser inputs and credential bytes remain private even in startup diagnostics.
    throw new Error('Invalid remote MCP platform configuration')
  }
}

/** Read model-only egress exceptions without inheriting MCP's origin list.
 * @param path Absolute operator file; empty selects the existing public HTTPS policy.
 * @param readText Trusted private file reader, including referenced CA files.
 * @returns Independently validated DNS/socket policy for native model HTTP.
 */
export async function loadModelNetworkPolicy(path: string,
  readText: (filename: string) => Promise<string> = filename => readFile(filename, 'utf8')): Promise<McpNetworkPolicy> {
  if (!path) return {}
  try {
    filePath.parse(path)
    return await readNetworkPolicy(networkConfiguration.parse(JSON.parse(await readText(path))), readText)
  } catch {
    // Operator filenames and CA material remain private in startup diagnostics.
    throw new Error('Invalid model network configuration')
  }
}

/** Resolve and validate every destination address without issuing any HTTP request.
 * @param config Operator-owned limits and resolved egress exceptions.
 * @param endpoint Personal connection URL; it never supplies a resolver or trust store.
 * @returns Completion after DNS checks and cleanup, or a redacted policy refusal.
 */
export async function assertMcpPlatformEndpoint(config: McpPlatformConfig, endpoint: string): Promise<void> {
  const operation = new McpNetworkOperation(config.settings.transport, new AbortController().signal)
  try {
    await operation.bounded(operation.fetchFor(endpoint, config.networkPolicy,
      () => Promise.reject(new McpTransportError('dispatch_replay_denied', false))))
  } catch (error) {
    throw new PlatformError(400, error instanceof McpTransportError ? `mcp_${error.code}` : 'mcp_endpoint_denied')
  } finally { await operation.dispose() }
}
