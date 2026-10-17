import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { FilesWorkOwner } from '../src/work-owner.ts'

const limits = {
  maxLanes: 3, maxRunning: 2, maxRunningPerLane: 1,
  maxQueued: 2, maxQueuedPerLane: 1,
  maxResidentBytes: 30, maxResidentBytesPerLane: 20, waitTimeoutMs: 10_000,
}
function binding(account = 'A', epoch = '1'): AccountBinding {
  return Object.freeze({
    accountId: account as AccountId, epoch: epoch as OwnerEpoch,
    recipeVersion: 'test-only', lifetime: new AbortController().signal,
  })
}
afterEach(() => { vi.useRealTimers() })

describe('files generation work owner', () => {
  it('rejects a structurally similar binding and refuses another generation before drain', async () => {
    const owner = new FilesWorkOwner(limits)
    const first = binding()
    const port = owner.bind(first, () => {})
    expect(() => owner.bind(binding('A', '2'), () => {})).toThrow()
    await expect(owner.stopEpoch({ ...first }, Date.now())).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect((await owner.stopEpoch(first, Date.now())).status).toBe('confirmed')
    expect(() => port.run(0, async () => {})).toThrow()
    const next = binding('A', '2')
    const nextPort = owner.bind(next, () => {})
    const result = await nextPort.run(0, async () => 'new generation')
    expect(result.value).toBe('new generation')
    result.release()
    owner.close()
  })

  it('returns unknown after a deadline and confirms only after actual work settles', async () => {
    vi.useFakeTimers()
    const owner = new FilesWorkOwner(limits)
    const bound = binding()
    const port = owner.bind(bound, () => {})
    let complete!: () => void
    let started!: () => void
    const actual = new Promise<void>((resolve) => { complete = resolve })
    const start = new Promise<void>((resolve) => { started = resolve })
    const wait = port.run(12, async () => { started(); await actual })
    await start
    const rejected = expect(wait).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    const drain = owner.stopEpoch(bound, Date.now() + 30)
    await rejected
    await vi.advanceTimersByTimeAsync(30)
    const receipt = await drain
    expect(receipt).toMatchObject({ participant: 'files', accountId: 'A', epoch: '1', status: 'unknown' })
    expect(receipt.pendingOperationIds).toHaveLength(1)
    expect(() => owner.bind(binding('A', '2'), () => {})).toThrow()
    complete()
    await vi.advanceTimersByTimeAsync(0)
    expect(await owner.stopEpoch(bound, Date.now())).toMatchObject({ status: 'confirmed', pendingOperationIds: [] })
    owner.close()
  })

  it('retains delivered result reservations during drain until release', async () => {
    const owner = new FilesWorkOwner(limits)
    const bound = binding()
    const port = owner.bind(bound, () => {})
    const result = await port.run(10, async () => new Uint8Array(10))
    expect((await owner.stopEpoch(bound, Date.now())).status).toBe('unknown')
    result.release()
    expect(await owner.stopEpoch(bound, Date.now())).toMatchObject({ status: 'confirmed', pendingOperationIds: [] })
    owner.close()
  })

  it('checks the runtime admission callback on every submission', async () => {
    const owner = new FilesWorkOwner(limits)
    const bound = binding()
    let current = true
    const port = owner.bind(bound, () => { if (!current) throw new Error('owner changed') })
    current = false
    const backend = vi.fn(async () => {})
    expect(() => port.run(0, backend)).toThrow('owner changed')
    expect(backend).not.toHaveBeenCalled()
    owner.close()
  })

  it('stops the exact lane when its graph lifetime ends without stopping another account', async () => {
    const lifetime = new AbortController()
    const bound = Object.freeze({ ...binding(), lifetime: lifetime.signal })
    const owner = new FilesWorkOwner(limits)
    const port = owner.bind(bound, () => {})
    const b = owner.bind(binding('B'), () => {})
    lifetime.abort()
    expect(port.stopping.aborted).toBe(true)
    expect(b.stopping.aborted).toBe(false)
    expect(() => port.run(0, async () => {})).toThrow()
    const result = await b.run(1, async () => 'B continues')
    expect(result.value).toBe('B continues')
    result.release()
    expect((await owner.stopEpoch(bound, Date.now())).status).toBe('confirmed')
    owner.close()
    expect(b.stopping.aborted).toBe(true)
  })

  it('rejects an invalid drain deadline and unknown generation', async () => {
    const owner = new FilesWorkOwner(limits)
    const bound = binding()
    owner.bind(bound, () => {})
    await expect(owner.stopEpoch(bound, Number.POSITIVE_INFINITY)).rejects.toMatchObject({ code: 'files/prerequisite-missing' })
    await expect(owner.stopEpoch(binding('B'), Date.now())).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    owner.close()
  })
})
