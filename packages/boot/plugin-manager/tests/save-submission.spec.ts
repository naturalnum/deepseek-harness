/** Native management saves under the real profile lock and Loader application. */
import * as fs from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfileManifest, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import PluginManager from '../src/index.ts'
import type { ChangeResult, PluginInstallRequestId, PluginSaveOperation, PluginSaveSubmissionHook } from '../src/index.ts'
import * as operations from '../src/operations.ts'
import * as githubConnection from '../src/github-connection.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

beforeEach(async () => {
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(real.rename)
})
afterEach(() => { vi.restoreAllMocks() })

async function fixture(live = true, overlay = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'manager-save-')))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  const installAnchor = join(home, 'package.json')
  writeFileSync(installAnchor, '{"name":"installation","dependencies":{}}\n')
  initProfile(dir, ['core', 'extra'])
  const bundle = (name: string, rows: object[]) => {
    const path = join(dir, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(path, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
    writeFileSync(join(path, 'probe.mjs'), 'export function apply() {}\n')
  }
  bundle('core', [{ id: 'manager', name: 'cordis:manager' }])
  bundle('extra', [{ id: 'managed', name: './probe.mjs' }])
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { extra: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor, cwd: home, home,
    startedBundles: ['core', 'extra'], overlays: overlay ? [{ id: 'managed', disabled: true }] : [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (scope) => {
    owner = scope
    scope.provide('profileContext', profile)
    scope.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    scope.loader.builtins.manager = PluginManager
  })
  if (live) {
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
  }
  vi.spyOn(operations, 'readProfileRegistry').mockResolvedValue('https://registry.npmjs.org/')
  vi.spyOn(githubConnection, 'checkGithubConnection').mockResolvedValue(undefined)
  // All package commands are fixtures: these tests never start pnpm or a network lookup.
  const run = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(() => {
    throw new Error('unexpected package command')
  })
  const managed = (await ctx.pluginManager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  return { ctx, manager: ctx.pluginManager, dir, profile, managed, bundle, run }
}

function observer() {
  const pending = new Set<Promise<ChangeResult>>()
  const submitted: Promise<ChangeResult>[] = []
  const operations: PluginSaveOperation[] = []
  const results: ChangeResult[] = []
  const unsuccessful: ChangeResult[] = []
  const rejections: unknown[] = []
  const denied = new Error('plugin save admission closed')
  let accepting = true
  const hook: PluginSaveSubmissionHook = {
    submit(operation, submit) {
      if (!accepting) throw denied
      const task = submit()
      operations.push(operation)
      submitted.push(task)
      pending.add(task)
      void task.then((result) => {
        pending.delete(task)
        results.push(result)
        if (result.application === 'failed' || result.application === 'cancelled') unsuccessful.push(result)
      }, (error: unknown) => {
        pending.delete(task)
        rejections.push(error)
      })
      return task
    },
  }
  return { hook, pending, submitted, operations, results, unsuccessful, rejections, denied, stop: () => { accepting = false } }
}

it('admits lock-waiting saves once and observes actual patch/manifest replacement and application', async () => {
  const { manager, managed, dir } = await fixture()
  const tracked = observer()
  const dispose = manager.registerSaveHook(tracked.hook)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const real = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    entered.resolve(undefined)
    await release.promise
    await real.rename(from, to)
  })
  const before = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  const first = manager.setPluginEnabled(managed, false)
  const second = manager.setBundleEnabled('extra', false)
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([first, second])
    await dispose()
  })
  expect(tracked.pending.size).toBe(2)
  expect(tracked.operations).toEqual([{ stage: 'enable', reason: 'plugin' }, { stage: 'enable', reason: 'bundle' }])
  await entered.promise
  expect(fs.rename).toHaveBeenCalledOnce()
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(before)
  tracked.stop()
  await expect(manager.setPluginEnabled(managed, true)).rejects.toBe(tracked.denied)
  release.resolve(undefined)
  const results = await Promise.all([first, second])
  expect(results.map(result => result.application)).toEqual(['applied', 'applied'])
  expect(tracked.results).toEqual(results)
  expect(tracked.pending.size).toBe(0)
  expect(tracked.operations).toHaveLength(2)
  expect((await manager.listBundles()).find(row => row.name === 'extra')!.enabled).toBe(false)
})

it('denies every management writer before lock entry, configuration or package execution', async () => {
  const { manager, managed, dir, run } = await fixture()
  const tracked = observer()
  onTestFinished(manager.registerSaveHook(tracked.hook))
  tracked.stop()
  const files = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']
  const before = files.map(name => readFileSync(join(dir, name), 'utf8'))
  const tasks = [
    manager.setPluginEnabled(managed, false), manager.setBundleEnabled('extra', false),
    manager.setVersionExemption('extra@1.0.0', '0.2.1-rc.2', false),
    manager.installBundle('fixture-only'), manager.removeBundle('extra'),
  ]
  await Promise.all(tasks.map(task => expect(task).rejects.toBe(tracked.denied)))
  expect(files.map(name => readFileSync(join(dir, name), 'utf8'))).toEqual(before)
  expect(fs.rename).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(tracked.submitted).toEqual([])
})

it('retains a fulfilled failed result as unsuccessful and preserves the original result object', async () => {
  const { manager, managed } = await fixture()
  const tracked = observer()
  onTestFinished(manager.registerSaveHook(tracked.hook))
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('patch unavailable'), { code: 'EIO' }))
  const failed = await manager.setPluginEnabled(managed, false)
  expect(failed).toMatchObject({ application: 'failed', changed: false })
  expect(tracked.unsuccessful).toEqual([failed])
  expect(await tracked.submitted[0]).toBe(failed)
  const next = await manager.setPluginEnabled(managed, false)
  expect(next.application).toBe('applied')
  expect(tracked.results).toEqual([failed, next])
  expect(tracked.rejections).toEqual([])
})

it('observes cancellation through file restoration without rejecting the native ChangeResult', async () => {
  const { manager, dir, run } = await fixture()
  const tracked = observer()
  const dispose = manager.registerSaveHook(tracked.hook)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  run.mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, partial: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    entered.resolve(undefined)
    await release.promise
    return { exitCode: 1, output: 'fixture cancelled', truncated: false, logPath: join(dir, 'fixture.log') }
  })
  const requestId = '5be0c020-61b7-4121-93d6-19cc487e6858' as PluginInstallRequestId
  const saving = manager.installBundle('fixture-only', { requestId })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([saving]); await dispose() })
  await entered.promise
  const cancelling = manager.cancelInstall(requestId)
  expect(tracked.pending.size).toBe(1)
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).not.toBe(before)
  release.resolve(undefined)
  expect(await cancelling).toEqual({ status: 'cancelled' })
  const result = await saving
  expect(result).toMatchObject({ application: 'cancelled', changed: false })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  expect(tracked.unsuccessful).toEqual([result])
  expect(await tracked.submitted[0]).toBe(result)
  expect(tracked.pending.size).toBe(0)
  expect(tracked.rejections).toEqual([])
})

it('includes installation and removal under one admission each while retaining requested stage metadata', async () => {
  const { manager, dir, run, bundle } = await fixture()
  const tracked = observer()
  onTestFinished(manager.registerSaveHook(tracked.hook))
  run.mockImplementation((_profile, args) => {
    const manifest = readProfileManifest('test', dir)
    if (args[0] === 'add') {
      bundle('added', [{ id: 'added-probe', name: './probe.mjs' }])
      manifest.dependencies = { ...manifest.dependencies, added: '1.0.0' }
    } else {
      delete manifest.dependencies?.added
      rmSync(join(dir, 'node_modules', 'added'), { recursive: true, force: true })
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return Promise.resolve({ exitCode: 0, output: '', truncated: false, logPath: join(dir, 'fixture.log') })
  })
  const installed = await manager.installBundle('added')
  expect(installed).toMatchObject({ application: 'applied', stage: 'enable', bundle: 'added' })
  const removed = await manager.removeBundle('added')
  expect(removed.application).toBe('applied')
  expect(tracked.operations).toEqual([{ stage: 'install', reason: 'install' }, { stage: 'remove', reason: 'remove' }])
  expect(tracked.results).toEqual([installed, removed])
  expect(run).toHaveBeenCalledTimes(2)
})

it('preserves restart-required and overridden outcomes instead of flattening them to applied', async () => {
  const startup = await fixture(false)
  const first = observer()
  onTestFinished(startup.manager.registerSaveHook(first.hook))
  expect(await startup.manager.setPluginEnabled(startup.managed, false)).toMatchObject({
    application: 'restart-required', restartReason: 'no-hmr',
  })
  const live = await fixture(true, true)
  const second = observer()
  onTestFinished(live.manager.registerSaveHook(second.hook))
  expect(await live.manager.setPluginEnabled(live.managed, true)).toMatchObject({ application: 'overridden' })
  expect(first.results[0]!.application).toBe('restart-required')
  expect(second.results[0]!.application).toBe('overridden')
})

it('retains required application failure after the patch is committed', async () => {
  const { manager, managed, ctx, dir } = await fixture()
  const tracked = observer()
  onTestFinished(manager.registerSaveHook(tracked.hook))
  vi.spyOn(ctx.hmr, 'reconcileProfile').mockRejectedValueOnce(new Error('required application failed'))
  const result = await manager.setPluginEnabled(managed, false)
  expect(result).toMatchObject({ application: 'failed', changed: true })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: true')
  expect(tracked.unsuccessful).toEqual([result])
})

it('stays pending after commit until required live application completes', async () => {
  const { manager, managed, ctx, dir } = await fixture()
  const tracked = observer()
  const dispose = manager.registerSaveHook(tracked.hook)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const reconcile = ctx.hmr.reconcileProfile.bind(ctx.hmr)
  vi.spyOn(ctx.hmr, 'reconcileProfile').mockImplementationOnce(async (...args) => {
    const result = await reconcile(...args)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const saving = manager.setPluginEnabled(managed, false)
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([saving]); await dispose() })
  await entered.promise
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: true')
  expect(tracked.pending.size).toBe(1)
  expect(tracked.results).toEqual([])
  release.resolve(undefined)
  expect((await saving).application).toBe('applied')
  expect(tracked.pending.size).toBe(0)
})

it('rejects duplicate registration and removes the hook with its caller', async () => {
  const { ctx, manager, managed } = await fixture()
  const tracked = observer()
  const owner = await ctx.plugin({ inject: ['pluginManager'], apply(scope) {
    scope.pluginManager.registerSaveHook(tracked.hook)
  } })
  expect(() => manager.registerSaveHook(tracked.hook)).toThrow('already registered')
  await manager.setPluginEnabled(managed, false)
  expect(tracked.submitted).toHaveLength(1)
  await owner.dispose()
  await manager.setPluginEnabled(managed, true)
  expect(tracked.submitted).toHaveLength(1)
})
