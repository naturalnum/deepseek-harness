/** Actual function Loader rejects incomplete deployment and retains pending secret cleanup without network. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { afterEach, expect, it, vi } from 'vitest'
import * as Root from '../src/root.ts'
import * as Index from '../src/index.ts'
import { RuntimeRootConfigSchema } from '../src/schema.ts'
import { rootConfig, RootCredentials } from './root-control-fixture.ts'
import type { AccountBinding, DrainParticipant } from '../src/types.ts'

const directories: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-root-control-')))
  directories.push(path)
  return path
}

it('exports the real function plugin without a default that hides apply/inject; component capacities remain independently usable', () => {
  expect('default' in Root).toBe(false)
  expect('default' in Index).toBe(false)
  expect(Index.apply).toBe(Root.apply)
  expect(Root.inject).toEqual(['credentials'])
  expect(() => z.resolve({ maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 }, Root.Config, {})).toThrow()
  expect(Root.PeAccountRuntime.Config({ maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 }))
    .toEqual({ maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
})

it('requires explicit root budgets and a formal reference without accepting a password value', () => {
  const config = rootConfig(directory())
  expect(RuntimeRootConfigSchema(config)).toEqual(config)
  expect(() => RuntimeRootConfigSchema({ ...config, heartbeatIntervalMs: 0 })).toThrow()
  expect(() => RuntimeRootConfigSchema({ ...config, database: { ...config.database, passwordRef: 'not a ref' } })).toThrow()
  expect(() => RuntimeRootConfigSchema({ ...config, pg: { ...config.pg, lockTimeoutMs: Infinity } })).toThrow()
  expect(() => z.resolve({ ...config, saves: undefined }, RuntimeRootConfigSchema, {})).toThrow()
  expect(() => z.resolve({ ...config, accountPolicy: undefined }, RuntimeRootConfigSchema, {})).toThrow()
})

it('cannot borrow a graph through a component-only or closed root and never reserves a mount for that request', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const runtime = new Root.PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const binding: AccountBinding = {
    accountId: 'not-mounted' as AccountBinding['accountId'], epoch: '1' as AccountBinding['epoch'],
    recipeVersion: 'not-mounted', lifetime: new AbortController().signal,
  }
  await expect(runtime.borrowAccount(binding)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(runtime.inspectControl()).toMatchObject({ phase: 'component', accounts: 0 })
  await runtime.close()
  await expect(runtime.borrowAccount(binding)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(runtime.inspectControl()).toMatchObject({ accounts: 0 })
})

it('retains the original secret resolution during Loader closure, without starting a database or graph', async () => {
  const dir = directory()
  mkdirSync(join(dir, 'profile'))
  const configPath = join(dir, 'root.cordis.yml')
  writeFileSync(configPath, JSON.stringify([
    { id: 'credentials', name: 'cordis:root-credentials' },
    { id: 'runtime', name: 'cordis:actual-runtime-root', config: rootConfig(dir) },
  ]))
  const secret = Promise.withResolvers<ResolvedCredential | undefined>()
  const entered = Promise.withResolvers<undefined>()
  let context: Context | undefined
  const read = vi.fn(() => { entered.resolve(undefined); return secret.promise })
  const actual = boot('actual-runtime-root-no-network', configPath, [], (ctx) => {
    context = ctx; contexts.push(ctx)
    Object.assign(ctx.loader.builtins, {
      'actual-runtime-root': Root,
      'root-credentials': { apply(scope: Context) { new RootCredentials(scope, read) } },
    })
  })
  try {
    await entered.promise
    if (context === undefined) throw new Error('Loader prepare did not run')
    let closed = false
    const closing = context.fiber.dispose().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    secret.resolve(undefined)
    await closing
    await actual
    expect(read).toHaveBeenCalledTimes(1)
    expect(closed).toBe(true)
  } finally { secret.resolve(undefined); await actual }
})

it('retains a Root participant until its actual shutdown settles and denies component-only database borrowing', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const runtime = new Root.PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const stopped = Promise.withResolvers<undefined>()
  const closeRoot = vi.fn(() => stopped.promise)
  const participant: DrainParticipant = { id: 'execution', closeRoot,
    stopEpoch: async () => { throw new Error('No account is mounted in this fixture') } }
  const withdraw = runtime.registerDrainParticipant(participant)
  expect(() => runtime.controlDatabase(participant)).toThrow('not available')
  const actual = withdraw()
  await Promise.resolve()
  expect(closeRoot).toHaveBeenCalledTimes(1)
  expect(() => runtime.registerDrainParticipant(participant)).toThrow('Duplicate')
  stopped.resolve(undefined)
  await actual
  expect(() => runtime.registerDrainParticipant({ ...participant, closeRoot: () => Promise.resolve() })).not.toThrow()
})
