/** Actual Host preview consumer; Platform replies are independent wire fixtures, not a live parser or PG. */
import { createHash } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { NativeOfficePreview, type NativeOfficePreviewCall } from '../../application/src/host/native-office-preview.ts'

const requestId = '10000000-0000-4000-8000-000000000001'
const sessionId = '20000000-0000-4000-8000-000000000002'
const jobId = '30000000-0000-4000-8000-000000000003'
const generation = 'a'.repeat(64)
const version = 'b'.repeat(64)
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
const digest = createHash('sha256').update(pdf).digest('hex')
const args = { workspaceFileScopeId: sessionId, path: '/workspace/报告.docx', priority: 'foreground' }

function content(): Record<string, unknown> {
  return { absolutePath: '/workspace/报告.docx', version, bytes: pdf.length, offset: 0, eof: true,
    data: pdf.toString('base64'), missingFonts: [], generation, pdfSha256: digest }
}

function fixture(overrides: { generation?: unknown; source?: unknown; prepare?: unknown; status?: unknown; content?: unknown } = {}) {
  const calls: { path: string; input: unknown; token: string; signal: AbortSignal }[] = []
  const call = vi.fn<NativeOfficePreviewCall>(async (path, token, input, signal) => {
    calls.push({ path, input, token, signal })
    switch (path) {
      case '/office-preview/generation': return overrides.generation ?? { generation }
      case '/native/files/stat': return overrides.source ?? { absolutePath: '/workspace/报告.docx', version, bytes: 23 }
      case '/office-preview/prepare': return overrides.prepare ?? { jobId, generation, state: 'succeeded', errorCode: null }
      case '/office-preview/status': return overrides.status ?? { jobId, generation, state: 'succeeded', errorCode: null }
      case '/office-preview/content': return overrides.content ?? content()
      case '/office-preview/cancel': return { jobId, generation, state: 'cancelled', errorCode: null }
      default: throw new Error('Unexpected fixture endpoint: ' + path)
    }
  })
  const consumer = new NativeOfficePreview(call, { pollMs: 1, renderDeadlineMs: 1000, cancelTimeoutMs: 100, maxActiveRenders: 1 })
  return { consumer, calls, render: () => consumer.render('employee1-wire-token', requestId, args, new AbortController().signal) }
}

test('Host returns complete verified bytes and retains the original native source fields', async () => {
  const f = fixture()
  try {
    const received = await f.render()
    expect(Buffer.from(received.data)).toEqual(pdf)
    expect(received).toMatchObject({ absolutePath: args.path, version, bytes: pdf.length, offset: 0, eof: true, generation })
    expect(received).not.toHaveProperty('pdfSha256')
    expect(f.calls.map(call => call.path)).toEqual(['/office-preview/generation', '/native/files/stat',
      '/office-preview/prepare', '/office-preview/content'])
    expect(f.calls[2]?.input).toEqual({ requestId, sessionId, path: '报告.docx', priority: 'foreground', generation })
    expect(f.calls.every(call => call.token === 'employee1-wire-token')).toBe(true)
  } finally { await f.consumer.close() }
})

for (const [name, changes, code] of [
  ['generation', { generation: 'c'.repeat(64) }, 'invalid-output'],
  ['source hash', { version: 'c'.repeat(64) }, 'source-changed'],
  ['source path', { absolutePath: '/workspace/替换.docx' }, 'source-changed'],
  ['physical path', { absolutePath: '/private/report.docx' }, 'invalid-output'],
  ['PDF digest', { pdfSha256: 'c'.repeat(64) }, 'invalid-output'],
  ['byte count', { bytes: pdf.length + 1 }, 'invalid-output'],
  ['incomplete chunk', { eof: false }, 'invalid-output'],
  ['nonzero offset', { offset: 1 }, 'invalid-output'],
  ['base64 whitespace', { data: pdf.toString('base64') + '\n' }, 'invalid-output'],
  ['base64 truncated quartet', { data: pdf.toString('base64').slice(0, -1) }, 'invalid-output'],
  ['base64 padding bits', { data: 'AB==', bytes: 1 }, 'invalid-output'],
  ['base64 extra padding', { data: 'AA===', bytes: 1 }, 'invalid-output'],
  ['unexpected marker field', { nonce: '40000000-0000-4000-8000-000000000004' }, 'invalid-output'],
] as const) {
  test('Host refuses content ' + name + ' before native delivery and cancels the original job', async () => {
    const f = fixture({ content: { ...content(), ...changes } })
    try {
      await expect(f.render()).rejects.toMatchObject({ code })
      expect(f.calls.at(-1)).toMatchObject({ path: '/office-preview/cancel', input: { jobId, generation } })
      expect(f.calls.filter(call => call.path === '/office-preview/content')).toHaveLength(1)
    } finally { await f.consumer.close() }
  })
}

for (const [name, job] of [
  ['failed without error', { jobId, generation, state: 'failed', errorCode: null }],
  ['blocked without error', { jobId, generation, state: 'blocked', errorCode: null }],
  ['succeeded with error', { jobId, generation, state: 'succeeded', errorCode: 'failed' }],
  ['old generation', { jobId, generation: 'c'.repeat(64), state: 'succeeded', errorCode: null }],
  ['extra stop claim', { jobId, generation, state: 'succeeded', errorCode: null, stopped: true }],
] as const) {
  test('Host rejects prepare ' + name + ' without requesting content', async () => {
    const f = fixture({ prepare: job })
    try {
      await expect(f.render()).rejects.toMatchObject({ code: 'invalid-output' })
      expect(f.calls.some(call => call.path === '/office-preview/content')).toBe(false)
      expect(f.calls.at(-1)?.input).toEqual({ requestId, generation })
    } finally { await f.consumer.close() }
  })
}

for (const [name, status] of [
  ['another job', { jobId: '40000000-0000-4000-8000-000000000004', generation, state: 'succeeded', errorCode: null }],
  ['another generation', { jobId, generation: 'c'.repeat(64), state: 'succeeded', errorCode: null }],
  ['malformed blocked state', { jobId, generation, state: 'blocked', errorCode: null }],
] as const) {
  test('Host rejects polling ' + name + ' without requesting content', async () => {
    const f = fixture({ prepare: { jobId, generation, state: 'running', errorCode: null }, status })
    try {
      await expect(f.render()).rejects.toMatchObject({ code: 'invalid-output' })
      expect(f.calls.some(call => call.path === '/office-preview/content')).toBe(false)
      expect(f.calls.at(-1)?.input).toEqual({ jobId, generation })
    } finally { await f.consumer.close() }
  })
}

for (const state of ['failed', 'blocked'] as const) {
  test('Host preserves a valid ' + state + ' error and does not fetch bytes', async () => {
    const f = fixture({ prepare: { jobId, generation, state, errorCode: 'invalid-document' } })
    try {
      await expect(f.render()).rejects.toMatchObject({ code: 'invalid-document' })
      expect(f.calls.some(call => call.path === '/office-preview/content')).toBe(false)
      expect(f.calls.at(-1)?.input).toEqual({ jobId, generation })
    } finally { await f.consumer.close() }
  })
}

for (const [name, source, code] of [
  ['substituted source', { absolutePath: '/workspace/other.docx', version, bytes: 23 }, 'source-changed'],
  ['one over input ceiling', { absolutePath: args.path, version, bytes: 33_554_433 }, 'input-too-large'],
  ['unsafe hash', { absolutePath: args.path, version: 'not-a-digest', bytes: 23 }, 'invalid-output'],
] as const) {
  test('Host rejects ' + name + ' before admission', async () => {
    const f = fixture({ source })
    try {
      await expect(f.render()).rejects.toMatchObject({ code })
      expect(f.calls.map(call => call.path)).toEqual(['/office-preview/generation', '/native/files/stat'])
    } finally { await f.consumer.close() }
  })
}

test('the exact input ceiling reaches admission; cancellation is not a stop certificate', async () => {
  const f = fixture({ source: { absolutePath: args.path, version, bytes: 33_554_432 },
    prepare: { jobId, generation, state: 'cancelled', errorCode: null } })
  try {
    await expect(f.render()).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.calls.some(call => call.path === '/office-preview/prepare')).toBe(true)
    expect(f.calls.some(call => call.path === '/office-preview/content')).toBe(false)
  } finally { await f.consumer.close() }
})

for (const bytes of [8_388_608, 8_388_609]) {
  test('Host consumes the complete output byte boundary ' + String(bytes), async () => {
    const payload = Buffer.alloc(bytes, 32)
    payload.write('%PDF-1.4\n'); payload.write('\n%%EOF\n', bytes - 7)
    const f = fixture({ content: { ...content(), bytes, data: payload.toString('base64'),
      pdfSha256: createHash('sha256').update(payload).digest('hex') } })
    try {
      if (bytes === 8_388_608) {
        const actual = await f.render()
        expect(actual.data.byteLength).toBe(bytes)
        expect(createHash('sha256').update(actual.data).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
        expect(f.calls.some(call => call.path === '/office-preview/cancel')).toBe(false)
      } else {
        await expect(f.render()).rejects.toMatchObject({ code: 'invalid-output' })
        expect(f.calls.at(-1)).toMatchObject({ path: '/office-preview/cancel', input: { jobId, generation } })
      }
    } finally { await f.consumer.close() }
  })
}

for (const extra of [' ', '  ']) {
  test('Host rejects noncanonical base64 padding while decoded PDF bytes and digest still match: ' + String(extra.length), async () => {
    const payload = Buffer.concat([pdf, Buffer.from(extra)])
    const encoded = payload.toString('base64')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const position = encoded.endsWith('==') ? encoded.length - 3 : encoded.length - 2
    const alteredCharacter = alphabet.charAt(alphabet.indexOf(encoded.charAt(position)) + 1)
    const altered = encoded.slice(0, position) + alteredCharacter + encoded.slice(position + 1)
    expect(Buffer.from(altered, 'base64')).toEqual(payload)
    const f = fixture({ content: { ...content(), bytes: payload.length, data: altered,
      pdfSha256: createHash('sha256').update(payload).digest('hex') } })
    try {
      await expect(f.render()).rejects.toMatchObject({ code: 'invalid-output' })
      expect(f.calls.at(-1)).toMatchObject({ path: '/office-preview/cancel', input: { jobId, generation } })
    } finally { await f.consumer.close() }
  })
}

for (const path of ['../report.docx', '/private/report.docx', 'C:report.docx', 'a\\report.docx', 'a//report.docx', 'e\u0301.docx']) {
  test('Host refuses unsafe Office selection ' + JSON.stringify(path) + ' before any upstream request', async () => {
    const f = fixture()
    try {
      await expect(f.consumer.render('employee1-wire-token', requestId, { ...args, path }, new AbortController().signal)).rejects.toThrow()
      expect(f.calls).toEqual([])
    } finally { await f.consumer.close() }
  })
}
