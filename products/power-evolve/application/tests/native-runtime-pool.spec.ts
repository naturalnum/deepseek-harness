/** Real PostgreSQL reservations and controlled Kubernetes observations exercise tenant pool lifecycle. */
import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { accountUserId } from '../src/account-contracts.ts'
import { CURRENT_SCHEMA_VERSION } from '../src/platform/database.ts'
import { KubernetesClient, KubernetesError } from '../src/platform/kubernetes.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { NativeRuntimePool, type NativeRuntimePoolConfig } from '../src/platform/native-runtime-pool.ts'
import { cloudFixture } from './cloud-fixture.ts'

const object = z.object({ metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()),
  finalizers: z.array(z.string()).optional() }).loose(), stringData: z.record(z.string(), z.string()).optional(),
  spec: z.record(z.string(), z.unknown()).optional() }).loose()

async function fixture(run: (value: {
  pool: NativeRuntimePool; main: Pool; locks: Pool; config: NativeRuntimePoolConfig;
  userId: z.infer<typeof accountUserId>; otherUserId: z.infer<typeof accountUserId>; resources: Map<string, Record<string, unknown>>;
  barrier: { entered: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined>; block: boolean; blockStop: boolean };
  calls: Array<{ method: string; path: string }>; seed: (unlinked?: boolean) => Promise<string>; retry: () => NativeRuntimePool;
  expectedFailures: Set<NativeRuntimePool>; hooks: { invalidStop: boolean; failPatchOnce: boolean; losePodResponse: boolean }
}) => Promise<void>) {
  await cloudFixture(async f => {
    for (let next = CURRENT_SCHEMA_VERSION + 1; next <= 11; next++) {
      await f.pool.query(await readFile(new URL(`../assets/cloud-schema-v${next}.sql`, import.meta.url), 'utf8'))
    }
    const main = new Pool({ ...f.pool.options, max: 1, connectionTimeoutMillis: 2000 })
    const locks = new Pool({ ...f.pool.options, max: 2, connectionTimeoutMillis: 2000 })
    const file = join(f.root, 'kubeconfig')
    await writeFile(file, JSON.stringify({ 'current-context': 'owned', contexts: [{ name: 'owned', context: { cluster: 'owned', user: 'owned' } }],
      clusters: [{ name: 'owned', cluster: { server: 'https://127.0.0.1:1', 'certificate-authority-data': 'dGVzdA==' } }],
      users: [{ name: 'owned', user: { token: 'fixture-token' } }] }), { mode: 0o600 })
    const kube = await KubernetesClient.fromFile(file)
    const resources = new Map<string, Record<string, unknown>>(), calls: Array<{ method: string; path: string }> = []
    const barrier = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>(), block: false, blockStop: false }
    const config: NativeRuntimePoolConfig = { kubeconfigFile: file, namespace: 'owned',
      image: 'fixture@sha256:' + 'a'.repeat(64), runtimeClass: 'gvisor', volumeClaimName: 'owned',
      storageSubPath: 'homes', localStateRoot: join(await realpath(f.root), 'homes'),
      deployment: { mode: 'local-http', privateDir: '/unused', dshHome: '/unused', hostOrigin: 'http://trial.example',
        platformOrigin: 'http://trial.example', platformInternalUrl: 'http://platform', rows: { 'native-runtime': {} } },
      credentialLifetimeMs: 60000, readyTimeoutMs: 2000, requestTimeoutMs: 1000, stopTimeoutMs: 1000,
      reconcileMs: 1000, maxResponseBytes: 1048576, maxRuntimeSeconds: 60, maxAccounts: 10, lockConnections: 2,
      resources: { requests: { cpu: '1', memory: '256Mi' }, limits: { cpu: '1', memory: '256Mi' } } }
    const userId = accountUserId.parse(f.alice.user.userId)
    const hooks = { invalidStop: false, failPatchOnce: false, losePodResponse: false }
    const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      calls.push({ method, path })
      if (path.includes('/proxy/')) {
        const id = path.match(/http:pe-runtime-([^:]+):8080/u)?.[1]
        const value = resources.get(kube.resourcePath(config.namespace, 'secrets', 'pe-runtime-' + id))
        if (!value) throw new KubernetesError(404, 'Missing secret')
        const data = z.object({ data: z.object({ 'deployment.json': z.string() }) }).parse(value)
        const deployment = z.object({ runtimeIdentity: z.object({ userId: z.string(), runtimeId: z.string(), generation: z.number() }) })
          .parse(JSON.parse(Buffer.from(data.data['deployment.json'], 'base64').toString()))
        return { runtimeUserId: deployment.runtimeIdentity.userId, runtimeId: deployment.runtimeIdentity.runtimeId,
          generation: deployment.runtimeIdentity.generation }
      }
      if (method === 'POST') {
        const input = object.parse(body), target = path + '/' + input.metadata.name
        if (resources.has(target)) throw new KubernetesError(409, 'Already exists')
        const value: Record<string, unknown> = { ...input, metadata: { ...input.metadata, uid: randomUUID(), resourceVersion: '1', generation: 1 } }
        if (input.stringData) value['data'] = Object.fromEntries(Object.entries(input.stringData).map(([key, data]) => [key, Buffer.from(data).toString('base64')]))
        if (path.endsWith('/pods')) value['spec'] = { ...input.spec, nodeName: 'owned-node' }
        resources.set(target, value)
        if (path.endsWith('/pods') && hooks.losePodResponse) {
          resources.delete(target); throw new KubernetesError(503, 'Pod creation response lost')
        }
        return value
      }
      const value = resources.get(path)
      if (!value) throw new KubernetesError(404, 'Missing resource')
      if (method === 'GET') {
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
        value['status'] = { phase: 'Failed', ...(hooks.invalidStop ? { reason: 'NodeLost' } : {}), conditions: [{ type: 'PodReadyToStartContainers', status: 'False', observedGeneration: 1 }],
          containerStatuses: [{ name: 'native-runtime', ready: false, restartCount: 0, containerID, lastState: {},
            state: { terminated: { exitCode: 0, containerID, startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z' } } }] }
        return value
      }
      throw new Error('Unexpected Kubernetes fixture method')
    }
    vi.spyOn(kube, 'call').mockImplementation(async <T>(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown) => await call(method, path, body) as T)
    const pool = new NativeRuntimePool(main, locks, kube, config)
    const owners = [pool], expectedFailures = new Set<NativeRuntimePool>()
    const retry = () => { const owner = new NativeRuntimePool(main, locks, kube, config); owners.push(owner); return owner }
    const seed = async (unlinked = false) => {
      const runtimeId = randomUUID(), authority = new NativeRuntimeAuthority(main)
      const credential = await authority.issue({ userId, runtimeId, generation: 1, lifetimeMs: 60000 })
      await main.query(`INSERT INTO pe_native_runtime_instances(runtime_id,user_id,generation,phase,credential_id)
        VALUES($1,$2,1,'creating',$3)`, [runtimeId, userId, unlinked ? null : credential.credentialId])
      await call('POST', kube.resourcePath(config.namespace, 'secrets'), { metadata: { name: 'pe-runtime-' + runtimeId,
        labels: { 'power-evolve.io/runtime': runtimeId, 'power-evolve.io/user': userId } }, stringData: {
        'runtime-token': credential.token, 'deployment.json': JSON.stringify({ runtimeIdentity: { userId, runtimeId, generation: 1 } }),
      } })
      return runtimeId
    }
    try { await run({ pool, main, locks, config, userId, otherUserId: accountUserId.parse(f.bob.user.userId), resources, barrier, calls, seed, retry, expectedFailures, hooks }) }
    finally {
      barrier.release.resolve(undefined)
      try {
        for (const owner of owners) await owner.close().catch(error => { if (!expectedFailures.has(owner)) throw error })
      } finally { await Promise.all([main.end(), locks.end()]) }
    }
  })
}

test('account advisory locks cannot consume the saturated main query pool', () => fixture(async f => {
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

test('a committed Secret resumes the same creating generation without issuing another credential', () => fixture(async f => {
  const original = await f.seed()
  const selected = await f.pool.ensure(f.userId)
  expect(selected.runtimeId).toBe(original)
  expect((await f.main.query('SELECT generation FROM pe_runtime_credentials')).rows).toEqual([{ generation: 1 }])
  expect((await stat(join(f.config.localStateRoot, f.userId, '.native-runtime'))).mode & 0o777).toBe(0o700)
  expect(f.calls.filter(row => row.method === 'POST' && row.path.endsWith('/pods'))).toHaveLength(1)
}))

test('close joins a blocked allocation, refuses new work and drains exact owned resources once', () => fixture(async f => {
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

test('NodeLost termination fields remain uncertain and cannot release the original runtime finalizer', () => fixture(async f => {
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

test('restart finishes finalizer cleanup from immutable persisted stop evidence', () => fixture(async f => {
  const selected = await f.pool.ensure(f.userId)
  f.hooks.failPatchOnce = true
  f.expectedFailures.add(f.pool)
  await expect(f.pool.close()).rejects.toMatchObject({ message: 'Native runtime drain failed' })
  const original = (await f.main.query('SELECT stop_proof FROM pe_native_runtime_instances')).rows[0]?.stop_proof
  expect(original).not.toBeNull()
  for (const [path, value] of f.resources) if (path.includes('/pods/')) {
    const metadata = z.record(z.string(), z.unknown()).parse(value['metadata'])
    value['metadata'] = { ...metadata, resourceVersion: '2' }
  }
  await f.retry().close()
  expect((await f.main.query('SELECT runtime_id,phase,stop_proof FROM pe_native_runtime_instances')).rows)
    .toEqual([{ runtime_id: selected.runtimeId, phase: 'stopped', stop_proof: original }])
  expect(f.resources.size).toBe(0)
}))

test('a lost Pod creation followed by missing original identity cannot create a replacement generation', () => fixture(async f => {
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

test('different account allocations cannot race past the shared runtime capacity', () => fixture(async f => {
  f.config.maxAccounts = 1
  const outcomes = await Promise.allSettled([f.pool.ensure(f.userId), f.pool.ensure(f.otherUserId)])
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = outcomes.find(result => result.status === 'rejected')
  expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'native_runtime_capacity' } })
  expect((await f.main.query("SELECT count(*)::int AS count FROM pe_native_runtime_instances WHERE phase<>'stopped'")).rows)
    .toEqual([{ count: 1 }])
}))

async function waitingForAccountLock(database: Pool): Promise<void> {
  const deadline = Date.now() + 10000
  for (;;) {
    const result = await database.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_locks
      WHERE locktype='advisory' AND classid=72819544 AND NOT granted) AS waiting`)
    if (result.rows[0]?.waiting) return
    if (Date.now() >= deadline) throw new Error('Reconciliation never waited for the owned account lock')
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

test('reconciliation rechecks a creating reservation after waiting for account ownership', () => fixture(async f => {
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

test('reconciliation observes a Pod request committed while it waited for account ownership', () => fixture(async f => {
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

test('drain requests only its configured number of account locks before a stop barrier releases', () => fixture(async f => {
  await f.pool.ensure(f.userId); await f.pool.ensure(f.otherUserId)
  f.config.lockConnections = 1
  f.barrier.blockStop = true
  const connections = vi.spyOn(f.locks, 'connect')
  const draining = f.pool.close(); void draining.catch(() => {})
  try {
    await Promise.race([f.barrier.entered.promise, draining])
    expect(connections).toHaveBeenCalledTimes(1)
  } finally { f.barrier.release.resolve(undefined) }
  await draining
  expect(connections).toHaveBeenCalledTimes(2)
  expect(f.resources.size).toBe(0)
}))
