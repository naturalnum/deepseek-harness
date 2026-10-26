/** Actual root function Loader owns real PG migrations/registration/heartbeat/factory and ordered closure. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { Context, type Message } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Root from '../src/root.ts'
import { RootRecipeAudit } from '../src/recipe-audit.ts'
import type { AccountId, DrainParticipant } from '../src/types.ts'
import { instanceTestConnection } from './instance-test-connection.ts'
import { RootCredentials, rootConfig } from './root-control-fixture.ts'

const privateConfig = process.env['DSH_RUNTIME_ROOT_PG_PRIVATE_CONFIG']

describe.skipIf(privateConfig === undefined)('actual root Loader on the controller-assigned runtime database', { concurrent: false }, () => {
  let connection: Awaited<ReturnType<typeof instanceTestConnection>>
  let database: Client
  const contexts: Context[] = []
  const directories: string[] = []
  const recipes: string[] = []
  beforeAll(async () => {
    if (privateConfig === undefined) throw new Error('Controller-assigned runtime PG configuration is required')
    connection = await instanceTestConnection(privateConfig)
    database = new Client(connection)
    await database.connect()
  })
  afterEach(async () => {
    await database.query('ROLLBACK')
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
    for (const recipe of recipes.splice(0)) {
      await database.query('DELETE FROM public.pe_account_owners WHERE recipe_version = $1', [recipe])
      await database.query('DELETE FROM public.pe_instances WHERE recipe_version = $1', [recipe])
    }
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  afterAll(async () => { await database?.end() })

  async function root(patch: Partial<ReturnType<typeof rootConfig>> = {}, setupRoot?: (ctx: Context) => void) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'm8e-actual-root-')))
    directories.push(dir)
    const recipeVersion = 'm8e-root-' + randomUUID()
    recipes.push(recipeVersion)
    const config = { ...rootConfig(dir), ...patch, recipeVersion }
    const { host, port, user, database: name } = connection
    config.database = { ...config.database, host, port, user, database: name }
    const configPath = join(dir, 'root.cordis.yml')
    writeFileSync(configPath, JSON.stringify([
      { id: 'credentials', name: 'cordis:root-test-credentials' },
      { id: 'runtime', name: 'cordis:actual-root', config },
    ]))
    let resolves = 0
    const ctx = await boot('m8e-runtime-root', configPath, [], (setup) => {
      setupRoot?.(setup)
      Object.assign(setup.loader.builtins, {
        'actual-root': Root,
        'root-test-credentials': { apply(owner: Context) {
          new RootCredentials(owner, async () => {
            resolves++
            const password = connection.password
            return { value: typeof password === 'string' ? password : await password(), source: 'controller-assigned-test' }
          })
        } },
      })
    })
    contexts.push(ctx)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'runtime')
    if (entry?.fiber === undefined) throw new Error('Actual runtime Loader entry is absent')
    await entry.fiber.await()
    const runtime = ctx.get('peAccountRuntime')
    if (runtime === undefined) throw new Error('Actual runtime root did not activate')
    const record = async () => {
      const result = await database.query<{ instance_id: string; phase: string; heartbeat_at: Date }>(
        'SELECT instance_id, phase, heartbeat_at FROM public.pe_instances WHERE recipe_version = $1', [recipeVersion])
      expect(result.rowCount).toBe(1)
      return result.rows[0]!
    }
    return { ctx, runtime, config, record, resolves: () => resolves }
  }

  // The formal AppReady test supplier controls callback timing only; it is not a production ready producer.
  function readyObservation(brokenLogger = false) {
    const listeners = new Set<() => void>(), messages: Message[] = []
    return {
      messages, listeners,
      setup: (ctx: Context) => {
        ctx.provide('appReady', { onReady(listener: () => void) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        } })
        ctx.logger.exporter({ levels: { default: 3 }, export(message) {
          if (!(message.type === 'info' && message.args[0] === 'Cloud runtime observation: %o')
            && !(message.type === 'warn' && message.args[0] === 'Cloud runtime observation is unavailable; business state is unchanged.')) return
          messages.push(message)
          if (brokenLogger) throw new Error('Test observation sink failed')
        } })
      },
      commit() { for (const listener of [...listeners]) { listeners.delete(listener); listener() } },
    }
  }

  it('emits the bounded ordinary Root observation only after AppReady and a successful seal return', async () => {
    const observation = readyObservation()
    let observationsBeforeSealReturn = -1
    // Isolate only this notification boundary; the original audit remains unsealed and grants no account authority.
    const seal = vi.spyOn(RootRecipeAudit.prototype, 'sealCurrent').mockImplementation(() => {
      observationsBeforeSealReturn = observation.messages.length
    })
    try {
      const fixture = await root({}, observation.setup)
      const original = await fixture.record()
      expect(observation.listeners.size).toBe(1)
      expect(seal).not.toHaveBeenCalled()
      expect(observation.messages).toHaveLength(0)
      expect(() => { observation.commit() }).not.toThrow()
      expect(seal).toHaveBeenCalledTimes(1)
      expect(seal).toHaveBeenCalledWith(fixture.config.recipeVersion, fixture.config.native.maxEntries)
      expect(observationsBeforeSealReturn).toBe(0)
      expect(observation.messages).toHaveLength(1)
      const fields: unknown = observation.messages[0]?.args[1]
      if (typeof fields !== 'object' || fields === null) throw new Error('The ready logger must receive its structured record')
      const monotonicNs: unknown = Reflect.get(fields, 'monotonicNs')
      expect(monotonicNs).toMatch(/^[0-9]{1,24}$/)
      expect(observation.messages[0]?.args[1]).toEqual({ event: 'ordinary-profile-ready', pid: process.pid,
        instanceId: original.instance_id, recipeVersion: fixture.config.recipeVersion,
        rootFiberUid: fixture.ctx.root.fiber.uid, monotonicNs,
        appReadyObserved: true, recipeStatus: 'sealed' })
      expect(() => { fixture.runtime.assertRecipeSealed(fixture.config.recipeVersion) }).toThrow('not sealed')
    } finally { seal.mockRestore() }
  })

  it('emits no successful Root observation when the original native recipe seal rejects', async () => {
    const observation = readyObservation()
    const seal = vi.spyOn(RootRecipeAudit.prototype, 'sealCurrent')
    try {
      const fixture = await root({}, observation.setup)
      expect(() => { observation.commit() }).not.toThrow()
      expect(seal).toHaveBeenCalledTimes(1)
      expect(seal).toHaveBeenCalledWith(fixture.config.recipeVersion, fixture.config.native.maxEntries)
      expect(seal.mock.results[0]?.type).toBe('throw')
      expect(observation.messages).toHaveLength(0)
      expect(fixture.runtime.inspectRecipe()).toMatchObject({ status: 'blocked' })
      expect(() => { fixture.runtime.assertRecipeSealed(fixture.config.recipeVersion) }).toThrow('not sealed')
      expect(fixture.runtime.inspectControl()).toMatchObject({ phase: 'active', accounts: 0, hasFailure: false })
    } finally { seal.mockRestore() }
  })

  it('contains failures of both the ready info sink and its warning without changing original Root lifecycle', async () => {
    const observation = readyObservation(true)
    const seal = vi.spyOn(RootRecipeAudit.prototype, 'sealCurrent').mockImplementation(() => {})
    try {
      const fixture = await root({}, observation.setup)
      const original = await fixture.record()
      expect(() => { observation.commit() }).not.toThrow()
      expect(seal).toHaveBeenCalledTimes(1)
      expect(seal).toHaveBeenCalledWith(fixture.config.recipeVersion, fixture.config.native.maxEntries)
      expect(observation.messages.map(message => message.type)).toEqual(['info', 'warn'])
      expect(fixture.runtime.inspectControl()).toMatchObject({ phase: 'active', accounts: 0, hasFailure: false })
      expect(await fixture.record()).toMatchObject({ instance_id: original.instance_id, phase: 'registered' })
      expect(() => { fixture.runtime.assertRecipeSealed(fixture.config.recipeVersion) }).toThrow('not sealed')
      await fixture.ctx.fiber.dispose()
      expect(fixture.runtime.inspectControl()).toMatchObject({ phase: 'closed', accounts: 0, hasFailure: false })
      expect((await fixture.record()).phase).toBe('closed')
    } finally { seal.mockRestore() }
  })

  it('migrates/registers through the actual Loader, heartbeats with newly resolved credentials, then closes its row and connections', async () => {
    const fixture = await root()
    const first = await fixture.record()
    expect(first.phase).toBe('registered')
    expect(fixture.runtime.inspectControl()).toMatchObject({ phase: 'active', accounts: 0, pendingSecrets: 0 })
    expect(() => { fixture.runtime.assertRequiredParticipants() }).toThrow('files')
    const before = fixture.resolves()
    await expect.poll(async () => (await fixture.record()).heartbeat_at.getTime()).toBeGreaterThan(first.heartbeat_at.getTime())
    expect(fixture.resolves()).toBeGreaterThan(before)
    await fixture.ctx.fiber.dispose()
    expect((await fixture.record()).phase).toBe('closed')
    expect(fixture.runtime.inspectControl()).toMatchObject({ phase: 'closed', accounts: 0, pendingSecrets: 0 })
    expect(() => fixture.runtime.locateAccount(brandString<AccountId>('closed-root'))).toThrow('closed')
    const sessions = await database.query<{ count: string }>(
      'SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')
    expect(sessions.rows[0]?.count).toBe('0')
  })

  it('refuses unsealed actual root acquisition before any claim or native graph despite registered participants', async () => {
    const fixture = await root()
    const make = (id: DrainParticipant['id']): DrainParticipant => ({
      id, stopEpoch: async binding => ({ participant: id, accountId: binding.accountId, epoch: binding.epoch,
        status: 'unknown', pendingOperationIds: [], evidenceRefs: [], reason: 'test-registration-does-not-prove-drain' }),
    })
    fixture.runtime.registerDrainParticipant(make('files'))
    fixture.runtime.registerDrainParticipant(make('execution'))
    const accountId = brandString<AccountId>('m8m-' + randomUUID())
    expect(() => fixture.runtime.acquireAccount(accountId)).toThrow('not sealed')
    expect(await fixture.runtime.locateAccount(accountId)).toBeUndefined()
    expect(fixture.runtime.inspectControl()).toMatchObject({ accounts: 0 })
    expect(existsSync(fixture.config.paths.sharedAccountsRoot)).toBe(false)
    await fixture.ctx.fiber.dispose()
    expect((await fixture.record()).phase).toBe('closed')
  })

  it('keeps Root metadata access through actual participant cleanup, then refuses old borrowers before SQL submission', async () => {
    const fixture = await root()
    const stopped = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
    const participant: DrainParticipant = { id: 'execution',
      closeRoot: () => { entered.resolve(undefined); return stopped.promise },
      stopEpoch: async () => { throw new Error('This fixture mounts no account') } }
    fixture.runtime.registerDrainParticipant(participant)
    expect(() => fixture.runtime.controlDatabase({ ...participant })).toThrow('original registered')
    const query = fixture.runtime.controlDatabase(participant)
    expect(fixture.runtime.controlDatabase(participant)).toBe(query)
    await expect(query.query('SELECT $1::text AS value', ['actual-root-metadata']))
      .resolves.toMatchObject({ rows: [{ value: 'actual-root-metadata' }] })
    const actual = fixture.runtime.close()
    try {
      await entered.promise
      expect((await fixture.record()).phase).toBe('registered')
      expect(() => fixture.runtime.controlDatabase(participant)).toThrow('closed')
      await expect(query.query('SELECT $1::text AS value', ['cleanup-still-owned']))
        .resolves.toMatchObject({ rows: [{ value: 'cleanup-still-owned' }] })
    } finally { stopped.resolve(undefined); await actual }
    const failure = await query.query('SELECT 1', []).then(() => undefined, (cause: unknown) => cause)
    expect(query.wasNotSubmitted(failure)).toBe(true)
    expect(query.wasNotSubmitted(new Error('unclassified transport failure'))).toBe(false)
    expect((await fixture.record()).phase).toBe('closed')
  })

  it('closes admission after a heartbeat observation expires but joins the original locked SQL before actual shutdown', async () => {
    const fixture = await root({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 30 })
    const first = await fixture.record()
    await database.query('BEGIN')
    await database.query('SELECT instance_id FROM public.pe_instances WHERE instance_id = $1 FOR UPDATE', [first.instance_id])
    try {
      await expect.poll(() => fixture.runtime.inspectControl().phase).toBe('failed')
      expect(() => fixture.runtime.locateAccount(brandString<AccountId>('heartbeat-blocked'))).toThrow('not available')
      let closed = false
      const actual = fixture.runtime.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      await database.query('ROLLBACK')
      await actual
      expect(closed).toBe(true)
      expect((await fixture.record()).phase).toBe('closed')
      expect(fixture.runtime.inspectControl()).toMatchObject({ phase: 'failed', hasFailure: true })
    } finally { await database.query('ROLLBACK') }
  })
})
