import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { directoryWorkBudget } from '../src/directory-budget.ts'
import { FilesWorkQueue } from '../src/work-queue.ts'
import { FilesWorkOwner } from '../src/work-owner.ts'
import type { DirectoryPrepareOutcome } from '../src/directory-responsibility.ts'

// Callback settlements exercise scheduling only; none of these fixtures performs Linux directory I/O.
const intent = { parent: { rootPath: '/projects', rootDevice: '1', rootInode: '2' }, leaf: 'default-workspace' }
const bounds = { maxPathBytes: 128, replyOverheadBytes: 32 }
const budget = directoryWorkBudget(intent, bounds)
const limits = {
  maxLanes: 3, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 1, maxQueuedPerLane: 1,
  maxResidentBytes: budget.totalBytes, maxResidentBytesPerLane: budget.totalBytes, waitTimeoutMs: 1000,
}
const created: DirectoryPrepareOutcome = { kind: 'created', identity: { device: '1', inode: '3' } }
function deferred<T>() { return Promise.withResolvers<T>() }
function binding(account = 'A', epoch = '1'): AccountBinding {
  return Object.freeze({ accountId: account as AccountId, epoch: epoch as OwnerEpoch,
    recipeVersion: 'component-only', lifetime: new AbortController().signal })
}
afterEach(() => { vi.useRealTimers() })

describe('bounded independent directory responsibility', () => {
  it('accounts exact fixed records, identity copies and independent complete cleanup scratch', () => {
    expect(budget).toEqual({ ioBytes: 6140, responsibilityBytes: 10284, totalBytes: 16424 })
    expect(Object.isFrozen(budget)).toBe(true)
    const uuid = directoryWorkBudget({ ...intent, leaf: randomUUID() }, bounds)
    expect(uuid.totalBytes).toBeGreaterThan(budget.totalBytes)
    const unicode = directoryWorkBudget({ ...intent, parent: { ...intent.parent, rootPath: '/项目' } }, bounds)
    expect(unicode.totalBytes).toBeLessThan(budget.totalBytes)
  })

  it.each([
    { ...intent, leaf: 'client-title' }, { ...intent, leaf: '../default-workspace' },
    { ...intent, leaf: 'default-workspace\0' },
    { ...intent, parent: { ...intent.parent, rootPath: '/projects/..' } },
  ])('refuses unapproved naming or unbounded intent before dispatch: %j', (bad) => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const execute = vi.fn(async () => created)
    expect(() => lane.prepareDirectory(bad, bounds, execute)).toThrow()
    expect(execute).not.toHaveBeenCalled()
    expect(queue.inspect()).toMatchObject({ running: 0, queued: 0, residentBytes: 0, pending: 0 })
    queue.close()
  })

  it('refuses overflow, invalid bounds and multibyte complete paths before backend work', () => {
    expect(() => directoryWorkBudget(intent, { ...bounds, replyOverheadBytes: Number.MAX_SAFE_INTEGER })).toThrow()
    expect(() => directoryWorkBudget(intent, { ...bounds, replyOverheadBytes: 0 })).toThrow()
    expect(() => directoryWorkBudget(intent, { ...bounds, maxPathBytes: 16385 })).toThrow()
    const multi = { ...intent, parent: { ...intent.parent, rootPath: `/${'项'.repeat(36)}` } }
    expect(() => directoryWorkBudget(multi, bounds)).not.toThrow()
    expect(() => directoryWorkBudget(multi, { ...bounds, maxPathBytes: 126 })).toThrow()
    const encoded = vi.spyOn(Buffer, 'byteLength')
    for (const oversized of [
      { ...intent, leaf: 'x'.repeat(1000) },
      { ...intent, parent: { ...intent.parent, rootPath: `/${'x'.repeat(1000)}` } },
      { ...intent, parent: { ...intent.parent, rootDevice: '9'.repeat(1000) } },
    ]) expect(() => directoryWorkBudget(oversized, bounds)).toThrow()
    expect(encoded).not.toHaveBeenCalled()
    encoded.mockRestore()
  })

  it('rejects Rdir-only capacity atomically with no retained partial reservation', () => {
    const queue = new FilesWorkQueue({ ...limits,
      maxResidentBytes: budget.responsibilityBytes, maxResidentBytesPerLane: budget.responsibilityBytes })
    const lane = queue.openLane()
    const execute = vi.fn(async () => created)
    expect(() => lane.prepareDirectory(intent, bounds, execute)).toThrow()
    expect(execute).not.toHaveBeenCalled()
    expect(lane.pending()).toEqual([])
    expect(queue.inspect()).toMatchObject({ residentBytes: 0, running: 0 })
    queue.close()
  })

  it('frees one running slot and Rio before sequential metadata while Rdir remains retained', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const prepared = lane.prepareDirectory(intent, bounds, async () => created)
    expect(queue.inspect()).toMatchObject({ running: 1, residentBytes: budget.totalBytes, pending: 1 })
    expect(await prepared.observation.waitPrepared()).toBe('created')
    expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: budget.responsibilityBytes, pending: 1 })
    for (const value of ['canonical', 'stat']) {
      const result = await lane.run(budget.ioBytes, async () => value)
      expect(result.value).toBe(value)
      result.release()
    }
    const held = await lane.run(budget.ioBytes, async () => 'held metadata')
    expect(queue.inspect().residentBytes).toBe(budget.totalBytes)
    expect(await prepared.control.cleanup(async (identity) => {
      expect(identity).toEqual({ device: '1', inode: '3' })
      expect(queue.inspect()).toMatchObject({ running: 1, residentBytes: budget.totalBytes })
      return 'cleaned'
    })).toBe('cleaned')
    expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: budget.ioBytes, pending: 1 })
    held.release()
    queue.close()
    await queue.whenClosed()
  })

  it('removes queued preparation on generation close without invoking its callback', async () => {
    const queue = new FilesWorkQueue({ ...limits, maxResidentBytes: budget.totalBytes + 1,
      maxResidentBytesPerLane: budget.totalBytes + 1 })
    const lane = queue.openLane()
    const actual = deferred<null>()
    const started = deferred<null>()
    const active = lane.run(1, async () => { started.resolve(null); await actual.promise })
    await started.promise
    const execute = vi.fn(async () => created)
    const queued = lane.prepareDirectory(intent, bounds, execute)
    const ordinaryRejected = expect(active).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    const directoryRejected = expect(queued.observation.waitPrepared()).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    lane.close()
    await Promise.all([ordinaryRejected, directoryRejected])
    expect(execute).not.toHaveBeenCalled()
    expect(queue.inspect()).toMatchObject({ running: 1, queued: 0, residentBytes: 1, pending: 1 })
    actual.resolve(null)
    await vi.waitFor(() => { expect(queue.inspect().pending).toBe(0) })
    queue.close()
  })

  it('confirms never-invoked preparation cancelled in the initial callback microtask', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const execute = vi.fn(async () => created)
    const prepared = lane.prepareDirectory(intent, bounds, execute)
    const rejected = expect(prepared.observation.waitPrepared()).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    queue.close()
    await rejected
    await queue.whenClosed()
    expect(execute).not.toHaveBeenCalled()
    expect(queue.inspect()).toMatchObject({ residentBytes: 0, pending: 0 })
  })

  it('keeps actual preparation and late-created responsibility after observer abort', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const actual = deferred<DirectoryPrepareOutcome>()
    const started = deferred<AbortSignal>()
    const prepared = lane.prepareDirectory(intent, bounds, async (signal) => { started.resolve(signal); return actual.promise })
    const control = await started.promise
    const observer = new AbortController()
    const reason = new Error('caller no longer observes')
    const rejected = expect(prepared.observation.waitPrepared(observer.signal)).rejects.toBe(reason)
    observer.abort(reason)
    await rejected
    expect(control.aborted).toBe(false)
    expect(queue.inspect()).toMatchObject({ running: 1, residentBytes: budget.totalBytes, pending: 1 })
    actual.resolve(created)
    expect(await prepared.observation.waitPrepared()).toBe('created')
    expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: budget.responsibilityBytes, pending: 1 })
    await prepared.control.cleanup(async () => 'cleaned')
    queue.close()
  })

  it('bounds observers and retains actual work after an observer deadline', async () => {
    vi.useFakeTimers()
    const queue = new FilesWorkQueue({ ...limits, waitTimeoutMs: 25 })
    const lane = queue.openLane()
    const actual = deferred<DirectoryPrepareOutcome>()
    const started = deferred<null>()
    const prepared = lane.prepareDirectory(intent, bounds, async () => { started.resolve(null); return actual.promise })
    await started.promise
    const rejected = expect(prepared.observation.waitPrepared()).rejects.toMatchObject({ code: 'files/deadline' })
    await expect(prepared.observation.waitPrepared()).rejects.toMatchObject({ code: 'cloud/capacity' })
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(queue.inspect()).toMatchObject({ running: 1, residentBytes: budget.totalBytes })
    actual.resolve(created)
    await vi.advanceTimersByTimeAsync(0)
    expect(await prepared.observation.waitPrepared()).toBe('created')
    await prepared.control.cleanup(async () => 'cleaned')
    queue.close()
  })

  it('allows only the original private cleanup after root business closure on the same queue', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const actual = deferred<DirectoryPrepareOutcome>()
    const started = deferred<AbortSignal>()
    const prepared = lane.prepareDirectory(intent, bounds, async (signal) => { started.resolve(signal); return actual.promise })
    const oldControl = await started.promise
    const rejected = expect(prepared.observation.waitPrepared()).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    queue.close()
    await rejected
    expect(oldControl.aborted).toBe(true)
    actual.resolve(created)
    await vi.waitFor(() => { expect(queue.inspect().running).toBe(0) })
    expect(lane.pending()).toEqual([prepared.observation.id])
    expect(() => lane.prepareDirectory(intent, bounds, async () => created)).toThrow()
    await expect(lane.run(1, async () => {})).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(prepared.control.cleanup(async (_identity, signal) => {
      expect(signal.aborted).toBe(false)
      expect(queue.inspect()).toMatchObject({ running: 1, residentBytes: budget.responsibilityBytes })
      return 'cleaned'
    })).resolves.toBe('cleaned')
    await queue.whenClosed()
    expect(queue.inspect()).toMatchObject({ pending: 0, residentBytes: 0, lanes: 0 })
  })

  it('refuses exposed cleanup and retains pending even when the component owner closes', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const prepared = lane.prepareDirectory(intent, bounds, async () => created)
    expect(prepared.control.expose()).toBe('/projects/default-workspace')
    await prepared.observation.waitPrepared()
    const remove = vi.fn(async (): Promise<'cleaned'> => 'cleaned')
    await expect(prepared.control.cleanup(remove)).rejects.toThrow()
    expect(remove).not.toHaveBeenCalled()
    queue.close()
    let closed = false
    void queue.whenClosed().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(queue.pending()).toEqual([prepared.observation.id])
    expect(queue.inspect().residentBytes).toBe(budget.responsibilityBytes)
  })

  it('retains unknown preparation after actual failure and never offers release or transfer by assertion', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    expect(lane.isIdle()).toBe(true)
    const reason = new Error('actual outcome unknown')
    const prepared = lane.prepareDirectory(intent, bounds, () => { throw reason })
    await expect(prepared.observation.waitPrepared()).rejects.toBe(reason)
    expect(lane.isIdle()).toBe(false)
    const remove = vi.fn(async (): Promise<'cleaned'> => 'cleaned')
    await expect(prepared.control.cleanup(remove)).rejects.toThrow()
    expect(remove).not.toHaveBeenCalled()
    expect(Object.keys(prepared.control).sort()).toEqual(['cleanup', 'expose'])
    queue.close()
    expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: budget.responsibilityBytes, pending: 1, lanes: 1 })
  })

  it('does not retain oversized queued backend identity as a confirmed creation', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const prepared = lane.prepareDirectory(intent, bounds, async () => ({
      kind: 'created', identity: { device: '1', inode: '9'.repeat(21) },
    }))
    await expect(prepared.observation.waitPrepared()).rejects.toThrow()
    const remove = vi.fn(async (): Promise<'cleaned'> => 'cleaned')
    await expect(prepared.control.cleanup(remove)).rejects.toThrow()
    expect(remove).not.toHaveBeenCalled()
    queue.close()
    expect(queue.inspect().residentBytes).toBe(budget.responsibilityBytes)
  })

  it.each(['unknown', 'throw'] as const)('keeps %s cleanup unsettled without blind retry', async (outcome) => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const prepared = lane.prepareDirectory(intent, bounds, async () => created)
    await prepared.observation.waitPrepared()
    const attempt = prepared.control.cleanup(async () => {
      if (outcome === 'throw') throw new Error('cleanup actual reply lost')
      return 'unknown'
    })
    if (outcome === 'throw') await expect(attempt).rejects.toThrow('cleanup actual reply lost')
    else expect(await attempt).toBe('unknown')
    const retry = vi.fn(async (): Promise<'cleaned'> => 'cleaned')
    await expect(prepared.control.cleanup(retry)).rejects.toThrow()
    expect(retry).not.toHaveBeenCalled()
    expect(() => prepared.control.expose()).toThrow()
    queue.close()
    expect(queue.pending()).toEqual([prepared.observation.id])
  })

  it('does not acquire cleanup ownership for an unchanged directory', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const prepared = lane.prepareDirectory(intent, bounds, async () => ({ kind: 'unchanged' }))
    expect(await prepared.observation.waitPrepared()).toBe('unchanged')
    expect(prepared.control.expose()).toBe('/projects/default-workspace')
    await expect(prepared.control.cleanup(async () => 'cleaned')).rejects.toThrow()
    expect(queue.inspect()).toMatchObject({ residentBytes: 0, pending: 0 })
    queue.close()
  })

  it('keeps running cleanup after observer abort and rejects concurrent cleanup or exposure', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const prepared = lane.prepareDirectory(intent, bounds, async () => created)
    await prepared.observation.waitPrepared()
    const actual = deferred<'cleaned'>()
    const started = deferred<null>()
    const observer = new AbortController()
    const pending = prepared.control.cleanup(async () => { started.resolve(null); return actual.promise }, observer.signal)
    await started.promise
    const rejected = expect(pending).rejects.toThrow('observer ended')
    observer.abort(new Error('observer ended'))
    await rejected
    await expect(prepared.control.cleanup(async () => 'cleaned')).rejects.toThrow()
    expect(() => prepared.control.expose()).toThrow()
    queue.close()
    expect(queue.inspect()).toMatchObject({ running: 1, residentBytes: budget.responsibilityBytes, pending: 1 })
    actual.resolve('cleaned')
    await queue.whenClosed()
    expect(queue.inspect().residentBytes).toBe(0)
  })

  it('shares ordinary queue capacity and refuses cleanup overflow without bypassing admission', async () => {
    const queue = new FilesWorkQueue({ ...limits, maxResidentBytes: budget.totalBytes + 2,
      maxResidentBytesPerLane: budget.totalBytes + 2 })
    const lane = queue.openLane()
    const prepared = lane.prepareDirectory(intent, bounds, async () => created)
    await prepared.observation.waitPrepared()
    const actual = deferred<null>()
    const first = lane.run(1, () => actual.promise)
    const second = lane.run(1, async () => {})
    const cleanup = vi.fn(async (): Promise<'cleaned'> => 'cleaned')
    await expect(prepared.control.cleanup(cleanup)).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(cleanup).not.toHaveBeenCalled()
    expect(queue.inspect()).toMatchObject({ running: 1, queued: 1, pending: 3 })
    actual.resolve(null)
    for (const result of await Promise.all([first, second])) result.release()
    await prepared.control.cleanup(cleanup)
    queue.close()
    await queue.whenClosed()
  })

  it('pumps already queued cleanup after closing business without starting another ordinary job', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const prepared = lane.prepareDirectory(intent, bounds, async () => created)
    await prepared.observation.waitPrepared()
    const actual = deferred<null>()
    const started = deferred<null>()
    const ordinary = lane.run(1, async () => { started.resolve(null); return actual.promise })
    await started.promise
    const cleanup = vi.fn(async (): Promise<'cleaned'> => 'cleaned')
    const cleaning = prepared.control.cleanup(cleanup)
    expect(queue.inspect()).toMatchObject({ running: 1, queued: 1, pending: 2 })
    const rejected = expect(ordinary).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    queue.close()
    await rejected
    expect(cleanup).not.toHaveBeenCalled()
    actual.resolve(null)
    expect(await cleaning).toBe('cleaned')
    expect(cleanup).toHaveBeenCalledOnce()
    await queue.whenClosed()
    expect(queue.inspect()).toMatchObject({ running: 0, queued: 0, residentBytes: 0, pending: 0 })
  })

  it('bounds responsibility count by positive resident reservation', async () => {
    const secondIntent = { ...intent, leaf: randomUUID() }
    const capacity = budget.responsibilityBytes + directoryWorkBudget(secondIntent, bounds).totalBytes
    const queue = new FilesWorkQueue({ ...limits, maxResidentBytes: capacity, maxResidentBytesPerLane: capacity })
    const lane = queue.openLane()
    const first = lane.prepareDirectory(intent, bounds, async () => created)
    await first.observation.waitPrepared()
    const second = lane.prepareDirectory(secondIntent, bounds, async () => created)
    await second.observation.waitPrepared()
    const third = vi.fn(async () => created)
    expect(() => lane.prepareDirectory({ ...intent, leaf: randomUUID() }, bounds, third)).toThrow()
    expect(third).not.toHaveBeenCalled()
    expect(lane.pending()).toHaveLength(2)
    await first.control.cleanup(async () => 'cleaned')
    await second.control.cleanup(async () => 'cleaned')
    queue.close()
  })

  it('reuses the same unresolved location and refuses identity changes without another callback', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const first = lane.prepareDirectory(intent, bounds, async () => created)
    const duplicate = vi.fn(async () => created)
    expect(lane.prepareDirectory(intent, bounds, duplicate)).toBe(first)
    expect(lane.prepareDirectory({ ...intent, parent: { ...intent.parent, rootPath: '/projects/' } }, bounds, duplicate)).toBe(first)
    await first.observation.waitPrepared()
    first.control.expose()
    expect(lane.prepareDirectory(intent, bounds, duplicate).observation.id).toBe(first.observation.id)
    expect(() => lane.prepareDirectory({ ...intent, parent: { ...intent.parent, rootInode: '99' } }, bounds, duplicate)).toThrow()
    expect(duplicate).not.toHaveBeenCalled()
    expect(queue.inspect()).toMatchObject({ residentBytes: budget.responsibilityBytes, pending: 1 })
    queue.close()
  })

  it('passes a frozen intent snapshot to preparation and cleanup after the original object changes', async () => {
    const queue = new FilesWorkQueue(limits)
    const lane = queue.openLane()
    const mutable = { parent: { ...intent.parent }, leaf: intent.leaf }
    const prepared = lane.prepareDirectory(mutable, bounds, async (_signal, fixed) => {
      expect(fixed).toEqual(intent)
      expect(Object.isFrozen(fixed)).toBe(true)
      expect(Object.isFrozen(fixed.parent)).toBe(true)
      return created
    })
    mutable.parent.rootPath = '/other'
    mutable.parent.rootInode = '99'
    mutable.leaf = randomUUID()
    await prepared.observation.waitPrepared()
    await prepared.control.cleanup(async (_identity, _signal, fixed) => {
      expect(fixed).toEqual(intent)
      expect(Object.isFrozen(fixed.parent)).toBe(true)
      return 'cleaned'
    })
    queue.close()
    await queue.whenClosed()
  })
})

describe('directory responsibility account lifetime', () => {
  it('retains the old epoch until owner-only cleanup actually finishes', async () => {
    const owner = new FilesWorkOwner(limits)
    const bound = binding()
    let current = true
    const port = owner.bind(bound, () => { if (!current) throw new Error('current owner ended') })
    const prepared = port.prepareDirectory(intent, bounds, async () => created)
    await prepared.observation.waitPrepared()
    current = false
    expect(() => prepared.control.expose()).toThrow('current owner ended')
    expect((await owner.stopEpoch(bound, Date.now())).status).toBe('unknown')
    expect(owner.pending()).toEqual([prepared.observation.id])
    expect(() => owner.bind(binding('A', '2'), () => {})).toThrow()
    expect(() => port.prepareDirectory(intent, bounds, async () => created)).toThrow()
    const actual = deferred<'cleaned'>()
    const started = deferred<null>()
    const cleanup = prepared.control.cleanup(async () => { started.resolve(null); return actual.promise })
    await started.promise
    owner.close()
    expect((await owner.stopEpoch(bound, Date.now())).status).toBe('unknown')
    actual.resolve('cleaned')
    expect(await cleanup).toBe('cleaned')
    await owner.whenClosed()
    expect(await owner.stopEpoch(bound, Date.now())).toMatchObject({ status: 'confirmed', pendingOperationIds: [] })
  })

  it('allows another account within shared spare running and resident capacity', async () => {
    const owner = new FilesWorkOwner({ ...limits, maxRunning: 2, maxResidentBytes: 2 * budget.totalBytes })
    const aBinding = binding()
    const a = owner.bind(aBinding, () => {})
    const b = owner.bind(binding('B'), () => {})
    const actual = deferred<DirectoryPrepareOutcome>()
    const started = deferred<null>()
    const prepared = a.prepareDirectory(intent, bounds, async () => { started.resolve(null); return actual.promise })
    await started.promise
    const result = await b.run(1, async () => 'B progresses')
    expect(result.value).toBe('B progresses')
    result.release()
    actual.resolve(created)
    await prepared.observation.waitPrepared()
    expect((await owner.stopEpoch(aBinding, Date.now())).status).toBe('unknown')
    await prepared.control.cleanup(async () => 'cleaned')
    expect((await owner.stopEpoch(aBinding, Date.now())).status).toBe('confirmed')
    const next = owner.bind(binding('A', '2'), () => {})
    const nextResult = await next.run(1, async () => 'next epoch')
    nextResult.release()
    owner.close()
    await owner.whenClosed()
  })
})

it('keeps retained directory responsibility and cleanup busy after preparation I/O has ended', async () => {
  const queue = new FilesWorkQueue(limits), lane = queue.openLane()
  const owned = lane.prepareDirectory(intent, bounds, async () => created)
  expect(lane.isIdle()).toBe(false)
  await owned.observation.waitPrepared()
  expect(queue.inspect().running).toBe(0)
  expect(lane.isIdle()).toBe(false)
  const pending = Promise.withResolvers<'cleaned'>(), entered = Promise.withResolvers<undefined>()
  const cleanup = owned.control.cleanup(async () => { entered.resolve(undefined); return pending.promise })
  await entered.promise
  expect(lane.isIdle()).toBe(false)
  pending.resolve('cleaned'); await cleanup
  expect(lane.isIdle()).toBe(true)
  queue.close(); await queue.whenClosed()
})
