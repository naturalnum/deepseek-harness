/** Observe native attachment source descriptors at the public iterator's settlement. */
import { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { fstatSync } from 'node:fs'
import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { expect, it, onTestFinished, vi } from 'vitest'

interface ReadObservation {
  stream: import('node:fs').ReadStream
  fd?: number
  openIdentity?: { dev: number; ino: number }
  closeCount: number
  closeFdState?: string
  sourceErrorCode?: string
}

const observed = vi.hoisted(() => ({ reads: [] as ReadObservation[] }))

// Delegate every filesystem operation to Node; observe the provider's own stream.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    createReadStream(...args: Parameters<typeof fs.createReadStream>) {
      const stream = fs.createReadStream(...args)
      const observation: ReadObservation = { stream, closeCount: 0 }
      observed.reads.push(observation)
      stream.on('open', (fd) => {
        observation.fd = fd
        const { dev, ino } = fs.fstatSync(fd)
        observation.openIdentity = { dev, ino }
      })
      stream.on('error', (error) => {
        observation.sourceErrorCode = 'code' in error ? String(error.code) : error.name
      })
      stream.on('close', () => {
        observation.closeCount++
        observation.closeFdState = fdState(observation.fd, fs.fstatSync)
      })
      return stream
    },
  }
})

function fdState(fd: number | undefined, stat = fstatSync): string {
  if (fd === undefined) return 'never-opened'
  try {
    stat(fd)
    return 'open'
  } catch (error) {
    // Preserve the kernel error instead of treating every probe failure as closure.
    return error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
  }
}

async function fixture() {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-native-attachment-fd-'))
  const ctx = new Context()
  const store: AttachmentStore = new LocalAttachmentStore(ctx, { dshHome })
  const firstRead = observed.reads.length
  onTestFinished(async () => {
    const reads = observed.reads.slice(firstRead)
    for (const { stream } of reads) if (!stream.closed) stream.destroy()
    // Source failures are intentional; cleanup still waits for actual completion.
    await Promise.allSettled(reads.map(({ stream }) => finished(stream)))
    await ctx.fiber.dispose()
    await rm(dshHome, { recursive: true, force: true })
  })
  return { store, firstRead }
}

function source(firstRead: number): ReadObservation {
  expect(observed.reads.length).toBe(firstRead + 1)
  const observation = observed.reads[firstRead]
  if (observation === undefined) throw new Error('Native provider did not create a source stream')
  return observation
}

function assertClosedAtSettlement(label: string, observation: ReadObservation): void {
  const settlementFdState = fdState(observation.fd)
  console.info('native-attachment-fd', JSON.stringify({
    case: label, fd: observation.fd, openIdentity: observation.openIdentity,
    closeCount: observation.closeCount, closeFdState: observation.closeFdState,
    sourceErrorCode: observation.sourceErrorCode, settlementFdState,
    streamClosed: observation.stream.closed,
  }))
  expect(observation.openIdentity).toBeDefined()
  expect(observation.closeCount).toBe(1)
  expect(observation.closeFdState).toBe('EBADF')
  expect(observation.stream.closed).toBe(true)
  expect(settlementFdState).toBe('EBADF')
}

const data = Uint8Array.from({ length: (1 << 18) + 7 }, (_, index) => index % 251)

it.each([0, data.length])('native EOF closes the real source FD before settlement (%i bytes)', async (length) => {
  const { store, firstRead } = await fixture()
  const content = data.subarray(0, length)
  const ref = await store.saveFile({ data: content, name: 'eof.bin' })
  const chunks: Uint8Array[] = []
  for await (const chunk of store.readFileStream(ref)) {
    expect(chunk.byteLength).toBeLessThanOrEqual(1 << 16)
    chunks.push(chunk)
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(content))
  assertClosedAtSettlement(`eof-${length}`, source(firstRead))
})

it('native iterator.return closes an observed open source FD before resolving', async () => {
  const { store, firstRead } = await fixture()
  const ref = await store.saveFile({ data, name: 'return.bin' })
  const iterator = store.readFileStream(ref)[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  const observation = source(firstRead)
  expect(fdState(observation.fd)).toBe('open')
  if (iterator.return === undefined) throw new Error('Native iterator has no return method')
  expect((await iterator.return()).done).toBe(true)
  assertClosedAtSettlement('iterator-return', observation)
})

it('native abort closes an observed open source FD before rejecting with the caller reason', async () => {
  const { store, firstRead } = await fixture()
  const ref = await store.saveFile({ data, name: 'abort.bin' })
  const controller = new AbortController()
  const iterator = store.readFileStream(ref, controller.signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  const observation = source(firstRead)
  expect(fdState(observation.fd)).toBe('open')
  const reason = new Error('caller cancelled native source')
  controller.abort(reason)
  await expect(iterator.next()).rejects.toBe(reason)
  assertClosedAtSettlement('abort', observation)
})

it('native kernel read error closes its successfully opened directory FD before rejecting', async () => {
  const { store, firstRead } = await fixture()
  const ref = await store.saveFile({ data: Uint8Array.of(1), name: 'source-error.bin' })
  const path = store.fileHostPath(ref)
  if (path === undefined) throw new Error('Native local attachment has no host path')
  await unlink(path)
  await mkdir(path)
  const iterator = store.readFileStream(ref)[Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toMatchObject({
    code: 'ATTACHMENT_READ_FAILED', cause: { code: 'EISDIR' },
  })
  const observation = source(firstRead)
  expect(observation.sourceErrorCode).toBe('EISDIR')
  assertClosedAtSettlement('kernel-EISDIR', observation)
})

it('native post-EOF integrity rejection occurs after the real source FD closes', async () => {
  const { store, firstRead } = await fixture()
  const ref = await store.saveFile({ data, name: 'integrity.bin' })
  let bytes = 0
  const read = (async () => {
    for await (const chunk of store.readFileStream({ ...ref, bytes: ref.bytes + 1 })) bytes += chunk.byteLength
  })()
  await expect(read).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  expect(bytes).toBe(data.byteLength)
  assertClosedAtSettlement('integrity-after-EOF', source(firstRead))
})

it('native missing-source rejection waits for close without opening a source FD', async () => {
  const { store, firstRead } = await fixture()
  const ref = await store.saveFile({ data: Uint8Array.of(1), name: 'missing.bin' })
  const path = store.fileHostPath(ref)
  if (path === undefined) throw new Error('Native local attachment has no host path')
  await unlink(path)
  const iterator = store.readFileStream(ref)[Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  const observation = source(firstRead)
  console.info('native-attachment-fd', JSON.stringify({
    case: 'missing-ENOENT', fd: observation.fd, closeCount: observation.closeCount,
    closeFdState: observation.closeFdState, sourceErrorCode: observation.sourceErrorCode,
    settlementFdState: fdState(observation.fd), streamClosed: observation.stream.closed,
  }))
  expect(observation.fd).toBeUndefined()
  expect(observation.openIdentity).toBeUndefined()
  expect(observation.closeCount).toBe(1)
  expect(observation.closeFdState).toBe('never-opened')
  expect(observation.sourceErrorCode).toBe('ENOENT')
  expect(observation.stream.closed).toBe(true)
})
