/** Actual authenticated Host RPC and download carrier over owned loopback HTTP; Platform is a wire substitute. */
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import SessionStore from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { fileDownloadUrl, type DownloadSessionId } from '@power-evolve/contracts/file-download'
import { expect, test, vi } from 'vitest'
import { apply, Config } from '../../application/src/host/index.ts'
import { Scheduler } from '../../application/src/host/scheduler.ts'
import RuntimeScope from '../../application/src/host/scope.ts'
import { parseFileDownloadQuery } from '../../application/src/file-download-http.ts'
import { readJson, sendFailure, sendJson } from '../../application/src/http.ts'

const sessionId = '10000000-0000-4000-8000-000000000001'
const workspaceId = '20000000-0000-4000-8000-000000000002'
const revision = 'a'.repeat(64)
const path = 'docs/报告.txt'
const downloadUrl = '/api/powerEvolve/workspace-download?sessionId=' + sessionId
  + '&paths=%5B%22docs%2F%E6%8A%A5%E5%91%8A.txt%22%5D&revision=' + revision
function view(): Record<string, unknown> {
  return { sessionId, workspaceId, revision, downloadUrl, fileName: '报告.txt', contentType: 'application/octet-stream',
    fileCount: 1, sourceBytes: 4, totalBytes: 4 }
}
interface WireFixture {
  origin: string
  platformOrigin: string
  token: string
  reply: unknown
  status: number
  contentType: string
  body: Buffer
  declaredLength: string
  calls: { url: string; input: unknown; authorization: string | undefined }[]
}

async function host(run: (f: WireFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'employee1-download-host-'))
  const context = new Context()
  // Scheduler is unrelated to this RPC; disable only background claims, retaining every consumer and carrier under test.
  const start = vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
  const f: WireFixture = { origin: '', platformOrigin: '', token: 'employee1_dummy_bearer_'.padEnd(64, 'x'), reply: view(),
    status: 200, contentType: 'application/octet-stream', body: Buffer.from('data'), declaredLength: '4', calls: [] }
  const pending = new Set<Promise<void>>()
  const platform = createServer((request, response) => {
    const task = (async () => {
      try {
        const url = request.url ?? ''
        const input: unknown = request.method === 'POST' ? await readJson(request, 16_384) : null
        f.calls.push({ url, input, authorization: request.headers.authorization })
        if (url === '/identity/me') { sendJson(response, { userId: workspaceId, username: 'employee1-fixture',
          settings: { model: 'wire-model', maxTokens: 1000, revision: 1 } }); return }
        if (url === '/files/download/prepare') { sendJson(response, f.reply); return }
        if (url.startsWith('/files/download?')) {
          response.writeHead(f.status, { 'content-type': f.contentType, 'content-length': f.declaredLength })
          response.end(f.body); return
        }
        throw new Error('Unexpected fixture endpoint: ' + url)
      } catch (error) { sendFailure(response, error) }
    })().finally(() => { pending.delete(task) })
    pending.add(task)
  })
  try {
    await writeFile(join(root, 'worker-token'), randomUUID(), { mode: 0o600, flag: 'wx' })
    platform.listen(0, '127.0.0.1'); await once(platform, 'listening')
    const address = platform.address()
    if (!address || typeof address === 'string') throw new Error('Owned Platform did not listen')
    f.platformOrigin = `http://127.0.0.1:${address.port}`
    await context.plugin(RuntimeScope, { platformUrl: f.platformOrigin, workerTokenFile: join(root, 'worker-token'),
      timeoutMs: 2000, maxResponseBytes: 16_384 })
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await context.plugin(TypertRegistry)
    await context.plugin(TypertGateway, {})
    await context.plugin(SessionStore)
    await context.inject(['powerEvolveRuntime', 'webServer', 'typert', 'typertGateway', 'sessions'], async (ctx) => {
      f.origin = `http://127.0.0.1:${ctx.webServer.port}`
      await apply(ctx, Config({ origin: f.origin, platformOrigin: f.platformOrigin, concurrency: 1,
        pollMs: 50, renewMs: 100, operationTimeoutMs: 1000, maxRequestBytes: 16_384, maxStreams: 1,
        fileDownloadTimeoutMs: 2000, readyFile: join(root, 'ready.json') }))
    })
    if (!f.origin) throw new Error('Production Host did not activate')
    await run(f)
  } finally {
    start.mockRestore()
    try { await context.fiber.dispose() }
    finally {
      await Promise.allSettled(pending)
      if (platform.listening) await new Promise<void>((resolve, reject) => {
        platform.close((error) => { if (error) reject(error); else resolve() }); platform.closeIdleConnections()
      })
      await rm(root, { recursive: true, force: true })
    }
  }
}

function prepare(f: WireFixture, input: unknown = { sessionId, paths: [path] }): Promise<Response> {
  return fetch(f.origin + '/api/powerEvolve/filesDownloadPrepare', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + f.token },
    body: JSON.stringify({ request: input }) })
}
function download(f: WireFixture, url = downloadUrl): Promise<Response> {
  return fetch(f.origin + url, { headers: { authorization: 'Bearer ' + f.token } })
}

test('production ProductRemote accepts exact same-origin metadata and proxy transfers exact bytes', () => host(async (f) => {
  const response = await prepare(f)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(view())
  expect(f.calls.find(call => call.url === '/files/download/prepare')?.input).toEqual({ sessionId, paths: [path] })
  const file = await download(f)
  expect(file.status).toBe(200)
  expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from('data'))
  expect(file.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt")
  expect(file.headers.get('cache-control')).toBe('no-store')
  expect(f.calls.find(call => call.url.startsWith('/files/download?'))).toEqual({
    url: '/files/download' + downloadUrl.slice('/api/powerEvolve/workspace-download'.length), input: null,
    authorization: 'Bearer ' + f.token })
  expect(f.calls.every(call => !call.url.includes(f.token))).toBe(true)
}))

for (const [name, changes] of [
  ['alternate origin', { downloadUrl: 'https://other.invalid' + downloadUrl }],
  ['network-path origin', { downloadUrl: '//other.invalid' + downloadUrl }],
  ['credential query', { downloadUrl: downloadUrl + '&token=untrusted' }],
  ['duplicate query', { downloadUrl: downloadUrl + '&revision=' + revision }],
  ['fragment', { downloadUrl: downloadUrl + '#ignored' }],
  ['noncanonical encoding', { downloadUrl: downloadUrl.replace('%2F', '%2f') }],
  ['different selection', { downloadUrl: downloadUrl.replace('docs%2F', 'else%2F') }],
  ['different session', { sessionId: workspaceId, downloadUrl: downloadUrl.replace(sessionId, workspaceId) }],
  ['unbound revision', { revision: 'b'.repeat(64) }],
  ['filename', { fileName: 'other.txt' }],
  ['count', { fileCount: 2 }],
  ['byte mismatch', { totalBytes: 5 }],
  ['malformed paths JSON', { downloadUrl: downloadUrl.replace('%5B%22', '%5B') }],
  ['private metadata', { physicalRoot: '/private/workspace' }],
] as const) {
  test('production ProductRemote refuses ' + name + ' and exposes no navigation target or content request', () => host(async (f) => {
    f.reply = { ...view(), ...changes }
    const response = await prepare(f)
    expect(response.ok).toBe(false)
    const failure: unknown = await response.json()
    expect(failure).toHaveProperty('error')
    expect(failure).not.toHaveProperty('downloadUrl')
    expect(f.calls.filter(call => call.url.startsWith('/files/download?'))).toEqual([])
    expect(f.calls.filter(call => call.url === '/files/download/prepare')).toHaveLength(1)
  }))
}

test('zero-byte file metadata and zero-byte actual HTTP transfer are accepted', () => host(async (f) => {
  f.reply = { ...view(), sourceBytes: 0, totalBytes: 0 }
  f.body = Buffer.alloc(0); f.declaredLength = '0'
  const response = await prepare(f)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(f.reply)
  const file = await download(f)
  expect(file.status).toBe(200)
  expect((await file.arrayBuffer()).byteLength).toBe(0)
}))

for (const [name, paths] of [
  ['empty selection', []], ['multiple selection', ['a.txt', 'b.txt']], ['absolute', ['/etc/passwd']],
  ['drive', ['C:report.txt']], ['backslash', ['a\\b.txt']], ['traversal', ['a/../b.txt']],
  ['dot', ['a/./b.txt']], ['empty segment', ['a//b.txt']], ['trailing separator', ['a/']],
  ['NUL', ['a\u0000.txt']], ['control', ['a\n.txt']], ['DEL', ['a\u007f.txt']],
  ['unpaired surrogate', ['a\ud800.txt']], ['non-NFC', ['e\u0301.txt']],
  ['17 segments', [Array.from({ length: 17 }, () => 'a').join('/')]], ['101 segment characters', ['a'.repeat(101)]],
  ['513 path characters', [Array.from({ length: 5 }, () => 'a'.repeat(100)).join('/') + '/aaaaaaab']],
] as const) {
  test('both actual download consumers refuse ' + name + ' before upstream file operations', () => host(async (f) => {
    const prepared = await prepare(f, { sessionId, paths })
    expect(prepared.ok).toBe(false); await prepared.arrayBuffer()
    const query = new URLSearchParams({ sessionId, paths: JSON.stringify(paths), revision })
    const file = await download(f, '/api/powerEvolve/workspace-download?' + query.toString())
    expect(file.ok).toBe(false); await file.arrayBuffer()
    expect(f.calls.filter(call => call.url !== '/identity/me')).toEqual([])
  }))
}

for (const validPath of ['é.txt', Array.from({ length: 16 }, () => 'a').join('/'), 'a'.repeat(100),
  Array.from({ length: 5 }, () => 'a'.repeat(100)).join('/') + '/aaaaaaa']) {
  test('canonical path boundary reaches the real preparation consumer: ' + String(validPath.length), () => host(async (f) => {
    const query = new URLSearchParams({ sessionId, paths: JSON.stringify([validPath]), revision })
    f.reply = { ...view(), fileName: validPath.split('/').at(-1), downloadUrl: '/api/powerEvolve/workspace-download?' + query.toString() }
    const response = await prepare(f, { sessionId, paths: [validPath] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(f.reply)
    expect(f.calls.filter(call => call.url === '/files/download/prepare')).toHaveLength(1)
  }))
}

for (const query of [downloadUrl + '&sessionId=' + sessionId, downloadUrl + '&credential=untrusted',
  downloadUrl.replace('%5B%22', '%5B'), downloadUrl.replace(revision, 'wrong')]) {
  test('content route refuses malformed query before upstream transfer', () => host(async (f) => {
    const response = await download(f, query)
    expect(response.ok).toBe(false); await response.arrayBuffer()
    expect(f.calls.filter(call => call.url !== '/identity/me')).toEqual([])
  }))
}

for (const [name, type, length, status, error] of [['unexpected content type', 'text/html', '4', 502, 'download_unavailable'],
  ['over byte ceiling', 'application/octet-stream', '33554433', 502, 'download_unavailable'],
  // The real HTTP parser rejects this illegal header before proxyFileDownload receives a Response.
  ['nonnumeric byte header', 'application/octet-stream', '4x', 503, 'service_unavailable']] as const) {
  test('Host refuses ' + name + ' before committing attachment bytes', () => host(async (f) => {
    f.contentType = type; f.declaredLength = length
    const response = await download(f)
    expect(response.status).toBe(status)
    expect(response.headers.get('content-disposition')).toBeNull()
    expect(await response.json()).toEqual({ error })
  }))
}

test('upstream changed-revision error never becomes an attachment', () => host(async (f) => {
  f.status = 409; f.contentType = 'application/json'; f.body = Buffer.from('{"error":"download_changed"}')
  f.declaredLength = String(f.body.length)
  const response = await download(f)
  expect(response.status).toBe(409)
  expect(response.headers.get('content-disposition')).toBeNull()
  expect(await response.json()).toEqual({ error: 'download_changed' })
}))

test('actual query parser distinguishes the exact wire ceiling from one byte over', () => {
  const prefix = '/api/powerEvolve/workspace-download?sessionId=' + sessionId + '&paths=%5B%22'
  const suffix = '%22%5D&revision=' + revision
  const exact = prefix + 'a'.repeat(6000 - prefix.length - suffix.length) + suffix
  expect(Buffer.byteLength(exact)).toBe(6000)
  // Canonical admitted selections are shorter than this wire ceiling; this oversized path still fails its independent path limit.
  expect(() => parseFileDownloadQuery(new URL(exact, 'https://owned.invalid'))).toThrow()
  expect(() => parseFileDownloadQuery(new URL(prefix + 'a' + exact.slice(prefix.length), 'https://owned.invalid')))
    .toThrow(expect.objectContaining({ status: 413, code: 'download_limit' }))
})

test('public URL builder enforces its exact byte budget even when a caller bypasses path admission', () => {
  const empty = fileDownloadUrl({ sessionId: brandString<DownloadSessionId>(sessionId), paths: [''], revision })
  const rawPath = 'a'.repeat(6000 - Buffer.byteLength(empty))
  // This deliberately unvalidated long path isolates the helper's wire guard. It is never an admissible browser selection.
  const wire = { sessionId: brandString<DownloadSessionId>(sessionId), paths: [rawPath] as [string], revision }
  const exact = fileDownloadUrl(wire)
  expect(Buffer.byteLength(exact)).toBe(6000)
  expect(() => parseFileDownloadQuery(new URL(exact, 'https://owned.invalid'))).toThrow()
  expect(() => fileDownloadUrl({ ...wire, paths: [rawPath + 'a'] })).toThrow(RangeError)
})
