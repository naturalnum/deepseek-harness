/** Actual pg connections/SQL, bounded observers and runtime-only PostgreSQL fault evidence. */
import { readFile } from 'node:fs/promises'
import { Client, defaults } from 'pg'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PgOwnerExecutor, type OwnerPgConnection, type OwnerPgLimits } from '../src/owner-pg-executor.ts'
import { OwnerPgNotSubmittedError } from '../src/owner-pg-errors.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import { account, instance, limits } from './owner-fixture.ts'
import { pgResponseProxy, type PgResponseProxy } from './pg-response-proxy.ts'

const budgets: OwnerPgLimits = {
  maxConnections: 2, maxQueued: 2, queueTimeoutMs: 1000, connectionTimeoutMs: 1000,
  statementTimeoutMs: 5000, lockTimeoutMs: 4000, maxObservedOperations: 4, maxObservers: 4,
}
const offline: OwnerPgConnection = { host: '127.0.0.1', port: 1, user: 'fixture', password: 'fixture', database: 'fixture', ssl: false }
const adapters = new Set<PgOwnerExecutor>()
const controls = new Set<Client>()
const proxies = new Set<PgResponseProxy>()
afterEach(async () => {
  // End control transactions first, so failed assertions cannot strand a real row lock.
  for (const client of controls) await client.end()
  controls.clear()
  for (const adapter of adapters) await adapter.close()
  adapters.clear()
  for (const proxy of proxies) await proxy.close()
  proxies.clear()
})

describe('bounded owner database observation without a server', () => {
  it('retains one settlement subscription across expired waits and bounds actual-observation records', async () => {
    const adapter = new PgOwnerExecutor(offline, { ...budgets, maxObservedOperations: 1, maxObservers: 1 })
    adapters.add(adapter)
    const actual = Promise.withResolvers<undefined>()
    const unrelated = Promise.withResolvers<undefined>()
    try {
      for (let index = 0; index < 6; index++) {
        await expect(adapter.observe(actual.promise, Date.now() + 2)).resolves.toEqual({ status: 'pending', reason: 'deadline' })
        expect(adapter.inspect()).toMatchObject({ observedOperations: 1, observers: 0, connections: 0 })
      }
      expect(() => adapter.observe(unrelated.promise, Date.now() + 1000)).toThrow('actual-observation capacity')
    } finally { actual.resolve(undefined); unrelated.resolve(undefined) }
    await expect.poll(() => adapter.inspect().observedOperations).toBe(0)
  })

  it('cancels only the observer and bounds concurrent waiters on the same actual work', async () => {
    const adapter = new PgOwnerExecutor(offline, { ...budgets, maxObservers: 1 })
    adapters.add(adapter)
    const actual = Promise.withResolvers<undefined>()
    const observer = new AbortController()
    const first = adapter.observe(actual.promise, Date.now() + 1000, observer.signal)
    expect(() => adapter.observe(actual.promise, Date.now() + 1000)).toThrow('observer capacity')
    observer.abort()
    await expect(first).resolves.toEqual({ status: 'pending', reason: 'observer-cancelled' })
    expect(adapter.inspect()).toMatchObject({ observedOperations: 1, observers: 0 })
    const second = adapter.observe(actual.promise, Date.now() + 1000)
    actual.resolve(undefined)
    await expect(second).resolves.toEqual({ status: 'settled', outcome: 'fulfilled' })
    expect(adapter.inspect()).toMatchObject({ observedOperations: 0, observers: 0 })
  })

  it('closes admission without a connection and validates finite budgets', async () => {
    const adapter = new PgOwnerExecutor(offline, budgets)
    adapters.add(adapter)
    const closed = adapter.close()
    expect(adapter.close() === closed).toBe(true)
    await expect(adapter.query('SELECT 1', [])).rejects.toBeInstanceOf(OwnerPgNotSubmittedError)
    expect(() => new PgOwnerExecutor(offline, { ...budgets, statementTimeoutMs: 0 })).toThrow('time budgets')
    expect(() => new PgOwnerExecutor(offline, { ...budgets, maxQueued: -1 })).toThrow('queue capacity')
    expect(() => adapter.observe(Promise.resolve(), Number.POSITIVE_INFINITY)).toThrow('deadline')
  })

  it('refuses inherited pg early query timeout before any connection or SQL', async () => {
    const adapter = new PgOwnerExecutor(offline, budgets)
    adapters.add(adapter)
    const previous = defaults.query_timeout
    try {
      defaults.query_timeout = 20
      await expect(adapter.query('SELECT 1', [])).rejects.toMatchObject({
        name: 'OwnerPgNotSubmittedError', message: 'Owner database requires pg client query timeout to stay disabled',
      })
      expect(adapter.inspect()).toMatchObject({ connections: 0, queued: 0 })
    } finally { defaults.query_timeout = previous }
  })

  it('retains actual responsibility even when the first observer arrives already cancelled', async () => {
    const adapter = new PgOwnerExecutor(offline, { ...budgets, maxObservedOperations: 1 })
    adapters.add(adapter)
    const actual = Promise.withResolvers<undefined>()
    const other = Promise.withResolvers<undefined>()
    try {
      await expect(adapter.observe(actual.promise, Date.now() - 1, AbortSignal.abort())).resolves.toEqual({
        status: 'pending', reason: 'observer-cancelled',
      })
      expect(adapter.inspect()).toMatchObject({ observedOperations: 1, observers: 0 })
      expect(() => adapter.observe(other.promise, Date.now() + 1000)).toThrow('actual-observation capacity')
      const failure = expect(actual.promise).rejects.toThrow('late actual failure')
      actual.reject(new Error('late actual failure'))
      await failure
    } finally { actual.resolve(undefined); other.resolve(undefined) }
    await expect.poll(() => adapter.inspect().observedOperations).toBe(0)
  })
})

const privateConfig = process.env['DSH_OWNER_PG_PRIVATE_CONFIG']
let target: OwnerPgConnection

async function assignedConnection(path: string): Promise<OwnerPgConnection> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('host' in parsed) || !('port' in parsed)
    || !('user' in parsed) || !('password' in parsed) || !('databases' in parsed)) throw new Error('Assigned runtime database configuration is incomplete')
  const databases = parsed.databases
  if (typeof databases !== 'object' || databases === null || !('runtime' in databases)
    || typeof databases.runtime !== 'string' || typeof parsed.host !== 'string'
    || typeof parsed.user !== 'string' || typeof parsed.password !== 'string') throw new Error('Assigned runtime database target is invalid')
  const port = typeof parsed.port === 'number' ? parsed.port : Number(parsed.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Assigned runtime database port is invalid')
  return { host: parsed.host, port, user: parsed.user, password: parsed.password, database: databases.runtime, ssl: false }
}

function executor(overrides: Partial<OwnerPgLimits> = {}, connection: Partial<OwnerPgConnection> = {}): PgOwnerExecutor {
  const adapter = new PgOwnerExecutor({ ...target, ...connection }, { ...budgets, ...overrides })
  adapters.add(adapter)
  return adapter
}

async function control(): Promise<Client> {
  const client = new Client({ ...target, connectionTimeoutMillis: 1000, statement_timeout: 5000, query_timeout: 0 })
  controls.add(client)
  client.on('error', (_cause: unknown) => {})
  await client.connect()
  return client
}

async function lockAccount(client: Client): Promise<void> {
  await client.query('BEGIN')
  await client.query('SELECT account_id FROM public.pe_account_owners WHERE account_id=$1 FOR UPDATE', [account])
}

describe.skipIf(privateConfig === undefined)('real pg 8.16.3 adapter against assigned runtime database', { concurrent: false }, () => {
  beforeAll(async () => {
    if (privateConfig === undefined) throw new Error('Assigned runtime database configuration is required')
    target = await assignedConnection(privateConfig)
  })
  beforeEach(async () => {
    const setup = executor()
    await new PostgresOwnerStore(setup, { instanceId: instance }, limits).migrate()
    await setup.query('TRUNCATE public.pe_account_owners', [])
  })

  it('uses real bound parameters, exact epochs and server-side execution budgets', async () => {
    const adapter = executor()
    const store = new PostgresOwnerStore(adapter, { instanceId: instance }, limits)
    await store.migrate()
    const quoted = brandString<typeof account>("pg-adapter'; DROP TABLE pe_account_owners; --")
    const owner = await store.claim({ accountId: quoted, expectedEpoch: null, recipeVersion: 'driver-test' })
    expect(owner).toMatchObject({ accountId: quoted, epoch: '1', phase: 'mounting' })
    expect(await store.locate(quoted)).toEqual(owner)
    const settings = await adapter.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock", [])
    expect(settings.rows).toEqual([{ statement: '5s', lock: '4s' }])
    expect(adapter.inspect()).toMatchObject({ connections: 0, queued: 0 })
  })

  it('keeps slow A SQL and its connection after observer deadline while B remains usable', async () => {
    const adapter = executor()
    const store = new PostgresOwnerStore(adapter, { instanceId: instance }, limits)
    await store.migrate()
    const a = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'driver-test' })
    const b = await store.claim({ accountId: brandString<typeof account>('pg-healthy-b'), expectedEpoch: null, recipeVersion: 'driver-test' })
    const admin = await control()
    await lockAccount(admin)
    const actual = store.heartbeat(a)
    try {
      await expect.poll(() => adapter.inspect().querying, { timeout: 1500, interval: 5 }).toBe(1)
      await expect(adapter.observe(actual, Date.now() + 20)).resolves.toEqual({ status: 'pending', reason: 'deadline' })
      expect(adapter.inspect()).toMatchObject({ connections: 1, querying: 1, observedOperations: 1, observers: 0 })
      await expect(store.heartbeat(a)).rejects.toMatchObject({ code: 'cloud/config-busy' })
      expect(await store.heartbeat(b)).toMatchObject({ accountId: b.accountId, epoch: '1' })
    } finally { await admin.query('ROLLBACK') }
    expect(await actual).toMatchObject({ accountId: account, epoch: '1' })
    expect(await store.heartbeat(a)).toMatchObject({ accountId: account, epoch: '1' })
    expect(adapter.inspect()).toMatchObject({ connections: 0, observedOperations: 0 })
  })

  it('treats real server statement timeout as submitted A uncertainty without closing B writes', async () => {
    const adapter = executor({ statementTimeoutMs: 100, lockTimeoutMs: 1000 })
    const store = new PostgresOwnerStore(adapter, { instanceId: instance }, limits)
    await store.migrate()
    const a = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'driver-test' })
    const b = await store.claim({ accountId: brandString<typeof account>('pg-timeout-b'), expectedEpoch: null, recipeVersion: 'driver-test' })
    const admin = await control()
    await lockAccount(admin)
    try {
      await expect(store.heartbeat(a)).rejects.toMatchObject({ code: 'cloud/account-unavailable', cause: { code: '57014' } })
      await expect(store.heartbeat(a)).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
      expect(await store.heartbeat(b)).toMatchObject({ accountId: b.accountId, epoch: '1' })
    } finally { await admin.query('ROLLBACK') }
    expect(await store.locate(account)).toMatchObject({ epoch: '1', phase: 'mounting' })
    await expect(store.quarantine(a)).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
    expect(adapter.inspect()).toMatchObject({ connections: 0 })
  })

  it('bounds the queue and does not quarantine B/C when their SQL was never submitted', async () => {
    const adapter = executor({ maxConnections: 1, maxQueued: 1, queueTimeoutMs: 40 })
    const store = new PostgresOwnerStore(adapter, { instanceId: instance }, limits)
    await store.migrate()
    const a = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'driver-test' })
    const b = await store.claim({ accountId: brandString<typeof account>('pg-queued-b'), expectedEpoch: null, recipeVersion: 'driver-test' })
    const c = await store.claim({ accountId: brandString<typeof account>('pg-rejected-c'), expectedEpoch: null, recipeVersion: 'driver-test' })
    const admin = await control()
    await lockAccount(admin)
    const actual = store.heartbeat(a)
    const observed = adapter.observe(actual, Date.now() + 20)
    try {
      const queued = expect(store.heartbeat(b)).rejects.toBeInstanceOf(OwnerPgNotSubmittedError)
      expect(adapter.inspect()).toMatchObject({ connections: 1, queued: 1 })
      await expect(store.heartbeat(c)).rejects.toBeInstanceOf(OwnerPgNotSubmittedError)
      await queued
      await observed
      expect(adapter.inspect()).toMatchObject({ connections: 1, queued: 0 })
    } finally { await admin.query('ROLLBACK') }
    await actual
    expect(await store.heartbeat(b)).toMatchObject({ accountId: b.accountId })
    expect(await store.heartbeat(c)).toMatchObject({ accountId: c.accountId })
  })

  it('closes admission without abandoning actual blocked SQL or its closing connection', async () => {
    const adapter = executor({ maxConnections: 1, maxQueued: 1 })
    const store = new PostgresOwnerStore(adapter, { instanceId: instance }, limits)
    await store.migrate()
    const a = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'driver-test' })
    const b = await store.claim({ accountId: brandString<typeof account>('pg-close-b'), expectedEpoch: null, recipeVersion: 'driver-test' })
    const admin = await control()
    await lockAccount(admin)
    const actual = store.heartbeat(a)
    const observed = adapter.observe(actual, Date.now() + 20)
    await expect.poll(() => adapter.inspect().querying, { timeout: 1500, interval: 5 }).toBe(1)
    const queued = expect(store.heartbeat(b)).rejects.toBeInstanceOf(OwnerPgNotSubmittedError)
    const closing = adapter.close()
    try {
      expect(adapter.close() === closing).toBe(true)
      await expect(adapter.observe(closing, Date.now() + 20)).resolves.toMatchObject({ status: 'pending', reason: 'deadline' })
      await queued
      await observed
      expect(adapter.inspect()).toMatchObject({ connections: 1, closing: true, queued: 0 })
    } finally { await admin.query('ROLLBACK') }
    await actual
    await closing
    expect(adapter.inspect()).toMatchObject({ connections: 0, queued: 0 })
    await expect(store.heartbeat(b)).rejects.toBeInstanceOf(OwnerPgNotSubmittedError)
  })

  it('retains A unknown after a real committed response loss and allows healthy B CAS', async () => {
    const proxy = await pgResponseProxy(target, 'forward')
    proxies.add(proxy)
    const adapter = executor({}, { host: '127.0.0.1', port: proxy.port })
    const store = new PostgresOwnerStore(adapter, { instanceId: instance }, limits)
    await store.migrate()
    proxy.armQueryResponseLoss()
    await expect(store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'driver-test' })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(proxy.inspect()).toMatchObject({ dropped: 1 })
    expect(await store.locate(account)).toMatchObject({ accountId: account, epoch: '1', phase: 'mounting' })
    expect(() => store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'driver-test' })).toThrow('unresolved')
    const b = await store.claim({ accountId: brandString<typeof account>('pg-response-loss-b'), expectedEpoch: null, recipeVersion: 'driver-test' })
    expect(await store.heartbeat(b)).toMatchObject({ accountId: b.accountId, epoch: '1' })
    expect(adapter.inspect()).toMatchObject({ connections: 0 })
  })

  it('bounds a real startup handshake wait and never submits SQL after connection timeout', async () => {
    const proxy = await pgResponseProxy(target, 'hold-startup-ready')
    proxies.add(proxy)
    const adapter = executor({ connectionTimeoutMs: 200 }, { host: '127.0.0.1', port: proxy.port })
    await expect(adapter.query('SELECT 1', [])).rejects.toBeInstanceOf(OwnerPgNotSubmittedError)
    expect(proxy.inspect()).toMatchObject({ heldStartupReady: 1 })
    expect(adapter.inspect()).toMatchObject({ connections: 0, queued: 0, querying: 0 })
  })
})
