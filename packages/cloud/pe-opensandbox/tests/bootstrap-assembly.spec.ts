import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BootstrapConfig } from '../src/bootstrap/bootstrap.ts'
import type { ManagedCoordinatorConfig } from '../src/managed-coordinator.ts'
import { SOURCE_DIGEST } from '../src/bootstrap/asset-manifest.ts'

const state = vi.hoisted(() => ({
  input: {} as Record<string, unknown>, events: [] as string[], retained: 0,
  ready: Promise.withResolvers<undefined>(), adopted: Promise.withResolvers<undefined>(), sdkClose: Promise.withResolvers<undefined>(),
  guard: (): void => {}, sdkCreated: vi.fn(), epoch: vi.fn(), sandboxCreate: vi.fn(), keeperClosed: vi.fn(),
}))
vi.mock('../src/bootstrap/deployment-reference.ts', () => {
  class Lease {
    constructor(private readonly reference: { path: string }) {}
    assertCurrent(): void { state.events.push(this.reference.path.endsWith('config.json') ? 'selection-current' : 'manifest-current') }
    value(): unknown { return this.reference.path.endsWith('config.json') ? state.input : {
      schema: 'root-daemon-exports-v1', runId: '1'.repeat(32),
      liveness: { kind: 'inherited-fifo-v1', frameBytes: 128, nonce: '2'.repeat(64), device: '3', inode: '4' } } }
    bytes(): Buffer { return Buffer.from('{}') }
    close(): void { state.events.push(this.reference.path.endsWith('config.json') ? 'selection-close' : 'manifest-close') }
  }
  return { RootDeploymentLease: Lease, readRootDeploymentReference: (reference: { path: string }) => new Lease(reference) }
})
vi.mock('../src/bootstrap/keeper-live.ts', () => ({ adoptExportKeeperLive: () => {
  state.adopted.resolve(undefined)
  return { ready: state.ready.promise, signal: new AbortController().signal,
    assertAvailable(): void { state.events.push('keeper-current') },
    closeObserver(): Promise<void> { state.events.push('keeper-close'); state.keeperClosed(); return Promise.resolve(undefined) } }
} }))
vi.mock('../src/export-share.ts', () => ({ createRetainedExecutionExports: () => ({
  share: vi.fn(), assertEpochReleased: state.epoch,
  get retainedShares() { return state.retained }, assertCurrent(): void { state.events.push('exports-current') },
}) }))
vi.mock('../src/bootstrap/factory.ts', () => ({ createRootSdkExecutionOwner: (config: BootstrapConfig) => {
  state.sdkCreated(); state.guard = () => { config.assertDeploymentCurrent() }
  return Promise.resolve({ backend: { create: state.sandboxCreate,
    closeRootActual(): Promise<void> { state.events.push('sdk-close'); config.assertDeploymentCurrent(); return state.sdkClose.promise } },
  runtimes: {}, assertCurrent: () => { config.assertDeploymentCurrent() } })
} }))
import { assembleRootExecutionDeployment } from '../src/bootstrap/assembly.ts'
import { parseRootDeploymentInput } from '../src/bootstrap/deployment-input.ts'

const limits: ManagedCoordinatorConfig = {
  maxBoundAccounts: 2, maxActiveCommands: 2, maxActiveCommandsPerAccount: 1,
  maxResidentCommands: 4, maxResidentCommandsPerAccount: 2, maxResidentBytes: 262144, maxResidentBytesPerAccount: 131072,
  maxStopObservers: 2, stopWaitBudgetMs: 1000, recoveryPageSize: 2,
  allocations: { environmentVersion: 'env-v1', provider: 'selected-docker', createBudgetMs: 1000,
    maxAllocations: 2, maxAllocationsPerAccount: 1, maxWaiters: 4, maxWaitersPerAllocation: 2 },
  store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 16384,
    maxRows: 4, maxCapabilities: 5, maxPendingQueries: 2, maxMutationResponsibilities: 2, maxRetainedBytes: 262144 },
  commands: { allowedTools: ['bash'], maxScopes: 2,
    commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096,
      maxTailBytes: 32, maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2, maxLifetimeMs: 1000, stopWaitMs: 100 } },
  shell: { bashPath: '/bin/bash', timeoutMs: 20, maxTimeoutMs: 100, maxOutputBytes: 32, graceMs: 10 },
}
function input() {
  return { schema: 'pe-opensandbox-root-deployment-v1', selection: {
    serverImageDigest: 'sha256:4900c9b13a02e0cdbec19733b9cc140d7af6d3fa06a06c752d19a3d2e5ee7ca7',
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
beforeEach(() => {
  state.input = input(); state.events.length = 0; state.retained = 0
  state.ready = Promise.withResolvers<undefined>(); state.adopted = Promise.withResolvers<undefined>()
  state.sdkClose = Promise.withResolvers<undefined>()
  state.sdkCreated.mockClear(); state.epoch.mockClear(); state.sandboxCreate.mockClear(); state.keeperClosed.mockClear()
  const original = process
  vi.stubGlobal('process', new Proxy(original, { get(target, key, receiver) {
    if (key === 'platform') return 'linux'
    if (key === 'getuid' || key === 'getgid') return () => 2000
    const value: unknown = Reflect.get(target, key, receiver)
    return value
  } }))
})
afterEach(() => { vi.unstubAllGlobals() })

it('awaits original keeper readiness, preserves epoch-release function and closes SDK before observer/selection', async () => {
  const pending = assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: '4'.repeat(64) }, limits)
  await state.adopted.promise
  expect(state.sdkCreated).not.toHaveBeenCalled()
  state.ready.resolve(undefined)
  const assembly = await pending
  const epochFunction: unknown = Object.getOwnPropertyDescriptor(assembly.deployment, 'assertEpochReleased')?.value
  expect(epochFunction).toBe(state.epoch)
  expect(state.sandboxCreate).not.toHaveBeenCalled()
  const closed = assembly.closeActual()
  expect(assembly.closeActual()).toBe(closed)
  expect(state.events).toContain('sdk-close')
  expect(state.events).not.toContain('keeper-close')
  expect(() => { assembly.deployment.assertCurrent() }).toThrow()
  expect(() => { state.guard() }).not.toThrow()
  state.sdkClose.resolve(undefined); await closed
  expect(state.events.slice(-3)).toEqual(['keeper-close', 'manifest-close', 'selection-close'])
})

it('retains original observer and selection on unpublished retained-share uncertainty', async () => {
  state.ready.resolve(undefined); state.sdkClose.resolve(undefined)
  const assembly = await assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: '4'.repeat(64) }, limits)
  state.retained = 1
  await expect(assembly.closeActual()).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  expect(state.keeperClosed).not.toHaveBeenCalled()
  expect(state.events).not.toContain('selection-close')
  expect(() => parseRootDeploymentInput({ ...input(), status: 'verified' })).toThrow()
})

it.each([60, 120, 600])('accepts the selected backend finite TTL %s before any lifecycle request', (ttlSeconds) => {
  const value = input()
  value.lifecycle.ttlSeconds = ttlSeconds
  expect(parseRootDeploymentInput(value).lifecycle.ttlSeconds).toBe(ttlSeconds)
  expect(state.sandboxCreate).not.toHaveBeenCalled()
})

it.each([59, 601])('refuses TTL %s outside the selected backend policy before allocation', (ttlSeconds) => {
  const value = input()
  value.lifecycle.ttlSeconds = ttlSeconds
  expect(() => parseRootDeploymentInput(value)).toThrow()
  expect(state.sandboxCreate).not.toHaveBeenCalled()
})

it('refuses the predecessor server image instead of claiming its TTL policy changed', () => {
  const value = input()
  value.selection.serverImageDigest = 'sha256:231802e5e5fba30fb95955869a017ae3b56d074d9c72e1c6f2cf1bf60c2856f2'
  expect(() => parseRootDeploymentInput(value)).toThrow()
  expect(state.sandboxCreate).not.toHaveBeenCalled()
})
