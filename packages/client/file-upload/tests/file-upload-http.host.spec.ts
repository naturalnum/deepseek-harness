import { runInNewContext } from 'node:vm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { handleFileUploadHttp } from '../src/http-route.ts'
import { FileUploadIntakeUnconfirmedError, type FileUploads } from '../src/index.ts'

function request(input: {
  method?: string
  sessionId?: string
  name?: string
  mediaType?: string
  contentType?: string
  body?: Uint8Array
} = {}): Request {
  const query = new URLSearchParams()
  if (input.sessionId !== undefined) query.set('sessionId', input.sessionId)
  if (input.name !== undefined) query.set('name', input.name)
  if (input.mediaType !== undefined) query.set('mediaType', input.mediaType)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return new Request(`http://host/api/session/uploadFileBinary${suffix}`, {
    method: input.method ?? 'POST',
    headers: input.contentType === undefined ? {} : { 'content-type': input.contentType },
    ...(input.body === undefined ? {} : { body: new Blob([Uint8Array.from(input.body).buffer]) }),
  })
}

function uploads(result: unknown): FileUploads & {
  uploadStream: Mock<FileUploads['uploadStream']>
  uploadedChunks: Uint8Array[]
} {
  const uploadedChunks: Uint8Array[] = []
  const uploadStream = vi.fn<FileUploads['uploadStream']>(async (input) => {
    for await (const chunk of input.data) uploadedChunks.push(chunk)
    return await result as Awaited<ReturnType<FileUploads['uploadStream']>>
  })
  return {
    uploadedChunks,
    uploadStream,
  } as unknown as FileUploads & {
    uploadStream: Mock<FileUploads['uploadStream']>
    uploadedChunks: Uint8Array[]
  }
}

describe('background file upload Fetch route', () => {
  it('accepts one authenticated streaming POST request', async () => {
    const service = uploads(Promise.resolve({}))
    expect((await handleFileUploadHttp(service, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).status).toBe(200)
  })

  it('rejects the wrong method, media type, and missing Session id without storing', async () => {
    const service = uploads(Promise.resolve({}))
    const wrongMethod = await handleFileUploadHttp(service, request({ method: 'GET' }))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const wrongType = await handleFileUploadHttp(service, request({ contentType: 'application/json' }))
    expect(wrongType.status).toBe(415)
    expect(await wrongType.text()).toBe('content type must be application/octet-stream')

    const missingSession = await handleFileUploadHttp(
      service,
      request({ contentType: 'application/octet-stream' }),
    )
    expect(missingSession.status).toBe(400)
    expect(await missingSession.text()).toBe('sessionId is required')
    expect(service.uploadStream).not.toHaveBeenCalled()
  })

  it('stores the request bytes and returns the staged receipt', async () => {
    const value = {
      receiptId: 'receipt-1',
      file: { attachmentId: 'file-1', name: 'large & final.bin', bytes: 4 },
    }
    const service = uploads(Promise.resolve(value))
    const response = await handleFileUploadHttp(service, request({
      sessionId: 's1',
      name: 'large & final.bin',
      contentType: 'application/octet-stream; charset=binary',
      body: Uint8Array.of(1, 2, 3, 4),
    }))
    expect(service.uploadStream).toHaveBeenCalledOnce()
    const upload = service.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1', name: 'large & final.bin' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(service.uploadedChunks).toEqual([Uint8Array.of(1, 2, 3, 4)])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('stages the body as a prompt image when the request names its media type', async () => {
    const value: Awaited<ReturnType<FileUploads['uploadImageStream']>> = {
      receiptId: 'receipt-2' as never,
      image: { attachmentId: 'image-1' as never, mediaType: 'image/png', bytes: 2, width: 1, height: 1 },
    }
    const imageChunks: Uint8Array[] = []
    const uploadImageStream = vi.fn<FileUploads['uploadImageStream']>(async (input) => {
      for await (const chunk of input.data) imageChunks.push(chunk)
      return value
    })
    const service = Object.assign(uploads(Promise.resolve({})), { uploadImageStream })
    const response = await handleFileUploadHttp(service, request({
      sessionId: 's1', name: 'shot.png', mediaType: 'image/png',
      contentType: 'application/octet-stream', body: Uint8Array.of(7, 8),
    }))
    expect(service.uploadStream).not.toHaveBeenCalled()
    expect(uploadImageStream.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's1', name: 'shot.png', mediaType: 'image/png' })
    expect(imageChunks).toEqual([Uint8Array.of(7, 8)])
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('returns business and internal storage failures and keeps an absent name absent', async () => {
    const business = uploads(Promise.reject(new RemoteError(
      'session/attachment-invalid', 'denied', { reason: 'NOPE' },
    )))
    const businessResponse = await handleFileUploadHttp(business, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))
    expect(business.uploadStream).toHaveBeenCalledOnce()
    const upload = business.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(business.uploadedChunks).toEqual([])
    expect(await businessResponse.json()).toEqual({
      ok: false,
      error: { code: 'session/attachment-invalid', message: 'denied', details: { reason: 'NOPE' } },
    })

    const internal = uploads(Promise.reject(new Error('disk offline')))
    expect(await (await handleFileUploadHttp(internal, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'disk offline', details: {} },
    })

    const foreignError = runInNewContext('new Error("disk exception")') as unknown as Error
    const exception = uploads(Promise.reject(foreignError))
    expect(await (await handleFileUploadHttp(exception, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'Error: disk exception', details: {} },
    })
  })

  it('reports a typed unconfirmed service result with a structured reason', async () => {
    const service = uploads(Promise.reject(new FileUploadIntakeUnconfirmedError()))
    const response = await handleFileUploadHttp(service, request({ sessionId: 's1', contentType: 'application/octet-stream' }))
    expect(await response.json()).toEqual({ ok: false, error: { code: 'gateway/internal',
      message: 'File upload intake settlement is unconfirmed.', details: { reason: 'FILE_UPLOAD_INTAKE_UNCONFIRMED' } } })
  })


  it('cancels unread request bodies before each early route rejection', async () => {
    for (const [method, contentType, sessionId, expected] of [
      ['PUT', 'application/octet-stream', 's1', 405],
      ['POST', 'application/json', 's1', 415],
      ['POST', 'application/octet-stream', '', 400],
    ] as const) {
      let pulls = 0, cancels = 0
      const body = new ReadableStream<Uint8Array>({ pull() { pulls++ }, cancel() { cancels++ } }, { highWaterMark: 0 })
      const request = new Request(`http://fixture/upload?sessionId=${sessionId}`, {
        method, headers: { 'content-type': contentType }, body, duplex: 'half',
      } as RequestInit)
      const response = await handleFileUploadHttp(uploads(Promise.resolve({})), request)
      expect(response.status).toBe(expected)
      expect(pulls).toBe(0)
      expect(cancels).toBe(1)
    }
  })

  it('reports unconfirmed cleanup if cancellation fails before route validation', async () => {
    let cancels = 0
    const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; throw new Error('private path') } }, { highWaterMark: 0 })
    const request = new Request('http://fixture/upload?sessionId=s1', {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
    } as RequestInit)
    const response = await handleFileUploadHttp(uploads(Promise.resolve({})), request)
    expect(await response.json()).toEqual({ ok: false, error: { code: 'gateway/internal',
      message: 'File upload intake settlement is unconfirmed.', details: { reason: 'FILE_UPLOAD_INTAKE_UNCONFIRMED' } } })
    expect(cancels).toBe(1)
  })

  it('does not return a receipt when cleanup fails after the service resolves', async () => {
    const receipt = { receiptId: 'receipt-unknown', file: { attachmentId: 'id', name: 'f', bytes: 1 } }
    const uploadStream = vi.fn(async () => receipt)
    const service = { uploadStream } as unknown as FileUploads
    const body = new ReadableStream<Uint8Array>({ cancel() { throw new Error('cleanup failure') } }, { highWaterMark: 0 })
    const request = new Request('http://fixture/upload?sessionId=s1', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
    } as RequestInit)
    expect(await (await handleFileUploadHttp(service, request)).json()).toEqual({ ok: false, error: { code: 'gateway/internal',
      message: 'File upload intake settlement is unconfirmed.', details: { reason: 'FILE_UPLOAD_INTAKE_UNCONFIRMED' } } })
    expect(uploadStream).toHaveBeenCalledOnce()
  })

})

it('joins one real rejected cancel, releases the reader, and retains its cached unknown cause', async () => {
  const cause = new Error('private request cancellation failed')
  let cancels = 0
  const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; throw cause } }, { highWaterMark: 0 })
  const receipt = { receiptId: 'unpublished-receipt', file: { attachmentId: 'id', name: 'f', bytes: 1 } }
  const observations: FileUploadIntakeUnconfirmedError[] = []
  const service = {
    async uploadStream(input: Parameters<FileUploads['uploadStream']>[0]) {
      const iterator = input.data[Symbol.asyncIterator]()
      if (iterator.return === undefined) throw new Error('Original HTTP iterator has no close operation')
      const first = iterator.return()
      expect(iterator.return()).toBe(first)
      const error: unknown = await first.catch((failure: unknown) => failure)
      if (!(error instanceof FileUploadIntakeUnconfirmedError)) throw new Error('Actual cancel failure was not retained')
      observations.push(error)
      expect(error.cause).toBe(cause)
      expect(iterator.return()).toBe(first)
      return receipt
    },
  } as unknown as FileUploads
  const request = new Request('http://fixture/upload?sessionId=s1', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
  } as RequestInit)
  const result: unknown = await (await handleFileUploadHttp(service, request)).json()
  expect(result).toEqual({ ok: false, error: { code: 'gateway/internal',
    message: 'File upload intake settlement is unconfirmed.', details: { reason: 'FILE_UPLOAD_INTAKE_UNCONFIRMED' } } })
  expect(observations).toHaveLength(1)
  expect(observations[0]?.cause).toBe(cause)
  expect(cancels).toBe(1)
  expect(body.locked).toBe(false)
  expect(JSON.stringify(result)).not.toContain(cause.message)
})

it('releases an already errored request reader without inventing an underlying cancel failure', async () => {
  const failure = new Error('original body failure'), cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(failure) },
    cancel,
  }, { highWaterMark: 0 })
  const request = new Request('http://fixture/upload?sessionId=s1', {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half',
  } as RequestInit)
  const service = uploads(Promise.resolve({}))
  const response = await handleFileUploadHttp(service, request)
  expect(response.status).toBe(405)
  expect(service.uploadStream).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  expect(body.locked).toBe(false)
})
