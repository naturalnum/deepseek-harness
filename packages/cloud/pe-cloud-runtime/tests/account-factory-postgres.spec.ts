/** Actual PostgreSQL claim ownership; missing production ports deliberately prevent native startup and ready. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { AccountFactory, type AccountFactoryRequest } from '../src/account-factory.ts'
import { AccountMountPrerequisiteError } from '../src/account-mount.ts'
import { deriveAccountLayout, defaultProjectLayout } from '../src/account-layout.ts'
import { RuntimeCapacity } from '../src/capacity.ts'
import { createProcessInstanceIdentity } from '../src/instance-identity.ts'
import { PgOwnerExecutor } from '../src/owner-pg-executor.ts'
import { OwnerPgNotSubmittedError } from '../src/owner-pg-errors.ts'
import { claimOwnerSql, readyOwnerSql } from '../src/owner-sql.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import type { AccountId, OwnerPgExecutor } from '../src/types.ts'
import { instanceTestConnection } from './instance-test-connection.ts'

const privateConfig = process.env['DSH_ACCOUNT_FACTORY_PG_PRIVATE_CONFIG']
const identity = createProcessInstanceIdentity()
const capacityLimits = { maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2 }

describe.skipIf(privateConfig === undefined)('actual PostgreSQL factory claims before unavailable production providers', { concurrent: false }, () => {
  let executor: PgOwnerExecutor
  let locker: Client
  const factories: AccountFactory[] = []
  const directories: string[] = []

  beforeAll(async () => {
    if (privateConfig === undefined) throw new Error('Coordinator-assigned PostgreSQL fixture is required')
    const connection = await instanceTestConnection(privateConfig)
    executor = new PgOwnerExecutor(connection, {
      maxConnections: 4, maxQueued: 32, queueTimeoutMs: 5000, connectionTimeoutMs: 5000,
      statementTimeoutMs: 5000, lockTimeoutMs: 3000, maxObservedOperations: 64, maxObservers: 24,
    })
    locker = new Client(connection)
    await locker.connect()
  })
  beforeEach(async () => {
    await new PostgresOwnerStore(executor, identity, capacityLimits).migrate()
    await executor.query('TRUNCATE public.pe_account_owners', [])
  })
  afterEach(async () => {
    // Release the real row lock before joining retained claim work, including on assertion failure.
    await locker.query('ROLLBACK')
    for (const factory of factories.splice(0)) await factory.close()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })
  afterAll(async () => {
    await locker?.end()
    if (executor === undefined) return
    await executor.close()
    expect(executor.inspect()).toMatchObject({ connections: 0, querying: 0, queued: 0, observedOperations: 0, observers: 0 })
  })

  function fixture(label: string) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pe-factory-pg-')))
    directories.push(directory)
    const accountId = brandString<AccountId>(label)
    const deployment = { sharedAccountsRoot: join(directory, 'shared'), localCacheRoot: join(directory, 'cache'), maxPathBytes: 4096 }
    const layout = deriveAccountLayout(accountId, identity.instanceId, deployment)
    const cwd = defaultProjectLayout(layout, 4096).root
    mkdirSync(cwd, { recursive: true })
    initProfile(layout.profileRoot, [])
    const configPath = join(layout.profileRoot, 'cordis.yml')
    writeFileSync(configPath, '[]\n')
    const anchor = join(directory, 'package.json')
    writeFileSync(anchor, '{"name":"factory-pg-control-fixture","private":true}\n')
    const profile: ProfileContext = {
      name: label, dir: layout.profileRoot, patchPath: layout.patchPath, installAnchor: anchor,
      cwd, home: layout.privateRoot, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    }
    let nativeStarts = 0
    const request: AccountFactoryRequest = Object.freeze({
      accountId, instanceId: identity.instanceId, recipeVersion: 'factory-pg-no-production-ports', deployment,
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: layout.privateRoot } }]),
      recipe: {
        profile, configPath, bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
        requiredEntryIds: ['include'], maxObservedEvents: 8, maxPathBytes: 4096,
        prepare: () => { nativeStarts++ },
      },
    })
    return { request, nativeStarts: () => nativeStarts }
  }

  function factory() {
    const capacity = new RuntimeCapacity(capacityLimits)
    const value = new AccountFactory(capacity, { maxWaiters: 24, maxWaitersPerAccount: 20, maxBorrows: 24, maxBorrowsPerAccount: 20 })
    factories.push(value)
    return { value, capacity }
  }

  it.each(['same-request', 'fresh-wrapper'])('keeps one submitted claim through twenty %s observers and cancellation while B progresses', async (style) => {
    const a = fixture(`factory-pg-A-${style}`), b = fixture(`factory-pg-B-${style}`)
    const submissions = new Map<AccountId, number>()
    let readySubmissions = 0
    const counted: OwnerPgExecutor = { query: (sql, values) => {
      if (sql === claimOwnerSql && values[0] === a.request.accountId) {
        submissions.set(a.request.accountId, (submissions.get(a.request.accountId) ?? 0) + 1)
      }
      if (sql === readyOwnerSql) readySubmissions++
      return executor.query(sql, values)
    } }
    const store = new PostgresOwnerStore(counted, identity, capacityLimits)
    await store.migrate()
    const original = await store.claim({ accountId: a.request.accountId, expectedEpoch: null, recipeVersion: a.request.recipeVersion })
    // This metadata fixture is not evidence of actual graph drain or owner release.
    await executor.query("UPDATE public.pe_account_owners SET phase='unowned', owner_instance_id=NULL WHERE account_id=$1", [a.request.accountId])
    submissions.clear()
    await locker.query('BEGIN')
    await locker.query('SELECT account_id FROM public.pe_account_owners WHERE account_id=$1 FOR UPDATE', [a.request.accountId])
    const { value, capacity } = factory()
    const actual = value.claimAndMount(store, a.request)
    const failedActual = expect(actual).rejects.toBeInstanceOf(AccountMountPrerequisiteError)
    const cancelled = new AbortController()
    const observers = Array.from({ length: 20 }, (_, index) => value.acquireAccount(
      store, style === 'same-request' ? a.request : { ...a.request }, Date.now() + 5000, index === 0 ? cancelled.signal : undefined,
    ))
    const settled = Promise.allSettled(observers)
    await vi.waitFor(async () => {
      const result = await executor.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'", [])
      const row = result.rows[0]
      expect(typeof row === 'object' && row !== null && 'n' in row ? row.n : undefined).toBe('1')
    })
    expect(submissions.get(a.request.accountId)).toBe(1)
    await expect(value.acquireAccount(store, { ...a.request }, Date.now() + 5000)).rejects.toMatchObject({ code: 'cloud/capacity' })
    cancelled.abort()
    await expect(observers[0]).rejects.toMatchObject({ reason: 'observer-cancelled' })
    expect(value.inspect()).toMatchObject({ slots: 1, pending: 1, waiters: 19, borrows: 0 })
    await expect(value.claimAndMount(store, b.request)).rejects.toBeInstanceOf(AccountMountPrerequisiteError)
    await expect(store.locate(b.request.accountId)).resolves.toMatchObject({ phase: 'mounting', epoch: '1' })
    expect(value.inspect()).toMatchObject({ slots: 2, pending: 1, waiters: 19 })
    await locker.query('ROLLBACK')
    await failedActual
    const outcomes = await settled
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(20)
    expect(value.claimAndMount(store, { ...a.request })).toBe(actual)
    await expect(store.locate(a.request.accountId)).resolves.toMatchObject({ phase: 'mounting', epoch: (BigInt(original.epoch) + 1n).toString() })
    expect(submissions.get(a.request.accountId)).toBe(1)
    expect(readySubmissions).toBe(0)
    expect(a.nativeStarts() + b.nativeStarts()).toBe(0)
    expect(value.inspect()).toMatchObject({ slots: 2, pending: 0, waiters: 0, borrows: 0 })
    await value.close()
    expect(() => capacity.reserveMount(a.request.accountId)).toThrow('already reserved')
  })

  it('retains a committed claim with a lost result and never retries it after reading mounting metadata', async () => {
    const f = fixture('factory-pg-lost-claim')
    let submissions = 0, readySubmissions = 0
    const lost: OwnerPgExecutor = { query: async (sql, values) => {
      const result = await executor.query(sql, values)
      if (sql === readyOwnerSql) readySubmissions++
      if (sql === claimOwnerSql) { submissions++; throw new Error('Test carrier lost the actual committed claim response') }
      return result
    } }
    const store = new PostgresOwnerStore(lost, identity, capacityLimits)
    await store.migrate()
    const { value, capacity } = factory()
    const actual = value.claimAndMount(store, f.request)
    await expect(actual).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(store.locate(f.request.accountId)).resolves.toMatchObject({ phase: 'mounting', epoch: '1' })
    expect(value.claimAndMount(store, { ...f.request })).toBe(actual)
    await expect(value.observeMount(f.request.accountId, Date.now() + 5000)).rejects.toThrow()
    expect(submissions).toBe(1)
    expect(readySubmissions).toBe(0)
    expect(f.nativeStarts()).toBe(0)
    expect(value.inspect()).toMatchObject({ slots: 1, unknown: 1, pending: 0, waiters: 0, borrows: 0 })
    await value.close()
    expect(() => capacity.reserveMount(f.request.accountId)).toThrow('already reserved')
  })

  it('releases only a never-submitted claim before a new explicit actual attempt', async () => {
    const f = fixture('factory-pg-never-submitted')
    let refused = false, submissions = 0
    const admission: OwnerPgExecutor = { query: (sql, values) => {
      if (sql === claimOwnerSql) {
        if (!refused) { refused = true; return Promise.reject(new OwnerPgNotSubmittedError('cloud/capacity', 'Test adapter refused before actual query submission')) }
        submissions++
      }
      return executor.query(sql, values)
    } }
    const store = new PostgresOwnerStore(admission, identity, capacityLimits)
    await store.migrate()
    const { value } = factory()
    const first = value.claimAndMount(store, f.request)
    await expect(first).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(value.inspect()).toMatchObject({ slots: 0, pending: 0 })
    await expect(store.locate(f.request.accountId)).resolves.toBeUndefined()
    const second = value.claimAndMount(store, { ...f.request })
    expect(second).not.toBe(first)
    await expect(second).rejects.toBeInstanceOf(AccountMountPrerequisiteError)
    await expect(store.locate(f.request.accountId)).resolves.toMatchObject({ phase: 'mounting', epoch: '1' })
    expect(submissions).toBe(1)
    expect(f.nativeStarts()).toBe(0)
  })
})
