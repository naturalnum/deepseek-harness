/** Synthetic private deployment input; no real credential or runtime is read. */
import type { ManagedCoordinatorConfig } from '../../src/managed-coordinator.ts'
import { SOURCE_DIGEST } from '../../src/bootstrap/asset-manifest.ts'

/** @returns Independent fixed-selection deployment for configuration and assembly checks. */
export function rootDeploymentFixture() {
  return { schema: 'pe-opensandbox-root-deployment-v1', selection: {
    serverImageDigest: 'sha256:64383075f5bd4dae3f76b283c7cbed38d067446aad66373b840ffc16bdcefa17',
    execdImageDigest: 'sha256:39ee9357842bc4a931a208170484ae6d1e33985f5d256b13d654a7c3ce35cbdf', apiKeyDeploymentIdentity: 'selected-deployment' },
  lifecycle: { lifecycleBaseUrl: 'http://127.0.0.1:24444/v1', apiKey: 'synthetic-management-only', deploymentIdentity: 'selected-deployment',
    environmentVersion: 'env-v1', provider: 'selected-docker', imageDigest: 'sha256:3a1883e6bd3272095de9407f33bcb0119dcc664e6cff2952cd0931caa8e0bf9f',
    payloadSha256: SOURCE_DIGEST, entrypoint: ['/usr/bin/tail', '-f', '/dev/null'], platform: 'arm64', cpuCores: 0.5, memoryMiB: 192,
    ttlSeconds: 120, requestTimeoutMs: 1000, stopBudgetMs: 1000, readyPollIntervalMs: 1, maxReadyPolls: 3,
    pageSize: 1, maxPages: 2, maxItems: 2, maxRecords: 4, maxInflightOperations: 8,
    maxRequestBytes: 32768, maxResponseBytes: 32768, maxOperationBytes: 262144, maxFieldBytes: 512 },
  bootstrap: { execdAccessToken: 'synthetic-execd-only', transport: { connections: 1, connectTimeoutMs: 100, headersTimeoutMs: 1000,
    bodyTimeoutMs: 1000, keepAliveTimeoutMs: 1000, maxHeaderBytes: 4096, maxRequestBytes: 32768, maxResponseBytes: 32768 },
  bootstrapTimeoutMs: 10000, requestTimeoutMs: 5000, commandTimeoutSeconds: 3,
  maxRequestBytes: 32768, maxReplyBytes: 32768, maxAggregateBytes: 262144, maxEvents: 8, maxRecords: 4, agentPort: 8080 },
  exports: { manifest: { path: '/root-private/manifest.json', sha256: '3'.repeat(64) },
    limits: { maxManifestBytes: 16384, maxMountInfoBytes: 65536, maxPathBytes: 4096, maxShares: 4, maxResidentBytes: 8388608 } } }
}

/** @returns Explicit shared-path input referencing the existing files plan, without legacy export fields. */
export function sharedPathDeploymentFixture() {
  const { exports: previous, ...common } = rootDeploymentFixture()
  return { ...common, selection: { ...common.selection,
    serverImageDigest: 'sha256:fec2756169ff3e9baf123c0f2e9664baf3f2214898372c180847d991559ce0fd' },
  schema: 'pe-opensandbox-root-deployment-v2', storage: {
    mode: 'shared-path', plan: { path: '/root-private/storage-plan.json', sha256: '5'.repeat(64) },
    limits: { maxPlanBytes: previous.limits.maxManifestBytes, maxMountInfoBytes: previous.limits.maxMountInfoBytes,
      maxPathBytes: previous.limits.maxPathBytes, maxShares: previous.limits.maxShares,
      maxResidentBytes: previous.limits.maxResidentBytes },
  } }
}

/** @returns Explicit coordinator limits matching the synthetic protected deployment. */
export function managedDeploymentFixture(): ManagedCoordinatorConfig {
  return {
    maxBoundAccounts: 2, maxActiveCommands: 2, maxActiveCommandsPerAccount: 1,
    maxResidentCommands: 4, maxResidentCommandsPerAccount: 2, maxResidentBytes: 262144, maxResidentBytesPerAccount: 131072,
    maxStopObservers: 2, stopWaitBudgetMs: 1000, recoveryPageSize: 2,
    allocations: { environmentVersion: 'env-v1', provider: 'selected-docker', createBudgetMs: 1000,
      maxAllocations: 2, maxAllocationsPerAccount: 1, maxWaiters: 4, maxWaitersPerAllocation: 2 },
    store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 16384,
      maxRows: 4, maxCapabilities: 5, maxPendingQueries: 2, maxMutationResponsibilities: 2, maxRetainedBytes: 262144 },
    commands: { allowedTools: ['bash'], maxScopes: 2,
      commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096,
        maxTailBytes: 32, maxObservedBytes: 65536, pollIntervalMs: 1000, maxWaiters: 2, maxLifetimeMs: 1000, stopWaitMs: 100 } },
    shell: { bashPath: '/bin/bash', timeoutMs: 20, maxTimeoutMs: 100, maxOutputBytes: 32, graceMs: 10 },
  }
}
