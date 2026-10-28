import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SessionAllocationOwner, type AllocationBackend, type NativeAllocationRequest } from '../src/allocation-owner.ts'
import { AllocationQueryNotSubmittedError } from '../src/allocation-store.ts'
import type { AllocationCreateIntent, AllocationExpectation, AllocationChange, AllocationScope, SandboxAllocation } from '../src/allocation-types.ts'

class NeverSubmitted extends AllocationQueryNotSubmittedError {
  constructor() { super(); this.name = 'FixtureNeverSubmitted' }
}

function fixture() {
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>('a'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'allocation-unit', lifetime: lifetime.signal })
  const rows = new Map<string, SandboxAllocation>()
  const created = Promise.withResolvers<{ sandboxId: string }>()
  const stopped = Promise.withResolvers<undefined>()
  const release = vi.fn()
  let current = true, existing = false, unknownBegin = false, unknownReady = false, pendingReady = false
  let committedBegin = false, pendingBegin = false, unsubmittedBegin = false
  let terminalUnknown = false, terminalNotSubmitted = false, pendingTerminal = false
  let afterBegin: (() => void) | undefined
  const mount = { value: Object.freeze({ marker: 'one original files capability' }),
    projectMountVersion: 'mount-v1', assertCurrent: () => { if (!current) throw new Error('stale mount') }, release }
  const prepareMount = vi.fn(async () => mount)
  const request = (session = 's1'): NativeAllocationRequest<typeof mount.value> => ({
    binding, sessionId: brandString<SessionId>(session), workspaceId: brandString<WorkspaceId>('w1'),
    assertCurrent: () => { if (!current) throw new Error('stale native selection') }, prepareMount,
  })
  const store = {
    begin: vi.fn(async (intent: AllocationCreateIntent) => {
      if (unsubmittedBegin) throw new NeverSubmitted()
      if (unknownBegin) throw new Error('SQL outcome unknown')
      const row: SandboxAllocation = { ...intent, state: 'creating', sandboxId: null,
        lastActivityAt: intent.requestedAt, lastCheckedAt: intent.requestedAt,
        runtimeIdentity: null, executionProtocolVersion: null, executionCapabilities: [], failureCode: null }
      rows.set(row.allocationId, row)
      afterBegin?.()
      if (committedBegin) { pendingBegin = true; throw new Error('Committed intent response lost') }
      return { allocation: row, inserted: !existing }
    }),
    transition: vi.fn(async (expected: AllocationExpectation, change: AllocationChange) => {
      if (pendingReady) throw new Error('Original ready CAS remains unknown')
      const row = rows.get(expected.allocationId)
      if (row === undefined || row.state !== expected.state) throw new Error('CAS conflict')
      const next: SandboxAllocation = { ...row, state: change.to, sandboxId: change.sandboxId ?? row.sandboxId,
        ...(change.to === 'ready' ? { runtimeIdentity: change.runtimeIdentity,
          executionProtocolVersion: change.executionProtocolVersion, executionCapabilities: change.executionCapabilities } : {}) }
      rows.set(next.allocationId, next)
      if (unknownReady && change.to === 'ready') {
        pendingReady = true
        throw new Error('Ready CAS outcome unknown')
      }
      return next
    }),
    reconcileCommitted: vi.fn(async (scope: AllocationScope) => {
      const row = rows.get(scope.allocationId)
      if (pendingBegin && row?.state === 'creating') { pendingBegin = false; return row }
      if (pendingTerminal && row?.state === 'failed') { pendingTerminal = false; return row }
      if (!pendingReady || row?.state !== 'ready') throw new Error('Exact postimage not confirmed')
      pendingReady = false
      return row
    }),
    failNotCreated: vi.fn(async (expected: AllocationExpectation, failureCode: string) => {
      if (terminalNotSubmitted) { terminalNotSubmitted = false; throw new NeverSubmitted() }
      const row = rows.get(expected.allocationId)
      if (row === undefined || row.state !== 'creating') throw new Error('No creating row')
      const next: SandboxAllocation = { ...row, state: 'failed', failureCode }
      rows.set(next.allocationId, next)
      if (terminalUnknown) { terminalUnknown = false; pendingTerminal = true; throw new Error('Failed CAS response lost') }
      return next
    }),
    releaseStopped: vi.fn(async (expected: AllocationExpectation) => {
      const row = rows.get(expected.allocationId)
      if (row === undefined || row.state !== 'stopping') throw new Error('No stopped row')
      const next: SandboxAllocation = { ...row, state: 'released' }
      rows.set(next.allocationId, next)
      return next
    }),
  }
  const backend = {
    create: vi.fn<AllocationBackend<typeof mount.value>['create']>(() => created.promise),
    prepare: vi.fn<AllocationBackend<typeof mount.value>['prepare']>(async ({ sandboxId }) => ({
      sandboxId, runtimeIdentity: 'runtime-1', protocolVersion: 'fixture-1', capabilities: ['argv-collect'],
    })),
    stop: vi.fn<AllocationBackend<typeof mount.value>['stop']>(() => stopped.promise),
  }
  const owner = new SessionAllocationOwner(store, backend, { environmentVersion: 'image+abi+recipe-1',
    provider: 'unit-only', createBudgetMs: 1000, maxAllocations: 2, maxAllocationsPerAccount: 2,
    maxWaiters: 4, maxWaitersPerAllocation: 2 })
  return { owner, backend, store, created, stopped, release, request, lifetime, prepareMount, rows,
    stale: () => { current = false }, existing: () => { existing = true },
    unknownBegin: () => { unknownBegin = true }, unknownReady: () => { unknownReady = true },
    committedBegin: () => { committedBegin = true }, unsubmittedBegin: () => { unsubmittedBegin = true },
    afterBegin: (callback: () => void) => { afterBegin = callback },
    terminalUnknown: () => { terminalUnknown = true }, terminalNotSubmitted: () => { terminalNotSubmitted = true } }
}

describe('Root actual Session allocation ownership', () => {
  it('observes only the original settled ready handle for idle retirement without preparing or stopping it', async () => {
    const f = fixture(), request = f.request()
    expect(f.owner.preparedForRetirement(request)).toBeUndefined()
    expect(f.prepareMount).not.toHaveBeenCalled()
    const actual = f.owner.prepare(request)
    await vi.waitFor(() => { expect(f.backend.create).toHaveBeenCalledTimes(1) })
    expect(f.owner.preparedForRetirement(request)).toBeUndefined()
    f.created.resolve({ sandboxId: 'original-ready' })
    const prepared = await actual
    expect(f.owner.preparedForRetirement(request)).toBe(prepared)
    expect(f.owner.preparedForRetirement({ ...request })).toBeUndefined()
    expect(f.backend.create).toHaveBeenCalledTimes(1)
    expect(f.backend.prepare).toHaveBeenCalledTimes(1)
    expect(f.backend.stop).not.toHaveBeenCalled()
    const stopped = f.owner.stop(request)
    expect(f.owner.preparedForRetirement(request)).toBeUndefined()
    f.stopped.resolve(undefined); await stopped
    expect(f.owner.preparedForRetirement(request)).toBeUndefined()
    expect(f.owner.inspect().allocations).toBe(0)
  })

  it('ends a pre-intent cancellation without SQL or backend work', async () => {
    const f = fixture(), request = f.request()
    const prepared = f.owner.prepare(request)
    const refused = expect(prepared).rejects.toThrow('closed or unresolved')
    const stop = f.owner.stop(request)
    await refused
    await stop
    expect(f.store.begin).not.toHaveBeenCalled()
    expect(f.backend.create).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.owner.inspect().allocations).toBe(0)
  })

  it('coalesces the entire chain and preserves it when just one waiter is cancelled', async () => {
    const f = fixture(), request = f.request(), cancel = new AbortController()
    const a = f.owner.prepare(request, cancel.signal), b = f.owner.prepare(request)
    await vi.waitFor(() => { expect(f.backend.create).toHaveBeenCalledTimes(1) })
    const cause = Object.freeze({ original: 'caller reason' })
    cancel.abort(cause)
    await expect(a).rejects.toBe(cause)
    expect(f.owner.inspect().allocations).toBe(1)
    expect(f.backend.stop).not.toHaveBeenCalled()
    f.created.resolve({ sandboxId: 'physical-1' })
    const ready = await b
    expect(await f.owner.prepare(request)).toBe(ready)
    expect(f.prepareMount).toHaveBeenCalledTimes(1)
    expect(f.store.begin).toHaveBeenCalledTimes(1)
    expect(f.backend.create).toHaveBeenCalledTimes(1)
    const stopping = f.owner.stop(request)
    await vi.waitFor(() => { expect(f.backend.stop).toHaveBeenCalledTimes(1) })
    expect(f.owner.inspect().allocations).toBe(1)
    expect(f.release).not.toHaveBeenCalled()
    await expect(f.owner.prepare(request)).rejects.toThrow('closed or unresolved')
    f.stopped.resolve(undefined)
    await stopping
    expect(f.owner.inspect().allocations).toBe(0)
    expect(f.release).toHaveBeenCalledTimes(1)
    expect([...f.rows.values()][0]?.state).toBe('released')
  })

  it('owns a late successful create through actual stop while fencing handshake and ready publication', async () => {
    const f = fixture(), request = f.request()
    const preparation = f.owner.prepare(request)
    const refused = expect(preparation).rejects.toThrow('closed or unresolved')
    await vi.waitFor(() => { expect(f.backend.create).toHaveBeenCalledTimes(1) })
    const stop = f.owner.stop(request)
    expect(f.owner.stop(request)).toBe(stop)
    f.created.resolve({ sandboxId: 'late-physical' })
    await refused
    await vi.waitFor(() => { expect(f.backend.stop).toHaveBeenCalledWith({ sandboxId: 'late-physical' }, undefined) })
    expect(f.backend.prepare).not.toHaveBeenCalled()
    expect(f.store.releaseStopped).not.toHaveBeenCalled()
    f.stopped.resolve(undefined)
    await stop
    expect(f.release).toHaveBeenCalledTimes(1)
  })

  it('never mutates an existing noninserted allocation into failed or replays create', async () => {
    const f = fixture(), request = f.request()
    f.existing()
    await expect(f.owner.prepare(request)).rejects.toThrow('closed or unresolved')
    await expect(f.owner.stop(request)).rejects.toThrow('closed or unresolved')
    expect(f.backend.create).not.toHaveBeenCalled()
    expect(f.store.failNotCreated).not.toHaveBeenCalled()
    expect(f.owner.inspect().allocations).toBe(1)
    expect(f.release).not.toHaveBeenCalled()
  })

  it('retains a lost create response and capacity; a second request does not resubmit', async () => {
    const f = fixture(), request = f.request()
    const first = f.owner.prepare(request)
    await vi.waitFor(() => { expect(f.backend.create).toHaveBeenCalledTimes(1) })
    f.created.reject(new Error('provider response unknown'))
    await expect(first).rejects.toThrow('provider response unknown')
    await expect(f.owner.prepare(request)).rejects.toThrow('provider response unknown')
    await expect(f.owner.stop(request)).rejects.toThrow('closed or unresolved')
    expect(f.backend.create).toHaveBeenCalledTimes(1)
    expect(f.backend.stop).not.toHaveBeenCalled()
    expect(f.store.failNotCreated).not.toHaveBeenCalled()
    expect(f.owner.inspect().allocations).toBe(1)
    expect(f.owner.preparedForRetirement(request)).toBeUndefined()
  })

  it('retains uncertain SQL before create without claiming no allocation metadata exists', async () => {
    const f = fixture(), request = f.request()
    f.unknownBegin()
    await expect(f.owner.prepare(request)).rejects.toThrow('SQL outcome unknown')
    await expect(f.owner.close()).rejects.toThrow('closed or unresolved')
    expect(f.backend.create).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
    expect(f.owner.inspect().allocations).toBe(1)
    await expect(f.owner.reconcileUnstartedMetadata(request)).rejects.toThrow('Exact postimage not confirmed')
    expect(f.owner.inspect().allocations).toBe(1)
  })

  it('reconciles an exact committed intent without ever calling provider create', async () => {
    const f = fixture(), request = f.request()
    f.committedBegin()
    await expect(f.owner.prepare(request)).rejects.toThrow('Committed intent response lost')
    const reconcile = f.owner.reconcileUnstartedMetadata(request)
    expect(f.owner.reconcileUnstartedMetadata(request)).toBe(reconcile)
    await reconcile
    expect(f.backend.create).not.toHaveBeenCalled()
    expect(f.store.reconcileCommitted).toHaveBeenCalledTimes(1)
    expect(f.store.failNotCreated).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.owner.inspect().allocations).toBe(0)
  })

  it('returns capacity after an actual never-submitted SQL refusal', async () => {
    const f = fixture(), request = f.request()
    f.unsubmittedBegin()
    await expect(f.owner.prepare(request)).rejects.toBeInstanceOf(AllocationQueryNotSubmittedError)
    await f.owner.stop(request)
    expect(f.backend.create).not.toHaveBeenCalled()
    expect(f.store.failNotCreated).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.owner.inspect().allocations).toBe(0)
  })

  it('returns a refused mount reservation only through the original stop without submitting SQL or SDK work', async () => {
    const f = fixture(), refused = new Error('known pre-allocation mount refusal')
    f.prepareMount.mockRejectedValue(refused)
    for (const request of [f.request('session-A'), f.request('session-B'), f.request('session-C')]) {
      await expect(f.owner.prepare(request)).rejects.toBe(refused)
      expect(f.owner.inspect().allocations).toBe(1)
      await f.owner.stop(request)
      expect(f.owner.inspect().allocations).toBe(0)
    }
    expect(f.store.begin).not.toHaveBeenCalled(); expect(f.store.failNotCreated).not.toHaveBeenCalled()
    expect(f.backend.create).not.toHaveBeenCalled(); expect(f.backend.stop).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
  })

  it.each(['committed-response-lost', 'never-submitted'] as const)(
    'reconciles the zero-create terminal CAS when it was %s', async (kind) => {
      const f = fixture(), request = f.request()
      if (kind === 'committed-response-lost') f.terminalUnknown()
      else f.terminalNotSubmitted()
      let stopped: Promise<void> | undefined
      f.afterBegin(() => {
        stopped = f.owner.stop(request)
        void stopped.catch(() => { /* Observe below after preparation's rejection. */ })
      })
      await expect(f.owner.prepare(request)).rejects.toThrow('closed or unresolved')
      if (stopped === undefined) throw new Error('Stop was not called after the confirmed begin')
      await expect(stopped).rejects.toBeInstanceOf(Error)
      expect(f.owner.inspect().allocations).toBe(1)
      expect(f.release).not.toHaveBeenCalled()
      await f.owner.reconcileUnstartedMetadata(request)
      expect(f.owner.inspect().allocations).toBe(0)
      expect(f.release).toHaveBeenCalledTimes(1)
      expect(f.backend.create).not.toHaveBeenCalled()
      expect(f.store.failNotCreated).toHaveBeenCalledTimes(kind === 'never-submitted' ? 2 : 1)
      expect(f.store.reconcileCommitted).toHaveBeenCalledTimes(kind === 'never-submitted' ? 0 : 1)
    })

  it('still stops the known physical resource after a lost ready CAS response', async () => {
    const f = fixture(), request = f.request()
    f.unknownReady()
    const first = f.owner.prepare(request)
    f.created.resolve({ sandboxId: 'known-physical' })
    await expect(first).rejects.toThrow('Ready CAS outcome unknown')
    const stop = f.owner.stop(request)
    await vi.waitFor(() => { expect(f.backend.stop).toHaveBeenCalledTimes(1) })
    f.stopped.resolve(undefined)
    await expect(stop).rejects.toThrow('Original ready CAS remains unknown')
    expect(f.release).not.toHaveBeenCalled()
    expect(f.owner.inspect().allocations).toBe(1)
    const reconciled = f.owner.reconcileStoppedMetadata(request)
    expect(f.owner.reconcileStoppedMetadata(request)).toBe(reconciled)
    await reconciled
    expect(f.store.reconcileCommitted).toHaveBeenCalledTimes(1)
    expect(f.backend.stop).toHaveBeenCalledTimes(1)
    expect(f.backend.create).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.owner.inspect().allocations).toBe(0)
  })

  it('isolates same-project Sessions and rejects a copied account generation before reuse', async () => {
    const f = fixture()
    f.created.resolve({ sandboxId: 'unit-shared-reply-only' })
    const a = f.request('a'), b = f.request('b')
    await Promise.all([f.owner.prepare(a), f.owner.prepare(b)])
    expect(f.store.begin).toHaveBeenCalledTimes(2)
    expect(f.backend.create).toHaveBeenCalledTimes(2)
    expect(new Set(f.store.begin.mock.calls.map(([intent]) => intent.allocationId)).size).toBe(2)
    await expect(f.owner.prepare({ ...a, binding: { ...a.binding } })).rejects.toThrow('selection changed')
    await expect(f.owner.prepare(f.request('c'))).rejects.toThrow('capacity')
    f.stopped.resolve(undefined)
    await f.owner.close()
    expect(f.owner.inspect().allocations).toBe(0)
  })

  it('fences an expired preparation while retaining a late create for actual stop', async () => {
    const f = fixture(), request = f.request()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const first = f.owner.prepare(request)
      await vi.waitFor(() => { expect(f.backend.create).toHaveBeenCalledTimes(1) })
      clock.mockReturnValue(1_700_000_001_001)
      f.created.resolve({ sandboxId: 'late-expired-physical' })
      await expect(first).rejects.toThrow('exceeded its infrastructure deadline')
      expect(f.backend.prepare).not.toHaveBeenCalled()
      expect(f.owner.inspect().allocations).toBe(1)
      f.stopped.resolve(undefined)
      await f.owner.stop(request)
      expect(f.backend.stop).toHaveBeenCalledWith({ sandboxId: 'late-expired-physical' }, undefined)
      expect(f.owner.inspect().allocations).toBe(0)
    } finally { clock.mockRestore() }
  })

  it('bounds pending waiters and detaches cancelled waiters while keeping only one shared create', async () => {
    const f = fixture(), request = f.request(), firstCancel = new AbortController()
    const first = f.owner.prepare(request, firstCancel.signal), kept = f.owner.prepare(request)
    await expect(f.owner.prepare(request)).rejects.toThrow('waiter capacity')
    expect(f.owner.inspect().waiters).toBe(2)
    firstCancel.abort()
    await expect(first).rejects.toBe(firstCancel.signal.reason)
    for (let index = 0; index < 20; index++) {
      const cancel = new AbortController(), waiter = f.owner.prepare(request, cancel.signal)
      expect(f.owner.inspect().waiters).toBe(2)
      cancel.abort()
      await expect(waiter).rejects.toBe(cancel.signal.reason)
      expect(f.owner.inspect().waiters).toBe(1)
    }
    f.created.resolve({ sandboxId: 'one-shared-create' })
    await kept
    expect(f.owner.inspect().waiters).toBe(0)
    expect(f.backend.create).toHaveBeenCalledTimes(1)
    f.stopped.resolve(undefined)
    await f.owner.close()
  })
})

it('observes warm allocation idleness without releasing its files lease, changing identity or replaying create', async () => {
  const f = fixture(), request = f.request()
  expect(f.owner.isEpochIdle(request.binding)).toBe(true)
  const wait = f.owner.prepare(request)
  await vi.waitFor(() => { expect(f.backend.create).toHaveBeenCalledTimes(1) })
  expect(f.owner.isEpochIdle(request.binding)).toBe(false)
  f.created.resolve({ sandboxId: 'warm-sandbox' })
  const prepared = await wait
  expect(f.owner.isEpochIdle(request.binding)).toBe(true)
  expect(f.owner.isEpochIdle({ ...request.binding })).toBe(false)
  for (let i = 0; i < 3; i++) expect(f.owner.isEpochIdle(request.binding)).toBe(true)
  expect(f.release).not.toHaveBeenCalled(); expect(f.backend.stop).not.toHaveBeenCalled()
  expect(await f.owner.prepare(request)).toBe(prepared)
  expect(prepared).toMatchObject({ sandboxId: 'warm-sandbox', runtimeIdentity: 'runtime-1' })
  expect(f.backend.create).toHaveBeenCalledTimes(1)
  const stopped = f.owner.stop(request)
  expect(f.owner.isEpochIdle(request.binding)).toBe(false)
  f.stopped.resolve(undefined); await stopped
  expect(f.owner.isEpochIdle(request.binding)).toBe(true)
  expect(f.release).toHaveBeenCalledTimes(1)
  await f.owner.close()
  expect(f.owner.isEpochIdle(request.binding)).toBe(false)
})

it('refuses unknown ready persistence and late creating work after the observer leaves', async () => {
  const f = fixture(), request = f.request(), cancel = new AbortController()
  f.unknownReady()
  const wait = f.owner.prepare(request, cancel.signal)
  await vi.waitFor(() => { expect(f.backend.create).toHaveBeenCalledTimes(1) })
  const rejected = expect(wait).rejects.toThrow('observation left')
  cancel.abort(new Error('observation left')); await rejected
  expect(f.owner.isEpochIdle(request.binding)).toBe(false)
  f.created.resolve({ sandboxId: 'late-warm' })
  await vi.waitFor(() => { expect(f.store.transition).toHaveBeenCalled() })
  expect(f.owner.isEpochIdle(request.binding)).toBe(false)
  expect(f.owner.inspect()).toMatchObject({ allocations: 1, waiters: 0 })
  expect(f.release).not.toHaveBeenCalled(); expect(f.backend.create).toHaveBeenCalledTimes(1)
  const stopped = f.owner.stop(request)
  f.stopped.resolve(undefined)
  await expect(stopped).rejects.toThrow()
  expect(f.owner.isEpochIdle(request.binding)).toBe(false)
})
