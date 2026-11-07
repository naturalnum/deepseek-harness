/** Actual two-instance PostgreSQL claim/stop ordering; no native graph or physical readiness is supplied here. */
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createProcessInstanceIdentity } from '../src/instance-identity.ts'
import { PostgresOwnerStore, OwnerClaimAdmissionClosed } from '../src/owner-store.ts'
import { claimStaticOwnerSql } from '../src/owner-sql.ts'
import { StaticAccountBindings } from '../src/static-account-bindings.ts'
import type { AccountId, RootMetadataDatabase } from '../src/types.ts'
import type { OwnerPgExecutor } from '../src/owner-types.ts'
import { AccountFactory, type AccountFactoryRequest } from '../src/account-factory.ts'
import { RuntimeCapacity } from '../src/capacity.ts'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { createStaticStorageInventory } from '../../pe-cloud-files/src/static-inventory.ts'
import { parseStorageDeploymentPlan } from '../../pe-cloud-files/src/storage-probe.ts'
import { physicalInventoryPlan, remountInventoryPlan } from '../../pe-cloud-files/tests/fixtures/static-inventory.ts'

const configPath = process.env.PE_ACCOUNT_CLAIM_GATE_POSTGRES_CONFIG
const databaseName = 'dsh_admin_claim_gate_20261107'
const limits = { maxMountedAccounts: 4, maxConcurrentMounts: 4, maxConcurrentDrains: 4 }

describe.skipIf(configPath === undefined)('durable account claim admission', () => {
  it('restores the original B/C bindings after namespace remeasurement and refuses changed physical slots', async () => {
    if (configPath === undefined) throw new Error('Dedicated claim-gate database configuration required')
    const config: pg.PoolConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    if (config.database !== databaseName) throw new Error('Only the dedicated claim-gate database is authorized')
    const firstPool = new pg.Pool({ ...config, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 10000 })
    const nextPool = new pg.Pool({ ...config, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 10000 })
    const metadata = (pool: pg.Pool): RootMetadataDatabase => ({ wasNotSubmitted: () => false,
      query: (text, values) => pool.query(text, [...values]) })
    const inventory = (raw: ReturnType<typeof physicalInventoryPlan>) => {
      const parsed = parseStorageDeploymentPlan(new TextEncoder().encode(JSON.stringify(raw)), 1024)
      if (parsed.version !== 3) throw new Error('Expected v3 inventory')
      return createStaticStorageInventory(parsed)
    }
    const prefix = 'inventory-restart-' + randomUUID(), ids = ['A', 'B', 'C'].map(value => brandString<AccountId>(prefix + value))
    const originalPlan = physicalInventoryPlan(), original = inventory(originalPlan)
    const first = new StaticAccountBindings(metadata(firstPool), original, () => {})
    const registries = [first]
    let firstEnded = false
    try {
      await first.initialize()
      await first.seed(ids[0]!, original.slots[0]!.slotId)
      const b = await first.reserve(ids[1]!, 'standard', 'create-B'), c = await first.reserve(ids[2]!, 'standard', 'create-C')
      await first.transition(b, 'failed', 'retry-B-keeps-original-slot')
      const before = (await firstPool.query('SELECT * FROM public.pe_account_static_bindings WHERE account_id = ANY($1::text[]) ORDER BY account_id', [ids])).rows
      await first.close(); await firstPool.end(); firstEnded = true

      const nextPlan = physicalInventoryPlan()
      remountInventoryPlan(nextPlan)
      nextPlan.slots.reverse()
      const next = inventory(nextPlan)
      expect(createHash('sha256').update(JSON.stringify(nextPlan)).digest('hex'))
        .not.toBe(createHash('sha256').update(JSON.stringify(originalPlan)).digest('hex'))
      expect(next.sha256).toBe(original.sha256)
      const restarted = new StaticAccountBindings(metadata(nextPool), next, () => {})
      registries.push(restarted); await restarted.initialize()
      expect(restarted.lookup(ids[1]!)).toEqual(b.assignment)
      expect(restarted.lookup(ids[2]!)).toEqual(c.assignment)
      expect(restarted.status(ids[1]!)?.phase).toBe('failed')
      expect((await restarted.reserve(ids[1]!, 'standard', 'retry-B')).assignment).toBe(restarted.lookup(ids[1]!))
      expect(restarted.lookup(ids[1]!)?.slotId).not.toBe(restarted.lookup(ids[2]!)?.slotId)

      for (const change of [
        (plan: ReturnType<typeof physicalInventoryPlan>) => { plan.slots[1]!.private.backing.inode = '9999' },
        (plan: ReturnType<typeof physicalInventoryPlan>) => { plan.slots[1]!.private.maximumBytes = '12288' },
        (plan: ReturnType<typeof physicalInventoryPlan>) => { plan.slots[1]!.slotId = 'replacement-slot' },
      ]) {
        const changed = physicalInventoryPlan(); remountInventoryPlan(changed); change(changed)
        const rejected = new StaticAccountBindings(metadata(nextPool), inventory(changed), () => {})
        registries.push(rejected)
        await expect(rejected.initialize()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
      }
      expect((await nextPool.query('SELECT * FROM public.pe_account_static_bindings WHERE account_id = ANY($1::text[]) ORDER BY account_id', [ids])).rows).toEqual(before)
    } finally {
      await Promise.all(registries.map(registry => registry.close()))
      await nextPool.query('DELETE FROM public.pe_account_static_bindings WHERE account_id = ANY($1::text[])', [ids])
      await nextPool.end()
      if (!firstEnded) await firstPool.end()
    }
  }, 20000)

  it('serializes the original owner claim and stop fence in either order across two instances', async () => {
    if (configPath === undefined) throw new Error('Dedicated claim-gate database configuration required')
    const config: pg.PoolConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    if (config.database !== databaseName) throw new Error('Only the dedicated claim-gate database is authorized')
    const prefix = 'claim-gate-' + randomUUID()
    const pool = new pg.Pool({ ...config, max: 4, connectionTimeoutMillis: 2000, statement_timeout: 10000,
      application_name: prefix + '-observe' })
    const claimant = new pg.Pool({ ...config, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 10000,
      application_name: prefix + '-claim' })
    const stopper = new pg.Pool({ ...config, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 10000,
      application_name: prefix + '-stop' })
    const claimEntered = Promise.withResolvers<undefined>(), finishClaim = Promise.withResolvers<undefined>()
    const stopEntered = Promise.withResolvers<undefined>(), finishStop = Promise.withResolvers<undefined>()
    const running: Promise<unknown>[] = []
    let holdClaim = false, holdStop = false
    const execute = async (selected: pg.Pool, sql: string, values: readonly (string | null)[], hold: boolean,
      entered: PromiseWithResolvers<undefined>, finish: PromiseWithResolvers<undefined>) => {
      if (!hold) return selected.query(sql, [...values])
      const client = await selected.connect()
      try {
        await client.query('BEGIN')
        const result = await client.query(sql, [...values])
        entered.resolve(undefined); await finish.promise
        await client.query('COMMIT')
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    const executor: OwnerPgExecutor = {
      query: (sql, values) => execute(claimant, sql, values, holdClaim && sql === claimStaticOwnerSql, claimEntered, finishClaim),
    }
    const observer: OwnerPgExecutor = { query: (sql, values) => pool.query(sql, [...values]) }
    const metadata: RootMetadataDatabase = { ...observer, wasNotSubmitted: () => false }
    const stoppingMetadata: RootMetadataDatabase = { wasNotSubmitted: () => false,
      query: (sql, values) => execute(stopper, sql, values, holdStop && sql.startsWith('UPDATE public.pe_account_static_bindings'),
        stopEntered, finishStop) }
    const firstIdentity = createProcessInstanceIdentity()
    const first = new PostgresOwnerStore(executor, firstIdentity, limits)
    const second = new PostgresOwnerStore(observer, createProcessInstanceIdentity(), limits)
    const inventory = { sha256: 'b'.repeat(64), maxAccounts: 3,
      slots: [1, 2, 3].map(index => ({ slotId: prefix + '-' + index, templateId: 'standard' })) }
    const bindings = new StaticAccountBindings(metadata, inventory, () => {})
    const stopped = new StaticAccountBindings(stoppingMetadata, inventory, () => {})
    const ids = [1, 2, 3].map(index => brandString<AccountId>(prefix + '-' + index))
    const waitForServerLock = async (application: string) => vi.waitFor(async () => {
      const result = await pool.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting", [application])
      expect(result.rows[0]?.waiting).toBe(true)
    }, { timeout: 3000, interval: 10 })
    try {
      expect((await pool.query<{ database: string }>('SELECT current_database() AS database')).rows[0]?.database).toBe(databaseName)
      await first.migrate(); await second.migrate(); await bindings.initialize(); await stopped.initialize()
      first.installStaticAccountAdmission(inventory.sha256); second.installStaticAccountAdmission(inventory.sha256)
      const a = await bindings.reserve(ids[0]!, 'standard', 'create-a')
      holdClaim = true
      const claim = first.claim({ accountId: ids[0]!, expectedEpoch: null, recipeVersion: prefix }); running.push(claim)
      await claimEntered.promise
      const stopping = stopped.transition((await stopped.refresh(ids[0]!))!, 'stop-unknown', 'stop-a'); running.push(stopping)
      await waitForServerLock(prefix + '-stop')
      finishClaim.resolve(undefined)
      const claimed = await claim
      expect(claimed.phase).toBe('mounting')
      expect((await stopping).phase).toBe('stop-unknown')
      expect((await second.locate(ids[0]!))?.ownerInstanceId).toBe(claimed.ownerInstanceId)
      expect((await bindings.refresh(ids[0]!))?.assignment).toBe(a.assignment)

      holdClaim = false
      const b = await bindings.reserve(ids[1]!, 'standard', 'create-b')
      holdStop = true
      const stopFirst = stopped.transition((await stopped.refresh(ids[1]!))!, 'stop-unknown', 'stop-b'); running.push(stopFirst)
      await stopEntered.promise
      const denied = first.claim({ accountId: ids[1]!, expectedEpoch: null, recipeVersion: prefix })
      const refusal = expect(denied).rejects.toBeInstanceOf(OwnerClaimAdmissionClosed); running.push(denied)
      await waitForServerLock(prefix + '-claim')
      finishStop.resolve(undefined)
      await stopFirst; await refusal
      expect(await first.locate(ids[1]!)).toBeUndefined()
      expect(await second.locate(ids[1]!)).toBeUndefined()
      expect((await bindings.refresh(ids[1]!))?.assignment).toBe(b.assignment)
      const deniedAgain = second.claim({ accountId: ids[1]!, expectedEpoch: null, recipeVersion: prefix })
      await expect(deniedAgain).rejects.toBeInstanceOf(OwnerClaimAdmissionClosed)
      const factory = new AccountFactory(new RuntimeCapacity(limits), {
        maxWaiters: 8, maxWaitersPerAccount: 4, maxBorrows: 8, maxBorrowsPerAccount: 4,
      })
      const request: AccountFactoryRequest = {
        accountId: ids[1]!, instanceId: firstIdentity.instanceId, recipeVersion: prefix,
        deployment: { sharedAccountsRoot: '/unopened-claim-gate/accounts', localCacheRoot: '/unopened-claim-gate/cache', maxPathBytes: 4096 },
        environment: createLaunchEnvironmentSnapshot([]),
        recipe: { configPath: '/unopened-claim-gate/cordis.yml', bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
          requiredEntryIds: [], maxObservedEvents: 8, maxPathBytes: 4096,
          profile: { name: prefix, dir: '/unopened-claim-gate', patchPath: '/unopened-claim-gate/cordis.patch.yml',
            installAnchor: '/unopened-claim-gate/package.json', cwd: '/unopened-claim-gate', home: '/unopened-claim-gate',
            startedBundles: [], overlays: [], telemetryDisabledEnv: undefined },
          prepare: async () => { throw new Error('A refused claim must not start native preparation') } },
      }
      try {
        await expect(factory.claimAndMount(first, request)).rejects.toBeInstanceOf(OwnerClaimAdmissionClosed)
        expect(factory.inspect()).toMatchObject({ slots: 0, pending: 0 })
      } finally { await factory.close() }
      const disabled = await bindings.transition((await bindings.refresh(ids[1]!))!, 'disabled', 'stop-b-confirmed')
      await bindings.transition(disabled, 'preparing', 'explicit-enable-b')
      expect((await second.claim({ accountId: ids[1]!, expectedEpoch: null, recipeVersion: prefix })).phase).toBe('mounting')

      // An ordinary store without this opt-in retains its original claim SQL and needs no static assignment.
      const legacy = new PostgresOwnerStore(observer, createProcessInstanceIdentity(), limits)
      await legacy.migrate()
      expect((await legacy.claim({ accountId: ids[2]!, expectedEpoch: null, recipeVersion: prefix })).phase).toBe('mounting')
    } finally {
      finishClaim.resolve(undefined); finishStop.resolve(undefined)
      await Promise.allSettled(running)
      await Promise.all([bindings.close(), stopped.close()])
      await pool.query('DELETE FROM public.pe_account_owners WHERE account_id = ANY($1::text[])', [ids])
      await pool.query('DELETE FROM public.pe_account_static_bindings WHERE account_id = ANY($1::text[])', [ids])
      await Promise.all([pool.end(), claimant.end(), stopper.end()])
    }
  }, 20000)
})
