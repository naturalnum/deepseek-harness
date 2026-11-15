/** Native paging through the original Gateway stream; native FD coverage stays in linux-content-interop. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SessionStore from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { FsDirectoryVersion, FsError, FsVersion, type FsDirectoryEnumeration } from '@deepseek-ai/dsh-fs'
import type { WorkspaceDirectoryControl, WorkspaceDirectoryFrame } from '../src/types.ts'
import { openWorkspace, type Harness } from './harness.ts'

let harness: Harness
const cleanups: Array<() => Promise<unknown>> = []
beforeEach(async () => {
  harness = await openWorkspace('workspace-directory-pages-')
  await harness.ctx.plugin(SessionStore)
  await harness.ctx.plugin(TypertRegistry)
  await harness.ctx.plugin(RemoteAccess)
  await harness.ctx.plugin(TypertGateway)
  harness.endpoint({ maxEntries: 64 })
  harness.ctx.sessions.create(harness.scope.sessionId, { meta: { cwd: harness.workspace } })
})
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close() }
  finally { await harness.ctx.fiber.dispose(); await harness.dispose() }
})

/** Return wakes the pending input read, just as the original Gateway decoder does. */
function controls() {
  const queue: WorkspaceDirectoryControl[] = []
  let pending: ReturnType<typeof Promise.withResolvers<IteratorResult<WorkspaceDirectoryControl>>> | undefined
  let done = false
  const iterator: AsyncIterator<WorkspaceDirectoryControl> = {
    next: () => {
      const value = queue.shift()
      if (value !== undefined) return Promise.resolve({ value, done: false })
      if (done) return Promise.resolve({ value: undefined, done: true })
      pending = Promise.withResolvers<IteratorResult<WorkspaceDirectoryControl>>()
      return pending.promise
    },
    return: async () => { done = true; pending?.resolve({ value: undefined, done: true }); return { value: undefined, done: true } },
  }
  return { source: { [Symbol.asyncIterator]: () => iterator }, send: (value: WorkspaceDirectoryControl) => {
    if (pending !== undefined) { pending.resolve({ value, done: false }); pending = undefined }
    else queue.push(value)
  }, end: () => iterator.return?.() }
}

async function open(count: number) {
  const input = controls(), controller = new AbortController()
  const target = await harness.ctx.fs.resolve(harness.workspace)
  const version = FsDirectoryVersion('1:2:3:4:5:6:7'), ended = Promise.withResolvers<undefined>()
  void ended.promise.catch(() => {})
  const closeGate = Promise.withResolvers<undefined>(), closeEntered = Promise.withResolvers<undefined>()
  closeGate.resolve(undefined)
  let gate = closeGate.promise, current = true, offset = 0, closing: Promise<void> | undefined
  const assertCurrent = vi.fn(() => { if (!current) throw new FsError('Directory changed.', 'FS_STALE_VERSION') })
  const close = vi.fn(() => closing ??= (async () => { closeEntered.resolve(undefined); await gate })())
  const next = vi.fn<FsDirectoryEnumeration['next']>(async () => {
    assertCurrent()
    const stop = Math.min(count, offset + 64)
    const entries = Array.from({ length: stop - offset }, (_, index) => ({ name: `item-${String(offset + index).padStart(3, '0')}`,
      target, version: FsVersion('entry'), type: 'file' as const, size: 1 }))
    offset = stop
    if (offset === count) { await close(); ended.resolve(undefined); return { entries, version, eof: true, closed: true } }
    return { entries, version, eof: false, closed: false }
  })
  const provider = vi.spyOn(harness.ctx.fs, 'openDirectory').mockResolvedValue({ version, maxReplyBytes: 65536,
    ended: ended.promise, assertCurrent, next, close })
  const list = vi.spyOn(harness.ctx.fs, 'listDirectory')
  const peer = new Peer(harness.ctx, { principal: { kind: 'owner' } })
  const result = await harness.ctx.typertGateway.stream({ peer, namespace: 'workspaceFiles', method: 'listPages',
    args: { workspaceFileScopeId: harness.scope.sessionId, path: '.' }, signal: controller.signal, uplink: input.source })
  const stream = result[Symbol.asyncIterator]()
  cleanups.push(async () => { controller.abort(); await input.end(); await stream.return?.(); provider.mockRestore(); list.mockRestore() })
  const frame = async (): Promise<WorkspaceDirectoryFrame> => {
    const item = await stream.next()
    if (item.done) throw new Error('Expected a Native directory frame')
    return item.value as WorkspaceDirectoryFrame
  }
  const ready = await frame()
  if (ready.kind !== 'ready') throw new Error('Expected ready')
  return { input, stream, frame, ready, next, close, provider, list, controller, closeEntered,
    holdClose: () => { const held = Promise.withResolvers<undefined>(); gate = held.promise; return held },
    endNormally: () => { ended.resolve(undefined) },
    change: () => { current = false }, failIdle: (code: 'FS_ABORTED' | 'FS_TOO_LARGE' | 'FS_PERMISSION_DENIED' = 'FS_ABORTED') => {
      ended.reject(new FsError('Original directory enumeration stopped.', code))
    } }
}

it.each([0, 63, 64, 65, 128, 129])('delivers all %i entries under original credits with EOF only after actual closure', async (count) => {
  const h = await open(count)
  expect(h.next).not.toHaveBeenCalled()
  expect(h.provider).toHaveBeenCalledWith(expect.anything(), 64, expect.any(AbortSignal))
  let cursor = h.ready.cursor
  const names: string[] = []
  while (true) {
    h.input.send({ kind: 'credit', version: h.ready.version, cursor })
    const page = await h.frame()
    if (page.kind !== 'page') throw new Error('Expected a page')
    expect(page.entries.length).toBeLessThanOrEqual(64)
    names.push(...page.entries.map(entry => entry.name))
    if (page.closed) { expect(h.close).toHaveBeenCalled(); expect(page.nextCursor).toBeNull(); break }
    expect(page.entries.length).toBeGreaterThan(0)
    cursor = page.nextCursor
  }
  expect(names).toHaveLength(count)
  expect(new Set(names).size).toBe(count)
  expect(h.next).toHaveBeenCalledTimes(Math.max(1, Math.ceil(count / 64)))
  expect(h.list).not.toHaveBeenCalled()
  await expect(h.stream.next()).resolves.toMatchObject({ done: true })
})

it('acknowledges explicit close only after the Provider has joined actual cleanup, without scanning', async () => {
  const h = await open(129), gate = h.holdClose()
  h.input.send({ kind: 'close', version: h.ready.version, cursor: h.ready.cursor })
  let delivered = false
  const closing = h.frame().then((value) => { delivered = true; return value })
  try {
    await h.closeEntered.promise
    expect(delivered).toBe(false); expect(h.next).not.toHaveBeenCalled()
    gate.resolve(undefined)
    await expect(closing).resolves.toEqual({ kind: 'closed', version: h.ready.version, closed: true })
    await expect(h.stream.next()).resolves.toMatchObject({ done: true })
  } finally { gate.resolve(undefined); await closing }
})

it('rejects a consumed cursor before a second native scan', async () => {
  const h = await open(129)
  const credit = { kind: 'credit' as const, version: h.ready.version, cursor: h.ready.cursor }
  h.input.send(credit); await h.frame()
  h.input.send(credit)
  await expect(h.stream.next()).rejects.toMatchObject({ code: 'gateway/bad-request' })
  expect(h.next).toHaveBeenCalledOnce(); expect(h.close).toHaveBeenCalled()
})

it('rechecks the same Provider identity after a pause before taking the next page', async () => {
  const h = await open(129)
  h.change()
  h.input.send({ kind: 'credit', version: h.ready.version, cursor: h.ready.cursor })
  await expect(h.stream.next()).rejects.toMatchObject({ code: 'workspace-file/directory-changed', details: { path: '.', closed: true } })
  expect(h.next).not.toHaveBeenCalled(); expect(h.close).toHaveBeenCalled()
})

it('wakes a no-credit wait on the Provider idle terminal and joins cleanup', async () => {
  const h = await open(129), waiting = h.stream.next()
  const failed = expect(waiting).rejects.toBeDefined()
  h.failIdle()
  await failed
  expect(h.next).not.toHaveBeenCalled(); expect(h.close).toHaveBeenCalled()
})

it('confirms a no-credit Provider completion only after the original close barrier settles', async () => {
  const h = await open(129), gate = h.holdClose()
  let delivered = false
  const waiting = h.stream.next()
  void waiting.then(() => { delivered = true }, () => { delivered = true })
  const failed = expect(waiting).rejects.toMatchObject({ code: 'workspace-file/directory-stopped',
    details: { path: '.', closed: true, reason: 'unavailable' } })
  h.endNormally()
  try {
    await h.closeEntered.promise
    expect(delivered).toBe(false)
    expect(h.next).not.toHaveBeenCalled()
    gate.resolve(undefined)
    await failed
    await expect(h.stream.next()).resolves.toMatchObject({ done: true })
  } finally { gate.resolve(undefined); await waiting.catch(() => undefined) }
})

it.each(['FS_IO_ERROR', 'FS_ABORTED'] as const)('retains an unconfirmed %s close after a no-credit Provider completion', async (code) => {
  const h = await open(129), failure = new FsError('Native closure remains unconfirmed.', code)
  h.close.mockRejectedValue(failure)
  const waiting = h.stream.next(), failed = expect(waiting).rejects.toBe(failure)
  h.endNormally()
  await failed
  expect(h.next).not.toHaveBeenCalled()
  expect(h.close).toHaveBeenCalled()
})

it('delivers the final EOF page when Provider completion occurs during its original pull', async () => {
  const h = await open(64), gate = h.holdClose()
  h.input.send({ kind: 'credit', version: h.ready.version, cursor: h.ready.cursor })
  let delivered = false
  const reading = h.frame().then((value) => { delivered = true; return value })
  try {
    await h.closeEntered.promise
    expect(delivered).toBe(false)
    gate.resolve(undefined)
    await expect(reading).resolves.toMatchObject({ kind: 'page', closed: true, nextCursor: null,
      entries: Array.from({ length: 64 }, (_, index) => ({ name: `item-${String(index).padStart(3, '0')}`, type: 'file', size: 1 })) })
    expect(h.next).toHaveBeenCalledOnce()
    await expect(h.stream.next()).resolves.toMatchObject({ done: true })
  } finally { gate.resolve(undefined); await reading }
})


it.each([
  ['FS_TOO_LARGE', 'too-large'],
  ['FS_PERMISSION_DENIED', 'unavailable'],
] as const)('returns a closed finite terminal after Provider %s while no credit is pending', async (code, reason) => {
  const h = await open(129), waiting = h.stream.next()
  const failed = expect(waiting).rejects.toMatchObject({ code: 'workspace-file/directory-stopped',
    details: { path: '.', closed: true, reason } })
  h.failIdle(code)
  await failed
  expect(h.next).not.toHaveBeenCalled()
  expect(h.close).toHaveBeenCalled()
})
