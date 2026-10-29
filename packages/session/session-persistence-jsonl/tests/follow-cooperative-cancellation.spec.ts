/** Signal-free cold reads cannot provide cooperative cancellation inside JSONL operations. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '../src/index.ts'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readColdSessionLogForObservation } from '../../../session-query/session-query/src/cold-read.ts'
import { generationLogPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const probe = vi.hoisted(() => ({ path: '', cancelled: false, fileEntered: undefined as (() => void) | undefined,
  fileRelease: undefined as Promise<unknown> | undefined, closeEntered: undefined as (() => void) | undefined,
  closeRelease: undefined as Promise<unknown> | undefined, closeFailure: undefined as Error | undefined, closes: 0, dir: '', dirEntered: undefined as (() => void) | undefined,
  dirRelease: undefined as Promise<unknown> | undefined, parentReadsAfterCancel: 0, bodyReadsAfterCancel: 0, decodersAfterCancel: 0 }))

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
      if (args[0] === probe.dir) { probe.dirEntered?.(); await probe.dirRelease }
      return result
    }) as typeof actual.readdir,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === probe.path && probe.cancelled) probe.bodyReadsAfterCancel += 1
      return actual.readFile(...args)
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
      dirEntered: undefined, dirRelease: undefined, parentReadsAfterCancel: 0, bodyReadsAfterCancel: 0, decodersAfterCancel: 0 })
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
