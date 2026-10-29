/** Signal-free cold reads cannot provide cooperative cancellation inside JSONL operations. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '../src/index.ts'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readColdSessionLogForObservation } from '../../../session-query/session-query/src/cold-read.ts'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'
import { generationLogPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const probe = vi.hoisted(() => ({ path: '', cancelled: false, fileEntered: undefined as (() => void) | undefined,
  fileRelease: undefined as Promise<unknown> | undefined, closeEntered: undefined as (() => void) | undefined,
  closeRelease: undefined as Promise<unknown> | undefined, closeFailure: undefined as Error | undefined, closes: 0, dir: '', dirEntered: undefined as (() => void) | undefined,
  dirRelease: undefined as Promise<unknown> | undefined, dirFailure: undefined as Error | undefined,
  bodyEntered: undefined as (() => void) | undefined, bodyRelease: undefined as Promise<unknown> | undefined,
  bodyFailure: undefined as Error | undefined, parentReadsAfterCancel: 0, bodyReadsAfterCancel: 0, decodersAfterCancel: 0 }))

vi.mock('../src/zstd.ts', async (load) => {
  const actual = await load<typeof import('../src/zstd.ts')>()
  return { ...actual, createZstdFrameDecoder: () => {
    if (probe.cancelled) probe.decodersAfterCancel += 1
    return actual.createZstdFrameDecoder()
  } }
})

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const result = await actual.readdir(...args)
      if (args[0] === probe.dir) {
        probe.dirEntered?.(); await probe.dirRelease
        if (probe.dirFailure !== undefined) throw probe.dirFailure
      }
      return result
    }) as typeof actual.readdir,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === probe.path && probe.cancelled) probe.bodyReadsAfterCancel += 1
      const result = await actual.readFile(...args)
      if (args[0] === probe.path && probe.bodyEntered !== undefined) {
        probe.bodyEntered(); await probe.bodyRelease
        if (probe.bodyFailure !== undefined) throw probe.bodyFailure
      }
      return result
    }) as typeof actual.readFile,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (args[0] !== probe.path || args[1] !== 'r') return handle
      let body = false
      return new Proxy(handle, { get(target, property) {
        if (property === 'close') return async () => {
          if (body) { probe.closeEntered?.(); await probe.closeRelease }
          await target.close()
          if (body) { probe.closes += 1; if (probe.closeFailure !== undefined) throw probe.closeFailure }
        }
        if (property === 'readFile') return async (...readArgs: Parameters<typeof target.readFile>) => {
          body = true
          const result = await target.readFile(...readArgs)
          probe.fileEntered?.(); await probe.fileRelease
          if (probe.cancelled) probe.parentReadsAfterCancel += 1
          return result
        }
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        const bound: unknown = value.bind(target)
        return bound
      } })
    },
  }
})

async function fixture(version: 3 | 4, compression: 'none' | 'zstd') {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-follow-cancel-probe-')), ctx = new Context()
  const release = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined)
    Object.assign(probe, { path: '', cancelled: false, fileEntered: undefined, fileRelease: undefined, closeEntered: undefined, closeRelease: undefined, closeFailure: undefined, closes: 0, dir: '',
      dirEntered: undefined, dirRelease: undefined, dirFailure: undefined, bodyEntered: undefined,
      bodyRelease: undefined, bodyFailure: undefined, parentReadsAfterCancel: 0, bodyReadsAfterCancel: 0, decodersAfterCancel: 0 })
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPersistence, { root, compression })
  const id = SessionId(`probe-v${String(version)}`)
  const header = { id, version, createdAt: 1, isSeeded: false, cwd: '/work', delegationDepth: 0 }
  const path = generationLogPath(root, header.cwd, id, version, compression)
  const data = JSON.stringify(version === 3 ? { type: 'session', ...header } : toHeaderLine(header)) + '\n'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, compression === 'zstd' ? await compressZstdFrame(data) : data)
  probe.path = path
  return { ctx, id, path, entered, release }
}

it('starts the historical decoder after external cancellation of a signal-free cold read', async () => {
  const f = await fixture(3, 'zstd'), abort = new AbortController()
  probe.fileEntered = () => { f.entered.resolve(undefined) }; probe.fileRelease = f.release.promise
  const pending = readColdSessionLogForObservation(f.ctx.sessionPersistence, f.id)
  void pending.catch(() => {})
  await Promise.race([f.entered.promise, pending.then(() => { throw new Error('Read completed before the gate') })])
  abort.abort(); probe.cancelled = true
  expect(f.ctx.sessionPersistence.isQuiescent(8)).toBe(false)
  f.release.resolve(undefined)
  await pending
  expect(probe.parentReadsAfterCancel).toBe(1)
  expect(probe.closes).toBe(1)
  expect(probe.decodersAfterCancel).toBeGreaterThan(0)
})

it('joins the only historical waiter and does not start a decoder after cancellation', async () => {
  const f = await fixture(3, 'zstd'), abort = new AbortController(), reason = new Error('cancel')
  probe.fileEntered = () => { f.entered.resolve(undefined) }; probe.fileRelease = f.release.promise
  const pending = f.ctx.sessionPersistence.open(f.id, 'read', { signal: abort.signal })
  void pending.catch(() => {})
  await Promise.race([f.entered.promise, pending.then(() => { throw new Error('Open completed before the gate') })])
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  abort.abort(reason); probe.cancelled = true
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(settled).toBe(false)
  f.release.resolve(undefined)
  await expect(pending).rejects.toBe(reason)
  expect(probe.closes).toBe(1)
  expect(probe.decodersAfterCancel).toBe(0)
})

it('starts a body read after external cancellation during a signal-free handle directory probe', async () => {
  const f = await fixture(4, 'none'), abort = new AbortController()
  const persistence = f.ctx.sessionPersistence, open = persistence.open.bind(persistence)
  vi.spyOn(persistence, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    probe.dir = dirname(f.path); probe.dirEntered = () => { f.entered.resolve(undefined) }; probe.dirRelease = f.release.promise
    return handle
  })
  const pending = readColdSessionLogForObservation(persistence, f.id)
  void pending.catch(() => {})
  await Promise.race([f.entered.promise, pending.then(() => { throw new Error('Read completed before the gate') })])
  abort.abort(); probe.cancelled = true
  await appendFile(f.path, '\n')
  f.release.resolve(undefined)
  await pending
  expect(probe.bodyReadsAfterCancel).toBeGreaterThan(0)
})

it.each(['cancel', 'same-reason'] as const)('joins handle directory lookup and preserves %s after cancellation', async (kind) => {
  const f = await fixture(4, 'none'), abort = new AbortController(), reason = new Error('cancelled lookup')
  const persistence = f.ctx.sessionPersistence, open = persistence.open.bind(persistence)
  let closed = false
  vi.spyOn(persistence, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); closed = true })
    probe.dir = dirname(f.path); probe.dirEntered = () => { f.entered.resolve(undefined) }; probe.dirRelease = f.release.promise
    return handle
  })
  const pending = new SessionObservationReader(f.ctx).read(f.id, { signal: abort.signal, projectionMode: 'none' })
  void pending.catch(() => {})
  await Promise.race([f.entered.promise, pending.then(() => { throw new Error('Read completed before the gate') })])
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  abort.abort(reason); probe.cancelled = true
  if (kind === 'same-reason') { Object.assign(reason, { code: 'EIO' }); probe.dirFailure = reason }
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(settled).toBe(false)
  f.release.resolve(undefined)
  const error: unknown = await pending.catch((failure: unknown) => failure)
  expect(closed).toBe(true)
  expect(probe.bodyReadsAfterCancel).toBe(0)
  if (kind === 'same-reason') expect(error).toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED',
    cause: { name: 'AggregateError', cause: reason, errors: [reason] } })
  else expect(error).toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
})

it.each(['cancel', 'same-reason'] as const)('joins a current body read and preserves %s during cancellation', async (kind) => {
  const f = await fixture(4, 'none'), abort = new AbortController(), reason = new Error('cancelled body read')
  const persistence = f.ctx.sessionPersistence, open = persistence.open.bind(persistence)
  let closed = false
  vi.spyOn(persistence, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); closed = true })
    await appendFile(f.path, '\n')
    probe.bodyEntered = () => { f.entered.resolve(undefined) }; probe.bodyRelease = f.release.promise
    return handle
  })
  const pending = new SessionObservationReader(f.ctx).read(f.id, { signal: abort.signal, projectionMode: 'none' })
  void pending.catch(() => {})
  await Promise.race([f.entered.promise, pending.then(() => { throw new Error('Read completed before the gate') })])
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  abort.abort(reason); probe.cancelled = true
  if (kind === 'same-reason') { Object.assign(reason, { code: 'EIO' }); probe.bodyFailure = reason }
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(settled).toBe(false)
  f.release.resolve(undefined)
  const error: unknown = await pending.catch((failure: unknown) => failure)
  expect(closed).toBe(true)
  if (kind === 'same-reason') expect(error).toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED',
    cause: { name: 'AggregateError', cause: reason, errors: [reason] } })
  else expect(error).toMatchObject({ code: 'SESSION_QUERY_ABORTED', cause: reason })
})
