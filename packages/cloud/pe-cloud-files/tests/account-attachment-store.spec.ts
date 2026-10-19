/** Real native stores; the finite trusted maps stand in only for future verified-copy lookup. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { AttachmentError, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { DEFAULT_IMAGE_COMPRESSION_CONCURRENCY, DEFAULT_MAX_IMAGE_BYTES, LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createAccountAttachmentStore } from '../src/account-attachment-store.ts'

const bytes = Uint8Array.of(0, 255, 13, 10, 128, 1)

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'cloud-attachment-store-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    try { for (const ctx of contexts.toReversed()) await ctx.fiber.dispose() }
    finally { await rm(home, { recursive: true, force: true }) }
  })
  const owner = (name: string, plugin = false) => {
    const ctx = new Context()
    contexts.push(ctx)
    const lifetime = new AbortController()
    const binding: AccountBinding = Object.freeze({ accountId: name as AccountId, epoch: '1' as OwnerEpoch,
      recipeVersion: 'test-only-native-attachments', lifetime: lifetime.signal })
    ctx.provide('peAccount', binding)
    let active = true
    const copies = new Map<FileAttachmentRef, string>()
    const mapFileHostPath = vi.fn((_caller: Context, ref: FileAttachmentRef) => copies.get(ref))
    const Store = createAccountAttachmentStore({ binding,
      assertCurrent: () => { if (!active) throw new Error('The test graph is no longer current') },
      assertInstalled: (caller) => { if (caller.root !== ctx) throw new Error('The test caller belongs to another graph') },
      mapFileHostPath,
    })
    const config = { dshHome: join(home, name, 'private') }
    const fiber = plugin ? ctx.plugin(Store, config) : undefined
    const direct = plugin ? undefined : new Store(ctx, config)
    const publishCopy = async (ref: FileAttachmentRef) => {
      const directory = join(home, name, 'project')
      await mkdir(directory, { recursive: true })
      const path = join(directory, ref.name)
      await writeFile(path, bytes)
      copies.set(ref, path)
      return path
    }
    return { ctx, binding, lifetime, Store, fiber, copies, mapFileHostPath, publishCopy,
      get store(): LocalAttachmentStore {
        const installed = direct ?? ctx.get('attachments')
        if (!(installed instanceof LocalAttachmentStore)) throw new Error('The native attachment provider is unavailable')
        return installed
      },
      revoke: () => { active = false } }
  }
  return { owner }
}

async function readOriginal(store: LocalAttachmentStore, ref: FileAttachmentRef): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of store.readFileStream(ref)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

it('activates through the real class-plugin constructor with inherited Config, one provider and native streams', async () => {
  const f = await fixture(), a = f.owner('plugin', true)
  const fiber = a.fiber
  if (fiber === undefined) throw new Error('The class-plugin fixture requires its real fiber')
  await fiber
  expect(fiber.state).toBe(FiberState.ACTIVE)
  const config: unknown = fiber.config
  expect(config).toMatchObject({ imageCompressionConcurrency: DEFAULT_IMAGE_COMPRESSION_CONCURRENCY,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES })
  const store = a.store
  expect(store.imageCompressionConcurrency).toBe(DEFAULT_IMAGE_COMPRESSION_CONCURRENCY)
  expect(store.imageLimits.maxImageBytes).toBe(DEFAULT_MAX_IMAGE_BYTES)
  const providers = [...a.ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
    .filter(current => current.store?.['attachments']?.fiber === current)
  expect(providers.map(current => current.uid)).toEqual([fiber.uid])
  const ref = await store.saveFileStream({ name: 'plugin.bin', data: (async function* () { yield bytes })() })
  const path = await a.publishCopy(ref)
  let callerUid: number | null | undefined
  await a.ctx.plugin({ inject: ['attachments'], apply(scope: Context) {
    callerUid = scope.fiber.uid
    expect(scope.attachments.fileHostPath(ref)).toBe(path)
  } })
  expect(a.mapFileHostPath.mock.calls[0]?.[0].fiber.uid).toBe(callerUid)
  await expect(readOriginal(store, ref)).resolves.toEqual(Buffer.from(bytes))
  expect(a.mapFileHostPath).toHaveBeenCalledOnce()
  await fiber.dispose()
  expect(a.ctx.get('attachments')).toBeUndefined()
  expect(() => store.fileHostPath(ref)).toThrow(AttachmentError)
  expect(a.mapFileHostPath).toHaveBeenCalledOnce()
})

it('delegates the complete native ref and actual caller to each account copy without mixing owners', async () => {
  const f = await fixture(), a = f.owner('A'), b = f.owner('B')
  const refA = await a.store.saveFile({ data: bytes, name: 'native.bin' })
  const refB = await b.store.saveFile({ data: bytes, name: 'native.bin' })
  expect(refA).toEqual(refB)
  const pathA = await a.publishCopy(refA), pathB = await b.publishCopy(refB)
  let caller: Context | undefined
  await a.ctx.plugin({ inject: ['attachments'], apply(scope: Context) {
    caller = scope
    expect(scope.attachments.fileHostPath(refA)).toBe(pathA)
  } })
  expect(a.mapFileHostPath).toHaveBeenCalledOnce()
  expect(a.mapFileHostPath.mock.calls[0]?.[0].fiber === caller?.fiber).toBe(true)
  expect(a.mapFileHostPath.mock.calls[0]?.[0].root === a.ctx).toBe(true)
  expect(a.mapFileHostPath.mock.calls[0]?.[1]).toBe(refA)
  expect(b.store.fileHostPath(refB)).toBe(pathB)
  expect(pathA).not.toBe(pathB)
  await expect(readFile(pathA)).resolves.toEqual(Buffer.from(bytes))
  expect(() => new a.Store(b.ctx, {})).toThrow(AttachmentError)
  expect(b.store.fileHostPath(refB)).toBe(pathB)
  expect(a.mapFileHostPath).toHaveBeenCalledOnce()
})

it('keeps native byte and streamed persistence readable from the original when no copy is available', async () => {
  const f = await fixture(), a = f.owner('A')
  const ref = await a.store.saveFile({ data: bytes, name: 'original.bin' })
  const streamed = await a.store.saveFileStream({ name: 'streamed.bin', data: (async function* () {
    yield bytes.subarray(0, 2)
    yield bytes.subarray(2)
  })() })
  expect(() => a.store.fileHostPath(ref)).toThrow(expect.objectContaining({ code: 'ATTACHMENT_PROJECTION_UNSUPPORTED' }))
  expect(a.mapFileHostPath).toHaveBeenCalledOnce()
  a.mapFileHostPath.mockImplementation(() => { throw new AttachmentError('No verified project copy.', 'ATTACHMENT_NOT_FOUND') })
  await expect(readOriginal(a.store, ref)).resolves.toEqual(Buffer.from(bytes))
  await expect(readOriginal(a.store, streamed)).resolves.toEqual(Buffer.from(bytes))
  expect(a.mapFileHostPath).toHaveBeenCalledOnce()
  expect(() => a.store.fileHostPath(ref)).toThrow(expect.objectContaining({ code: 'ATTACHMENT_NOT_FOUND' }))
})

it('rejects a noncanonical native ref before consulting the trusted map', async () => {
  const f = await fixture(), a = f.owner('A')
  const ref = await a.store.saveFile({ data: bytes, name: 'safe.bin' })
  await a.publishCopy(ref)
  expect(() => a.store.fileHostPath({ ...ref, name: '../escape.bin' }))
    .toThrow(expect.objectContaining({ code: 'INVALID_ATTACHMENT_REF' }))
  expect(a.mapFileHostPath).not.toHaveBeenCalled()
})

it('withdraws an available path when the graph is revoked, including during the synchronous map', async () => {
  const f = await fixture(), a = f.owner('A'), b = f.owner('B')
  const refA = await a.store.saveFile({ data: bytes, name: 'a.bin' })
  await a.publishCopy(refA)
  a.revoke()
  expect(() => a.store.fileHostPath(refA)).toThrow(AttachmentError)
  expect(a.mapFileHostPath).not.toHaveBeenCalled()
  const refB = await b.store.saveFile({ data: bytes, name: 'b.bin' })
  const pathB = await b.publishCopy(refB)
  b.mapFileHostPath.mockImplementation(() => { b.lifetime.abort(); return pathB })
  expect(() => b.store.fileHostPath(refB)).toThrow(AttachmentError)
  expect(b.mapFileHostPath).toHaveBeenCalledOnce()
})
