/** C-12 metadata against real pg; closed/stale instances never authorize owner reclamation. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RuntimeInstanceControl, InstanceControlError } from '../src/instance-control.ts'
import { PgOwnerExecutor, type OwnerPgConnection, type OwnerPgLimits } from '../src/owner-pg-executor.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import type { AccountId, InstanceId } from '../src/types.ts'
import { instanceTestConnection } from './instance-test-connection.ts'
import { pgResponseProxy, type PgResponseProxy } from './pg-response-proxy.ts'
import { limits } from './owner-fixture.ts'

const execute = promisify(execFile)
const privateConfig = process.env['DSH_OWNER_PG_PRIVATE_CONFIG']
const budgets: OwnerPgLimits = {
  maxConnections: 2, maxQueued: 2, queueTimeoutMs: 1000, connectionTimeoutMs: 1000,
  statementTimeoutMs: 5000, lockTimeoutMs: 4000, maxObservedOperations: 6, maxObservers: 4,
}
let target: OwnerPgConnection
const adapters = new Set<PgOwnerExecutor>()
const instances = new Set<RuntimeInstanceControl>()
const controls = new Set<Client>()
const proxies = new Set<PgResponseProxy>()

afterEach(async () => {
  for (const control of controls) await control.end()
  controls.clear()
  for (const instance of instances) {
    try { await instance.close() } catch (cause) {
      // Intentional unknown/conflict cases retain their actual typed failure, never a fabricated close.
      if (!(cause instanceof InstanceControlError)) throw cause
    }
  }
  instances.clear()
  for (const adapter of adapters) await adapter.close()
  adapters.clear()
  for (const proxy of proxies) await proxy.close()
  proxies.clear()
})

function driver(overrides: Partial<OwnerPgLimits> = {}, connection: Partial<OwnerPgConnection> = {}): PgOwnerExecutor {
  const adapter = new PgOwnerExecutor({ ...target, ...connection }, { ...budgets, ...overrides })
  adapters.add(adapter)
  return adapter
}

function component(executor: PgOwnerExecutor, address = 'trusted-deployment-fixture'): RuntimeInstanceControl {
  const instance = new RuntimeInstanceControl(executor, { internalAddress: address, recipeVersion: 'm4-fixture' })
  instances.add(instance)
  return instance
}

async function control(): Promise<Client> {
  const client = new Client({ ...target, connectionTimeoutMillis: 1000, statement_timeout: 5000, query_timeout: 0 })
  client.on('error', (_cause: unknown) => {})
  controls.add(client)
  await client.connect()
  return client
}

describe.skipIf(privateConfig === undefined)('real PostgreSQL process-instance metadata', { concurrent: false }, () => {
  beforeAll(async () => {
    if (privateConfig === undefined) throw new Error('Assigned runtime database configuration is required')
    target = await instanceTestConnection(privateConfig)
  })
  beforeEach(async () => {
    const executor = driver()
    const setup = component(executor)
    await setup.migrate()
    await new PostgresOwnerStore(executor, setup.identity, limits).migrate()
    await executor.query('TRUNCATE public.pe_instances, public.pe_account_owners', [])
  })

  it('migrates concurrently with exactly five fields and coalesces duplicate local registration', async () => {
    const executor = driver()
    const a = component(executor)
    const b = component(executor)
    await Promise.all([a.migrate(), a.migrate(), b.migrate()])
    const columns = await executor.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pe_instances' ORDER BY ordinal_position", [])
    expect(columns.rows).toEqual(['instance_id', 'internal_address', 'recipe_version', 'phase', 'heartbeat_at'].map(column_name => ({ column_name })))
    const registrations = Array.from({ length: 20 }, () => a.register())
    expect(new Set(registrations).size).toBe(1)
    const row = await registrations[0]
    expect(row).toMatchObject({ instanceId: a.identity.instanceId, internalAddress: 'trusted-deployment-fixture', phase: 'registered' })
    expect(a.register() === registrations[0]).toBe(true)
    expect(Object.isFrozen(a.identity)).toBe(true)
    expect(Reflect.set(a.identity, 'instanceId', 'wire-selected')).toBe(false)
    expect(await a.locate(a.identity.instanceId)).toEqual(row)
    const closed = a.close()
    expect(a.close() === closed).toBe(true)
    await expect(closed).resolves.toMatchObject({ status: 'closed', record: { phase: 'closed' } })
    expect(await b.locate(a.identity.instanceId)).toMatchObject({ phase: 'closed', instanceId: a.identity.instanceId })
  })

  it('rejects a durable duplicate id without replacing another registration address or recipe', async () => {
    const executor = driver()
    const instance = component(executor)
    await instance.migrate()
    await executor.query("INSERT INTO public.pe_instances (instance_id,internal_address,recipe_version,phase) VALUES ($1,$2,$3,'registered')", [instance.identity.instanceId, 'existing-address', 'existing-recipe'])
    await expect(instance.register()).rejects.toMatchObject({ operation: 'register', outcome: 'conflict', code: 'cloud/config-conflict' })
    expect(() => instance.heartbeat()).toThrow(InstanceControlError)
    expect(await instance.locate(instance.identity.instanceId)).toMatchObject({ internalAddress: 'existing-address', recipeVersion: 'existing-recipe' })
  })

  it('generates a new id in each real Node startup and preserves the old owner reference after restart', async () => {
    const child = fileURLToPath(new URL('./fixtures/instance-startup-child.ts', import.meta.url))
    const run = async (claim: boolean): Promise<{ instanceId: InstanceId; pid: number }> => {
      const result = await execute(process.execPath, ['--import', 'tsx/esm', child, claim ? 'claim-owner' : 'register-only'], {
        cwd: fileURLToPath(new URL('../../../../', import.meta.url)), env: { ...process.env }, timeout: 10000, maxBuffer: 65536,
      })
      const parsed: unknown = JSON.parse(result.stdout)
      if (typeof parsed !== 'object' || parsed === null || !('instanceId' in parsed) || !('pid' in parsed)
        || typeof parsed.instanceId !== 'string' || typeof parsed.pid !== 'number') throw new Error('Child startup result is invalid')
      return { instanceId: brandString<InstanceId>(parsed.instanceId), pid: parsed.pid }
    }
    const first = await run(true)
    const second = await run(false)
    expect(first.instanceId).not.toBe(second.instanceId)
    expect(first.pid).not.toBe(second.pid)
    const executor = driver()
    const next = component(executor)
    await next.migrate()
    expect(await next.locate(first.instanceId)).toMatchObject({ phase: 'closed' })
    expect(await next.locate(second.instanceId)).toMatchObject({ phase: 'closed' })
    const owners = new PostgresOwnerStore(executor, next.identity, limits)
    await owners.migrate()
    const account = brandString<AccountId>('m4-restart-owner')
    const owner = await owners.locate(account)
    expect(owner).toMatchObject({ ownerInstanceId: first.instanceId, epoch: '1', phase: 'mounting' })
    if (owner === undefined) throw new Error('Old startup owner reference is required')
    await expect(owners.claim({ accountId: account, expectedEpoch: owner.epoch, recipeVersion: 'm4-fixture' })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  })

  it('updates stale instance observation and closure without deleting, fencing or advancing an owner', async () => {
    const executor = driver()
    const old = component(executor, 'old-fixture')
    const next = component(executor, 'new-fixture')
    await Promise.all([old.migrate(), next.migrate()])
    await old.register()
    const oldOwners = new PostgresOwnerStore(executor, old.identity, limits)
    const nextOwners = new PostgresOwnerStore(executor, next.identity, limits)
    await Promise.all([oldOwners.migrate(), nextOwners.migrate()])
    const account = brandString<AccountId>('m4-observation-owner')
    const owner = await oldOwners.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'm4-fixture' })
    await executor.query("UPDATE public.pe_instances SET heartbeat_at='2000-01-01T00:00:00Z' WHERE instance_id=$1", [old.identity.instanceId])
    await next.register()
    await next.heartbeat()
    await old.heartbeat()
    await old.close()
    expect(await nextOwners.locate(account)).toMatchObject({ ownerInstanceId: old.identity.instanceId, epoch: '1', phase: 'mounting' })
    await expect(nextOwners.claim({ accountId: account, expectedEpoch: owner.epoch, recipeVersion: 'm4-fixture' })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    // Even a closed directory row cannot revoke a still-running old process's physical capabilities.
    expect(await oldOwners.heartbeat(owner)).toMatchObject({ ownerInstanceId: old.identity.instanceId, epoch: '1' })
  })

  it('retains delayed heartbeat and close actual promises after an observation deadline', async () => {
    const executor = driver()
    const instance = component(executor)
    await instance.migrate()
    await instance.register()
    const admin = await control()
    await admin.query('BEGIN')
    await admin.query('SELECT instance_id FROM public.pe_instances WHERE instance_id=$1 FOR UPDATE', [instance.identity.instanceId])
    const heartbeat = instance.heartbeat()
    const closed = instance.close()
    try {
      await expect(executor.observe(closed, Date.now() + 20)).resolves.toMatchObject({ status: 'pending', reason: 'deadline' })
      expect(executor.inspect()).toMatchObject({ connections: 1 })
      expect(instance.close() === closed).toBe(true)
      expect(() => instance.heartbeat()).toThrow('admission is closed')
    } finally { await admin.query('ROLLBACK') }
    expect(await heartbeat).toMatchObject({ phase: 'registered' })
    await expect(closed).resolves.toMatchObject({ status: 'closed', record: { phase: 'closed' } })
    expect(executor.inspect()).toMatchObject({ connections: 0 })
  })

  it('retains real committed registration-response uncertainty and leaves another component healthy', async () => {
    const proxy = await pgResponseProxy(target, 'forward')
    proxies.add(proxy)
    const executor = driver({}, { host: '127.0.0.1', port: proxy.port })
    const uncertain = component(executor)
    const healthy = component(executor)
    await Promise.all([uncertain.migrate(), healthy.migrate()])
    proxy.armQueryResponseLoss()
    await expect(uncertain.register()).rejects.toMatchObject({ operation: 'register', outcome: 'unknown' })
    expect(await uncertain.locate(uncertain.identity.instanceId)).toMatchObject({ phase: 'registered' })
    expect(() => uncertain.register()).toThrow(InstanceControlError)
    await expect(uncertain.close()).rejects.toMatchObject({ outcome: 'unknown' })
    expect(uncertain.inspect()).toMatchObject({ state: 'unknown', pendingMutation: true })
    expect(await healthy.register()).toMatchObject({ phase: 'registered' })
    expect(await healthy.heartbeat()).toMatchObject({ phase: 'registered' })
    expect(proxy.inspect().dropped).toBe(1)
  })

  it('keeps timed-out heartbeat uncertainty after a read without disabling another instance', async () => {
    const executor = driver({ statementTimeoutMs: 100, lockTimeoutMs: 1000 })
    const a = component(executor)
    const b = component(executor)
    await Promise.all([a.migrate(), b.migrate()])
    await Promise.all([a.register(), b.register()])
    const admin = await control()
    await admin.query('BEGIN')
    await admin.query('SELECT instance_id FROM public.pe_instances WHERE instance_id=$1 FOR UPDATE', [a.identity.instanceId])
    try {
      await expect(a.heartbeat()).rejects.toMatchObject({ operation: 'heartbeat', outcome: 'unknown', cause: { code: '57014' } })
      expect(await a.locate(a.identity.instanceId)).toMatchObject({ phase: 'registered' })
      expect(() => a.heartbeat()).toThrow(InstanceControlError)
      expect(await b.heartbeat()).toMatchObject({ phase: 'registered' })
    } finally { await admin.query('ROLLBACK') }
  })

  it('retains committed close-response uncertainty even when a read observes closed metadata', async () => {
    const proxy = await pgResponseProxy(target, 'forward')
    proxies.add(proxy)
    const executor = driver({}, { host: '127.0.0.1', port: proxy.port })
    const uncertain = component(executor)
    const healthy = component(executor)
    await Promise.all([uncertain.migrate(), healthy.migrate()])
    await uncertain.register()
    proxy.armQueryResponseLoss()
    const closed = uncertain.close()
    await expect(closed).rejects.toMatchObject({ operation: 'close', outcome: 'unknown' })
    expect(await uncertain.locate(uncertain.identity.instanceId)).toMatchObject({ phase: 'closed' })
    expect(uncertain.close() === closed).toBe(true)
    expect(uncertain.inspect()).toMatchObject({ state: 'unknown', pendingMutation: true, closeRequested: true })
    expect(() => uncertain.heartbeat()).toThrow(InstanceControlError)
    expect(await healthy.register()).toMatchObject({ phase: 'registered' })
    expect(proxy.inspect().dropped).toBe(1)
  })

  it('allows explicit retry of a definitely unsubmitted close without reopening local admission', async () => {
    const executor = driver({ maxConnections: 1, maxQueued: 0 })
    const instance = component(executor)
    await instance.migrate()
    await instance.register()
    const admin = await control()
    await admin.query('BEGIN')
    await admin.query('SELECT instance_id FROM public.pe_instances WHERE instance_id=$1 FOR UPDATE', [instance.identity.instanceId])
    const blocker = executor.query('SELECT instance_id FROM public.pe_instances WHERE instance_id=$1 FOR UPDATE', [instance.identity.instanceId])
    const first = instance.close()
    try {
      await expect(first).rejects.toMatchObject({ operation: 'close', outcome: 'not-submitted' })
      expect(instance.inspect()).toMatchObject({ state: 'registered', pendingMutation: false, closeRequested: true })
      expect(() => instance.heartbeat()).toThrow(InstanceControlError)
    } finally { await admin.query('ROLLBACK') }
    await blocker
    const retry = instance.close()
    expect(retry === first).toBe(false)
    await expect(retry).resolves.toMatchObject({ status: 'closed', record: { phase: 'closed' } })
  })

  it('distinguishes successful absence from invalid persisted heartbeat data', async () => {
    const executor = driver()
    const instance = component(executor)
    await instance.migrate()
    expect(await instance.locate(instance.identity.instanceId)).toBeUndefined()
    await instance.register()
    await executor.query("UPDATE public.pe_instances SET heartbeat_at='infinity' WHERE instance_id=$1", [instance.identity.instanceId])
    await expect(instance.locate(instance.identity.instanceId)).rejects.toMatchObject({ operation: 'read', outcome: 'invalid-record' })
  })

  it('rejects incompatible schema atomically and preserves pre-existing sentinel data', async () => {
    const executor = driver()
    await executor.query('DROP TABLE public.pe_instances', [])
    await executor.query('CREATE TABLE public.pe_instances (sentinel text)', [])
    await executor.query("INSERT INTO public.pe_instances VALUES ('preserve')", [])
    const invalid = component(executor)
    try {
      await expect(invalid.migrate()).rejects.toMatchObject({ operation: 'migrate', outcome: 'unknown' })
      expect((await executor.query('SELECT sentinel FROM public.pe_instances', [])).rows).toEqual([{ sentinel: 'preserve' }])
    } finally {
      await executor.query('DROP TABLE public.pe_instances', [])
      await component(executor).migrate()
    }
  })
})
