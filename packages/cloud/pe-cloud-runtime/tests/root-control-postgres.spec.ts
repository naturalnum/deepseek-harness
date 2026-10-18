/** Actual root function Loader owns real PG migrations/registration/heartbeat/factory and ordered closure. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as Root from '../src/root.ts'
import type { AccountId, DrainParticipant } from '../src/types.ts'
import { AccountMountPrerequisiteError } from '../src/account-mount.ts'
import { deriveAccountLayout } from '../src/account-layout.ts'
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

  async function root(patch: Partial<ReturnType<typeof rootConfig>> = {}) {
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

  it('uses one root factory for repeated real claims, never starts native fallback/ready, and quarantines rather than releasing retained owners', async () => {
    const fixture = await root()
    const make = (id: DrainParticipant['id']): DrainParticipant => ({
      id, stopEpoch: async binding => ({ participant: id, accountId: binding.accountId, epoch: binding.epoch,
        status: 'unknown', pendingOperationIds: [], evidenceRefs: [], reason: 'test-registration-does-not-prove-drain' }),
    })
    fixture.runtime.registerDrainParticipant(make('files'))
    fixture.runtime.registerDrainParticipant(make('execution'))
    const accountId = brandString<AccountId>('m8e-' + randomUUID())
    const attempts = Array.from({ length: 20 }, () => fixture.runtime.acquireAccount(accountId))
    const results = await Promise.allSettled(attempts)
    expect(results.every(result => result.status === 'rejected' && result.reason instanceof AccountMountPrerequisiteError)).toBe(true)
    const owner = await fixture.runtime.locateAccount(accountId)
    expect(owner).toMatchObject({ accountId, epoch: '1', phase: 'mounting', recipeVersion: fixture.config.recipeVersion })
    expect(fixture.runtime.inspectControl()).toMatchObject({ accounts: 1 })
    const abandoned = brandString<AccountId>('m8e-abandoned-' + randomUUID())
    await expect(fixture.runtime.acquireAccount(abandoned, AbortSignal.abort())).rejects.toMatchObject({ reason: 'observer-cancelled' })
    expect(await fixture.runtime.locateAccount(abandoned)).toBeUndefined()
    expect(fixture.runtime.inspectControl()).toMatchObject({ accounts: 1 })
    if (owner?.ownerInstanceId === null || owner?.ownerInstanceId === undefined) throw new Error('Actual claim has no instance identity')
    const layout = deriveAccountLayout(accountId, owner.ownerInstanceId, fixture.config.paths)
    expect(existsSync(layout.accountRoot)).toBe(false)
    const binding = { accountId, epoch: owner.epoch, recipeVersion: owner.recipeVersion, lifetime: new AbortController().signal }
    expect(() => { fixture.runtime.assertMountCurrent(binding) }).toThrow('no longer current')
    expect(() => { fixture.runtime.assertBusinessCurrent(binding) }).toThrow('no longer current')
    await fixture.ctx.fiber.dispose()
    const retained = await database.query<{ phase: string; epoch: string }>(
      'SELECT phase, epoch::text FROM public.pe_account_owners WHERE account_id = $1', [accountId])
    expect(retained.rows[0]).toEqual({ phase: 'quarantined', epoch: '1' })
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
