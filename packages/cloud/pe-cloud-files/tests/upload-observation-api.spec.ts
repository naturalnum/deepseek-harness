/** Real Native Loader/Session guards, API, CloudAccountFiles, queue and TCP; auth/SQL/Linux ABI remain outside this Host test. */
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import type { Socket } from 'node:net'
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { LinuxFilesPool, type WorkspaceUploadObservation } from '../src/worker-pool.ts'

it('associates an actual API/live Session/Files upload B with its original queued record over TCP', async () => {
  const workers: Worker[] = [], gate = new SharedArrayBuffer(24), counters = new Int32Array(gate), sockets = new Set<Socket>()
  const pool = new LinuxFilesPool({ maxLanes: 2, maxRunning: 2, maxRunningPerLane: 1, maxQueued: 4, maxQueuedPerLane: 2,
    maxResidentBytes: 134217728, maxResidentBytesPerLane: 67108864, waitTimeoutMs: 30000,
    workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 8388608, replyOverheadBytes: 4096,
    readyTimeoutMs: 3000, drainTimeoutMs: 20, helperPath: '/fixture/fd.node', maxReadBytes: 65536,
    maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 4096,
    staging: { helperPath: '/fixture/stage.node', maxFileBytes: 67108864, maxBatchRefs: 4, maxBatchBytes: 67108864,
      maxSourceChunkBytes: 65536, operationTimeoutMs: 30000, reservationBytes: 2097152 } }, (input) => {
    const worker = new Worker(new URL('./fixtures/stage-worker.mjs', import.meta.url), { workerData: { gate, staging: input.staging } })
    workers.push(worker); return worker
  })
  onTestFinished(async () => { await pool.stop(Date.now() + 100); await Promise.all(workers.map(worker => worker.terminate())) })
  await pool.start()
  const route = { method: 'POST', path: '/api/workspace-files/upload', handlerId: 'cloud:workspaceUpload', guard: 'account-session' as const }
  const native = policyFixture([], undefined, 'queue-api-original', { selected: [route], inspectRootFetch: () => [] },
    undefined, undefined, undefined, undefined, [], false, undefined, { defaultId: 'cloud-chat',
      declarations: [{ entryId: 'cloud-preset', config: { id: 'cloud-chat', plugins: [] }, selectable: true }],
      filesAttachments(binding, projects) {
        const info = statSync(projects, { bigint: true })
        return pool.bind(binding, { rootPath: projects, rootDevice: String(info.dev), rootInode: String(info.ino), rootMountId: '1' },
          () => { binding.lifetime.throwIfAborted() })
      },
      async afterReady(ctx, api, files, guards) {
        await ctx.plugin({ inject: connectionInject, apply: applyConnection })
        const select = guards.resolveFileTransfer
        if (select === undefined) throw Error('Original file transfer guard absent')
        api.installWorkspaceTransfers(ctx, { maxFileBytes: 67108864, maxFiles: 2, maxTotalBytes: 67108864,
          chunkBytes: 65536, maxPathBytes: 4096, timeoutMs: 30000 }, async (id, signal) =>
          ({ ...await select(id, signal), files }))
      } })
  const graph = await native.start('1', native.config, true, { maxNativeInventoryEntries: 512 })
  graph.api.assertInstalled(graph.ctx)
  const created = await graph.ctx.sessionController.create({})
  graph.api.assertInstalled(graph.ctx)
  graph.files.assertWorkspaceUploadAvailable(graph.files.project().workspace)
  const jobs: Promise<unknown>[] = [], outcomes: unknown[] = [], lifetime = new AbortController()
  const server = createServer((request, response) => {
    const closed = new AbortController()
    response.once('close', () => { if (!response.writableFinished) closed.abort(Error('Actual client closed')) })
    const job = graph.api.consumeWorkspaceUploadResponse({ request, response,
      signal: AbortSignal.any([lifetime.signal, closed.signal]), assertCurrent() { graph.api.assertInstalled(graph.ctx) } })
    jobs.push(job); void job.then((value) => { outcomes.push(value); if (value.cleanup === 'unknown') response.destroy() })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => { sockets.delete(socket) }) })
  onTestFinished(async () => {
    lifetime.abort(); for (const socket of sockets) socket.destroy(); await Promise.allSettled(jobs)
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (address === null || typeof address === 'string') throw Error('Listener absent')
  const caseId = 'c'.repeat(32), data = (role: 'A' | 'B') => Buffer.alloc(role === 'A' ? 8192 : 4096, 137)
  const claim = (role: 'A' | 'B') => ({ name: `qa-${caseId}-${role}`, bytes: data(role).length,
    sha256: createHash('sha256').update(data(role)).digest('hex') })
  const rows: WorkspaceUploadObservation[] = []
  pool.observeWorkspaceUploads({ caseId, accountId: graph.binding.accountId, durationMs: 120000,
    claims: [claim('A'), claim('B')] }, (row) => { rows.push(row); return true })
  const call = (role: 'A' | 'B', sessionId: string = created.sessionId) => {
    const actual = claim(role), answer = Promise.withResolvers<{ status: number; body: string }>()
    const request = httpRequest({ hostname: '127.0.0.1', port: address.port, method: 'POST', agent: false,
      path: `/api/workspace-files/upload?sessionId=${sessionId}&directory=.&name=${actual.name}`,
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(actual.bytes), 'x-content-sha256': actual.sha256 } }, (reply) => {
      let body = ''; reply.on('data', (b: Buffer) => { body += b }); reply.on('error', answer.reject)
      reply.on('end', () => { answer.resolve({ status: reply.statusCode ?? 0, body }) })
    }); request.on('error', answer.reject)
    void answer.promise.catch(() => {}) // The later receipt assertion still observes failure; teardown may close a pending client first.
    request.flushHeaders(); return { request, answer: answer.promise }
  }
  const a = call('A'); a.request.write(data('A').subarray(0, 4096))
  await vi.waitFor(() => { expect(Atomics.load(counters, 3)).toBeGreaterThan(0) })
  const refused = call('B', 'foreign-session'); refused.request.end(data('B'))
  expect((await refused.answer).status).toBe(403); expect(rows.some(row => row.role === 'B')).toBe(false)
  const b = call('B'), rejected = expect(b.answer).rejects.toBeInstanceOf(Error)
  await vi.waitFor(() => { expect(rows.some(row => row.role === 'B' && row.event === 'queued-before-invoke')).toBe(true) })
  const id = rows.find(row => row.role === 'B')!.id
  expect(pool.inspect().work).toMatchObject({ running: 1, queued: 1, residentBytes: 4194304 })
  b.request.destroy(Error('Cancel only B')); await rejected
  await vi.waitFor(() => { expect(rows.filter(row => row.id === id).map(row => row.event))
    .toEqual(['queued-before-invoke', 'cancelled-before-invoke', 'settled']) })
  expect(Atomics.load(counters, 0)).toBe(1); expect(pool.inspect().work.residentBytes).toBe(2097152)
  a.request.end(data('A').subarray(4096)); const complete = await a.answer
  expect(complete.status).toBe(200)
  expect(JSON.parse(complete.body)).toMatchObject({ ok: true, value: { bytes: 8192, sha256: claim('A').sha256, outcome: 'published' } })
  expect(readFileSync(join(native.project, claim('A').name))).toEqual(data('A'))
  await Promise.all(jobs); expect(outcomes).toContainEqual({ cleanup: 'confirmed', outcome: 'cancelled' })
  await vi.waitFor(() => { expect(pool.inspect().work.residentBytes).toBe(0) })
})
