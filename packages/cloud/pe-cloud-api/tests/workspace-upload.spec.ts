/** Real TCP and original files queue/worker protocol; Node sink and account/Session admission are explicit fixtures. */
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LinuxFilesPool } from '../../pe-cloud-files/src/worker-pool.ts'
import { createWorkspaceUploadConsumer, type WorkspaceUploadSettlement } from '../src/workspace-upload.ts'
import { CloudApiError } from '../src/errors.ts'

async function fixture(maxFileBytes = 67108864, releaseFailure?: Error) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-upload-tcp-')))
  const projects = join(home, 'projects'), project = join(projects, 'default-workspace')
  mkdirSync(project, { recursive: true })
  const gate = new SharedArrayBuffer(24), counters = new Int32Array(gate), workers: Worker[] = [], sockets = new Set<Socket>()
  const pool = new LinuxFilesPool({ maxLanes: 2, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 4, maxQueuedPerLane: 4,
    maxResidentBytes: 67108864, maxResidentBytesPerLane: 2097152, waitTimeoutMs: 30000,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 8388608, replyOverheadBytes: 4096,
    readyTimeoutMs: 3000, drainTimeoutMs: 20, helperPath: '/test-only/fd.node', maxReadBytes: 65536,
    maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 4096,
    staging: { helperPath: '/test-only/staging.node', maxFileBytes: 67108864, maxBatchRefs: 4, maxBatchBytes: 67108864,
      maxSourceChunkBytes: 65536, operationTimeoutMs: 30000, reservationBytes: 2097152 } }, (input) => {
    const worker = new Worker(new URL('../../pe-cloud-files/tests/fixtures/stage-worker.mjs', import.meta.url),
      { workerData: { gate, staging: input.staging } })
    workers.push(worker); return worker
  })
  await pool.start()
  const lifetime = new AbortController()
  const binding = { accountId: 'tcp-upload', epoch: '1', recipeVersion: 'fixture', lifetime: lifetime.signal } as AccountBinding
  const info = statSync(projects, { bigint: true }), workspace = { path: project } as Workspace
  const current = (): void => { lifetime.signal.throwIfAborted() }
  const port = pool.bind(binding, { rootPath: projects, rootDevice: String(info.dev), rootInode: String(info.ino), rootMountId: '1' }, current)
  const consumer = createWorkspaceUploadConsumer({ maxFileBytes, maxSourceChunkBytes: Math.min(65536, maxFileBytes), maxPathBytes: 4096 },
    async (id) => {
      if (id !== 'owned') throw new CloudApiError('cloud/forbidden', 'Foreign Session')
      return { assertCurrent: current, publish: async (source, signal) => {
        const held = await port.stageWorkspaceUploads(workspace, [source], current, signal)
        return releaseFailure === undefined ? held : { value: held.value, release() { throw releaseFailure } }
      } }
    })
  const pending: Promise<WorkspaceUploadSettlement>[] = [], results: WorkspaceUploadSettlement[] = []
  const server = createServer((request, response) => {
    const control = new AbortController()
    response.once('close', () => { if (!response.writableFinished) control.abort(new Error('Client disconnected')) })
    const job = consumer({ request, response, signal: AbortSignal.any([control.signal, lifetime.signal]), assertCurrent: current })
    pending.push(job)
    void job.then((value) => { results.push(value); if (value.cleanup === 'unknown') response.destroy() })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => { sockets.delete(socket) }) })
  onTestFinished(async () => {
    lifetime.abort(); for (const socket of sockets) socket.destroy()
    await pool.stop(Date.now() + 100)
    await Promise.all(workers.map(worker => worker.terminate()))
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    rmSync(home, { recursive: true, force: true })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('TCP fixture listener missing')
  const call = (bytes: number, digest: string, name = 'report.bin', sendBody = true, sessionId = 'owned') => {
    const response = Promise.withResolvers<{ status: number; body: string }>()
    const request = httpRequest({ host: '127.0.0.1', port: address.port, method: 'POST', agent: false,
      path: `/api/workspace-files/upload?sessionId=${sessionId}&directory=.&name=${encodeURIComponent(name)}`,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes), 'x-content-sha256': digest } }, (reply) => {
      const chunks: Buffer[] = []
      reply.on('data', (chunk: Buffer) => { chunks.push(chunk) }); reply.on('error', response.reject)
      reply.on('end', () => { response.resolve({ status: reply.statusCode ?? 0, body: Buffer.concat(chunks).toString() }) })
    })
    request.on('error', response.reject); request.setTimeout(10000, () => { request.destroy(new Error('Upload test timed out')) })
    if (sendBody) request.end(Buffer.alloc(bytes, 137)); else request.flushHeaders()
    return { request, response: response.promise }
  }
  return { pool, port, project, counters, call, pending, results }
}

const digest = (size: number) => createHash('sha256').update(Buffer.alloc(size, 137)).digest('hex')

it('publishes raw declared bytes and returns complete Cloud receipts with atomic collision suffixes', async () => {
  const f = await fixture()
  for (const path of ['./report.bin', './report_1.bin', './report_2.bin']) {
    const response = await f.call(2097152, digest(2097152)).response
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, value: { kind: 'workspace-upload', path,
      bytes: 2097152, sha256: digest(2097152), outcome: 'published' } })
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(f.project, path))) hash.update(chunk as Buffer)
    expect(hash.digest('hex')).toBe(digest(2097152))
  }
  await Promise.all(f.pending)
  expect(f.results.every(value => value.cleanup === 'confirmed' && value.outcome === 'completed')).toBe(true)
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
  expect(Atomics.load(f.counters, 4)).toBe(4096)
})

it('delivers a complete early rejection over TCP without pulling a declared 64 MiB body', async () => {
  const f = await fixture(1024), response = await f.call(67108864, 'a'.repeat(64), 'rejected.bin', false).response
  expect(response.status).toBe(413)
  expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { outcome: 'not-published' } })
  await Promise.all(f.pending)
  expect(f.results).toEqual([{ cleanup: 'confirmed', outcome: 'rejected' }])
  expect(Atomics.load(f.counters, 0)).toBe(0)
  expect(readdirSync(f.project)).toEqual([])
})

it('rejects a wrong declared digest after cleanup and never publishes a successful file receipt', async () => {
  const f = await fixture(), response = await f.call(4096, '0'.repeat(64), 'wrong.bin').response
  expect(response.status).toBe(400)
  expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { outcome: 'not-published' } })
  await Promise.all(f.pending)
  expect(f.results).toEqual([{ cleanup: 'confirmed', outcome: 'rejected' }])
  expect(readdirSync(f.project)).toEqual([])
})

it('joins actual client disconnect and stage cleanup before confirming cancellation', async () => {
  const f = await fixture(), call = f.call(67108864, 'a'.repeat(64), 'cancel.bin', false)
  const rejected = expect(call.response).rejects.toBeInstanceOf(Error)
  call.request.write(Buffer.alloc(131072, 137))
  await vi.waitFor(() => { expect(Atomics.load(f.counters, 3)).toBeGreaterThan(0) })
  call.request.destroy(new Error('Client cancelled'))
  await rejected
  await vi.waitFor(() => { expect(f.results).toEqual([{ cleanup: 'confirmed', outcome: 'cancelled' }]) })
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
  expect(readdirSync(f.project)).toEqual([])
  const next = await f.call(4096, digest(4096), 'after-cancel.bin').response
  expect(next.status).toBe(200)
  expect(JSON.parse(next.body)).toMatchObject({ ok: true })
})

it('rejects a foreign Session before opening a storage transaction', async () => {
  const f = await fixture(), response = await f.call(4096, digest(4096), 'foreign.bin', false, 'foreign').response
  expect(response.status).toBe(403)
  expect(JSON.parse(response.body)).toMatchObject({ ok: false })
  expect(Atomics.load(f.counters, 0)).toBe(0)
})

it('streams 64 MiB to projects and verifies the actual file hash without a private attachment object', async () => {
  const f = await fixture(), total = 67108864, chunk = Buffer.alloc(65536, 137)
  const hash = createHash('sha256')
  for (let sent = 0; sent < total; sent += chunk.byteLength) hash.update(chunk as Buffer)
  const expected = hash.digest('hex'), call = f.call(total, expected, 'large.bin', false)
  for (let sent = 0; sent < total; sent += chunk.byteLength) {
    if (!call.request.write(chunk)) await new Promise<void>((resolve) => { call.request.once('drain', resolve) })
  }
  call.request.end()
  const response = await call.response
  expect(response.status).toBe(200)
  expect(JSON.parse(response.body)).toMatchObject({ ok: true, value: { kind: 'workspace-upload', path: './large.bin',
    sha256: expected, bytes: total } })
  const actual = createHash('sha256')
  for await (const bytes of createReadStream(join(f.project, 'large.bin'))) actual.update(bytes as Buffer)
  expect(statSync(join(f.project, 'large.bin')).size).toBe(total)
  const actualHash = actual.digest('hex')
  expect(actualHash).toBe(expected)
  await Promise.all(f.pending)
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
  expect(Atomics.load(f.counters, 4)).toBe(4096)
  const evidencePath = process.env.DSH_WORKSPACE_UPLOAD_EVIDENCE
  if (evidencePath !== undefined) writeFileSync(evidencePath, JSON.stringify({
    scope: 'real loopback TCP, original queue/worker protocol; Node sink and account guards are fixtures; not production/Linux quota qualification',
    time: new Date().toISOString(), receipt: JSON.parse(response.body) as object, actualBytes: statSync(join(f.project, 'large.bin')).size,
    expectedSha256: expected, actualSha256: actualHash, maximumWorkerFrameBytes: Atomics.load(f.counters, 4),
    residentBytesAfterSettlement: f.pool.inspect().work.residentBytes,
    modules: Object.fromEntries(['../../pe-cloud-files/src/stage-bridge.ts', '../../pe-cloud-files/src/worker-pool.ts',
      '../src/workspace-upload.ts'].map(path => [path, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')])),
  }, null, 2) + '\n')
}, 30000)

it('retains unknown publication responsibility instead of returning a success or recycling its charge', async () => {
  const f = await fixture(), call = f.call(4096, digest(4096), 'unknown.bin')
  await expect(call.response).rejects.toBeInstanceOf(Error)
  await vi.waitFor(() => { expect(f.results[0]?.cleanup).toBe('unknown') })
  expect(f.pool.inspect().work.pending).toBeGreaterThan(0)
  expect(f.pool.inspect().work.residentBytes).toBeGreaterThan(0)
})

it('returns a confirmed queue-capacity refusal and admits the next request after the original work releases', async () => {
  const f = await fixture(), gate = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined) })
  const busy = f.port.runNativeMutation(2097152, () => {}, async () => { entered.resolve(undefined); await gate.promise; return true })
  await entered.promise
  const response = await f.call(4096, digest(4096), 'capacity.bin').response
  expect(response.status).toBe(400)
  expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { outcome: 'not-published' } })
  expect(f.results).toEqual([{ cleanup: 'confirmed', outcome: 'rejected' }])
  expect(Atomics.load(f.counters, 0)).toBe(0)
  gate.resolve(undefined); (await busy).release()
  await vi.waitFor(() => { expect(f.pool.inspect().work.residentBytes).toBe(0) })
  expect(JSON.parse((await f.call(4096, digest(4096), 'after-capacity.bin').response).body)).toMatchObject({ ok: true })
})


it('retains a post-response release failure and its positive charge instead of treating HTTP success as cleanup', async () => {
  const cause = new Error('Original result release is unconfirmed'), f = await fixture(67108864, cause)
  expect((await f.call(4096, digest(4096), 'release-unknown.bin').response).status).toBe(200)
  await Promise.all(f.pending)
  expect(f.results).toEqual([{ cleanup: 'unknown', cause }])
  expect(f.pool.inspect().work.residentBytes).toBeGreaterThan(0)
})


it('rejects the protected project metadata name before opening any raw upload source', async () => {
  const f = await fixture(), response = await f.call(4096, digest(4096), '.pe').response
  expect(response.status).toBe(400)
  expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { outcome: 'not-published' } })
  await Promise.all(f.pending)
  expect(Atomics.load(f.counters, 0)).toBe(0)
  expect(readdirSync(f.project)).toEqual([])
  expect(f.pool.inspect().work.residentBytes).toBe(0)
})
