/** Actual Cordis/binding composition with scripted Root SQL and SDK transport; no Agent, network or sandbox is created. */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { startNativeAccountBoot, type NativeAccountBootHandle } from '@deepseek-ai/dsh-pe-cloud-runtime/src/native-boot.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import type { AccountBinding, AccountRuntimeService, DrainParticipant, RootMetadataDatabase } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ManagedCoordinator, installManagedExecutionProviders } from '../src/managed-coordinator.ts'
import type { ManagedCoordinatorConfig, ManagedExecutionDeployment } from '../src/managed-coordinator.ts'
import type { NativeAccountExecutionAuthority } from '../src/coordinator.ts'
import { assertAccountExecutionProviders, installIssuedExecutionPort, withAccountApplicationService,
  accountServiceAvailability } from '../src/account-port.ts'
import type { AccountExecutionPort } from '../src/account-port.ts'
import type { SandboxAllocation } from '../src/allocation-types.ts'
import { allocationMigrationSql } from '../src/migrations/allocations.ts'
import { SdkAllocationBackend } from '../src/sdk-lifecycle.ts'
import type { OwnedSdkTransport, SdkLifecycleConfig } from '../src/lifecycle-types.ts'
import { TrustedRuntimeRegistry } from '../src/trusted-runtime.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as accountEntry from '../src/account.ts'
import * as rootEntry from '../src/root.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { CloudAccountFiles, FdMutationFailure, FilesFailure, type AccountFilesProject } from '@deepseek-ai/dsh-pe-cloud-files'
import { copyFacts } from '../src/skill-wire.ts'
import type { SkillProjectGrant, SkillOperationCopies } from '../src/skill-files-types.ts'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { NativeCommandAccount } from '../src/native-command-account.ts'
import { SessionAllocationOwner, type PreparedSandbox } from '../src/allocation-owner.ts'
import type { CommandChannel, CommandSnapshot } from '../src/command-operation.ts'
import type { PreviewHttpOwner } from '../src/application-http.ts'
import type { OriginalDevServiceWork } from '../src/dev-service-consumer.ts'
import type { RegisteredApplicationService } from '../src/types.ts'
import type {} from '@deepseek-ai/dsh-shell-env'

const applicationCleanups: (() => void)[] = []
afterEach(() => { for (const close of applicationCleanups.splice(0)) close(); vi.restoreAllMocks() })

const config: ManagedCoordinatorConfig = {
  maxBoundAccounts: 2, maxActiveCommands: 2, maxActiveCommandsPerAccount: 1,
  maxResidentCommands: 4, maxResidentCommandsPerAccount: 2, maxResidentBytes: 262144, maxResidentBytesPerAccount: 131072,
  maxStopObservers: 2, stopWaitBudgetMs: 1000, recoveryPageSize: 2,
  allocations: { environmentVersion: 'env-v1', provider: 'scripted-deployment', createBudgetMs: 1000,
    maxAllocations: 2, maxAllocationsPerAccount: 1, maxWaiters: 4, maxWaitersPerAllocation: 2 },
  store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 16384,
    maxRows: 4, maxCapabilities: 5, maxPendingQueries: 2, maxMutationResponsibilities: 2, maxRetainedBytes: 262144 },
  commands: { allowedTools: ['bash'], maxScopes: 2,
    commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096,
      maxTailBytes: 32, maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2, maxLifetimeMs: 1000, stopWaitMs: 100 } },
  shell: { bashPath: '/bin/bash', timeoutMs: 20, maxTimeoutMs: 100, maxOutputBytes: 32, graceMs: 10 },
}
const sdkConfig: SdkLifecycleConfig = {
  lifecycleBaseUrl: 'https://managed-fixture.invalid/v1', apiKey: 'component-fixture-only',
  deploymentIdentity: 'scripted-deployment', environmentVersion: config.allocations.environmentVersion,
  provider: config.allocations.provider, imageDigest: `sha256:${'1'.repeat(64)}`, payloadSha256: '2'.repeat(64),
  entrypoint: ['/trusted/root-agent'], platform: 'arm64', cpuCores: 0.5, memoryMiB: 192, ttlSeconds: 120,
  requestTimeoutMs: 1000, stopBudgetMs: 1000, readyPollIntervalMs: 1, maxReadyPolls: 2,
  pageSize: 1, maxPages: 2, maxItems: 2, maxRecords: 2, maxInflightOperations: 4,
  maxRequestBytes: 8192, maxResponseBytes: 8192, maxOperationBytes: 16384, maxFieldBytes: 512,
}
type Rows = Awaited<ReturnType<RootMetadataDatabase['query']>>

function fixture(input: {
  holdMigration?: boolean
  failMigration?: boolean
  retained?: SandboxAllocation
  managed?: ManagedCoordinatorConfig
  applicationFactory?: boolean
  skillCopies?: number
} = {}) {
  const ctx = new Context(), accountContexts: Context[] = []
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const migration = Promise.withResolvers<Rows>(), migrationEntered = Promise.withResolvers<undefined>()
  const transportClose = Promise.withResolvers<undefined>(), transportCloseEntered = Promise.withResolvers<undefined>()
  const query = vi.fn<RootMetadataDatabase['query']>(async (sql) => {
    if (sql === allocationMigrationSql) {
      migrationEntered.resolve(undefined)
      if (input.failMigration) throw new Error('Scripted submitted migration lost its commit acknowledgement')
      return input.holdMigration ? migration.promise : { rows: [] }
    }
    if (!sql.startsWith('SELECT')) throw new Error('This fixture permits only migration and startup recovery reads')
    return { rows: input.retained === undefined ? [] : [{ allocation: input.retained }] }
  })
  const database: RootMetadataDatabase = { query, wasNotSubmitted: () => false }
  let registered: DrainParticipant | undefined, withdraw: (() => void | Promise<void>) | undefined
  const runtimePort = {
    registerDrainParticipant: vi.fn<AccountRuntimeService['registerDrainParticipant']>((participant) => {
      const disposer = runtime.registerDrainParticipant(participant)
      registered = participant; withdraw = disposer
      return disposer
    }),
    controlDatabase: vi.fn<AccountRuntimeService['controlDatabase']>((participant) => {
      if (participant !== registered) throw new Error('Metadata requires the original registered participant')
      return database
    }),
  } satisfies Pick<AccountRuntimeService, 'registerDrainParticipant' | 'controlDatabase'>
  const fetch = vi.fn<OwnedSdkTransport['fetch']>(async () => { throw new Error('No lifecycle request is expected') })
  const close = vi.fn(async () => { transportCloseEntered.resolve(undefined); await transportClose.promise })
  const bootstrap = vi.fn(async (): Promise<never> => { throw new Error('No agent bootstrap is expected') })
  const runtimes = new TrustedRuntimeRegistry({ bootstrap, fence() { throw new Error('No agent fence is expected') } }, 2,
    undefined, input.applicationFactory ? () => { throw new Error('No application I/O is expected') } : undefined)
  const backend = new SdkAllocationBackend(sdkConfig, runtimes, { fetch, close })
  const create = vi.spyOn(backend, 'create'), actualClose = vi.spyOn(backend, 'closeRootActual')
  const observeClose = vi.spyOn(backend, 'closeRoot')
  const deployment = { backend, runtimes,
    ...input.skillCopies === undefined ? {} : { skillCopies: { maxCopiesPerOperation: input.skillCopies } },
    assertCurrent: vi.fn(), assertEpochReleased: vi.fn(),
    share: vi.fn<ManagedExecutionDeployment['share']>(async () => { throw new Error('No file export is expected') }),
  } satisfies ManagedExecutionDeployment
  const owner = new ManagedCoordinator(ctx, runtimePort, input.managed ?? config, deployment)
  const bind = (accountId = 'account-1') => {
    const account = new Context(), lifetime = new AbortController()
    accountContexts.push(account)
    const binding = installAccountBinding(account, {
      accountId: brandString<AccountBinding['accountId']>(accountId), epoch: brandString<AccountBinding['epoch']>('1'),
      recipeVersion: 'managed-component-test', lifetime: lifetime.signal,
    })
    const current = vi.fn(() => { lifetime.signal.throwIfAborted() })
    const authority = {
      assertBusinessCurrent: vi.fn(() => { lifetime.signal.throwIfAborted() }),
      getAgent: vi.fn<NativeAccountExecutionAuthority['getAgent']>(() => undefined),
      projectForAgent: vi.fn<NativeAccountExecutionAuthority['projectForAgent']>(() => { throw new Error('No Agent is expected') }),
      projectForSession: vi.fn<NativeAccountExecutionAuthority['projectForSession']>(() => { throw new Error('No Session is expected') }),
      files: vi.fn<NativeAccountExecutionAuthority['files']>(() => { throw new Error('No files owner is expected') }),
    } satisfies NativeAccountExecutionAuthority
    const port = owner.bindAccount(account, binding, current, authority)
    return { ctx: account, lifetime, binding, current, authority, port }
  }
  onTestFinished(async () => {
    migration.resolve({ rows: [] }); transportClose.resolve(undefined)
    // Failed recovery intentionally retains the original rejected shutdown; contain teardown without inventing a clean receipt.
    await Promise.allSettled([owner.closeRoot()])
    for (const account of accountContexts.reverse()) await account.fiber.dispose()
    await ctx.fiber.dispose()
  })
  return { ctx, runtime, owner, runtimePort, database, deployment, backend, create, actualClose, observeClose,
    fetch, bootstrap, close, query,
    migration, migrationEntered, transportClose, transportCloseEntered, bind,
    withdraw: () => {
      if (withdraw === undefined) throw new Error('Participant was not registered')
      return Promise.resolve(withdraw())
    } }
}

function retainedAllocation(): SandboxAllocation {
  return {
    allocationId: brandString<SandboxAllocation['allocationId']>('retained-1'),
    accountId: brandString<SandboxAllocation['accountId']>('account-1'), epoch: brandString<SandboxAllocation['epoch']>('1'),
    sessionId: brandString<SandboxAllocation['sessionId']>('session-1'),
    workspaceId: brandString<SandboxAllocation['workspaceId']>('workspace-1'),
    environmentVersion: config.allocations.environmentVersion, provider: config.allocations.provider,
    projectMountVersion: 'mount-v1', state: 'creating', sandboxId: null,
    requestedAt: '2026-10-20T00:00:00.000Z', createDeadlineAt: '2026-10-20T00:00:01.000Z',
    lastActivityAt: '2026-10-20T00:00:00.000Z', lastCheckedAt: '2026-10-20T00:00:00.000Z',
    runtimeIdentity: null, executionProtocolVersion: null, executionCapabilities: [], failureCode: null,
  }
}

it('retains its original runtime registration while shutdown joins a pending migration and actual backend close', async () => {
  const f = fixture({ holdMigration: true }), starting = f.owner.start()
  const refusedStart = expect(starting).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  await f.migrationEntered.promise
  expect(f.owner.start()).toBe(starting)
  expect(f.runtimePort.controlDatabase).toHaveBeenCalledWith(f.owner)
  expect(f.runtimePort.controlDatabase).toHaveReturnedWith(f.database)
  let closed = false, withdrawn = false
  const closing = f.owner.closeRoot().then(() => { closed = true })
  const withdrawal = f.withdraw().then(() => { withdrawn = true })
  await f.transportCloseEntered.promise
  expect(closed).toBe(false); expect(withdrawn).toBe(false)
  expect(f.actualClose).toHaveBeenCalledTimes(1); expect(f.observeClose).not.toHaveBeenCalled()
  expect(() => { f.owner.assertReady() }).toThrow(expect.objectContaining({ code: 'cloud/execution-unavailable' }))
  expect(() => f.runtime.registerDrainParticipant(f.owner)).toThrow('Duplicate')
  f.migration.resolve({ rows: [] }); await refusedStart
  expect(closed).toBe(false); expect(withdrawn).toBe(false)
  expect(f.query).toHaveBeenCalledTimes(2)
  f.transportClose.resolve(undefined); await closing; await withdrawal
  expect(closed).toBe(true); expect(withdrawn).toBe(true)
  const unregister = f.runtime.registerDrainParticipant(f.owner)
  await unregister()
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

it('keeps a submitted unknown migration closed and retains the participant after shutdown rejects', async () => {
  const f = fixture({ failMigration: true }), starting = f.owner.start()
  await expect(starting).rejects.toMatchObject({ code: 'unknown' })
  expect(f.owner.start()).toBe(starting)
  expect(() => { f.owner.assertReady() }).toThrow(expect.objectContaining({ code: 'cloud/execution-unavailable' }))
  const closing = f.owner.closeRoot()
  const failedClose = expect(closing).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  f.transportClose.resolve(undefined); await failedClose
  await expect(f.withdraw()).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  expect(f.owner.closeRoot()).toBe(closing)
  expect(() => f.runtime.registerDrainParticipant(f.owner)).toThrow('Duplicate')
  expect(f.query).toHaveBeenCalledTimes(1)
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

it('refuses readiness and clean shutdown for an actual validated nonterminal allocation without replaying create', async () => {
  const retained = retainedAllocation(), f = fixture({ retained }), starting = f.owner.start()
  await expect(starting).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  expect(() => { f.owner.assertReady() }).toThrow(expect.objectContaining({ code: 'cloud/execution-unavailable' }))
  expect(f.owner.start()).toBe(starting)
  const closing = f.owner.closeRoot()
  const failedClose = expect(closing).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  f.transportClose.resolve(undefined); await failedClose
  expect(f.query).toHaveBeenCalledTimes(2)
  expect(f.query.mock.calls[1]?.[1]).toEqual([null, null, null, String(config.recoveryPageSize)])
  expect(retained.state).toBe('creating')
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

it('binds and installs the real account providers lazily without a files owner, Agent or sandbox', async () => {
  const f = fixture(); await f.owner.start()
  const a = f.bind()
  expect(a.port.binding).toBe(a.binding)
  expect(a.ctx.get('shell')).toBeUndefined(); expect(a.ctx.get('subprocess')).toBeUndefined()
  expect(a.ctx.get('shellEnv')).toBeUndefined()
  installIssuedExecutionPort(a.ctx, a.port)
  await expect(a.ctx.plugin(accountEntry, { mode: 'closed', requiredCapabilities: [] }))
    .rejects.toMatchObject({ code: 'cloud/invalid-config' })
  await expect(a.ctx.plugin(accountEntry, { mode: 'session-collect', requiredCapabilities: ['pipes'] }))
    .rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  await a.ctx.plugin(accountEntry, { mode: 'session-collect', requiredCapabilities: ['argv-collect'] })
  expect(() => { assertAccountExecutionProviders(a.ctx) }).not.toThrow()
  expect(a.ctx.get('shell')).toBeDefined(); expect(a.ctx.get('subprocess')).toBeDefined()
  expect(a.ctx.get('shellEnv')).toBeDefined()
  expect(a.ctx.get('peAccount')).toBe(a.binding)
  expect(a.ctx.get('agents')).toBeUndefined(); expect(a.ctx.get('peCloudFiles')).toBeUndefined()
  for (const callback of Object.values(a.authority)) expect(callback).not.toHaveBeenCalled()
  expect(f.deployment.share).not.toHaveBeenCalled(); expect(f.bootstrap).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

it('requires native tools before claiming service providers and removes the original service tool on account entry disposal', async () => {
  const managed: ManagedCoordinatorConfig = { ...config, commands: { ...config.commands,
    allowedTools: ['bash', 'dev_service'], commandLimits: { ...config.commands.commandLimits,
      pollIntervalMs: 1000, maxLifetimeMs: 190000 },
    services: { maxOutputBytes: 32, graceMs: 1000,
      profile: { kind: 'python-http-v1', port: 8000, startWaitMs: 5000, runMs: 120000, stopWaitMs: 5000,
        maxLogReadBytes: 96, maxReplyBytes: 4096, maxScriptBytes: 256, maxArgs: 8, maxArgBytes: 256, maxArgsBytes: 2048 } } } }
  const f = fixture({ managed }); await f.owner.start()
  const account = f.bind(), claim = vi.spyOn(f.owner, 'claim')
  installIssuedExecutionPort(account.ctx, account.port)
  await expect(account.ctx.plugin(accountEntry, { mode: 'session-collect', requiredCapabilities: ['argv-collect'] }))
    .rejects.toMatchObject({ code: 'cloud/invalid-config' })
  expect(claim).not.toHaveBeenCalled()
  expect(account.ctx.get('shell')).toBeUndefined()
  await account.ctx.plugin(SystemPrompt); await account.ctx.plugin(ToolRuntime)
  const tools = account.ctx.get('tools')!
  expect(tools.get('dev_service')).toBeUndefined()
  const entry = await account.ctx.plugin(accountEntry, { mode: 'session-collect', requiredCapabilities: ['argv-collect'] })
  expect(tools.get('dev_service')?.name).toBe('dev_service')
  expect(() => { assertAccountExecutionProviders(account.ctx) }).not.toThrow()
  expect(f.deployment.share).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
  expect(f.bootstrap).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  await entry.dispose()
  expect(tools.get('dev_service')).toBeUndefined()
  expect(f.deployment.share).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
})

it('does not confirm epoch cleanup when an export preparation retained an unpublished descriptor responsibility', async () => {
  const f = fixture()
  await f.owner.start()
  const account = f.bind()
  const failure = new Error('Original export preparation cleanup remains unconfirmed')
  f.deployment.assertEpochReleased.mockImplementation((binding) => {
    expect(binding).toBe(account.binding)
    throw failure
  })
  const receipt = await f.owner.stopEpoch(account.binding, Date.now() + 1000)
  expect(receipt.status).toBe('unknown')
  expect(f.deployment.assertEpochReleased).toHaveBeenCalledTimes(1)
  f.transportClose.resolve(undefined)
  await expect(f.owner.closeRoot()).rejects.toBe(failure)
  expect(f.create).not.toHaveBeenCalled()
})

it('cannot turn managed Loader JSON into Root deployment authority', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const managed = { ...config, commands: { ...config.commands, commandLimits: { ...config.commands.commandLimits,
    pollIntervalMs: 1000, maxLifetimeMs: 20000 } } }
  await expect(rootEntry.apply(ctx, { mode: 'session-collect', requiredCapabilities: ['argv-collect'], managed }))
    .rejects.toMatchObject({ code: 'cloud/invalid-config',
      message: 'Managed execution requires its original protected Root deployment.' })
  expect(ctx.get('peSandboxCoordinator')).toBeUndefined()
  expect(ctx.get('shell')).toBeUndefined()
})

it('requires the installed original port before claiming providers and rejects foreign or shadowed services', async () => {
  const f = fixture(); await f.owner.start()
  const a = f.bind('account-a'), b = f.bind('account-b')
  const claim = vi.spyOn(f.owner, 'claim')
  const copied: AccountExecutionPort = { ...a.port,
    assertCurrent: a.port.assertCurrent.bind(a.port), deny: a.port.deny.bind(a.port),
    claim: a.port.claim.bind(a.port), close: a.port.close.bind(a.port) }
  const stale: unknown = expect.objectContaining({ code: 'cloud/stale-generation' })
  expect(() => { installManagedExecutionProviders(a.ctx, a.port) }).toThrow(stale)
  expect(claim).not.toHaveBeenCalled()
  expect(() => { installIssuedExecutionPort(a.ctx, copied) }).toThrow(stale)
  expect(() => { installIssuedExecutionPort(b.ctx, a.port) }).toThrow(stale)
  expect(() => { a.port.assertCurrent(b.ctx) }).toThrow(stale)
  expect(() => f.owner.bindAccount(a.ctx, { ...a.binding }, a.current, a.authority)).toThrow(stale)
  for (const account of [a, b]) installIssuedExecutionPort(account.ctx, account.port)
  installManagedExecutionProviders(b.ctx, b.port)
  for (const key of ['shell', 'subprocess', 'shellEnv'] as const) {
    const unprovide = a.ctx.provide(key, b.ctx[key])
    try {
      expect(() => { installManagedExecutionProviders(a.ctx, a.port) }).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
      expect(claim).toHaveBeenCalledTimes(1)
    } finally { unprovide() }
    expect(a.ctx.get(key)).toBeUndefined()
  }
  installManagedExecutionProviders(a.ctx, a.port)
  expect(claim).toHaveBeenCalledTimes(2)
  expect(() => { installManagedExecutionProviders(a.ctx, a.port) }).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
  expect(() => { assertAccountExecutionProviders(b.ctx) }).not.toThrow()
  const replacedEnv = b.ctx.isolate('shellEnv')
  replacedEnv.provide('shellEnv', a.ctx.shellEnv)
  expect(() => { assertAccountExecutionProviders(replacedEnv) }).toThrow(stale)
  expect(() => { assertAccountExecutionProviders(a.ctx) }).not.toThrow()
  const replaced = a.ctx.isolate('shell')
  replaced.provide('shell', b.ctx.shell)
  expect(() => { assertAccountExecutionProviders(replaced) }).toThrow(stale)
  // The same-fiber replacement also invalidates the original provider registration audit.
  expect(() => { assertAccountExecutionProviders(a.ctx) }).toThrow(stale)
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

it('keeps expired epoch and SDK shutdown observations separate from later actual confirmation', async () => {
  const f = fixture(); await f.owner.start()
  const a = f.bind()
  installIssuedExecutionPort(a.ctx, a.port); installManagedExecutionProviders(a.ctx, a.port)
  const expired = await f.owner.stopEpoch(a.binding, Date.now() - 1)
  expect(expired).toMatchObject({ participant: 'execution', accountId: a.binding.accountId, epoch: a.binding.epoch, status: 'unknown' })
  expect(expired.pendingOperationIds).toHaveLength(1)
  const confirmed = await f.owner.stopEpoch(a.binding, Date.now() + 1000)
  expect(confirmed).toMatchObject({ status: 'confirmed', pendingOperationIds: [] })
  expect(expired.status).toBe('unknown')
  let closed = false
  const actual = f.owner.closeRoot(), closing = actual.then(() => { closed = true })
  expect(f.owner.closeRoot()).toBe(actual)
  await f.transportCloseEntered.promise
  expect(closed).toBe(false); expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.actualClose).toHaveBeenCalledTimes(1); expect(f.observeClose).not.toHaveBeenCalled()
  const backendActual = f.backend.closeRootActual()
  expect(f.backend.closeRootActual()).toBe(backendActual)
  // Losing an SDK shutdown observation must not poison Root's original actual-close promise.
  await expect(f.backend.closeRoot(Date.now() - 1)).rejects.toMatchObject({ code: 'sdk/close-unconfirmed' })
  expect(f.owner.closeRoot()).toBe(actual); expect(closed).toBe(false)
  f.transportClose.resolve(undefined); await closing
  await backendActual
  expect(closed).toBe(true)
  await expect(f.backend.closeRoot(Date.now() + 1000)).resolves.toBeUndefined()
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

/** Root budget integration over real Cordis/Agent/native rows; allocation and HTTP I/O are scripted at existing methods. */
async function applicationFixture(options: {
  maximum?: number
  perAccount?: number
  bytes?: number
  globalBytes?: number
  application?: boolean
  services?: boolean
  skillCopies?: number
} = {}) {
  const managed: ManagedCoordinatorConfig = { ...config, maxActiveCommands: 8, maxActiveCommandsPerAccount: 4,
    maxResidentCommands: 16, maxResidentCommandsPerAccount: 8,
    maxResidentBytes: options.globalBytes ?? options.bytes ?? 1048576, maxResidentBytesPerAccount: options.bytes ?? 1048576,
    allocations: { ...config.allocations, maxAllocations: 4, maxAllocationsPerAccount: 2 },
    commands: { ...config.commands, allowedTools: ['bash', 'dev_service'], maxScopes: 8,
      commandLimits: { ...config.commands.commandLimits, pollIntervalMs: 1000, maxLifetimeMs: 190000, maxWaiters: 4,
        ...options.skillCopies === undefined ? {} : { maxArgvBytes: 256, maxArgvEntries: 8, maxPathBytes: 128, maxStdinBytes: 256 } },
      ...(options.services === false ? {} : { services: { maxOutputBytes: 32, graceMs: 1000,
        profile: { kind: 'python-http-v1', port: 8000, startWaitMs: 5000, runMs: 120000, stopWaitMs: 5000,
          maxLogReadBytes: 96, maxReplyBytes: 4096, maxScriptBytes: 256, maxArgs: 8, maxArgBytes: 256, maxArgsBytes: 2048 },
        ...(options.application === false ? {} : { application: { maxRequests: options.maximum ?? 2,
          maxRequestsPerAccount: options.perAccount ?? 1, maxRequestsPerService: 1,
          transport: { readBufferBytes: 32, prefetchBytes: 64, maxWireBytes: 1048576, maxRequestHeaderBytes: 4096,
            maxPathBytes: 2048, timeoutMs: 5000, maxBufferPoolBytes: 8192 } } }) } }) } }
  const f = fixture({ managed, ...options.skillCopies === undefined ? {} : { skillCopies: options.skillCopies } }); await f.owner.start()
  const channels: { sessionId: SessionId; empty(): void }[] = []
  const attempts: { readonly terminal: ReturnType<typeof Promise.withResolvers<undefined>>; readonly controller: AbortController }[] = []
  const attach = vi.spyOn(NativeCommandAccount.prototype, 'attachOriginal')
  // Existing allocation method is the external preparation boundary; it never invokes a files owner or backend here.
  const prepare = vi.spyOn(SessionAllocationOwner.prototype, 'prepare').mockImplementation(async request => ({
    sandboxId: String(request.sessionId), runtimeIdentity: '1'.repeat(64), protocolVersion: 'component-only', capabilities: ['argv-collect'] }))
  vi.spyOn(SessionAllocationOwner.prototype, 'stop').mockImplementation(async (request) => {
    for (const channel of channels) if (channel.sessionId === request.sessionId) channel.empty()
  })
  // Scripted preparation does not register a real runtime or project-copy capability.
  vi.spyOn(f.deployment.runtimes, 'skillProject').mockReturnValue(undefined)
  const service = vi.spyOn(f.deployment.runtimes, 'service').mockImplementation((prepared, registration) => {
    registration.bindAllocation(brandString<Parameters<typeof registration.bindAllocation>[0]>(prepared.sandboxId))
    const initial: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
      physicalStopRequired: false, providerFailure: false, direct: undefined,
      stdout: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }, stderr: { bytes: Buffer.alloc(0), observedBytes: 0, eof: false } }
    let current = initial
    const polls: ReturnType<typeof Promise.withResolvers<CommandSnapshot>>[] = []
    const empty = (): void => {
      current = { ...current, rangeEmpty: true, ioClosed: true, commitClosed: true,
        stdout: { ...current.stdout, eof: true }, stderr: { ...current.stderr, eof: true } }
      for (const poll of polls.splice(0)) poll.resolve(current)
    }
    channels.push({ sessionId: registration.scope.sessionId, empty })
    return { prepare: async () => initial, commit: async () => { current = { ...current, submitted: true }; return current },
      poll: async () => {
        if (current.rangeEmpty) return current
        const deferred = Promise.withResolvers<CommandSnapshot>(); polls.push(deferred); return deferred.promise
      }, stop: async () => { empty(); return current } } satisfies CommandChannel
  })
  const application = vi.spyOn(f.deployment.runtimes, 'application').mockImplementation((_registration, _identity, _limits, owner) => ({
    async withResponse(_request, _responseLimits, signal, consume) {
      const terminal = Promise.withResolvers<undefined>(), controller = new AbortController()
      void terminal.promise.catch((_cause: unknown) => { /* Original request owner observes this same rejected terminal. */ })
      const input: Parameters<PreviewHttpOwner['retainRequest']>[0] = { controller, settled: terminal.promise,
        charge: { retainedPayloadBytes: 4096, headerEntries: 11, maxWireBytes: 1048576, timeoutMs: 5000 } }
      const retained = owner.retainRequest(input)
      attempts.push({ terminal, controller })
      retained.assertCurrent(); signal.throwIfAborted()
      await consume({ status: 200, headers: [], read: async () => null, close: async () => {} })
      await terminal.promise
      controller.signal.throwIfAborted()
    },
  }))
  applicationCleanups.push(() => {
    for (const attempt of attempts) attempt.terminal.resolve(undefined)
    for (const channel of channels) channel.empty()
  })
  let serial = 0
  const account = async (id: string, sessions = 2) => {
    const a = f.bind(id)
    await mountAgentLoopTestDependencies(a.ctx, { tools: { mode: 'native' } })
    provideWorkingDirectoryFixture(a.ctx, '/project')
    const harness = await mountAgentLoopTestHarness(a.ctx)
    const agents = await Promise.all(Array.from({ length: sessions }, (_, i) =>
      harness.create(SessionId(`${id}-${i + 1}`), {}, { cwd: '/project' })))
    const workspace: Workspace = { id: brandString<Workspace['id']>(`${id}-project`), path: '/project',
      sessionIds: agents.map(agent => agent.session.id), title: 'component', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
      setTitle: async () => {}, attachSession: async () => {}, detachSession: async () => {}, insertSessionBefore: async () => {}, status: async () => 'ok' }
    a.authority.getAgent.mockImplementation(agentId => a.ctx.agents.get(agentId))
    a.authority.projectForAgent.mockImplementation(() => workspace)
    a.authority.projectForSession.mockImplementation(() => workspace)
    installIssuedExecutionPort(a.ctx, a.port); installManagedExecutionProviders(a.ctx, a.port)
    const start = async (index = 0): Promise<OriginalDevServiceWork<Workspace>> => {
      const agent = agents[index]
      if (agent === undefined) throw new Error('No original fixture Agent')
      const result = await a.ctx.tools.execute({ callId: ToolCallId(`service-${++serial}`), name: 'dev_service', agent,
        signal: new AbortController().signal, arguments: { action: 'start', script: 'server.py' } })
      if (result.isError) throw new Error(result.error.message)
      const original = attach.mock.results.at(-1)
      if (original?.type !== 'return') throw new Error('No original native work')
      return original.value
    }
    const borrow = (work: OriginalDevServiceWork<Workspace>, consume?: (value: RegisteredApplicationService) => Promise<void>) =>
      withAccountApplicationService(a.ctx, { sessionId: work.lease.scope.sessionId, serviceId: work.handle },
        new AbortController().signal, Date.now() + 10000, consume ?? (value => value.withResponse(
          { method: 'GET', resourcePath: '/', headers: [] },
          { maxBodyBytes: 64, maxChunkBytes: 16, maxChunks: 4, maxHeaderCount: 8, maxHeaderBytes: 512 },
          new AbortController().signal, async () => {})))
    return { ...a, agents, start, borrow }
  }
  return { ...f, prepare, service, application, attempts, account,
    emptyChannels: () => { for (const channel of channels) channel.empty() } }
}

function trackApplication(actual: Promise<void>) {
  const state: { settled: boolean; cause?: unknown } = { settled: false }
  const joined = actual.then(() => { state.settled = true }, (cause: unknown) => { state.settled = true; state.cause = cause })
  return { state, joined }
}

it('shares account request ceilings across original service rows and reuses a slot only after its terminal', async () => {
  const f = await applicationFixture(), a = await f.account('A'), b = await f.account('B')
  const a1 = await a.start(), a2 = await a.start(1), b1 = await b.start()
  const first = trackApplication(a.borrow(a1))
  await vi.waitFor(() => { if (first.state.cause !== undefined) throw first.state.cause; expect(f.attempts).toHaveLength(1) })
  await expect(a.borrow(a2)).rejects.toMatchObject({ code: 'cloud/capacity' })
  const second = trackApplication(b.borrow(b1))
  await vi.waitFor(() => { expect(f.attempts).toHaveLength(2) })
  expect(first.state.settled).toBe(false); expect(second.state.settled).toBe(false)
  f.attempts[0]!.terminal.resolve(undefined); await first.joined
  expect(first.state.cause).toBeUndefined()
  const replacement = trackApplication(a.borrow(a2))
  await vi.waitFor(() => { expect(f.attempts).toHaveLength(3) })
  f.attempts[1]!.terminal.resolve(undefined); f.attempts[2]!.terminal.resolve(undefined)
  await second.joined; await replacement.joined
  expect(second.state.cause).toBeUndefined(); expect(replacement.state.cause).toBeUndefined()
  expect(f.prepare).toHaveBeenCalledTimes(3); expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

it.each(['same-account', 'other-account'] as const)(
  'charges application bytes against original %s resident service capacity before another prepare', async (variant) => {
    const f = await applicationFixture({ bytes: 40000, globalBytes: variant === 'same-account' ? 80000 : 40000 }), a = await f.account('A'), b = await f.account('B')
    const work = await a.start(), pending = trackApplication(a.borrow(work))
    await vi.waitFor(() => { expect(f.attempts).toHaveLength(1) })
    const next = variant === 'same-account' ? () => a.start(1) : () => b.start()
    await expect(next()).rejects.toThrow('configured cloud execution capacity is exhausted')
    expect(f.prepare).toHaveBeenCalledTimes(1)
    f.attempts[0]!.terminal.resolve(undefined); await pending.joined
    expect(pending.state.cause).toBeUndefined()
    await next()
    expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })

it('keeps rejected HTTP terminal capacity charged after physical range cleanup and refuses another account request', async () => {
  const f = await applicationFixture({ maximum: 1 }), a = await f.account('A'), b = await f.account('B')
  const a1 = await a.start(), b1 = await b.start(), pending = trackApplication(a.borrow(a1))
  await vi.waitFor(() => { expect(f.attempts).toHaveLength(1) })
  f.attempts[0]!.terminal.reject(new Error('scripted terminal cleanup unconfirmed')); await pending.joined
  expect(pending.state.cause).toMatchObject({ code: 'cloud/stop-unconfirmed' })
  await expect(b.borrow(b1)).rejects.toMatchObject({ code: 'cloud/capacity' })
  const stopped = await f.owner.stopEpoch(a.binding, Date.now() + 1000)
  expect(stopped.status).toBe('unknown')
  expect(f.attempts).toHaveLength(1); expect(f.prepare).toHaveBeenCalledTimes(2)
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

it.each(['application-absent', 'services-absent', 'other-account', 'other-session', 'old-generation'] as const)(
  'refuses %s through the original public account helper without new preparation or application I/O', async (variant) => {
    const f = await applicationFixture({ application: variant !== 'application-absent', services: variant !== 'services-absent' })
    const a = await f.account('A'), b = await f.account('B')
    const work = variant === 'services-absent' ? undefined : await a.start()
    const prepared = f.prepare.mock.calls.length
    if (variant === 'old-generation') a.lifetime.abort(new Error('old generation closed'))
    const ctx = variant === 'other-account' ? b.ctx : a.ctx
    const sessionId = variant === 'other-session' ? a.agents[1]!.session.id : work?.lease.scope.sessionId ?? a.agents[0]!.session.id
    const serviceId = work?.handle ?? brandString<OriginalDevServiceWork<Workspace>['handle']>('not-registered')
    const consume = vi.fn(async () => {})
    await expect(withAccountApplicationService(ctx, { sessionId, serviceId }, new AbortController().signal,
      Date.now() + 10000, consume)).rejects.toThrow()
    expect(consume).not.toHaveBeenCalled(); expect(f.application).not.toHaveBeenCalled()
    expect(f.prepare).toHaveBeenCalledTimes(prepared); expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })

it('enforces the global request ceiling even when a different account has remaining local capacity', async () => {
  const f = await applicationFixture({ perAccount: 2 }), a = await f.account('A'), b = await f.account('B')
  const a1 = await a.start(), a2 = await a.start(1), b1 = await b.start()
  const first = trackApplication(a.borrow(a1)), second = trackApplication(a.borrow(a2))
  await vi.waitFor(() => { expect(f.attempts).toHaveLength(2) })
  await expect(b.borrow(b1)).rejects.toMatchObject({ code: 'cloud/capacity' })
  expect(f.attempts).toHaveLength(2)
  f.attempts[0]!.terminal.resolve(undefined); await first.joined
  const replacement = trackApplication(b.borrow(b1))
  await vi.waitFor(() => { expect(f.attempts).toHaveLength(3) })
  f.attempts[1]!.terminal.resolve(undefined); f.attempts[2]!.terminal.resolve(undefined); await second.joined; await replacement.joined
  expect(second.state.cause).toBeUndefined(); expect(replacement.state.cause).toBeUndefined()
  expect(f.prepare).toHaveBeenCalledTimes(3); expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

it('retains unknown request bytes in the same global resident pool after the original physical stop callback', async () => {
  const f = await applicationFixture({ bytes: 50000 }), a = await f.account('A'), b = await f.account('B')
  const a1 = await a.start(); await b.start()
  const pending = trackApplication(a.borrow(a1))
  await vi.waitFor(() => { expect(f.attempts).toHaveLength(1) })
  f.attempts[0]!.terminal.reject(new Error('scripted terminal cleanup unconfirmed')); await pending.joined
  expect(pending.state.cause).toMatchObject({ code: 'cloud/stop-unconfirmed' })
  await expect(b.start(1)).rejects.toThrow('configured cloud execution capacity is exhausted')
  expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

function serviceAvailabilityConfig(application = true): ManagedCoordinatorConfig {
  return { ...config, commands: { ...config.commands, allowedTools: ['bash', 'dev_service'],
    commandLimits: { ...config.commands.commandLimits, pollIntervalMs: 1000, maxLifetimeMs: 190000 },
    services: { maxOutputBytes: 32, graceMs: 1000,
      profile: { kind: 'python-http-v1', port: 8000, startWaitMs: 5000, runMs: 120000, stopWaitMs: 5000,
        maxLogReadBytes: 96, maxReplyBytes: 4096, maxScriptBytes: 256, maxArgs: 8, maxArgBytes: 256, maxArgsBytes: 2048 },
      ...application ? { application: { maxRequests: 2, maxRequestsPerAccount: 1, maxRequestsPerService: 1,
        transport: { readBufferBytes: 32, prefetchBytes: 64, maxWireBytes: 1048576, maxRequestHeaderBytes: 4096,
          maxPathBytes: 2048, timeoutMs: 5000, maxBufferPoolBytes: 8192 } } } : {},
    } } }
}
async function installedServices(options: { services?: boolean; application?: boolean; factory?: boolean } = {}) {
  const f = fixture({ managed: options.services === false ? config : serviceAvailabilityConfig(options.application !== false),
    applicationFactory: options.factory !== false })
  await f.owner.start()
  const a = f.bind(); installIssuedExecutionPort(a.ctx, a.port)
  if (options.services !== false) { await a.ctx.plugin(SystemPrompt); await a.ctx.plugin(ToolRuntime) }
  const entry = await a.ctx.plugin(accountEntry, { mode: 'session-collect', requiredCapabilities: ['argv-collect'] })
  return { ...f, a, entry }
}
it('reads original service consumer and factory availability without allocating or executing user work', async () => {
  const f = await installedServices()
  expect(accountServiceAvailability(f.a.ctx)).toEqual({ developmentServices: true, servicePreview: true })
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  expect(f.bootstrap).not.toHaveBeenCalled(); expect(f.deployment.share).not.toHaveBeenCalled()
})
it.each([{ services: false }, { application: false }, { factory: false }])('keeps absent service inputs closed: %j', async (options) => {
  const f = await installedServices(options)
  expect(accountServiceAvailability(f.a.ctx)).toEqual({ developmentServices: options.services !== false, servicePreview: false })
})
it('rejects service availability after original provider disposal', async () => {
  const f = await installedServices(); expect(accountServiceAvailability(f.a.ctx).servicePreview).toBe(true)
  await f.entry.dispose(); expect(() => accountServiceAvailability(f.a.ctx)).toThrow()
})
it('rejects a replaced development-service definition', async () => {
  const f = await installedServices(), tools = f.a.ctx.get('tools')!, definition = tools.get('dev_service')!
  vi.spyOn(tools, 'get').mockImplementation(name => name === 'dev_service' ? { ...definition } : undefined)
  expect(() => accountServiceAvailability(f.a.ctx)).toThrow()
})
it('rejects a real replacement Tools provider in the actual consumer scope and an ended binding', async () => {
  const f = await installedServices(), shadow = f.a.ctx.isolate('tools')
  await shadow.plugin(ToolRuntime)
  expect(() => accountServiceAvailability(shadow)).toThrow()
  expect(accountServiceAvailability(f.a.ctx).servicePreview).toBe(true)
  f.a.lifetime.abort(); expect(() => accountServiceAvailability(f.a.ctx)).toThrow()
})
it('rejects a copied execution port during service inspection', async () => {
  const f = await installedServices(), shadow = f.a.ctx.isolate('peAccountExecution')
  shadow.provide('peAccountExecution', { ...f.a.port } as AccountExecutionPort)
  expect(() => accountServiceAvailability(shadow)).toThrow()
})
it.each([true, false])('uses original NativeBoot and account entry with service tools dependency=%s', async (edge) => {
  const f = fixture({ managed: serviceAvailabilityConfig(), applicationFactory: true }); await f.owner.start()
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-cloud-service-availability-')))
  const owned: { handle?: NativeAccountBootHandle } = {}
  onTestFinished(async () => { await owned.handle?.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const home = join(directory, 'home'), cwd = join(directory, 'project'), dir = join(home, 'profiles', 'offline')
  mkdirSync(cwd, { recursive: true }); initProfile(dir, [])
  const configPath = join(dir, 'cordis.yml'); writeFileSync(configPath, '[]\n')
  const rows = [{ id: 'system-prompt', name: 'cordis:system-prompt' },
    { id: 'tools', name: 'cordis:tools', config: { mode: 'native' } },
    { id: 'execution-account', name: 'cordis:pe-cloud-execution-account',
      config: { mode: 'session-collect', requiredCapabilities: ['argv-collect'] }, ...edge ? { inject: ['tools'] } : {} }]
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]) + '\n')
  const profile: ProfileContext = { name: 'offline', dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(directory, 'package.json'), cwd, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  writeFileSync(profile.installAnchor, '{"name":"isolated-service-availability","private":true}\n')
  const lifetime = new AbortController(), claim = vi.spyOn(f.owner, 'claim')
  const handle = startNativeAccountBoot({ binding: { accountId: brandString<AccountBinding['accountId']>('offline-loader-services'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'offline-availability', lifetime: lifetime.signal },
  profile, configPath, bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: home, DSH_HOME: home } }]),
  requiredEntryIds: ['include', 'execution-account', 'system-prompt', 'tools'], maxObservedEvents: 32, maxEntries: 16,
  prepare(ctx, binding) {
    const noUse = (): never => { throw new Error('No native user work is expected') }
    const port = f.owner.bindAccount(ctx, binding, () => { lifetime.signal.throwIfAborted() }, {
      assertBusinessCurrent: () => { lifetime.signal.throwIfAborted() }, getAgent: () => undefined,
      projectForAgent: noUse, projectForSession: noUse, files: noUse,
    })
    installIssuedExecutionPort(ctx, port)
    Object.assign(ctx.loader.builtins, { 'system-prompt': SystemPrompt, tools: ToolRuntime, 'pe-cloud-execution-account': accountEntry })
  } })
  owned.handle = handle
  const outcome = await handle.result
  if (edge) {
    expect(outcome.status).toBe('mounted'); if (outcome.status !== 'mounted') throw outcome.cause
    expect(accountServiceAvailability(outcome.context)).toEqual({ developmentServices: true, servicePreview: true })
    expect(claim).toHaveBeenCalledTimes(1); expect(outcome.context.get('agents')).toBeUndefined()
  } else { expect(outcome.status).toBe('failed'); expect(claim).not.toHaveBeenCalled() }
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.bootstrap).not.toHaveBeenCalled()
})


/** Actual Tools/Agent/subprocess/coordinator path; the existing allocation and carrier frontiers are scripted. */
async function continuationFixture(sessions = 2) {
  const f = await applicationFixture(), a = await f.account('continuation', sessions), counts = new Map<string, number>()
  let generation = 0, serial = 0
  f.prepare.mockImplementation(async () => ({ sandboxId: `compute-${generation}`, runtimeIdentity: String(generation).padStart(64, '1'),
    protocolVersion: 'scripted-original-frontier', capabilities: ['argv-collect'] }))
  const stop = vi.spyOn(SessionAllocationOwner.prototype, 'stop')
  stop.mockImplementation(async () => { generation++ })
  const retire = vi.spyOn(f.backend, 'retireStopped').mockImplementation(() => {})
  const due = vi.spyOn(f.deployment.runtimes, 'needsContinuation').mockImplementation(prepared => (counts.get(prepared.sandboxId) ?? 0) >= 4)
  const command = vi.spyOn(f.deployment.runtimes, 'command').mockImplementation((prepared) => {
    counts.set(prepared.sandboxId, (counts.get(prepared.sandboxId) ?? 0) + 1)
    const empty = { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }
    const initial: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false,
      ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: empty, stderr: empty }
    const complete: CommandSnapshot = { ...initial, submitted: true, rangeEmpty: true, ioClosed: true,
      direct: { exitCode: 0, signal: null }, stdout: { ...empty, eof: true }, stderr: { ...empty, eof: true } }
    return { prepare: async () => initial, commit: async () => complete, poll: async () => complete, stop: async () => complete }
  })
  const dispose = a.ctx.tools.register(defineTool({ name: 'bash', description: 'Synthetic native command consumer for continuation components.', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] }, execute: async () => {
      const handle = a.ctx.subprocess.spawn({ argv: ['/bin/true'], cwd: '/project', graceMs: 100,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } } })
      const outcome = await handle.done
      if (!await handle.waitForExit()) throw new Error('Original range remains active')
      return { exitCode: outcome.exitCode }
    } }))
  applicationCleanups.push(dispose)
  const run = (signal = new AbortController().signal) => a.ctx.tools.execute({ callId: ToolCallId(`continuation-${++serial}`),
    name: 'bash', arguments: {}, agent: a.agents[0]!, signal })
  const runSession = (index: number, signal = new AbortController().signal) => a.ctx.tools.execute({ callId: ToolCallId(`continuation-${++serial}`),
    name: 'bash', arguments: {}, agent: a.agents[index]!, signal })
  return { ...f, a, counts, stop, due, command, retire, run, runSession }
}

/** Exercises original coordinator/native ownership; external ready/stop frontiers are scripted, never deployment evidence. */
async function idleComputeFixture() {
  const f = await continuationFixture(4), prepared = new Map<object, PreparedSandbox>()
  let serial = 0
  f.prepare.mockImplementation(async (request) => {
    let value = prepared.get(request)
    if (value === undefined) {
      value = { sandboxId: `warm-${++serial}`, runtimeIdentity: String(serial).padStart(64, '1'),
        protocolVersion: 'scripted-original-frontier', capabilities: ['argv-collect'] }
      prepared.set(request, value)
    }
    return value
  })
  const observe = vi.spyOn(SessionAllocationOwner.prototype, 'preparedForRetirement')
    .mockImplementation(request => prepared.get(request))
  f.due.mockReturnValue(false)
  f.stop.mockImplementation(async () => {})
  f.retire.mockImplementation((value) => {
    for (const [request, original] of prepared) if (original === value) prepared.delete(request)
  })
  return { ...f, prepared, observe }
}

it('reuses the fixed two compute slots across four idle Sessions only after original stop and retirement', async () => {
  const f = await idleComputeFixture()
  for (let i = 0; i < 4; i++) expect((await f.runSession(i)).isError).toBe(false)
  expect(f.prepare).toHaveBeenCalledTimes(4); expect(f.stop).toHaveBeenCalledTimes(2)
  expect(f.retire).toHaveBeenCalledTimes(2); expect(f.prepared.size).toBe(2)
  expect(f.stop.mock.calls.map(([request]) => request.sessionId)).toEqual([f.a.agents[0]!.session.id, f.a.agents[1]!.session.id])
  expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(f.retire.mock.invocationCallOrder[0]!)
  expect(f.retire.mock.invocationCallOrder[0]).toBeLessThan(f.prepare.mock.invocationCallOrder[2]!)
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
})

it.each([0, 3])('shares a pending idle retirement with Session index %i without closing unrelated work', async (waitingSession) => {
  const f = await idleComputeFixture(), stopped = Promise.withResolvers<undefined>()
  for (let i = 0; i < 2; i++) expect((await f.runSession(i)).isError).toBe(false)
  f.stop.mockImplementationOnce(() => stopped.promise)
  const third = f.runSession(2)
  await vi.waitFor(() => { expect(f.stop).toHaveBeenCalledTimes(1) })
  const waiting = f.runSession(waitingSession)
  expect((await f.runSession(1)).isError).toBe(false)
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.retire).not.toHaveBeenCalled()
  expect(f.prepare).toHaveBeenCalledTimes(3)
  stopped.resolve(undefined)
  expect((await third).isError).toBe(false); expect((await waiting).isError).toBe(false)
  expect(f.retire).toHaveBeenCalledTimes(2); expect(f.stop).toHaveBeenCalledTimes(2)
  expect(f.prepared.size).toBe(2)
  if (waitingSession === 0) {
    const rebuilt = f.prepare.mock.calls.findLast(([request]) => request.sessionId === f.a.agents[0]!.session.id)?.[0]
    expect(rebuilt).toBeDefined(); expect(rebuilt).not.toBe(f.prepare.mock.calls[0]?.[0])
  }
})

it.each(['stop', 'retire'] as const)('retains an unconfirmed %s and never retries retirement or creates a third compute', async (phase) => {
  const f = await idleComputeFixture()
  for (let i = 0; i < 2; i++) expect((await f.runSession(i)).isError).toBe(false)
  if (phase === 'stop') f.stop.mockRejectedValueOnce(new Error('scripted original stop remains unknown'))
  else f.retire.mockImplementationOnce(() => { throw new Error('scripted original SDK retirement refused') })
  expect((await f.runSession(2)).isError).toBe(true)
  expect((await f.runSession(3)).isError).toBe(true)
  expect((await f.runSession(0)).isError).toBe(true)
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.retire).toHaveBeenCalledTimes(phase === 'stop' ? 0 : 1)
  expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.prepared.size).toBe(2)
})

it('finishes the original retirement after caller cancellation without reserving or poisoning a replacement Session', async () => {
  const f = await idleComputeFixture(), stopped = Promise.withResolvers<undefined>(), cancel = new AbortController()
  for (let i = 0; i < 2; i++) expect((await f.runSession(i)).isError).toBe(false)
  f.stop.mockImplementationOnce(() => stopped.promise)
  const third = f.runSession(2, cancel.signal)
  await vi.waitFor(() => { expect(f.stop).toHaveBeenCalledTimes(1) })
  cancel.abort(new Error('original new Session cancellation')); stopped.resolve(undefined)
  expect((await third).isError).toBe(true)
  expect(f.retire).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledTimes(2)
  expect((await f.runSession(3)).isError).toBe(false)
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledTimes(3)
})

it('refuses to evict either ready compute while its original service remains active', async () => {
  const f = await idleComputeFixture()
  await f.a.start(0); await f.a.start(1)
  expect((await f.runSession(2)).isError).toBe(true)
  expect(f.observe).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled()
  expect(f.prepare).toHaveBeenCalledTimes(2)
})

it.each(['not-published', 'unknown', 'untyped-cause', 'outside-mount', 'getter-code'] as const)(
  'reports environment exhaustion only for the confirmed pre-allocation files refusal: %s', async (kind) => {
    const f = await applicationFixture(), a = await f.account('environment-capacity', 4)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const project: AccountFilesProject = { binding: a.binding,
      workspace: a.authority.projectForSession(a.agents[0]!.session),
      projectDirectory: { binding: a.binding, prepare: async () => {} } }
    const capacity = kind === 'untyped-cause' ? new Error('/private/environment-key must not reach the model')
      : new FilesFailure('cloud/capacity', '/private/environment-key must not reach the model')
    const refused = new FdMutationFailure(kind === 'unknown' ? 'unknown' : 'not-published', 'FS_TOO_LARGE', undefined,
      { cause: capacity })
    const mounts = vi.fn<CloudAccountFiles['prepareExecutionMounts']>(async () => { throw refused })
    const scripted = { projectFor: async () => project, prepareExecutionMounts: mounts }
    const files = new Proxy(CloudAccountFiles.prototype, { get(_target, key): unknown {
      const value: unknown = Reflect.get(scripted, key)
      if (value === undefined) throw new Error('Unexpected files operation before environment capacity refusal')
      return value
    } })
    a.authority.files.mockReturnValue(files)
    // Only the allocation preparation frontier is scripted; its original mount callback must execute.
    let getterReads = 0
    if (kind === 'getter-code') {
      const cause = new Error('/private/SDK-key must not reach the observation')
      Object.defineProperty(cause, 'code', { get() { getterReads++; throw new Error('private getter') } })
      f.prepare.mockRejectedValueOnce(cause)
    } else if (kind === 'outside-mount') f.prepare.mockRejectedValueOnce(refused)
    else f.prepare.mockImplementation(async (request) => {
      await request.prepareMount()
      throw new Error('A refused environment must not prepare a runtime')
    })
    const queriesBefore = f.query.mock.calls.length, command = vi.spyOn(f.deployment.runtimes, 'command')
    const stop = vi.spyOn(SessionAllocationOwner.prototype, 'stop')
    const dispose = a.ctx.tools.register(defineTool({ name: 'bash', description: 'Native Shell capacity component consumer.', parameters: {},
      output: { schema: { type: 'json' }, render: () => [] }, execute: async () => {
        const shell = await a.ctx.shell.execute(a.ctx.shell.resolve({ command: 'printf hello', onExpiry: 'none' }))
        await shell.done
        return { completed: true }
      } }))
    applicationCleanups.push(dispose)
    // Four known no-create refusals must not turn the two concurrent compute slots into a historical Session limit.
    const attempts = kind === 'not-published' ? 4 : 1
    for (let i = 0; i < attempts; i++) {
      const result = await a.ctx.tools.execute({ callId: ToolCallId(`environment-capacity-${i}`), name: 'bash', arguments: {},
        agent: a.agents[i]!, signal: new AbortController().signal })
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('The refused environment unexpectedly executed')
      expect(result.error.message).toBe(kind === 'not-published'
        ? 'No free session environment is available. Continue in a session that already has an environment, or ask an administrator to release or provision one.'
        : 'Cloud execution is not confirmed available; Root retains cleanup responsibility.')
      expect(JSON.stringify(result.error)).not.toContain('/private/environment-key')
    }
    expect(mounts).toHaveBeenCalledTimes(kind === 'outside-mount' || kind === 'getter-code' ? 0 : attempts)
    expect(stop).toHaveBeenCalledTimes(kind === 'not-published' ? attempts : 0)
    expect(f.prepare).toHaveBeenCalledTimes(attempts); expect(f.query).toHaveBeenCalledTimes(queriesBefore)
    expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled()
    expect(getterReads).toBe(0)
    if (kind === 'not-published') expect(warn).not.toHaveBeenCalled()
    else {
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith('Cloud managed execution preparation failed: %j', {
        event: 'managed-execution-preparation-failed', pid: process.pid,
        stage: kind === 'outside-mount' || kind === 'getter-code' ? 'allocation-prepare' : 'environment-mounts',
        coordinatorOpen: true, coordinatorReady: true,
        ...kind === 'getter-code' ? {} : { code: 'FS_TOO_LARGE' },
        ...kind === 'unknown' || kind === 'outside-mount' ? { causeCode: 'cloud/capacity' } : {},
      })
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|SDK-key|getter/)
    }
  })

it('continues the fifth and ninth never-submitted native operation on new compute without replacing account or Session', async () => {
  const f = await continuationFixture()
  for (let i = 0; i < 9; i++) expect((await f.run()).isError).toBe(false)
  expect([...f.counts]).toEqual([['compute-0', 4], ['compute-1', 4], ['compute-2', 1]])
  expect(f.stop).toHaveBeenCalledTimes(2); expect(f.command).toHaveBeenCalledTimes(9)
  expect(f.retire).toHaveBeenCalledTimes(2)
  expect(f.stop.mock.invocationCallOrder[0]).toBeLessThan(f.retire.mock.invocationCallOrder[0]!)
  expect(f.prepare).toHaveBeenCalledTimes(11)
  expect(new Set(f.prepare.mock.calls.map(([request]) => request.sessionId)).size).toBe(1)
  expect(f.a.lifetime.signal.aborted).toBe(false)
})

it('retains the old compute when original physical/terminal stop refuses and never opens a replacement channel', async () => {
  const f = await continuationFixture()
  for (let i = 0; i < 4; i++) expect((await f.run()).isError).toBe(false)
  f.stop.mockRejectedValueOnce(new Error('scripted stop or terminal SQL unknown'))
  expect((await f.run()).isError).toBe(true)
  expect(f.command).toHaveBeenCalledTimes(4); expect(f.prepare).toHaveBeenCalledTimes(5)
  expect(f.retire).not.toHaveBeenCalled()
})

it('does not retire compute while the independent original service is active', async () => {
  const f = await continuationFixture()
  await f.a.start()
  f.due.mockReturnValue(true)
  expect((await f.run()).isError).toBe(true)
  expect(f.stop).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled()
})

it('does not prepare new compute or submit the new operation after its original cancellation during stop', async () => {
  const f = await continuationFixture(), stopped = Promise.withResolvers<undefined>(), cancel = new AbortController()
  f.due.mockReturnValue(true); f.stop.mockImplementationOnce(() => stopped.promise)
  const actual = f.run(cancel.signal)
  await vi.waitFor(() => { expect(f.stop).toHaveBeenCalledTimes(1) })
  cancel.abort(new Error('original caller cancellation')); stopped.resolve(undefined)
  expect((await actual).isError).toBe(true)
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.command).not.toHaveBeenCalled()
})


it('[managed-skills] sends the complete mixed copy set on each native Shell operation and retains it past direct exit until actual range settlement', async () => {
  const f = await applicationFixture({ skillCopies: 2 }), a = await f.account('mixed-copies')
  const metadata = { relativePath: '.pe', device: '7', inode: '11', mountId: '8', uid: 2000, gid: 2000, mode: 0o40700 }
  const parent: SkillProjectGrant = { binding: a.binding, workspaceId: brandString<SkillProjectGrant['workspaceId']>('mixed-project'),
    project: { rootPath: '/project', rootDevice: '7', rootInode: '9', rootMountId: '8',
      quota: { device: '7', mountId: '8', maximumBytes: '65536', maximumInodes: '128' } },
    metadataDirectory: metadata, skillsDirectory: { ...metadata, inode: '12' } }
  const base = { binding: a.binding, workspaceId: parent.workspaceId,
    metadataDirectory: parent.metadataDirectory, skillsDirectory: parent.skillsDirectory }
  const legacy: SkillOperationCopies['copies'][number] = { ...base,
    version: { binding: a.binding, id: brandString<SkillOperationCopies['copies'][number]['version']['id']>('00000000-0000-4000-8000-000000000001'),
      skillSha256: '1'.repeat(64), resourceSha256: '2'.repeat(64), skillBytes: 12, resourceBytes: 4 },
    resourceBase: '.pe/skills/00000000-0000-4000-8000-000000000001/', copyDirectory: { ...metadata, inode: '13' } }
  const bundle: SkillOperationCopies['copies'][number] = { ...base,
    version: { binding: a.binding, id: brandString<SkillOperationCopies['copies'][number]['version']['id']>('00000000-0000-4000-8000-000000000002'),
      format: 'bundle-tree-v1', files: [{ relativePath: 'SKILL.md', bytes: 12, sha256: '1'.repeat(64) },
        { relativePath: 'nested/resource.bin', bytes: 4, sha256: '2'.repeat(64) }], directories: ['nested'], treeSha256: '3'.repeat(64),
      contentBytes: 16, directoryCount: 1, chargedBytes: 128, chargedInodes: 5 },
    resourceBase: '.pe/skills/00000000-0000-4000-8000-000000000002/', copyDirectory: { ...metadata, inode: '14' } }
  const copies: SkillOperationCopies = Object.freeze({ project: parent, copies: [legacy, bundle] })
  const release = vi.fn(), borrow = vi.fn(async () => ({ value: copies, release }))
  // Only the external Linux files preparation is scripted; the native tool/Agent/coordinator/command owner remain real.
  const scripted = { assertSkillProjectGrant: (grant: SkillProjectGrant) => { expect(grant).toBe(parent) },
    borrowAllBundleWorkingCopies: borrow,
    assertBundleOperationCopies: (value: SkillOperationCopies) => { expect(value).toBe(copies) },
    borrowAllSkillWorkingCopies: () => { throw new Error('Legacy-only enumeration must not run for a mixed project') },
  }
  const files = new Proxy(CloudAccountFiles.prototype, { get(_target, key): unknown {
    const value: unknown = Reflect.get(scripted, key)
    if (value === undefined) throw new Error('Unexpected files call in the scripted native I/O frontier')
    return value
  } })
  a.authority.files.mockReturnValue(files)
  vi.spyOn(f.deployment.runtimes, 'skillProject').mockReturnValue({ grant: parent, maxCopies: 2 })
  vi.spyOn(f.deployment.runtimes, 'needsContinuation').mockReturnValue(false)
  const poll = Promise.withResolvers<CommandSnapshot>(), submitted = Promise.withResolvers<undefined>()
  const empty = { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }
  const prepared: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
    physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: empty, stderr: empty }
  const direct = { ...prepared, submitted: true, direct: { exitCode: 0, signal: null },
    stdout: { ...empty, eof: true }, stderr: { ...empty, eof: true } }
  const complete: CommandSnapshot = { ...direct, rangeEmpty: true, ioClosed: true }
  applicationCleanups.push(() => { poll.resolve(complete) })
  const command = vi.spyOn(f.deployment.runtimes, 'command').mockImplementation((_sandbox, operation) => {
    if (operation === undefined) throw new Error('Missing actual complete copies borrow')
    operation.assertCurrent()
    expect(copyFacts(operation.value, operation.maxCopies).copies.map(copy => copy.version)).toEqual([legacy.version.id, bundle.version.id])
    return { release: () => { operation.release() }, prepare: async () => prepared,
      commit: async () => { submitted.resolve(undefined); return direct },
      poll: async () => poll.promise, stop: async () => complete }
  })
  const dispose = a.ctx.tools.register(defineTool({ name: 'bash', description: 'Native Shell component consumer.', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] }, execute: async () => {
      const handle = await a.ctx.shell.execute(a.ctx.shell.resolve({ command: 'printf complete-tree', onExpiry: 'none' }))
      await handle.done
      return { completed: true }
    } }))
  applicationCleanups.push(dispose)
  const run = () => a.ctx.tools.execute({ callId: ToolCallId('managed-copy-command'), name: 'bash', arguments: {},
    agent: a.agents[0]!, signal: new AbortController().signal })
  const running = run()
  const outcome: { result?: Awaited<ReturnType<typeof run>> } = {}
  void running.then((result) => { outcome.result = result })
  await vi.waitFor(() => {
    if (outcome.result?.isError) throw new Error(outcome.result.error.message)
    expect(command).toHaveBeenCalledTimes(1)
  })
  await submitted.promise
  expect(command).toHaveBeenCalledTimes(1); expect(borrow).toHaveBeenCalledTimes(1)
  expect(release).not.toHaveBeenCalled()
  poll.resolve(complete)
  expect((await running).isError).toBe(false)
  await vi.waitFor(() => { expect(release).toHaveBeenCalledTimes(1) })
  expect((await run()).isError).toBe(false)
  await vi.waitFor(() => { expect(release).toHaveBeenCalledTimes(2) })
  expect(borrow).toHaveBeenCalledTimes(2)
  expect(new Set(f.prepare.mock.calls.map(([request]) => request.sessionId)).size).toBe(1)
  expect(f.prepare.mock.calls.every(([request]) => request.binding === a.binding)).toBe(true)
  expect(a.binding.lifetime.aborted).toBe(false)
})


it('observes a cached Session after service settlement while application I/O still blocks quiet', async () => {
  const f = await applicationFixture(), a = await f.account('idle-observer')
  expect(f.owner.isEpochIdle(a.binding)).toBe(true)
  expect(f.owner.isEpochIdle({ ...a.binding })).toBe(false)
  const work = await a.start()
  expect(f.owner.isEpochIdle(a.binding)).toBe(false)
  const pending = trackApplication(a.borrow(work))
  await vi.waitFor(() => { expect(f.attempts).toHaveLength(1) })
  // The scripted process range can empty; the actual original HTTP request row must still join.
  f.emptyChannels()
  expect(f.owner.isEpochIdle(a.binding)).toBe(false)
  expect(f.attempts[0]!.controller.signal.aborted).toBe(false)
  f.attempts[0]!.terminal.resolve(undefined); await pending.joined
  await vi.waitFor(() => { expect(f.owner.isEpochIdle(a.binding)).toBe(true) }, { timeout: 3000 })
  expect(f.create).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  // This fixture scripts allocation transport; it establishes the original command/request observation only.
  expect(work.lease.scope.binding).toBe(a.binding)
})
