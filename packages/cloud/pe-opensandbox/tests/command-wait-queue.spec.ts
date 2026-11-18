import { afterEach, expect, it, vi } from 'vitest'
import { CommandWaitQueue, type CommandAdmission, type CommandWaitOwner } from '../src/command-wait-queue.ts'

function owner(accountId: string, sessionId = 'session') {
  const controller = new AbortController()
  const current = vi.fn(() => {})
  const authority: CommandWaitOwner = { accountId, sessionId, lifetime: controller.signal, assertCurrent: current }
  return { authority, controller, current }
}

function fixture(global = 1, perAccount = 1, maxRecords = 8) {
  const queue = new CommandWaitQueue<string>({ maxWaiting: 4, maxWaitingPerAccount: 2, maxRecords, timeoutMs: 50 })
  const active = new Map<string, string>()
  const proposed: string[] = []
  const started: string[] = []
  const releasedUnstarted: string[] = []
  const observedDirect: string[] = []
  const attempt = (target: CommandWaitOwner, label: string, reserved?: () => void, startFailure?: Error) =>
    (): CommandAdmission<string> => {
      proposed.push(label)
      if (active.size >= global || [...active.values()].filter(account => account === target.accountId).length >= perAccount) {
        return { kind: 'busy' }
      }
      if (active.has(label)) throw new Error('duplicate original reservation')
      active.set(label, target.accountId)
      reserved?.()
      return { kind: 'reserved', start: () => {
        started.push(label)
        if (startFailure !== undefined) throw startFailure
        return label
      }, releaseUnstarted: () => {
        releasedUnstarted.push(label)
        active.delete(label)
        queue.capacityReleased()
      } }
    }
  const release = (label: string): void => {
    expect(active.delete(label)).toBe(true)
    queue.capacityReleased()
  }
  const directDone = (label: string): void => {
    expect(active.has(label)).toBe(true)
    observedDirect.push(label)
  }
  return { queue, active, proposed, started, releasedUnstarted, observedDirect, attempt, directDone, release }
}

function tracked<T>(value: ReturnType<CommandWaitQueue<T>['submit']>) {
  if (value.kind !== 'tracked') throw new Error(`Expected an accepted wait ticket, got ${value.reason}.`)
  return value.ticket
}

afterEach(() => { vi.useRealTimers() })

it('starts the first eligible waiter only after the original reservation actually releases', async () => {
  const f = fixture()
  const a = owner('A').authority, b = owner('B').authority, c = owner('C').authority
  const first = tracked(f.queue.submit(a, 'first', f.attempt(a, 'A')))
  const second = tracked(f.queue.submit(b, 'second', f.attempt(b, 'B')))
  const third = tracked(f.queue.submit(c, 'third', f.attempt(c, 'C')))
  await expect(first.done).resolves.toEqual({ state: 'admitted', command: 'A' })
  expect(f.queue.state(b, 'second')).toBe('waiting')
  expect(f.queue.state(c, 'third')).toBe('waiting')
  f.directDone('A')
  expect(f.observedDirect).toEqual(['A'])
  expect(f.active.has('A')).toBe(true)
  expect(f.started).toEqual(['A'])
  f.release('A')
  await expect(second.done).resolves.toEqual({ state: 'admitted', command: 'B' })
  expect(f.started).toEqual(['A', 'B'])
  expect(f.queue.state(c, 'third')).toBe('waiting')
  f.release('B')
  await expect(third.done).resolves.toEqual({ state: 'admitted', command: 'C' })
  expect(f.started).toEqual(['A', 'B', 'C'])
})

it('cancels the waiting job without resubmission, reservation or startup, then advances the next key', async () => {
  const f = fixture()
  const a = owner('A').authority, b = owner('B').authority, c = owner('C').authority
  f.queue.submit(a, 'first', f.attempt(a, 'A'))
  const cancelled = tracked(f.queue.submit(b, 'second', f.attempt(b, 'B')))
  const third = tracked(f.queue.submit(c, 'third', f.attempt(c, 'C')))
  expect(f.queue.cancel(b, 'second')).toBe('cancelled')
  const replacement = vi.fn(f.attempt(b, 'dup-B'))
  expect(tracked(f.queue.submit(b, 'second', replacement))).toBe(cancelled)
  await expect(cancelled.done).resolves.toEqual({ state: 'cancelled' })
  const before = f.proposed.filter(label => label === 'B').length
  f.release('A')
  await expect(third.done).resolves.toEqual({ state: 'admitted', command: 'C' })
  expect(f.proposed.filter(label => label === 'B')).toHaveLength(before)
  expect(f.active.has('B')).toBe(false)
  expect(f.started).toEqual(['A', 'C'])
  expect(replacement).not.toHaveBeenCalled()
})

it('keeps the original waiter and command on duplicate submission, before and after admission', async () => {
  const f = fixture()
  const a = owner('A').authority, b = owner('B').authority
  f.queue.submit(a, 'first', f.attempt(a, 'A'))
  const original = tracked(f.queue.submit(b, 'stable', f.attempt(b, 'B')))
  const replacement = vi.fn(f.attempt(b, 'replayed-B'))
  expect(tracked(f.queue.submit(b, 'stable', replacement))).toBe(original)
  expect(original.retire()).toBe(false)
  f.release('A')
  await expect(original.done).resolves.toEqual({ state: 'admitted', command: 'B' })
  expect(tracked(f.queue.submit(b, 'stable', replacement))).toBe(original)
  expect(replacement).not.toHaveBeenCalled()
  expect(f.started).toEqual(['A', 'B'])
})

it('isolates status and cancel by current account, Session and owner generation', () => {
  const f = fixture()
  const a = owner('A').authority, b = owner('B').authority
  f.queue.submit(a, 'first', f.attempt(a, 'A'))
  f.queue.submit(b, 'stable', f.attempt(b, 'B'))
  const otherSession = owner('B', 'another-session').authority
  const newerGeneration = owner('B').authority
  for (const outsider of [a, otherSession, newerGeneration]) {
    expect(f.queue.state(outsider, 'stable')).toBeUndefined()
    expect(f.queue.cancel(outsider, 'stable')).toBeUndefined()
  }
  expect(f.queue.submit(newerGeneration, 'stable', f.attempt(newerGeneration, 'reuse'))).toEqual({
    kind: 'refused', reason: 'scope-conflict',
  })
  expect(f.queue.state(b, 'stable')).toBe('waiting')
  f.queue.close()
})

it('runs a newer eligible account when an older waiter is still blocked by its account cap', async () => {
  const f = fixture(2)
  const a = owner('A').authority, b = owner('B').authority, c = owner('C').authority
  f.queue.submit(a, 'original', f.attempt(a, 'A'))
  f.queue.submit(b, 'original', f.attempt(b, 'B'))
  const blocked = tracked(f.queue.submit(a, 'blocked', f.attempt(a, 'A-next')))
  const eligible = tracked(f.queue.submit(c, 'eligible', f.attempt(c, 'C')))
  f.release('B')
  await expect(eligible.done).resolves.toEqual({ state: 'admitted', command: 'C' })
  expect(f.queue.state(a, 'blocked')).toBe('waiting')
  f.release('A')
  await expect(blocked.done).resolves.toEqual({ state: 'admitted', command: 'A-next' })
})

it('withdraws a newly reserved slot when job cancellation arrives during the reservation call', async () => {
  const f = fixture()
  const a = owner('A').authority, b = owner('B').authority, c = owner('C').authority
  const cancel = new AbortController()
  f.queue.submit(a, 'first', f.attempt(a, 'A'))
  const aborted = tracked(f.queue.submit(b, 'second', f.attempt(b, 'B', () => { cancel.abort() }), cancel.signal))
  const next = tracked(f.queue.submit(c, 'third', f.attempt(c, 'C')))
  f.release('A')
  await expect(aborted.done).resolves.toEqual({ state: 'cancelled' })
  await expect(next.done).resolves.toEqual({ state: 'admitted', command: 'C' })
  expect(f.releasedUnstarted).toEqual(['B'])
  expect(f.started).toEqual(['A', 'C'])
})

it('routes cancellation after the handoff to the original job without releasing active work', async () => {
  const f = fixture()
  const a = owner('A').authority
  const ticket = tracked(f.queue.submit(a, 'first', f.attempt(a, 'A')))
  expect(f.queue.cancel(a, 'first')).toBe('admitted')
  await expect(ticket.done).resolves.toEqual({ state: 'admitted', command: 'A' })
  expect(f.active.has('A')).toBe(true)
  expect(f.releasedUnstarted).toEqual([])
})

it('refuses an invalidated waiter before reading another reservation', async () => {
  const f = fixture()
  const a = owner('A').authority, b = owner('B')
  f.queue.submit(a, 'first', f.attempt(a, 'A'))
  const ticket = tracked(f.queue.submit(b.authority, 'second', f.attempt(b.authority, 'B')))
  const stale = Error('original binding is stale')
  const before = f.proposed.filter(label => label === 'B').length
  b.current.mockImplementation(() => { throw stale })
  f.release('A')
  await expect(ticket.done).resolves.toEqual({ state: 'refused', cause: stale })
  expect(f.proposed.filter(label => label === 'B')).toHaveLength(before)
  expect(f.started).toEqual(['A'])
})

it('withdraws a reserved slot when authority expires during reservation', async () => {
  const f = fixture()
  const a = owner('A')
  const stale = Error('original binding is stale')
  const ticket = tracked(f.queue.submit(a.authority, 'first',
    f.attempt(a.authority, 'A', () => { a.current.mockImplementation(() => { throw stale }) })))
  await expect(ticket.done).resolves.toEqual({ state: 'refused', cause: stale })
  expect(f.releasedUnstarted).toEqual(['A'])
  expect(f.started).toEqual([])
})

it('expires a waiter at the original deadline even when no slot releases', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const f = fixture()
  const a = owner('A').authority, b = owner('B').authority
  f.queue.submit(a, 'holder', f.attempt(a, 'A'))
  const ticket = tracked(f.queue.submit(b, 'second', f.attempt(b, 'B')))
  vi.advanceTimersByTime(49)
  expect(tracked(f.queue.submit(b, 'second', f.attempt(b, 'replacement')))).toBe(ticket)
  expect(f.queue.state(b, 'second')).toBe('waiting')
  vi.advanceTimersByTime(1)
  await expect(ticket.done).resolves.toEqual({ state: 'expired' })
  f.release('A')
  expect(f.started).toEqual(['A'])
})

it('keeps unclassified admission failures out of the waiting state', async () => {
  const f = fixture()
  const a = owner('A').authority
  const failure = Error('permanent refusal')
  const refuse = vi.fn(() => { throw failure })
  const ticket = tracked(f.queue.submit(a, 'first', refuse))
  expect(f.queue.state(a, 'first')).toBe('refused')
  await expect(ticket.done).resolves.toEqual({ state: 'refused', cause: failure })
  f.queue.capacityReleased()
  expect(refuse).toHaveBeenCalledTimes(1)
})

it('withdraws a reservation if the deadline passes before the timed callback can run', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const f = fixture()
  const a = owner('A').authority
  const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    const ticket = tracked(f.queue.submit(a, 'first', f.attempt(a, 'A', () => { elapsed.mockReturnValue(50) })))
    await expect(ticket.done).resolves.toEqual({ state: 'expired' })
    expect(f.releasedUnstarted).toEqual(['A'])
    expect(f.started).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  } finally { elapsed.mockRestore() }
})

it('retains an unknown handoff with the real owner and never retries it', async () => {
  const f = fixture()
  const a = owner('A').authority, b = owner('B').authority
  const failure = Error('start became unknown')
  const ticket = tracked(f.queue.submit(a, 'unknown', f.attempt(a, 'A', undefined, failure)))
  await expect(ticket.done).resolves.toEqual({ state: 'uncertain', cause: failure })
  expect(f.queue.cancel(a, 'unknown')).toBe('uncertain')
  expect(tracked(f.queue.submit(a, 'unknown', f.attempt(a, 'duplicate')))).toBe(ticket)
  f.queue.submit(b, 'second', f.attempt(b, 'B'))
  f.queue.capacityReleased()
  expect(f.queue.state(b, 'second')).toBe('waiting')
  expect(f.active.has('A')).toBe(true)
  expect(f.started).toEqual(['A'])
  f.queue.close()
})

it('bounds account waiters and retry records independently and only retires by original ticket', async () => {
  const f = fixture(1, 1, 4)
  const a = owner('A').authority, b = owner('B').authority, c = owner('C').authority
  const hold = tracked(f.queue.submit(a, 'first', f.attempt(a, 'A')))
  const b1 = tracked(f.queue.submit(b, 'first', f.attempt(b, 'B-1')))
  f.queue.submit(b, 'second', f.attempt(b, 'B-2'))
  expect(f.queue.submit(b, 'third', f.attempt(b, 'B-3'))).toEqual({ kind: 'refused', reason: 'capacity' })
  expect(f.queue.state(b, 'third')).toBeUndefined()
  f.queue.submit(c, 'first', f.attempt(c, 'C-1'))
  f.queue.cancel(b, 'first')
  expect(f.queue.submit(c, 'second', f.attempt(c, 'C-2'))).toEqual({ kind: 'refused', reason: 'capacity' })
  expect(b1.retire()).toBe(true)
  expect(b1.retire()).toBe(false)
  expect(f.queue.submit(c, 'second', f.attempt(c, 'C-2')).kind).toBe('tracked')
  f.queue.close()
  await expect(hold.done).resolves.toEqual({ state: 'admitted', command: 'A' })
  expect(f.active.has('A')).toBe(true)
})

it('cancels pending authority revocation and closes waiting without touching the admitted work', async () => {
  const f = fixture()
  const a = owner('A').authority, b = owner('B'), c = owner('C').authority
  f.queue.submit(a, 'first', f.attempt(a, 'A'))
  const revoked = tracked(f.queue.submit(b.authority, 'second', f.attempt(b.authority, 'B')))
  const closed = tracked(f.queue.submit(c, 'third', f.attempt(c, 'C')))
  b.controller.abort()
  await expect(revoked.done).resolves.toEqual({ state: 'cancelled' })
  f.queue.close()
  await expect(closed.done).resolves.toEqual({ state: 'cancelled' })
  expect(f.queue.submit(c, 'new', f.attempt(c, 'new'))).toEqual({ kind: 'refused', reason: 'closed' })
  expect(f.active.has('A')).toBe(true)
  expect(f.started).toEqual(['A'])
})

it('does not retain or try a request when the global waiting bound is full', () => {
  const f = fixture()
  const a = owner('A').authority
  f.queue.submit(a, 'holder', f.attempt(a, 'A'))
  for (const id of ['B', 'C', 'D', 'E']) {
    const authority = owner(id).authority
    expect(f.queue.submit(authority, 'same-key', f.attempt(authority, id)).kind).toBe('tracked')
  }
  const last = owner('F').authority
  const denied = vi.fn(f.attempt(last, 'F'))
  expect(f.queue.submit(last, 'same-key', denied)).toEqual({ kind: 'refused', reason: 'capacity' })
  expect(denied).not.toHaveBeenCalled()
  expect(f.queue.state(last, 'same-key')).toBeUndefined()
  f.queue.close()
})
