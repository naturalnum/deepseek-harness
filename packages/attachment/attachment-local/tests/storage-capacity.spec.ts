/** Actual native staging descriptors and cleanup; only individual filesystem failures are injected. */
import { constants, fstatSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { AttachmentStorageCapacityError as PublicCapacityError } from '../src/index.ts'
import { AttachmentCleanupError, AttachmentPublicationUnconfirmedError, AttachmentStorageCapacityError,
  publishImmutableObjectStream } from '../src/store.ts'
import { saveFileStreamVerbatim } from '../src/file-store.ts'

const io = vi.hoisted(() => ({ phase: '' as string, code: 'ENOSPC', fault: undefined as Error | undefined,
  closeFault: undefined as Error | undefined, unlinkFault: undefined as Error | undefined,
  beforeFailure: undefined as (() => void) | undefined, closeGate: undefined as Promise<void> | undefined,
  closeEntered: undefined as (() => void) | undefined, fd: -1, closes: 0, unlinks: 0, writes: 0, links: 0,
  reclaim: [] as Array<() => Promise<void>> }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const fail = (phase: string): void => {
    if (io.phase !== phase) return
    io.beforeFailure?.()
    throw io.fault ??= Object.assign(new Error('owned I/O failed'), { code: io.code })
  }
  return { ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const stage = typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0
      if (stage) fail('open')
      const handle = await actual.open(...args)
      if (stage) {
        io.fd = handle.fd
        const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...values) => { io.writes++; fail('write'); await write(...values) })
        vi.spyOn(handle, 'sync').mockImplementation(async () => { fail('sync'); await sync() })
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          io.closes++; io.closeEntered?.(); await io.closeGate
          if (io.closeFault !== undefined) { io.reclaim.push(close); throw io.closeFault }
          await close()
        })
      }
      return handle
    },
    async unlink(...args: Parameters<typeof actual.unlink>) {
      io.unlinks++
      if (io.unlinkFault !== undefined) throw io.unlinkFault
      await actual.unlink(...args)
    },
    async link(...args: Parameters<typeof actual.link>) {
      io.links++; fail(io.links === 1 ? 'link' : 'alias'); await actual.link(...args)
    },
  }
})
const homes: string[] = []
afterEach(async () => {
  for (const close of io.reclaim.splice(0)) await close()
  vi.restoreAllMocks()
  io.phase = ''; io.code = 'ENOSPC'; io.fault = io.closeFault = io.unlinkFault = undefined
  io.beforeFailure = io.closeEntered = undefined; io.closeGate = undefined
  io.fd = -1; io.closes = io.unlinks = io.writes = io.links = 0
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'native-capacity-')); homes.push(home)
  return { root: join(home, 'attachments', 'v1'), target: join(home, 'attachments', 'v1', 'object') }
}
async function* chunks() { yield Uint8Array.of(1) }
async function rejected(work: Promise<unknown>): Promise<unknown> {
  try { await work } catch (cause) { return cause }
  throw Error('Unexpected publication')
}

it.each(['ENOSPC', 'EDQUOT'])('waits for source return, real close and unlink before write %s is classified', async (code) => {
  const f = await setup(), closing = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  io.phase = 'write'; io.code = code; io.closeGate = closing.promise; io.closeEntered = () => { entered.resolve(undefined) }
  let sourceClosed = false, settled = false
  async function* data() { try { yield Uint8Array.of(1, 2, 3) } finally { await Promise.resolve(); sourceClosed = true } }
  const operation = rejected(publishImmutableObjectStream(f.root, data(), () => f.target)).then((error) => { settled = true; return error })
  await entered.promise
  expect(sourceClosed).toBe(true); expect(settled).toBe(false); expect(fstatSync(io.fd).isFile()).toBe(true)
  closing.resolve(undefined)
  const error = await operation
  expect(PublicCapacityError).toBe(AttachmentStorageCapacityError)
  expect(error).toBeInstanceOf(AttachmentStorageCapacityError)
  expect(error).toMatchObject({ code: 'ATTACHMENT_STORAGE_CAPACITY', phase: 'write', cause: io.fault })
  expect(() => fstatSync(io.fd)).toThrow(); expect(await readdir(join(f.root, 'tmp'))).toEqual([])
  expect(io.closes).toBe(1); expect(io.unlinks).toBe(1)
})
it.each(['open', 'sync'])('identifies owned %s separately from source-open evidence', async (phase) => {
  const f = await setup(); io.phase = phase
  let pulled = false
  async function* data() { pulled = true; yield Uint8Array.of(9) }
  const error = await rejected(publishImmutableObjectStream(f.root, data(), () => f.target))
  expect(error).toMatchObject({ code: 'ATTACHMENT_STORAGE_CAPACITY', phase, cause: io.fault })
  expect(pulled).toBe(phase !== 'open')
  expect(io.closes).toBe(phase === 'open' ? 0 : 1)
  expect(await readdir(join(f.root, 'tmp'))).toEqual([])
})
it.each(['ENOSPC', 'EDQUOT'])('does not classify a source exception spoofing %s', async (code) => {
  const f = await setup(), cause = Object.assign(Error('source failed'), { code })
  async function* data() { yield Uint8Array.of(9); throw cause }
  const error = await rejected(publishImmutableObjectStream(f.root, data(), () => f.target))
  expect(error).toBeInstanceOf(AttachmentError); expect(error).not.toBeInstanceOf(AttachmentStorageCapacityError)
  expect(error).toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED', cause })
  expect(io.closes).toBe(1); expect(await readdir(join(f.root, 'tmp'))).toEqual([])
})
it('keeps non-capacity I/O generic and does not classify text or nested errno', async () => {
  const f = await setup(); io.phase = 'write'; io.fault = Object.assign(Error('ENOSPC'), { code: 'EIO', cause: { code: 'ENOSPC' } })
  expect(await rejected(publishImmutableObjectStream(f.root, chunks(), () => f.target)))
    .toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED', cause: io.fault })
})
it.each(['close', 'unlink'])('keeps write capacity plus %s failure unknown, with both original causes', async (cleanup) => {
  const f = await setup(); io.phase = 'write'
  const cause = Error('original cleanup failed')
  if (cleanup === 'close') io.closeFault = cause
  else io.unlinkFault = cause
  const error = await rejected(publishImmutableObjectStream(f.root, chunks(), () => f.target))
  expect(error).toBeInstanceOf(AttachmentCleanupError)
  expect(error).toMatchObject({ settlement: 'unknown', code: 'ATTACHMENT_WRITE_FAILED' })
  if (!(error instanceof AttachmentCleanupError) || !(error.cause instanceof AggregateError)) throw error
  expect(error.cause.errors[0]).toBe(io.fault); expect(error.cause.errors[1]).toHaveProperty('cause', cause)
  expect(io.closes).toBe(1); expect(io.unlinks).toBe(1)
})
it('keeps abort ahead of storage-capacity classification', async () => {
  const f = await setup(), abort = new AbortController(), reason = Error('original cancel')
  io.phase = 'write'; io.beforeFailure = () => { abort.abort(reason) }
  const error = await rejected(publishImmutableObjectStream(f.root, chunks(), () => f.target, abort.signal))
  expect(error).toBe(io.fault); expect(error).not.toBeInstanceOf(AttachmentStorageCapacityError)
  expect(io.closes).toBe(1); expect(await readdir(join(f.root, 'tmp'))).toEqual([])
})
it('limits its marker to owned storage when for-await preserves write failure over a throwing source return', async () => {
  const f = await setup(), cause = Error('source return unconfirmed'); io.phase = 'write'
  async function* data() { try { yield Uint8Array.of(1) } finally { throw cause } }
  // for-await preserves its original write failure if the IteratorClose also throws.
  // The Cloud input owner separately joins source return and retains its failure; this Native helper does not claim source closure.
  expect(await rejected(publishImmutableObjectStream(f.root, data(), () => f.target))).toMatchObject({ phase: 'write', cause: io.fault })
})
it.each(['link', 'alias'])('never classifies %s capacity as confirmed storage refusal after publication was attempted', async (phase) => {
  const f = await setup(); io.phase = phase
  const error = await rejected(saveFileStreamVerbatim(f.root, { data: chunks(), name: 'test.bin' }))
  expect(error).toBeInstanceOf(AttachmentPublicationUnconfirmedError)
  expect(error).toMatchObject({ settlement: 'unknown', code: 'ATTACHMENT_WRITE_FAILED' })
})
