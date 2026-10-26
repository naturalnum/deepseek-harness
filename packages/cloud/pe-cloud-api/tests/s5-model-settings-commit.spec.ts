/** Isolated native save components; synthetic references only, no RPC or model transport is opened. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Settings, { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings/types'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { prepareAccountApiInstall, type AccountApiInstall } from '../src/account-install.ts'
import { ConfigSaveCoordinator, ConfigSaveOutcomeUnknown } from '../src/config-saves.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import type { ConfigSaveBarrier, CredentialEditToken } from '../src/save-hooks.ts'

const REF = credentialRef('S5_SYNTHETIC_REFERENCE')
const OTHER = credentialRef('S5_SECOND_REFERENCE')

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof fs>()
  return { ...native, rename: vi.fn(native.rename) }
})

beforeEach(async () => {
  const native = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(native.rename)
})

async function fixture(names: string[] = ['a'], managed = true) {
  const home = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'scratch-')))
  const saves = new ConfigSaveCoordinator({ maxAccounts: 2, maxRunning: 2, maxQueued: 4, maxQueuedPerAccount: 2,
    maxTrackedOperations: 12, maxTrackedOperationsPerAccount: 6, maxNestedPerOperation: 3, maxWaitersPerAccount: 2 })
  const exposure = new ExposurePolicy({ recipeVersion: 's5-component', rpcEndpoints: [], streamEndpoints: [],
    exactFetchRoutes: [], allowedSettings: [] })
  const rows: Array<{
    ctx: Context
    install: AccountApiInstall
    barrier: ConfigSaveBarrier
    binding: AccountBinding
    lifetime: AbortController
    profile: ProfileContext
    saves: ConfigSaveCoordinator
  }> = []
  onTestFinished(async () => {
    try {
      for (const row of rows) {
        const receipt = await row.barrier.stopConfigSaves(Date.now() + 1_000)
        if (receipt.status === 'confirmed') {
          await row.install.withdraw()
          saves.releaseAccount(row.barrier)
        }
        // Rejected-save cases retain their failed receipt; this only disposes the owned component fixture.
        await row.ctx.fiber.dispose()
      }
      if (saves.snapshot().accounts === 0) saves.close()
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  for (const name of names) {
    const local = join(home, name), dir = join(local, 'profiles', 'test')
    mkdirSync(dir, { recursive: true })
    initProfile(dir, [])
    writeFileSync(join(local, 'package.json'), '{"name":"s5-native-component"}\n')
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const credentialPath = join(local, 'synthetic-credentials.yaml')
    writeFileSync(credentialPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })
    const profile: ProfileContext = { name: 'test', home: local, cwd: local, dir,
      patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(local, 'package.json'),
      startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
    writeFileSync(profile.patchPath, JSON.stringify([{ insert: [
      { id: 'editor', name: 'cordis:s5-editor' },
      { id: 'settings', name: 'cordis:s5-settings' },
      { id: 'model', name: 'cordis:s5-model', config: { provider: 'synthetic', model: 'initial' } },
      { id: 'probe', name: 'cordis:s5-probe', config: { ordinary: 'fixed', count: 1 } },
      { id: 'credentials', name: 'cordis:s5-credentials', config: { path: credentialPath, watch: false } },
    ] }]) + '\n')
    const lifetime = new AbortController()
    const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountId>(name),
      epoch: brandString<OwnerEpoch>('1'), recipeVersion: exposure.manifest.recipeVersion, lifetime: lifetime.signal })
    let installed: { install: AccountApiInstall; barrier: ConfigSaveBarrier } | undefined
    const ctx = await boot('s5-component', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (owner) => {
      owner.provide('profileContext', profile)
      owner.provide('peAccount', binding)
      owner.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
      const original = owner.get('peAccount')!
      const barrier = saves.createAccount(original,
        managed ? { references: [REF, OTHER], maxReferences: 2, maxReferenceBytes: 64 } : undefined)
      const install = prepareAccountApiInstall(owner, original, () => { lifetime.signal.throwIfAborted() },
        exposure, exposure.manifest, barrier)
      installed = { install, barrier }
      Object.assign(owner.loader.builtins, { 's5-editor': install.configEditor, 's5-settings': Settings,
        's5-model': DefaultModel, 's5-credentials': install.credentials,
        's5-probe': { Config: z.object({ ordinary: z.string().required(), count: z.number().volatile() }), apply() {} } })
    })
    if (installed === undefined) throw new Error('Native component preparation did not run')
    rows.push({ ctx, ...installed, binding, lifetime, profile, saves })
  }
  return rows
}

function latch() {
  const signal = Promise.withResolvers<undefined>()
  return { promise: signal.promise, release: () => { signal.resolve(undefined) } }
}

it('compares queued credential versions inside the original owner turn and persists only the first edit', async () => {
  const [row] = await fixture(), account = row!
  const view = await account.install.describeCredentialEdit(REF)
  const entered = latch(), release = latch()
  onTestFinished(release.release)
  const held = account.barrier.admit('settings', async () => { entered.release(); await release.promise })
  await entered.promise
  const submittedVersion = { ...view.version }
  const first = account.install.setCredential(REF, 'synthetic-first', submittedVersion)
  const second = account.install.setCredential(REF, 'synthetic-stale', view.version)
  submittedVersion.editToken = brandString<CredentialEditToken>('caller-mutated-after-queue')
  const joined = Promise.allSettled([first, second])
  expect(account.saves.snapshot()).toMatchObject({ running: 1, queued: 2, tracked: 3 })
  release.release()
  await held
  const [one, two] = await joined
  expect(one.status).toBe('fulfilled')
  expect(two.status === 'rejected' && Reflect.get(two.reason, 'code') === 'cloud/config-conflict').toBe(true)
  expect((await account.ctx.credentials.resolve(REF))?.value === 'synthetic-first').toBe(true)
  const after = await account.install.describeCredentialEdit(REF)
  expect(after.version.editToken).not.toBe(view.version.editToken)
  expect(one.status === 'fulfilled' && one.value.editToken === after.version.editToken).toBe(true)
  expect(account.barrier.snapshot().failures).toHaveLength(0)
  expect(account.saves.snapshot().tracked).toBe(0)
})

it('binds opaque versions to the account, approved reference and original epoch without native writes', async () => {
  const [a, b] = await fixture(['a', 'b']), first = a!, second = b!
  const view = await first.install.describeCredentialEdit(REF)
  const before = readFileSync(second.profile.patchPath, 'utf8')
  await expect(second.install.setCredential(REF, 'synthetic-cross-account', view.version))
    .rejects.toMatchObject({ code: 'cloud/config-conflict' })
  await expect(first.install.setCredential(REF, 'synthetic-old-epoch', {
    ...view.version, epoch: brandString<OwnerEpoch>('0'),
  })).rejects.toMatchObject({ code: 'cloud/stale-generation' })
  await expect(first.install.setCredential(OTHER, 'synthetic-cross-ref', view.version))
    .rejects.toMatchObject({ code: 'cloud/config-conflict' })
  await expect(first.install.describeCredentialEdit(credentialRef('S5_UNREVIEWED')))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(await first.ctx.credentials.resolve(REF)).toBeUndefined()
  expect(await first.ctx.credentials.resolve(OTHER)).toBeUndefined()
  expect(await second.ctx.credentials.resolve(REF)).toBeUndefined()
  expect(readFileSync(second.profile.patchPath, 'utf8')).toBe(before)
  expect(first.barrier.snapshot().failures).toHaveLength(0)
  expect(second.barrier.snapshot().failures).toHaveLength(0)
})

it('rejects original native managed-ref set and unset calls that bypass the checked edit', async () => {
  const [row] = await fixture(), account = row!
  const before = await account.install.describeCredentialEdit(REF)
  await expect(account.ctx.credentials.set(REF, 'synthetic-bypass')).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  await expect(account.ctx.credentials.unset(REF)).rejects.toMatchObject({ code: 'cloud/config-conflict' })
  expect(await account.ctx.credentials.resolve(REF)).toBeUndefined()
  expect((await account.install.describeCredentialEdit(REF)).version).toEqual(before.version)
  expect(account.barrier.snapshot().failures).toHaveLength(0)
})

it('settles the exact native no-write Settings revision conflict and preserves normal following saves', async () => {
  const [row] = await fixture(), account = row!
  const revision = account.ctx.settings.describe().find(value => value.ns === 'model')!.revision
  await account.ctx.settings.update('model', { model: 'next' }, revision)
  const before = readFileSync(account.profile.patchPath, 'utf8')
  await expect(account.ctx.settings.update('model', { model: 'stale' }, revision))
    .rejects.toBeInstanceOf(SettingsConflictError)
  expect(readFileSync(account.profile.patchPath, 'utf8')).toBe(before)
  expect(account.barrier.snapshot().failures).toHaveLength(0)
  const fresh = account.ctx.settings.describe().find(value => value.ns === 'model')!.revision
  await account.ctx.settings.update('model', { model: 'after-conflict' }, fresh)
  expect(account.ctx.agentDefaultModel.currentSelection().model).toBe('after-conflict')
  expect((await account.barrier.stopConfigSaves(Date.now() + 1_000)).status).toBe('confirmed')
})

it('does not suppress a SettingsConflictError thrown by an outer operation after a real successful write', async () => {
  const [row] = await fixture(), account = row!
  await expect(account.barrier.admit('settings', async () => {
    await account.ctx.settings.update('model', { model: 'committed' })
    throw new SettingsConflictError(brandString<SettingsNamespace>('model'), 0, 1)
  })).rejects.toBeInstanceOf(SettingsConflictError)
  expect(account.ctx.agentDefaultModel.currentSelection().model).toBe('committed')
  expect(account.barrier.snapshot().failures).toHaveLength(1)
  expect((await account.barrier.stopConfigSaves(Date.now() + 1_000)).status).toBe('unknown')
})

it('does not call a post-replacement native SettingsConflictError a zero-write conflict', async () => {
  const [row] = await fixture(), account = row!
  const before = readFileSync(account.profile.patchPath, 'utf8')
  const native = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await native.rename(from, to)
    if (to === account.profile.patchPath) throw new SettingsConflictError(brandString<SettingsNamespace>('model'), 0, 1)
  })
  await expect(account.ctx.settings.update('model', { model: 'replaced-before-fault' }))
    .rejects.toBeInstanceOf(ConfigSaveOutcomeUnknown)
  expect(readFileSync(account.profile.patchPath, 'utf8') === before).toBe(false)
  expect(account.barrier.snapshot().failures[0]?.outcome).toBe('unknown')
  expect((await account.barrier.stopConfigSaves(Date.now() + 1_000)).status).toBe('unknown')
})

it('keeps unknown credential writes owned and returns no value, raw provider message or usable new version', async () => {
  const [row] = await fixture(), account = row!
  const view = await account.install.describeCredentialEdit(REF)
  const value = 'synthetic-unknown-canary'
  const error: unknown = await account.barrier.commitCredentialEdit(REF, view.version, async () => {
    await account.ctx.credentials.set(REF, value)
    throw new Error(value)
  }).catch((failure: unknown) => failure)
  expect(error instanceof Error).toBe(true)
  expect(error instanceof Error && error.message.includes(value)).toBe(false)
  expect((await account.ctx.credentials.resolve(REF))?.value === value).toBe(true)
  expect(account.barrier.snapshot().failures[0]?.outcome).toBe('unknown')
  expect(JSON.stringify(account.barrier.snapshot()).includes(value)).toBe(false)
  await expect(account.install.describeCredentialEdit(REF)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect((await account.barrier.stopConfigSaves(Date.now() + 1_000)).status).toBe('unknown')
})

it('waits for an enrolled child before version publication and retains a swallowed child failure', async () => {
  const [row] = await fixture(), account = row!
  const view = await account.install.describeCredentialEdit(REF)
  const entered = latch(), release = latch()
  onTestFinished(release.release)
  const editing = account.barrier.commitCredentialEdit(REF, view.version, async () => {
    await account.ctx.credentials.set(REF, 'synthetic-child-write')
    void account.barrier.admit('config-editor', async () => {
      entered.release()
      await release.promise
      throw new ConfigSaveOutcomeUnknown()
    }).catch((_error: unknown) => {})
  })
  const result = Promise.allSettled([editing])
  await entered.promise
  expect(account.barrier.snapshot().pending).toHaveLength(1)
  release.release()
  expect((await result)[0].status).toBe('rejected')
  expect(account.barrier.snapshot().failures[0]?.outcome).toBe('unknown')
  await expect(account.install.describeCredentialEdit(REF)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
})

it('keeps paused and ended generations zero-submit and permits a live same-epoch edit after resume', async () => {
  const [row] = await fixture(), account = row!
  const view = await account.install.describeCredentialEdit(REF)
  await account.install.pauseAccountChanges(Date.now() + 1_000)
  await expect(account.install.setCredential(REF, 'synthetic-paused', view.version))
    .rejects.toMatchObject({ code: 'cloud/config-busy' })
  expect(await account.ctx.credentials.resolve(REF)).toBeUndefined()
  account.install.resumeAccountChanges()
  const next = await account.install.setCredential(REF, 'synthetic-live', view.version)
  expect(next.epoch).toBe(view.version.epoch)
  account.lifetime.abort()
  await expect(account.install.setCredential(REF, 'synthetic-ended', next))
    .rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect((await account.ctx.credentials.resolve(REF))?.value === 'synthetic-live').toBe(true)
})

it('uses original native unset and returns only redacted metadata; no-policy private writes keep their old behavior', async () => {
  const [row] = await fixture(), account = row!
  const initial = await account.install.describeCredentialEdit(REF)
  const written = await account.install.setCredential(REF, 'synthetic-set', initial.version)
  const described = await account.install.describeCredentialEdit(REF)
  expect(Object.keys(described).sort()).toEqual(['credential', 'version'])
  expect(Object.keys(described.credential).sort()).toEqual(['configured', 'source', 'writable'])
  expect(JSON.stringify(described).includes('synthetic-set')).toBe(false)
  const cleared = await account.install.unsetCredential(REF, written)
  expect(cleared.editToken).not.toBe(written.editToken)
  expect(await account.ctx.credentials.resolve(REF)).toBeUndefined()
  const [legacy] = await fixture(['legacy'], false)
  await legacy!.ctx.credentials.set(REF, 'synthetic-private')
  expect((await legacy!.ctx.credentials.resolve(REF))?.value === 'synthetic-private').toBe(true)
})
