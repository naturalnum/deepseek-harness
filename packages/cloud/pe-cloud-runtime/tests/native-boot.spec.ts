/** Independent native Profile assembly and teardown; no product files/execution/save capability is faked. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import Settings from '@deepseek-ai/dsh-settings'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { ConfigSaveCoordinator, type ConfigSaveBarrier } from '@deepseek-ai/dsh-pe-cloud-api'
import * as AccountEntry from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { startNativeAccountBoot, type NativeAccountBootHandle, type NativeAccountBootInput } from '../src/native-boot.ts'
import type { AccountId, OwnerEpoch } from '../src/types.ts'
import NativeAccountProbe from './fixtures/native-probe.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { generationLogPath } from '../../../session/session-persistence-jsonl/src/format.ts'

const preparationFault = vi.hoisted(() => ({ path: '', readEntered: undefined as (() => void) | undefined,
  readRelease: undefined as Promise<unknown> | undefined, closeEntered: undefined as (() => void) | undefined,
  closeRelease: undefined as Promise<unknown> | undefined, closeFailure: undefined as Error | undefined }))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, open: (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (args[0] !== preparationFault.path || args[1] !== 'r') return handle
    let body = false
    return new Proxy(handle, { get(target, property) {
      if (property === 'readFile') return async (...readArgs: Parameters<typeof target.readFile>) => {
        body = true; preparationFault.readEntered?.(); await preparationFault.readRelease
        return target.readFile(...readArgs)
      }
      if (property === 'close') return async () => {
        if (body) { preparationFault.closeEntered?.(); await preparationFault.closeRelease }
        await target.close()
        if (body && preparationFault.closeFailure !== undefined) throw preparationFault.closeFailure
      }
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const bound: unknown = value.bind(target)
      return bound
    } })
  }) }
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Actual API save barrier prepared from the installed binding in this mechanism fixture. */
    nativeSaveBudgetProbe: ConfigSaveBarrier
  }
}

const handles: NativeAccountBootHandle[] = []
const directories: string[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(label: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pe-native-profile-')))
  directories.push(directory)
  const home = join(directory, 'private')
  const cwd = join(directory, 'project')
  const dir = join(home, 'profiles', label)
  mkdirSync(cwd, { recursive: true })
  initProfile(dir, [])
  writeFileSync(join(directory, 'package.json'), '{"name":"native-mechanism-fixture","private":true}\n')
  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, '[]\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'account', name: 'cordis:runtime-account' },
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'probe', name: 'cordis:probe', config: { ordinary: label, count: 1 } },
  ] }]) + '\n')
  const profile: ProfileContext = {
    name: label, dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(directory, 'package.json'),
    cwd, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  const values = { HOME: home, PE_M2_ACCOUNT_MARKER: label }
  const controller = new AbortController()
  const input: NativeAccountBootInput = {
    binding: { accountId: brandString<AccountId>(label), epoch: brandString<OwnerEpoch>('9007199254740993'), recipeVersion: 'm2-mechanism', lifetime: controller.signal },
    profile, configPath, bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values }]),
    requiredEntryIds: ['include', 'account', 'config-editor', 'settings', 'probe'], maxObservedEvents: 8,
    prepare(ctx) {
      Object.assign(ctx.loader.builtins, { 'runtime-account': AccountEntry, editor: ConfigEditor, settings: Settings, probe: NativeAccountProbe })
    },
  }
  const start = (overrides: Partial<NativeAccountBootInput> = {}): NativeAccountBootHandle => {
    const handle = startNativeAccountBoot({ ...input, ...overrides })
    handles.push(handle)
    return handle
  }
  return { input, profile, controller, values, start }
}

async function mounted(handle: NativeAccountBootHandle): Promise<Context> {
  const outcome = await handle.result
  if (outcome.status === 'failed') throw outcome.cause
  return outcome.context
}

function entry(ctx: Context, id: string) {
  const result = [...ctx.loader.entries()].find(row => row.options.id === id)
  if (result === undefined) throw new Error('Native mechanism entry is missing')
  return result
}

describe('private native account assembly', () => {
  it('keeps detached JSONL preparation owned through native disposal and reports a late close failure', async () => {
    const f = fixture('jsonl-preparation'), read = Promise.withResolvers<undefined>(), releaseRead = Promise.withResolvers<undefined>()
    const close = Promise.withResolvers<undefined>(), releaseClose = Promise.withResolvers<undefined>()
    const root = join(f.profile.home, 'sessions'), id = SessionId('native-historical')
    const path = generationLogPath(root, f.profile.cwd, id, 0, 'none')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ type: 'session', id, version: 0, createdAt: 1, cwd: f.profile.cwd, delegationDepth: 0 }) + '\n')
    const failure = new Error('late native JSONL close failed')
    preparationFault.path = path; preparationFault.readEntered = () => { read.resolve(undefined) }
    preparationFault.readRelease = releaseRead.promise; preparationFault.closeEntered = () => { close.resolve(undefined) }
    preparationFault.closeRelease = releaseClose.promise; preparationFault.closeFailure = failure
    const handle = f.start({ prepare: async (ctx, binding) => {
      await f.input.prepare(ctx, binding)
      await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    } })
    try {
      const ctx = await mounted(handle), persistence = ctx.sessionPersistence, abort = new AbortController()
      const reason = new Error('caller cancelled'), opening = persistence.open(id, 'read', { signal: abort.signal })
      void opening.catch(() => {})
      await read.promise
      abort.abort(reason); await expect(opening).rejects.toBe(reason)
      expect(persistence.isQuiescent(8)).toBe(false)
      releaseRead.resolve(undefined); await close.promise
      let settled = false
      const disposal = handle.dispose().then((result) => { settled = true; return result })
      await Promise.resolve(); expect(settled).toBe(false)
      releaseClose.resolve(undefined)
      await expect(disposal).resolves.toMatchObject({ status: 'unknown', errorEvents: expect.any(Number) as unknown, overflow: false })
      expect(persistence.isQuiescent(8)).toBe(false)
    } finally {
      releaseRead.resolve(undefined); releaseClose.resolve(undefined)
      preparationFault.path = ''; preparationFault.readEntered = undefined; preparationFault.readRelease = undefined
      preparationFault.closeEntered = undefined; preparationFault.closeRelease = undefined; preparationFault.closeFailure = undefined
    }
  })
  it('checks original before-read admission before parsing a private Profile patch', () => {
    const f = fixture('pre-read'), denied = new Error('Actual before-read admission refused')
    writeFileSync(f.profile.patchPath, '[unterminated')
    expect(() => f.start({ assertBeforeNativeRead: () => { throw denied } })).toThrow(denied)
    // The same actual reader fails parsing when the mechanism-only caller omits admission.
    expect(() => f.start()).toThrow()
    expect(handles).toHaveLength(0)
  })

  it('rejects excessive required entries before boot and bounds actual native entry collection', async () => {
    const f = fixture('entry-limit')
    expect(() => f.start({ maxEntries: f.input.requiredEntryIds.length - 1 }))
      .toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
    const rows: unknown = JSON.parse(readFileSync(f.profile.patchPath, 'utf8'))
    if (!Array.isArray(rows)) throw new Error('Native fixture patch array absent')
    const patches: readonly unknown[] = rows
    writeFileSync(f.profile.patchPath, JSON.stringify([...patches, { insert: [{ id: 'extra', name: 'cordis:extra' }] }]))
    const handle = f.start({ maxEntries: f.input.requiredEntryIds.length, async prepare(ctx, binding) {
      await f.input.prepare(ctx, binding)
      ctx.loader.builtins.extra = { apply() {} }
    } })
    const outcome = await handle.result
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') throw new Error('Oversized native graph was accepted')
    expect(outcome.cause).toMatchObject({ code: 'cloud/account-unavailable', message: 'Native entries exceed the explicit inventory limit' })
    expect(outcome.disposal.status).toBe('confirmed')
  })

  it('boots two real Profiles in one PID with independent paths, environment, bindings and one root Include', async () => {
    const cwd = process.cwd()
    const environment = { ...process.env }
    const signals = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const
    const counts = signals.map(signal => process.listenerCount(signal))
    const a = fixture('a')
    const b = fixture('b')
    const handleA = a.start()
    const handleB = b.start()
    const [ctxA, ctxB] = await Promise.all([mounted(handleA), mounted(handleB)])
    expect(ctxA.root).toBe(ctxA)
    expect(ctxB.root).toBe(ctxB)
    expect(ctxA.root).not.toBe(ctxB.root)
    expect(ctxA.fiber).not.toBe(ctxB.fiber)
    expect(ctxA.nativeAccountProbe.pid).toBe(process.pid)
    expect(ctxB.nativeAccountProbe.pid).toBe(process.pid)
    for (const [ctx, f] of [[ctxA, a], [ctxB, b]] as const) {
      expect([...ctx.loader.entries()].filter(row => row.options.id === 'include')).toHaveLength(1)
      expect(ctx.get('hmr')).toBeUndefined()
      expect(ctx.configEditor.documentPath).toBe(f.profile.patchPath)
      expect(ctx.nativeAccountProbe.profile).toEqual(f.profile)
      expect(ctx.nativeAccountProbe.binding).toBe(ctx.peAccount)
      expect(Object.isFrozen(ctx.peAccount)).toBe(true)
      expect(ctx.nativeAccountProbe.environment.get('HOME')?.value).toBe(f.profile.home)
      expect(ctx.nativeAccountProbe.environment).toBe(f.input.environment)
      expect(ctx.nativeAccountProbe.environment.get('PE_M2_ACCOUNT_MARKER')?.value).toBe(f.profile.name)
      expect(ctx.get('dshHomePath')).toBeTypeOf('function')
    }
    a.values.PE_M2_ACCOUNT_MARKER = 'later-change'
    expect(ctxA.nativeAccountProbe.environment.get('PE_M2_ACCOUNT_MARKER')?.value).toBe('a')
    expect(process.cwd()).toBe(cwd)
    expect(process.env).toEqual(environment)
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(counts)
    for (const [handle, ctx] of [[handleA, ctxA], [handleB, ctxB]] as const) {
      await expect(handle.dispose()).resolves.toMatchObject({ status: 'confirmed' })
      expect(ctx.get('loader')).toBeUndefined()
      expect(ctx.get('peAccount')).toBeUndefined()
      expect(ctx.fiber.getEffects()).toEqual([])
      // Cordis retains its built-in buffer exporter outside the root disposable list.
      expect(ctx.logger.exporters.size).toBe(1)
    }
  })

  it('applies Settings and ordinary ConfigEditor changes only to A without changing B roots, fibers, paths or module resolver', async () => {
    const cwd = process.cwd()
    const environment = { ...process.env }
    const a = fixture('a')
    const b = fixture('b')
    const handleA = a.start()
    const [ctxA, ctxB] = await Promise.all([mounted(handleA), mounted(b.start())])
    const rootA = ctxA.fiber
    const originalA = ctxA.nativeAccountProbe
    const originalFiberA = entry(ctxA, 'probe').fiber
    const editorFiberA = entry(ctxA, 'config-editor').fiber
    const settingsFiberA = entry(ctxA, 'settings').fiber
    const beforeB = [...ctxB.loader.entries()].map((row) => {
      const config: unknown = row.options.config
      return { row, fiber: row.fiber, config }
    })
    const resolverB = ctxB.loader.internal
    const patchB = readFileSync(b.profile.patchPath, 'utf8')
    await ctxA.settings.update('probe', { count: 2 })
    expect(entry(ctxA, 'probe').fiber === originalFiberA).toBe(true)
    expect(originalA.closed).toBe(false)
    expect(ctxA.settings.describe().find(row => row.ns === 'probe')?.value).toEqual({ count: 2 })
    await ctxA.configEditor.edit(entry(ctxA, 'probe'), current => ({ ...current, ordinary: 'a-changed' }))
    expect(originalA.closed).toBe(true)
    expect(ctxA.nativeAccountProbe.config.ordinary).toBe('a-changed')
    expect(ctxA.fiber === rootA).toBe(true)
    expect(entry(ctxA, 'config-editor').fiber === editorFiberA).toBe(true)
    expect(entry(ctxA, 'settings').fiber === settingsFiberA).toBe(true)
    expect(readFileSync(a.profile.patchPath, 'utf8')).toContain('a-changed')
    expect(ctxB.nativeAccountProbe.config.ordinary).toBe('b')
    expect(ctxB.settings.describe().find(row => row.ns === 'probe')?.value).toEqual({ count: 1 })
    expect(readFileSync(b.profile.patchPath, 'utf8')).toBe(patchB)
    expect(ctxB.loader.internal === resolverB).toBe(true)
    for (const prior of beforeB) {
      expect(entry(ctxB, prior.row.options.id) === prior.row).toBe(true)
      expect(prior.row.fiber === prior.fiber).toBe(true)
      expect(prior.row.options.config === prior.config).toBe(true)
    }
    const probeA = ctxA.nativeAccountProbe
    const probeFiber = entry(ctxA, 'probe').fiber
    await expect(handleA.dispose()).resolves.toEqual({ status: 'confirmed', errorEvents: 0, warningEvents: 0, overflow: false })
    expect(probeA.closed).toBe(true)
    expect(probeFiber?.state).toBe(FiberState.DISPOSED)
    expect(ctxA.get('loader')).toBeUndefined()
    expect(ctxA.fiber.getEffects()).toEqual([])
    expect(ctxB.nativeAccountProbe.closed).toBe(false)
    await ctxB.settings.update('probe', { count: 3 })
    expect(process.cwd()).toBe(cwd)
    expect(process.env).toEqual(environment)
  })

  it('retains disposal observation through an asynchronous throwing disposer and leaves B usable', async () => {
    const a = fixture('a')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const handle = a.start({ prepare: async (ctx, binding) => {
      await a.input.prepare(ctx, binding)
      ctx.effect(() => async () => { entered.resolve(undefined); await release.promise; throw new Error('native mechanism disposal failure') })
    } })
    const [ctxA, ctxB] = await Promise.all([mounted(handle), mounted(fixture('b').start())])
    const disposal = handle.dispose()
    expect(handle.dispose()).toBe(disposal)
    let settled = false
    void disposal.then(() => { settled = true })
    try {
      await entered.promise
      expect(settled).toBe(false)
      await ctxB.settings.update('probe', { count: 4 })
    } finally { release.resolve(undefined) }
    await expect(disposal).resolves.toMatchObject({ status: 'unknown', errorEvents: 1, overflow: false })
    expect(ctxA.get('loader')).toBeUndefined()
    expect(ctxA.fiber.getEffects()).toEqual([])
    expect(ctxB.nativeAccountProbe.closed).toBe(false)
  })

  it('builds the real API save budget from the one installed binding before injecting it', async () => {
    const f = fixture('binding-identity')
    const coordinator = new ConfigSaveCoordinator({
      maxAccounts: 1, maxRunning: 1, maxQueued: 1, maxQueuedPerAccount: 1,
      maxTrackedOperations: 2, maxTrackedOperationsPerAccount: 2, maxNestedPerOperation: 1, maxWaitersPerAccount: 1,
    })
    const prepared = Promise.withResolvers<ConfigSaveBarrier>()
    const handle = f.start({ prepare: async (ctx, binding) => {
      await f.input.prepare(ctx, binding)
      const barrier = coordinator.createAccount(binding)
      ctx.provide('nativeSaveBudgetProbe', barrier)
      prepared.resolve(barrier)
    } })
    const ctx = await mounted(handle)
    const barrier = await prepared.promise
    try {
      expect(barrier === ctx.nativeSaveBudgetProbe).toBe(true)
      expect(barrier.binding === ctx.peAccount).toBe(true)
      expect(barrier.binding === ctx.nativeAccountProbe.binding).toBe(true)
      expect(barrier.binding === f.input.binding).toBe(false)
      expect(barrier.binding.lifetime === f.controller.signal).toBe(true)
      await expect(barrier.admit('default-model', () => Promise.resolve('observed'))).resolves.toBe('observed')
      expect(coordinator.snapshot()).toEqual({ accounts: 1, running: 0, queued: 0, tracked: 0 })
    } finally {
      await barrier.stopConfigSaves(Date.now() + 1000)
      coordinator.releaseAccount(barrier)
      await handle.dispose()
      coordinator.close()
    }
  })

  it.each(['missing', 'disabled'])('rejects a %s required entry and disposes partial native assembly', async (kind) => {
    const f = fixture(kind)
    if (kind === 'disabled') {
      writeFileSync(f.profile.patchPath, readFileSync(f.profile.patchPath, 'utf8').replace('"id":"probe",', '"id":"probe","disabled":true,'))
    }
    let context: Context | undefined
    const handle = f.start({ requiredEntryIds: kind === 'missing' ? [...f.input.requiredEntryIds, 'absent'] : f.input.requiredEntryIds,
      prepare: async (ctx, binding) => { context = ctx; await f.input.prepare(ctx, binding) } })
    await expect(handle.result).resolves.toMatchObject({ status: 'failed', cause: { code: 'cloud/account-unavailable' } })
    expect(context?.get('loader')).toBeUndefined()
    expect(context?.fiber.getEffects()).toEqual([])
  })

  it('observes cleanup failure even when native boot rejects during prepare', async () => {
    const f = fixture('failure')
    const handle = f.start({ prepare(ctx) {
      ctx.effect(() => () => { throw new Error('cleanup failed after partial prepare') })
      throw new Error('prepare failed')
    } })
    await expect(handle.result).resolves.toMatchObject({ status: 'failed', disposal: { status: 'unknown', errorEvents: 1 } })
  })

  it('rejects a failed required plugin inside the actual Include tree and removes its successful siblings', async () => {
    const f = fixture('bad-plugin')
    writeFileSync(f.profile.patchPath, readFileSync(f.profile.patchPath, 'utf8').replace('"count":1', '"count":"invalid"'))
    let context: Context | undefined
    const handle = f.start({ prepare: async (ctx, binding) => { context = ctx; await f.input.prepare(ctx, binding) } })
    await expect(handle.result).resolves.toMatchObject({ status: 'failed', disposal: { status: 'unknown', errorEvents: 1 } })
    expect(context?.get('settings')).toBeUndefined()
    expect(context?.get('configEditor')).toBeUndefined()
    expect(context?.get('loader')).toBeUndefined()
    expect(context?.fiber.getEffects()).toEqual([])
    expect(context?.logger.exporters.size).toBe(1)
  })

  it('bounds diagnostic counters and treats overflow as unknown instead of forgetting errors', async () => {
    const f = fixture('bounded')
    const handle = f.start({ maxObservedEvents: 2, prepare: async (ctx, binding) => {
      await f.input.prepare(ctx, binding)
      ctx.effect(() => () => { for (let index = 0; index < 4; index++) ctx.logger.error(new Error('bounded disposal observation')) })
    } })
    await mounted(handle)
    await expect(handle.dispose()).resolves.toEqual({ status: 'unknown', errorEvents: 2, warningEvents: 0, overflow: true })
  })

  it('honors a close request made before prepare and retains the failed startup settlement', async () => {
    const handle = fixture('closed').start()
    const disposal = handle.dispose()
    await expect(handle.result).resolves.toMatchObject({ status: 'failed' })
    await expect(disposal).resolves.toMatchObject({ status: 'confirmed' })
  })

  it.each(['abort', 'dispose'])('starts no Include entry or writer after %s during delayed preparation', async (action) => {
    const f = fixture(`delayed-${action}`)
    const marker = join(f.profile.home, 'writer-started')
    writeFileSync(f.profile.patchPath, readFileSync(f.profile.patchPath, 'utf8').replace('"insert":[', '"insert":[{"id":"cancellation-writer","name":"cordis:cancellation-writer"},'))
    const entered = Promise.withResolvers<Context>()
    const resume = Promise.withResolvers<undefined>()
    const cleanupEntered = Promise.withResolvers<undefined>()
    const finishCleanup = Promise.withResolvers<undefined>()
    const observer = new Context()
    let entryStarts = 0
    let writerStarts = 0
    let cleanups = 0
    const handle = f.start({ prepare: async (ctx, binding) => {
      await f.input.prepare(ctx, binding)
      // The external observer survives an early account dispose, so zero entries is observable.
      observer.events = ctx.events
      observer.on('loader/entry-init', () => { entryStarts++ }, { global: true })
      ctx.loader.builtins['cancellation-writer'] = {
        name: 'cancellation-writer', inject: [], Config: AccountEntry.Config,
        apply() { writerStarts++; writeFileSync(marker, 'stale writer started\n') },
      }
      ctx.effect(() => async () => {
        cleanupEntered.resolve(undefined)
        await finishCleanup.promise
        cleanups++
      })
      entered.resolve(ctx)
      await resume.promise
    } })
    const context = await entered.promise
    let resultSettled = false
    void handle.result.then(() => { resultSettled = true })
    try {
      if (action === 'abort') f.controller.abort()
      else void handle.dispose()
      resume.resolve(undefined)
      await cleanupEntered.promise
      const disposal = handle.dispose()
      expect(handle.dispose() === disposal).toBe(true)
      const observed = await Promise.race([
        disposal.then(() => 'disposed'),
        new Promise<string>(resolve => setTimeout(() => { resolve('deadline') }, 0)),
      ])
      expect(observed).toBe('deadline')
      expect(handle.dispose() === disposal).toBe(true)
      expect(resultSettled).toBe(false)
      expect(cleanups).toBe(0)
      expect.soft(entryStarts).toBe(0)
      expect.soft(writerStarts).toBe(0)
      expect.soft(existsSync(marker)).toBe(false)
    } finally {
      resume.resolve(undefined)
      finishCleanup.resolve(undefined)
      await handle.dispose()
      await observer.fiber.dispose()
    }
    await expect(handle.result).resolves.toMatchObject({ status: 'failed', cause: { cause: { code: 'cloud/account-unavailable' } } })
    expect(cleanups).toBe(1)
    expect(context.get('loader')).toBeUndefined()
    expect(context.fiber.getEffects()).toEqual([])
    expect(entryStarts).toBe(0)
    expect(writerStarts).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  it('retains pending preparation and observes late cleanup after a close request', async () => {
    const f = fixture('pending-prepare')
    const entered = Promise.withResolvers<Context>()
    const initiallyDisposed = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const handle = f.start({ prepare: async (ctx, binding) => {
      await f.input.prepare(ctx, binding)
      ctx.effect(() => () => { initiallyDisposed.resolve(undefined) })
      entered.resolve(ctx)
      await release.promise
      ctx.effect(() => () => { throw new Error('late preparation cleanup failed') })
    } })
    const context = await entered.promise
    const disposal = handle.dispose()
    let settled = false
    void disposal.then(() => { settled = true })
    try {
      await initiallyDisposed.promise
      await context.fiber.dispose()
      expect(settled).toBe(false)
    } finally { release.resolve(undefined) }
    await expect(handle.result).resolves.toMatchObject({ status: 'failed', disposal: { status: 'unknown', errorEvents: 1 } })
    await expect(disposal).resolves.toMatchObject({ status: 'unknown', errorEvents: 1 })
  })

  it('rejects nonabsolute account paths and an ended generation before starting a native tree', () => {
    const f = fixture('invalid')
    expect(() => f.start({ profile: { ...f.profile, home: 'relative' } })).toThrow('absolute')
    expect(() => f.start({ maxObservedEvents: 0 })).toThrow('positive finite')
    expect(() => f.start({ requiredEntryIds: [] })).toThrow('required entry')
    f.controller.abort()
    expect(() => f.start()).toThrow('ended')
  })
})
