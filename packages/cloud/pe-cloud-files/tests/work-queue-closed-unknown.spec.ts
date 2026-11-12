/** Finite actual settlement retains unknown responsibility without retaining execution capacity. */
import { expect, it } from 'vitest'
import { FilesWorkQueue } from '../src/work-queue.ts'

const limits = { maxLanes: 3, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 4,
  maxQueuedPerLane: 2, maxResidentBytes: 100, maxResidentBytesPerLane: 50, waitTimeoutMs: 10000 }

it('retains the original unknown record and complete budget after actual execution settles', async () => {
  const queue = new FilesWorkQueue(limits), lane = queue.openLane()
  const failure = new Error('public unknown operation')
  const result = await lane.run(17, async (_control, retainUnconfirmed) => {
    retainUnconfirmed(failure)
    throw failure
  }).catch((reason: unknown) => reason)
  const pending = lane.pending()
  const observed = queue.inspect()
  queue.close()
  expect(result).toBe(failure)
  expect(pending).toHaveLength(1)
  expect(observed).toMatchObject({ running: 0, residentBytes: 17, pending: 1, lanes: 1 })
  expect(queue.pending()).toEqual(pending)
  expect(lane.isIdle()).toBe(false)
})

it('keeps the first failure through early observer cancellation and pumps another lane only after actual settlement', async () => {
  const queue = new FilesWorkQueue(limits), a = queue.openLane(), b = queue.openLane()
  const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  const abort = new AbortController(), cancelled = new Error('public caller cancellation'), failure = new Error('public unknown')
  const actual = a.run(17, async (_control, retainUnconfirmed) => {
    entered.resolve(undefined)
    await finish.promise
    retainUnconfirmed(failure)
    retainUnconfirmed(new Error('later failure does not replace original responsibility'))
    throw failure
  }, abort.signal).catch((error: unknown) => error)
  await entered.promise
  const original = a.pending()
  const other = b.run(19, async () => 'other-account')
  abort.abort(cancelled)
  expect(await actual).toBe(cancelled)
  a.close()
  expect(queue.inspect()).toMatchObject({ running: 1, queued: 1, residentBytes: 36 })
  finish.resolve(undefined)
  const held = await other
  expect(held.value).toBe('other-account')
  expect(a.pending()).toEqual(original)
  expect(queue.inspect()).toMatchObject({ running: 0, queued: 0, residentBytes: 36, pending: 2 })
  held.release()
  expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: 17, pending: 1 })
  queue.close()
  expect(a.pending()).toEqual(original)
})

it('does not free responsibility when the retaining executor returns a value instead of rejecting', async () => {
  const queue = new FilesWorkQueue(limits), lane = queue.openLane(), failure = new Error('public retained outcome')
  const observed = await lane.run(17, async (_control, retainUnconfirmed) => {
    retainUnconfirmed(failure)
    return 'not a confirmed success'
  }).catch((error: unknown) => error)
  expect(observed).toBe(failure)
  expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: 17, pending: 1 })
  queue.close()
})

it('preserves ordinary explicit failure and success result release', async () => {
  const queue = new FilesWorkQueue(limits), lane = queue.openLane(), failure = new Error('public definite refusal')
  await expect(lane.run(17, async () => { throw failure })).rejects.toBe(failure)
  expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: 0, pending: 0 })
  const held = await lane.run(19, async () => 'confirmed')
  expect(held.value).toBe('confirmed')
  expect(queue.inspect()).toMatchObject({ running: 0, residentBytes: 19, pending: 1 })
  held.release(); held.release()
  expect(queue.inspect()).toMatchObject({ residentBytes: 0, pending: 0 })
  queue.close()
  await queue.whenClosed()
})

it('keeps original generation drain unknown and idle false after the executor ends', async () => {
  const { FilesWorkOwner } = await import('../src/work-owner.ts')
  const owner = new FilesWorkOwner(limits)
  const binding = { accountId: 'closed-unknown-owner' as import('@deepseek-ai/dsh-pe-cloud-runtime/types').AccountId,
    epoch: '1' as import('@deepseek-ai/dsh-pe-cloud-runtime/types').OwnerEpoch,
    recipeVersion: 'finite-component', lifetime: new AbortController().signal }
  const port = owner.bind(binding, () => {}), failure = new Error('public unknown responsibility')
  await expect(port.run(17, async (_control, retainUnconfirmed) => { retainUnconfirmed(failure); throw failure })).rejects.toBe(failure)
  expect(owner.isEpochIdle(binding)).toBe(false)
  const original = owner.pending()
  expect(await owner.stopEpoch(binding, Date.now())).toMatchObject({ status: 'unknown', pendingOperationIds: original })
  let joined = false
  void owner.joinEpoch(binding).then(() => { joined = true })
  owner.close()
  expect(owner.pending()).toEqual(original)
  expect(owner.inspect()).toMatchObject({ running: 0, residentBytes: 17, pending: 1, lanes: 1 })
  expect(joined).toBe(false)
})
