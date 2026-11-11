/** Real PostgreSQL and the original Root Loader exercise opt-in takeover and lock ownership. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Root from '../src/root.ts'
import { PgOwnerExecutor } from '../src/owner-pg-executor.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import { instanceMigrationSql } from '../src/migrations/instances.ts'
import { accountOwnerMigrationSql } from '../src/migrations/account-owners.ts'
import { heartbeatOwnerSql } from '../src/owner-sql.ts'
import type { AccountId, InstanceId, OwnerEpoch } from '../src/types.ts'
import type { RuntimeRootConfig } from '../src/root-config.ts'
import { instanceTestConnection } from './instance-test-connection.ts'
import { RootCredentials, rootConfig } from './root-control-fixture.ts'

const privateConfig = process.env['DSH_RUNTIME_ROOT_PG_PRIVATE_CONFIG']
const lockSql = "SELECT pg_try_advisory_lock(hashtextextended('pe-cloud/single-instance', 0)) AS locked"

describe.skipIf(privateConfig === undefined)('single-instance Root takeover', { concurrent: false }, () => {
  let connection: Awaited<ReturnType<typeof instanceTestConnection>>
  let database: Client
  const contexts: Context[] = []
  const directories: string[] = []
  const clients: Client[] = []
  const executors: PgOwnerExecutor[] = []
  const oldInstance = brandString<InstanceId>('single-instance-old-process')
  const phases = ['ready', 'mounting', 'quarantined'] as const
  const account = (phase: string) => brandString<AccountId>('single-instance-' + phase)
  const epoch = brandString<OwnerEpoch>('7')

  beforeAll(async () => {
    if (privateConfig === undefined) throw new Error('Assigned runtime PostgreSQL configuration is required')
    connection = await instanceTestConnection(privateConfig)
    database = new Client(connection)
    await database.connect()
    await database.query(instanceMigrationSql)
    await database.query(accountOwnerMigrationSql)
  })
  beforeEach(async () => {
    await database.query('TRUNCATE public.pe_account_owners, public.pe_instances')
    await database.query(`INSERT INTO public.pe_instances(instance_id, internal_address, recipe_version, phase)
      VALUES ($1, 'http://127.0.0.1:1/old', 'old-recipe', 'registered')`, [oldInstance])
    for (const phase of phases) {
      await database.query(`INSERT INTO public.pe_account_owners(account_id, owner_instance_id, epoch, phase, recipe_version)
        VALUES ($1, $2, $3, $4, 'old-recipe')`, [account(phase), oldInstance, epoch, phase])
    }
  })
  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
    for (const executor of executors.splice(0)) await executor.close()
    for (const client of clients.splice(0)) {
      await client.query('SELECT pg_advisory_unlock_all()')
      await client.end()
    }
    await database.query('DROP TRIGGER IF EXISTS pe_test_reject_instance_close ON public.pe_instances')
    await database.query('DROP FUNCTION IF EXISTS public.pe_test_reject_instance_close()')
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await database?.query('TRUNCATE public.pe_account_owners, public.pe_instances')
    await database?.end()
  })

  async function root(patch: Partial<RuntimeRootConfig> = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pe-single-instance-')))
    directories.push(dir)
    const config = { ...rootConfig(dir), heartbeatIntervalMs: 60_000, ...patch,
      recipeVersion: 'single-instance-' + randomUUID() }
    const { host, port, user, database: name } = connection
    config.database = { ...config.database, host, port, user, database: name }
    const configPath = join(dir, 'root.cordis.yml')
    writeFileSync(configPath, JSON.stringify([
      { id: 'credentials', name: 'cordis:takeover-credentials' },
      { id: 'runtime', name: 'cordis:takeover-root', config },
    ]))
    const observations: unknown[] = [], errors: unknown[] = []
    const ctx = await boot('single-instance-test', configPath, [], (setup) => {
      setup.logger.exporter({ levels: { default: 3 }, export(message) {
        if (message.type === 'error') errors.push(...message.args)
        if (message.type === 'info' && message.args[0] === 'Cloud runtime observation: %o') observations.push(message.args[1])
      } })
      Object.assign(setup.loader.builtins, {
        'takeover-root': Root,
        'takeover-credentials': { apply(owner: Context) {
          new RootCredentials(owner, async () => {
            const password = connection.password
            return { value: typeof password === 'string' ? password : await password(), source: 'assigned-test' }
          })
        } },
      })
    })
    contexts.push(ctx)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'runtime')
    if (entry?.fiber === undefined) throw new Error('Root Loader entry is absent')
    await entry.fiber.await()
    const runtime = ctx.get('peAccountRuntime')
    if (runtime === undefined) throw errors.find(error => error instanceof Error) ?? new Error('Root did not activate')
    return { runtime, config, observations }
  }

  function store(instanceId: InstanceId, config: RuntimeRootConfig) {
    const executor = new PgOwnerExecutor(connection, config.pg)
    executors.push(executor)
    return new PostgresOwnerStore(executor, { instanceId }, config)
  }
  async function snapshot() {
    return {
      owners: (await database.query('SELECT * FROM public.pe_account_owners ORDER BY account_id')).rows,
      instances: (await database.query('SELECT * FROM public.pe_instances WHERE instance_id = $1', [oldInstance])).rows,
    }
  }
  async function blocker() {
    const client = new Client(connection)
    clients.push(client)
    await client.connect()
    return client
  }

  it('reclaims ready, mounting and quarantined accounts with incremented epochs and fences old writes', async () => {
    const { runtime, config, observations } = await root({ singleInstance: true })
    expect(runtime.singleInstanceActive).toBe(true)
    expect(observations).toContainEqual({ event: 'single-instance-takeover', ownerRows: 3, instanceRows: 1 })
    const newInstance = runtime.activeInstanceId
    if (newInstance === undefined) throw new Error('Root must register a fresh instance')
    const owners = store(newInstance, config)
    await owners.migrate()
    for (const phase of phases) {
      expect(await runtime.locateAccount(account(phase))).toMatchObject({ phase: 'unowned', epoch, ownerInstanceId: null })
      const claimed = await owners.claim({ accountId: account(phase), expectedEpoch: epoch, recipeVersion: config.recipeVersion })
      expect(claimed).toMatchObject({ phase: 'mounting', epoch: '8', ownerInstanceId: newInstance })
      expect((await database.query(heartbeatOwnerSql, [account(phase), oldInstance, epoch])).rowCount).toBe(0)
    }
    expect((await database.query('SELECT phase FROM public.pe_instances WHERE instance_id = $1', [oldInstance])).rows)
      .toEqual([{ phase: 'closed' }])
    await runtime.close()
    expect(runtime.singleInstanceActive).toBe(false)
    expect((await (await blocker()).query(lockSql)).rows).toEqual([{ locked: true }])
  })

  it.each([undefined, false])('preserves old owners and registrations when singleInstance is %s', async (singleInstance) => {
    const original = await snapshot()
    const { runtime, config } = await root(singleInstance === undefined ? {} : { singleInstance })
    expect(runtime.singleInstanceActive).not.toBe(true)
    expect(await snapshot()).toEqual(original)
    const instanceId = runtime.activeInstanceId
    if (instanceId === undefined) throw new Error('Ordinary multi-instance Root must activate')
    const owners = store(instanceId, config)
    await owners.migrate()
    await expect(owners.claim({ accountId: account('ready'), expectedEpoch: epoch, recipeVersion: config.recipeVersion })).rejects.toThrow()
    expect(await snapshot()).toEqual(original)
    expect((await (await blocker()).query(lockSql)).rows).toEqual([{ locked: true }])
  })

  it('refuses another live single-instance process without changing old records', async () => {
    const client = await blocker()
    expect((await client.query(lockSql)).rows).toEqual([{ locked: true }])
    const original = await snapshot()
    const error = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(root({ singleInstance: true }).then(() => 'started')).rejects.toThrow('Another process holds the single-instance lock')
    expect(await snapshot()).toEqual(original)
    expect(error).toHaveBeenCalledWith('Cloud runtime control observation: %j',
      expect.objectContaining({ event: 'runtime-control-failed', code: 'cloud/config-conflict' }))
  })

  it('rolls back owner resets when closing stale instance registrations fails', async () => {
    const original = await snapshot()
    await database.query(`CREATE FUNCTION public.pe_test_reject_instance_close() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test instance-close failure'; END $$;
      CREATE TRIGGER pe_test_reject_instance_close BEFORE UPDATE ON public.pe_instances
      FOR EACH ROW EXECUTE FUNCTION public.pe_test_reject_instance_close()`)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(root({ singleInstance: true }).then(() => 'started')).rejects.toThrow()
    expect(await snapshot()).toEqual(original)
    expect((await (await blocker()).query(lockSql)).rows).toEqual([{ locked: true }])
  })

  async function lockPid(): Promise<number | undefined> {
    const result = await database.query<{ pid: number }>(`SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
    expect(result.rows.length).toBeLessThanOrEqual(1)
    return result.rows[0]?.pid
  }

  it('reconnects a lost lock session without resetting current account ownership', async () => {
    const { runtime, config, observations } = await root({ singleInstance: true })
    const instanceId = runtime.activeInstanceId
    if (instanceId === undefined) throw new Error('Root must be active')
    const owners = store(instanceId, config)
    await owners.migrate()
    await owners.claim({ accountId: account('ready'), expectedEpoch: epoch, recipeVersion: config.recipeVersion })
    const original = await snapshot(), pid = await lockPid()
    if (pid === undefined) throw new Error('Root must hold its dedicated lock session')
    await database.query('SELECT pg_terminate_backend($1)', [pid])
    await expect.poll(async () => {
      const current = await lockPid()
      return current !== undefined && current !== pid && runtime.singleInstanceActive
    }).toBe(true)
    expect(await snapshot()).toEqual(original)
    expect(runtime.inspectControl()).toMatchObject({ phase: 'active', hasFailure: false })
    expect(observations).toContainEqual({ event: 'single-instance-lock-lost' })
    expect(observations).toContainEqual({ event: 'single-instance-lock-reacquired' })
  })

  it('closes Root admission when another process wins lock reacquisition', async () => {
    const { runtime } = await root({ singleInstance: true })
    const pid = await lockPid()
    if (pid === undefined) throw new Error('Root must hold its dedicated lock session')
    const competitor = await blocker()
    const gate = Promise.withResolvers<undefined>()
    const connect = Client.prototype.connect
    const reconnect = vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async function (this: Client) {
      await gate.promise
      return new Promise<void>((resolve, reject) => { connect.call(this, (error) => { if (error) reject(error); else resolve() }) })
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await database.query('SELECT pg_terminate_backend($1)', [pid])
      await expect.poll(() => reconnect.mock.calls.length).toBe(1)
      expect(runtime.singleInstanceActive).toBe(false)
      expect((await competitor.query(lockSql)).rows).toEqual([{ locked: true }])
      gate.resolve(undefined)
      await expect.poll(() => runtime.inspectControl().phase).toBe('failed')
      expect(() => { runtime.locateAccount(account('ready')) }).toThrow('not available')
      expect(runtime.singleInstanceActive).toBe(false)
      expect(reconnect).toHaveBeenCalledTimes(1)
    } finally { gate.resolve(undefined); reconnect.mockRestore() }
  })

  it('reopens admission on the third connection attempt without resetting current owners', async () => {
    const { runtime, config, observations } = await root({ singleInstance: true })
    const instanceId = runtime.activeInstanceId
    if (instanceId === undefined) throw new Error('Root must be active')
    const owners = store(instanceId, config)
    await owners.migrate()
    await owners.claim({ accountId: account('ready'), expectedEpoch: epoch, recipeVersion: config.recipeVersion })
    const original = await snapshot(), pid = await lockPid()
    if (pid === undefined) throw new Error('Root must hold its lock')
    const reconnect = vi.spyOn(Client.prototype, 'connect')
      .mockRejectedValueOnce(new Error('PRIVATE failed connection'))
      .mockRejectedValueOnce(new Error('PRIVATE connection timeout'))
    try {
      await database.query('SELECT pg_terminate_backend($1)', [pid])
      await expect.poll(() => reconnect.mock.calls.length).toBe(1)
      expect(runtime.singleInstanceActive).toBe(false)
      expect(() => { runtime.locateAccount(account('ready')) }).toThrow('not available')
      await expect.poll(() => runtime.singleInstanceActive, { timeout: 10_000 }).toBe(true)
      expect(reconnect).toHaveBeenCalledTimes(3)
      expect(runtime.inspectControl()).toMatchObject({ phase: 'active', hasFailure: false })
      expect(await snapshot()).toEqual(original)
      expect(observations).toContainEqual({ event: 'single-instance-lock-lost' })
      expect(observations).toContainEqual({ event: 'single-instance-lock-reconnect-failed', attempt: 1 })
      expect(observations).toContainEqual({ event: 'single-instance-lock-reconnect-failed', attempt: 2 })
      expect(observations).toContainEqual({ event: 'single-instance-lock-reacquired' })
      expect(JSON.stringify(observations)).not.toContain('PRIVATE')
    } finally { reconnect.mockRestore() }
  }, 15_000)

  it('stops reconnecting and closes admission after five failed connections', async () => {
    const { runtime, observations } = await root({ singleInstance: true })
    const pid = await lockPid()
    if (pid === undefined) throw new Error('Root must hold its lock')
    const reconnect = vi.spyOn(Client.prototype, 'connect').mockRejectedValue(new Error('PRIVATE failed connection'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await database.query('SELECT pg_terminate_backend($1)', [pid])
      await expect.poll(() => runtime.inspectControl().phase, { timeout: 12_000 }).toBe('failed')
      expect(reconnect).toHaveBeenCalledTimes(5)
      expect(runtime.singleInstanceActive).toBe(false)
      expect(() => { runtime.locateAccount(account('ready')) }).toThrow('not available')
      expect(observations.filter(row => typeof row === 'object' && row !== null
        && Reflect.get(row, 'event') === 'single-instance-lock-reconnect-failed'))
        .toEqual([1, 2, 3, 4, 5].map(attempt => ({ event: 'single-instance-lock-reconnect-failed', attempt })))
      expect(observations).not.toContainEqual({ event: 'single-instance-lock-reacquired' })
      expect(JSON.stringify(observations)).not.toContain('PRIVATE')
    } finally { reconnect.mockRestore() }
  }, 15_000)

  it('keeps maintenance recovery unchanged even with the single-instance declaration', async () => {
    const original = await snapshot()
    const { runtime } = await root(Object.assign({ recovery: {
      verifierId: 'local-original-process-and-provider-v1' as const,
      limits: { maxAllocations: 1, maxEvidenceRefs: 1, maxReferenceBytes: 128, maxProofBytes: 1024,
        maxProofAgeMs: 1000, maxAuditRows: 10 },
    } }, { singleInstance: true }))
    expect(runtime.recovery).toBeDefined()
    expect(runtime.singleInstanceActive).not.toBe(true)
    expect(await snapshot()).toEqual(original)
    expect((await (await blocker()).query(lockSql)).rows).toEqual([{ locked: true }])
  })
})
