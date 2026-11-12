/** Finite bound-lane notification checks; never enters the pool's permanently retained unknown executor. */
import { afterEach, expect, it, vi } from 'vitest'
import { createMutationUnknownState } from '../src/worker-pool.ts'

afterEach(() => { vi.restoreAllMocks() })

it('fences before synchronously notifying the original owner once', () => {
  const notify = vi.fn(() => { expect(state.unknown).toBe(true) })
  const state = createMutationUnknownState(notify)
  expect(state.unknown).toBe(false)
  state.markUnknown(); state.markUnknown()
  expect(state.unknown).toBe(true); expect(notify).toHaveBeenCalledTimes(1)
})

it('contains a failed notification and its diagnostic without clearing the original write fence or retrying', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('public diagnostic fault') })
  const notify = vi.fn(() => { throw new Error('public notification fault') }), state = createMutationUnknownState(notify)
  expect(() => { state.markUnknown() }).not.toThrow()
  state.markUnknown()
  expect(state.unknown).toBe(true); expect(notify).toHaveBeenCalledTimes(1)
  expect(warning).toHaveBeenCalledExactlyOnceWith('Cloud file owner notification is unconfirmed: %j',
    { event: 'file-mutation-unknown' })
})

it('keeps two original lane fences independent when a notification reenters its own state', () => {
  const notifyA = vi.fn(() => { a.markUnknown() }), notifyB = vi.fn()
  const a = createMutationUnknownState(notifyA), b = createMutationUnknownState(notifyB)
  a.markUnknown()
  expect(a.unknown).toBe(true); expect(b.unknown).toBe(false)
  expect(notifyA).toHaveBeenCalledTimes(1); expect(notifyB).not.toHaveBeenCalled()
  b.markUnknown(); expect(notifyB).toHaveBeenCalledTimes(1)
})

it('retains component-only fencing without inventing an installed runtime owner', () => {
  const state = createMutationUnknownState()
  state.markUnknown(); state.markUnknown()
  expect(state.unknown).toBe(true)
})
