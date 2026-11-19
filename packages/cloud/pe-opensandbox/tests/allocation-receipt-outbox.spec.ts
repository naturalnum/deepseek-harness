/** Scripted transaction and transport effects. No database or SDK service is contacted. */
import { expect, it, vi } from 'vitest'
import {
  AllocationReceiptOutbox,
  type AllocationDeletionReceipt, type AllocationReceiptStorage, type AllocationReceiptTransport,
  type OriginalDeletionBinding, type PersistedDeletionReceipt,
} from '../src/allocation-receipt-outbox.ts'
import type { AllocationScope } from '../src/allocation-types.ts'

function original(id: string): AllocationDeletionReceipt {
  return {
    allocationId: id as AllocationScope['allocationId'],
    accountId: 'a-1' as AllocationScope['accountId'],
    sessionId: `session-${id}` as AllocationScope['sessionId'],
    workspaceId: 'project-1' as AllocationScope['workspaceId'],
    epoch: '1' as AllocationScope['epoch'],
    sandboxId: `sandbox-${id}`, containerId: 'a'.repeat(64),
    providerGeneration: 'b'.repeat(64), policyDigest: 'c'.repeat(64), receiptDigest: 'd'.repeat(64),
  }
}

function key(scope: AllocationScope): string {
  return JSON.stringify([scope.allocationId, scope.accountId, scope.sessionId, scope.workspaceId, scope.epoch])
}

function fixture(...readyForRelease: readonly OriginalDeletionBinding[]) {
  const awaitingStop = new Map(readyForRelease.map(binding => [key(binding), binding]))
  const durable = new Map<string, PersistedDeletionReceipt>()
  const accepted = new Map<string, AllocationDeletionReceipt>()
  const failure = { loseReleaseReply: false, failBeforeRelease: false, loseAckReply: false,
    loseMarkReply: false, failBeforeMark: false }
  const slotCount = () => [...durable.values()].filter(row => row.ack === 'pending').length
  const storage: AllocationReceiptStorage = {
    release: vi.fn(async (receipt, capacity) => {
      if (failure.failBeforeRelease) throw new Error('connection lost before write')
      const id = key(receipt)
      const existing = durable.get(id)
      if (existing !== undefined) return JSON.stringify(existing.receipt) === JSON.stringify(receipt) ? 'recorded' : 'conflict'
      const originalBinding = awaitingStop.get(id)
      if (originalBinding?.sandboxId !== receipt.sandboxId) return 'conflict'
      if (slotCount() >= capacity) return 'capacity'
      durable.set(id, { state: 'released', ack: 'pending', receipt })
      awaitingStop.delete(id)
      if (failure.loseReleaseReply) throw new Error('connection lost after commit')
      return 'recorded'
    }),
    read: vi.fn(async scope => durable.get(key(scope))),
    pending: vi.fn(async () => [...durable.values()].filter(row => row.ack === 'pending').map(row => row.receipt)),
    markAcknowledged: vi.fn(async (receipt) => {
      if (failure.failBeforeMark) throw new Error('connection lost before mark')
      const id = key(receipt)
      const row = durable.get(id)
      if (row !== undefined && JSON.stringify(row.receipt) === JSON.stringify(receipt)) {
        durable.set(id, { ...row, ack: 'acknowledged' })
      }
      if (failure.loseMarkReply) throw new Error('connection lost after mark')
    }),
  }
  const transport: AllocationReceiptTransport = {
    acknowledge: vi.fn(async (receipt) => {
      const id = key(receipt)
      if (!accepted.has(id)) accepted.set(id, receipt)
      if (failure.loseAckReply) throw new Error('ACK reply lost after provider committed')
      return accepted.get(id) ?? receipt
    }),
  }
  return { failure, durable, accepted, storage, transport, slotCount, awaitingStop,
    open: (capacity = 2) => new AllocationReceiptOutbox(storage, transport, capacity) }
}

it('requires committed release evidence and recovers a lost submission reply by independent readback', async () => {
  const receipt = original('allocation-1')
  const f = fixture(receipt)
  const app = f.open()
  f.failure.failBeforeRelease = true
  await expect(app.persistRelease(receipt, receipt)).rejects.toMatchObject({ code: 'release-unconfirmed' })
  await expect(app.acknowledge(receipt)).resolves.toBe('missing')
  expect(f.transport.acknowledge).not.toHaveBeenCalled()
  expect(f.awaitingStop.has(key(receipt))).toBe(true)

  f.failure.failBeforeRelease = false
  f.failure.loseReleaseReply = true
  await expect(app.persistRelease(receipt, receipt)).resolves.toEqual({ state: 'released', ack: 'pending', receipt })
  expect(f.storage.read).toHaveBeenCalledWith({
    allocationId: receipt.allocationId, accountId: receipt.accountId, sessionId: receipt.sessionId,
    workspaceId: receipt.workspaceId, epoch: receipt.epoch,
  })
  expect(f.slotCount()).toBe(1)
  expect(f.transport.acknowledge).not.toHaveBeenCalled()
})

it('replays the exact receipt after an ACK response is lost and the application restarts', async () => {
  const receipt = original('allocation-1')
  const f = fixture(receipt)
  const app = f.open()
  await app.persistRelease(receipt, receipt)
  f.failure.loseAckReply = true
  await expect(app.acknowledge(receipt)).rejects.toMatchObject({ code: 'ack-unconfirmed' })
  expect(f.accepted.size).toBe(1)
  expect(f.slotCount()).toBe(1)
  expect(f.storage.markAcknowledged).not.toHaveBeenCalled()

  f.failure.loseAckReply = false
  f.failure.loseMarkReply = true
  const restarted = f.open()
  const pending = await restarted.pending()
  expect(pending).toHaveLength(1)
  await expect(restarted.acknowledge(pending[0]!)).resolves.toBe('acknowledged')
  await expect(restarted.acknowledge(receipt)).resolves.toBe('acknowledged')
  expect(f.transport.acknowledge).toHaveBeenCalledTimes(2)
  expect(f.transport.acknowledge).toHaveBeenNthCalledWith(1, receipt)
  expect(f.transport.acknowledge).toHaveBeenNthCalledWith(2, receipt)
  expect(f.accepted.size).toBe(1)
  expect(f.durable.get(key(receipt))).toEqual({ state: 'released', ack: 'acknowledged', receipt })
  expect(f.slotCount()).toBe(0)
})

it('discovers committed release after losing both the submission reply and the first independent read', async () => {
  const receipt = original('allocation-1')
  const f = fixture(receipt)
  const firstApp = f.open()
  const actualRead = f.storage.read
  f.failure.loseReleaseReply = true
  f.storage.read = async () => { throw new Error('read connection lost') }
  await expect(firstApp.persistRelease(receipt, receipt)).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.transport.acknowledge).not.toHaveBeenCalled()
  f.storage.read = actualRead
  const restartedApp = f.open()
  const pending = await restartedApp.pending()
  expect(pending).toHaveLength(1)
  await expect(restartedApp.acknowledge(pending[0]!)).resolves.toBe('acknowledged')
  expect(f.transport.acknowledge).toHaveBeenCalledOnce()
})

it('rejects receipts from another allocation, epoch, original container or provider generation', async () => {
  const receipt = original('allocation-1')
  const f = fixture(receipt)
  const app = f.open()
  for (const wrong of [
    original('allocation-2'),
    { ...receipt, epoch: '2' as AllocationScope['epoch'] },
    { ...receipt, containerId: 'e'.repeat(64) },
    { ...receipt, providerGeneration: 'f'.repeat(64) },
    { ...receipt, policyDigest: '1'.repeat(64) },
    { ...receipt, receiptDigest: `${receipt.receiptDigest}\n` },
  ]) {
    await expect(app.persistRelease(receipt, wrong)).rejects.toMatchObject({ code: 'invalid-evidence' })
  }
  expect(f.storage.release).not.toHaveBeenCalled()
  expect(f.transport.acknowledge).not.toHaveBeenCalled()
})

it('rejects a different digest for the same original allocation and verifies the durable scope before transport', async () => {
  const first = original('allocation-1'), second = original('allocation-2')
  const f = fixture(first, second)
  const app = f.open()
  await app.persistRelease(first, first)
  await expect(app.persistRelease(first, { ...first, receiptDigest: 'e'.repeat(64) }))
    .rejects.toMatchObject({ code: 'conflict' })
  expect(f.durable.get(key(first))?.receipt).toEqual(first)
  f.storage.read = async () => f.durable.get(key(first))
  await expect(app.acknowledge(second)).rejects.toMatchObject({ code: 'conflict' })
  expect(f.transport.acknowledge).not.toHaveBeenCalled()
})

it('preserves the pending slot when the provider confirms the wrong receipt or the local mark never commits', async () => {
  const receipt = original('allocation-1')
  const f = fixture(receipt)
  const app = f.open()
  await app.persistRelease(receipt, receipt)
  const actualAcknowledge = f.transport.acknowledge
  const wrongResults = [original('allocation-2'), { ...receipt, providerGeneration: 'f'.repeat(64) },
    { ...receipt, receiptDigest: 'e'.repeat(64) }]
  for (const result of wrongResults) {
    f.transport.acknowledge = async () => result
    await expect(app.acknowledge(receipt)).rejects.toMatchObject({ code: 'ack-unconfirmed' })
  }
  expect(f.storage.markAcknowledged).not.toHaveBeenCalled()
  f.transport.acknowledge = actualAcknowledge
  f.failure.failBeforeMark = true
  await expect(app.acknowledge(receipt)).rejects.toMatchObject({ code: 'ack-unconfirmed' })
  expect(f.slotCount()).toBe(1)
  expect(f.durable.get(key(receipt))?.receipt).toEqual(receipt)
})

it('serializes capacity in the durable adapter across processes and reuses only acknowledged slots', async () => {
  const first = original('allocation-1'), second = original('allocation-2')
  const f = fixture(first, second)
  const app = f.open(1), otherProcess = f.open(1)
  const outcomes = await Promise.allSettled([app.persistRelease(first, first), otherProcess.persistRelease(second, second)])
  expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { ack: 'pending' } })
  expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'capacity' } })
  expect(f.awaitingStop.has(key(second))).toBe(true)
  expect(await otherProcess.pending()).toHaveLength(1)
  await expect(otherProcess.acknowledge(second)).resolves.toBe('missing')
  await expect(otherProcess.acknowledge(first)).resolves.toBe('acknowledged')
  await expect(app.persistRelease(second, second)).resolves.toMatchObject({ ack: 'pending' })
  expect(f.durable.get(key(first))?.receipt).toEqual(first)
})

it('enforces the 128 limit at admission and rejects oversize or duplicate pending results', async () => {
  const one = original('allocation-1'), two = original('allocation-2')
  const f = fixture(one, two)
  expect(() => f.open(129)).toThrow(expect.objectContaining({ code: 'capacity' }))
  f.storage.pending = async () => [one, two]
  await expect(f.open(1).pending()).rejects.toMatchObject({ code: 'capacity' })
  f.storage.pending = async () => [one, one]
  await expect(f.open(2).pending()).rejects.toMatchObject({ code: 'conflict' })
  expect(f.transport.acknowledge).not.toHaveBeenCalled()
})

it('backpressures the one hundred twenty-ninth pending receipt and makes room after a verified ACK', async () => {
  const receipts = Array.from({ length: 129 }, (_, index) => original(`allocation-${index + 1}`))
  const f = fixture(...receipts)
  const app = f.open(128)
  for (const receipt of receipts.slice(0, 128)) await app.persistRelease(receipt, receipt)
  const blocked = receipts[128]!
  await expect(app.persistRelease(blocked, blocked)).rejects.toMatchObject({ code: 'capacity' })
  expect(f.awaitingStop.has(key(blocked))).toBe(true)
  const pending = await app.pending()
  expect(pending).toHaveLength(128)
  await expect(app.acknowledge(pending[0]!)).resolves.toBe('acknowledged')
  await expect(app.persistRelease(blocked, blocked)).resolves.toMatchObject({ ack: 'pending' })
  expect(f.slotCount()).toBe(128)
  expect(f.durable.size).toBe(129)
})
