/** Opt-in real HTTP/original Files worker/FD/staging regression; no deployed Root, SQL or account authority. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, mkdtempSync, mkdirSync, statSync, statfsSync, openSync, closeSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

assert.equal(process.platform, 'linux')
assert.ok(process.argv.length === 7 || process.argv.length === 8, 'api-bundle worker-bundle fd.node staging.node disposable-parent [all|queued|queued-baseline] required')
const mode = process.argv[7] ?? 'all'
assert.ok(['all', 'queued', 'queued-baseline'].includes(mode))
const [api, workerModule, helperPath, stagingPath, parent] = process.argv.slice(2, 7).map(value => resolve(value))
const { LinuxFilesPool, createWorkspaceUploadConsumer } = await import(pathToFileURL(api).href)
const block = Buffer.alloc(65536, 137), largeBytes = 67108864, reports = [], queuedCases = []
function digest(size) {
  const hash = createHash('sha256')
  for (let at = 0; at < size; at += block.length) hash.update(block.subarray(0, Math.min(block.length, size - at)))
  return hash.digest('hex')
}
async function actualHash(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
function drain(request) {
  return new Promise((resolve, reject) => {
    const clean = () => { request.off('drain', drained); request.off('error', failed); request.off('close', closed) }
    const drained = () => { clean(); resolve() }
    const failed = error => { clean(); reject(error) }
    const closed = () => { clean(); reject(new Error('Actual client socket closed while sending')) }
    request.once('drain', drained); request.once('error', failed); request.once('close', closed)
  })
}
async function suite(operationTimeoutMs, run, waitTimeoutMs = 25) {
  const home = mkdtempSync(join(parent, 'native-workspace-upload-')), projects = join(home, 'projects')
  const project = join(projects, 'default-workspace')
  mkdirSync(project, { recursive: true })
  const stat = statSync(projects, { bigint: true }), fd = openSync(projects, 'r')
  let mountId
  try { mountId = /^mnt_id:\s+(\d+)$/mu.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))[1] }
  finally { closeSync(fd) }
  const lifetime = new AbortController(), current = () => lifetime.signal.throwIfAborted()
  const binding = { accountId: 'offline-native-upload', epoch: '1', recipeVersion: 'test-only', lifetime: lifetime.signal }
  const workers = [], terminal = [], sockets = new Set(), jobs = [], settlements = []
  const events = { ack: undefined }, guards = new Set()
  const admission = { phase: 'normal', reason: undefined, abort: undefined, submitted: Promise.withResolvers(), failures: [] }
  const pool = new LinuxFilesPool({ maxLanes: 2, maxRunning: 1, maxRunningPerLane: 1, maxQueued: 4, maxQueuedPerLane: 4,
    maxResidentBytes: 67108864, maxResidentBytesPerLane: 2097152, waitTimeoutMs,
    workerCount: 1, minimumHealthyWorkers: 1, workerReservationBytes: 8388608, replyOverheadBytes: 4096,
    readyTimeoutMs: 10000, drainTimeoutMs: 1000, helperPath, maxReadBytes: 65536, maxPathBytes: 4096,
    maxResolveRetries: 2, readChunkBytes: 4096,
    content: { maxEntries: 256, maxNameBytes: 255, maxReplyBytes: 65536, operationTimeoutMs: 5000 },
    staging: { helperPath: stagingPath, maxFileBytes: 1073741824, maxBatchRefs: 16, maxBatchBytes: 2147483648,
      maxSourceChunkBytes: 65536, operationTimeoutMs, reservationBytes: 2097152 } }, input => {
    const worker = new Worker(pathToFileURL(workerModule), { workerData: input, execArgv: [] })
    workers.push(worker)
    worker.on('message', message => {
      if (message.kind === 'stage-ack') events.ack?.(message)
      if (message.kind === 'stage-result' || message.kind === 'stage-failure') terminal.push(message)
    })
    return worker
  })
  let server, cleanupConfirmed = false, opened = 0, closed = 0
  try {
    await pool.start()
    const port = pool.bind(binding, { rootPath: projects, rootDevice: String(stat.dev), rootInode: String(stat.ino), rootMountId: mountId }, current)
    const occupy = async () => {
      const life = new AbortController(), entered = Promise.withResolvers(), gate = Promise.withResolvers()
      const guardBinding = { ...binding, accountId: 'offline-queue-blocker', lifetime: life.signal }
      const guard = pool.bind(guardBinding, { rootPath: projects, rootDevice: String(stat.dev),
        rootInode: String(stat.ino), rootMountId: mountId }, () => life.signal.throwIfAborted())
      const actual = guard.runNativeMutation(1, current, async () => { entered.resolve(); await gate.promise })
      let joined
      const release = () => joined ??= (async () => {
        gate.resolve(); (await actual).release()
        assert.equal((await pool.stopEpoch(guardBinding, Date.now() + 2000)).status, 'confirmed')
        guards.delete(release)
      })()
      guards.add(release); await entered.promise
      assert.equal(pool.inspect().busy, 1)
      return release
    }
    const consumer = createWorkspaceUploadConsumer({ maxFileBytes: 1073741824, maxSourceChunkBytes: 65536, maxPathBytes: 4096 },
      async () => ({ assertCurrent: current, publish: (source, signal) => {
        if (admission.phase === 'pre-aborted') admission.abort()
        const actual = port.stageWorkspaceUploads({ path: project }, [{ ...source,
          open: async function* (control) { opened++; try { yield* source.open(control) } finally { closed++ } } }], current, signal)
        admission.submitted.resolve(pool.inspect())
        if (admission.phase === 'before-invoke') admission.abort()
        return actual.catch(error => { admission.failures.push({ error, reason: signal.reason }); throw error })
      } }))
    server = createServer((request, response) => {
      const control = new AbortController()
      const reason = admission.reason, abort = () => control.abort(reason)
      admission.abort = abort
      response.once('close', () => { if (!response.writableFinished) abort() })
      const job = consumer({ request, response, signal: control.signal, assertCurrent: current })
      jobs.push(job)
      void job.then(result => {
        settlements.push(result)
        if (result.cleanup === 'unknown') { console.error('Actual unknown settlement', result.cause); response.destroy() }
      })
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const call = (name, bytes, sha256 = digest(bytes)) => {
      console.error(JSON.stringify({ case: name, bytes, operationTimeoutMs }))
      const response = Promise.withResolvers()
      const request = httpRequest({ host: '127.0.0.1', port: server.address().port, method: 'POST', agent: false,
        path: `/api/workspace-files/upload?sessionId=owned&directory=.&name=${encodeURIComponent(name)}`,
        headers: { 'content-type': 'application/octet-stream', 'content-length': bytes, 'x-content-sha256': sha256 } }, reply => {
        let body = ''
        reply.on('data', bytes => { body += bytes }); reply.once('error', response.reject)
        reply.once('end', () => response.resolve({ status: reply.statusCode, body: JSON.parse(body) }))
      })
      request.once('error', response.reject)
      request.setTimeout(60000, () => request.destroy(new Error('Offline regression TCP deadline')))
      void response.promise.catch(() => {})
      return { request, response: response.promise, async send(count = bytes, finish = true) {
        for (let at = 0; at < count; at += block.length) {
          if (!request.write(block.subarray(0, Math.min(block.length, count - at)))) await drain(request)
        }
        if (finish) request.end()
      } }
    }
    const settled = async () => {
      await Promise.all(jobs)
      assert.deepEqual(pool.inspect().work, { running: 0, queued: 0, residentBytes: 0, pending: 0, lanes: 1 })
      assert.equal(opened, closed)
      assert.equal(pool.inspect().healthy, 1)
    }
    await run({ call, settled, project, events, terminal, settlements, pool, admission, occupy,
      joinConsumers: () => Promise.all(jobs), sources: () => ({ opened, closed }) })
    await settled()
    reports.push({ operationTimeoutMs, waitTimeoutMs, projectRoot: { path: projects, device: String(stat.dev), inode: String(stat.ino),
      mountId, filesystemType: String(statfsSync(project).type) }, work: pool.inspect().work, sourcesOpened: opened, sourcesClosed: closed,
      terminal: terminal.map(message => ({ kind: message.kind, ...(message.result ?? { code: message.code, facts: message.facts }) })), settlements })
  } finally {
    for (const socket of sockets) socket.destroy()
    if (server !== undefined) await new Promise(resolve => server.close(resolve))
    await Promise.allSettled(jobs)
    await Promise.all([...guards].map(release => release()))
    lifetime.abort()
    const stop = await pool.stop(Date.now() + 2000)
    cleanupConfirmed = stop.status === 'confirmed'
    if (cleanupConfirmed) rmSync(home, { recursive: true })
    assert.equal(cleanupConfirmed, true, `Original workers/work unresolved; preserve ${home}`)
  }
}
if (mode === 'all') {
await suite(240000, async f => {
  const large = f.call('large.bin', largeBytes), started = Date.now()
  await large.send()
  const receipt = await large.response
  assert.equal(receipt.status, 200)
  assert.equal(receipt.body.value.bytes, largeBytes)
  assert.equal(statSync(join(f.project, 'large.bin')).size, largeBytes)
  assert.equal(await actualHash(join(f.project, 'large.bin')), digest(largeBytes))
  assert.ok(Date.now() - started > 25, 'Real native transfer must exceed its queue admission deadline')
  await f.settled()
  for (const expected of ['collision.bin', 'collision_1.bin', 'collision_2.bin']) {
    const upload = f.call('collision.bin', 4096); await upload.send()
    assert.equal((await upload.response).body.value.path, `./${expected}`)
    assert.equal(await actualHash(join(f.project, expected)), digest(4096))
  }
  const wrong = f.call('wrong.bin', 4096, 'a'.repeat(64)); await wrong.send()
  assert.equal((await wrong.response).status, 400); await f.settled()
  assert.equal(readdirSync(f.project).includes('wrong.bin'), false)
  const ack = Promise.withResolvers()
  f.events.ack = message => { if (message.total >= 65536) ack.resolve() }
  const cancel = f.call('cancel.bin', largeBytes)
  await cancel.send(2097152, false); await ack.promise
  cancel.request.destroy(new Error('Actual test client cancels its unfinished upload'))
  await assert.rejects(cancel.response)
  await f.settled()
  assert.equal(f.settlements.at(-1).outcome, 'cancelled')
  assert.equal(readdirSync(f.project).some(name => name.startsWith('.stage-') || name === 'cancel.bin'), false)
  const next = f.call('after-cancel.bin', 4096); await next.send()
  assert.equal((await next.response).status, 200); await f.settled()
})
await suite(200, async f => {
  const partial = f.call('deadline.bin', largeBytes)
  await partial.send(65536, false)
  const receipt = await partial.response
  assert.equal(receipt.status, 400)
  await f.settled()
  assert.deepEqual(readdirSync(f.project), [])
  assert.deepEqual(f.settlements, [{ cleanup: 'confirmed', outcome: 'rejected' }])
  assert.ok(f.terminal.at(-1).facts.closed && f.terminal.at(-1).facts.clean)
})
}
if (mode === 'queued' || mode === 'queued-baseline') {
  const expectedCleanup = mode === 'queued' ? 'confirmed' : 'unknown'
  await suite(240000, async f => {
    for (const phase of ['queued', 'pre-aborted', 'before-invoke']) {
      for (const kind of ['default', 'custom-error', 'custom-value']) {
        const reason = kind === 'default' ? undefined : kind === 'custom-error' ? new Error('Original caller reason') : 'Original caller value'
        const expected = mode === 'queued-baseline' && kind === 'custom-value' ? 'confirmed' : expectedCleanup
        const release = phase === 'queued' ? await f.occupy() : undefined
        try {
          f.admission.phase = phase; f.admission.reason = reason; f.admission.submitted = Promise.withResolvers()
          const call = f.call(`${phase}-${kind}.bin`, 4096), initialSources = f.sources()
          call.request.flushHeaders()
          const submitted = await f.admission.submitted.promise
          if (phase === 'queued') {
            assert.deepEqual(submitted.work, { running: 1, queued: 1, residentBytes: 2097153, pending: 2, lanes: 2 })
            assert.equal(submitted.busy, 1)
            call.request.destroy(new Error('Actual client cancels a queued request'))
          } else if (phase === 'before-invoke') {
            assert.equal(submitted.work.running, 1); assert.equal(submitted.busy, 0)
          }
          await assert.rejects(call.response)
          await f.joinConsumers()
          const result = f.settlements.at(-1), failure = f.admission.failures.at(-1)
          assert.equal(result.cleanup, expected)
          assert.deepEqual(f.sources(), initialSources)
          assert.equal(f.terminal.length, 0)
          assert.deepEqual(f.pool.inspect().work, { running: release ? 1 : 0, queued: 0,
            residentBytes: release ? 1 : 0, pending: release ? 1 : 0, lanes: release ? 2 : 1 })
          if (expected === 'confirmed') {
            assert.equal(result.outcome, 'cancelled')
            assert.equal(failure.error.outcome, 'not-published'); assert.equal(failure.error.code, 'FS_ABORTED')
            if (failure.reason instanceof Error) assert.equal(failure.error.cause, failure.reason)
            else assert.equal(failure.error.cause.cause, failure.reason)
          } else {
            if (failure.reason instanceof Error) assert.equal(failure.error, failure.reason)
            else assert.equal(failure.error.cause, failure.reason)
          }
          queuedCases.push({ phase, reasonKind: kind, cleanup: result.cleanup, outcome: result.outcome,
            rawFailure: { name: failure.error.name, code: failure.error.code, outcome: failure.error.outcome },
            originalReasonRetained: true, sources: f.sources(), submitted, afterConsumer: f.pool.inspect() })
        } finally { if (release !== undefined) await release() }
        await f.settled()
      }
    }
    if (mode === 'queued') {
      const release = await f.occupy()
      try {
        f.admission.phase = 'queued-deadline'; f.admission.reason = undefined; f.admission.submitted = Promise.withResolvers()
        const call = f.call('queued-deadline.bin', 4096), started = Date.now()
        call.request.flushHeaders(); const submitted = await f.admission.submitted.promise
        assert.equal(submitted.work.queued, 1)
        const receipt = await call.response
        assert.equal(receipt.status, 400); assert.equal(receipt.body.error.outcome, 'not-published')
        await f.joinConsumers()
        const failure = f.admission.failures.at(-1)
        assert.equal(failure.error.outcome, 'not-published'); assert.equal(failure.error.cause.code, 'files/deadline')
        assert.deepEqual(f.sources(), { opened: 0, closed: 0 }); assert.equal(f.terminal.length, 0)
        assert.ok(Date.now() - started >= 29000, 'Queue expiry retains its original30s bound')
        queuedCases.push({ phase: 'queued-deadline', elapsedMs: Date.now() - started,
          receipt, cleanup: f.settlements.at(-1).cleanup, sourceOpened: 0, afterConsumer: f.pool.inspect() })
      } finally { await release() }
      f.admission.phase = 'normal'; f.admission.reason = undefined
      const next = f.call('after-queued-cancel.bin', 4096); await next.send()
      assert.equal((await next.response).status, 200); await f.settled()
    }
  }, 30000)
}
console.log(JSON.stringify({ status: 'passed', scope: 'real loopback HTTP + original pool/worker + FD ABI8/staging ABI1; authentication/Root/PG not qualified',
  node: process.version, executionIdentity: { pid: process.pid, uid: process.getuid(), gid: process.getgid() },
  inputSuppliers: [api, workerModule, helperPath, stagingPath].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })),
  mode, queuedCases, expected64MiBSha256: digest(largeBytes), reports }, null, 2))
