import { createHash } from 'node:crypto'
import { constants, fstatSync } from 'node:fs'
import type { NoParamCallback, ReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { AttachmentCleanupError as PublicCleanupError } from '../src/index.ts'
import { AttachmentCleanupError, publishImmutableObject, publishImmutableObjectStream } from '../src/store.ts'

interface Controls {
  stageCloseError: Error | undefined
  directoryCloseError: Error | undefined
  digestCloseError: Error | undefined
  unlinkError: Error | undefined
  stageGate: Promise<void> | undefined
  digestGate: Promise<void> | undefined
  stageEntered: (() => void) | undefined
  digestEntered: (() => void) | undefined
  stageCloses: number
  directoryCloses: number
  digestCloses: number
  unlinks: number
  stageFds: number[]
  digestFds: number[]
  streams: ReadStream[]
  actualCleanup: Array<() => Promise<void>>
}

const io = vi.hoisted((): Controls => ({
  stageCloseError: undefined, directoryCloseError: undefined, digestCloseError: undefined, unlinkError: undefined,
  stageGate: undefined, digestGate: undefined, stageEntered: undefined, digestEntered: undefined,
  stageCloses: 0, directoryCloses: 0, digestCloses: 0, unlinks: 0,
  stageFds: [], digestFds: [], streams: [], actualCleanup: [],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      const handle = await actual.open(...args)
      const close = handle.close.bind(handle)
      let retained = false
      const staged = typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0
      if (staged) {
        io.stageFds.push(handle.fd)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          io.stageCloses++
          io.stageEntered?.()
          if (io.stageGate !== undefined) await io.stageGate
          if (io.stageCloseError !== undefined) {
            if (!retained) { io.actualCleanup.push(close); retained = true }
            throw io.stageCloseError
          }
          await close()
        })
      } else if (io.directoryCloseError !== undefined) {
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          io.directoryCloses++
          if (!retained) { io.actualCleanup.push(close); retained = true }
          throw io.directoryCloseError
        })
      }
      return handle
    },
    async unlink(...args: Parameters<typeof actual.unlink>): ReturnType<typeof actual.unlink> {
      io.unlinks++
      if (io.unlinkError !== undefined) throw io.unlinkError
      await actual.unlink(...args)
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream(...args: Parameters<typeof actual.createReadStream>): ReturnType<typeof actual.createReadStream> {
      const stream = actual.createReadStream(...args)
      io.streams.push(stream)
      return stream
    },
    close(fd: number, callback: NoParamCallback): void {
      io.digestCloses++
      io.digestFds.push(fd)
      io.digestEntered?.()
      if (io.digestCloseError !== undefined) {
        io.actualCleanup.push(() => new Promise<void>((resolve, reject) => {
          actual.close(fd, (error) => {
            if (error === null) resolve()
            else reject(error)
          })
        }))
        callback(io.digestCloseError)
      } else if (io.digestGate !== undefined) {
        void io.digestGate.then(() => { actual.close(fd, callback) })
      } else {
        actual.close(fd, callback)
      }
    },
  }
})

const roots: string[] = []
const gates: Array<() => void> = []

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => { throw new Error('Gate not initialized') }
  const promise = new Promise<void>((resolve) => { release = resolve })
  gates.push(release)
  return { promise, release }
}

async function setup(): Promise<{ root: string; target: string; data: Uint8Array; digest: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-cleanup-'))
  roots.push(home)
  const root = join(home, 'attachments', 'v1')
  const data = Uint8Array.of(0, 1, 254, 255)
  const digest = createHash('sha256').update(data).digest('hex')
  return { root, data, digest, target: join(root, 'file-objects', digest.slice(0, 2), digest) }
}

function observed<T>(values: readonly T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error('The actual IO observation is missing')
  return value
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
  try { await operation } catch (error) { return error }
  throw new Error('Operation unexpectedly resolved')
}

afterEach(async () => {
  for (const release of gates.splice(0)) release()
  for (const close of io.actualCleanup.splice(0)) await close() // Test-only reclamation after proving an actual FD remains open.
  vi.restoreAllMocks()
  io.stageCloseError = io.directoryCloseError = io.digestCloseError = io.unlinkError = undefined
  io.stageGate = io.digestGate = undefined
  io.stageEntered = io.digestEntered = undefined
  io.stageCloses = io.directoryCloses = io.digestCloses = io.unlinks = 0
  io.stageFds.length = io.digestFds.length = io.streams.length = 0
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('attachment store actual cleanup settlement', () => {
  it('exports one cleanup error with the existing write-failure routing code and original cause', () => {
    const cause = new Error('close failed')
    const error = new AttachmentCleanupError(cause)
    expect(PublicCleanupError).toBe(AttachmentCleanupError)
    expect(error).toBeInstanceOf(AttachmentError)
    expect(error).toMatchObject({ name: 'AttachmentCleanupError', code: 'ATTACHMENT_WRITE_FAILED', cause })
  })

  it('preserves cancellation identity only after actual stage close and temporary cleanup finish', async () => {
    const value = await setup()
    const controller = new AbortController()
    const reason = new Error('cancel source')
    const entered = gate(), closing = gate()
    io.stageEntered = entered.release
    io.stageGate = closing.promise
    async function* source(): AsyncIterable<Uint8Array> { yield value.data; controller.abort(reason); yield value.data }
    let settled = false
    const operation = rejected(publishImmutableObjectStream(value.root, source(), () => value.target, controller.signal))
      .then((error) => { settled = true; return error })
    await entered.promise
    expect(settled).toBe(false)
    expect(fstatSync(observed(io.stageFds)).isFile()).toBe(true)
    closing.release()
    expect(await operation).toBe(reason)
    expect(() => fstatSync(observed(io.stageFds))).toThrow()
    expect(await readdir(join(value.root, 'tmp'))).toEqual([])
    expect(io.stageCloses).toBe(1)
  })

  it('reports a failed successful-path close without retrying it or pretending the real FD is closed', async () => {
    const value = await setup()
    const cause = new Error('stage close failed')
    io.stageCloseError = cause
    const error = await rejected(publishImmutableObject(value.root, value.target, value.data, value.digest))
    expect(error).toBeInstanceOf(AttachmentCleanupError)
    expect(error).toHaveProperty('cause', cause)
    expect(io.stageCloses).toBe(1)
    expect(fstatSync(observed(io.stageFds)).isFile()).toBe(true)
    expect(await readdir(join(value.root, 'tmp'))).toEqual([])
  })

  it('retains the original source error beside cleanup-close failure', async () => {
    const value = await setup()
    const original = new AttachmentError('source failed', 'ATTACHMENT_CORRUPT')
    const closeError = new Error('cleanup close failed')
    io.stageCloseError = closeError
    async function* source(): AsyncIterable<Uint8Array> { yield value.data; throw original }
    const error = await rejected(publishImmutableObjectStream(value.root, source(), () => value.target))
    if (!(error instanceof AttachmentCleanupError) || !(error.cause instanceof AggregateError)) throw error
    expect(error.cause.errors[0]).toBe(original)
    expect(error.cause.errors[1]).toHaveProperty('cause', closeError)
    expect(io.stageCloses).toBe(1)
    expect(fstatSync(observed(io.stageFds)).isFile()).toBe(true)
  })

  it('preserves an ordinary AttachmentError when its actual cleanup succeeds', async () => {
    const value = await setup()
    const original = new AttachmentError('source rejected', 'ATTACHMENT_CORRUPT')
    async function* source(): AsyncIterable<Uint8Array> { yield value.data; throw original }
    expect(await rejected(publishImmutableObjectStream(value.root, source(), () => value.target))).toBe(original)
    expect(() => fstatSync(observed(io.stageFds))).toThrow()
    expect(await readdir(join(value.root, 'tmp'))).toEqual([])
  })

  it('distinguishes failed temporary unlink while the original source error and closed FD remain observable', async () => {
    const value = await setup()
    const original = new Error('source interrupted')
    const cleanup = new Error('temporary unlink failed')
    io.unlinkError = cleanup
    async function* source(): AsyncIterable<Uint8Array> { yield value.data; throw original }
    const error = await rejected(publishImmutableObjectStream(value.root, source(), () => value.target))
    if (!(error instanceof AttachmentCleanupError) || !(error.cause instanceof AggregateError)) throw error
    expect(error.cause.errors[0]).toBe(original)
    expect(error.cause.errors[1]).toHaveProperty('cause', cleanup)
    expect(() => fstatSync(observed(io.stageFds))).toThrow()
    expect((await readdir(join(value.root, 'tmp'))).length).toBe(1)
    expect(io.unlinks).toBe(1)
  })

  it('does not retry failed post-link cleanup or roll back the already published private object', async () => {
    const value = await setup()
    const cause = new Error('post-link temporary unlink failed')
    io.unlinkError = cause
    const error = await rejected(publishImmutableObject(value.root, value.target, value.data, value.digest))
    expect(error).toBeInstanceOf(AttachmentCleanupError)
    expect(error).toHaveProperty('cause', cause)
    expect(io.unlinks).toBe(1)
    expect(new Uint8Array(await readFile(value.target))).toEqual(value.data)
    expect((await readdir(join(value.root, 'tmp'))).length).toBe(1)
  })

  it('waits for the real digest stream close before deduplication resolves', async () => {
    const value = await setup()
    await publishImmutableObject(value.root, value.target, value.data, value.digest)
    const entered = gate(), closing = gate()
    io.digestEntered = entered.release
    io.digestGate = closing.promise
    let settled = false
    const operation = publishImmutableObject(value.root, value.target, value.data, value.digest).then(() => { settled = true })
    await entered.promise
    expect(settled).toBe(false)
    expect(fstatSync(observed(io.digestFds)).isFile()).toBe(true)
    closing.release()
    await operation
    expect(observed(io.streams).closed).toBe(true)
    expect(() => fstatSync(observed(io.digestFds))).toThrow()
  })

  it('exposes digest close failure with the existing private object retained and its FD still owned', async () => {
    const value = await setup()
    await publishImmutableObject(value.root, value.target, value.data, value.digest)
    io.digestCloseError = new Error('digest close failed')
    const error = await rejected(publishImmutableObject(value.root, value.target, value.data, value.digest))
    expect(error).toBeInstanceOf(AttachmentCleanupError)
    expect(error).toHaveProperty('cause', io.digestCloseError)
    expect(io.digestCloses).toBe(1)
    expect(fstatSync(observed(io.digestFds)).isFile()).toBe(true)
    expect(new Uint8Array(await readFile(value.target))).toEqual(value.data)
    expect(await readdir(join(value.root, 'tmp'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('classifies directory-handle close failure without retry', async () => {
    const value = await setup()
    io.directoryCloseError = new Error('directory close failed')
    const error = await rejected(publishImmutableObject(value.root, value.target, value.data, value.digest))
    expect(error).toBeInstanceOf(AttachmentCleanupError)
    expect(error).toHaveProperty('cause', io.directoryCloseError)
    expect(io.directoryCloses).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('waits for actual digest close after a real directory read failure', async () => {
    const value = await setup()
    await mkdir(value.target, { recursive: true })
    const entered = gate(), closing = gate()
    io.digestEntered = entered.release
    io.digestGate = closing.promise
    let settled = false
    const operation = rejected(publishImmutableObject(value.root, value.target, value.data, value.digest))
      .then((error) => { settled = true; return error })
    await entered.promise
    expect(settled).toBe(false)
    expect(fstatSync(observed(io.digestFds)).isDirectory()).toBe(true)
    closing.release()
    const error = await operation
    expect(error).toBeInstanceOf(AttachmentError)
    expect(error).not.toBeInstanceOf(AttachmentCleanupError)
    expect(() => fstatSync(observed(io.digestFds))).toThrow()
    expect(await readdir(join(value.root, 'tmp'))).toEqual([])
  })
})
