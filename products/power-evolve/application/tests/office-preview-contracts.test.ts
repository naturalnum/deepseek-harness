/** Office wire validation at file/HTTP boundaries; no converter, Platform or Pod is simulated as an acceptance result. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { officePreviewPrepareRequest, officePreviewCancelRequest, officePreviewJobSchema, officePreviewResultSchema, officePreviewFailureSchema,
  officePreviewContentView, officePreviewJobView, OFFICE_PREVIEW_MAX_OUTPUT_BYTES,
} from '@power-evolve/contracts/office-preview'

const digest = 'a'.repeat(64)
const identity = { jobId: randomUUID(), nonce: randomUUID(), generation: digest }
const limits = {
  inputBytes: 2 * 1024 * 1024, outputBytes: OFFICE_PREVIEW_MAX_OUTPUT_BYTES, timeoutMs: 120_000,
  archiveEntries: 1000, uncompressedBytes: 32 * 1024 * 1024, fontLoadedBytes: 128 * 1024 * 1024,
  pages: 100, fontFiles: 5000, fontFileBytes: 64 * 1024 * 1024,
  fontResolutionEntries: 10_000, imageResolution: 150,
}
const job = { protocolVersion: 1, ...identity, sourceSha256: digest, sourceBytes: 1232, extension: 'docx', limits }
const content = (bytes: Buffer) => ({ absolutePath: '/workspace/report.docx', version: digest,
  bytes: bytes.length, offset: 0, eof: true, data: bytes.toString('base64'),
  missingFonts: ['缺失字体'], generation: digest, pdfSha256: digest })

test('admission preserves native RPC keys and rejects authority fields or escaping paths', () => {
  const input = { requestId: 'native:17', sessionId: randomUUID(), path: '报告/材料.docx', priority: 'foreground', generation: digest }
  assert.equal(officePreviewPrepareRequest.parse(input).requestId, input.requestId)
  for (const path of ['../other.docx', '/private/a.docx', 'x/../y.docx', 'C:\\x.docx']) {
    assert.equal(officePreviewPrepareRequest.safeParse({ ...input, path }).success, false)
  }
  for (const extra of [{ userId: randomUUID() }, { image: 'other' }, { root: '/private' }]) {
    assert.equal(officePreviewPrepareRequest.safeParse({ ...input, ...extra }).success, false)
  }
  assert.equal(officePreviewPrepareRequest.safeParse({ ...input, requestId: 'id\nnext' }).success, false)
})

test('parser task freezes every budget and rejects oversized source or user execution selection', () => {
  assert.equal(officePreviewJobSchema.parse(job).extension, 'docx')
  assert.equal(officePreviewJobSchema.safeParse({ ...job, sourceBytes: limits.inputBytes + 1 }).success, false)
  assert.equal(officePreviewJobSchema.safeParse({ ...job, sourceBytes: 2000, limits: { ...limits, inputBytes: 1000 } }).success, false)
  assert.equal(officePreviewJobSchema.safeParse({ ...job, command: 'bash' }).success, false)
  assert.equal(officePreviewJobSchema.safeParse({ ...job, limits: { ...limits, outputBytes: OFFICE_PREVIEW_MAX_OUTPUT_BYTES + 1 } }).success, false)
  assert.equal(officePreviewJobSchema.safeParse({ ...job, limits: { ...limits, timeoutMs: undefined } }).success, false)
  assert.equal(officePreviewJobSchema.safeParse({ ...job, protocolVersion: 2 }).success, false)
})

test('lost admission replies can cancel by the original key without guessing an execution id', () => {
  assert.deepEqual(officePreviewCancelRequest.parse({ requestId: 'native:17', generation: digest }),
    { requestId: 'native:17', generation: digest })
  assert.equal(officePreviewCancelRequest.safeParse({ jobId: identity.jobId, generation: digest }).success, true)
  assert.equal(officePreviewCancelRequest.safeParse({ requestId: 'native:17', jobId: identity.jobId, generation: digest }).success, false)
  assert.equal(officePreviewCancelRequest.safeParse({ requestId: 'native:17', generation: digest, userId: randomUUID() }).success, false)
})

test('complete content has canonical exact-length bytes and only a virtual source path', () => {
  for (const bytes of [Buffer.from('f'), Buffer.from('fo'), Buffer.from('foo')]) {
    assert.equal(officePreviewContentView.parse(content(bytes)).bytes, bytes.length)
  }
  const valid = content(Buffer.from('f'))
  for (const data of ['Zh==', 'Zg=', 'Zg===', 'Z g==']) {
    assert.equal(officePreviewContentView.safeParse({ ...valid, data }).success, false)
  }
  assert.equal(officePreviewContentView.safeParse({ ...valid, bytes: 2 }).success, false)
  assert.equal(officePreviewContentView.safeParse({ ...valid, absolutePath: '/workspace/../private/key' }).success, false)
  assert.equal(officePreviewContentView.safeParse({ ...valid, absolutePath: '/home/runner/result.pdf' }).success, false)
  assert.equal(officePreviewContentView.safeParse({ ...valid, eof: false }).success, false)
})

test('the full PDF wire ceiling is accepted without an unbounded or nested base64 expression', () => {
  assert.equal(officePreviewContentView.parse(content(Buffer.alloc(OFFICE_PREVIEW_MAX_OUTPUT_BYTES))).bytes, OFFICE_PREVIEW_MAX_OUTPUT_BYTES)
  assert.equal(officePreviewContentView.safeParse(content(Buffer.alloc(OFFICE_PREVIEW_MAX_OUTPUT_BYTES + 1))).success, false)
})

test('result markers remain WASM facts and terminal states classify failure without diagnostics', () => {
  const result = { protocolVersion: 1, ...identity, sourceSha256: digest, pdfSha256: digest,
    pdfBytes: 30066, pages: 1, missingFonts: ['PE Prototype Missing Font'], backend: 'wasm' }
  assert.equal(officePreviewResultSchema.parse(result).pages, 1)
  assert.equal(officePreviewResultSchema.safeParse({ ...result, backend: 'native' }).success, false)
  assert.equal(officePreviewResultSchema.safeParse({ ...result, podStopped: true }).success, false)
  const failure = { protocolVersion: 1, ...identity, sourceSha256: digest, errorCode: 'invalid-document' }
  assert.equal(officePreviewFailureSchema.parse(failure).errorCode, 'invalid-document')
  assert.equal(officePreviewFailureSchema.safeParse({ ...failure, stderr: 'private text' }).success, false)
  assert.equal(officePreviewFailureSchema.safeParse({ ...failure, errorCode: 'cancelled' }).success, false)
  const view = { jobId: identity.jobId, generation: digest, state: 'blocked', errorCode: 'unavailable' }
  assert.equal(officePreviewJobView.parse(view).state, 'blocked')
  assert.equal(officePreviewJobView.safeParse({ ...view, state: 'succeeded' }).success, false)
  assert.equal(officePreviewJobView.safeParse({ ...view, errorCode: '/private/parser.log' }).success, false)
})
