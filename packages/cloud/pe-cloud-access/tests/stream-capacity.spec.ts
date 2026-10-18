/** Counter scopes are opaque test objects; these cases issue no authentication, Peer or account-ready fixture. */
import { describe, expect, it, vi } from 'vitest'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { StreamCapacity } from '../src/stream-capacity.ts'

const a = 'account-a' as AccountId, b = 'account-b' as AccountId
const id = 'stream-capacity-test' as Branded<'pe-request-id'>

describe('actual logical-stream reservations', () => {
  it('enforces Peer, account and global limits and releases only actual confirmed slots', () => {
    const capacity = new StreamCapacity({ maxLogicalStreams: 3, maxLogicalStreamsPerAccount: 2, maxLogicalStreamsPerPeer: 1 })
    const p = {}, q = {}, r = {}, s = {}
    const settle = capacity.acquire(a, p, id, () => {})
    expect(() => capacity.acquire(a, p, id, () => {})).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
    const settle2 = capacity.acquire(a, q, id, () => {})
    expect(() => capacity.acquire(a, r, id, () => {})).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
    const settle3 = capacity.acquire(b, r, id, () => {})
    expect(() => capacity.acquire(b, s, id, () => {})).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
    expect(capacity.pending).toBe(3)
    settle('confirmed')
    settle('confirmed')
    expect(capacity.pending).toBe(2)
    const settle4 = capacity.acquire(a, p, id, () => {})
    for (const done of [settle2, settle3, settle4]) done('confirmed')
    expect(capacity.pending).toBe(0)
  })

  it('retains an unknown slot, closes that owner and does not turn a later duplicate confirmation into release', () => {
    const capacity = new StreamCapacity({ maxLogicalStreams: 2, maxLogicalStreamsPerAccount: 2, maxLogicalStreamsPerPeer: 2 })
    const peer = {}
    const unknown = vi.fn()
    const settle = capacity.acquire(a, peer, id, unknown)
    settle('unknown')
    settle('confirmed')
    expect(unknown).toHaveBeenCalledTimes(1)
    expect(capacity.pending).toBe(1)
    expect(() => capacity.acquire(a, peer, id, unknown)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    capacity.close()
    expect(() => capacity.acquire(b, {}, id, unknown)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    expect(capacity.pending).toBe(1)
  })
})
