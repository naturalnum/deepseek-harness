/** Driver-result and rejection tests; no test in this file is PostgreSQL execution evidence. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import type { OperationId, OwnerDrainEvidence, OwnerEpoch, OwnerPgExecutor } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { claimOwnerSql, finishOwnerDrainSql, locateOwnerSql, quarantineOwnerSql } from '../src/owner-sql.ts'
import { account, cleanEvidence, epoch, instance, limits, row } from './owner-fixture.ts'

describe('owner store driver-result handling (not real PostgreSQL)', () => {
  it('keeps all owner operations closed until migration succeeds', () => {
    const store = new PostgresOwnerStore({ query: async () => ({ rows: [] }) }, { instanceId: instance }, limits)
    expect(() => store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'r' })).toThrow('migration')
  })

  it('coalesces twenty identical pending claims, rejects conflicting inputs, and bounds distinct claims', async () => {
    let settle!: (value: { rows: readonly unknown[] }) => void
    let claimQueries = 0
    const executor: OwnerPgExecutor = { query: (sql) => {
      if (sql !== claimOwnerSql) return Promise.resolve({ rows: [] })
      claimQueries += 1
      return new Promise((resolve) => { settle = resolve })
    } }
    const store = new PostgresOwnerStore(executor, { instanceId: instance }, { ...limits, maxConcurrentMounts: 1 })
    await store.migrate()
    const pending = Array.from({ length: 20 }, () => store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'r' }))
    expect(new Set(pending).size).toBe(1)
    expect(claimQueries).toBe(1)
    expect(() => store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'other' })).toThrow('conflict')
    expect(() => store.claim({ accountId: brandString<typeof account>('other'), expectedEpoch: null, recipeVersion: 'r' })).toThrow('capacity')
    settle({ rows: [row()] })
    await expect(Promise.all(pending)).resolves.toHaveLength(20)
  })

  it('retains uncertainty after a write rejection and never automatically replays it', async () => {
    const queries: string[] = []
    const store = new PostgresOwnerStore({ query: async (sql) => {
      queries.push(sql)
      if (sql === claimOwnerSql) throw new Error('driver disconnected after send')
      return { rows: sql === locateOwnerSql ? [row()] : [] }
    } }, { instanceId: instance }, limits)
    await store.migrate()
    await expect(store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'r' })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(() => store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'r' })).toThrow('unresolved')
    await expect(store.locate(account)).resolves.toMatchObject({ phase: 'mounting' })
    expect(queries.filter(sql => sql === claimOwnerSql)).toHaveLength(1)
  })

  it('reports zero-row CAS refusal without treating it as a committed write or lease takeover', async () => {
    const store = new PostgresOwnerStore({ query: async () => ({ rows: [] }) }, { instanceId: instance }, limits)
    await store.migrate()
    await expect(store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'r' })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(store.locate(account)).resolves.toBeUndefined()
  })

  it('does not interpret a failed lookup as an absent row', async () => {
    const store = new PostgresOwnerStore({ query: async (sql) => {
      if (sql === locateOwnerSql) throw new Error('driver unavailable')
      return { rows: [] }
    } }, { instanceId: instance }, limits)
    await store.migrate()
    await expect(store.locate(account)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  })

  it('refuses corrupt durable JSON without inferring ownership or an absent row', async () => {
    const store = new PostgresOwnerStore({
      query: async sql => ({ rows: sql === locateOwnerSql ? [{ owner: { epoch: 1 } }] : [] }),
    }, { instanceId: instance }, limits)
    await store.migrate()
    await expect(store.locate(account)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'r' })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  })

  it('rejects exhausted epoch text before issuing a mutation', async () => {
    const queries: string[] = []
    const store = new PostgresOwnerStore({
      query: async (sql) => { queries.push(sql); return { rows: [] } },
    }, { instanceId: instance }, limits)
    await store.migrate()
    expect(() => store.claim({ accountId: account, expectedEpoch: brandString<OwnerEpoch>('9223372036854775807'), recipeVersion: 'r' })).toThrow('exhausted')
    expect(queries).toHaveLength(1)
  })

  it('bounds pinned unknown responsibilities without dropping or clearing an earlier account', async () => {
    let writes = 0
    const store = new PostgresOwnerStore({ query: async (sql) => {
      if (sql !== claimOwnerSql) return { rows: [] }
      writes += 1
      throw new Error('synthetic unknown write')
    } }, { instanceId: instance }, { ...limits, maxMountedAccounts: 1 })
    await store.migrate()
    await expect(store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'r' })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(store.claim({ accountId: brandString<typeof account>('other'), expectedEpoch: null, recipeVersion: 'r' })).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(() => store.claim({ accountId: account, expectedEpoch: null, recipeVersion: 'r' })).toThrow('unresolved')
    expect(writes).toBe(1)
  })

  it('rejects evidence from another generation without mutating either owner', async () => {
    const queries: string[] = []
    const store = new PostgresOwnerStore({
      query: async (sql) => { queries.push(sql); return { rows: [] } },
    }, { instanceId: instance }, limits)
    await store.migrate()
    await expect(store.release({ accountId: account, epoch }, { ...cleanEvidence(), epoch: brandString<OwnerEpoch>('2') })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect(queries).toHaveLength(1)
  })

  const incomplete: readonly [string, (value: OwnerDrainEvidence) => OwnerDrainEvidence][] = [
    ['native idle', value => ({ ...value, nativeIdle: false })],
    ['persistence flush', value => ({ ...value, persistenceFlushed: false })],
    ['context disposal', value => ({ ...value, contextDisposed: false })],
    ['disposal errors', value => ({ ...value, disposalErrors: ['synthetic-error'] })],
    ['config saves', value => ({ ...value, configSaves: { ...value.configSaves, status: 'unknown' } })],
    ['pending config saves', value => ({ ...value, configSaves: {
      ...value.configSaves, pendingOperationIds: [brandString<OperationId>('pending-save')],
    } })],
    ['unresolved save failure', value => ({ ...value, configSaves: { ...value.configSaves, failures: [{ code: 'synthetic-save-error' }] } })],
    ['missing participant', value => ({ ...value, participants: value.participants.slice(0, 1) })],
    ['duplicate participant', value => ({ ...value, participants: [value.participants[0]!, value.participants[0]!] })],
    ['pending execution work', value => ({ ...value, participants: [value.participants[0]!, {
      participant: 'execution', accountId: value.accountId, epoch: value.epoch, status: 'unknown',
      pendingOperationIds: [brandString<OperationId>('pending-execution')], reason: 'synthetic-in-flight', evidenceRefs: [],
    }] })],
  ]

  it.each(incomplete)('quarantines instead of releasing with incomplete %s evidence', async (_label, change) => {
    const queries: string[] = []
    const store = new PostgresOwnerStore({ query: async (sql) => {
      queries.push(sql)
      return { rows: sql === quarantineOwnerSql ? [row('quarantined')] : [] }
    } }, { instanceId: instance }, limits)
    await store.migrate()
    await expect(store.release({ accountId: account, epoch }, change(cleanEvidence()))).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(queries).toContain(quarantineOwnerSql)
    expect(queries).not.toContain(finishOwnerDrainSql)
  })
})
