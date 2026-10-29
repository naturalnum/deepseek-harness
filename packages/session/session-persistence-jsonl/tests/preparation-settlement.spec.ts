import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const hooks = vi.hoisted(() => ({ path: '', openCalls: 0, blockOpen: 0, gatedOpenCloses: 0,
  openEntered: undefined as (() => void) | undefined, openRelease: undefined as Promise<unknown> | undefined,
  readCalls: 0, blockRead: 0, readFailure: undefined as Error | undefined,
  readEntered: undefined as (() => void) | undefined, readRelease: undefined as Promise<unknown> | undefined,
  closeCalls: 0, blockClose: 0, closeEntered: undefined as (() => void) | undefined,
  closeRelease: undefined as Promise<unknown> | undefined, closeFailure: undefined as Error | undefined,
  readdirPath: '', readdirEntered: undefined as (() => void) | undefined, readdirRelease: undefined as Promise<unknown> | undefined }))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, readdir: (async (...args: Parameters<typeof actual.readdir>) => {
    if (args[0] === hooks.readdirPath) { hooks.readdirEntered?.(); await hooks.readdirRelease }
    return actual.readdir(...args)
  }) as typeof actual.readdir, readFile: (async (...args: Parameters<typeof actual.readFile>) => {
    if (args[0] === hooks.path) {
      hooks.readCalls += 1
      if (hooks.readCalls === hooks.blockRead) { hooks.readEntered?.(); await hooks.readRelease }
    }
    return actual.readFile(...args)
  }) as typeof actual.readFile, open: (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (args[0] !== hooks.path || args[1] !== 'r') return handle
    hooks.openCalls += 1
    const gatedOpen = hooks.openCalls === hooks.blockOpen
    if (gatedOpen) { hooks.openEntered?.(); await hooks.openRelease }
    let isBody = false
    return new Proxy(handle, { get(target, property) {
      if (property === 'readFile') return async (...readArgs: Parameters<typeof target.readFile>) => {
        isBody = true; hooks.readCalls += 1
        if (hooks.readCalls === hooks.blockRead) { hooks.readEntered?.(); await hooks.readRelease }
        const result = await target.readFile(...readArgs)
        if (hooks.readFailure !== undefined) throw hooks.readFailure
        return result
      }
      if (property === 'close') return async () => {
        if (isBody) {
          hooks.closeCalls += 1
          if (hooks.closeCalls === hooks.blockClose) { hooks.closeEntered?.(); await hooks.closeRelease }
        }
        await target.close()
        if (gatedOpen) hooks.gatedOpenCloses += 1
        if ((isBody || gatedOpen) && hooks.closeFailure !== undefined) throw hooks.closeFailure
      }
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const bound: unknown = value.bind(target)
      return bound
    } })
  }) }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-preparation-settlement-')), ctx = new Context()
  const releases: Array<() => void> = []
  const fiber = await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const persistence = ctx.sessionPersistence, id = SessionId('historical-parent')
  const path = generationLogPath(root, '/work', id, 0, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ type: 'session', id, version: 0, createdAt: 1, cwd: '/work', delegationDepth: 0 }) + '\n')
  hooks.path = path
  onTestFinished(async () => {
    releases.forEach((release) => { release() })
    await fiber.dispose()
    Object.assign(hooks, { path: '', openCalls: 0, blockOpen: 0, gatedOpenCloses: 0, openEntered: undefined, openRelease: undefined, readCalls: 0, blockRead: 0, readFailure: undefined, readEntered: undefined, readRelease: undefined,
      closeCalls: 0, blockClose: 0, closeEntered: undefined, closeRelease: undefined, closeFailure: undefined })
    hooks.readdirPath = ''; hooks.readdirEntered = undefined; hooks.readdirRelease = undefined
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  const barrier = () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    releases.push(() => { release.resolve(undefined) })
    return { entered, release }
  }
  return { ctx, fiber, persistence, id, path, root, barrier }
}

it('joins an active open before it can create a preparation and stops new requests during teardown', async () => {
  const f = await fixture(), gate = f.barrier(), abort = new AbortController(), reason = new Error('cancel during discovery')
  hooks.readdirPath = f.root; hooks.readdirEntered = () => { gate.entered.resolve(undefined) }; hooks.readdirRelease = gate.release.promise
  const opening = f.persistence.open(f.id, 'read', { signal: abort.signal })
  void opening.catch(() => {})
  await gate.entered.promise
  let disposed = false
  const disposal = f.fiber.dispose().then(() => { disposed = true })
  const internal = f.persistence as unknown as { closing: boolean }
  await vi.waitFor(() => { expect(internal.closing).toBe(true) })
  expect(disposed).toBe(false)
  await expect(f.persistence.stat(f.id)).rejects.toThrow('session-persistence-jsonl is disposing')
  abort.abort(reason); gate.release.resolve(undefined)
  await expect(opening).rejects.toBe(reason)
  await disposal
  expect(disposed).toBe(true)
})

it('closes an acquired historical source without starting its body read after the last waiter cancels', async () => {
  const f = await fixture(), gate = f.barrier(), abort = new AbortController()
  hooks.blockOpen = 2; hooks.openEntered = () => { gate.entered.resolve(undefined) }; hooks.openRelease = gate.release.promise
  const opening = f.persistence.open(f.id, 'read', { signal: abort.signal }), reason = new Error('last waiter cancelled')
  void opening.catch(() => {})
  await gate.entered.promise
  abort.abort(reason)
  expect(f.persistence.isQuiescent(8)).toBe(false)
  gate.release.resolve(undefined)
  await expect(opening).rejects.toBe(reason)
  await vi.waitFor(() => { expect(f.persistence.isQuiescent(8)).toBe(true) })
  expect(hooks.readCalls).toBe(0)
  expect(hooks.gatedOpenCloses).toBe(1)
})

it('retains a close failure after cancellation before the historical body read', async () => {
  const f = await fixture(), gate = f.barrier(), abort = new AbortController()
  const failure = new Error('acquired source close failed')
  const reported = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => undefined)
  hooks.blockOpen = 2; hooks.openEntered = () => { gate.entered.resolve(undefined) }; hooks.openRelease = gate.release.promise
  hooks.closeFailure = failure
  const opening = f.persistence.open(f.id, 'read', { signal: abort.signal }), reason = new Error('last waiter cancelled')
  void opening.catch(() => {})
  await gate.entered.promise
  abort.abort(reason)
  gate.release.resolve(undefined)
  await expect(opening).rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure })
  await vi.waitFor(() => { expect(reported).toHaveBeenCalled() })
  expect(hooks.readCalls).toBe(0)
  expect(hooks.gatedOpenCloses).toBe(1)
  expect(f.persistence.isQuiescent(8)).toBe(false)
  await f.fiber.dispose()
  const logged = reported.mock.calls.map(call => call[0] as unknown)
  expect(logged).toContainEqual(expect.objectContaining({ name: 'JsonlReadCleanupError', cause: failure }))
  expect(logged).toContainEqual(expect.objectContaining({ name: 'AggregateError',
    errors: [expect.objectContaining({ name: 'JsonlReadCleanupError', cause: failure })] }))
})

it('joins the last cancelled waiter through the source close', async () => {
  const f = await fixture(), read = f.barrier(), close = f.barrier(), abort = new AbortController()
  hooks.blockRead = 1; hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise
  hooks.blockClose = 1; hooks.closeEntered = () => { close.entered.resolve(undefined) }; hooks.closeRelease = close.release.promise
  const reason = new Error('cancel'), opening = f.persistence.open(f.id, 'read', { signal: abort.signal })
  let settled = false
  void opening.then(() => { settled = true }, () => { settled = true })
  await read.entered.promise
  abort.abort(reason)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(settled).toBe(false)
  read.release.resolve(undefined)
  await close.entered.promise
  expect(settled).toBe(false)
  close.release.resolve(undefined)
  await expect(opening).rejects.toBe(reason)
  expect(f.persistence.isQuiescent(8)).toBe(true)
})

it('joins a cancelled waiter without aborting the other waiter', async () => {
  const f = await fixture(), gate = f.barrier(), abort = new AbortController(), reason = new Error('cancel one')
  hooks.blockRead = 1; hooks.readEntered = () => { gate.entered.resolve(undefined) }; hooks.readRelease = gate.release.promise
  const first = f.persistence.open(f.id, 'read', { signal: abort.signal }), second = f.persistence.open(f.id, 'read')
  let settled = false
  void first.then(() => { settled = true }, () => { settled = true }); void second.catch(() => {})
  await gate.entered.promise
  const internal = f.persistence as unknown as { migrationPreparations: Map<SessionId, { waiters: number }> }
  await expect.poll(() => internal.migrationPreparations.get(f.id)?.waiters).toBe(2)
  abort.abort(reason)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(settled).toBe(false)
  expect(internal.migrationPreparations.get(f.id)?.waiters).toBe(1)
  gate.release.resolve(undefined)
  await expect(first).rejects.toBe(reason)
  const handle = await second
  expect((await handle.read()).events).toEqual([])
  await handle.close()
  expect(hooks.readCalls).toBe(1)
})

it.each(['generic', 'errno'] as const)('preserves an independent %s read failure equal to the cancellation reason', async (kind) => {
  const f = await fixture(), gate = f.barrier(), abort = new AbortController()
  const failure = new Error('read and cancellation share a reason')
  if (kind === 'errno') Object.assign(failure, { code: 'ENOENT' })
  hooks.blockRead = 1; hooks.readEntered = () => { gate.entered.resolve(undefined) }; hooks.readRelease = gate.release.promise
  hooks.readFailure = failure
  const opening = f.persistence.open(f.id, 'read', { signal: abort.signal })
  void opening.catch(() => {})
  await gate.entered.promise
  abort.abort(failure); gate.release.resolve(undefined)
  await expect(opening).rejects.toMatchObject(kind === 'errno'
    ? { name: 'AggregateError', errors: [failure], cause: failure }
    : { name: 'SessionPersistenceCorruptionError', cause: failure })
})

it('keeps the same preparation for another waiter after cancellation', async () => {
  const f = await fixture(), gate = f.barrier(), abort = new AbortController(), reason = new Error('one waiter cancelled')
  hooks.blockRead = 1; hooks.readEntered = () => { gate.entered.resolve(undefined) }; hooks.readRelease = gate.release.promise
  const first = f.persistence.open(f.id, 'read', { signal: abort.signal })
  const second = f.persistence.open(f.id, 'read')
  void first.catch(() => {}); void second.catch(() => {})
  await gate.entered.promise
  const internal = f.persistence as unknown as { migrationPreparations: Map<SessionId, { waiters: number }> }
  await expect.poll(() => internal.migrationPreparations.get(f.id)?.waiters).toBe(2)
  abort.abort(reason)
  expect(f.persistence.isQuiescent(8)).toBe(false)
  gate.release.resolve(undefined)
  await expect(first).rejects.toBe(reason)
  const handle = await second
  expect((await handle.read()).events).toEqual([])
  await handle.close()
  expect(hooks.readCalls).toBe(1)
  expect(f.persistence.isQuiescent(8)).toBe(true)
})

it('tracks the last cancelled waiter until actual handle close and dispose settle', async () => {
  const f = await fixture(), read = f.barrier(), close = f.barrier(), abort = new AbortController()
  hooks.blockRead = 1; hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise
  hooks.blockClose = 1; hooks.closeEntered = () => { close.entered.resolve(undefined) }; hooks.closeRelease = close.release.promise
  const opening = f.persistence.open(f.id, 'read', { signal: abort.signal }), reason = new Error('last waiter cancelled')
  void opening.catch(() => {})
  await read.entered.promise
  abort.abort(reason)
  expect(f.persistence.isQuiescent(8)).toBe(false)
  read.release.resolve(undefined)
  await close.entered.promise
  expect(f.persistence.isQuiescent(8)).toBe(false)
  let disposed = false
  const disposal = f.fiber.dispose().then(() => { disposed = true })
  await Promise.resolve(); expect(disposed).toBe(false)
  close.release.resolve(undefined)
  await expect(opening).rejects.toBe(reason)
  await disposal
  expect(disposed).toBe(true)
})

it('keeps a detached old revision while a replacement finishes', async () => {
  const f = await fixture(), read = f.barrier(), close = f.barrier(), abort = new AbortController()
  hooks.blockRead = 1; hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise
  hooks.blockClose = 2; hooks.closeEntered = () => { close.entered.resolve(undefined) }; hooks.closeRelease = close.release.promise
  const first = f.persistence.open(f.id, 'read', { signal: abort.signal }), reason = new Error('first cancelled')
  void first.catch(() => {})
  await read.entered.promise
  await appendFile(f.path, '\n')
  const replacement = await f.persistence.open(f.id, 'read')
  await replacement.close()
  abort.abort(reason)
  expect(f.persistence.isQuiescent(8)).toBe(false)
  read.release.resolve(undefined); await close.entered.promise
  expect(f.persistence.isQuiescent(8)).toBe(false)
  close.release.resolve(undefined)
  await expect(first).rejects.toBe(reason)
  await vi.waitFor(() => { expect(f.persistence.isQuiescent(8)).toBe(true) })
})

it('retains and reports a late actual source close failure after the last waiter cancels', async () => {
  const f = await fixture(), read = f.barrier(), close = f.barrier(), abort = new AbortController()
  const failure = new Error('actual source close failed')
  const reported = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => undefined)
  hooks.blockRead = 1; hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise
  hooks.blockClose = 1; hooks.closeEntered = () => { close.entered.resolve(undefined) }; hooks.closeRelease = close.release.promise
  hooks.closeFailure = failure
  const opening = f.persistence.open(f.id, 'read', { signal: abort.signal }), reason = new Error('last waiter cancelled')
  void opening.catch(() => {})
  await read.entered.promise
  abort.abort(reason)
  read.release.resolve(undefined); await close.entered.promise
  expect(f.persistence.isQuiescent(8)).toBe(false)
  close.release.resolve(undefined)
  await expect(opening).rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure })
  await vi.waitFor(() => { expect(reported).toHaveBeenCalled() })
  expect(f.persistence.isQuiescent(8)).toBe(false)
  await f.fiber.dispose()
  const logged = reported.mock.calls.map(call => call[0] as unknown)
  expect(logged).toContainEqual(expect.objectContaining({ name: 'JsonlReadCleanupError', cause: failure }))
  expect(logged).toContainEqual(expect.objectContaining({ name: 'AggregateError',
    errors: [expect.objectContaining({ name: 'JsonlReadCleanupError', cause: failure })] }))
})

it('retains a late child source close failure after the last parent waiter cancels', async () => {
  const f = await fixture(), read = f.barrier(), close = f.barrier(), abort = new AbortController()
  const child = SessionId('historical-child'), failure = new Error('actual child close failed')
  const path = generationLogPath(f.root, '/work', child, 3, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ type: 'session', id: child, version: 3, createdAt: 2,
    cwd: '/work', isSeeded: false, origin: 'subagent', parentSession: f.id, delegationDepth: 1 }) + '\n')
  const reported = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => undefined)
  hooks.path = path; hooks.blockRead = 1; hooks.readEntered = () => { read.entered.resolve(undefined) }
  hooks.readRelease = read.release.promise
  hooks.blockClose = 1; hooks.closeEntered = () => { close.entered.resolve(undefined) }; hooks.closeRelease = close.release.promise
  hooks.closeFailure = failure
  const reason = new Error('cancel parent'), opening = f.persistence.open(f.id, 'read', { signal: abort.signal })
  void opening.catch(() => {})
  await read.entered.promise
  abort.abort(reason)
  read.release.resolve(undefined); await close.entered.promise
  expect(f.persistence.isQuiescent(8)).toBe(false)
  close.release.resolve(undefined)
  await expect(opening).rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure })
  await vi.waitFor(() => { expect(reported).toHaveBeenCalled() })
  expect(f.persistence.isQuiescent(8)).toBe(false)
  expect(reported.mock.calls.map(call => call[0] as unknown))
    .toContainEqual(expect.objectContaining({ name: 'JsonlReadCleanupError', cause: failure }))
})
