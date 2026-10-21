/** Real Cordis/Root entry with assembly/coordinator seams: component evidence only, not actual CLI, PG, FD4 or SDK. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { ManagedCoordinatorConfig } from '../src/managed-coordinator.ts'
import * as root from '../src/root.ts'

const seam = vi.hoisted(() => ({ assemble: vi.fn(), construct: vi.fn(),
  start: vi.fn<() => Promise<void>>(), closeRoot: vi.fn<() => Promise<void>>(), events: [] as string[] }))
vi.mock('../src/bootstrap/assembly.ts', () => ({
  assembleRootExecutionDeployment: (...args: unknown[]): unknown => seam.assemble(...args),
}))
vi.mock('../src/managed-coordinator.ts', () => ({ ManagedCoordinator: class {
  constructor(...args: unknown[]) { seam.events.push('coordinator-construct'); seam.construct(...args) }
  start(): Promise<void> { return seam.start() }
  closeRoot(): Promise<void> { return seam.closeRoot() }
} }))

const managed: ManagedCoordinatorConfig = {
  maxBoundAccounts: 2, maxActiveCommands: 4, maxActiveCommandsPerAccount: 2,
  maxResidentCommands: 8, maxResidentCommandsPerAccount: 4, maxResidentBytes: 524288, maxResidentBytesPerAccount: 262144,
  maxStopObservers: 4, stopWaitBudgetMs: 10000, recoveryPageSize: 2,
  allocations: { environmentVersion: 'component-env', provider: 'component-provider', createBudgetMs: 30000,
    maxAllocations: 4, maxAllocationsPerAccount: 2, maxWaiters: 8, maxWaitersPerAllocation: 4 },
  store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 32768,
    maxRows: 8, maxCapabilities: 5, maxPendingQueries: 4, maxMutationResponsibilities: 8, maxRetainedBytes: 1048576 },
  commands: { allowedTools: ['bash'], maxScopes: 4, commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16,
    maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 4096, maxObservedBytes: 65536,
    pollIntervalMs: 1000, maxWaiters: 4, maxLifetimeMs: 12000, stopWaitMs: 2000 } },
  shell: { bashPath: '/bin/bash', timeoutMs: 3000, maxTimeoutMs: 5000, maxOutputBytes: 4096, graceMs: 1000 },
}
const reference = { path: '/component-only/not-read/root-deployment.json', sha256: 'a'.repeat(64) }
const selection = () => ({ mode: 'session-collect', requiredCapabilities: ['argv-collect'],
  managed, rootDeployment: reference } satisfies root.Config)

beforeEach(() => {
  vi.clearAllMocks()
  seam.events.length = 0
  seam.start.mockImplementation(async () => { seam.events.push('coordinator-start') })
  seam.closeRoot.mockImplementation(async () => { seam.events.push('coordinator-close') })
})

function fixture(withRuntime = true) {
  const ctx = new Context(), releases: (() => void)[] = [], pending: Promise<unknown>[] = []
  if (withRuntime) new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const assembly = {
    // These identities exist only behind the module seam; no SDK/export object or resource is created.
    deployment: { backend: {}, runtimes: {}, assertCurrent: vi.fn(() => { seam.events.push('deployment-current') }),
      share: vi.fn(), assertEpochReleased: vi.fn() },
    closeActual: vi.fn(async () => { seam.events.push('assembly-close') }),
  }
  seam.assemble.mockImplementation(async () => { seam.events.push('assembly-create'); return assembly })
  onTestFinished(async () => {
    for (const release of releases) release()
    await Promise.allSettled([ctx.fiber.dispose(), ...pending])
    vi.restoreAllMocks()
  })
  return { ctx, assembly, releases, pending }
}

it.each(['closed', 'account', 'two-authorities', 'no-runtime'] as const)(
  'refuses %s before entering the private assembly seam', async (kind) => {
    const f = fixture(kind !== 'no-runtime')
    const config: root.Config = kind === 'closed'
      ? { mode: 'closed', requiredCapabilities: [], maxBoundAccounts: 2, rootDeployment: reference } : selection()
    if (kind === 'account') installAccountBinding(f.ctx, {
      accountId: brandString<AccountBinding['accountId']>('component-account'),
      epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'component-recipe', lifetime: new AbortController().signal,
    })
    // Issue only a typed module-seam identity for the internal third-argument case; then begin the Root observation.
    const internal = kind === 'two-authorities'
      ? await (await import('../src/bootstrap/assembly.ts')).assembleRootExecutionDeployment(reference, managed) : undefined
    seam.assemble.mockClear(); seam.events.length = 0
    await expect(root.apply(f.ctx, config, internal?.deployment)).rejects.toMatchObject({ code: 'cloud/invalid-config' })
    expect(seam.assemble).not.toHaveBeenCalled()
    expect(seam.construct).not.toHaveBeenCalled()
    expect(f.assembly.closeActual).not.toHaveBeenCalled()
  },
)

it('keeps the schema-compatible internal deployment path without a rootDeployment reference', async () => {
  const f = fixture()
  const config = root.Config({ mode: 'session-collect', requiredCapabilities: ['argv-collect'], managed })
  expect(config.rootDeployment).toBeUndefined()
  const internal = await (await import('../src/bootstrap/assembly.ts')).assembleRootExecutionDeployment(reference, managed)
  seam.assemble.mockClear(); seam.events.length = 0
  await root.apply(f.ctx, config, internal.deployment)
  expect(seam.assemble).not.toHaveBeenCalled()
  expect(seam.construct.mock.calls[0]?.[3]).toBe(internal.deployment)
  expect(seam.start).toHaveBeenCalledOnce()
  expect(f.assembly.deployment.assertCurrent).toHaveBeenCalledOnce()
  await f.ctx.fiber.dispose()
  expect(f.assembly.closeActual).not.toHaveBeenCalled()
})

it('mounts through the ordinary two-argument Cordis plugin and closes the coordinator before the original assembly', async () => {
  const f = fixture(), coordinatorClosing = Promise.withResolvers<undefined>(), coordinatorClosed = Promise.withResolvers<undefined>()
  f.releases.push(() => { coordinatorClosed.resolve(undefined) })
  seam.closeRoot.mockImplementation(async () => {
    seam.events.push('coordinator-close'); coordinatorClosing.resolve(undefined); await coordinatorClosed.promise
  })
  await f.ctx.plugin(root, selection())
  expect(seam.assemble).toHaveBeenCalledOnce()
  expect(seam.assemble).toHaveBeenCalledWith(reference, managed)
  expect(seam.construct.mock.calls[0]?.[3]).toBe(f.assembly.deployment)
  expect(seam.events).toEqual(['assembly-create', 'deployment-current', 'coordinator-construct', 'coordinator-start'])
  const disposing = f.ctx.fiber.dispose()
  f.pending.push(disposing)
  await coordinatorClosing.promise
  expect(f.assembly.closeActual).not.toHaveBeenCalled()
  coordinatorClosed.resolve(undefined)
  await disposing
  expect(seam.events.slice(-2)).toEqual(['coordinator-close', 'assembly-close'])
  expect(f.assembly.closeActual).toHaveBeenCalledOnce()
})

it('joins a pending factory and releases its late original assembly before context disposal completes', async () => {
  const f = fixture(), entered = Promise.withResolvers<undefined>(), factory = Promise.withResolvers<typeof f.assembly>()
  const closing = Promise.withResolvers<undefined>(), closed = Promise.withResolvers<undefined>()
  const logged = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
  f.releases.push(() => { factory.resolve(f.assembly); closed.resolve(undefined) })
  seam.assemble.mockImplementation(() => { entered.resolve(undefined); return factory.promise })
  f.assembly.closeActual.mockImplementation(async () => { closing.resolve(undefined); await closed.promise })
  const plugin = f.ctx.plugin(root, selection())
  const mounting = Promise.resolve(plugin).then(
    () => ({ status: 'mounted' as const }), (cause: unknown) => ({ status: 'rejected' as const, cause }),
  )
  f.pending.push(mounting)
  await entered.promise
  expect(plugin.ctx.fiber.uid).not.toBeNull()
  let disposed = false
  const disposing = f.ctx.fiber.dispose().then(() => { disposed = true })
  f.pending.push(disposing)
  await Promise.resolve()
  expect(plugin.ctx.fiber.uid).toBeNull()
  expect(disposed).toBe(false)
  expect(f.assembly.closeActual).not.toHaveBeenCalled()
  const replacement = { ...f.assembly, closeActual: vi.fn(async () => {}) }
  seam.assemble.mockResolvedValue(replacement)
  factory.resolve(f.assembly)
  await closing.promise
  expect(disposed).toBe(false)
  // Root checks the original terminal uid after await; its cleanup effect still owns the late assembly.
  expect(seam.construct.mock.calls.length).toBe(0)
  expect(seam.start).not.toHaveBeenCalled()
  expect(seam.closeRoot).not.toHaveBeenCalled()
  expect(f.assembly.deployment.assertCurrent).not.toHaveBeenCalled()
  expect(replacement.closeActual).not.toHaveBeenCalled()
  closed.resolve(undefined)
  await disposing
  expect(disposed).toBe(true)
  expect(f.assembly.closeActual).toHaveBeenCalledOnce()
  await mounting
  expect(logged).toHaveBeenCalledWith(expect.objectContaining({ code: 'cloud/execution-unavailable' }))
})

it('still closes the assembly after coordinator cleanup fails and lets Cordis report the original error', async () => {
  const f = fixture(), failure = new Error('Component coordinator cleanup remains unknown')
  const logged = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
  seam.closeRoot.mockImplementation(async () => { seam.events.push('coordinator-close'); throw failure })
  await f.ctx.plugin(root, selection())
  // Real Cordis contains disposer failures in its diagnostic path; disposal itself resolves.
  await expect(f.ctx.fiber.dispose()).resolves.toBeUndefined()
  expect(seam.events.slice(-2)).toEqual(['coordinator-close', 'assembly-close'])
  expect(f.assembly.closeActual).toHaveBeenCalledOnce()
  expect(logged).toHaveBeenCalledWith(failure)
})
