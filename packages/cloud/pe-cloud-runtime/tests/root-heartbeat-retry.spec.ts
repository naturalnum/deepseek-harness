/** Original function Loader, executor and instance state; only pg transport and clock are controlled. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Root from '../src/root.ts'
import { RootRecipeAudit } from '../src/recipe-audit.ts'
import { RuntimeInstanceControl, InstanceControlError } from '../src/instance-control.ts'
import { rootConfig, RootCredentials } from './root-control-fixture.ts'
import { accountOwnerMigrationSql } from '../src/migrations/account-owners.ts'
import { instanceMigrationSql } from '../src/migrations/instances.ts'
import { registerInstanceSql, heartbeatInstanceSql, closeInstanceSql } from '../src/instance-sql.ts'
import { locateOwnerSql } from '../src/owner-sql.ts'
import { account } from './owner-fixture.ts'

const driver = vi.hoisted(() => ({ connect: undefined as undefined | (() => Promise<void>),
  run: undefined as undefined | ((text: string, values: readonly (string | null)[]) => Promise<{ rows: readonly unknown[] }>) }))
vi.mock('pg', () => ({ defaults: { query_timeout: 0 }, Client: class {
  constructor(private readonly config: { password?: string | (() => Promise<string>) }) {}
  on() { return this }
  async connect() {
    if (typeof this.config.password === 'function') await this.config.password()
    await driver.connect?.()
  }
  query(input: { text: string; values: readonly (string | null)[] }) {
    if (driver.run === undefined) throw new Error('Unconfigured pg transport fixture')
    return driver.run(input.text, input.values)
  }
  async end() {}
} }))

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'root-heartbeat-retry-'))), config = rootConfig(directory)
  let context: Context | undefined
  const releases: (() => void)[] = [], statements: string[] = []
  onTestFinished(async () => {
    for (const release of releases) release()
    try { await context?.fiber.dispose() }
    finally { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  driver.connect = undefined
  driver.run = async (text, values) => {
    statements.push(text)
    if (text === instanceMigrationSql || text === accountOwnerMigrationSql || text === locateOwnerSql) return { rows: [] }
    if ([registerInstanceSql, heartbeatInstanceSql, closeInstanceSql].includes(text)) {
      return { rows: [{ instance: { instanceId: values[0], internalAddress: values[1], recipeVersion: values[2],
        phase: text === closeInstanceSql ? 'closed' : 'registered', heartbeatAt: '2026-10-29T00:00:00.000000Z' } }] }
    }
    throw new Error('Unexpected SQL in heartbeat component fixture')
  }
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const revokes = vi.spyOn(RootRecipeAudit.prototype, 'revoke')
  const path = join(directory, 'cordis.yml')
  writeFileSync(path, JSON.stringify([{ id: 'credentials', name: 'cordis:heartbeat-credentials' },
    { id: 'runtime', name: 'cordis:heartbeat-root', config }]))
  const graph = await boot('root-heartbeat-transport-fixture', path, [], (ctx) => {
    context = ctx
    Object.assign(ctx.loader.builtins, { 'heartbeat-root': Root, 'heartbeat-credentials': {
      apply(owner: Context) { new RootCredentials(owner, async () => ({ value: 'synthetic-only', source: 'fixture' })) },
    } })
  })
  const runtime = graph.get('peAccountRuntime')
  if (!(runtime instanceof Root.PeAccountRuntime)) throw new Error('Original Root runtime absent')
  const heartbeat = vi.spyOn(RuntimeInstanceControl.prototype, 'heartbeat')
  revokes.mockClear(); stderr.mockClear(); statements.length = 0
  return { runtime, config, heartbeat, statements, stderr, revokes, releases }
}

it('retries only a settled connection failure before SQL using the original interval and preserves metadata guards', async () => {
  const f = await fixture(), unavailable = Object.assign(new Error('PRIVATE endpoint and credential details'), { code: 'ECONNREFUSED' })
  let failures = 2
  driver.connect = async () => { if (failures-- > 0) throw unavailable }
  for (let i = 1; i <= 2; i++) {
    await vi.advanceTimersByTimeAsync(f.config.heartbeatIntervalMs - 1)
    expect(f.heartbeat).toHaveBeenCalledTimes(i - 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.heartbeat).toHaveBeenCalledTimes(i)
    expect(f.statements).not.toContain(heartbeatInstanceSql)
    expect(f.runtime.inspectControl()).toMatchObject({ phase: 'active', hasFailure: false })
    expect(f.revokes).not.toHaveBeenCalledWith('runtime-control')
  }
  await vi.advanceTimersByTimeAsync(f.config.heartbeatIntervalMs)
  expect(f.heartbeat).toHaveBeenCalledTimes(3)
  expect(f.statements.filter(x => x === heartbeatInstanceSql)).toHaveLength(1)
  await expect(f.runtime.locateAccount(account)).resolves.toBeUndefined()
  expect(() => { f.runtime.assertRecipeSealed(f.config.recipeVersion) }).toThrow()
  expect(JSON.stringify(f.stderr.mock.calls)).not.toMatch(/PRIVATE|credential details|ECONNREFUSED/)
  expect(f.stderr.mock.calls.filter(([text]) => text === 'Cloud runtime control observation: %j')).toHaveLength(2)
  await f.runtime.close()
  expect(f.statements.filter(x => x === closeInstanceSql)).toHaveLength(1)
  expect(f.runtime.inspectControl()).toMatchObject({ phase: 'closed', hasFailure: false })
})

it('joins a pending heartbeat on shutdown and ignores only its eventual confirmed zero-submission failure', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  f.releases.push(() => { release.resolve(undefined) })
  driver.connect = async () => { entered.resolve(undefined); await release.promise; throw new Error('Private before-submit failure') }
  await vi.advanceTimersByTimeAsync(f.config.heartbeatIntervalMs)
  await entered.promise
  let closed = false
  const closing = f.runtime.close().then(() => { closed = true })
  await Promise.resolve(); expect(closed).toBe(false)
  driver.connect = undefined
  release.resolve(undefined); await closing
  expect(closed).toBe(true)
  expect(f.statements).not.toContain(heartbeatInstanceSql)
  expect(f.statements.filter(x => x === closeInstanceSql)).toHaveLength(1)
  expect(f.runtime.inspectControl()).toMatchObject({ phase: 'closed', hasFailure: false })
  await vi.advanceTimersByTimeAsync(f.config.heartbeatIntervalMs * 3)
  expect(f.heartbeat).toHaveBeenCalledOnce()
})

it.each(['unknown', 'conflict', 'invalid-record', 'wrong-operation'] as const)('keeps the permanent fence for %s heartbeat outcomes', async (outcome) => {
  const f = await fixture()
  const run = driver.run!
  if (outcome === 'wrong-operation') f.heartbeat.mockRejectedValueOnce(new InstanceControlError('register', 'not-submitted', 'Private original failure'))
  else driver.run = async (text, values) => {
    if (text !== heartbeatInstanceSql) return run(text, values)
    if (outcome === 'unknown') throw new Error('Private submitted transport failure')
    return { rows: outcome === 'conflict' ? [] : [{}] }
  }
  await vi.advanceTimersByTimeAsync(f.config.heartbeatIntervalMs)
  expect(f.runtime.inspectControl()).toMatchObject({ phase: 'failed', hasFailure: true })
  expect(f.revokes).toHaveBeenCalledWith('runtime-control')
  await vi.advanceTimersByTimeAsync(f.config.heartbeatIntervalMs * 3)
  expect(f.heartbeat).toHaveBeenCalledOnce()
  await expect(f.runtime.close()).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
})

it('retains the actual heartbeat after observation timeout and never un-fences when it eventually succeeds', async () => {
  const f = await fixture(), release = Promise.withResolvers<undefined>(), run = driver.run!
  f.releases.push(() => { release.resolve(undefined) })
  driver.run = async (text, values) => { if (text === heartbeatInstanceSql) await release.promise; return run(text, values) }
  await vi.advanceTimersByTimeAsync(f.config.heartbeatIntervalMs + f.config.heartbeatTimeoutMs)
  expect(f.runtime.inspectControl()).toMatchObject({ phase: 'failed', hasFailure: true })
  expect(f.revokes).toHaveBeenCalledWith('runtime-control')
  let closed = false
  const closing = f.runtime.close().then(() => { closed = true })
  await Promise.resolve(); expect(closed).toBe(false)
  f.releases[0]!(); await closing
  expect(f.runtime.inspectControl()).toMatchObject({ phase: 'failed', hasFailure: true })
  await vi.advanceTimersByTimeAsync(f.config.heartbeatIntervalMs * 3)
  expect(f.heartbeat).toHaveBeenCalledOnce()
})
