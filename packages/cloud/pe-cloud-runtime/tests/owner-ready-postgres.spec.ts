/** Real PostgreSQL CAS through the bounded pg adapter; no graph, provider audit or production readiness. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createProcessInstanceIdentity } from '../src/instance-identity.ts'
import { PgOwnerExecutor } from '../src/owner-pg-executor.ts'
import { OwnerPgNotSubmittedError } from '../src/owner-pg-errors.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import { readyOwnerSql } from '../src/owner-sql.ts'
import type { AccountId, OwnerEpoch, OwnerPgExecutor } from '../src/types.ts'
import { limits } from './owner-fixture.ts'
import { instanceTestConnection } from './instance-test-connection.ts'

const privateConfig = process.env['DSH_OWNER_READY_PG_PRIVATE_CONFIG']
const identity = createProcessInstanceIdentity()
const account = brandString<AccountId>('ready-cas-account-a')
const otherAccount = brandString<AccountId>('ready-cas-account-b')
const recipe = 'ready-cas-approved-recipe'

describe.skipIf(privateConfig === undefined)('real PostgreSQL mounting-to-ready CAS (control metadata only)', { concurrent: false }, () => {
  let executor: PgOwnerExecutor
  let store: PostgresOwnerStore

  beforeAll(async () => {
    if (privateConfig === undefined) throw new Error('Coordinator-assigned PostgreSQL fixture is required')
    executor = new PgOwnerExecutor(await instanceTestConnection(privateConfig), {
      maxConnections: 4, maxQueued: 32, queueTimeoutMs: 5000, connectionTimeoutMs: 5000,
      statementTimeoutMs: 5000, lockTimeoutMs: 3000, maxObservedOperations: 64, maxObservers: 16,
    })
  })
  beforeEach(async () => {
    store = new PostgresOwnerStore(executor, identity, limits)
    await store.migrate()
    await executor.query('TRUNCATE public.pe_account_owners', [])
  })
  afterAll(async () => {
    if (executor === undefined) return
    await executor.close()
    expect(executor.inspect()).toMatchObject({ connections: 0, querying: 0, queued: 0, observedOperations: 0, observers: 0 })
  })

  async function claim(id: AccountId = account) {
    return store.claim({ accountId: id, expectedEpoch: null, recipeVersion: recipe })
  }

  it('commits the exact mounting row without changing its owner, epoch or recipe', async () => {
    const mounting = await claim()
    const expected = { accountId: account, epoch: mounting.epoch }
    const ready = await store.ready(expected, recipe)
    expect(ready).toMatchObject({ accountId: account, epoch: mounting.epoch, ownerInstanceId: identity.instanceId, recipeVersion: recipe, phase: 'ready' })
    await expect(store.locate(account)).resolves.toEqual(ready)
    await expect(store.ready(expected, recipe)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(store.locate(account)).resolves.toEqual(ready)
  })

  it('refuses a foreign instance without consuming the legitimate owner transition', async () => {
    const mounting = await claim()
    const foreign = new PostgresOwnerStore(executor, createProcessInstanceIdentity(), limits)
    await foreign.migrate()
    await expect(foreign.ready({ accountId: account, epoch: mounting.epoch }, recipe)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(store.locate(account)).resolves.toEqual(mounting)
    await expect(store.ready({ accountId: account, epoch: mounting.epoch }, recipe)).resolves.toMatchObject({ phase: 'ready' })
  })

  it('refuses stale epochs and a changed recipe while retaining the original mounting row', async () => {
    const mounting = await claim()
    await expect(store.ready({ accountId: account, epoch: brandString<OwnerEpoch>('2') }, recipe)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(store.ready({ accountId: account, epoch: mounting.epoch }, 'unapproved-recipe')).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(store.locate(account)).resolves.toEqual(mounting)
  })

  it.each(['draining', 'quarantined', 'parked', 'unowned', 'reconfiguring'])('never revives a %s row', async (phase) => {
    const mounting = await claim()
    // Phase fixtures test SQL refusal, not successful graph draining, parking or recovery.
    await executor.query(`UPDATE public.pe_account_owners
      SET phase = $2, owner_instance_id = CASE WHEN $2 = 'unowned' THEN NULL ELSE owner_instance_id END
      WHERE account_id = $1`, [account, phase])
    const before = await store.locate(account)
    await expect(store.ready({ accountId: account, epoch: mounting.epoch }, recipe)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    await expect(store.locate(account)).resolves.toEqual(before)
  })

  it('allows only one current transition among twenty concurrent commit observers', async () => {
    const mounting = await claim()
    const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
      store.ready({ accountId: account, epoch: mounting.epoch }, recipe)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(19)
    await expect(store.locate(account)).resolves.toMatchObject({ phase: 'ready', epoch: mounting.epoch })
  })

  it('retains uncertainty after an actual committed result is lost and does not block another account', async () => {
    let readySubmissions = 0
    const lostReply: OwnerPgExecutor = { query: async (sql, values) => {
      const result = await executor.query(sql, values)
      if (sql === readyOwnerSql && values[0] === account) {
        readySubmissions += 1
        throw new Error('Test carrier lost the committed owner result')
      }
      return result
    } }
    const uncertain = new PostgresOwnerStore(lostReply, identity, limits)
    await uncertain.migrate()
    const mounting = await uncertain.claim({ accountId: account, expectedEpoch: null, recipeVersion: recipe })
    const expected = { accountId: account, epoch: mounting.epoch }
    await expect(uncertain.ready(expected, recipe)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(uncertain.ready(expected, recipe)).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
    await expect(uncertain.locate(account)).resolves.toMatchObject({ phase: 'ready' })
    await expect(uncertain.quarantine(expected)).rejects.toMatchObject({ code: 'cloud/account-quarantined' })
    expect(readySubmissions).toBe(1)
    const other = await uncertain.claim({ accountId: otherAccount, expectedEpoch: null, recipeVersion: recipe })
    await expect(uncertain.ready({ accountId: otherAccount, epoch: other.epoch }, recipe)).resolves.toMatchObject({ phase: 'ready' })
  })

  it('releases only a trusted never-submitted failure before a later explicit commit', async () => {
    let refused = false
    const boundedAdmission: OwnerPgExecutor = { query: (sql, values) => {
      if (sql === readyOwnerSql && !refused) {
        refused = true
        return Promise.reject(new OwnerPgNotSubmittedError('cloud/capacity', 'Test adapter refused before SQL submission'))
      }
      return executor.query(sql, values)
    } }
    const bounded = new PostgresOwnerStore(boundedAdmission, identity, limits)
    await bounded.migrate()
    const mounting = await bounded.claim({ accountId: account, expectedEpoch: null, recipeVersion: recipe })
    const expected = { accountId: account, epoch: mounting.epoch }
    await expect(bounded.ready(expected, recipe)).rejects.toMatchObject({ code: 'cloud/capacity' })
    await expect(bounded.locate(account)).resolves.toEqual(mounting)
    await expect(bounded.ready(expected, recipe)).resolves.toMatchObject({ phase: 'ready' })
  })
})
