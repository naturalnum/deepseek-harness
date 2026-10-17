/** Real PG tests use an isolated, package-owned Docker container and official psql prepared statements. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import type { InstanceId, OwnerEpoch, OwnerPgExecutor } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { account, cleanEvidence, instance, limits } from './owner-fixture.ts'
import { claimOwnerSql, heartbeatOwnerSql } from '../src/owner-sql.ts'

const execute = promisify(execFile)
const container = process.env['DSH_OWNER_PG_CONTAINER']
const privateConfig = process.env['DSH_OWNER_PG_PRIVATE_CONFIG']
const enabled = privateConfig !== undefined || container !== undefined && /^dsh-owner-m1-[a-f0-9-]+$/.test(container)
interface PsqlTarget { container: string; database: string; user: string; password: string }
let target: PsqlTarget | undefined

async function assignedTarget(path: string): Promise<PsqlTarget> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('databases' in parsed) || !('user' in parsed)
    || !('password' in parsed) || !('port' in parsed)) throw new Error('Runtime PostgreSQL test configuration is incomplete')
  const databases = parsed.databases
  if (typeof databases !== 'object' || databases === null || !('runtime' in databases) || typeof databases.runtime !== 'string'
    || typeof parsed.user !== 'string' || typeof parsed.password !== 'string') throw new Error('Runtime PostgreSQL database is not configured')
  const port = String(parsed.port)
  if (!/^[0-9]+$/.test(port)) throw new Error('Runtime PostgreSQL port is invalid')
  const list = await execute('docker', ['ps', '--format', '{{.ID}}'], { encoding: 'utf8', timeout: 5000 })
  const matches: string[] = []
  for (const id of list.stdout.trim().split('\n').filter(Boolean)) {
    const output = await execute('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', id], { encoding: 'utf8', timeout: 5000 })
    const ports: unknown = JSON.parse(output.stdout)
    if (typeof ports !== 'object' || ports === null || !('5432/tcp' in ports) || !Array.isArray(ports['5432/tcp'])) continue
    if (ports['5432/tcp'].some((binding: unknown) => typeof binding === 'object' && binding !== null && 'HostPort' in binding && binding.HostPort === port)) matches.push(id)
  }
  if (matches.length !== 1 || matches[0] === undefined) throw new Error('Runtime PostgreSQL container could not be selected uniquely')
  return { container: matches[0], database: databases.runtime, user: parsed.user, password: parsed.password }
}

class PsqlExecutor implements OwnerPgExecutor {
  readonly mutations: string[] = []

  async raw(sql: string): Promise<string> {
    if (!enabled || target === undefined) throw new Error('Assigned owner-test PostgreSQL container is required')
    const { stdout } = await execute('docker', [
      'exec', '--env', 'PGPASSWORD', '--env', 'PGOPTIONS', target.container, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
      '-U', target.user, '-d', target.database, '-c', sql,
    ], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PGPASSWORD: target.password, PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=5000' },
    })
    return stdout.trim()
  }

  async query(sql: string, values: readonly (string | null)[]): Promise<{ rows: readonly unknown[] }> {
    if (sql.includes('UPDATE public.pe_account_owners') || sql.includes('INSERT INTO public.pe_account_owners')) this.mutations.push(sql)
    // Only the psql test carrier renders EXECUTE literals; production adapters pass values to their driver's bind API.
    const bound = values.map(value => value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`).join(', ')
    const command = values.length === 0 ? sql : `PREPARE owner_test AS ${sql}; EXECUTE owner_test(${bound});`
    const output = await this.raw(command)
    return { rows: output.length === 0 ? [] : output.split('\n').map((line) => {
      const owner: unknown = JSON.parse(line)
      return { owner }
    }) }
  }
}

describe.skipIf(!enabled)('real PostgreSQL owner CAS (teardown evidence remains a fixture)', { concurrent: false }, () => {
  const executor = new PsqlExecutor()
  const store = new PostgresOwnerStore(executor, { instanceId: instance }, limits)
  const other = new PostgresOwnerStore(new PsqlExecutor(), { instanceId: brandString<InstanceId>('other-owner-test-instance') }, limits)

  beforeAll(async () => {
    target = privateConfig === undefined
      ? { container: container ?? '', database: 'postgres', user: 'postgres', password: '' }
      : await assignedTarget(privateConfig)
    process.stdout.write(JSON.stringify({ runtimePgServerVersion: await executor.raw('SHOW server_version'), carrier: 'official-psql' }) + '\n')
    await Promise.all([store.migrate(), other.migrate()])
  })
  beforeEach(async () => {
    await executor.raw('TRUNCATE public.pe_account_owners')
  })

  it('migrates concurrently and idempotently with the seven expected columns', async () => {
    const extra = new PostgresOwnerStore(new PsqlExecutor(), { instanceId: instance }, limits)
    await extra.migrate()
    expect(await executor.raw("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='pe_account_owners'"))
      .toBe('7')
  })

  it('coalesces twenty same-instance initial callers into one database claim', async () => {
    const before = executor.mutations.length
    const claims = Array.from({ length: 20 }, () => store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' }))
    expect(new Set(claims).size).toBe(1)
    const values = await Promise.all(claims)
    expect(new Set(values.map(value => value.epoch))).toEqual(new Set(['1']))
    expect(executor.mutations.length - before).toBe(1)
    expect(values[0]).toMatchObject({ phase: 'mounting', ownerInstanceId: instance })
  })

  it('lets exactly one of two independent instances win the initial insert', async () => {
    const outcomes = await Promise.allSettled([
      store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' }),
      other.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' }),
    ])
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1)
    expect(await store.locate(account)).toMatchObject({ epoch: '1', phase: 'mounting' })
  })

  it('retains an unowned epoch on confirmed release and increments on same-instance reacquisition', async () => {
    const first = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })
    // Ready is a seeded database fixture; no product seal/mount or real teardown is claimed here.
    await executor.raw("UPDATE public.pe_account_owners SET phase='ready'")
    await store.beginDrain(first)
    expect(await store.release(first, cleanEvidence(account, first.epoch))).toMatchObject({ phase: 'unowned', epoch: '1', ownerInstanceId: null })
    const second = await store.claim({ accountId: account, expectedEpoch: first.epoch, recipeVersion: 'recipe-next' })
    expect(second).toMatchObject({ phase: 'mounting', epoch: '2', ownerInstanceId: instance, recipeVersion: 'recipe-next' })
    await expect(store.heartbeat(first)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  })

  it('allows only one concurrent expected-epoch reacquisition after release', async () => {
    const first = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })
    await executor.raw("UPDATE public.pe_account_owners SET phase='ready'")
    await store.beginDrain(first)
    await store.release(first, cleanEvidence(account, first.epoch))
    const outcomes = await Promise.allSettled([
      store.claim({ accountId: account, expectedEpoch: first.epoch, recipeVersion: 'recipe-test' }),
      other.claim({ accountId: account, expectedEpoch: first.epoch, recipeVersion: 'recipe-test' }),
    ])
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(await store.locate(account)).toMatchObject({ epoch: '2', phase: 'mounting' })
  })

  it('increments parked reassembly and never lets another instance steal parked ownership', async () => {
    const first = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })
    await executor.raw("UPDATE public.pe_account_owners SET phase='ready'")
    await store.beginDrain(first)
    expect(await store.park(first, cleanEvidence(account, first.epoch))).toMatchObject({ phase: 'parked', epoch: '1', ownerInstanceId: instance })
    await expect(other.claim({ accountId: account, expectedEpoch: first.epoch, recipeVersion: 'recipe-test' })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect(await store.claim({ accountId: account, expectedEpoch: first.epoch, recipeVersion: 'recipe-test' })).toMatchObject({ phase: 'mounting', epoch: '2' })
  })

  it('never reclaims an active owner on stale heartbeat and heartbeat does not change ownership', async () => {
    const first = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })
    await executor.raw("UPDATE public.pe_account_owners SET heartbeat_at='2000-01-01T00:00:00Z'")
    await expect(other.claim({ accountId: account, expectedEpoch: first.epoch, recipeVersion: 'recipe-test' })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    const refreshed = await store.heartbeat(first)
    expect(refreshed).toMatchObject({ epoch: first.epoch, ownerInstanceId: instance, phase: 'mounting' })
    expect(refreshed.heartbeatAt).not.toContain('2000-01-01')
  })

  it('persists quarantine for incomplete drain and has no normal release or reclaim exit', async () => {
    const first = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })
    await executor.raw("UPDATE public.pe_account_owners SET phase='ready'")
    await store.beginDrain(first)
    await expect(store.release(first, { ...cleanEvidence(account, first.epoch), nativeIdle: false })).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(await store.locate(account)).toMatchObject({ phase: 'quarantined', ownerInstanceId: instance, epoch: first.epoch })
    await expect(store.release(first, cleanEvidence(account, first.epoch))).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(other.claim({ accountId: account, expectedEpoch: first.epoch, recipeVersion: 'recipe-test' })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  })

  it('keeps bigint epochs above Number precision exact', async () => {
    await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })
    await executor.raw("UPDATE public.pe_account_owners SET phase='unowned', owner_instance_id=NULL, epoch=9007199254740993")
    const next = await store.claim({ accountId: account, expectedEpoch: brandString<OwnerEpoch>('9007199254740993'), recipeVersion: 'recipe-test' })
    expect(next.epoch).toBe('9007199254740994')
  })

  it('binds SQL-looking account identifiers as data', async () => {
    const quoted = brandString<typeof account>("a'; DROP TABLE public.pe_account_owners; --")
    expect(await store.claim({ accountId: quoted, expectedEpoch: null, recipeVersion: 'recipe-test' })).toMatchObject({ accountId: quoted, epoch: '1' })
    expect(await store.locate(quoted)).toMatchObject({ accountId: quoted })
    expect(await executor.raw('SELECT count(*) FROM public.pe_account_owners')).toBe('1')
  })

  it('enforces epoch/phase/owner checks in PostgreSQL', async () => {
    await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })
    await expect(executor.raw("UPDATE public.pe_account_owners SET phase='unowned'")).rejects.toThrow()
    await expect(executor.raw('UPDATE public.pe_account_owners SET epoch=0')).rejects.toThrow()
    await expect(executor.raw("UPDATE public.pe_account_owners SET phase='unsupported'")).rejects.toThrow()
    expect(await store.locate(account)).toMatchObject({ epoch: '1', phase: 'mounting' })
  })

  it('contains A unknown commit by account while healthy B keeps normal CAS and heartbeat', async () => {
    const lost = new PostgresOwnerStore({ query: async (sql, values) => {
      const result = await executor.query(sql, values)
      if (sql === claimOwnerSql && values[0] === account) throw new Error('synthetic response loss after real PostgreSQL commit')
      return result
    } }, { instanceId: instance }, limits)
    await lost.migrate()
    const healthyId = brandString<typeof account>('healthy-owner-b')
    const healthy = await lost.claim({ accountId: healthyId, expectedEpoch: null, recipeVersion: 'recipe-test' })
    await expect(lost.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(() => lost.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })).toThrow('unresolved')
    const unresolved = await lost.locate(account)
    expect(unresolved).toMatchObject({ epoch: '1', phase: 'mounting' })
    await expect(lost.release({ accountId: account, epoch: healthy.epoch }, cleanEvidence())).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
    await expect(lost.claim({ accountId: healthyId, expectedEpoch: healthy.epoch, recipeVersion: 'recipe-test' })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect(await lost.heartbeat(healthy)).toMatchObject({ accountId: healthyId, epoch: '1', phase: 'mounting' })
    await expect(lost.heartbeat({ ...healthy, epoch: brandString<OwnerEpoch>('2') })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect(await lost.heartbeat(healthy)).toMatchObject({ accountId: healthyId, epoch: '1' })
    expect(await lost.quarantine(healthy)).toMatchObject({ accountId: healthyId, phase: 'quarantined', epoch: '1' })
    await expect(other.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  })

  it('keeps known-epoch A heartbeat uncertainty isolated while B drains, releases, and reclaims', async () => {
    const scoped = new PostgresOwnerStore({ query: async (sql, values) => {
      const result = await executor.query(sql, values)
      if (sql === heartbeatOwnerSql && values[0] === account) throw new Error('synthetic heartbeat response loss after real commit')
      return result
    } }, { instanceId: instance }, limits)
    await scoped.migrate()
    const a = await scoped.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })
    const healthyId = brandString<typeof account>('healthy-owner-b')
    const b = await scoped.claim({ accountId: healthyId, expectedEpoch: null, recipeVersion: 'recipe-test' })
    await expect(scoped.heartbeat(a)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(scoped.quarantine(a)).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
    expect(await scoped.heartbeat(b)).toMatchObject({ accountId: healthyId, epoch: '1' })
    await scoped.beginDrain(b)
    await scoped.release(b, cleanEvidence(healthyId, b.epoch))
    expect(await scoped.claim({ accountId: healthyId, expectedEpoch: b.epoch, recipeVersion: 'recipe-test' })).toMatchObject({ accountId: healthyId, epoch: '2' })
    expect(() => scoped.claim({ accountId: account, expectedEpoch: a.epoch, recipeVersion: 'recipe-test' })).toThrow('unresolved')
  })

  it('drains a known failed mounting graph without publishing ready and reacquires a new epoch', async () => {
    const first = await store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'recipe-test' })
    expect(first.phase).toBe('mounting')
    expect(await store.beginDrain(first)).toMatchObject({ phase: 'draining', epoch: '1' })
    expect(await store.release(first, cleanEvidence(account, first.epoch))).toMatchObject({ phase: 'unowned', epoch: '1' })
    expect(await store.claim({ accountId: account, expectedEpoch: first.epoch, recipeVersion: 'recipe-test' })).toMatchObject({ phase: 'mounting', epoch: '2' })
  })

  it('rejects a different existing constraint even when its name is unchanged', async () => {
    await executor.raw("ALTER TABLE public.pe_account_owners DROP CONSTRAINT pe_owner_phase_valid; ALTER TABLE public.pe_account_owners ADD CONSTRAINT pe_owner_phase_valid CHECK (phase <> '')")
    const checking = new PostgresOwnerStore(new PsqlExecutor(), { instanceId: instance }, limits)
    try {
      await expect(checking.migrate()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    } finally {
      await executor.raw('DROP TABLE public.pe_account_owners')
      const restore = new PostgresOwnerStore(new PsqlExecutor(), { instanceId: instance }, limits)
      await restore.migrate()
    }
  })

  it('rejects an incompatible existing table without resetting its rows', async () => {
    await executor.raw("DROP TABLE public.pe_account_owners; CREATE TABLE public.pe_account_owners (sentinel text); INSERT INTO public.pe_account_owners VALUES ('preserve')")
    const checking = new PostgresOwnerStore(new PsqlExecutor(), { instanceId: instance }, limits)
    try {
      await expect(checking.migrate()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
      expect(await executor.raw('SELECT sentinel FROM public.pe_account_owners')).toBe('preserve')
    } finally {
      await executor.raw('DROP TABLE public.pe_account_owners')
      const restore = new PostgresOwnerStore(new PsqlExecutor(), { instanceId: instance }, limits)
      await restore.migrate()
    }
  })
})
