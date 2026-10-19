import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import * as uploadClient from '../src/client/index.ts'
import type { ClientFileUploadHooks, FileUploadFetch } from '../src/types.ts'

interface UploadGlobal {
  __DSH_FILE_UPLOAD__?: ClientFileUploadHooks
}

const contexts: Context[] = []
const SESSION = 'same-session' as SessionId

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  delete (globalThis as UploadGlobal).__DSH_FILE_UPLOAD__
  vi.restoreAllMocks()
})

function receipt(label: string, bytes = 4): Response {
  return new Response(JSON.stringify({
    ok: true,
    value: { receiptId: `receipt-${label}`, file: { attachmentId: `file-${label}`, name: 'file.bin', bytes } },
  }))
}

async function mounted(hooks?: ClientFileUploadHooks) {
  const ctx = new Context()
  contexts.push(ctx)
  const remote = vi.fn(() => Promise.reject(new Error('Unexpected encoded upload')))
  ctx.provide('remote', { fileUploads: { upload: remote } } as never)
  if (hooks !== undefined) ctx.provide('fileUploadHooks', hooks)
  await ctx.plugin(uploadClient)
  return { ctx, service: ctx.fileUpload, remote }
}

describe('instance-owned raw upload fetch', () => {
  it('keeps two Context carriers separate for the same Session and ignores the legacy global', async () => {
    const legacy = vi.fn<FileUploadFetch>(() => Promise.resolve(receipt('global')))
    ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = { fetch: legacy }
    const fetchA = vi.fn<FileUploadFetch>(() => Promise.resolve(receipt('A')))
    const fetchB = vi.fn<FileUploadFetch>(() => Promise.resolve(receipt('B')))
    const a = await mounted({ fetch: fetchA })
    const b = await mounted({ fetch: fetchB })
    const bodyA = new File(['data'], 'a.bin')
    const bodyB = new Blob(['data'])
    const [resultA, resultB] = await Promise.all([
      a.service.upload(SESSION, bodyA, 'a.bin'), b.service.upload(SESSION, bodyB, 'b.bin'),
    ])
    expect(resultA).toMatchObject({ ok: true, value: { receiptId: 'receipt-A' } })
    expect(resultB).toMatchObject({ ok: true, value: { receiptId: 'receipt-B' } })
    expect(fetchA.mock.calls[0]?.[1].body).toBe(bodyA)
    expect(fetchB.mock.calls[0]?.[1].body).toBe(bodyB)
    expect(fetchA).toHaveBeenCalledOnce()
    expect(fetchB).toHaveBeenCalledOnce()
    expect(legacy).not.toHaveBeenCalled()
    expect(a.remote).not.toHaveBeenCalled()
    expect(b.remote).not.toHaveBeenCalled()
  })

  it('captures the function before dependency objects and global hooks are replaced', async () => {
    const original = vi.fn<FileUploadFetch>(() => Promise.resolve(receipt('original')))
    const replacement = vi.fn<FileUploadFetch>(() => Promise.resolve(receipt('replacement')))
    const hooks = { fetch: original }
    const instance = await mounted(hooks)
    hooks.fetch = replacement
    ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = { fetch: replacement }
    await expect(instance.service.upload(SESSION, new Blob()))
      .resolves.toMatchObject({ value: { receiptId: 'receipt-original' } })
    expect(replacement).not.toHaveBeenCalled()
  })

  it('retains the legacy one-time global capture when no instance input is installed', async () => {
    const original = vi.fn<FileUploadFetch>(() => Promise.resolve(receipt('legacy')))
    const replacement = vi.fn<FileUploadFetch>(() => Promise.resolve(receipt('later')))
    ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = { fetch: original }
    const instance = await mounted()
    ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = { fetch: replacement }
    await expect(instance.service.upload(SESSION, new Blob()))
      .resolves.toMatchObject({ value: { receiptId: 'receipt-legacy' } })
    expect(replacement).not.toHaveBeenCalled()
  })

  it('passes the exact File, raw route, signal and headers without synthetic Fetch progress', async () => {
    const fetch = vi.fn<FileUploadFetch>(() => Promise.resolve(receipt('file')))
    const instance = await mounted({ fetch })
    const body = new File(['data'], 'notes & refs.bin', { type: 'application/octet-stream' })
    const progress = vi.fn()
    const signal = new AbortController().signal
    await expect(instance.service.upload(SESSION, body, body.name, signal, progress))
      .resolves.toMatchObject({ ok: true, value: { file: { bytes: 4 } } })
    expect(fetch).toHaveBeenCalledWith(
      'api/session/uploadFileBinary?sessionId=same-session&name=notes+%26+refs.bin',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, signal },
    )
    expect(progress).not.toHaveBeenCalled()
  })

  it('hands the original one-shot stream to the carrier with native duplex semantics', async () => {
    const chunks: number[][] = []
    const fetch = vi.fn<FileUploadFetch>(async (_input, init) => {
      if (!(init.body instanceof ReadableStream)) throw new Error('Expected the original stream')
      for await (const chunk of init.body) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Expected native byte chunks')
        chunks.push([...chunk])
      }
      return receipt('stream', 3)
    })
    const instance = await mounted({ fetch })
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Uint8Array.of(0, 255))
      controller.enqueue(Uint8Array.of(7))
      controller.close()
    } })
    await expect(instance.service.upload(SESSION, stream)).resolves.toMatchObject({ ok: true })
    expect(fetch.mock.calls[0]?.[1].body).toBe(stream)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ duplex: 'half' })
    expect(chunks).toEqual([[0, 255], [7]])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps a revoked owner pending until its captured carrier settles and never redirects to B', async () => {
    const lifetime = new AbortController()
    const late = Promise.withResolvers<Response>()
    const revoked = new Error('fixture page A revoked')
    const fetchA = vi.fn<FileUploadFetch>(async () => {
      lifetime.signal.throwIfAborted()
      const response = await late.promise
      lifetime.signal.throwIfAborted()
      return response
    })
    const a = await mounted({ fetch: fetchA })
    const fetchB = vi.fn<FileUploadFetch>(() => Promise.resolve(receipt('B')))
    const b = await mounted({ fetch: fetchB })
    let settled = false
    const pending = a.service.upload(SESSION, new Blob()).finally(() => { settled = true })
    const rejected = expect(pending).rejects.toBe(revoked)
    lifetime.abort(revoked)
    await a.ctx.fiber.dispose()
    expect(a.ctx.get('fileUpload')).toBeUndefined()
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(b.service.upload(SESSION, new Blob())).resolves.toMatchObject({ ok: true })
    late.resolve(receipt('late-A'))
    await rejected
    await expect(a.service.upload(SESSION, new Blob())).rejects.toBe(revoked)
    expect(fetchA).toHaveBeenCalledTimes(2)
    expect(fetchB).toHaveBeenCalledOnce()
  })

  it('forwards caller abort and waits for an ignoring carrier before exposing its late rejection', async () => {
    const control = new AbortController()
    const aborted = new Error('caller withdrew')
    const release = Promise.withResolvers<undefined>()
    const fetch = vi.fn<FileUploadFetch>(async (_input, init) => {
      await release.promise
      init.signal?.throwIfAborted()
      return receipt('unused')
    })
    const instance = await mounted({ fetch })
    let settled = false
    const pending = instance.service.upload(SESSION, new Blob(), undefined, control.signal)
      .finally(() => { settled = true })
    const rejected = expect(pending).rejects.toBe(aborted)
    control.abort(aborted)
    await Promise.resolve()
    expect(fetch.mock.calls[0]?.[1].signal).toBe(control.signal)
    expect(settled).toBe(false)
    release.resolve(undefined)
    await rejected
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('returns the original unknown carrier failure without a retry or Remote fallback', async () => {
    const failure = new Error('upload outcome unknown')
    const fetch = vi.fn<FileUploadFetch>(() => Promise.reject(failure))
    const instance = await mounted({ fetch })
    await expect(instance.service.upload(SESSION, new Blob())).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledOnce()
    expect(instance.remote).not.toHaveBeenCalled()
  })
})
