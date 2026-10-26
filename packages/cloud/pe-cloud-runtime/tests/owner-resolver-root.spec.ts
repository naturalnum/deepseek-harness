/** Function Loader, original executor/stores and Root closure; only the pg driver and secret source are external fixtures. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { expect, it, vi, onTestFinished } from 'vitest'
import * as Root from '../src/root.ts'
import { PgOwnerExecutor } from '../src/owner-pg-executor.ts'
import { rootConfig, RootCredentials } from './root-control-fixture.ts'
import { locateOwnerSql } from '../src/owner-sql.ts'
import { locateInstanceSql, registerInstanceSql, closeInstanceSql, heartbeatInstanceSql } from '../src/instance-sql.ts'
import { accountOwnerMigrationSql } from '../src/migrations/account-owners.ts'
import { instanceMigrationSql } from '../src/migrations/instances.ts'
import { account } from './owner-fixture.ts'

const driver = vi.hoisted(() => ({
  calls: [] as { text: string; values: readonly (string | null)[] }[],
  events: [] as string[],
  run: undefined as undefined | ((text: string, values: readonly (string | null)[]) => Promise<{ rows: readonly unknown[] }>),
  end: undefined as undefined | ((text: string) => Promise<void>),
}))
vi.mock('pg', () => ({ defaults: { query_timeout: 0 }, Client: class {
  private text = ''
  constructor(private readonly config: { password?: string | (() => Promise<string>) }) {}
  on() { return this }
  async connect() { if (typeof this.config.password === 'function') await this.config.password() }
  async query(input: { text: string; values: readonly (string | null)[] }) {
    this.text = input.text; driver.calls.push(input)
    if (driver.run === undefined) throw new Error('Private pg driver is not configured')
    return driver.run(input.text, input.values)
  }
  async end() { await driver.end?.(this.text); driver.events.push(this.text === locateOwnerSql ? 'owner-client-ended' : 'other-client-ended') }
} }))

async function fixture(maintenance = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'private106-root-')))
  const config = { ...rootConfig(directory), heartbeatIntervalMs: 60000 }
  driver.calls.length = 0; driver.events.length = 0; driver.end = undefined
  driver.run = async (text, values) => {
    if (text === accountOwnerMigrationSql || text === instanceMigrationSql) return { rows: [] }
    if (text === registerInstanceSql || text === closeInstanceSql || text === heartbeatInstanceSql) {
      if (text === closeInstanceSql) driver.events.push('instance-close-submitted')
      return { rows: [{ instance: { instanceId: values[0], internalAddress: values[1], recipeVersion: values[2],
        phase: text === closeInstanceSql ? 'closed' : 'registered', heartbeatAt: '2026-10-17T00:00:00.000000Z' } }] }
    }
    if (text === locateOwnerSql) return { rows: [{ owner: { accountId: values[0], ownerInstanceId: 'metadata-owner-106',
      epoch: '9007199254740993', phase: 'ready', recipeVersion: config.recipeVersion,
      heartbeatAt: '2026-10-17T00:00:00.000000Z', updatedAt: '2026-10-17T00:00:00.000000Z' } }] }
    if (text === locateInstanceSql) return { rows: [{ instance: { instanceId: values[0], internalAddress: 'https://metadata-only.invalid',
      recipeVersion: config.recipeVersion, phase: 'registered', heartbeatAt: '2026-10-17T00:00:00.000000Z' } }] }
    throw new Error('Unexpected SQL outside original migrations/registration/metadata/close')
  }
  const selected = maintenance ? { ...config, recovery: { verifierId: 'local-original-process-and-provider-v1' as const,
    limits: { maxAllocations: 2, maxEvidenceRefs: 2, maxReferenceBytes: 128,
      maxProofBytes: 4096, maxAuditRows: 2, maxProofAgeMs: 1000 } } } : config
  const path = join(directory, 'cordis.yml')
  writeFileSync(path, JSON.stringify([{ id: 'credentials', name: 'cordis:metadata-secret' },
    { id: 'root', name: 'cordis:metadata-root', config: selected }]))
  let context: Context | undefined
  const release: { callback?: () => void } = {}
  onTestFinished(async () => {
    release.callback?.()
    try { await context?.fiber.dispose() } finally { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  })
  const queries = vi.spyOn(PgOwnerExecutor.prototype, 'query')
  const graph = await boot('private106-root', path, [], (ctx) => {
    context = ctx
    Object.assign(ctx.loader.builtins, { 'metadata-root': Root,
      'metadata-secret': { apply(owner: Context) { new RootCredentials(owner, async () => ({ value: 'private106-synthetic', source: 'private106' })) } } })
  })
  const runtime = graph.get('peAccountRuntime')
  if (!(runtime instanceof Root.PeAccountRuntime)) throw new Error('Original function Root was not installed')
  return { graph, runtime, queries, config, release }
}

it('wires the ordinary function Root facade through its one original executor without granting business admission', async () => {
  const f = await fixture()
  const port = f.runtime.ownerResolver
  expect(port).toBeDefined(); if (port === undefined) throw new Error('Read facade absent')
  const before = driver.calls.length
  const result = await port.resolve(account)
  expect(driver.calls.slice(before).map(call => call.text)).toEqual([locateOwnerSql, locateInstanceSql, locateOwnerSql])
  expect(new Set(f.queries.mock.contexts).size).toBe(1)
  expect(result.owner.epoch).toBe('9007199254740993')
  expect(Object.keys(port)).toEqual(['resolve']); expect(Object.isFrozen(port)).toBe(true)
  expect('binding' in result).toBe(false)
  expect(() => { f.runtime.assertRecipeSealed(f.config.recipeVersion) }).toThrow()
  expect(f.runtime.inspectControl()).toMatchObject({ phase: 'active', accounts: 0 })
  await f.runtime.close(); expect(f.runtime.ownerResolver).toBeUndefined()
  expect(() => port.resolve(account)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('closes facade admission synchronously and joins actual driver end before original instance close', async () => {
  const f = await fixture(), port = f.runtime.ownerResolver
  if (port === undefined) throw new Error('Read facade absent')
  const ended = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  f.release.callback = () => { ended.resolve(undefined) }
  driver.end = async (text) => { if (text === locateOwnerSql) { entered.resolve(undefined); await ended.promise } }
  const actual = port.resolve(account)
  const observed = expect(actual).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  await entered.promise
  const closing = f.runtime.close()
  expect(f.runtime.close()).toBe(closing)
  expect(f.runtime.ownerResolver).toBeUndefined()
  expect(() => port.resolve(account)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(driver.events).not.toContain('instance-close-submitted')
  expect(driver.events).not.toContain('owner-client-ended')
  ended.resolve(undefined); await observed; await closing
  expect(driver.events.indexOf('owner-client-ended')).toBeLessThan(driver.events.indexOf('instance-close-submitted'))
  expect(driver.calls.filter(call => call.text === locateInstanceSql)).toHaveLength(0)
  expect(new Set(f.queries.mock.contexts).size).toBe(1)
})

it('omits the facade for component and actual maintenance Roots', async () => {
  const ctx = new Context()
  const component = new Root.PeAccountRuntime(ctx, { maxMountedAccounts: 1, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  expect(component.ownerResolver).toBeUndefined(); await ctx.fiber.dispose()
  const f = await fixture(true)
  expect(f.runtime.inspectControl()).toMatchObject({ phase: 'active' })
  expect(f.runtime.ownerResolver).toBeUndefined()
  expect(f.runtime.recovery).toBeDefined()
  expect(() => f.runtime.acquireAccount(account)).toThrow('Maintenance recovery')
})
