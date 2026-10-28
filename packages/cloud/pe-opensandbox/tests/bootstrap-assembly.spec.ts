import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BootstrapConfig } from '../src/bootstrap/bootstrap.ts'
import { rootDeploymentFixture as input, sharedPathDeploymentFixture, managedDeploymentFixture } from './fixtures/root-deployment.ts'
import { BootstrapFailure } from '../src/bootstrap/bootstrap.ts'

const state = vi.hoisted(() => ({
  input: {} as Record<string, unknown>, events: [] as string[], retained: 0,
  ready: Promise.withResolvers<undefined>(), adopted: Promise.withResolvers<undefined>(), sdkClose: Promise.withResolvers<undefined>(),
  guard: (): void => {}, sdkCreated: vi.fn(), epoch: vi.fn(), sandboxCreate: vi.fn(), keeperClosed: vi.fn(),
  sharedCreated: vi.fn(), planCurrent: true, sharedAvailable: true,
  keeperAdopted: vi.fn(),
}))
vi.mock('../src/bootstrap/deployment-reference.ts', () => {
  class Lease {
    constructor(private readonly reference: { path: string }) {}
    assertCurrent(): void {
      const plan = this.reference.path.endsWith('storage-plan.json')
      state.events.push(this.reference.path.endsWith('config.json') ? 'selection-current' : plan ? 'plan-current' : 'manifest-current')
      if (plan && !state.planCurrent) throw new Error('Synthetic plan revoked.')
    }
    value(): unknown { return this.reference.path.endsWith('config.json') ? state.input : {
      schema: 'root-daemon-exports-v1', runId: '1'.repeat(32),
      liveness: { kind: 'inherited-fifo-v1', frameBytes: 128, nonce: '2'.repeat(64), device: '3', inode: '4' } } }
    bytes(): Buffer { return Buffer.from('{}') }
    close(): void { state.events.push(this.reference.path.endsWith('config.json') ? 'selection-close'
      : this.reference.path.endsWith('storage-plan.json') ? 'plan-close' : 'manifest-close') }
  }
  return { RootDeploymentLease: Lease, readRootDeploymentReference: (reference: { path: string }) => new Lease(reference) }
})
vi.mock('../src/bootstrap/keeper-live.ts', () => ({ adoptExportKeeperLive: () => {
  state.keeperAdopted()
  state.adopted.resolve(undefined)
  return { ready: state.ready.promise, signal: new AbortController().signal,
    assertAvailable(): void { state.events.push('keeper-current') },
    closeObserver(): Promise<void> { state.events.push('keeper-close'); state.keeperClosed(); return Promise.resolve(undefined) } }
} }))
vi.mock('../src/export-share.ts', () => ({ createRetainedExecutionExports: () => ({
  share: vi.fn(), assertEpochReleased: state.epoch,
  get retainedShares() { return state.retained }, assertCurrent(): void { state.events.push('exports-current') },
}), createSharedPathExecutionExports: (...args: [Uint8Array, string, () => void, object]) => {
  state.sharedCreated(...args)
  args[2]()
  if (!state.sharedAvailable) throw new Error('Synthetic shared storage unavailable.')
  return { share: vi.fn(), assertEpochReleased: state.epoch,
    get retainedShares() { return state.retained }, assertCurrent(): void { args[2](); state.events.push('shared-current') } }
} }))
vi.mock('../src/bootstrap/factory.ts', () => ({ createRootSdkExecutionOwner: (config: BootstrapConfig) => {
  state.sdkCreated(); state.guard = () => { config.assertDeploymentCurrent() }
  return Promise.resolve({ backend: { create: state.sandboxCreate,
    closeRootActual(): Promise<void> { state.events.push('sdk-close'); config.assertDeploymentCurrent(); return state.sdkClose.promise } },
  runtimes: {}, assertCurrent: () => { config.assertDeploymentCurrent() } })
} }))
import { assembleRootExecutionDeployment } from '../src/bootstrap/assembly.ts'
import { parseRootDeploymentInput } from '../src/bootstrap/deployment-input.ts'

const limits = managedDeploymentFixture()

beforeEach(() => {
  state.input = input(); state.events.length = 0; state.retained = 0
  state.ready = Promise.withResolvers<undefined>(); state.adopted = Promise.withResolvers<undefined>()
  state.sdkClose = Promise.withResolvers<undefined>()
  state.sdkCreated.mockClear(); state.epoch.mockClear(); state.sandboxCreate.mockClear(); state.keeperClosed.mockClear()
  state.sharedCreated.mockClear(); state.planCurrent = true; state.sharedAvailable = true
  state.keeperAdopted.mockClear()
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
  expect(Object.hasOwn(assembly.deployment, 'skillCopies')).toBe(false)
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

it.each([
  'sha256:4900c9b13a02e0cdbec19733b9cc140d7af6d3fa06a06c752d19a3d2e5ee7ca7',
  'sha256:e2bd5a5691bb6b29dbae54ce4b74fe7357a7e0ccd163cb3d3d7484677db68087',
])('refuses predecessor server %s before keeper adoption or SDK construction', async (serverImageDigest) => {
  const value = input()
  value.selection.serverImageDigest = serverImageDigest
  expect(() => parseRootDeploymentInput(value)).toThrow()
  state.input = value
  await expect(assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: '4'.repeat(64) }, limits)).rejects.toThrow()
  expect(state.events).not.toContain('manifest-current')
  expect(state.sdkCreated).not.toHaveBeenCalled()
  expect(state.sandboxCreate).not.toHaveBeenCalled()
})


it('keeps absent copy policy absent and freezes an independent closed explicit count', () => {
  const omitted = parseRootDeploymentInput(input())
  expect(Object.hasOwn(omitted, 'skillCopies')).toBe(false)
  const policy = { maxCopiesPerOperation: 4 }
  const parsed = parseRootDeploymentInput({ ...input(), skillCopies: policy })
  expect(parsed.skillCopies).toEqual(policy)
  expect(parsed.skillCopies).not.toBe(policy)
  expect(Object.isFrozen(parsed.skillCopies)).toBe(true)
  policy.maxCopiesPerOperation = 5
  expect(parsed.skillCopies?.maxCopiesPerOperation).toBe(4)
})

it('rejects malformed or extra copy fields before entering SDK construction', async () => {
  for (const skillCopies of [undefined, null, {}, { maxCopiesPerOperation: 0 }, { maxCopiesPerOperation: -1 },
    { maxCopiesPerOperation: 1.5 }, { maxCopiesPerOperation: '4' }, { maxCopiesPerOperation: 2147483648 },
    { maxCopiesPerOperation: 4, path: '/caller-chosen' }]) {
    state.input = { ...input(), skillCopies }
    expect(() => parseRootDeploymentInput(state.input)).toThrow()
    await expect(assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: '4'.repeat(64) }, limits)).rejects.toThrow()
  }
  expect(state.sdkCreated).not.toHaveBeenCalled()
  expect(state.sandboxCreate).not.toHaveBeenCalled()
})

it('passes the protected explicit policy to the original deployment without creating a sandbox', async () => {
  const policy = { maxCopiesPerOperation: 4 }
  state.input = { ...input(), skillCopies: policy }
  state.ready.resolve(undefined); state.sdkClose.resolve(undefined)
  const assembly = await assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: '4'.repeat(64) }, limits)
  expect(assembly.deployment.skillCopies).toEqual({ maxCopiesPerOperation: 4 })
  expect(Object.isFrozen(assembly.deployment.skillCopies)).toBe(true)
  policy.maxCopiesPerOperation = 5
  expect(assembly.deployment.skillCopies?.maxCopiesPerOperation).toBe(4)
  expect(state.sandboxCreate).not.toHaveBeenCalled()
  await assembly.closeActual()
})

it('selects actual shared storage before SDK construction without adopting or waiting for a keeper', async () => {
  const selected = sharedPathDeploymentFixture(); state.input = selected
  const assembly = await assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: '4'.repeat(64) }, limits)
  expect(state.sharedCreated).toHaveBeenCalledExactlyOnceWith(Buffer.from('{}'), '5'.repeat(64), expect.any(Function), selected.storage.limits)
  expect(state.keeperAdopted).not.toHaveBeenCalled()
  expect(state.events).toContain('plan-current')
  expect(state.events).toContain('shared-current')
  expect(state.events).not.toContain('manifest-current')
  expect(state.sdkCreated).toHaveBeenCalledOnce()
  expect(state.sandboxCreate).not.toHaveBeenCalled()
  expect(state.keeperClosed).not.toHaveBeenCalled()
  state.sdkClose.resolve(undefined); await assembly.closeActual()
  expect(state.events.slice(-2)).toEqual(['plan-close', 'selection-close'])
  expect(state.events).not.toContain('keeper-close')
})

it('rejects unavailable shared storage before constructing the SDK instead of treating no keeper as ready', async () => {
  state.input = sharedPathDeploymentFixture(); state.sharedAvailable = false
  const failure = await assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: '4'.repeat(64) }, limits)
    .then(() => { throw new Error('Unavailable storage was admitted.') }, (cause: unknown) => cause)
  if (!(failure instanceof BootstrapFailure) || typeof failure.cause !== 'object' || failure.cause === null) {
    throw new Error('Expected retained construction cleanup.')
  }
  const cleanup: unknown = Reflect.get(failure.cause, 'cleanupActual')
  expect(cleanup).toBeInstanceOf(Promise)
  await cleanup
  expect(state.sharedCreated).toHaveBeenCalledOnce()
  expect(state.sdkCreated).not.toHaveBeenCalled()
  expect(state.events).toContain('plan-close')
  expect(state.events).toContain('selection-close')
  expect(state.events).not.toContain('keeper-close')
})

it('keeps physical SDK stop authority after shared storage revocation and retains files until actual stop', async () => {
  state.input = sharedPathDeploymentFixture()
  const assembly = await assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: '4'.repeat(64) }, limits)
  state.planCurrent = false
  expect(() => { assembly.deployment.assertCurrent() }).toThrow()
  expect(() => { state.guard() }).not.toThrow()
  const closing = assembly.closeActual()
  expect(state.events).toContain('sdk-close')
  expect(state.events).not.toContain('plan-close')
  state.sdkClose.resolve(undefined); await closing
  expect(state.events.slice(-2)).toEqual(['plan-close', 'selection-close'])
})

it('does not release shared-plan leases while a grant remains retained after SDK stop', async () => {
  state.input = sharedPathDeploymentFixture(); state.sdkClose.resolve(undefined)
  const assembly = await assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: '4'.repeat(64) }, limits)
  state.retained = 1
  await expect(assembly.closeActual()).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
  expect(state.events).not.toContain('plan-close')
  expect(state.events).not.toContain('selection-close')
})
