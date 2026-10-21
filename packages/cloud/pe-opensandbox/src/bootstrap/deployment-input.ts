/** Closed Root-only JSON input for the original selected-server policy, fixed bootstrap and export publication. */
import { ExecutionStateError } from '../errors.ts'
import type { SdkLifecycleConfig } from '../lifecycle-types.ts'
import type { OwnedTransportLimits } from '../sdk-transport.ts'
import type { ExecutionExportLimits } from '../export-share.ts'
import type { BootstrapConfig } from './bootstrap.ts'
import type { RootDeploymentReference } from './deployment-reference.ts'
import { SOURCE_DIGEST } from './asset-manifest.ts'

/** Parsed private fields. Only retained file leases and original FD4 adoption confer the associated capabilities. */
export interface RootDeploymentInput {
  readonly schema: 'pe-opensandbox-root-deployment-v1'
  readonly selection: Readonly<{ serverImageDigest: string; execdImageDigest: string; apiKeyDeploymentIdentity: string }>
  readonly lifecycle: SdkLifecycleConfig
  readonly bootstrap: Omit<BootstrapConfig, 'lifecycle' | 'assertDeploymentCurrent'>
  readonly exports: Readonly<{ manifest: RootDeploymentReference; limits: ExecutionExportLimits }>
}
function need(value: boolean, field: string): asserts value {
  if (!value) throw new ExecutionStateError('cloud/invalid-config', `Root deployment field ${field} is absent, unsupported or out of bounds.`)
}
function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), field)
  need(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), field)
  return value as Record<string, unknown>
}
function integer(value: unknown, field: string, maximum = 2147483647): number {
  need(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum, field)
  return value
}
function text(value: unknown, field: string, maximum = 1024): string {
  need(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/u.test(value), field)
  return value
}
const lifecycleKeys = ['lifecycleBaseUrl', 'apiKey', 'deploymentIdentity', 'environmentVersion', 'provider', 'imageDigest',
  'payloadSha256', 'entrypoint', 'platform', 'cpuCores', 'memoryMiB', 'ttlSeconds', 'requestTimeoutMs', 'stopBudgetMs',
  'readyPollIntervalMs', 'maxReadyPolls', 'pageSize', 'maxPages', 'maxItems', 'maxRecords', 'maxInflightOperations',
  'maxRequestBytes', 'maxResponseBytes', 'maxOperationBytes', 'maxFieldBytes'] as const
function lifecycle(value: unknown): SdkLifecycleConfig {
  const v = object(value, lifecycleKeys, 'lifecycle')
  const endpoint = text(v.lifecycleBaseUrl, 'lifecycle.lifecycleBaseUrl', 2048), url = new URL(endpoint)
  need(url.protocol === 'http:' && url.pathname === '/v1' && !url.username && !url.password && !url.search && !url.hash
    && url.href === endpoint, 'lifecycle.lifecycleBaseUrl')
  need(v.imageDigest === 'sha256:3a1883e6bd3272095de9407f33bcb0119dcc664e6cff2952cd0931caa8e0bf9f'
    && v.payloadSha256 === SOURCE_DIGEST && v.platform === 'arm64'
    && Array.isArray(v.entrypoint) && JSON.stringify(v.entrypoint) === '["/usr/bin/tail","-f","/dev/null"]', 'lifecycle.fixedSelection')
  need(typeof v.cpuCores === 'number' && Number.isFinite(v.cpuCores) && v.cpuCores > 0 && v.cpuCores <= 2147483647, 'lifecycle.cpuCores')
  const limits = Object.fromEntries(lifecycleKeys.filter(key => !['lifecycleBaseUrl', 'apiKey', 'deploymentIdentity', 'environmentVersion',
    'provider', 'imageDigest', 'payloadSha256', 'entrypoint', 'platform', 'cpuCores'].includes(key))
    .map(key => [key, integer(v[key], `lifecycle.${key}`)]))
  const result: SdkLifecycleConfig = { lifecycleBaseUrl: endpoint, apiKey: text(v.apiKey, 'lifecycle.apiKey'),
    deploymentIdentity: text(v.deploymentIdentity, 'lifecycle.deploymentIdentity', 256),
    environmentVersion: text(v.environmentVersion, 'lifecycle.environmentVersion', 256), provider: text(v.provider, 'lifecycle.provider', 256),
    imageDigest: v.imageDigest, payloadSha256: v.payloadSha256, entrypoint: Object.freeze(['/usr/bin/tail', '-f', '/dev/null']),
    platform: v.platform, cpuCores: v.cpuCores,
    memoryMiB: integer(limits.memoryMiB, 'lifecycle.memoryMiB'), ttlSeconds: integer(limits.ttlSeconds, 'lifecycle.ttlSeconds'),
    requestTimeoutMs: integer(limits.requestTimeoutMs, 'lifecycle.requestTimeoutMs'), stopBudgetMs: integer(limits.stopBudgetMs, 'lifecycle.stopBudgetMs'),
    readyPollIntervalMs: integer(limits.readyPollIntervalMs, 'lifecycle.readyPollIntervalMs'), maxReadyPolls: integer(limits.maxReadyPolls, 'lifecycle.maxReadyPolls'),
    pageSize: integer(limits.pageSize, 'lifecycle.pageSize', 200), maxPages: integer(limits.maxPages, 'lifecycle.maxPages'),
    maxItems: integer(limits.maxItems, 'lifecycle.maxItems'), maxRecords: integer(limits.maxRecords, 'lifecycle.maxRecords'),
    maxInflightOperations: integer(limits.maxInflightOperations, 'lifecycle.maxInflightOperations'),
    maxRequestBytes: integer(limits.maxRequestBytes, 'lifecycle.maxRequestBytes'), maxResponseBytes: integer(limits.maxResponseBytes, 'lifecycle.maxResponseBytes'),
    maxOperationBytes: integer(limits.maxOperationBytes, 'lifecycle.maxOperationBytes'), maxFieldBytes: integer(limits.maxFieldBytes, 'lifecycle.maxFieldBytes', 4096) }
  need(result.maxItems >= result.pageSize && result.maxInflightOperations >= result.maxRecords
    && result.maxOperationBytes >= result.maxResponseBytes, 'lifecycle.capacities')
  return Object.freeze(result)
}
function bootstrap(value: unknown): RootDeploymentInput['bootstrap'] {
  const keys = ['execdAccessToken', 'transport', 'bootstrapTimeoutMs', 'requestTimeoutMs', 'commandTimeoutSeconds',
    'maxRequestBytes', 'maxReplyBytes', 'maxAggregateBytes', 'maxEvents', 'maxRecords', 'agentPort'] as const
  const v = object(value, keys, 'bootstrap'), t = object(v.transport, ['connections', 'connectTimeoutMs', 'headersTimeoutMs',
    'bodyTimeoutMs', 'keepAliveTimeoutMs', 'maxHeaderBytes', 'maxRequestBytes', 'maxResponseBytes'], 'bootstrap.transport')
  const transport: OwnedTransportLimits = Object.freeze({ connections: integer(t.connections, 'transport.connections'),
    connectTimeoutMs: integer(t.connectTimeoutMs, 'transport.connectTimeoutMs'), headersTimeoutMs: integer(t.headersTimeoutMs, 'transport.headersTimeoutMs'),
    bodyTimeoutMs: integer(t.bodyTimeoutMs, 'transport.bodyTimeoutMs'), keepAliveTimeoutMs: integer(t.keepAliveTimeoutMs, 'transport.keepAliveTimeoutMs'),
    maxHeaderBytes: integer(t.maxHeaderBytes, 'transport.maxHeaderBytes'), maxRequestBytes: integer(t.maxRequestBytes, 'transport.maxRequestBytes'),
    maxResponseBytes: integer(t.maxResponseBytes, 'transport.maxResponseBytes') })
  need(v.agentPort === 8080, 'bootstrap.agentPort')
  const result = Object.freeze({ execdAccessToken: text(v.execdAccessToken, 'bootstrap.execdAccessToken'), transport,
    bootstrapTimeoutMs: integer(v.bootstrapTimeoutMs, 'bootstrap.bootstrapTimeoutMs'), requestTimeoutMs: integer(v.requestTimeoutMs, 'bootstrap.requestTimeoutMs'),
    commandTimeoutSeconds: integer(v.commandTimeoutSeconds, 'bootstrap.commandTimeoutSeconds'),
    maxRequestBytes: integer(v.maxRequestBytes, 'bootstrap.maxRequestBytes'), maxReplyBytes: integer(v.maxReplyBytes, 'bootstrap.maxReplyBytes'),
    maxAggregateBytes: integer(v.maxAggregateBytes, 'bootstrap.maxAggregateBytes'), maxEvents: integer(v.maxEvents, 'bootstrap.maxEvents'),
    maxRecords: integer(v.maxRecords, 'bootstrap.maxRecords'), agentPort: v.agentPort })
  need(result.requestTimeoutMs <= result.bootstrapTimeoutMs && result.commandTimeoutSeconds * 1000 < result.requestTimeoutMs
    && result.maxAggregateBytes >= result.maxRequestBytes && transport.maxResponseBytes >= result.maxReplyBytes
    && transport.maxRequestBytes >= result.maxRequestBytes, 'bootstrap.capacities')
  return result
}

/**
 * Parse the complete protected Root configuration with no defaults or executable/endpoint alternatives.
 * @param value Exact decoded readonly Root file; credential values remain private to this assembly.
 * @returns Independent frozen selection, limits, original credentials and export-manifest reference.
 */
export function parseRootDeploymentInput(value: unknown): RootDeploymentInput {
  const v = object(value, ['schema', 'selection', 'lifecycle', 'bootstrap', 'exports'], 'configuration')
  need(v.schema === 'pe-opensandbox-root-deployment-v1', 'schema')
  const life = lifecycle(v.lifecycle), boot = bootstrap(v.bootstrap)
  const s = object(v.selection, ['serverImageDigest', 'execdImageDigest', 'apiKeyDeploymentIdentity'], 'selection')
  need(s.serverImageDigest === 'sha256:231802e5e5fba30fb95955869a017ae3b56d074d9c72e1c6f2cf1bf60c2856f2'
    && s.execdImageDigest === 'sha256:39ee9357842bc4a931a208170484ae6d1e33985f5d256b13d654a7c3ce35cbdf'
    && s.apiKeyDeploymentIdentity === life.deploymentIdentity, 'selection.originalPolicy')
  const e = object(v.exports, ['manifest', 'limits'], 'exports'), m = object(e.manifest, ['path', 'sha256'], 'exports.manifest')
  const limits = object(e.limits, ['maxManifestBytes', 'maxMountInfoBytes', 'maxPathBytes', 'maxShares', 'maxResidentBytes'], 'exports.limits')
  need(boot.maxRecords >= life.maxRecords, 'bootstrap.maxRecords')
  return Object.freeze({ schema: v.schema,
    selection: Object.freeze({ serverImageDigest: s.serverImageDigest, execdImageDigest: s.execdImageDigest,
      apiKeyDeploymentIdentity: s.apiKeyDeploymentIdentity }), lifecycle: life, bootstrap: boot,
    exports: Object.freeze({ manifest: Object.freeze({ path: text(m.path, 'exports.manifest.path', 4096), sha256: text(m.sha256, 'exports.manifest.sha256', 64) }),
      limits: Object.freeze({ maxManifestBytes: integer(limits.maxManifestBytes, 'exports.maxManifestBytes', 131072),
        maxMountInfoBytes: integer(limits.maxMountInfoBytes, 'exports.maxMountInfoBytes', 4194304), maxPathBytes: integer(limits.maxPathBytes, 'exports.maxPathBytes', 4096),
        maxShares: integer(limits.maxShares, 'exports.maxShares'), maxResidentBytes: integer(limits.maxResidentBytes, 'exports.maxResidentBytes', Number.MAX_SAFE_INTEGER) }) }) })
}
