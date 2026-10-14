/** Real PostgreSQL reservations and controlled Kubernetes observations exercise tenant pool lifecycle. */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Server } from 'node:https'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import type { Duplex } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { accountUserId } from '../src/account-contracts.ts'
import { CURRENT_SCHEMA_VERSION } from '../src/platform/database.ts'
import { KubernetesClient, KubernetesError } from '../src/platform/kubernetes.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { NativeRuntimePool, nativeRuntimePoolConfigDigest, type NativeRuntimePoolConfig } from '../src/platform/native-runtime-pool.ts'
import { cloudFixture } from './cloud-fixture.ts'

const object = z.object({ metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()),
  finalizers: z.array(z.string()).optional() }).loose(), stringData: z.record(z.string(), z.string()).optional(),
spec: z.record(z.string(), z.unknown()).optional() }).loose()

interface NativePoolFixture {
  pool: NativeRuntimePool
  main: Pool
  locks: Pool
  config: NativeRuntimePoolConfig
  userId: z.infer<typeof accountUserId>
  otherUserId: z.infer<typeof accountUserId>
  resources: Map<string, Record<string, unknown>>
  barrier: {
    entered: PromiseWithResolvers<undefined>
    release: PromiseWithResolvers<undefined>
    block: boolean
    blockStop: boolean
  }
  calls: Array<{ method: string; path: string }>
  seed: (unlinked?: boolean) => Promise<string>
  retry: (next?: NativeRuntimePoolConfig) => NativeRuntimePool
  expectedFailures: Set<NativeRuntimePool>
  hooks: {
    invalidStop: boolean
    failPatchOnce: boolean
    losePodResponse: boolean
    runtimeNotReady: boolean
    podPhase: 'Pending' | 'Running'
    readPod?: () => Promise<void>
    readReady?: (path: string, timeoutMs: number, token?: string) => Promise<unknown> }
}

async function fixture(run: (value: NativePoolFixture) => Promise<void>, overrides: Partial<NativeRuntimePoolConfig> = {}) {
  await cloudFixture(async (f) => {
    for (let next = CURRENT_SCHEMA_VERSION + 1; next <= 11; next++) {
      await f.pool.query(await readFile(new URL(`../assets/cloud-schema-v${next}.sql`, import.meta.url), 'utf8'))
    }
    const main = new Pool({ ...f.pool.options, max: 1, connectionTimeoutMillis: 2000 })
    const locks = new Pool({ ...f.pool.options, max: 2, connectionTimeoutMillis: 2000 })
    const file = join(f.root, 'kubeconfig')
    await writeFile(file, JSON.stringify({ 'current-context': 'owned',
      contexts: [{ name: 'owned', context: { cluster: 'owned', user: 'owned' } }],
      clusters: [{ name: 'owned', cluster: { server: 'https://127.0.0.1:1', 'certificate-authority-data': 'dGVzdA==' } }],
      users: [{ name: 'owned', user: { token: 'fixture-token' } }] }), { mode: 0o600 })
    const kube = await KubernetesClient.fromFile(file)
    const resources = new Map<string, Record<string, unknown>>(), calls: Array<{ method: string; path: string }> = []
    const barrier = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>(),
      block: false, blockStop: false }
    const config: NativeRuntimePoolConfig = { kubeconfigFile: file, namespace: 'owned',
      image: 'fixture@sha256:' + 'a'.repeat(64), runtimeClass: 'gvisor', volumeClaimName: 'owned',
      storageSubPath: 'homes', localStateRoot: join(await realpath(f.root), 'homes'),
      deployment: { mode: 'local-http', privateDir: '/unused', dshHome: '/unused', hostOrigin: 'http://trial.example',
        platformOrigin: 'http://trial.example', platformInternalUrl: 'http://platform', rows: { 'native-runtime': {} } },
      credentialLifetimeMs: 60000, readyTimeoutMs: 2000, requestTimeoutMs: 1000, stopTimeoutMs: 1000,
      reconcileMs: 1000, maxResponseBytes: 1048576, maxRuntimeSeconds: 60, maxAccounts: 10, lockConnections: 2,
      resources: { requests: { cpu: '1', memory: '256Mi' }, limits: { cpu: '1', memory: '256Mi' } }, ...overrides }
    const userId = accountUserId.parse(f.alice.user.userId)
    const hooks: NativePoolFixture['hooks'] = { invalidStop: false, failPatchOnce: false, losePodResponse: false,
      runtimeNotReady: false, podPhase: 'Running' }
    const call = async (method: string, path: string, body?: unknown, timeoutMs = 1000, token?: string): Promise<unknown> => {
      calls.push({ method, path })
      if (path.includes('/proxy/')) {
        if (hooks.readReady) return hooks.readReady(path, timeoutMs, token)
        const id = path.match(/http:pe-runtime-([^:]+):8080/u)?.[1]
        if (!id) throw new Error('Missing Runtime identity in fixture proxy address')
        const namespace = path.split('/')[4]
        if (!namespace) throw new Error('Missing namespace in fixture proxy address')
        const value = resources.get(kube.resourcePath(namespace, 'secrets', 'pe-runtime-' + id))
        if (!value) throw new KubernetesError(404, 'Missing secret')
        const data = z.object({ data: z.object({ 'deployment.json': z.string() }) }).parse(value)
        const deployment = z.object({ runtimeIdentity: z.object({ userId: z.string(), runtimeId: z.string(), generation: z.number() }) })
          .parse(JSON.parse(Buffer.from(data.data['deployment.json'], 'base64').toString()))
        return { ready: !hooks.runtimeNotReady, runtimeUserId: deployment.runtimeIdentity.userId,
          runtimeId: deployment.runtimeIdentity.runtimeId,
          generation: deployment.runtimeIdentity.generation }
      }
      if (method === 'POST') {
        const input = object.parse(body), target = path + '/' + input.metadata.name
        if (resources.has(target)) throw new KubernetesError(409, 'Already exists')
        const value: Record<string, unknown> = { ...input, metadata: { ...input.metadata, uid: randomUUID(), resourceVersion: '1', generation: 1 } }
        if (input.stringData) value['data'] = Object.fromEntries(Object.entries(input.stringData).map(([key, data]) => [key, Buffer.from(data).toString('base64')]))
        if (path.endsWith('/pods')) {
          value['spec'] = { ...input.spec, nodeName: 'owned-node' }
          value['status'] = { phase: hooks.podPhase }
        }
        resources.set(target, value)
        if (path.endsWith('/pods') && hooks.losePodResponse) {
          resources.delete(target); throw new KubernetesError(503, 'Pod creation response lost')
        }
        return value
      }
      const value = resources.get(path)
      if (!value) throw new KubernetesError(404, 'Missing resource')
      if (method === 'GET') {
        if (path.includes('/pods/')) await hooks.readPod?.()
        if (barrier.block && path.includes('/secrets/')) { barrier.entered.resolve(undefined); await barrier.release.promise }
        return value
      }
      if (method === 'PATCH') {
        if (hooks.failPatchOnce) { hooks.failPatchOnce = false; throw new KubernetesError(503, 'Finalizer response interrupted') }
        resources.delete(path); return value
      }
      if (method === 'DELETE') {
        if (!path.includes('/pods/')) { resources.delete(path); return value }
        if (barrier.blockStop) { barrier.entered.resolve(undefined); await barrier.release.promise }
        const metadata = z.record(z.string(), z.unknown()).parse(value['metadata'])
        value['metadata'] = { ...metadata, deletionTimestamp: '2026-10-14T00:00:01Z' }
        const containerID = 'containerd://' + 'a'.repeat(64)
        const initID = 'containerd://' + 'b'.repeat(64)
        value['status'] = { phase: 'Failed', ...(hooks.invalidStop ? { reason: 'NodeLost' } : {}), conditions: [{ type: 'PodReadyToStartContainers', status: 'False', observedGeneration: 1 }],
          initContainerStatuses: [{ name: 'prepare-private', ready: true, restartCount: 0, containerID: initID, lastState: {},
            state: { terminated: { exitCode: 0, containerID: initID,
              startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:00Z' } } }],
          containerStatuses: [{ name: 'native-runtime', ready: false, restartCount: 0, containerID, lastState: {},
            state: { terminated: { exitCode: 0, containerID,
              startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z' } } }] }
        return value
      }
      throw new Error('Unexpected Kubernetes fixture method')
    }
    vi.spyOn(kube, 'call').mockImplementation(async (method, path, body, timeoutMs, token) => await call(method, path, body, timeoutMs, token))
    const pool = new NativeRuntimePool(main, locks, kube, config)
    const owners = [pool], expectedFailures = new Set<NativeRuntimePool>()
    const retry = (next = config) => { const owner = new NativeRuntimePool(main, locks, kube, next); owners.push(owner); return owner }
    const seed = async (unlinked = false) => {
      const runtimeId = randomUUID(), authority = new NativeRuntimeAuthority(main)
      const credential = await authority.issue({ userId, runtimeId, generation: 1, lifetimeMs: 60000 })
      await main.query(`INSERT INTO pe_native_runtime_instances(runtime_id,user_id,generation,phase,credential_id,namespace,config_digest)
        VALUES($1,$2,1,'creating',$3,$4,$5)`, [runtimeId, userId, unlinked ? null : credential.credentialId,
        config.namespace, nativeRuntimePoolConfigDigest(config)])
      await call('POST', kube.resourcePath(config.namespace, 'secrets'), { metadata: { name: 'pe-runtime-' + runtimeId,
        labels: { 'power-evolve.io/runtime': runtimeId, 'power-evolve.io/user': userId } }, stringData: {
        'runtime-token': credential.token, 'deployment.json': JSON.stringify({ runtimeIdentity: { userId, runtimeId, generation: 1 } }),
      } })
      return runtimeId
    }
    try { await run({ pool, main, locks, config, userId, otherUserId: accountUserId.parse(f.bob.user.userId), resources, barrier,
      calls, seed, retry, expectedFailures, hooks }) }
    finally {
      barrier.release.resolve(undefined)
      try {
        for (const owner of owners) await owner.close().catch((error: unknown) => { if (!expectedFailures.has(owner)) throw error })
      } finally { await Promise.all([main.end(), locks.end()]) }
    }
  })
}

async function readinessTls(f: NativePoolFixture, run: (server: Server) => Promise<void>): Promise<void> {
  const key = join(f.config.localStateRoot, '..', 'readiness-key.pem')
  const certificate = join(f.config.localStateRoot, '..', 'readiness-cert.pem')
  const token = join(f.config.localStateRoot, '..', 'readiness-platform-token')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1', '-keyout', key, '-out', certificate], { stdio: 'ignore', timeout: 10000 })
  await writeFile(token, 'owned-readiness-platform-token', { mode: 0o600 })
  const sockets = new Set<Duplex>(), server = createServer({ key: await readFile(key), cert: await readFile(certificate) })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing owned readiness listener')
    const client = await KubernetesClient.fromServiceAccount(`https://127.0.0.1:${address.port}`, certificate, token)
    f.hooks.readReady = (path, timeoutMs, runnerToken) => client.call('GET', path, undefined, timeoutMs, runnerToken)
    await run(server)
  } finally {
    delete f.hooks.readReady
    const closing = new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
    await Promise.all([...sockets].map(async (socket) => {
      const closed = socket.closed ? Promise.resolve() : once(socket, 'close')
      socket.destroy(); await closed
    }))
    await closing
  }
}

function readinessReply(f: NativePoolFixture): Record<string, unknown> {
  const secret = [...f.resources].find(([path]) => path.includes('/secrets/'))?.[1]
  const deployment = z.object({ data: z.object({ 'deployment.json': z.string() }) }).parse(secret)
  const identity = z.object({ runtimeIdentity: z.object({ userId: z.string(), runtimeId: z.string(), generation: z.number() }) })
    .parse(JSON.parse(Buffer.from(deployment.data['deployment.json'], 'base64').toString())).runtimeIdentity
  return { ready: true, runtimeUserId: identity.userId, runtimeId: identity.runtimeId, generation: identity.generation }
}

test('cold readiness skips Pending and survives original TLS proxy misses without another generation or business request', () => fixture(async (f) => {
  f.hooks.podPhase = 'Pending'
  const pending = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let reads = 0, requests = 0
  f.hooks.readPod = async () => { if (++reads === 2) { pending.resolve(undefined); await release.promise } }
  const before = (await f.main.query('SELECT count(*) AS count FROM pe_sessions')).rows
  await readinessTls(f, async (server) => {
    const statuses = [404, 500, 0, 502, 503, 504, 200]
    server.on('request', (request, response) => {
      requests++
      expect(request.method).toBe('GET')
      const status = statuses.shift()
      if (status === 0) { request.socket.destroy(); return }
      response.statusCode = status ?? 500
      response.end(JSON.stringify(status === 200 ? readinessReply(f) : { unavailable: true }))
    })
    const work = f.pool.ensure(f.userId)
    void work.catch(() => {})
    try {
      await Promise.race([pending.promise, work])
      expect(requests).toBe(0)
      for (const [path, pod] of f.resources) if (path.includes('/pods/')) pod['status'] = { phase: 'Running' }
    } finally { release.resolve(undefined) }
    const selected = await work
    expect(requests).toBe(7)
    expect((await f.main.query('SELECT runtime_id,generation,phase FROM pe_native_runtime_instances')).rows)
      .toEqual([{ runtime_id: selected.runtimeId, generation: 1, phase: 'ready' }])
    expect(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/pods'))).toHaveLength(1)
    expect(f.calls.filter(call => call.path.includes('/proxy/')).every(call => call.method === 'GET')).toBe(true)
    expect((await f.main.query('SELECT count(*) AS count FROM pe_sessions')).rows).toEqual(before)
  })
}, { readyTimeoutMs: 15000 }))

test.each([401, 403])('cold readiness refuses original TLS authorization status %s without retry', status => fixture(async (f) => {
  await readinessTls(f, async (server) => {
    let requests = 0
    server.on('request', (_request, response) => { requests++; response.statusCode = status; response.end('{}') })
    await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ status })
    expect(requests).toBe(1)
    expect((await f.main.query('SELECT generation,phase FROM pe_native_runtime_instances')).rows)
      .toEqual([{ generation: 1, phase: 'creating' }])
  })
}))

test.each(['schema', 'identity'])('cold readiness retains an original TLS %s refusal', kind => fixture(async (f) => {
  await readinessTls(f, async (server) => {
    let requests = 0
    server.on('request', (_request, response) => {
      requests++
      response.end(JSON.stringify(kind === 'schema' ? { ready: true }
        : { ...readinessReply(f), runtimeUserId: f.otherUserId }))
    })
    const work = f.pool.ensure(f.userId)
    if (kind === 'schema') await expect(work).rejects.toBeInstanceOf(z.ZodError)
    else await expect(work).rejects.toMatchObject({ code: 'native_runtime_identity_mismatch' })
    expect(requests).toBe(1)
  })
}))

test('every cold readiness TLS GET fits the remaining deadline and joins its interrupted response', () => fixture(async (f) => {
  await readinessTls(f, async (server) => {
    const closed = Promise.withResolvers<undefined>(), budgets: number[] = []
    const read = f.hooks.readReady
    if (!read) throw new Error('Missing original TLS reader')
    f.hooks.readReady = (path, timeoutMs, token) => { budgets.push(timeoutMs); return read(path, timeoutMs, token) }
    server.on('request', (_request, response) => { response.write('{'); response.once('close', () => { closed.resolve(undefined) }) })
    await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_ready_timeout' })
    await closed.promise
    expect(budgets).toHaveLength(1)
    expect(budgets[0]).toBeGreaterThan(0)
    expect(budgets[0]).toBeLessThanOrEqual(f.config.readyTimeoutMs)
    expect(budgets[0]).toBeLessThan(f.config.requestTimeoutMs)
    expect((await f.main.query('SELECT generation,phase FROM pe_native_runtime_instances')).rows)
      .toEqual([{ generation: 1, phase: 'creating' }])
  })
}, { requestTimeoutMs: 180000 }))

test('account advisory locks cannot consume the saturated main query pool', () => fixture(async (f) => {
  await f.seed()
  f.barrier.block = true
  const work = Promise.all(Array.from({ length: 4 }, () => f.pool.ensure(f.userId)))
  void work.catch(() => {})
  try {
    await Promise.race([f.barrier.entered.promise, work])
    expect((await f.main.query<{ value: number }>('SELECT 1 AS value')).rows).toEqual([{ value: 1 }])
  } finally { f.barrier.release.resolve(undefined) }
  const result = await work
  expect(new Set(result.map(row => row.runtimeId)).size).toBe(1)
}))

test('a committed Secret resumes the same creating generation without issuing another credential', () => fixture(async (f) => {
  const original = await f.seed()
  const selected = await f.pool.ensure(f.userId)
  expect(selected.runtimeId).toBe(original)
  expect((await f.main.query('SELECT generation FROM pe_runtime_credentials')).rows).toEqual([{ generation: 1 }])
  expect((await stat(join(f.config.localStateRoot, f.userId, '.native-runtime'))).mode & 0o777).toBe(0o700)
  expect(f.calls.filter(row => row.method === 'POST' && row.path.endsWith('/pods'))).toHaveLength(1)
}))

test('an account identity without native composition readiness remains in its original creating generation', () => fixture(async (f) => {
  f.hooks.runtimeNotReady = true
  await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_ready_timeout' })
  const rows = (await f.main.query<{ runtime_id: string; phase: string }>('SELECT runtime_id,phase FROM pe_native_runtime_instances')).rows
  expect(rows).toHaveLength(1)
  expect(rows[0]?.phase).toBe('creating')
  f.hooks.runtimeNotReady = false
  expect((await f.pool.ensure(f.userId)).runtimeId).toBe(rows[0]?.runtime_id)
  expect(f.calls.filter(row => row.method === 'POST' && row.path.endsWith('/pods'))).toHaveLength(1)
}))

test('close joins a blocked allocation, refuses new work and drains exact owned resources once', () => fixture(async (f) => {
  await f.seed(); f.barrier.block = true
  const work = f.pool.ensure(f.userId)
  void work.catch(() => {})
  await Promise.race([f.barrier.entered.promise, work])
  let stopped = false
  const close = f.pool.close().then(() => { stopped = true })
  expect(f.pool.close()).toBe(f.pool.close())
  await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_closing' })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(stopped).toBe(false)
  f.barrier.release.resolve(undefined)
  await work; await close
  expect((await f.main.query('SELECT phase,stop_proof IS NOT NULL AS proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ phase: 'stopped', proof: true }])
  expect(f.resources.size).toBe(0)
}))

test('NodeLost termination fields remain uncertain and cannot release the original runtime finalizer', () => fixture(async (f) => {
  await f.pool.ensure(f.userId)
  f.hooks.invalidStop = true
  f.expectedFailures.add(f.pool)
  await expect(f.pool.close()).rejects.toMatchObject({ message: 'Native runtime drain failed' })
  expect((await f.main.query('SELECT phase,stop_proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ phase: 'stopping', stop_proof: null }])
  expect(f.calls.some(row => row.method === 'PATCH')).toBe(false)
  f.hooks.invalidStop = false
  for (const [path, value] of f.resources) if (path.includes('/pods/')) {
    const status = z.record(z.string(), z.unknown()).parse(value['status'])
    Reflect.deleteProperty(status, 'reason'); value['status'] = status
  }
  await f.retry().close()
}))

test('restart finishes finalizer cleanup from immutable persisted stop evidence', () => fixture(async (f) => {
  const selected = await f.pool.ensure(f.userId)
  f.hooks.failPatchOnce = true
  f.expectedFailures.add(f.pool)
  await expect(f.pool.close()).rejects.toMatchObject({ message: 'Native runtime drain failed' })
  const original = (await f.main.query<{ stop_proof: unknown }>('SELECT stop_proof FROM pe_native_runtime_instances')).rows[0]?.stop_proof
  expect(original).not.toBeNull()
  for (const [path, value] of f.resources) if (path.includes('/pods/')) {
    const metadata = z.record(z.string(), z.unknown()).parse(value['metadata'])
    value['metadata'] = { ...metadata, resourceVersion: '2' }
  }
  await f.retry().close()
  expect((await f.main.query<{ runtime_id: string; phase: string; stop_proof: unknown }>('SELECT runtime_id,phase,stop_proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ runtime_id: selected.runtimeId, phase: 'stopped', stop_proof: original }])
  expect(f.resources.size).toBe(0)
}))

test('a lost Pod creation followed by missing original identity cannot create a replacement generation', () => fixture(async (f) => {
  await f.seed(); f.hooks.losePodResponse = true
  f.expectedFailures.add(f.pool)
  await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_stop_proof_unavailable' })
  await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_stop_proof_unavailable' })
  expect((await f.main.query('SELECT generation,phase,pod_create_requested_at IS NOT NULL AS requested FROM pe_native_runtime_instances')).rows)
    .toEqual([{ generation: 1, phase: 'stopping', requested: true }])
  expect((await f.main.query('SELECT count(*)::int AS count FROM pe_runtime_credentials')).rows).toEqual([{ count: 1 }])
  expect(f.calls.filter(row => row.method === 'POST' && row.path.endsWith('/pods'))).toHaveLength(1)
  await expect(f.pool.close()).rejects.toMatchObject({ message: 'Native runtime drain failed' })
}))

test('different account allocations cannot race past the shared runtime capacity', () => fixture(async (f) => {
  const controller = f.retry({ ...f.config, maxAccounts: 1 })
  const outcomes = await Promise.allSettled([controller.ensure(f.userId), controller.ensure(f.otherUserId)])
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = outcomes.find(result => result.status === 'rejected')
  expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'native_runtime_capacity' } })
  expect((await f.main.query("SELECT count(*)::int AS count FROM pe_native_runtime_instances WHERE phase<>'stopped'")).rows)
    .toEqual([{ count: 1 }])
}))

async function waitingForAccountLock(database: Pool, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 10000
  for (;;) {
    signal?.throwIfAborted()
    const result = await database.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks
      WHERE locktype='advisory' AND classid=72819544 AND NOT granted) AS waiting`)
    if (result.rows[0]?.waiting) return
    if (Date.now() >= deadline) throw new Error('Reconciliation never waited for the owned account lock')
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

test('reconciliation rechecks a creating reservation after waiting for account ownership', () => fixture(async (f) => {
  const runtimeId = await f.seed(true)
  const credential = (await f.main.query<{ id: string }>('SELECT id FROM pe_runtime_credentials')).rows[0]?.id
  const lock = await f.locks.connect()
  let work: Promise<void> | undefined
  try {
    await lock.query('SELECT pg_advisory_lock(72819544,hashtext($1))', [f.userId])
    work = f.pool.reconcile(); void work.catch(() => {})
    await waitingForAccountLock(f.main)
    await f.main.query('UPDATE pe_native_runtime_instances SET credential_id=$2 WHERE runtime_id=$1', [runtimeId, credential])
  } finally {
    await lock.query('SELECT pg_advisory_unlock(72819544,hashtext($1))', [f.userId]); lock.release()
  }
  await work
  expect((await f.main.query('SELECT phase FROM pe_native_runtime_instances')).rows).toEqual([{ phase: 'creating' }])
  expect((await f.main.query('SELECT revoked_at FROM pe_runtime_credentials')).rows).toEqual([{ revoked_at: null }])
}))

test('reconciliation observes a Pod request committed while it waited for account ownership', () => fixture(async (f) => {
  const runtimeId = await f.seed(true)
  const lock = await f.locks.connect()
  let work: Promise<void> | undefined
  f.expectedFailures.add(f.pool)
  try {
    await lock.query('SELECT pg_advisory_lock(72819544,hashtext($1))', [f.userId])
    work = f.pool.reconcile(); void work.catch(() => {})
    await waitingForAccountLock(f.main)
    await f.main.query('UPDATE pe_native_runtime_instances SET pod_create_requested_at=clock_timestamp() WHERE runtime_id=$1', [runtimeId])
  } finally {
    await lock.query('SELECT pg_advisory_unlock(72819544,hashtext($1))', [f.userId]); lock.release()
  }
  await expect(work).rejects.toMatchObject({ message: 'Native runtime reconciliation failed' })
  expect((await f.main.query('SELECT phase,stop_proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ phase: 'stopping', stop_proof: null }])
  await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_stop_proof_unavailable' })
}))

test('drain requests only its configured number of account locks before a stop barrier releases', () => fixture(async (f) => {
  const controller = f.retry({ ...f.config, lockConnections: 1 })
  await controller.ensure(f.userId); await controller.ensure(f.otherUserId)
  f.barrier.blockStop = true
  const connections = vi.spyOn(f.locks, 'connect')
  const draining = controller.close(); void draining.catch(() => {})
  try {
    await Promise.race([f.barrier.entered.promise, draining])
    expect(connections).toHaveBeenCalledTimes(1)
  } finally { f.barrier.release.resolve(undefined) }
  await draining
  expect(connections).toHaveBeenCalledTimes(2)
  expect(f.resources.size).toBe(0)
}))

test('configuration digest is canonical and detects a changed immutable deployment', () => fixture(async (f) => {
  const original = { ...f.config, deployment: { ...f.config.deployment, rows: { 'native-runtime': { a: { z: 1, b: 2 }, b: { value: 3 } } } } }
  const reordered = { ...f.config, deployment: { ...f.config.deployment, rows: { 'native-runtime': { b: { value: 3 }, a: { b: 2, z: 1 } } } } }
  expect(nativeRuntimePoolConfigDigest(original)).toBe(nativeRuntimePoolConfigDigest(reordered))
  expect(nativeRuntimePoolConfigDigest({ ...original, image: 'fixture@sha256:' + 'b'.repeat(64) }))
    .not.toBe(nativeRuntimePoolConfigDigest(original))
}))

test('a changed namespace and image stop the original Pod before allocating the next configured generation', () => fixture(async (f) => {
  const original = await f.pool.ensure(f.userId)
  f.calls.length = 0
  const config = { ...f.config, namespace: 'next-owned', image: 'fixture@sha256:' + 'b'.repeat(64) }
  const selected = await f.retry(config).ensure(f.userId)
  expect(selected.runtimeId).not.toBe(original.runtimeId)
  expect(selected.generation).toBe(2)
  const originalDelete = f.calls.findIndex(row => row.method === 'DELETE' && row.path.includes('/owned/pods/pe-runtime-' + original.runtimeId))
  const nextCreate = f.calls.findIndex(row => row.method === 'POST' && row.path.endsWith('/next-owned/pods'))
  expect(originalDelete).toBeGreaterThanOrEqual(0)
  expect(nextCreate).toBeGreaterThan(originalDelete)
  expect((await f.main.query('SELECT namespace,config_digest,phase FROM pe_native_runtime_instances ORDER BY generation')).rows)
    .toEqual([{ namespace: 'owned', config_digest: nativeRuntimePoolConfigDigest(f.config), phase: 'stopped' },
      { namespace: config.namespace, config_digest: nativeRuntimePoolConfigDigest(config), phase: 'ready' }])
}))

test('a ready Pod with a changed actual image is refused despite its unchanged durable configuration', () => fixture(async (f) => {
  await f.pool.ensure(f.userId)
  for (const [path, value] of f.resources) if (path.includes('/pods/')) {
    const spec = z.object({ containers: z.array(z.object({ name: z.string(), image: z.string() }).loose()) }).loose().parse(value['spec'])
    value['spec'] = { ...spec, containers: spec.containers.map(container => ({ ...container, image: 'fixture@sha256:' + 'b'.repeat(64) })) }
  }
  await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_pod_configuration_mismatch' })
}))

test.each(['init-image', 'init-subpath', 'foreign-state', 'writable-private'] as const)(
  'an altered %s cannot change the ready Runtime private files or account storage', alteration => fixture(async (f) => {
    await f.pool.ensure(f.userId)
    for (const [path, value] of f.resources) if (path.includes('/pods/')) {
      const spec = z.object({
        initContainers: z.array(z.object({ image: z.string(), volumeMounts: z.array(z.record(z.string(), z.unknown())) }).loose()),
        containers: z.array(z.object({ volumeMounts: z.array(z.record(z.string(), z.unknown())) }).loose()),
      }).loose().parse(value['spec'])
      const init = spec.initContainers[0], runtime = spec.containers[0]
      if (!init || !runtime) throw new Error('Fixture Runtime composition is absent')
      if (alteration === 'init-image') init.image = 'fixture@sha256:' + 'c'.repeat(64)
      if (alteration === 'init-subpath') {
        const mount = init.volumeMounts[0]
        if (!mount) throw new Error('Fixture initialization mount is absent')
        mount['subPath'] = 'another-key'
      }
      const state = runtime.volumeMounts.find(mount => mount['name'] === 'state')
      const privateFiles = runtime.volumeMounts.find(mount => mount['name'] === 'private')
      if (!state || !privateFiles) throw new Error('Fixture account mounts are absent')
      if (alteration === 'foreign-state') state['subPath'] = `homes/${f.otherUserId}/.native-runtime`
      if (alteration === 'writable-private') privateFiles['readOnly'] = false
      value['spec'] = spec
    }
    await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_private_preparation_mismatch' })
  }))

for (const phase of ['ready', 'creating'] as const) test(`reconciliation retires an exact failed ${phase} Pod with a still live credential`, () => fixture(async (f) => {
  const original = await f.pool.ensure(f.userId)
  await f.main.query('UPDATE pe_native_runtime_instances SET phase=$2 WHERE runtime_id=$1', [original.runtimeId, phase])
  for (const [path, value] of f.resources) if (path.includes('/pods/')) value['status'] = { phase: 'Failed' }
  expect((await f.main.query('SELECT revoked_at FROM pe_runtime_credentials')).rows).toEqual([{ revoked_at: null }])
  f.calls.length = 0
  await f.pool.reconcile()
  expect((await f.main.query('SELECT runtime_id,generation,phase,stop_proof IS NOT NULL AS proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ runtime_id: original.runtimeId, generation: 1, phase: 'stopped', proof: true }])
  expect((await f.main.query('SELECT revoked_at IS NOT NULL AS revoked FROM pe_runtime_credentials')).rows).toEqual([{ revoked: true }])
  expect(f.calls.filter(row => row.method === 'POST')).toHaveLength(0)
  expect(f.resources.size).toBe(0)
  const next = await f.pool.ensure(f.userId)
  expect(next.generation).toBe(2); expect(next.runtimeId).not.toBe(original.runtimeId)
}))

test('reconciliation observes a live credential Pod failure only after acquiring its original account lock', () => fixture(async (f) => {
  const original = await f.pool.ensure(f.userId), lock = await f.locks.connect()
  let work: Promise<void> | undefined, observing: Promise<void> | undefined
  const stopObserving = new AbortController()
  f.calls.length = 0
  try {
    await lock.query('SELECT pg_advisory_lock(72819544,hashtext($1))', [f.userId])
    work = f.pool.reconcile(); void work.catch(() => {})
    observing = waitingForAccountLock(f.main, stopObserving.signal)
    await Promise.race([observing, work.then(() => { throw new Error('Live Pod reconciliation did not acquire account ownership') })])
    expect(f.calls).toHaveLength(0)
    for (const [path, value] of f.resources) if (path.includes('/pods/')) value['status'] = { phase: 'Failed' }
  } finally {
    stopObserving.abort(); await observing?.catch(() => {})
    await lock.query('SELECT pg_advisory_unlock(72819544,hashtext($1))', [f.userId]); lock.release()
  }
  await work
  expect((await f.main.query<{ runtime_id: string; phase: string }>('SELECT runtime_id,phase FROM pe_native_runtime_instances')).rows)
    .toEqual([{ runtime_id: original.runtimeId, phase: 'stopped' }])
}))

test('reconciliation preserves a healthy original Pod and never issues a credential or replays a request', () => fixture(async (f) => {
  const original = await f.pool.ensure(f.userId)
  f.calls.length = 0
  await f.pool.reconcile()
  expect(f.calls).toEqual([{ method: 'GET', path: `/api/v1/namespaces/owned/pods/pe-runtime-${original.runtimeId}` }])
  expect((await f.main.query('SELECT phase FROM pe_native_runtime_instances')).rows).toEqual([{ phase: 'ready' }])
  expect((await f.main.query('SELECT revoked_at FROM pe_runtime_credentials')).rows).toEqual([{ revoked_at: null }])
}))

test('reconciliation cannot release a missing original Pod or allocate a replacement generation', () => fixture(async (f) => {
  const original = await f.pool.ensure(f.userId)
  for (const path of f.resources.keys()) if (path.includes('/pods/')) f.resources.delete(path)
  f.expectedFailures.add(f.pool); f.calls.length = 0
  await expect(f.pool.reconcile()).rejects.toMatchObject({ message: 'Native runtime reconciliation failed' })
  await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_stop_proof_unavailable' })
  expect((await f.main.query('SELECT runtime_id,generation,phase,stop_proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ runtime_id: original.runtimeId, generation: 1, phase: 'stopping', stop_proof: null }])
  expect(f.calls.some(row => row.method === 'POST' || row.method === 'PATCH')).toBe(false)
}))

test('reconciliation refuses a substituted Pod UID and preserves its original stopped-proof obligation', () => fixture(async (f) => {
  const original = await f.pool.ensure(f.userId)
  for (const [path, value] of f.resources) if (path.includes('/pods/')) {
    const metadata = z.record(z.string(), z.unknown()).parse(value['metadata'])
    value['metadata'] = { ...metadata, uid: randomUUID() }; value['status'] = { phase: 'Failed' }
  }
  f.expectedFailures.add(f.pool); f.calls.length = 0
  await expect(f.pool.reconcile()).rejects.toMatchObject({ message: 'Native runtime reconciliation failed' })
  await expect(f.pool.ensure(f.userId)).rejects.toMatchObject({ code: 'native_runtime_pod_replaced' })
  expect((await f.main.query('SELECT runtime_id,generation,phase,stop_proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ runtime_id: original.runtimeId, generation: 1, phase: 'stopping', stop_proof: null }])
  expect(f.calls.some(row => row.method === 'POST' || row.method === 'DELETE' || row.method === 'PATCH')).toBe(false)
}))

test('reconciliation never promotes NodeLost failure into kubelet stop proof', () => fixture(async (f) => {
  const original = await f.pool.ensure(f.userId)
  for (const [path, value] of f.resources) if (path.includes('/pods/')) value['status'] = { phase: 'Failed', reason: 'NodeLost' }
  f.hooks.invalidStop = true; f.expectedFailures.add(f.pool); f.calls.length = 0
  await expect(f.pool.reconcile()).rejects.toMatchObject({ message: 'Native runtime reconciliation failed' })
  expect((await f.main.query('SELECT runtime_id,generation,phase,stop_proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ runtime_id: original.runtimeId, generation: 1, phase: 'stopping', stop_proof: null }])
  expect(f.calls.some(row => row.method === 'POST' || row.method === 'PATCH')).toBe(false)
}))

test('a Kubernetes read transport failure never retires or replays the original healthy generation', () => fixture(async (f) => {
  const original = await f.pool.ensure(f.userId), get = f.resources.get.bind(f.resources)
  const observe = vi.spyOn(f.resources, 'get').mockImplementation((path) => {
    if (path.includes('/pods/')) throw new KubernetesError(503, 'Original Pod observation interrupted')
    return get(path)
  })
  f.calls.length = 0
  try {
    await expect(f.pool.reconcile()).rejects.toMatchObject({ message: 'Native runtime reconciliation failed' })
    expect((await f.main.query('SELECT runtime_id,generation,phase FROM pe_native_runtime_instances')).rows)
      .toEqual([{ runtime_id: original.runtimeId, generation: 1, phase: 'ready' }])
    expect((await f.main.query('SELECT revoked_at FROM pe_runtime_credentials')).rows).toEqual([{ revoked_at: null }])
    expect(f.calls.some(row => row.method !== 'GET')).toBe(false)
  } finally { observe.mockRestore() }
}))

test('restart preserves completed-before-deletion raw proof and retries only its original finalizer cleanup', () => fixture(async (f) => {
  const original = await f.pool.ensure(f.userId)
  const containerID = 'containerd://' + 'a'.repeat(64)
  for (const [path, value] of f.resources) if (path.includes('/pods/')) {
    const metadata = z.record(z.string(), z.unknown()).parse(value['metadata'])
    value['metadata'] = { ...metadata, generation: 2, deletionTimestamp: '2026-10-14T08:00:55Z', deletionGracePeriodSeconds: 0 }
    const init = z.object({ initContainers: z.array(z.object({ name: z.string() }).loose()).optional() }).loose().parse(value['spec'])
    const initID = 'containerd://' + 'b'.repeat(64)
    value['status'] = { phase: 'Failed', observedGeneration: 1,
      ...(init.initContainers?.length ? { initContainerStatuses: [{ name: 'prepare-private', ready: true, started: false,
        restartCount: 0, containerID: initID, imageID: f.config.image, lastState: {},
        state: { terminated: { containerID: initID, exitCode: 0, startedAt: '2026-10-14T07:07:00Z',
          finishedAt: '2026-10-14T07:07:01Z' } } }] } : {}),
      conditions: ['PodReadyToStartContainers', 'Initialized', 'Ready', 'ContainersReady', 'PodScheduled'].map(type => ({ type,
        status: ['Initialized', 'PodScheduled'].includes(type) ? 'True' : 'False', observedGeneration: 1,
        lastTransitionTime: '2026-10-14T07:07:32Z' })),
      containerStatuses: [{ name: 'native-runtime', ready: false, started: false, restartCount: 0, containerID,
        imageID: f.config.image, lastState: {}, state: { terminated: { containerID, exitCode: 1,
          startedAt: '2026-10-14T07:07:31Z', finishedAt: '2026-10-14T07:07:31Z' } } }],
    }
  }
  f.hooks.failPatchOnce = true; f.calls.length = 0
  await expect(f.pool.reconcile()).rejects.toMatchObject({ message: 'Native runtime reconciliation failed' })
  const result = await f.main.query<{ stop_proof: unknown }>(
    'SELECT stop_proof FROM pe_native_runtime_instances WHERE runtime_id=$1', [original.runtimeId])
  const persisted = result.rows[0]?.stop_proof
  expect(persisted).toMatchObject({ metadata: { generation: 2 }, status: { observedGeneration: 1 } })
  await f.retry().close()
  expect((await f.main.query('SELECT runtime_id,phase,stop_proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ runtime_id: original.runtimeId, phase: 'stopped', stop_proof: persisted }])
  expect(f.calls.some(row => row.method === 'POST' || row.method === 'DELETE' && row.path.includes('/pods/'))).toBe(false)
  expect(f.resources.size).toBe(0)
}))
