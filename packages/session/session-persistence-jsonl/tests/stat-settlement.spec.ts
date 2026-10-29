import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { generationLogPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const hooks = vi.hoisted(() => ({
  path: '', readEntered: undefined as (() => void) | undefined, readRelease: undefined as Promise<unknown> | undefined,
  readFailure: undefined as Error | undefined, closeEntered: undefined as (() => void) | undefined,
  closeRelease: undefined as Promise<unknown> | undefined, closeFailure: undefined as Error | undefined,
  statEntered: undefined as (() => void) | undefined, statRelease: undefined as Promise<unknown> | undefined,
  statFailure: undefined as Error | undefined, realpathPath: '', realpathEntered: undefined as (() => void) | undefined,
  realpathRelease: undefined as Promise<unknown> | undefined, realpathFailure: undefined as Error | undefined,
  readdirPath: '', readdirEntered: undefined as (() => void) | undefined, readdirRelease: undefined as Promise<unknown> | undefined,
  readdirCalls: 0, readdirFailAt: 0, readdirFailure: undefined as Error | undefined,
  decodeEntered: undefined as (() => void) | undefined, decodeRelease: undefined as Promise<unknown> | undefined,
  decodeFailure: undefined as Error | undefined,
}))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (args[0] !== hooks.path || args[1] !== 'r') return handle
      return new Proxy(handle, { get(target, property) {
        if (property === 'read') return async (...readArgs: Parameters<typeof target.read>) => {
          hooks.readEntered?.(); await hooks.readRelease
          if (hooks.readFailure !== undefined) throw hooks.readFailure
          return target.read(...readArgs)
        }
        if (property === 'close') return async () => {
          hooks.closeEntered?.(); await hooks.closeRelease
          await target.close()
          if (hooks.closeFailure !== undefined) throw hooks.closeFailure
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }) as typeof actual.open,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      if (args[0] === hooks.path) {
        hooks.statEntered?.(); await hooks.statRelease
        if (hooks.statFailure !== undefined) throw hooks.statFailure
      }
      return actual.stat(...args)
    }) as typeof actual.stat,
    realpath: (async (...args: Parameters<typeof actual.realpath>) => {
      if (args[0] === hooks.realpathPath) {
        hooks.realpathEntered?.(); await hooks.realpathRelease
        if (hooks.realpathFailure !== undefined) throw hooks.realpathFailure
      }
      return actual.realpath(...args)
    }) as typeof actual.realpath,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      if (args[0] === hooks.readdirPath) {
        hooks.readdirEntered?.(); await hooks.readdirRelease
        hooks.readdirCalls += 1
        if (hooks.readdirCalls === hooks.readdirFailAt && hooks.readdirFailure !== undefined) throw hooks.readdirFailure
      }
      return actual.readdir(...args)
    }) as typeof actual.readdir,
  }
})

vi.mock('../src/zstd.ts', async (load) => {
  const actual = await load<typeof import('../src/zstd.ts')>()
  return { ...actual, decompressZstdFrame: async (...args: Parameters<typeof actual.decompressZstdFrame>) => {
    hooks.decodeEntered?.(); await hooks.decodeRelease
    if (hooks.decodeFailure !== undefined) throw hooks.decodeFailure
    return actual.decompressZstdFrame(...args)
  } }
})

async function fixture(compression: 'none' | 'zstd', cwd = '/work', headerCwd = cwd, version = SESSION_FORMAT_VERSION) {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-stat-settlement-')), ctx = new Context()
  const releases: Array<() => void> = []
  onTestFinished(async () => {
    releases.forEach(release => release())
    Object.assign(hooks, { path: '', readEntered: undefined, readRelease: undefined, readFailure: undefined,
      closeEntered: undefined, closeRelease: undefined, closeFailure: undefined, statEntered: undefined,
      statRelease: undefined, statFailure: undefined, realpathPath: '', realpathEntered: undefined,
      realpathRelease: undefined, realpathFailure: undefined, readdirPath: '', readdirEntered: undefined, readdirRelease: undefined,
      readdirCalls: 0, readdirFailAt: 0, readdirFailure: undefined,
      decodeEntered: undefined, decodeRelease: undefined, decodeFailure: undefined })
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  const id = SessionId('settled-stat'), header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: headerCwd }
  const path = generationLogPath(root, cwd, id, version, compression)
  await mkdir(dirname(path), { recursive: true })
  const data = JSON.stringify(version === SESSION_FORMAT_VERSION ? toHeaderLine(header)
    : { type: 'session', id, version, createdAt: 1, cwd: headerCwd, delegationDepth: 0 }) + '\n'
  await writeFile(path, compression === 'none' ? data : await compressZstdFrame(data))
  hooks.path = path
  const barrier = () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    releases.push(() => { release.resolve(undefined) })
    return { entered, release }
  }
  return { ctx, id, path, root, barrier }
}

it('does not start filesystem work for an already-cancelled stat', async () => {
  const f = await fixture('none'), abort = new AbortController(), reason = new Error('already cancelled')
  hooks.readdirPath = f.root
  abort.abort(reason)
  await expect(f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })).rejects.toBe(reason)
  expect(hooks.readdirCalls).toBe(0)
})

it.each(['success', 'failure'] as const)('joins the zstd header decoder with %s after cancellation', async (outcome) => {
  const f = await fixture('zstd'), decode = f.barrier(), abort = new AbortController()
  const reason = new Error('cancel stat'), failure = new Error('decoder failed')
  hooks.decodeEntered = () => { decode.entered.resolve(undefined) }; hooks.decodeRelease = decode.release.promise
  if (outcome === 'failure') hooks.decodeFailure = failure
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await decode.entered.promise
  abort.abort(reason)
  await Promise.resolve(); expect(settled).toBe(false)
  decode.release.resolve(undefined)
  if (outcome === 'success') await expect(pending).rejects.toBe(reason)
  else await expect(pending).rejects.toMatchObject({ name: 'SessionPersistenceCorruptionError', cause: failure })
})

it.each(['readdir', 'stat'] as const)('joins real %s filesystem work before reporting cancellation', async (stage) => {
  const f = await fixture('none'), gate = f.barrier(), abort = new AbortController()
  if (stage === 'readdir') {
    hooks.readdirPath = f.root; hooks.readdirEntered = () => { gate.entered.resolve(undefined) }
    hooks.readdirRelease = gate.release.promise
  } else {
    hooks.statEntered = () => { gate.entered.resolve(undefined) }; hooks.statRelease = gate.release.promise
  }
  const reason = new Error('cancel stat'), pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await gate.entered.promise
  abort.abort(reason)
  await Promise.resolve(); expect(settled).toBe(false)
  gate.release.resolve(undefined)
  await expect(pending).rejects.toBe(reason)
})

it.each(['none', 'zstd'] as const)('joins real %s header read and close before reporting cancellation', async (compression) => {
  const f = await fixture(compression), read = f.barrier(), close = f.barrier(), abort = new AbortController()
  hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise
  hooks.closeEntered = () => { close.entered.resolve(undefined) }; hooks.closeRelease = close.release.promise
  const reason = new Error('cancel stat')
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await read.entered.promise
  abort.abort(reason)
  await Promise.resolve(); expect(settled).toBe(false)
  read.release.resolve(undefined)
  await close.entered.promise
  await Promise.resolve(); expect(settled).toBe(false)
  close.release.resolve(undefined)
  await expect(pending).rejects.toBe(reason)
  expect(f.ctx.sessionPersistence.statSettlesOnAbort).toBe(true)
})

it.each(['none', 'zstd'] as const)('retains a real %s handle close failure after cancellation', async (compression) => {
  const f = await fixture(compression), close = f.barrier(), abort = new AbortController()
  const closeFailure = Object.assign(new Error('close failure'), { code: 'ENOENT' })
  hooks.closeFailure = closeFailure; hooks.closeEntered = () => { close.entered.resolve(undefined) }
  hooks.closeRelease = close.release.promise
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await close.entered.promise
  abort.abort(new Error('cancel stat'))
  close.release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: closeFailure, errors: [closeFailure] })
})

it.each(['none', 'zstd'] as const)('retains both %s header read and close failures', async (compression) => {
  const f = await fixture(compression), close = f.barrier(), abort = new AbortController()
  const readFailure = new Error('read failed'), closeFailure = new Error('close failed')
  hooks.readFailure = readFailure; hooks.closeFailure = closeFailure
  hooks.closeEntered = () => { close.entered.resolve(undefined) }; hooks.closeRelease = close.release.promise
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await close.entered.promise
  abort.abort(new Error('cancel stat')); close.release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: closeFailure,
    errors: [readFailure, closeFailure] })
})

it('does not turn a historical corpus directory failure into an absent target', async () => {
  const f = await fixture('none', '/work', '/work', 0)
  const failure = Object.assign(new Error('historical directory disappeared'), { code: 'ENOENT' })
  hooks.readdirPath = dirname(dirname(f.path)); hooks.readdirFailAt = 2; hooks.readdirFailure = failure
  await expect(f.ctx.sessionPersistence.stat(f.id)).rejects.toBe(failure)
  expect(hooks.readdirCalls).toBe(2)
})

it.each(['independent', 'same-reason', 'node-wrapper'] as const)('retains %s final stat failure racing cancellation', async (kind) => {
  const f = await fixture('none'), statGate = f.barrier(), abort = new AbortController()
  const reason = new Error('cancel stat'), independent = new Error('stat failed')
  const failure = kind === 'same-reason' ? reason : kind === 'node-wrapper'
    ? Object.assign(new Error('independent wrapped failure', { cause: reason }), { name: 'AbortError', code: 'ABORT_ERR' })
    : independent
  hooks.statFailure = failure; hooks.statEntered = () => { statGate.entered.resolve(undefined) }
  hooks.statRelease = statGate.release.promise
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await statGate.entered.promise
  abort.abort(reason); statGate.release.resolve(undefined)
  if (kind === 'independent') await expect(pending).rejects.toBe(failure)
  else await expect(pending).rejects.toMatchObject({ name: 'AggregateError', cause: failure, errors: [failure] })
})

it('joins both realpath operations before reporting a mismatched header path', async () => {
  const f = await fixture('none', '/work', '/other'), gate = f.barrier()
  hooks.realpathPath = f.path; hooks.realpathEntered = () => { gate.entered.resolve(undefined) }
  hooks.realpathRelease = gate.release.promise
  const pending = f.ctx.sessionPersistence.stat(f.id)
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await gate.entered.promise
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  gate.release.resolve(undefined)
  await expect(pending).rejects.toThrow(/header id/)
})

it('does not hide a realpath failure behind an absent sibling path', async () => {
  const f = await fixture('none', '/work', '/other'), gate = f.barrier()
  const failure = new Error('realpath failed')
  hooks.realpathPath = f.path; hooks.realpathFailure = failure
  hooks.realpathEntered = () => { gate.entered.resolve(undefined) }; hooks.realpathRelease = gate.release.promise
  const pending = f.ctx.sessionPersistence.stat(f.id)
  void pending.catch(() => {})
  await gate.entered.promise
  gate.release.resolve(undefined)
  await expect(pending).rejects.toBe(failure)
})
