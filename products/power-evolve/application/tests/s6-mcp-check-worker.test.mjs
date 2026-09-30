/** Lease lifecycle fixtures plus short-lived real TLS discovery; no PG/browser/model acceptance is claimed. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:https'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpCheckWorker, McpCheckWorkerError } from '../lib/platform/mcp-check-worker.js'
import { PlatformError } from '../lib/contracts.js'
import { McpTransportError } from '../lib/platform/mcp-transport.js'
import { mcpCheckId, mcpLeaseOwnerId, mcpResourceId, mcpSessionId, mcpUserId } from '../lib/mcp-contracts.js'

const budgets = { timeoutMs: 5_000, idleTimeoutMs: 2_000, maxRequestBytes: 65_536,
  maxResponseBytes: 65_536, maxTotalResponseBytes: 262_144, maxResponseHeaderBytes: 16_384,
  maxRequests: 32, maxHeaderBytes: 8_192, maxHeaders: 16, maxPages: 4, maxTools: 16,
  maxCatalogBytes: 65_536 }
const valid = { name: 'echo', description: '\u0000表😀 literal \\u0000', inputSchema: { type: 'object',
  properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  annotations: { readOnlyHint: false }, _meta: { raw: '\u0000' }, extension: { original: '\u0000' } }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const turn = () => new Promise(done => setImmediate(done))
const isWorkerError = code => error => {
  assert(error instanceof McpCheckWorkerError)
  assert.equal(error.code, code)
  assert.equal(error.message, code)
  assert.equal(error.cause, undefined)
  return true
}

function fixture(overrides = {}) {
  const controller = new AbortController(), ownerId = mcpLeaseOwnerId.parse(randomUUID())
  const lease = { checkId: mcpCheckId.parse(randomUUID()), ownerId, epoch: 7 }
  const snapshot = { userId: mcpUserId.parse(randomUUID()), resourceId: mcpResourceId.parse(randomUUID()),
    configurationRevision: 3, credentialRevision: 2, serverName: 'fixture',
    serverUrl: 'https://mcp-worker.test/mcp', authentication: 'bearer', headers: { Authorization: 'Bearer fixture-private' } }
  const stats = { claims: 0, snapshots: 0, renewals: 0, activeRenewals: 0, finishes: [], trace: [] }
  const finishStarted = deferred(), snapshotStarted = deferred()
  const receipt = state => ({ checkId: lease.checkId, draftId: null, connectionId: snapshot.resourceId,
    sessionId: mcpSessionId.parse(randomUUID()), connectionRevision: 3, configurationRevision: 3,
    credentialRevision: 2, state, catalogId: null, discoveredTools: null, errorCode: null,
    cancelRequested: false, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() })
  const store = {
    async claimCheck(owner) {
      assert.equal(owner, ownerId)
      stats.claims++
      stats.trace.push('claim')
      return stats.claims === 1 ? lease : null
    },
    async renewCheck(value) {
      assert.deepEqual(value, lease)
      stats.renewals++
      stats.trace.push('renew')
    },
    async checkSnapshot(value) {
      assert.deepEqual(value, lease)
      stats.snapshots++
      stats.trace.push('snapshot')
      snapshotStarted.resolve()
      return snapshot
    },
    async finishCheck(value, outcome) {
      assert.deepEqual(value, lease)
      assert.equal(stats.activeRenewals, 0)
      stats.finishes.push(outcome)
      stats.trace.push('finish')
      finishStarted.resolve()
      controller.abort()
      return receipt('tools' in outcome ? 'succeeded' : 'failed')
    },
    ...overrides,
  }
  return { controller, ownerId, lease, snapshot, stats, store, receipt, finishStarted, snapshotStarted }
}

function launch(t, f, overrides = {}) {
  const worker = new McpCheckWorker(f.store, { ownerId: f.ownerId, pollMs: 50, renewMs: 25,
    budgets, networkPolicy: {}, toolLimits: { maxToolBytes: 16_384, maxDescriptionBytes: 8_192 },
    discover: async () => ({ tools: [valid] }), ...overrides })
  const run = worker.run(f.controller.signal)
  // Tests own and observe the run promise; this handler also covers a failure before an assertion is attached.
  run.catch(() => {})
  t.after(async () => {
    f.controller.abort()
    try { await worker.stop() } catch (_reportedWorkerFailure) { /* The run promise owns its terminal error. */ }
    await run.catch(() => {})
  })
  return { worker, run }
}

test('check worker preserves whole raw and zero-tool catalogs without retaining compiled partial tools', async t => {
  for (const raw of [[valid], []]) {
    await t.test(raw.length ? 'raw NUL and extension metadata' : 'zero tools', async st => {
      const f = fixture()
      const { run } = launch(st, f, { discover: async (target, options) => {
        assert.equal(f.stats.snapshots, 1)
        assert.equal(target.endpoint, f.snapshot.serverUrl)
        assert.deepEqual(target.headers, f.snapshot.headers)
        assert.equal(options.signal.aborted, false)
        return { tools: raw, _meta: { opaque: '\u0000' } }
      } })
      await run
      assert.deepEqual(f.stats.finishes, [{ tools: raw }])
      assert.deepEqual(f.stats.trace, ['claim', 'snapshot', 'finish'])
      if (raw.length) assert.equal(f.stats.finishes[0].tools[0].extension.original, '\u0000')
    })
  }
})

test('every unsupported descriptor or budget failure rejects the entire catalog', async t => {
  const cases = [
    { name: 'input external reference', bad: { name: 'bad', inputSchema: { type: 'object',
      properties: { secret: { $ref: 'https://private.example/secret' } } } }, code: 'mcp_schema_unsupported' },
    { name: 'output unsupported constraint', bad: { name: 'bad', inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { x: { type: 'string', pattern: 'private-pattern' } } } }, code: 'mcp_schema_unsupported' },
    { name: 'required tasks', bad: { name: 'bad', inputSchema: { type: 'object' },
      execution: { taskSupport: 'required' } }, code: 'mcp_tasks_unsupported' },
    { name: 'single tool bytes', bad: { name: 'bad', inputSchema: { type: 'object' }, padding: 'x'.repeat(2_000) },
      options: { toolLimits: { maxToolBytes: 1_000, maxDescriptionBytes: 8_192 } }, code: 'mcp_tool_size_limit' },
    { name: 'model description bytes', bad: { name: 'bad', inputSchema: { type: 'object' }, description: 'private'.repeat(300) },
      options: { toolLimits: { maxToolBytes: 16_384, maxDescriptionBytes: 1_000 } }, code: 'mcp_description_size_limit' },
    { name: 'whole catalog bytes', bad: { name: 'bad', inputSchema: { type: 'object' } },
      options: { budgets: { ...budgets, maxCatalogBytes: 100 } }, code: 'mcp_catalog_limit' },
    { name: 'tool count', bad: { name: 'bad', inputSchema: { type: 'object' } },
      options: { budgets: { ...budgets, maxTools: 1 } }, code: 'mcp_catalog_limit' },
    { name: 'duplicate raw names', bad: { ...valid }, code: 'mcp_tool_duplicate' },
  ]
  for (const item of cases) await t.test(item.name, async st => {
    const f = fixture(), { run } = launch(st, f, {
      discover: async () => ({ tools: [valid, item.bad] }), ...item.options })
    await run
    assert.deepEqual(f.stats.finishes, [{ errorCode: item.code }])
    assert.equal(f.stats.claims, 1)
  })
})

test('snapshot and discovery failures save only fixed redacted categories', async t => {
  const cases = [
    { name: 'snapshot stale', stage: 'snapshot', error: new PlatformError(409, 'mcp_check_stale'), code: 'mcp_check_stale' },
    { name: 'snapshot private PG error', stage: 'snapshot', error: new Error('postgres password=private-secret'), code: 'mcp_check_snapshot_failed' },
    { name: 'transport category', stage: 'discovery', error: new McpTransportError('address_denied', false), code: 'mcp_address_denied' },
    { name: 'private protocol error', stage: 'discovery', error: new Error('Bearer fixture-private echoed by server'), code: 'mcp_check_discovery_failed' },
  ]
  for (const item of cases) await t.test(item.name, async st => {
    const f = fixture()
    if (item.stage === 'snapshot') f.store.checkSnapshot = async () => { throw item.error }
    const { run } = launch(st, f, { discover: async () => { throw item.error } })
    await run
    assert.deepEqual(f.stats.finishes, [{ errorCode: item.code }])
    assert(!JSON.stringify(f.stats.finishes).includes('private-secret'))
  })
})

test('user cancellation, expired snapshot and uncertain renewal abort without a stale finish', async t => {
  for (const mode of ['cancelled', 'snapshot-expired', 'renewal-unknown']) await t.test(mode, async st => {
    const f = fixture(), aborted = deferred()
    if (mode === 'snapshot-expired') f.store.checkSnapshot = async () => {
      f.controller.abort()
      throw new PlatformError(409, 'mcp_check_lease_lost')
    }
    else f.store.renewCheck = async lease => {
      assert.deepEqual(lease, f.lease)
      f.stats.renewals++
      throw mode === 'cancelled' ? new PlatformError(409, 'mcp_check_lease_lost') : new Error('private renewal error')
    }
    const { run } = launch(st, f, { discover: async (_target, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted.resolve(); reject(new McpTransportError('aborted', false)) }, { once: true })
    }) })
    if (mode !== 'snapshot-expired') { await aborted.promise; f.controller.abort() }
    await run
    assert.equal(f.stats.finishes.length, 0)
    assert.equal(f.stats.snapshots, mode === 'snapshot-expired' ? 0 : 1)
  })
})

test('terminal write waits for the in-flight renewal and never renews the terminal epoch', async t => {
  const f = fixture(), renewing = deferred(), releaseRenewal = deferred(), discovery = deferred(), discoveryDone = deferred()
  t.after(() => { discovery.resolve(); releaseRenewal.resolve() })
  f.store.renewCheck = async () => {
    f.stats.activeRenewals++
    f.stats.trace.push('renew-start')
    renewing.resolve()
    await releaseRenewal.promise
    f.stats.trace.push('renew-end')
    f.stats.activeRenewals--
  }
  const { run } = launch(t, f, { discover: async () => {
    await discovery.promise
    discoveryDone.resolve()
    return { tools: [valid] }
  } })
  await renewing.promise
  discovery.resolve()
  await discoveryDone.promise
  await turn()
  assert.equal(f.stats.finishes.length, 0)
  assert.equal(f.stats.activeRenewals, 1)
  releaseRenewal.resolve()
  await run
  assert.deepEqual(f.stats.trace, ['claim', 'snapshot', 'renew-start', 'renew-end', 'finish'])
})

test('stop aborts discovery and waits for network cleanup plus pending renewal', async t => {
  const f = fixture(), renewing = deferred(), releaseRenewal = deferred(), networkAbort = deferred(), releaseNetwork = deferred()
  t.after(() => { releaseNetwork.resolve(); releaseRenewal.resolve() })
  f.store.renewCheck = async () => {
    f.stats.activeRenewals++
    renewing.resolve()
    await releaseRenewal.promise
    f.stats.activeRenewals--
  }
  let networkActive = true
  const { worker, run } = launch(t, f, { discover: async (_target, { signal }) => {
    await new Promise(done => signal.addEventListener('abort', () => { networkAbort.resolve(); done() }, { once: true }))
    await releaseNetwork.promise
    networkActive = false
    throw new McpTransportError('aborted', false)
  } })
  await renewing.promise
  let stopped = false
  const stop = worker.stop().then(() => { stopped = true })
  await networkAbort.promise
  assert.equal(networkActive, true)
  assert.equal(stopped, false)
  releaseNetwork.resolve()
  await turn()
  assert.equal(stopped, false)
  releaseRenewal.resolve()
  await Promise.all([stop, run])
  assert.equal(networkActive, false)
  assert.equal(f.stats.activeRenewals, 0)
  assert.equal(f.stats.finishes.length, 0)
  assert.equal(f.stats.claims, 1)
})

test('stop waits for a pending claim and starts no snapshot or network after it returns', async t => {
  const f = fixture(), claiming = deferred(), release = deferred()
  t.after(() => release.resolve())
  f.store.claimCheck = async () => { claiming.resolve(); await release.promise; return f.lease }
  let discoveries = 0
  const { worker, run } = launch(t, f, { discover: async () => { discoveries++; return { tools: [] } } })
  await claiming.promise
  let stopped = false
  const stop = worker.stop().then(() => { stopped = true })
  await turn()
  assert.equal(stopped, false)
  release.resolve()
  await Promise.all([stop, run])
  assert.equal(discoveries, 0)
  assert.equal(f.stats.snapshots, 0)
  assert.equal(f.stats.finishes.length, 0)
})

test('stop waits for an already-started finish transaction without any renewal or second finish', async t => {
  const f = fixture(), release = deferred()
  t.after(() => release.resolve())
  f.store.finishCheck = async (_lease, outcome) => {
    f.stats.finishes.push(outcome)
    f.finishStarted.resolve()
    await release.promise
    return f.receipt('succeeded')
  }
  const { worker, run } = launch(t, f)
  await f.finishStarted.promise
  let stopped = false
  const stop = worker.stop().then(() => { stopped = true })
  await turn()
  assert.equal(stopped, false)
  release.resolve()
  await Promise.all([stop, run])
  assert.equal(f.stats.renewals, 0)
  assert.equal(f.stats.finishes.length, 1)
  assert.equal(f.stats.claims, 1)
})

test('unknown finish acknowledgements reject run and never rewrite or reclaim that epoch', async t => {
  for (const mode of ['lost-commit-response', 'nonterminal-receipt']) await t.test(mode, async st => {
    const f = fixture()
    f.store.finishCheck = async (_lease, outcome) => {
      f.stats.finishes.push(outcome)
      if (mode === 'lost-commit-response') throw new Error('COMMIT response lost: private database URL')
      return f.receipt('running')
    }
    const { run } = launch(st, f)
    await assert.rejects(run, isWorkerError('mcp_check_finish_uncertain'))
    assert.equal(f.stats.finishes.length, 1)
    assert.equal(f.stats.claims, 1)
    assert.equal(f.stats.renewals, 0)
  })
})

test('known store size refusal saves one failure after a precommit rejection; lost leases do not finish again', async t => {
  for (const mode of ['budget', 'lost-lease']) await t.test(mode, async st => {
    const f = fixture()
    f.store.finishCheck = async (_lease, outcome) => {
      f.stats.finishes.push(outcome)
      if ('tools' in outcome) {
        if (mode === 'lost-lease') { f.controller.abort(); throw new PlatformError(409, 'mcp_check_lease_lost') }
        throw new PlatformError(413, 'mcp_catalog_limit')
      }
      f.controller.abort()
      return f.receipt('failed')
    }
    const { run } = launch(st, f)
    await run
    if (mode === 'budget') assert.deepEqual(f.stats.finishes, [{ tools: [valid] }, { errorCode: 'mcp_catalog_limit' }])
    else assert.deepEqual(f.stats.finishes, [{ tools: [valid] }])
  })
})

test('poll failures delay retry, cancellation wakes the delay, and one instance cannot run twice', async t => {
  const f = fixture(), times = []
  f.store.claimCheck = async () => {
    times.push(performance.now())
    if (times.length === 3) { f.controller.abort(); return null }
    throw new Error('private poll failure')
  }
  const { worker, run } = launch(t, f)
  await assert.rejects(worker.run(new AbortController().signal), isWorkerError('mcp_check_worker_running'))
  await run
  assert.equal(times.length, 3)
  assert(times[1] - times[0] >= 40)
  assert(times[2] - times[1] >= 40)
  const alreadyStopped = new AbortController()
  alreadyStopped.abort()
  await worker.run(alreadyStopped.signal)
  assert.equal(times.length, 3)
})

test('worker rejects invalid deployment settings before any store operation', () => {
  const f = fixture()
  const base = { ownerId: f.ownerId, pollMs: 50, renewMs: 25, budgets, networkPolicy: {},
    toolLimits: { maxToolBytes: 16_384, maxDescriptionBytes: 8_192 } }
  for (const invalid of [{ pollMs: 0 }, { renewMs: Number.NaN },
    { toolLimits: { maxToolBytes: 0, maxDescriptionBytes: 8_192 } }]) {
    assert.throws(() => new McpCheckWorker(f.store, { ...base, ...invalid }), isWorkerError('mcp_check_worker_config_invalid'))
  }
  assert.equal(f.stats.claims, 0)
})

test('default worker discovers over real TLS outside store transactions and never sends tools/call',
  { timeout: 20_000 }, async t => {
    if (spawnSync('openssl', ['version']).status !== 0) { t.skip('OpenSSL is unavailable'); return }
    const temporary = await mkdtemp(join(tmpdir(), 'pe-s6-check-worker-'))
    let server
    const closes = [], methods = []
    t.after(async () => {
      if (server?.listening) {
        const closed = new Promise(done => server.close(done))
        server.closeAllConnections()
        await closed
      }
      await Promise.all(closes)
      await rm(temporary, { recursive: true, force: true })
    })
    const key = join(temporary, 'key.pem'), certificate = join(temporary, 'ca.pem')
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=mcp-worker.test',
      '-addext', 'subjectAltName=DNS:mcp-worker.test'], { encoding: 'utf8' })
    assert.equal(generated.status, 0, generated.stderr)
    const ca = await readFile(certificate, 'utf8')
    const f = fixture()
    let transactionOpen = false
    const snapshotMethod = f.store.checkSnapshot
    f.store.checkSnapshot = async lease => {
      transactionOpen = true
      try { return await snapshotMethod(lease) }
      finally { transactionOpen = false }
    }
    server = createServer({ key: await readFile(key), cert: ca }, async (request, response) => {
      assert.equal(transactionOpen, false)
      assert.equal(request.headers.authorization, 'Bearer fixture-private')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8'), message = raw ? JSON.parse(raw) : {}
      methods.push(message.method ?? request.method)
      if (request.method === 'GET') { response.writeHead(405).end(); return }
      if (request.method === 'DELETE') { response.writeHead(200).end(); return }
      if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return }
      let value
      if (message.method === 'server/discover') value = { error: { code: -32601, message: 'legacy fixture' } }
      else if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 'worker-fixture')
        value = { result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'worker-fixture', version: '1.0.0' } } }
      } else if (message.method === 'tools/list') value = { result: { tools: [valid] } }
      else { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...value }))
    })
    server.on('connection', socket => { closes.push(new Promise(done => socket.once('close', done))) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `https://mcp-worker.test:${server.address().port}`
    f.snapshot.serverUrl = origin + '/mcp'
    const { run } = launch(t, f, { discover: undefined, networkPolicy: {
      internalExceptions: [{ origin, addresses: ['127.0.0.1'], ca }],
      resolve: async () => [{ address: '127.0.0.1', family: 4 }] } })
    await run
    assert.deepEqual(f.stats.finishes, [{ tools: [valid] }])
    assert(methods.includes('initialize'))
    assert(methods.includes('tools/list'))
    assert(!methods.includes('tools/call'))
    await Promise.all(closes)
  })
