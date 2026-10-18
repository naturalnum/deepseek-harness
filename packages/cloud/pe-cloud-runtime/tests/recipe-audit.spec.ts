/** Real Loader/fiber/service facts with external-resource fixtures; no fixture can issue a storage seal. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import z from '@deepseek-ai/schemastery'
import { afterEach, expect, it } from 'vitest'
import { PeAccountRuntime } from '../src/root.ts'
import type { AccountRuntimeService, DrainParticipant, RootRecipeInput, RootRecipeRole } from '../src/types.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const roles: RootRecipeRole[] = ['access/root', 'runtime/root', 'api/root', 'files/root', 'opensandbox/root',
  'runtime/account', 'api/account', 'files/account', 'opensandbox/account', 'instructions/session', 'client/client']

async function fixture(options: {
  duplicateEntry?: boolean
  duplicateProvider?: boolean
  wrongRegistration?: boolean
  disabledFiles?: boolean
} = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'm8m-root-recipe-')))
  directories.push(directory)
  let filesOpen = true
  let executionOpen = true
  const files: DrainParticipant & { inspect(): object } = {
    id: 'files', inspect: () => ({ state: filesOpen ? 'running' : 'closing', healthy: 1 }),
    stopEpoch: async binding => ({ participant: 'files', accountId: binding.accountId, epoch: binding.epoch,
      status: 'unknown', pendingOperationIds: [], evidenceRefs: [], reason: 'external-files-resource-fixture' }),
  }
  const execution: DrainParticipant & { assertReady(): void } = {
    id: 'execution', assertReady() { if (!executionOpen) throw new Error('fixture closed') },
    stopEpoch: async binding => ({ participant: 'execution', accountId: binding.accountId, epoch: binding.epoch,
      status: 'unknown', pendingOperationIds: [], evidenceRefs: [], reason: 'external-execution-resource-fixture' }),
  }
  const auth = { observe: () => ({ phase: 'initialized' }) }
  const infra = { webServer: {}, credentials: {}, clientModules: {} }
  const access = { Config: z.object({}), apply(ctx: Context) { ctx.provide('peAuth', auth) } }
  const isolatedAccess = { Config: z.object({}), apply(ctx: Context) { ctx.provide('peAuth', { ...auth }) } }
  const fileModule = {
    Config: z.object({ minimumHealthyWorkers: z.natural().min(1).required() }), inject: ['peAccountRuntime'],
    apply(ctx: Context) {
      ctx.provide('peFilesPool', files)
      ctx.peAccountRuntime.registerDrainParticipant(options.wrongRegistration ? { ...files } : files)
    },
  }
  const executionModule = { Config: z.object({}), inject: ['peAccountRuntime'], apply(ctx: Context) {
    ctx.provide('peSandboxCoordinator', execution)
    ctx.peAccountRuntime.registerDrainParticipant(execution)
  } }
  const infrastructure = { Config: z.object({}), apply(ctx: Context) {
    ctx.provide('webServer', infra.webServer); ctx.provide('credentials', infra.credentials); ctx.provide('clientModules', infra.clientModules)
  } }
  const configPath = join(directory, 'root.cordis.yml')
  writeFileSync(configPath, JSON.stringify([
    { id: 'runtime', name: 'cordis:runtime', config: { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 } },
    { id: 'access', name: 'cordis:access' },
    { id: 'api', name: 'cordis:api', config: { recipeVersion: 'm8m', rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] } },
    { id: 'files', name: 'cordis:files', config: { minimumHealthyWorkers: 1 }, disabled: options.disabledFiles ?? false },
    { id: 'execution', name: 'cordis:execution' }, { id: 'infra', name: 'cordis:infra' },
    ...options.duplicateEntry ? [{ id: 'another-access', name: 'cordis:access' }] : [],
    ...options.duplicateProvider ? [{ id: 'isolated-access', name: 'cordis:isolated-access', isolate: { peAuth: true } }] : [],
  ]))
  const ctx = await boot('m8m-recipe-root', configPath, [], (owner) => {
    Object.assign(owner.loader.builtins, { runtime: PeAccountRuntime, access, api: ExposureService,
      files: fileModule, execution: executionModule, infra: infrastructure, 'isolated-access': isolatedAccess })
  })
  contexts.push(ctx)
  const runtime: AccountRuntimeService | undefined = ctx.get('peAccountRuntime')
  if (runtime === undefined) throw new Error('Actual component Loader failed')
  const provider = (key: RootRecipeInput['providers'][number]['key'], entryId: string) => {
    const value: unknown = ctx.get(key)
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') throw new Error('Fixture provider missing: ' + key)
    return { key, entryId, value }
  }
  const input: RootRecipeInput = {
    recipeVersion: 'm8m', entrypoints: roles,
    roots: [
      { role: 'access/root', entryId: 'access', module: access }, { role: 'runtime/root', entryId: 'runtime', module: PeAccountRuntime },
      { role: 'api/root', entryId: 'api', module: ExposureService }, { role: 'files/root', entryId: 'files', module: fileModule },
      { role: 'opensandbox/root', entryId: 'execution', module: executionModule },
    ],
    providers: [provider('peAuth', 'access'), provider('peAccountRuntime', 'runtime'), provider('peExposure', 'api'),
      { key: 'peFilesPool', entryId: 'files', value: files }, provider('peSandboxCoordinator', 'execution'),
      provider('webServer', 'infra'), provider('credentials', 'infra'), provider('clientModules', 'infra')],
    manifest: ctx.peExposure.policy.manifest,
  }
  return { ctx, runtime, input, files, execution, closeFiles: () => { filesOpen = false },
    closeExecution: () => { executionOpen = false },
    entry: (id: string) => {
      const entry = [...ctx.loader.entries()].find(row => row.options.id === id)
      if (entry === undefined) throw new Error('Fixture entry missing')
      return entry
    } }
}

it('audits actual Root modules/providers/manifest/participants while refusing invented storage evidence and account ready', async () => {
  const f = await fixture()
  const input = { ...f.input, storage: { quota: true, bytes: 4096, inodes: 8, approved: true } }
  expect(() => { f.runtime.sealRecipe(input) }).toThrow('not sealed')
  expect(f.runtime.inspectRecipe()).toEqual({ status: 'blocked', recipeVersion: 'm8m', rootEntries: 5, providers: 8,
    participants: 2, issues: ['runtime-control-unavailable', 'storage-root-capability-missing'] })
  expect(() => { f.runtime.assertRecipeSealed('m8m') }).toThrow('not sealed')
  expect(f.runtime.inspectControl().accounts).toBe(0)
  const observed = f.runtime.inspectRecipe()
  expect(Object.isFrozen(observed)).toBe(true)
  expect(Object.isFrozen(observed.issues)).toBe(true)
})

it('checks all eleven declared scopes without loading account/session/browser entries in Root', async () => {
  const f = await fixture()
  expect(() => { f.runtime.sealRecipe({ ...f.input, entrypoints: roles.slice(0, 5) }) }).toThrow()
  expect(f.runtime.inspectRecipe().issues).toContain('entrypoint-catalog-mismatch')
  const account = f.entry('infra')
  await account.update({ name: '@deepseek-ai/dsh-pe-cloud-runtime/account' })
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow()
  expect(f.runtime.inspectRecipe().issues).toContain('account-entry-in-root')
})

it('rejects a missing or inactive actual entry and a copied module namespace', async () => {
  const f = await fixture({ disabledFiles: true })
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow()
  expect(f.runtime.inspectRecipe().issues).toContain('root-entry-inactive')
  const g = await fixture()
  expect(() => { g.runtime.sealRecipe({ ...g.input, roots: g.input.roots.map(row => row.role === 'api/root'
    ? { ...row, module: { default: ExposureService } } : row) }) }).toThrow()
  expect(g.runtime.inspectRecipe().issues).toContain('root-module-replaced')
})

it('rejects duplicate imports and a different registered participant despite identical id and methods', async () => {
  const duplicate = await fixture({ duplicateEntry: true })
  expect(() => { duplicate.runtime.sealRecipe(duplicate.input) }).toThrow()
  expect(duplicate.runtime.inspectRecipe().issues).toContain('root-entry-duplicate-or-missing')
  const f = await fixture({ wrongRegistration: true })
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow()
  expect(f.runtime.inspectRecipe().issues).toContain('participant-provider-mismatch')
})

it('rejects a manifest copy/version mismatch and a provider attributed to another entry', async () => {
  const f = await fixture()
  expect(() => { f.runtime.sealRecipe({ ...f.input, manifest: Object.freeze({ ...f.ctx.peExposure.policy.manifest }) }) }).toThrow()
  expect(f.runtime.inspectRecipe().issues).toContain('manifest-replaced-or-missing')
  expect(() => { f.runtime.sealRecipe({ ...f.input, recipeVersion: 'another' }) }).toThrow()
  expect(f.runtime.inspectRecipe().issues).toContain('version-mismatch')
  expect(() => { f.runtime.sealRecipe({ ...f.input, providers: f.input.providers.map(row =>
    row.key === 'peFilesPool' ? { ...row, entryId: 'infra' } : row) }) }).toThrow()
  expect(f.runtime.inspectRecipe().issues).toContain('provider-owner-mismatch')
})

it('rejects an actual isolated duplicate provider and revokes an actual service replacement', async () => {
  const duplicate = await fixture({ duplicateProvider: true })
  expect(() => { duplicate.runtime.sealRecipe(duplicate.input) }).toThrow('not sealed')
  expect(duplicate.runtime.inspectRecipe().issues).toContain('provider-duplicate-or-missing')
  const f = await fixture()
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow('not sealed')
  f.entry('files').fiber?.ctx.set('peFilesPool', { ...f.files })
  expect(f.runtime.inspectRecipe().status).toBe('revoked')
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow('not sealed')
  expect(f.runtime.inspectRecipe().issues).toContain('provider-replaced-or-missing')
})

it('rejects missing requirements and retains finite observations for an overlong catalog', async () => {
  const f = await fixture()
  expect(() => { f.runtime.sealRecipe({ ...f.input, roots: f.input.roots.slice(1), providers: f.input.providers.slice(1) }) }).toThrow('not sealed')
  expect(f.runtime.inspectRecipe().issues).toEqual(expect.arrayContaining(['root-entry-missing', 'provider-missing']))
  expect(() => { f.runtime.sealRecipe({ ...f.input, entrypoints: [...roles, ...roles] }) }).toThrow('not sealed')
  expect(f.runtime.inspectRecipe()).toMatchObject({ status: 'blocked', rootEntries: 0, providers: 0, participants: 0,
    issues: ['entrypoint-catalog-mismatch'] })
})

it.each(['files', 'execution'] as const)('rejects a closed actual %s provider without needing a Loader unload', async (kind) => {
  const f = await fixture()
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow()
  if (kind === 'files') f.closeFiles()
  else f.closeExecution()
  expect(f.runtime.inspectRecipe().status).toBe('revoked')
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow()
  expect(f.runtime.inspectRecipe().issues).toContain('provider-not-current')
})

it('revokes on real native config update, removal and explicit close; a new audit does not inherit authority', async () => {
  const f = await fixture()
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow()
  await f.entry('files').update({ config: { minimumHealthyWorkers: 2 } })
  expect(f.runtime.inspectRecipe().status).toBe('revoked')
  await f.entry('files').fiber?.await()
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow()
  expect(f.runtime.inspectRecipe().issues).toContain('provider-not-current')
  f.runtime.revokeRecipe()
  expect(f.runtime.inspectRecipe().status).toBe('revoked')
  await f.entry('execution').fiber?.dispose()
  expect(f.entry('execution').fiber?.state).not.toBe(FiberState.ACTIVE)
  await f.runtime.close()
  expect(f.runtime.inspectRecipe().status).toBe('closed')
  expect(() => { f.runtime.sealRecipe(f.input) }).toThrow('closed')
})
