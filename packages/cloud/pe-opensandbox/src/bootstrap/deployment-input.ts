/** Root-only JSON selection for the fixed SDK/bootstrap and an explicit storage deployment. */
import { posix } from 'node:path'
import { ExecutionStateError } from '../errors.ts'
import type { SdkLifecycleConfig } from '../lifecycle-types.ts'
import type { OwnedTransportLimits } from '../sdk-transport.ts'
import type { ExecutionExportLimits } from '../export-share.ts'
import type { BootstrapConfig } from './bootstrap.ts'
import type { RootDeploymentReference } from './deployment-reference.ts'
import { SOURCE_DIGEST } from './asset-manifest.ts'

/** Finite plan verification and retained-grant capacities for stable shared storage. */
export interface SharedPathStorageLimits {
  readonly maxPlanBytes: number
  readonly maxMountInfoBytes: number
  readonly maxPathBytes: number
  readonly maxShares: number
  readonly maxResidentBytes: number
}

interface RootDeploymentFields {
  readonly selection: Readonly<{ serverImageDigest: string; execdImageDigest: string; apiKeyDeploymentIdentity: string }>
  readonly lifecycle: SdkLifecycleConfig
  readonly bootstrap: Omit<BootstrapConfig, 'lifecycle' | 'assertDeploymentCurrent'>
  /** Optional explicit original-owner count bound; omission leaves copy execution disabled. */
  readonly skillCopies?: Readonly<{ maxCopiesPerOperation: number }>
}

/** Legacy v1 requires the original keeper; v2 selects shared paths through the existing protected files plan. */
export type RootDeploymentInput = RootDeploymentFields & (
  | { readonly schema: 'pe-opensandbox-root-deployment-v1'
    readonly exports: Readonly<{ manifest: RootDeploymentReference; limits: ExecutionExportLimits }> }
  | { readonly schema: 'pe-opensandbox-root-deployment-v2'
    readonly storage: Readonly<{ mode: 'shared-path'; plan: RootDeploymentReference; limits: SharedPathStorageLimits }> }
)
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

function sharedStorage(value: unknown): Extract<RootDeploymentInput, { schema: 'pe-opensandbox-root-deployment-v2' }>['storage'] {
  const storage = object(value, ['mode', 'plan', 'limits'], 'storage')
  need(storage.mode === 'shared-path', 'storage.mode')
  const plan = object(storage.plan, ['path', 'sha256'], 'storage.plan')
  const path = text(plan.path, 'storage.plan.path', 4096), digest = text(plan.sha256, 'storage.plan.sha256', 64)
  need(path.startsWith('/') && posix.normalize(path) === path && path !== '/' && !path.endsWith('/')
    && !path.includes('\\') && /^[a-f0-9]{64}$/.test(digest), 'storage.plan')
  const limits = object(storage.limits, ['maxPlanBytes', 'maxMountInfoBytes', 'maxPathBytes', 'maxShares', 'maxResidentBytes'], 'storage.limits')
  return Object.freeze({ mode: storage.mode, plan: Object.freeze({ path, sha256: digest }), limits: Object.freeze({
    maxPlanBytes: integer(limits.maxPlanBytes, 'storage.maxPlanBytes', 262144),
    maxMountInfoBytes: integer(limits.maxMountInfoBytes, 'storage.maxMountInfoBytes', 4194304),
    maxPathBytes: integer(limits.maxPathBytes, 'storage.maxPathBytes', 4096),
    maxShares: integer(limits.maxShares, 'storage.maxShares'),
    maxResidentBytes: integer(limits.maxResidentBytes, 'storage.maxResidentBytes', Number.MAX_SAFE_INTEGER),
  }) })
}

/**
 * Parse the complete protected Root configuration with no defaults or executable/endpoint alternatives.
 * @param value Exact decoded readonly Root file; credential values remain private to this assembly.
 * @returns Frozen fixed selection, credentials and either legacy exports or an explicit protected shared-path plan.
 */
export function parseRootDeploymentInput(value: unknown): RootDeploymentInput {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'configuration')
  const schema: unknown = Reflect.get(value, 'schema')
  need(schema === 'pe-opensandbox-root-deployment-v1' || schema === 'pe-opensandbox-root-deployment-v2', 'schema')
  const fields = ['schema', 'selection', 'lifecycle', 'bootstrap', schema === 'pe-opensandbox-root-deployment-v1' ? 'exports' : 'storage']
  const hasCopies = Object.hasOwn(value, 'skillCopies')
  const v = object(value, hasCopies ? [...fields, 'skillCopies'] : fields, 'configuration')
  const life = lifecycle(v.lifecycle), boot = bootstrap(v.bootstrap)
  const s = object(v.selection, ['serverImageDigest', 'execdImageDigest', 'apiKeyDeploymentIdentity'], 'selection')
  const serverImage = schema === 'pe-opensandbox-root-deployment-v2'
    ? 'sha256:fec2756169ff3e9baf123c0f2e9664baf3f2214898372c180847d991559ce0fd'
    : 'sha256:64383075f5bd4dae3f76b283c7cbed38d067446aad66373b840ffc16bdcefa17'
  need(s.serverImageDigest === serverImage
    && s.execdImageDigest === 'sha256:39ee9357842bc4a931a208170484ae6d1e33985f5d256b13d654a7c3ce35cbdf'
    && s.apiKeyDeploymentIdentity === life.deploymentIdentity, 'selection.originalPolicy')
  need(life.ttlSeconds >= 60 && life.ttlSeconds <= 600, 'lifecycle.ttlSeconds')
  need(boot.maxRecords >= life.maxRecords, 'bootstrap.maxRecords')
  let copies: RootDeploymentInput['skillCopies']
  if (hasCopies) {
    const policy = object(v.skillCopies, ['maxCopiesPerOperation'], 'skillCopies')
    copies = Object.freeze({ maxCopiesPerOperation: integer(policy.maxCopiesPerOperation, 'skillCopies.maxCopiesPerOperation') })
  }
  const common = { ...(copies === undefined ? {} : { skillCopies: copies }),
    selection: Object.freeze({ serverImageDigest: serverImage, execdImageDigest: s.execdImageDigest,
      apiKeyDeploymentIdentity: s.apiKeyDeploymentIdentity }), lifecycle: life, bootstrap: boot }
  if (schema === 'pe-opensandbox-root-deployment-v2') {
    return Object.freeze({ ...common, schema, storage: sharedStorage(v.storage) })
  }
  const e = object(v.exports, ['manifest', 'limits'], 'exports'), m = object(e.manifest, ['path', 'sha256'], 'exports.manifest')
  const limits = object(e.limits, ['maxManifestBytes', 'maxMountInfoBytes', 'maxPathBytes', 'maxShares', 'maxResidentBytes'], 'exports.limits')
  return Object.freeze({ ...common, schema,
    exports: Object.freeze({ manifest: Object.freeze({ path: text(m.path, 'exports.manifest.path', 4096), sha256: text(m.sha256, 'exports.manifest.sha256', 64) }),
      limits: Object.freeze({ maxManifestBytes: integer(limits.maxManifestBytes, 'exports.maxManifestBytes', 131072),
        maxMountInfoBytes: integer(limits.maxMountInfoBytes, 'exports.maxMountInfoBytes', 4194304), maxPathBytes: integer(limits.maxPathBytes, 'exports.maxPathBytes', 4096),
        maxShares: integer(limits.maxShares, 'exports.maxShares'), maxResidentBytes: integer(limits.maxResidentBytes, 'exports.maxResidentBytes', Number.MAX_SAFE_INTEGER) }) }) })
}
