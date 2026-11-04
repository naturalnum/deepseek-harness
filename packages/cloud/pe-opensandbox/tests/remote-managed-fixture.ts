/** Original managed Root and nominal account ports; only SQL and the external allocation transport are fixture services. */
import { Context } from '@deepseek-ai/cordis'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import type { AccountBinding, DrainParticipant, RootMetadataDatabase } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { ManagedCoordinator, installManagedExecutionProviders, type ManagedCoordinatorConfig } from '../src/managed-coordinator.ts'
import { installIssuedExecutionPort } from '../src/account-port.ts'
import { SdkAllocationBackend } from '../src/sdk-lifecycle.ts'
import { TrustedRuntimeRegistry } from '../src/trusted-runtime.ts'
import type { NativeAccountExecutionAuthority } from '../src/coordinator.ts'

/** Existing carrier ceilings are retained; remote consumers are explicitly selected. */
export const remoteManagedConfig: ManagedCoordinatorConfig = {
  maxBoundAccounts: 4, maxActiveCommands: 2, maxActiveCommandsPerAccount: 1,
  maxResidentCommands: 4, maxResidentCommandsPerAccount: 2, maxResidentBytes: 524288, maxResidentBytesPerAccount: 262144,
  maxStopObservers: 4, stopWaitBudgetMs: 2000, recoveryPageSize: 2,
  allocations: { environmentVersion: 'remote-fixture-v1', provider: 'external-fixture', createBudgetMs: 1000,
    maxAllocations: 4, maxAllocationsPerAccount: 2, maxWaiters: 4, maxWaitersPerAllocation: 2 },
  store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 16384,
    maxRows: 4, maxCapabilities: 5, maxPendingQueries: 2, maxMutationResponsibilities: 2, maxRetainedBytes: 262144 },
  commands: { remoteServers: true, allowedTools: ['bash', 'remote_exec', 'remote_server_info'], maxScopes: 4,
    commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096,
      maxTailBytes: 4096, maxObservedBytes: 65536, pollIntervalMs: 10, maxWaiters: 4, maxLifetimeMs: 15000, stopWaitMs: 2000 } },
  shell: { enforceSessionFilePolicy: true, bashPath: '/bin/bash', timeoutMs: 10000, maxTimeoutMs: 10000,
    maxOutputBytes: 4096, graceMs: 1000 },
}

/** Start the original coordinator. It cannot create an external allocation without an explicit test transport.
 * @returns Original owner, runtime registry, nominal installation and actual joined shutdown.
 */
export async function remoteManagedFixture() {
  const ctx = new Context(), runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2 })
  const db: RootMetadataDatabase = { async query() { return { rows: [] } }, wasNotSubmitted: () => false }
  let participant: DrainParticipant | undefined
  const runtimes = new TrustedRuntimeRegistry({ bootstrap: async () => { throw new Error('No external allocation transport selected') },
    fence() { throw new Error('No external allocation transport selected') } }, 4)
  const backend = new SdkAllocationBackend({
    lifecycleBaseUrl: 'https://remote-fixture.invalid/v1', apiKey: 'fixture-only', deploymentIdentity: 'remote-fixture',
    environmentVersion: 'remote-fixture-v1', provider: 'external-fixture', imageDigest: `sha256:${'1'.repeat(64)}`,
    payloadSha256: '2'.repeat(64), entrypoint: ['/trusted/root-agent'], platform: 'arm64', cpuCores: 0.5, memoryMiB: 192, ttlSeconds: 120,
    requestTimeoutMs: 1000, stopBudgetMs: 1000, readyPollIntervalMs: 1, maxReadyPolls: 2,
    pageSize: 1, maxPages: 2, maxItems: 4, maxRecords: 4, maxInflightOperations: 4,
    maxRequestBytes: 8192, maxResponseBytes: 8192, maxOperationBytes: 16384, maxFieldBytes: 512,
  }, runtimes, { fetch: async () => { throw new Error('No external allocation request selected') }, close: async () => {} })
  const owner = new ManagedCoordinator(ctx, {
    registerDrainParticipant(value) { participant = value; return runtime.registerDrainParticipant(value) },
    controlDatabase(value) { if (value !== participant) throw new Error('Foreign Root metadata consumer'); return db },
  }, remoteManagedConfig, { backend, runtimes, assertCurrent() { ctx.fiber.assertActive() }, assertEpochReleased() {},
    share: async () => { throw new Error('No file export selected') } })
  await owner.start()
  return { owner, runtimes,
    bind(account: Context, binding: AccountBinding, authority: NativeAccountExecutionAuthority) {
      const port = owner.bindAccount(account, binding, () => { account.fiber.assertActive(); binding.lifetime.throwIfAborted() }, authority)
      installIssuedExecutionPort(account, port); return port
    },
    installProviders: installManagedExecutionProviders,
    async close() { await owner.closeRoot(); await ctx.fiber.dispose() },
  }
}
