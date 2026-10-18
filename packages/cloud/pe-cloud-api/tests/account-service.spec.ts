/** Actual Loader profiles install one API owner and native credential/editor hooks before activation. */
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CloudAccountApi, type AccountApiPreparation } from '../src/account-service.ts'
import * as AccountEntry from '../src/account.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import type { ConfigSaveBarrier } from '../src/save-hooks.ts'

const ref = credentialRef('ACCOUNT_API_SERVICE_FIXTURE')

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'account-api-service-')))
  const saves = new ConfigSaveCoordinator({ maxAccounts: 4, maxRunning: 2, maxQueued: 4, maxQueuedPerAccount: 2,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 4, maxNestedPerOperation: 2, maxWaitersPerAccount: 2 })
  const root = new ExposurePolicy({ recipeVersion: 'api-service-fixture', rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] })
  const accounts: Array<{ ctx: Context; api: CloudAccountApi; barrier: ConfigSaveBarrier }> = []
  onTestFinished(async () => {
    try {
      for (const { ctx, api, barrier } of accounts.toReversed()) {
        const stopped = await api.stopConfigSaves(Date.now() + 1000)
        if (stopped.status === 'confirmed') { await api.withdraw(); saves.releaseAccount(barrier) }
        await ctx.fiber.dispose()
      }
      saves.close()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  async function account(name: string) {
    const dir = join(home, name), profileDir = join(dir, 'profile')
    mkdirSync(profileDir, { recursive: true })
    initProfile(profileDir, [])
    const configPath = join(profileDir, 'cordis.yml'), patchPath = join(profileDir, 'cordis.patch.yml')
    const credentials = join(dir, '.credentials.yaml')
    writeFileSync(join(dir, 'package.json'), '{"name":"api-service-fixture"}\n')
    writeFileSync(patchPath, '[]\n')
    writeFileSync(credentials, `version: 1\nrefs:\n  ACCOUNT_API_SERVICE_FIXTURE: value-${name}\n`, { mode: 0o600 })
    writeFileSync(configPath, JSON.stringify([
      { id: 'editor', name: 'cordis:api-service-editor' },
      { id: 'credentials', name: 'cordis:api-service-credentials', config: { path: credentials, watch: false } },
      { id: 'api', name: 'cordis:api-service-account', config: {} },
    ]))
    const lifetime = new AbortController()
    const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>(name),
      epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: root.manifest.recipeVersion, lifetime: lifetime.signal })
    const mountCurrent = vi.fn((actual: AccountBinding) => { expect(actual).toBe(binding); lifetime.signal.throwIfAborted() })
    const businessClosed = new Error('Business publication remains closed')
    const businessCurrent = vi.fn((_binding: AccountBinding): void => { throw businessClosed })
    const profile: ProfileContext = { name: 'account', dir: profileDir, patchPath, installAnchor: join(dir, 'package.json'),
      cwd: dir, home: dir, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
    let api: CloudAccountApi | undefined, input: AccountApiPreparation | undefined
    const ctx = await boot('api-service-' + name, configPath, [], (scope) => {
      scope.provide('profileContext', profile)
      scope.provide('peAccount', binding)
      const barrier = saves.createAccount(binding)
      input = { binding, rootExposure: root, selected: root.manifest, saves: barrier,
        assertMountCurrent: mountCurrent, assertBusinessCurrent: businessCurrent }
      api = new CloudAccountApi(scope, input)
      accounts.push({ ctx: scope, api, barrier })
      Object.assign(scope.loader.builtins, {
        'api-service-editor': api.providers.configEditor,
        'api-service-credentials': api.providers.credentials,
        'api-service-account': AccountEntry,
      })
    })
    if (api === undefined || input === undefined) throw new Error('API preparation did not run')
    return { ctx, api, input, credentials, businessClosed, businessCurrent, lifetime, mountCurrent }
  }
  return { account }
}

it('loads the real account entry while business stays closed and native writes retain the existing save barrier', async () => {
  const f = await fixture().account('A')
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'api')
  expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)
  const traced = f.ctx.get('peCloudApi')
  expect(traced).toBeInstanceOf(CloudAccountApi)
  expect(traced?.binding).toBe(f.api.binding)
  traced?.assertInstalled()
  expect(f.businessCurrent).not.toHaveBeenCalled()
  expect(() => traced?.requireRpc('session/create')).toThrow(f.businessClosed)
  expect((await f.ctx.credentials.resolve(ref))?.value).toBe('value-A')
  await f.ctx.credentials.set(ref, 'updated-A')
  const before = readFileSync(f.credentials, 'utf8')
  expect(before).toContain('updated-A')
  expect((await f.api.stopConfigSaves(Date.now() + 1000)).status).toBe('confirmed')
  await expect(f.ctx.credentials.set(ref, 'must-not-save')).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(readFileSync(f.credentials, 'utf8')).toBe(before)
  await f.api.withdraw()
  expect(() => { f.api.assertInstalled() }).toThrow('withdrawn')
})

it('rejects duplicate or foreign ownership and keeps another account view and native credentials independent', async () => {
  const shared = fixture(), a = await shared.account('A'), b = await shared.account('B')
  expect(() => new CloudAccountApi(a.ctx, a.input)).toThrow('already has an API owner')
  expect(() => { a.api.assertInstalled(b.ctx) }).toThrow()
  const shadow = a.ctx.isolate('peCloudApi')
  shadow.provide('peCloudApi', b.api)
  expect(() => { a.api.assertInstalled(shadow) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  a.api.audit({ recipeVersion: a.input.binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [] })
  b.api.audit({ recipeVersion: b.input.binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [] })
  a.businessCurrent.mockImplementation(() => {})
  b.businessCurrent.mockImplementation(() => {})
  expect(() => b.api.requireRpc('not-exposed')).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  await a.api.stopConfigSaves(Date.now() + 1000)
  expect(() => a.api.requireRpc('not-exposed')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => b.api.requireRpc('not-exposed')).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect((await b.ctx.credentials.resolve(ref))?.value).toBe('value-B')
  a.lifetime.abort()
  expect(() => { a.api.assertInstalled() }).toThrow()
  b.api.assertInstalled()
})

it('refuses an unprepared entry and nonempty Loader configuration', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  expect(() => { AccountEntry.apply(ctx, {}) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => AccountEntry.Config({ binding: 'not-an-input' })).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
})
