/** Root Loader inputs and an external secret-service fixture; no alternate runtime or database. */
import type { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { RuntimeRootConfig } from '../src/root-config.ts'
import { accountPresetConfigDigest } from '../src/account-policy.ts'

/** Read-only external secret fixture; every call retains the caller-provided actual resolution. */
export class RootCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly read: () => Promise<ResolvedCredential | undefined>) { super(ctx) }
  override resolve(): Promise<ResolvedCredential | undefined> { return this.read() }
  override describe(): never { throw new Error('Root credential fixture only supports resolve') }
  override set(): never { throw new Error('Root credential fixture is read-only') }
  override unset(): never { throw new Error('Root credential fixture is read-only') }
  override readRecord(): never { throw new Error('Root credential fixture has no records') }
  override describeRecord(): never { throw new Error('Root credential fixture has no records') }
  override listRecords(): never { throw new Error('Root credential fixture has no records') }
  override modifyRecord(): never { throw new Error('Root credential fixture is read-only') }
  override deleteRecord(): never { throw new Error('Root credential fixture is read-only') }
}

/** Explicit component-test values, never deployment defaults or a quota/readiness assertion. */
export function rootConfig(directory: string): RuntimeRootConfig {
  return {
    maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2,
    recipeVersion: 'runtime-root-control-fixture', internalAddress: 'http://127.0.0.1:1/root-fixture',
    heartbeatIntervalMs: 50, heartbeatTimeoutMs: 1000, startupTimeoutMs: 5000,
    shutdownTimeoutMs: 5000, secretResolveTimeoutMs: 1000, maxSecretBytes: 4096, accountWaitTimeoutMs: 5000,
    database: { host: '127.0.0.1', port: 1, user: 'unconnected', database: 'unconnected', passwordRef: 'RUNTIME_TEST_DB_PASSWORD', ssl: false },
    pg: { maxConnections: 4, maxQueued: 16, queueTimeoutMs: 2000, connectionTimeoutMs: 2000,
      statementTimeoutMs: 3000, lockTimeoutMs: 2000, maxObservedOperations: 16, maxObservers: 24 },
    factory: { maxWaiters: 24, maxWaitersPerAccount: 20, maxBorrows: 24, maxBorrowsPerAccount: 20 },
    saves: { maxAccounts: 4, maxRunning: 2, maxQueued: 8, maxQueuedPerAccount: 4,
      maxTrackedOperations: 16, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 2, maxWaitersPerAccount: 8 },
    accountPolicy: { maxModelRoutes: 1, maxPolicyStringBytes: 64, maxPresetConfigBytes: 256,
      models: [{ provider: 'unmounted', model: 'unmounted' }], presetId: 'root-fixture', presetEntryId: 'cloud-preset',
      presetConfigSha256: accountPresetConfigDigest({ id: 'root-fixture', plugins: [] }, 256), agentLoopEntryId: 'cloud-agent-loop' },
    paths: { sharedAccountsRoot: directory + '/accounts', localCacheRoot: directory + '/cache', maxPathBytes: 4096 },
    native: { configPath: directory + '/account.cordis.yml', installAnchor: directory + '/package.json',
      bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
      requiredEntryIds: ['include'], maxObservedEvents: 8, maxEntries: 8 },
  }
}
