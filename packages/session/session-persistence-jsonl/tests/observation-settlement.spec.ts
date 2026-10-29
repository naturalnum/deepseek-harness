import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { generationLogPath, toHeaderLine } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { prepareCatalogFacts } from '../src/catalog-migration.ts'
import { boot } from '../../../boot/app-boot/src/index.ts'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'

const faults = vi.hoisted(() => ({ headerPath: '', headerClose: undefined as Error | undefined, skipCloses: 0, fileCloses: 0,
  bodyReadFileClose: undefined as Error | undefined, bodyReadFileInjected: false,
  headerRead: undefined as Error | undefined, abortOnClose: undefined as AbortController | undefined,
  openFailure: undefined as Error | undefined, decoderRead: undefined as Error | undefined,
  abortOnDecoderClose: undefined as AbortController | undefined, decoderCloses: 0, privateDecoder: false, forcePublic: false,
  decoderClose: undefined as Error | undefined }))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args)
    if (args[0] === faults.headerPath && faults.bodyReadFileClose !== undefined) {
      faults.bodyReadFileInjected = true
      throw faults.bodyReadFileClose
    }
    return result
  }) as typeof actual.readFile, open: (async (...args: Parameters<typeof actual.open>) => {
    if (args[0] === faults.headerPath && faults.openFailure !== undefined) throw faults.openFailure
    const handle = await actual.open(...args)
    if (args[0] !== faults.headerPath || args[1] !== 'r' || faults.headerClose === undefined) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === 'close') return async () => {
        faults.fileCloses += 1
        await target.close()
        if (faults.skipCloses > 0) { faults.skipCloses -= 1; return }
        faults.abortOnClose?.abort(); throw faults.headerClose
      }
      if ((property === 'read' || property === 'readFile') && faults.headerRead !== undefined) return async () => { throw faults.headerRead }
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const bound: unknown = value.bind(target)
      return bound
    } })
  }) }
})

vi.mock('../src/zstd.ts', async (load) => {
  const actual = await load<typeof import('../src/zstd.ts')>()
  const { PublicZstdFrameDecoder } = await import('../src/zstd-public-decoder.ts')
  return { ...actual, createZstdFrameDecoder: () => {
    const decoder = faults.forcePublic ? new PublicZstdFrameDecoder() : actual.createZstdFrameDecoder()
    const decode = decoder.decode.bind(decoder), close = decoder.close.bind(decoder)
    const stream = Reflect.get(decoder, 'stream') as { close(): void } | undefined
    faults.privateDecoder = stream !== undefined
    const injectCloseFailure = (): void => {
      const failure = faults.decoderClose
      faults.decoderClose = undefined
      faults.abortOnDecoderClose?.abort()
      if (failure !== undefined) throw failure
    }
    if (stream !== undefined) {
      const closeStream = stream.close.bind(stream)
      stream.close = () => { closeStream(); injectCloseFailure() }
    }
    decoder.decode = (...args: Parameters<typeof decoder.decode>) => {
      if (faults.decoderRead !== undefined) throw faults.decoderRead
      return decode(...args)
    }
    decoder.close = () => {
      faults.decoderCloses += 1
      close()
      if (stream === undefined) injectCloseFailure()
    }
    return decoder
  } }
})

it('does not fulfill a parent open after a child decoder close fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settlement-parent-')); roots.push(root)
  const sessionsRoot = join(root, 'sessions'), configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { id: 'sessions', name: 'cordis:sessions' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: sessionsRoot, compression: 'zstd' } },
  ]))
  const ctx = await boot('dsh', configPath, [], (owner) => {
    Object.assign(owner.loader.builtins, { sessions: SessionStore, persistence: JsonlSessionPersistence })
  })
  contexts.push(ctx)
  const parent = SessionId('parent'), child = SessionId('child')
  const parentHeader = { type: 'session', id: parent, version: 3, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const childHeader = { ...parentHeader, id: child, createdAt: 2, origin: 'subagent', parentSession: parent, delegationDepth: 1 }
  for (const header of [parentHeader, childHeader]) {
    const path = generationLogPath(sessionsRoot, undefined, header.id, 3, 'zstd')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, await compressZstdFrame(JSON.stringify(header) + '\n'))
  }
  const failure = new Error('child decoder close failed')
  faults.decoderClose = failure
  const [result] = await Promise.allSettled([ctx.sessionPersistence.open(parent, 'read')])
  if (result?.status === 'fulfilled') { await result.value.close(); throw new Error('Parent open unexpectedly succeeded') }
  expect(result).toMatchObject({ status: 'rejected', reason: { name: 'JsonlReadCleanupError', cause: failure } })
  expect(faults.decoderCloses).toBe(1)
})

it.each(['header', 'body'] as const)('rejects parent discovery when a child %s file close fails', async (stage) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settlement-discovery-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const parent = SessionId('parent'), child = SessionId('child')
  const parentHeader = { type: 'session', id: parent, version: 3, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const childHeader = { ...parentHeader, id: child, createdAt: 2, origin: 'subagent', parentSession: parent, delegationDepth: 1 }
  for (const header of [parentHeader, childHeader]) {
    const path = generationLogPath(root, undefined, header.id, 3, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(header) + '\n')
  }
  const failure = Object.assign(new Error('child header close failed'), { code: 'ENOENT' })
  faults.headerPath = generationLogPath(root, undefined, child, 3, 'none'); faults.headerClose = failure
  faults.skipCloses = stage === 'body' ? 1 : 0
  if (stage === 'body') faults.bodyReadFileClose = failure
  const [result] = await Promise.allSettled([ctx.sessionPersistence.open(parent, 'read')])
  if (result?.status === 'fulfilled') {
    await result.value.close()
    if (stage === 'body') expect(faults.bodyReadFileInjected).toBe(true)
    throw new Error('Parent open unexpectedly succeeded')
  }
  expect(result).toMatchObject({ status: 'rejected', reason: { name: 'JsonlReadCleanupError', cause: failure } })
  expect(faults.fileCloses).toBe(stage === 'body' ? 2 : 1)
})

const contexts: Context[] = [], roots: string[] = []
afterEach(async () => {
  faults.headerPath = ''; faults.headerClose = undefined; faults.headerRead = undefined; faults.skipCloses = 0; faults.fileCloses = 0
  faults.abortOnClose = undefined; faults.openFailure = undefined; faults.decoderRead = undefined; faults.decoderClose = undefined
  faults.abortOnDecoderClose = undefined; faults.bodyReadFileClose = undefined; faults.bodyReadFileInjected = false
  faults.decoderCloses = 0; faults.privateDecoder = false; faults.forcePublic = false
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['none', 'zstd'] as const)('does not turn a failed %s header file close into an absent stat result', async (compression) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settlement-header-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  const id = SessionId('header-close-failure')
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const path = generationLogPath(root, header.cwd, id, SESSION_FORMAT_VERSION, compression)
  await mkdir(dirname(path), { recursive: true })
  const data = JSON.stringify(toHeaderLine(header)) + '\n'
  await writeFile(path, compression === 'none' ? data : await compressZstdFrame(data))
  await expect(ctx.sessionPersistence.stat(SessionId('missing'))).resolves.toBeUndefined()
  const failure = Object.assign(new Error('actual header close failed'), { code: 'ENOENT' })
  faults.headerPath = path; faults.headerClose = failure
  await expect(ctx.sessionPersistence.stat(id)).rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure, errors: [failure] })
  expect(faults.fileCloses).toBe(1)
  faults.fileCloses = 0
  const readFailure = new Error('actual header read failed')
  faults.headerRead = readFailure
  const abort = new AbortController(); faults.abortOnClose = abort
  await expect(ctx.sessionPersistence.stat(id, { signal: abort.signal }))
    .rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure, errors: [readFailure, failure] })
  expect(faults.fileCloses).toBe(1)
  faults.fileCloses = 0; faults.headerRead = undefined
  const observationAbort = new AbortController(); faults.abortOnClose = observationAbort
  await expect(new SessionObservationReader(ctx).read(id, { signal: observationAbort.signal, projectionMode: 'none' }))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: {
      name: 'JsonlReadCleanupError', cause: failure, errors: [failure],
    } })
  expect(faults.fileCloses).toBe(1)
})

it.each(['private', 'public'] as const)('retains current %s decoder and close errors during cancellation', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-current-decoder-errors-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
  const id = SessionId(`current-decoder-${kind}`)
  const header = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const path = generationLogPath(root, header.cwd, id, SESSION_FORMAT_VERSION, 'zstd')
  await mkdir(dirname(path), { recursive: true })
  const data = await compressZstdFrame(JSON.stringify(toHeaderLine(header)) + '\n')
  await writeFile(path, data)
  const handle = await ctx.sessionPersistence.open(id, 'read')
  await writeFile(path, Buffer.concat([data, await compressZstdFrame('\n')]))
  const readFailure = new Error('actual decoder read failed'), closeFailure = new Error('actual decoder close failed')
  const abort = new AbortController()
  faults.forcePublic = kind === 'public'; faults.decoderRead = readFailure
  faults.decoderClose = closeFailure; faults.abortOnDecoderClose = abort
  try {
    await expect(handle.read(0, undefined, { signal: abort.signal })).rejects.toMatchObject({
      name: 'JsonlReadCleanupError', cause: closeFailure, errors: [readFailure, closeFailure],
    })
    expect(abort.signal.aborted).toBe(true)
  } finally { await handle.close() }
})

it.each(['none', 'zstd'] as const)('does not discard a %s child file close failure as an unavailable child', async (compression) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settlement-child-file-')); roots.push(root)
  const parent = SessionId('parent'), id = SessionId('child')
  const header = { id, version: 3, createdAt: 2, isSeeded: false, origin: 'subagent', parentSession: parent, delegationDepth: 1 }
  const path = generationLogPath(root, undefined, id, 3, compression)
  await mkdir(dirname(path), { recursive: true })
  const data = JSON.stringify({ type: 'session', ...header }) + '\n'
  await writeFile(path, compression === 'none' ? data : await compressZstdFrame(data))
  const failure = Object.assign(new Error('actual child file close failed'), { code: 'ENOENT' })
  faults.headerPath = path; faults.headerClose = failure; faults.bodyReadFileClose = failure
  await expect(prepareCatalogFacts(parent, [{ header: header as never, path }], compression, new AbortController().signal))
    .rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure, errors: [failure] })
  expect(faults.fileCloses).toBe(1)
  faults.fileCloses = 0
  const readFailure = new Error('actual child file read failed')
  faults.headerRead = readFailure
  const abort = new AbortController(); faults.abortOnClose = abort
  await expect(prepareCatalogFacts(parent, [{ header: header as never, path }], compression, abort.signal))
    .rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure, errors: [readFailure, failure] })
  expect(faults.fileCloses).toBe(1)
  const missing = Object.assign(new Error('child was removed before open'), { code: 'ENOENT' })
  faults.headerRead = undefined; faults.headerClose = undefined; faults.abortOnClose = undefined
  faults.bodyReadFileClose = undefined; faults.openFailure = missing
  await expect(prepareCatalogFacts(parent, [{ header: header as never, path }], compression, new AbortController().signal))
    .resolves.toMatchObject({ failures: [{ error: missing }] })
})

it.each(['private', 'public'] as const)('preserves a %s child decoder close failure', async (decoderKind) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settlement-child-')); roots.push(root)
  const parent = SessionId('parent'), id = SessionId('child')
  const header = { id, version: 3, createdAt: 2, isSeeded: false, origin: 'subagent', parentSession: parent, delegationDepth: 1 }
  const path = generationLogPath(root, undefined, id, 3, 'zstd')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, await compressZstdFrame(JSON.stringify({ type: 'session', ...header }) + '\n'))
  const failure = new Error('actual decoder close failed')
  faults.forcePublic = decoderKind === 'public'
  faults.decoderClose = failure
  await expect(prepareCatalogFacts(parent, [{ header: header as never, path }], 'zstd', new AbortController().signal))
    .rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure, errors: [failure] })
  expect(faults.privateDecoder).toBe(decoderKind === 'private')
  expect(faults.decoderCloses).toBe(1)
  faults.decoderCloses = 0; faults.decoderRead = undefined; faults.abortOnDecoderClose = undefined
  await writeFile(path, Buffer.concat([
    await compressZstdFrame(JSON.stringify({ type: 'session', ...header }) + '\n'),
    await compressZstdFrame('{invalid json}\n' + JSON.stringify({ type: 'turn/end', seq: 0, time: 2,
      data: { turn: 1, reason: { kind: 'completed' } } }) + '\n'),
  ]))
  faults.decoderClose = failure
  const parserAbort = new AbortController(); faults.abortOnDecoderClose = parserAbort
  const [result] = await Promise.allSettled([
    prepareCatalogFacts(parent, [{ header: header as never, path }], 'zstd', parserAbort.signal),
  ])
  expect(result).toMatchObject({ status: 'rejected', reason: { name: 'JsonlReadCleanupError', cause: failure } })
  if (result?.status !== 'rejected' || !(result.reason instanceof AggregateError)) throw new Error('Expected cleanup failure')
  expect(result.reason.errors).toEqual([expect.any(Error), failure])
  expect(parserAbort.signal.aborted).toBe(true)
  expect(faults.decoderCloses).toBe(1)
  faults.decoderCloses = 0
  const readFailure = new Error('actual decoder read failed')
  faults.decoderRead = readFailure; faults.decoderClose = failure
  const abort = new AbortController(); faults.abortOnDecoderClose = abort
  await expect(prepareCatalogFacts(parent, [{ header: header as never, path }], 'zstd', abort.signal))
    .rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure, errors: [readFailure, failure] })
  expect(faults.decoderCloses).toBe(1)
  faults.decoderCloses = 0; faults.decoderRead = failure; faults.decoderClose = failure
  faults.abortOnDecoderClose = undefined
  await expect(prepareCatalogFacts(parent, [{ header: header as never, path }], 'zstd', new AbortController().signal))
    .rejects.toMatchObject({ name: 'JsonlReadCleanupError', cause: failure, errors: [failure, failure] })
  expect(faults.decoderCloses).toBe(1)
})
