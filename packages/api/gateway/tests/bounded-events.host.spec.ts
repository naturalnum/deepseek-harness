/** Real Gateway event clients with deliberately stalled native readers and original registration teardown. */
import { Context } from '@deepseek-ai/cordis'
import Typert from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { expect, it, onTestFinished } from 'vitest'
import Gateway, { type RemoteEventQueueLimits, type TypertRemoteEventFrame } from '../src/index.ts'
import { ownerPeer } from './peer.ts'
import type { TypertGateway } from '../src/types.ts'

const limits = { maxQueuedEvents: 2, maxQueuedBytes: 1024, maxFrameBytes: 512 }

async function fixture(budget?: RemoteEventQueueLimits) {
  const ctx = new Context()
  await ctx.plugin(Typert); await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway)
  const gateway: TypertGateway = ctx.typertGateway
  const readers: AsyncIterator<unknown>[] = []
  const pending: { frame: TypertRemoteEventFrame; handled: () => void }[] = []
  let wake: (() => void) | undefined, sourceReturned = false
  const remove = gateway.registerRemoteEvents(signal => (async function *() {
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        const item = pending.shift()
        if (item === undefined) { await new Promise<void>((resolve) => { wake = resolve }); wake = undefined; continue }
        try { yield item.frame } finally { item.handled() }
      }
    } finally { sourceReturned = true; signal.removeEventListener('abort', abort) }
  })(), { home: '/event-component' }, budget)
  onTestFinished(async () => {
    try { for (const reader of readers) await reader.return?.(); await remove() }
    finally { await ctx.fiber.dispose() }
  })
  const open = async () => {
    const stream = await gateway.wireStream.open('$events', { args: {} }, (async function *() { yield* [] })(),
      ownerPeer(ctx), new AbortController().signal)
    const reader = stream[Symbol.asyncIterator]()
    readers.push(reader)
    return reader
  }
  const emit = async (value: string | number) => {
    const handled = Promise.withResolvers<undefined>()
    pending.push({ frame: { event: 'tick', args: [value] }, handled: () => { handled.resolve(undefined) } })
    wake?.()
    await handled.promise
  }
  return { ctx, gateway, open, emit, remove, sourceReturned: () => sourceReturned }
}

it('fails only a stalled client at its item limit and retains healthy native clients and the source', async () => {
  const f = await fixture(limits), slow = await f.open(), healthy = await f.open()
  await slow.next(); await healthy.next()
  for (const value of [1, 2, 3]) {
    await f.emit(value)
    await expect(healthy.next()).resolves.toMatchObject({ value: { type: 'emit', event: 'tick', args: [value] } })
  }
  await expect(slow.next()).rejects.toThrow('queued-event limit')
  await expect(slow.return?.()).resolves.toMatchObject({ done: true })
  expect(f.gateway.hasLiveClient()).toBe(true)
  await f.emit(4)
  await expect(healthy.next()).resolves.toMatchObject({ value: { args: [4] } })
  expect(f.sourceReturned()).toBe(false)
  await healthy.return?.()
  expect(f.gateway.hasLiveClient()).toBe(false)
  await f.remove()
  expect(f.sourceReturned()).toBe(true)
})

it('charges complete event bytes before enqueue and returns resident capacity when native frames leave the queue', async () => {
  const bytes = Buffer.byteLength(JSON.stringify({ type: 'emit', event: 'tick', args: [1] }))
  const f = await fixture({ ...limits, maxQueuedBytes: bytes }), reader = await f.open()
  await reader.next()
  await f.emit(1)
  await expect(reader.next()).resolves.toMatchObject({ value: { args: [1] } })
  await f.emit(2)
  await expect(reader.next()).resolves.toMatchObject({ value: { args: [2] } })
  await f.emit(3); await f.emit(4)
  await expect(reader.next()).rejects.toThrow('resident-byte limit')
  expect(f.gateway.hasLiveClient()).toBe(false)
})

it('fails pending native reads on oversized complete frames while leaving the original source available', async () => {
  const f = await fixture({ ...limits, maxFrameBytes: 128 }), reader = await f.open()
  await reader.next()
  const reading = reader.next(), rejected = expect(reading).rejects.toThrow('frame exceeds')
  await f.emit('x'.repeat(256))
  await rejected
  const later = await f.open()
  await expect(later.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  await f.emit(1)
  await expect(later.next()).resolves.toMatchObject({ value: { args: [1] } })
})

it('checks complete ready frame bytes before adding a native client', async () => {
  const f = await fixture({ ...limits, maxFrameBytes: 1 }), reader = await f.open()
  await expect(reader.next()).rejects.toThrow('frame exceeds')
  expect(f.gateway.hasLiveClient()).toBe(false)
})

it('preserves omitted-budget native buffering and drains every original frame in order', async () => {
  const f = await fixture(), reader = await f.open()
  await reader.next()
  for (let value = 0; value < 8; value++) await f.emit(value)
  for (let value = 0; value < 8; value++) {
    await expect(reader.next()).resolves.toMatchObject({ value: { type: 'emit', args: [value] } })
  }
})

it('rejects incomplete or non-finite budgets before invoking a source factory', async () => {
  const f = await fixture()
  await f.remove()
  let starts = 0
  const source = () => { starts++; return (async function *() { yield* [] })() }
  for (const key of ['maxQueuedEvents', 'maxQueuedBytes', 'maxFrameBytes']) {
    const absent = { ...limits }
    Reflect.deleteProperty(absent, key)
    expect(() => f.gateway.registerRemoteEvents(source, { home: '/event-component' }, absent)).toThrow()
    for (const value of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => f.gateway.registerRemoteEvents(source, { home: '/event-component' }, { ...limits, [key]: value })).toThrow()
    }
  }
  expect(starts).toBe(0)
})

it('retains the actual source cleanup failure after joining registration withdrawal', async () => {
  const ctx = new Context()
  await ctx.plugin(Typert); await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway)
  const failure = new Error('Actual source cleanup failed'), entered = Promise.withResolvers<undefined>()
  let finalized = 0
  const remove = ctx.typertGateway.registerRemoteEvents(signal => (async function *() {
    try {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      yield* []
    } finally { finalized++; throw failure }
  })(), { home: '/event-component' }, limits)
  onTestFinished(async () => { await expect(remove()).rejects.toBe(failure); await ctx.fiber.dispose() })
  await entered.promise
  await expect(remove()).rejects.toBe(failure)
  await expect(remove()).rejects.toBe(failure)
  expect(finalized).toBe(1)
})

it('admits the exact complete UTF-8 frame limit and refuses the next byte without truncating payloads', async () => {
  const value = '中"\\\n'.repeat(32)
  const bytes = Buffer.byteLength(JSON.stringify({ type: 'emit', event: 'tick', args: [value] }))
  const f = await fixture({ ...limits, maxFrameBytes: bytes, maxQueuedBytes: bytes * 2 }), reader = await f.open()
  await reader.next()
  await f.emit(value)
  await expect(reader.next()).resolves.toMatchObject({ value: { type: 'emit', args: [value] } })
  await f.emit(value + 'a')
  await expect(reader.next()).rejects.toThrow('frame exceeds')
})

it('recognizes original native source cancellation while retaining real cleanup failures separately', async () => {
  const ctx = new Context()
  await ctx.plugin(Typert); await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway)
  const entered = Promise.withResolvers<undefined>()
  const remove = ctx.typertGateway.registerRemoteEvents(signal => (async function *() {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    signal.throwIfAborted()
    yield* []
  })(), { home: '/event-component' }, limits)
  onTestFinished(async () => { await remove(); await ctx.fiber.dispose() })
  await entered.promise
  await expect(remove()).resolves.toBeUndefined()
})
