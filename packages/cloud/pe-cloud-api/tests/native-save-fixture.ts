/** Account-local real native profile and provider; all scratch files remain in this package. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Settings from '@deepseek-ai/dsh-settings'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { ConfigSaveCoordinator } from '../src/config-saves.ts'
import { installNativeConfigSaveHook, installNativeCredentialSaveHook } from '../src/native-save-hook.ts'
import type { ConfigSaveBarrier } from '../src/save-hooks.ts'

export function latch() {
  const state = Promise.withResolvers<undefined>()
  return { promise: state.promise, resolve: () => { state.resolve(undefined) } }
}

export async function nativeSaveFixture(options: {
  install?: boolean
  legacy?: string
  credentialText?: string
  beforeBoot?: (barrier: ConfigSaveBarrier) => void
} = {}) {
  const home = realpathSync(mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'save-m2-')))
  const owner: { ctx?: Context } = {}
  onTestFinished(async () => {
    await owner.ctx?.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'test')
  mkdirSync(dir, { recursive: true })
  initProfile(dir, [])
  writeFileSync(join(home, 'package.json'), '{"name":"cloud-api-expanded-save-test"}\n')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const credentialPath = join(home, '.credentials.yaml')
  writeFileSync(credentialPath, options.credentialText ?? 'version: 1\nrefs:\n  DSH_CLOUD_SAVE_TEST: original\n', { mode: 0o600 })
  if (options.legacy !== undefined) writeFileSync(join(home, 'settings.yaml'), options.legacy)
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, JSON.stringify([{ insert: [
    { id: 'editor', name: 'cordis:save-editor' },
    { id: 'settings', name: 'cordis:save-settings' },
    { id: 'default-model', name: 'cordis:save-model', config: { provider: 'test', model: 'original' } },
    { id: 'probe', name: 'cordis:save-probe', config: { count: 1 } },
    { id: 'credentials', name: 'cordis:save-credentials', config: { path: credentialPath, watch: false } },
  ] }]) + '\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: [], dir, patchPath, installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountId>('a'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'd08-m2', lifetime: lifetime.signal,
  })
  const root = new ConfigSaveCoordinator({
    maxAccounts: 1, maxRunning: 1, maxQueued: 5, maxQueuedPerAccount: 5,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8,
    maxNestedPerOperation: 1, maxWaitersPerAccount: 2,
  })
  const barrier = root.createAccount(binding)
  options.beforeBoot?.(barrier)
  const removers: Array<() => Promise<void>> = []
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    owner.ctx = ctx
    ctx.provide('profileContext', profile)
    ctx.provide('peAccount', binding)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, {
      'save-editor': ConfigEditor, 'save-model': DefaultModel, 'save-settings': Settings,
      'save-credentials': LocalCredentialProvider,
      'save-probe': { Config: z.object({ count: z.number().min(1).volatile() }), apply() {} },
    })
    if (options.install !== false) {
      ctx.inject(['configEditor'], (scope) => { removers.push(installNativeConfigSaveHook(scope, barrier)) })
      ctx.inject(['credentials'], (scope) => { removers.push(installNativeCredentialSaveHook(scope, barrier)) })
    }
  })
  const install = (): void => {
    removers.push(installNativeConfigSaveHook(ctx, barrier), installNativeCredentialSaveHook(ctx, barrier))
  }
  const remove = async (): Promise<void> => { for (const dispose of removers) await dispose() }
  const release = async (): Promise<void> => {
    await barrier.stopConfigSaves(Date.now() + 1_000)
    await remove()
    root.releaseAccount(barrier)
    root.close()
  }
  return { ctx, home, profile, credentialPath, lifetime, binding, root, barrier, install, remove, release }
}
