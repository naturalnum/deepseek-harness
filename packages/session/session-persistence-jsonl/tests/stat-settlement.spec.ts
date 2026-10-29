import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { encodeSegment, generationLogPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const hooks = vi.hoisted(() => ({
  path: '', readEntered: undefined as (() => void) | undefined, readRelease: undefined as Promise<unknown> | undefined,
  readCalls: 0, readBytes: 0,
  readFailure: undefined as Error | undefined, closeEntered: undefined as (() => void) | undefined,
  closeRelease: undefined as Promise<unknown> | undefined, closeFailure: undefined as Error | undefined,
  statEntered: undefined as (() => void) | undefined, statRelease: undefined as Promise<unknown> | undefined,
  statFailure: undefined as Error | undefined, realpathPath: '', realpathEntered: undefined as (() => void) | undefined,
  realpathRelease: undefined as Promise<unknown> | undefined, realpathFailure: undefined as Error | undefined,
  readdirPath: '', readdirEntered: undefined as (() => void) | undefined, readdirRelease: undefined as Promise<unknown> | undefined,
  readdirCalls: 0, readdirFailAt: 0, readdirBlockAt: 0, readdirFailure: undefined as Error | undefined,
  decodeEntered: undefined as (() => void) | undefined, decodeRelease: undefined as Promise<unknown> | undefined,
  decodeFailure: undefined as Error | undefined, decodeCalls: 0,
  openPrefix: '', openCalls: 0, openEntered: undefined as (() => void) | undefined, openRelease: undefined as Promise<unknown> | undefined,
  projectPrefix: '', projectReads: 0, projectEntered: undefined as (() => void) | undefined,
  projectRelease: undefined as Promise<unknown> | undefined,
  readdirFailures: new Map<string, Error>(),
  readdirGates: new Map<number, { entered: () => void; release: Promise<unknown> }>(),
}))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const tracked = hooks.openPrefix !== '' && typeof args[0] === 'string' && args[0].startsWith(hooks.openPrefix) && args[1] === 'r'
      if (tracked) hooks.openCalls += 1
      let handle: Awaited<ReturnType<typeof actual.open>>
      try { handle = await actual.open(...args) } catch (error: unknown) {
        if (tracked && hooks.openCalls === 1) { hooks.openEntered?.(); await hooks.openRelease }
        throw error
      }
      if (tracked && hooks.openCalls === 1) { hooks.openEntered?.(); await hooks.openRelease }
      if (args[0] !== hooks.path || args[1] !== 'r') return handle
      return new Proxy(handle, { get(target, property) {
        if (property === 'read') return async (...readArgs: Parameters<typeof target.read>) => {
          hooks.readCalls += 1
          hooks.readEntered?.(); await hooks.readRelease
          if (hooks.readFailure !== undefined) throw hooks.readFailure
          const result = await target.read(...readArgs)
          hooks.readBytes += result.bytesRead
          return result
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
      const failure = hooks.readdirFailures.get(String(args[0]))
      if (failure !== undefined) throw failure
      const trackedProject = hooks.projectPrefix !== '' && typeof args[0] === 'string' && dirname(args[0]) === hooks.projectPrefix
      if (trackedProject) {
        hooks.projectReads += 1
        const entries = await actual.readdir(...args)
        if (hooks.projectReads === 1) { hooks.projectEntered?.(); await hooks.projectRelease }
        return entries
      }
      if (args[0] === hooks.readdirPath) {
        hooks.readdirCalls += 1
        const call = hooks.readdirCalls
        const gate = hooks.readdirGates.get(call)
        if (gate !== undefined) { gate.entered(); await gate.release }
        else if (hooks.readdirBlockAt === 0 || hooks.readdirBlockAt === call) { hooks.readdirEntered?.(); await hooks.readdirRelease }
        if (call === hooks.readdirFailAt && hooks.readdirFailure !== undefined) throw hooks.readdirFailure
      }
      return actual.readdir(...args)
    }) as typeof actual.readdir,
  }
})

vi.mock('../src/zstd.ts', async (load) => {
  const actual = await load<typeof import('../src/zstd.ts')>()
  return { ...actual, decompressZstdFrame: async (...args: Parameters<typeof actual.decompressZstdFrame>) => {
    hooks.decodeCalls += 1
    hooks.decodeEntered?.(); await hooks.decodeRelease
    if (hooks.decodeFailure !== undefined) throw hooks.decodeFailure
    return actual.decompressZstdFrame(...args)
  } }
})

async function fixture(compression: 'none' | 'zstd', cwd = '/work', headerCwd = cwd, version = SESSION_FORMAT_VERSION, listConcurrency = 4) {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-stat-settlement-')), ctx = new Context()
  const releases: Array<() => void> = []
  onTestFinished(async () => {
    releases.forEach(release => release())
    Object.assign(hooks, { path: '', readEntered: undefined, readRelease: undefined, readFailure: undefined, readCalls: 0, readBytes: 0,
      closeEntered: undefined, closeRelease: undefined, closeFailure: undefined, statEntered: undefined,
      statRelease: undefined, statFailure: undefined, realpathPath: '', realpathEntered: undefined,
      realpathRelease: undefined, realpathFailure: undefined, readdirPath: '', readdirEntered: undefined, readdirRelease: undefined,
      readdirCalls: 0, readdirFailAt: 0, readdirBlockAt: 0, readdirFailure: undefined,
      decodeEntered: undefined, decodeRelease: undefined, decodeFailure: undefined, decodeCalls: 0,
      openPrefix: '', openCalls: 0, openEntered: undefined, openRelease: undefined,
      projectPrefix: '', projectReads: 0, projectEntered: undefined, projectRelease: undefined })
    hooks.readdirFailures.clear()
    hooks.readdirGates.clear()
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(JsonlSessionPersistence, { root, compression, listConcurrency })
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

it.each(['none', 'zstd'] as const)('stops %s header reads after the in-flight 8192-byte chunk settles', async (compression) => {
  const f = await fixture(compression), read = f.barrier(), close = f.barrier(), abort = new AbortController()
  const data = compression === 'none' ? Buffer.alloc(128 * 1024, 0x61) : await compressZstdFrame(randomBytes(128 * 1024))
  await writeFile(f.path, data)
  hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise
  hooks.closeEntered = () => { close.entered.resolve(undefined) }; hooks.closeRelease = close.release.promise
  const reason = new Error('cancel during first chunk'), pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  await read.entered.promise
  abort.abort(reason)
  read.release.resolve(undefined)
  await close.entered.promise
  expect(settled).toBe(false)
  expect(hooks.readCalls).toBe(1); expect(hooks.readBytes).toBe(8192)
  close.release.resolve(undefined)
  await expect(pending).rejects.toBe(reason)
})

it('does not start decompression when cancellation arrives during a complete compressed header read', async () => {
  const f = await fixture('zstd'), read = f.barrier(), abort = new AbortController()
  const encoded = await compressZstdFrame(Buffer.alloc(1024 * 1024, 0x61))
  expect(encoded.byteLength).toBeLessThan(8192)
  await writeFile(f.path, encoded)
  hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise
  const reason = new Error('cancel before decompression'), pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await read.entered.promise
  abort.abort(reason); read.release.resolve(undefined)
  await expect(pending).rejects.toBe(reason)
  expect(hooks.readCalls).toBe(1); expect(hooks.decodeCalls).toBe(0)
})

it('does not start another legacy probe or directory after the in-flight open settles', async () => {
  const f = await fixture('none'), gate = f.barrier(), abort = new AbortController()
  await f.ctx.sessionPersistence.stat(SessionId('warm-root'))
  for (const cwd of ['/other-one', '/other-two']) {
    await mkdir(dirname(dirname(generationLogPath(f.root, cwd, f.id, 0, 'none'))), { recursive: true })
  }
  hooks.openPrefix = f.root; hooks.openEntered = () => { gate.entered.resolve(undefined) }; hooks.openRelease = gate.release.promise
  const reason = new Error('cancel directory search'), pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await gate.entered.promise
  abort.abort(reason)
  expect(hooks.openCalls).toBe(1)
  gate.release.resolve(undefined)
  await expect(pending).rejects.toBe(reason)
  expect(hooks.openCalls).toBe(1)
})

it('does not start queued root-encoding directory reads after cancellation', async () => {
  const f = await fixture('none', '/work', '/work', SESSION_FORMAT_VERSION, 1), gate = f.barrier(), abort = new AbortController()
  for (const cwd of ['/other-one', '/other-two']) {
    await mkdir(dirname(dirname(generationLogPath(f.root, cwd, f.id, 0, 'none'))), { recursive: true })
  }
  hooks.projectPrefix = f.root; hooks.projectEntered = () => { gate.entered.resolve(undefined) }
  hooks.projectRelease = gate.release.promise
  const reason = new Error('cancel root check'), pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await gate.entered.promise
  abort.abort(reason); gate.release.resolve(undefined)
  await expect(pending).rejects.toBe(reason)
  expect(hooks.projectReads).toBe(1)
})

it('does not start the root readdir when a queued stat is cancelled before its limiter slot', async () => {
  const f = await fixture('none', '/work', '/work', SESSION_FORMAT_VERSION, 1), gate = f.barrier(), abort = new AbortController()
  const { listLimit } = f.ctx.sessionPersistence as unknown as {
    listLimit: ((task: () => Promise<void>) => Promise<void>) & { readonly pendingCount: number }
  }
  const occupying = listLimit(async () => { gate.entered.resolve(undefined); await gate.release.promise })
  await gate.entered.promise
  hooks.readdirPath = f.root
  const reason = new Error('cancel queued stat'), pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await expect.poll(() => listLimit.pendingCount).toBe(1)
  abort.abort(reason); gate.release.resolve(undefined)
  await occupying
  await expect(pending).rejects.toBe(reason)
  expect(hooks.readdirCalls).toBe(0)
})

it('preserves an independent project read failure while cancelling queued root checks', async () => {
  const f = await fixture('none', '/work', '/work', SESSION_FORMAT_VERSION, 1), gate = f.barrier(), abort = new AbortController()
  const failure = Object.assign(new Error('project read failed'), { code: 'EACCES' })
  hooks.readdirPath = dirname(dirname(f.path)); hooks.readdirFailAt = 1; hooks.readdirFailure = failure
  hooks.readdirEntered = () => { gate.entered.resolve(undefined) }; hooks.readdirRelease = gate.release.promise
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await gate.entered.promise
  abort.abort(new Error('cancel root check')); gate.release.resolve(undefined)
  await expect(pending).rejects.toBe(failure)
})

it('does not cancel a second stat while stopping the first stat root check', async () => {
  const f = await fixture('none', '/work', '/work', SESSION_FORMAT_VERSION, 1), gate = f.barrier(), abort = new AbortController()
  hooks.projectPrefix = f.root; hooks.projectEntered = () => { gate.entered.resolve(undefined) }
  hooks.projectRelease = gate.release.promise
  const reason = new Error('cancel first stat'), first = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void first.catch(() => {})
  await gate.entered.promise
  const second = f.ctx.sessionPersistence.stat(f.id)
  abort.abort(reason); gate.release.resolve(undefined)
  await expect(first).rejects.toBe(reason)
  await expect(second).resolves.toMatchObject({ header: { id: f.id } })
})

it('joins a concurrently recorded root-check failure before returning its own successful check', async () => {
  const f = await fixture('none', '/work', '/work', SESSION_FORMAT_VERSION, 2), gate = f.barrier()
  const failure = Object.assign(new Error('concurrent root check failed'), { code: 'EACCES' })
  hooks.readdirPath = dirname(dirname(f.path)); hooks.readdirBlockAt = 1; hooks.readdirFailAt = 2; hooks.readdirFailure = failure
  hooks.readdirEntered = () => { gate.entered.resolve(undefined) }; hooks.readdirRelease = gate.release.promise
  const first = f.ctx.sessionPersistence.stat(f.id)
  void first.catch(() => {})
  await gate.entered.promise
  const second = f.ctx.sessionPersistence.stat(f.id)
  await expect(second).rejects.toBe(failure)
  gate.release.resolve(undefined)
  await expect(first).rejects.toBe(failure)
})

it.each(['stat', 'list'] as const)('joins an earlier successful stat with a later failing concurrent %s root check', async (kind) => {
  const f = await fixture('none', '/work', '/work', SESSION_FORMAT_VERSION, 2), firstGate = f.barrier(), secondGate = f.barrier()
  const failure = Object.assign(new Error('concurrent root check failed'), { code: 'EACCES' })
  hooks.readdirPath = dirname(dirname(f.path)); hooks.readdirFailAt = 2; hooks.readdirFailure = failure
  hooks.readdirGates.set(1, { entered: () => { firstGate.entered.resolve(undefined) }, release: firstGate.release.promise })
  hooks.readdirGates.set(2, { entered: () => { secondGate.entered.resolve(undefined) }, release: secondGate.release.promise })
  const first = f.ctx.sessionPersistence.stat(f.id)
  let firstSettled = false
  void first.then(() => { firstSettled = true }, () => { firstSettled = true })
  await firstGate.entered.promise
  const second = kind === 'stat' ? f.ctx.sessionPersistence.stat(f.id) : f.ctx.sessionPersistence.list()
  void second.catch(() => {})
  await secondGate.entered.promise
  firstGate.release.resolve(undefined)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(firstSettled).toBe(false)
  secondGate.release.resolve(undefined)
  await expect(second).rejects.toBe(failure)
  await expect(first).rejects.toBe(failure)
})

it('preserves the earlier session-directory failure ahead of a later project failure', async () => {
  const f = await fixture('none', '/work', '/work', SESSION_FORMAT_VERSION, 2)
  await mkdir(dirname(generationLogPath(f.root, '/other', f.id, 0, 'none')), { recursive: true })
  const projects = (await readdir(f.root, { withFileTypes: true })).filter(entry => entry.isDirectory())
  const first = projects[0], second = projects[1]
  if (first === undefined || second === undefined) throw new Error('Expected two real project directories')
  const firstPath = join(f.root, first.name), secondPath = join(f.root, second.name)
  const sessions = (await readdir(firstPath, { withFileTypes: true })).filter(entry => entry.isDirectory())
  const session = sessions[0]
  if (session === undefined) throw new Error('Expected a real session directory')
  const early = Object.assign(new Error('earlier session directory failed'), { code: 'EIO' })
  const later = Object.assign(new Error('later project failed'), { code: 'EACCES' })
  hooks.readdirFailures.set(join(firstPath, session.name), early)
  hooks.readdirFailures.set(secondPath, later)
  await expect(f.ctx.sessionPersistence.stat(f.id)).rejects.toBe(early)
})

it('preserves an already-reported project failure when cancellation stops an earlier directory check', async () => {
  const f = await fixture('none', '/work', '/work', SESSION_FORMAT_VERSION, 2), gate = f.barrier(), abort = new AbortController()
  await mkdir(dirname(generationLogPath(f.root, '/other', f.id, 0, 'none')), { recursive: true })
  const projects = (await readdir(f.root, { withFileTypes: true })).filter(entry => entry.isDirectory())
  const first = projects[0], second = projects[1]
  if (first === undefined || second === undefined) throw new Error('Expected two real project directories')
  const firstPath = join(f.root, first.name), secondPath = join(f.root, second.name)
  const session = (await readdir(firstPath, { withFileTypes: true })).find(entry => entry.isDirectory())
  if (session === undefined) throw new Error('Expected a real session directory')
  const failure = Object.assign(new Error('project failed'), { code: 'EACCES' })
  hooks.readdirFailures.set(secondPath, failure)
  hooks.readdirPath = join(firstPath, session.name); hooks.readdirEntered = () => { gate.entered.resolve(undefined) }
  hooks.readdirRelease = gate.release.promise
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await gate.entered.promise
  abort.abort(new Error('cancel directory')); gate.release.resolve(undefined)
  await expect(pending).rejects.toBe(failure)
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

it.each(['distinct', 'same-reason'] as const)('retains a legacy-flat close ENOENT with %s cancellation', async (kind) => {
  const f = await fixture('none'), close = f.barrier(), abort = new AbortController()
  await f.ctx.sessionPersistence.stat(f.id)
  const path = join(dirname(dirname(f.path)), `${encodeSegment(f.id)}.jsonl`)
  await writeFile(path, 'legacy flat artifact')
  const failure = Object.assign(new Error('legacy flat close failed'), { code: 'ENOENT' })
  hooks.path = path; hooks.closeFailure = failure
  hooks.closeEntered = () => { close.entered.resolve(undefined) }; hooks.closeRelease = close.release.promise
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await close.entered.promise
  abort.abort(kind === 'same-reason' ? failure : new Error('cancel stat'))
  close.release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure, errors: [failure] })
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

it.each(['none', 'zstd'] as const)('retains a %s header read ENOENT after a successful open and cancellation', async (compression) => {
  const f = await fixture(compression), read = f.barrier(), abort = new AbortController()
  const failure = Object.assign(new Error('header read failed'), { code: 'ENOENT' })
  hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise; hooks.readFailure = failure
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await read.entered.promise
  abort.abort(new Error('cancel stat')); read.release.resolve(undefined)
  await expect(pending).rejects.toBe(failure)
})

it.each(['none', 'zstd'] as const)('retains a %s header read ENOENT even when it is the abort reason', async (compression) => {
  const f = await fixture(compression), read = f.barrier(), abort = new AbortController()
  const failure = Object.assign(new Error('header read failed'), { code: 'ENOENT' })
  hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise; hooks.readFailure = failure
  const pending = f.ctx.sessionPersistence.stat(f.id, { signal: abort.signal })
  void pending.catch(() => {})
  await read.entered.promise
  abort.abort(failure); read.release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ name: 'AggregateError', cause: failure, errors: [failure] })
})

it.each(['none', 'zstd'] as const)('retains a %s header read ENOENT during a cancelled listing', async (compression) => {
  const f = await fixture(compression), read = f.barrier(), abort = new AbortController()
  const failure = Object.assign(new Error('header read failed'), { code: 'ENOENT' })
  hooks.readEntered = () => { read.entered.resolve(undefined) }; hooks.readRelease = read.release.promise; hooks.readFailure = failure
  const pending = f.ctx.sessionPersistence.list({ signal: abort.signal })
  void pending.catch(() => {})
  await read.entered.promise
  abort.abort(new Error('cancel list')); read.release.resolve(undefined)
  await expect(pending).rejects.toBe(failure)
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
