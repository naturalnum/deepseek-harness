/** Real Cordis lifecycle with only protected-publication and metadata seams; no PG, SDK or product receipt. */
import { Context } from '@deepseek-ai/cordis'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import type { AccountRecoveryRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BootstrapFailure } from '../src/bootstrap/bootstrap.ts'
import { ExecutionStateError } from '../src/errors.ts'
import type { ManagedCoordinatorConfig } from '../src/managed-coordinator.ts'
import { mountRootRecovery } from '../src/root-recovery.ts'

const seam = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/bootstrap/recovery-reference.ts', async original => ({
  ...await original<typeof import('../src/bootstrap/recovery-reference.ts')>(), openRootRecoveryReference: seam.open,
}))
const config: ManagedCoordinatorConfig = {
  maxBoundAccounts: 2, maxActiveCommands: 4, maxActiveCommandsPerAccount: 2,
  maxResidentCommands: 8, maxResidentCommandsPerAccount: 4, maxResidentBytes: 524288, maxResidentBytesPerAccount: 262144,
  maxStopObservers: 4, stopWaitBudgetMs: 10000, recoveryPageSize: 2,
  allocations: { environmentVersion: 'fixture', provider: 'fixture', createBudgetMs: 30000,
    maxAllocations: 4, maxAllocationsPerAccount: 2, maxWaiters: 8, maxWaitersPerAllocation: 4 },
  store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 32768,
    maxRows: 8, maxCapabilities: 5, maxPendingQueries: 4, maxMutationResponsibilities: 8, maxRetainedBytes: 1048576 },
  commands: { allowedTools: ['bash'], maxScopes: 4, commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16,
    maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 4096, maxObservedBytes: 65536,
    pollIntervalMs: 1000, maxWaiters: 4, maxLifetimeMs: 12000, stopWaitMs: 2000 } },
  shell: { bashPath: '/bin/bash', timeoutMs: 3000, maxTimeoutMs: 5000, maxOutputBytes: 4096, graceMs: 1000 },
}
const reference = { publication: { path: '/fixture/not-read.json', sha256: 'a'.repeat(64) }, maxBytes: 32768, maxAgeMs: 30000 }

function fixture(ready: Promise<undefined> = Promise.resolve(undefined)) {
  const root = new Context(), ctx = root.plugin({ apply() {} }).ctx
  const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const query = vi.fn(() => Promise.reject(new Error('No fixture SQL may be submitted')))
  const unused = vi.fn(() => { throw new Error('No owner recovery may be submitted') })
  const recovery: AccountRecoveryRuntime = { whenReady: () => ready, registerVerifier: vi.fn(() => () => {}),
    migrate: unused, locateInstance: unused, recoverAccount: unused, inspectAccount: unused,
    closeInstance: unused, inspectInstance: unused }
  vi.spyOn(runtime, 'recovery', 'get').mockReturnValue(recovery)
  const register = vi.spyOn(runtime, 'registerDrainParticipant')
  vi.spyOn(runtime, 'controlDatabase').mockReturnValue({ query, wasNotSubmitted: () => false })
  vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(async () => { await root.fiber.dispose(); vi.restoreAllMocks() })
  return { ctx, runtime, query, recovery, register, unused }
}

it.each(['wire-unknown', 'command-unknown'] as const)('retains actual %s publication cleanup through participant withdrawal', async (code) => {
  const f = fixture(), held = { originalLease: true }, failure = new BootstrapFailure(code, held)
  seam.open.mockImplementation(() => { throw failure })
  await expect(mountRootRecovery(f.ctx, f.runtime, config, reference)).rejects.toBe(failure)
  const participant = f.register.mock.calls[0]?.[0]
  expect(participant).toBeDefined()
  await expect(participant?.closeRoot?.()).rejects.toBe(failure)
  expect(f.query).not.toHaveBeenCalled()
  expect(f.unused).not.toHaveBeenCalled()
})

it('settles a known publication refusal without inventing SQL or unresolved work', async () => {
  const f = fixture(), failure = new ExecutionStateError('cloud/invalid-config', 'Fixture protection refused')
  seam.open.mockImplementation(() => { throw failure })
  await expect(mountRootRecovery(f.ctx, f.runtime, config, reference)).rejects.toBe(failure)
  await expect(f.register.mock.calls[0]?.[0].closeRoot?.()).resolves.toBeUndefined()
  expect(f.query).not.toHaveBeenCalled()
})

it('does not start late recovery after Cordis disposal while original runtime startup is pending', async () => {
  const ready = Promise.withResolvers<undefined>(), f = fixture(ready.promise)
  seam.open.mockReset()
  const actual = mountRootRecovery(f.ctx, f.runtime, config, reference)
  await f.ctx.fiber.dispose()
  ready.resolve(undefined)
  await expect(actual).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  expect(f.register).not.toHaveBeenCalled()
  expect(seam.open).not.toHaveBeenCalled()
  expect(f.query).not.toHaveBeenCalled()
})
