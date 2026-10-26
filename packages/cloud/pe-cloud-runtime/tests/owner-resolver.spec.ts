/** Original store/registry driver-result tests; no PostgreSQL or Node2 execution evidence. */
import { expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RootOwnerResolver } from '../src/owner-resolver.ts'
import { AccountRuntimeError } from '../src/errors.ts'
import { PostgresOwnerStore } from '../src/owner-store.ts'
import { RuntimeInstanceControl } from '../src/instance-control.ts'
import { locateOwnerSql } from '../src/owner-sql.ts'
import { locateInstanceSql } from '../src/instance-sql.ts'
import { accountOwnerMigrationSql } from '../src/migrations/account-owners.ts'
import { instanceMigrationSql } from '../src/migrations/instances.ts'
import type { OwnerEpoch, OwnerPgExecutor } from '../src/types.ts'
import { account, instance, limits, row } from './owner-fixture.ts'

async function fixture(input: {
  owner?: () => Promise<readonly unknown[]>
  registry?: () => Promise<readonly unknown[]>
  maximum?: number
  release?: () => void
} = {}) {
  const queries: { sql: string; values: readonly (string | null)[] }[] = []
  const executor: OwnerPgExecutor = { async query(sql, values) {
    if (sql === accountOwnerMigrationSql || sql === instanceMigrationSql) return { rows: [] }
    queries.push({ sql, values })
    if (sql === locateOwnerSql) return { rows: await input.owner?.() ?? [row('ready')] }
    if (sql === locateInstanceSql) return { rows: await input.registry?.() ?? [{ instance: {
      instanceId: instance, internalAddress: 'https://fixture-owner.internal', recipeVersion: 'recipe-test', phase: 'registered',
      heartbeatAt: '2026-10-17T00:00:00.000000Z',
    } }] }
    throw new Error('Unexpected write or unreviewed query in owner resolution')
  } }
  const owners = new PostgresOwnerStore(executor, { instanceId: instance }, limits)
  const instances = new RuntimeInstanceControl(executor, { internalAddress: 'fixture-local', recipeVersion: 'recipe-test' })
  await owners.migrate()
  await instances.migrate()
  let current = true
  const resolver = new RootOwnerResolver(owners, instances, input.maximum ?? 2, () => {
    if (!current) throw new AccountRuntimeError('cloud/account-unavailable', 'Original Root control ended')
  })
  onTestFinished(async () => { input.release?.(); await resolver.close() })
  return { resolver, port: resolver.port, queries, endRoot: () => { current = false } }
}

it('uses only original owner/instance point reads and returns immutable existing metadata', async () => {
  const f = await fixture()
  const result = await f.port.resolve(account)
  expect(result.owner).toMatchObject({ accountId: account, ownerInstanceId: instance, phase: 'ready', epoch: '1' })
  expect(result.instance).toMatchObject({ instanceId: instance, internalAddress: 'https://fixture-owner.internal' })
  expect(f.queries).toEqual([
    { sql: locateOwnerSql, values: [account] }, { sql: locateInstanceSql, values: [instance] },
    { sql: locateOwnerSql, values: [account] },
  ])
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.owner)).toBe(true)
  expect(Object.isFrozen(result.instance)).toBe(true)
  expect(Object.keys(f.port)).toEqual(['resolve'])
  expect(Object.isFrozen(f.port)).toBe(true)
})

it('does not look up an instance, claim or retry when ownership is absent or not ready', async () => {
  for (const value of [[], [row('unowned')], [row('parked')]]) {
    const f = await fixture({ owner: () => Promise.resolve(value) })
    await expect(f.port.resolve(account)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(f.queries).toEqual([{ sql: locateOwnerSql, values: [account] }])
  }
})

it('detects an owner epoch change during lookup without following the new owner or retrying', async () => {
  let reads = 0
  const f = await fixture({ owner: () => Promise.resolve([row('ready', brandString<OwnerEpoch>(++reads === 1 ? '1' : '2'))]) })
  await expect(f.port.resolve(account)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql, locateInstanceSql, locateOwnerSql])
})

it('preserves a registry failure instead of treating it as an absent instance', async () => {
  const failure = new Error('original registry driver failure')
  const f = await fixture({ registry: () => Promise.reject(failure) })
  await expect(f.port.resolve(account)).rejects.toMatchObject({ code: 'cloud/account-unavailable', cause: failure })
  expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql, locateInstanceSql])
})

it('retains capacity and closure through the actual pending read when the caller has not awaited it', async () => {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const f = await fixture({ maximum: 1, release: () => { release.resolve(undefined) }, owner: async () => {
    entered.resolve(undefined)
    await release.promise
    return [row('ready')]
  } })
  const actual = f.port.resolve(account)
  await entered.promise
  expect(() => { void f.port.resolve(account) }).toThrow(expect.objectContaining({ code: 'cloud/capacity' }))
  const closing = f.resolver.close()
  expect(f.resolver.close()).toBe(closing)
  let closed = false
  void closing.then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(() => { void f.port.resolve(account) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  release.resolve(undefined)
  await expect(actual).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await closing
  expect(closed).toBe(true)
  expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql])
})

it('rechecks the original Root after an awaited read before starting another query', async () => {
  let endRoot = (): void => {}
  const f = await fixture({ registry: () => {
    endRoot()
    return Promise.resolve([])
  } })
  endRoot = f.endRoot
  await expect(f.port.resolve(account)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql, locateInstanceSql])
})

it('preserves a decimal epoch beyond Number precision through both original owner reads', async () => {
  const large = brandString<OwnerEpoch>('9007199254740993')
  const f = await fixture({ owner: () => Promise.resolve([row('ready', large)]) })
  const result = await f.port.resolve(account)
  expect(result.owner.epoch).toBe('9007199254740993')
  expect(typeof result.owner.epoch).toBe('string')
  expect(f.queries).toHaveLength(3)
})

it.each(['missing', 'closed', 'recipe'] as const)('refuses %s instance metadata before another owner read', async (kind) => {
  const f = await fixture({ registry: () => Promise.resolve(kind === 'missing' ? [] : [{ instance: {
    instanceId: instance, internalAddress: 'https://fixture-owner.internal',
    recipeVersion: kind === 'recipe' ? 'different-recipe' : 'recipe-test',
    phase: kind === 'closed' ? 'closed' : 'registered', heartbeatAt: '2026-10-17T00:00:00.000000Z',
  } }]) })
  await expect(f.port.resolve(account)).rejects.toMatchObject({
    code: kind === 'recipe' ? 'cloud/stale-generation' : 'cloud/account-unavailable',
  })
  expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql, locateInstanceSql])
})

it.each(['mounting', 'draining', 'reconfiguring', 'quarantined'] as const)('rejects a %s owner without reading an instance', async (phase) => {
  const f = await fixture({ owner: () => Promise.resolve([row(phase)]) })
  await expect(f.port.resolve(account)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql])
})

it('preserves the original owner read failure and cause without an instance lookup or retry', async () => {
  const failure = new Error('original owner driver failure')
  const f = await fixture({ owner: () => Promise.reject(failure) })
  await expect(f.port.resolve(account)).rejects.toMatchObject({ code: 'cloud/account-unavailable', cause: failure })
  expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql])
})

it.each([0, -1, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid actual-read capacity %s before any lookup', async (maximum) => {
  await expect(fixture({ maximum })).rejects.toMatchObject({ code: 'cloud/invalid-config' })
})

function rawOwner(changes: Readonly<Record<string, string | number | null>> = {}) {
  return { owner: { accountId: account, ownerInstanceId: instance, epoch: '1', phase: 'ready', recipeVersion: 'recipe-test',
    heartbeatAt: '2026-10-17T00:00:00.000000Z', updatedAt: '2026-10-17T00:00:00.000000Z', ...changes } }
}

it.each([['ownerInstanceId', 'different-owner'], ['phase', 'draining'], ['recipeVersion', 'changed']] as const)(
  'refuses observed owner drift in %s without retry', async (field, value) => {
    let reads = 0
    const f = await fixture({ owner: () => Promise.resolve([rawOwner(++reads === 1 ? {} : { [field]: value })]) })
    await expect(f.port.resolve(account)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql, locateInstanceSql, locateOwnerSql])
  },
)

it('refuses observed owner metadata for a different account before reading its instance', async () => {
  const f = await fixture({ owner: () => Promise.resolve([rawOwner({ accountId: 'different-account' })]) })
  await expect(f.port.resolve(account)).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql])
})

it.each([{ epoch: 123, code: 'cloud/account-unavailable' }, { epoch: '01', code: 'cloud/invalid-config' }])(
  'preserves the original malformed epoch rejection for $epoch', async ({ epoch, code }) => {
    const f = await fixture({ owner: () => Promise.resolve([rawOwner({ epoch })]) })
    await expect(f.port.resolve(account)).rejects.toMatchObject({ code })
    expect(f.queries.map(query => query.sql)).toEqual([locateOwnerSql])
  },
)
