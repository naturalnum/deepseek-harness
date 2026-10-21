/** Real native A/B Loader profiles on owned Node paths; runtime/storage authority remains an explicit fixture. */
import * as fs from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Settings from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { prepareAccountApiInstall, type AccountApiInstall } from '../src/account-install.ts'
import { apply as mountIncompleteAccount } from '../src/account.ts'
import { CloudApiError } from '../src/errors.ts'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import type { ConfigSaveBarrier } from '../src/save-hooks.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof fs>()
  return { ...native, rename: vi.fn(native.rename), readFile: vi.fn(native.readFile) }
})

beforeEach(async () => {
  const native = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(native.rename)
  vi.mocked(fs.readFile).mockReset().mockImplementation(native.readFile)
})

const REF = credentialRef('DSH_API_INSTALL_FIXTURE')

function latch() {
  const signal = Promise.withResolvers<undefined>()
  return { promise: signal.promise, resolve: () => { signal.resolve(undefined) } }
}

function fixture() {
  const home = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'account-install-')))
  const coordinator = new ConfigSaveCoordinator({
    maxAccounts: 4, maxRunning: 2, maxQueued: 8, maxQueuedPerAccount: 4,
    maxTrackedOperations: 16, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 2, maxWaitersPerAccount: 3,
  })
  const maximum = new ExposurePolicy({
    recipeVersion: 'm8-install',
    rpcEndpoints: [{ endpoint: 'session/page', handlerId: 'native:sessionController', guard: 'account-session' }],
    streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [],
  })
  const accounts: Array<{
    context?: Context
    install?: AccountApiInstall
    barrier?: ConfigSaveBarrier
    boot?: Promise<Context>
  }> = []
  const releases: Array<() => void> = []
  onTestFinished(async () => {
    for (const release of releases) release()
    try {
      for (const account of accounts) {
        if (account.boot !== undefined) await Promise.allSettled([account.boot])
        if (account.install !== undefined && account.barrier !== undefined) {
          const receipt = await account.install.stopConfigSaves(Date.now() + 1_000)
          if (receipt.status === 'confirmed') {
            await account.install.withdraw()
            coordinator.releaseAccount(account.barrier)
          }
          // Failure fixtures retain their barrier evidence/slot; disposal below only cleans owned Node test files.
        }
        await account.context?.fiber.dispose()
      }
      if (coordinator.snapshot().accounts === 0) coordinator.close()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  const account = (name: string, options: { flat?: boolean; legacy?: boolean } = {}) => {
    const accountHome = join(home, name)
    const dir = join(accountHome, 'profiles', 'account')
    mkdirSync(dir, { recursive: true })
    initProfile(dir, [])
    writeFileSync(join(accountHome, 'package.json'), '{"name":"account-api-install-fixture"}\n')
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const credentialPath = join(accountHome, '.credentials.yaml')
    writeFileSync(credentialPath, options.flat === true
      ? `DSH_API_INSTALL_FIXTURE: original-${name}\n`
      : `version: 1\nrefs:\n  DSH_API_INSTALL_FIXTURE: original-${name}\n`, { mode: 0o600 })
    if (options.legacy === true) writeFileSync(join(accountHome, 'settings.yaml'), 'probe:\n  count: 4\n')
    const patchPath = join(dir, 'cordis.patch.yml')
    writeFileSync(patchPath, JSON.stringify([{ insert: [
      { id: 'editor', name: 'cordis:install-editor' },
      { id: 'credentials', name: 'cordis:install-credentials', config: { path: credentialPath, watch: false } },
      { id: 'settings', name: 'cordis:install-settings' },
      { id: 'model', name: 'cordis:install-model', config: { provider: 'fixture', model: 'original' } },
      { id: 'probe', name: 'cordis:install-probe', config: { count: 1 } },
    ] }]) + '\n')
    const profile: ProfileContext = {
      name: 'account', dir, patchPath, installAnchor: join(accountHome, 'package.json'),
      cwd: accountHome, home: accountHome, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    }
    const lifetime = new AbortController()
    const binding: AccountBinding = Object.freeze({
      accountId: brandString<AccountId>(name), epoch: brandString<OwnerEpoch>('1'),
      recipeVersion: maximum.manifest.recipeVersion, lifetime: lifetime.signal,
    })
    const graphClosed = new CloudApiError('cloud/account-unavailable', 'Fixture graph admission is closed.')
    const current = vi.fn((actual: AccountBinding): void => {
      if (actual !== binding || lifetime.signal.aborted) throw graphClosed
    })
    const owned: typeof accounts[number] = {}
    accounts.push(owned)
    const prepared = latch()
    const start = (): Promise<Context> => {
      owned.boot = boot('api-install-' + name, join(dir, 'cordis.yml'), readProfilePatches('account', profile), (ctx) => {
        owned.context = ctx
        ctx.provide('profileContext', profile)
        // This is an explicit graph-binding fixture, not the runtime's private owner/ready handoff.
        ctx.provide('peAccount', binding)
        const installed = ctx.get('peAccount')!
        owned.barrier = coordinator.createAccount(installed)
        owned.install = prepareAccountApiInstall(ctx, installed, current, maximum, maximum.manifest, owned.barrier)
        Object.assign(ctx.loader.builtins, {
          'install-editor': owned.install.configEditor, 'install-credentials': owned.install.credentials,
          'install-settings': Settings, 'install-model': DefaultModel,
          'install-probe': { Config: z.object({ count: z.number().min(1).volatile() }), apply() {} },
        })
        prepared.resolve()
      })
      void owned.boot.catch(() => {})
      return owned.boot
    }
    const install = (): AccountApiInstall => {
      if (owned.install === undefined) throw new Error('Fixture prepare has not run.')
      return owned.install
    }
    const barrier = (): ConfigSaveBarrier => {
      if (owned.barrier === undefined) throw new Error('Fixture barrier has not been issued.')
      return owned.barrier
    }
    return {
      start, install, barrier, prepared: prepared.promise, credentialPath, profile, accountHome, binding, lifetime, current, graphClosed,
    }
  }
  const holdRename = (matches: (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => boolean) => {
    const entered = latch()
    const release = latch()
    releases.push(release.resolve)
    const previous = vi.mocked(fs.rename).getMockImplementation()!
    let held = false
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!held && matches(from, to)) {
        held = true
        entered.resolve()
        await release.promise
      }
      await previous(from, to)
    })
    return { entered: entered.promise, release: release.resolve }
  }
  const holdInitialRead = (path: string) => {
    const entered = latch()
    const release = latch()
    releases.push(release.resolve)
    const previous = vi.mocked(fs.readFile).getMockImplementation()!
    let held = false
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      if (!held && args[0] === path) {
        held = true
        entered.resolve()
        await release.promise
      }
      return previous(...args)
    })
    return { entered: entered.promise, release: release.resolve }
  }
  return { maximum, coordinator, account, holdRename, holdInitialRead }
}

it('installs constructor hooks before real credentials migration and Settings legacy rename in independent A/B Loaders', async () => {
  const f = fixture()
  const a = f.account('A', { flat: true, legacy: true })
  const b = f.account('B', { flat: true })
  const credentialWrite = f.holdRename((_from, to) => to === a.credentialPath)
  const legacyRename = f.holdRename(from => from === join(a.accountHome, 'settings.yaml'))
  const bootA = a.start()
  await credentialWrite.entered
  expect(a.barrier().snapshot().pending).toMatchObject([{ kind: 'credentials' }])
  expect(a.current).not.toHaveBeenCalled()
  await expect(a.install().withdraw()).rejects.toMatchObject({ code: 'cloud/config-busy' })
  const ctxB = await b.start()
  expect(await ctxB.credentials.resolve(REF)).toEqual({ value: 'original-B', source: 'file' })
  expect(a.barrier().snapshot().pending).toHaveLength(1)
  credentialWrite.release()
  const ctxA = await bootA
  await legacyRename.entered
  expect(a.barrier().snapshot().pending).toMatchObject([{ kind: 'settings' }])
  expect(existsSync(join(a.accountHome, 'settings.yaml'))).toBe(true)
  legacyRename.release()
  await vi.waitFor(() => { expect(ctxA.settings.describe().find(row => row.ns === 'probe')?.value).toEqual({ count: 4 }) })
  expect(existsSync(join(a.accountHome, 'settings.yaml.imported'))).toBe(true)
  expect(readFileSync(a.credentialPath, 'utf8')).toContain('version: 1')
  expect(await ctxA.credentials.resolve(REF)).toEqual({ value: 'original-A', source: 'file' })
  expect(a.current).not.toHaveBeenCalled()
  expect(a.install().binding).toBe(a.barrier().binding)
  expect(() => { a.install().exposure.audit({
    recipeVersion: a.binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [],
  }) }).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
  expect(a.current).toHaveBeenCalledWith(a.binding)
  expect(() => a.install().exposure.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() =>{  mountIncompleteAccount(ctxA, {}) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('pauses actual submitted work, rejects new native writers and only reopens the paused quiescent barrier', async () => {
  const f = fixture()
  const a = f.account('A')
  const ctx = await a.start()
  const slow = f.holdRename((_from, to) => to === a.credentialPath)
  const saved = ctx.credentials.set(REF, 'committed')
  void saved.catch(() => {})
  await slow.entered
  const control = a.install()
  expect(await control.pauseAccountChanges(Date.now())).toMatchObject({ status: 'unknown', admission: 'paused' })
  expect(() => { control.resumeAccountChanges() }).toThrow(expect.objectContaining({ code: 'cloud/config-busy' }))
  await expect(ctx.credentials.unset(REF)).rejects.toMatchObject({ code: 'cloud/config-busy' })
  await expect(ctx.agentDefaultModel.saveSelection({ provider: 'fixture', model: 'blocked' })).rejects.toMatchObject({ code: 'cloud/config-busy' })
  slow.release()
  await saved
  expect(await control.pauseAccountChanges(Date.now() + 1_000)).toMatchObject({ status: 'confirmed' })
  await expect(control.withdraw()).rejects.toMatchObject({ code: 'cloud/config-busy' })
  control.resumeAccountChanges()
  await ctx.agentDefaultModel.saveSelection({ provider: 'fixture', model: 'allowed' })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('allowed')
  expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'committed', source: 'file' })
})

it('retains late native initialization after stop/observer cancellation and rejects withdrawal until actual settlement', async () => {
  const f = fixture()
  const a = f.account('A', { flat: true })
  const slow = f.holdRename((_from, to) => to === a.credentialPath)
  let settled = false
  const booting = a.start()
  void booting.then(() => { settled = true }, () => { settled = true })
  await slow.entered
  const signal = new AbortController()
  const stopped = a.install().stopConfigSaves(Date.now() + 1_000, signal.signal)
  signal.abort()
  expect(await stopped).toMatchObject({ status: 'unknown', reason: 'observer-cancelled', admission: 'stopped' })
  expect(settled).toBe(false)
  expect(a.barrier().snapshot().pending).toHaveLength(1)
  await expect(a.install().withdraw()).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(() => { f.coordinator.releaseAccount(a.barrier()) }).toThrow()
  slow.release()
  const ctx = await booting
  expect(readFileSync(a.credentialPath, 'utf8')).toContain('version: 1')
  expect(await a.install().stopConfigSaves(Date.now() + 1_000)).toMatchObject({ status: 'confirmed', pendingOperationIds: [] })
  await expect(ctx.credentials.set(REF, 'must-not-submit')).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(() => { a.install().resumeAccountChanges() }).toThrow()
  const first = a.install().withdraw()
  expect(a.install().withdraw()).toBe(first)
  await first
  expect(f.coordinator.snapshot().accounts).toBe(1)
})

it('retains real startup migration failure evidence instead of making withdrawal or root release succeed', async () => {
  const f = fixture()
  const a = f.account('A', { flat: true })
  const original = vi.mocked(fs.rename).getMockImplementation()!
  const failure = Object.assign(new Error('fixture migration storage failure'), { code: 'EIO' })
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (to === a.credentialPath) throw failure
    await original(from, to)
  })
  await Promise.allSettled([a.start()])
  await vi.waitFor(() => { expect(a.barrier().snapshot().failures).toHaveLength(1) })
  expect(a.barrier().snapshot()).toMatchObject({ pending: [], failures: [{ kind: 'credentials', outcome: 'failed' }] })
  expect(await a.install().stopConfigSaves(Date.now() + 1_000)).toMatchObject({ status: 'unknown', reason: 'failed' })
  await expect(a.install().withdraw()).rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(() => { f.coordinator.releaseAccount(a.barrier()) }).toThrow()
  expect(readFileSync(a.credentialPath, 'utf8')).not.toContain('version: 1')
})

it('retains hooks through native initialization reads even before the first save has been submitted', async () => {
  const f = fixture()
  const a = f.account('A', { flat: true })
  const read = f.holdInitialRead(a.credentialPath)
  const booting = a.start()
  await read.entered
  expect(a.barrier().snapshot().pending).toEqual([])
  expect(await a.install().stopConfigSaves(Date.now() + 1_000)).toMatchObject({ status: 'confirmed' })
  let withdrawn = false
  const withdrawal = a.install().withdraw()
  void withdrawal.then(() => { withdrawn = true }, () => { withdrawn = true })
  await Promise.resolve()
  expect(withdrawn).toBe(false)
  read.release()
  await Promise.allSettled([booting])
  await withdrawal
  expect(readFileSync(a.credentialPath, 'utf8')).not.toContain('version: 1')
  expect(vi.mocked(fs.rename).mock.calls.some(call => call[1] === a.credentialPath)).toBe(false)
  expect(a.barrier().snapshot()).toMatchObject({ admission: 'stopped', pending: [], failures: [] })
  expect(f.coordinator.snapshot().accounts).toBe(1)
})

it('binds terminal withdrawal to this installation and refuses construction in another graph or after withdrawal', async () => {
  const f = fixture()
  const a = f.account('A')
  const b = f.account('B')
  const ctxA = await a.start()
  const ctxB = await b.start()
  expect(() => new (a.install().credentials)(ctxB, { path: b.credentialPath, watch: false })).toThrow()
  expect(() => new (a.install().configEditor)(ctxB)).toThrow()
  expect(() => new (a.install().configEditor)(ctxA)).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
  expect(await a.install().stopConfigSaves(Date.now() + 1_000)).toMatchObject({ status: 'confirmed' })
  await a.install().withdraw()
  expect(() => new (a.install().configEditor)(ctxA)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  await ctxB.credentials.set(REF, 'B-still-works')
  expect(await ctxB.credentials.resolve(REF)).toEqual({ value: 'B-still-works', source: 'file' })
})

it('requires the exact installed barrier binding even when another object has identical fields', () => {
  const ctx = new Context()
  const coordinator = new ConfigSaveCoordinator({
    maxAccounts: 1, maxRunning: 1, maxQueued: 1, maxQueuedPerAccount: 1,
    maxTrackedOperations: 2, maxTrackedOperationsPerAccount: 2, maxNestedPerOperation: 1, maxWaitersPerAccount: 1,
  })
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountId>('A'), epoch: brandString<OwnerEpoch>('1'), recipeVersion: 'install-binding',
    lifetime: new AbortController().signal,
  })
  ctx.provide('peAccount', binding)
  const saves = coordinator.createAccount({ ...binding })
  const maximum = new ExposurePolicy({
    recipeVersion: binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [],
  })
  expect(() => prepareAccountApiInstall(ctx, binding, () => {}, maximum, maximum.manifest, saves))
    .toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  onTestFinished(async () => {
    await saves.stopConfigSaves(Date.now() + 1_000)
    coordinator.releaseAccount(saves)
    coordinator.close()
    await ctx.fiber.dispose()
  })
})
