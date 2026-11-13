/** Closed Root log projections with real Logger calls; deployment readiness remains separate. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Exporter } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boot, initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, expect, it, vi } from 'vitest'
import * as Root from '../src/root.ts'
import { startNativeAccountBoot, type NativeAccountBootHandle } from '../src/native-boot.ts'
import { installServiceLogOutput } from '../src/service-log-output.ts'
import type { AccountId, OwnerEpoch } from '../src/types.ts'
import { rootConfig, RootCredentials } from './root-control-fixture.ts'

const PREFIX = 'Cloud service log: '
const FAKE_KEY = 'iter015-fake-api-key-not-a-real-secret'
const SHUTDOWN = 'Runtime root shutdown observation expired; actual work and owner responsibility remain retained'
const DRAIN = 'Actual account drain remains unresolved; original Root control resources and ownership remain retained'
const CONTROL = 'Runtime root control or shutdown is unconfirmed; account ownership was not released and automatic recovery remains closed'
const OBSERVATION = 'Cloud runtime observation is unavailable; business state is unchanged.'
const PEER = 'Cloud login Peer cleanup is unconfirmed: %j'
const READY = 'Cloud runtime observation: %o'
const contexts: Context[] = []

const fixed = [
  [SHUTDOWN, [], SHUTDOWN],
  [DRAIN, [], DRAIN],
  [CONTROL, [], CONTROL],
  [OBSERVATION, [], OBSERVATION],
  ['Approved plugin rebuild %s failed; application is unconfirmed. Reconnect and read current state before another edit.', [FAKE_KEY],
    'Approved plugin rebuild failed; application is unconfirmed. Reconnect and read current state before another edit.'],
  ['Cloud Root recipe audit did not seal; account admission remains closed. Inspect the retained audit.', [],
    'Cloud Root recipe audit did not seal; account admission remains closed. Inspect the retained audit.'],
  ['Runtime root control failed or became uncertain; new account admission is closed and status requires inspection', [],
    'Runtime root control failed or became uncertain; new account admission is closed and status requires inspection'],
  ['Cloud authentication cleanup is unconfirmed; admission remains closed.', [],
    'Cloud authentication cleanup is unconfirmed; admission remains closed.'],
  ['Cloud authentication database failed; admission remains closed.', [],
    'Cloud authentication database failed; admission remains closed.'],
  [PEER, [{ requestId: FAKE_KEY }], 'Cloud login Peer cleanup is unconfirmed.'],
  ['Cloud ingress body cleanup is unconfirmed; admission remains closed.', [],
    'Cloud ingress body cleanup is unconfirmed; admission remains closed.'],
  ['Cloud owner forwarding closure is unconfirmed; no replay was attempted: %j', [{ requestId: FAKE_KEY }],
    'Cloud owner forwarding closure is unconfirmed; no replay was attempted.'],
  ['Cloud owner forwarding failed after possible delivery; no replay was attempted: %j', [{ requestId: FAKE_KEY }],
    'Cloud owner forwarding failed after possible delivery; no replay was attempted.'],
  ['Cloud owner request observation is unavailable; request state is unchanged.', [],
    'Cloud owner request observation is unavailable; request state is unchanged.'],
  ['Cloud ingress request failed: %j', [{ requestId: FAKE_KEY }], 'Cloud ingress request failed.'],
  ['Cloud ingress borrow cleanup is unconfirmed; admission remains closed.', [],
    'Cloud ingress borrow cleanup is unconfirmed; admission remains closed.'],
] as const

afterEach(async () => {
  try { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() }
  finally { vi.useRealTimers(); vi.restoreAllMocks() }
})

function root() {
  const ctx = new Context()
  contexts.push(ctx)
  const previous = new Set(ctx.logger.exporters.values())
  const runtime = new Root.PeAccountRuntime(ctx, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  const added = [...ctx.logger.exporters.values()].filter(value => !previous.has(value))
  expect(added).toHaveLength(1)
  const exporter = added[0]
  if (exporter === undefined) throw new Error('Root did not install its service log exporter')
  return { ctx, runtime, exporter, previous }
}

function row(line: unknown): unknown {
  if (typeof line !== 'string' || !line.startsWith(PREFIX)) throw new Error('Expected the fixed JSON log prefix')
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4096)
  expect(line).not.toContain('\n')
  return JSON.parse(line.slice(PREFIX.length))
}

it('exports all three levels under the fixed root alias and rejects debug', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx, exporter } = root()
  expect(exporter.levels?.default).toBe(2)
  const logger = ctx.logger(FAKE_KEY)
  logger.error(SHUTDOWN); logger.info(DRAIN); logger.warn(OBSERVATION); logger.debug(SHUTDOWN)
  expect(output).toHaveBeenCalledTimes(3)
  for (const [index, level] of ['error', 'info', 'warn'].entries()) {
    expect(output.mock.calls[index]).toHaveLength(1)
    expect(row(output.mock.calls[index]?.[0])).toMatchObject({ level, name: 'cloud-root' })
  }
  expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
  exporter.export({ sn: 1, ts: 0, type: 'debug', level: 3, name: FAKE_KEY, args: [SHUTDOWN] })
  expect(output).toHaveBeenCalledTimes(3)
})

it.each(fixed)('keeps the reviewed failure template %s without its dynamic fields', (input, args, text) => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx } = root()
  ctx.logger('unreviewed-name').warn(input, ...args)
  expect(output).toHaveBeenCalledTimes(1)
  expect(row(output.mock.calls[0]?.[0])).toEqual({ level: 'warn', name: 'cloud-root', content: text })
  expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
})

it('does not accept unknown strings, unreviewed names or missing and surplus parameters', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx } = root(), logger = ctx.logger(FAKE_KEY)
  logger.warn(FAKE_KEY); logger.warn('An unreviewed but harmless-looking message')
  logger.warn(PEER); logger.warn(SHUTDOWN, FAKE_KEY)
  logger.warn(READY); logger.warn(READY, { event: 'ordinary-profile-ready' }, FAKE_KEY)
  expect(output).not.toHaveBeenCalled()
})

it('projects Error first and reviewed Error parameters without message or stack text', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx } = root(), logger = ctx.logger(FAKE_KEY)
  const error = new TypeError(FAKE_KEY)
  Object.defineProperty(error, 'code', { value: 'cloud/account-unavailable' })
  logger.error(error); logger.warn(PEER, error)
  expect(output).toHaveBeenCalledTimes(2)
  for (const [line] of output.mock.calls) {
    expect(row(line)).toMatchObject({ name: 'cloud-root', error: { type: 'TypeError', code: 'cloud/account-unavailable' } })
  }
  const text = JSON.stringify(output.mock.calls)
  expect(text).not.toContain(FAKE_KEY); expect(text).not.toContain('service-log-output.spec.ts')
})

it.each(['cloud/account-unavailable', 'cloud/stop-unconfirmed', 'cloud/config-conflict', 'cloud/invalid-config'] as const)(
  'retains the reviewed project code %s through the real Logger', (code) => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = root()
    ctx.logger(FAKE_KEY).error(new Root.AccountRuntimeError(code, FAKE_KEY))
    expect(row(output.mock.calls[0]?.[0])).toMatchObject({ error: { type: 'AccountRuntimeError', code } })
    expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
  },
)

it('does not copy unknown name or code and does not invent a code for an ordinary Error', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx } = root(), error = new Error(FAKE_KEY)
  Object.defineProperty(error, 'name', { value: FAKE_KEY }); Object.defineProperty(error, 'code', { value: FAKE_KEY })
  ctx.logger(FAKE_KEY).error(error)
  expect(row(output.mock.calls[0]?.[0])).toMatchObject({ error: { type: 'unknown' } })
  expect(row(output.mock.calls[0]?.[0])).not.toHaveProperty('error.code')
  const shaped = new Error(FAKE_KEY)
  Object.defineProperty(shaped, 'name', { value: 'UnreviewedError' })
  Object.defineProperty(shaped, 'code', { value: 'cloud/unreviewed-code' })
  ctx.logger(FAKE_KEY).error(shaped)
  expect(row(output.mock.calls[1]?.[0])).toMatchObject({ error: { type: 'unknown' } })
  expect(row(output.mock.calls[1]?.[0])).not.toHaveProperty('error.code')
  ctx.logger(FAKE_KEY).error(new Error(FAKE_KEY))
  expect(row(output.mock.calls[2]?.[0])).toMatchObject({ error: { type: 'Error' } })
  expect(row(output.mock.calls[2]?.[0])).not.toHaveProperty('error.code')
  expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
  expect(JSON.stringify(output.mock.calls)).not.toContain('UnreviewedError')
  expect(JSON.stringify(output.mock.calls)).not.toContain('cloud/unreviewed-code')
})

it.each([FAKE_KEY, { event: 'ordinary-profile-ready', extra: FAKE_KEY }, [FAKE_KEY]])(
  'drops an unreviewed cause value without inventing a ready event: %#', (cause) => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = root()
    ctx.logger(FAKE_KEY).error(new Error(FAKE_KEY, { cause }))
    expect(output).toHaveBeenCalledTimes(1)
    expect(row(output.mock.calls[0]?.[0])).toMatchObject({ error: { type: 'Error' } })
    expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(output.mock.calls)).not.toContain('ordinary-profile-ready')
  },
)

it('sanitizes nested Error and AggregateError elements after the existing Logger splits them', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx } = root(), logger = ctx.logger(FAKE_KEY)
  logger.error(new Error(FAKE_KEY, { cause: new TypeError(FAKE_KEY) }))
  expect(output).toHaveBeenCalledTimes(2)
  logger.error(new AggregateError([FAKE_KEY, { event: 'ordinary-profile-ready' }, [FAKE_KEY], new Error(FAKE_KEY)], FAKE_KEY))
  expect(output).toHaveBeenCalledTimes(3)
  for (const [line] of output.mock.calls) expect(row(line)).toHaveProperty('error.type')
  expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
  expect(JSON.stringify(output.mock.calls)).not.toContain('ordinary-profile-ready')
})

it('allows only the public constant for a matching cause and still enforces arity', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx } = root(), logger = ctx.logger(FAKE_KEY)
  logger.error(new Error(FAKE_KEY, { cause: SHUTDOWN }))
  expect(output).toHaveBeenCalledTimes(2)
  expect(row(output.mock.calls[0]?.[0])).toEqual({ level: 'error', name: 'cloud-root', content: SHUTDOWN })
  output.mockClear()
  logger.error(new Error(FAKE_KEY, { cause: PEER }))
  expect(output).toHaveBeenCalledTimes(1)
  expect(row(output.mock.calls[0]?.[0])).toHaveProperty('error.type')
  logger.error(PEER, {}, FAKE_KEY); logger.error(SHUTDOWN, FAKE_KEY)
  expect(output).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
})

it('projects only the direct ready event under its exact two-argument template', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx } = root(), logger = ctx.logger(FAKE_KEY)
  const getter = vi.fn(() => { throw new Error(FAKE_KEY) })
  const observation = { event: 'ordinary-profile-ready', instanceId: FAKE_KEY, recipeVersion: FAKE_KEY,
    pid: 123456789, appReadyObserved: true, recipeStatus: 'sealed', unknown: { secret: FAKE_KEY } }
  Object.defineProperty(observation, 'ignoredGetter', { get: getter })
  logger.info(READY, observation)
  expect(output).toHaveBeenCalledTimes(1)
  expect(row(output.mock.calls[0]?.[0])).toEqual({ level: 'info', name: 'cloud-root',
    content: 'Cloud runtime observation.', event: 'ordinary-profile-ready' })
  expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
  expect(JSON.stringify(output.mock.calls)).not.toContain('123456789')
  logger.info(READY, { event: FAKE_KEY })
  logger.info(READY, Object.create({ event: 'ordinary-profile-ready' }))
  logger.info(READY, Object.defineProperty({}, 'event', { get: getter }))
  logger.info(observation)
  expect(output).toHaveBeenCalledTimes(1)
  expect(getter).not.toHaveBeenCalled()
})

it('never calls input Error accessors or object formatter methods inside the exporter', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { exporter } = root()
  const getter = vi.fn(() => { throw new Error(FAKE_KEY) })
  const error = new Error('Fixed outer error')
  for (const key of ['name', 'code', 'message', 'stack', 'cause']) Object.defineProperty(error, key, { get: getter })
  for (const value of [error, { toJSON: getter, toString: getter }]) {
    expect(() => exporter.export({ sn: 1, ts: 0, name: FAKE_KEY, type: 'warn', level: 2, args: [PEER, value] })).not.toThrow()
  }
  expect(getter).not.toHaveBeenCalled()
  expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
})

it('isolates a reflection trap failure at the exporter boundary without logging its thrown text', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { exporter } = root()
  const trap = vi.fn(() => { throw new Error(FAKE_KEY) })
  const message = new Proxy({ sn: 1, ts: 0, name: FAKE_KEY, type: 'warn' as const, level: 2, args: [SHUTDOWN] },
    { getOwnPropertyDescriptor: trap })
  expect(() => exporter.export(message)).not.toThrow()
  expect(trap).toHaveBeenCalled()
  expect(output).not.toHaveBeenCalled()
})

it('omits long unknown text and ignores long dynamic arguments while keeping complete JSON within 4096 bytes', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx } = root(), logger = ctx.logger(FAKE_KEY.repeat(4096))
  for (const long of [FAKE_KEY.repeat(4096), '长\n"'.repeat(4096), '\n'.repeat(8192)]) {
    logger.warn(long); logger.warn(PEER, long)
  }
  expect(output).toHaveBeenCalledTimes(3)
  for (const [line] of output.mock.calls) {
    expect(row(line)).toEqual({ level: 'warn', name: 'cloud-root', content: 'Cloud login Peer cleanup is unconfirmed.' })
  }
  expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
})

it('contains a console failure while actually attempting an approved row', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error(FAKE_KEY) })
  const { ctx } = root()
  expect(() => ctx.logger(FAKE_KEY).warn(OBSERVATION)).not.toThrow()
  expect(output).toHaveBeenCalledTimes(1)
})

it('withdraws on component close without removing other exporters and remains idempotent', async () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx, runtime, exporter, previous } = root()
  const observer = { levels: { default: 2 }, export: vi.fn() }
  ctx.logger.exporter(observer)
  ctx.logger(FAKE_KEY).warn(OBSERVATION)
  expect(output).toHaveBeenCalledTimes(1)
  await runtime.close(); await runtime.close()
  expect([...ctx.logger.exporters.values()]).not.toContain(exporter)
  for (const value of previous) expect([...ctx.logger.exporters.values()]).toContain(value)
  expect([...ctx.logger.exporters.values()]).toContain(observer)
  ctx.logger(FAKE_KEY).warn(OBSERVATION)
  expect(output).toHaveBeenCalledTimes(1)
  expect(observer.export).toHaveBeenCalledTimes(2)
})

it.each([false, true])('keeps closing diagnostics until the actual close promise settles, rejection=%s', async (reject) => {
  vi.useFakeTimers()
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx, runtime, exporter } = root(), actual = Promise.withResolvers<undefined>()
  const failure = new Error(FAKE_KEY)
  // Script only the existing finishControl boundary; exercise the unchanged close entry and timeout observer.
  Object.defineProperty(runtime, 'control', { configurable: true, writable: true,
    value: { phase: 'active', config: { shutdownTimeoutMs: 20 } } })
  Object.defineProperty(runtime, 'finishControl', { configurable: true, value: () => actual.promise })
  const closing = runtime.close()
  expect(closing).toBe(actual.promise)
  expect(runtime.close()).toBe(closing)
  try {
    await vi.advanceTimersByTimeAsync(20)
    expect([...ctx.logger.exporters.values()]).toContain(exporter)
    expect(output.mock.calls.map(([line]) => row(line))).toContainEqual({ level: 'error', name: 'cloud-root', content: SHUTDOWN })
    ctx.logger(FAKE_KEY).error(reject ? CONTROL : DRAIN)
    if (reject) {
      const observed = expect(closing).rejects.toBe(failure)
      actual.reject(failure)
      await observed
    } else { actual.resolve(undefined); await closing }
    expect([...ctx.logger.exporters.values()]).not.toContain(exporter)
    const count = output.mock.calls.length
    ctx.logger(FAKE_KEY).error(CONTROL)
    expect(output).toHaveBeenCalledTimes(count)
  } finally {
    actual.resolve(undefined)
    await closing.catch((_expected: unknown) => { /* The scripted failure is asserted above; teardown only joins it. */ })
    Object.defineProperty(runtime, 'control', { value: undefined })
    Reflect.deleteProperty(runtime, 'finishControl')
  }
})

it('revokes on the owning fiber and ignores later direct delivery after repeated withdrawal', async () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const ctx = new Context()
  contexts.push(ctx)
  const before = new Set(ctx.logger.exporters.values()), stop = installServiceLogOutput(ctx, async () => {})
  const exporter = [...ctx.logger.exporters.values()].find(value => !before.has(value))
  if (exporter === undefined) throw new Error('Expected the installed exporter')
  await ctx.fiber.dispose()
  stop(); stop()
  exporter.export({ sn: 1, ts: 0, name: FAKE_KEY, type: 'warn', level: 2, args: [OBSERVATION] })
  expect(output).not.toHaveBeenCalled()
})

it.each([false, true])('retains closing diagnostics while the real owning fiber disposes, rejection=%s', async (reject) => {
  vi.useFakeTimers()
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { ctx, runtime, exporter, previous } = root(), actual = Promise.withResolvers<undefined>()
  const failure = new Error(FAKE_KEY)
  Object.defineProperty(runtime, 'control', { configurable: true, writable: true,
    value: { phase: 'active', config: { shutdownTimeoutMs: 20 } } })
  Object.defineProperty(runtime, 'finishControl', { configurable: true, value: () => actual.promise })
  const closing = runtime.close()
  let disposed = false
  const disposing = ctx.fiber.dispose().then(() => { disposed = true })
  expect(runtime.close()).toBe(closing)
  expect(closing).toBe(actual.promise)
  try {
    await vi.advanceTimersByTimeAsync(20)
    expect(disposed).toBe(false)
    expect([...ctx.logger.exporters.values()]).toContain(exporter)
    expect(output.mock.calls.map(([line]) => row(line))).toContainEqual({ level: 'error', name: 'cloud-root', content: SHUTDOWN })
    ctx.logger(FAKE_KEY).error(DRAIN); ctx.logger(FAKE_KEY).error(CONTROL)
    for (const content of [DRAIN, CONTROL]) {
      expect(output.mock.calls.map(([line]) => row(line))).toContainEqual({ level: 'error', name: 'cloud-root', content })
    }
    if (reject) {
      const observed = expect(closing).rejects.toBe(failure)
      actual.reject(failure)
      await observed
    } else { actual.resolve(undefined); await closing }
    await disposing
    expect(disposed).toBe(true)
    expect([...ctx.logger.exporters.values()]).not.toContain(exporter)
    for (const value of previous) expect([...ctx.logger.exporters.values()]).toContain(value)
    const count = output.mock.calls.length
    exporter.export({ sn: 1, ts: 0, name: FAKE_KEY, type: 'warn', level: 2, args: [OBSERVATION] })
    const repeated = runtime.close()
    expect(repeated).toBe(closing)
    await repeated.catch((_expected: unknown) => { /* Original rejection identity was asserted above. */ })
    expect(output).toHaveBeenCalledTimes(count)
    expect(JSON.stringify(output.mock.calls)).not.toContain(FAKE_KEY)
  } finally {
    actual.resolve(undefined)
    await closing.catch((_expected: unknown) => { /* Join the original scripted failure during teardown. */ })
    await disposing
    Object.defineProperty(runtime, 'control', { value: undefined })
    Reflect.deleteProperty(runtime, 'finishControl')
  }
})

it('does not initiate Root closure when diagnostic registration itself fails', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const previous = [...ctx.logger.exporters.values()]
  const closeActual = vi.fn(async () => {})
  vi.spyOn(ctx.logger, 'exporter').mockImplementation(() => { throw new Error(FAKE_KEY) })
  let stop: (() => void) | undefined
  expect(() => { stop = installServiceLogOutput(ctx, closeActual) }).not.toThrow()
  stop?.(); stop?.()
  await ctx.fiber.dispose()
  expect(closeActual).not.toHaveBeenCalled()
  expect([...ctx.logger.exporters.values()]).toEqual(previous)
})

it('cleans a registered diagnostic observer without closing Root when owner-hook registration fails', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const previous = [...ctx.logger.exporters.values()]
  const closeActual = vi.fn(async () => {})
  let installedBeforeOwnerHook = false
  vi.spyOn(ctx, 'effect').mockImplementation(() => {
    installedBeforeOwnerHook = ctx.logger.exporters.size === previous.length + 1
    throw new Error(FAKE_KEY)
  })
  const stop = installServiceLogOutput(ctx, closeActual)
  expect(installedBeforeOwnerHook).toBe(true)
  stop(); stop()
  await ctx.fiber.dispose()
  expect(closeActual).not.toHaveBeenCalled()
  expect([...ctx.logger.exporters.values()]).toEqual(previous)
})

it('isolates the formal Root Loader exporter from a real Native account while joining pending shutdown', async () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pe-service-log-composition-')))
  const sentinelOwner = new Context()
  const sentinel = { levels: { default: 2 }, export: vi.fn() }
  const secret = Promise.withResolvers<ResolvedCredential | undefined>()
  const entered = Promise.withResolvers<undefined>()
  let nativeHandle: NativeAccountBootHandle | undefined
  let nativeProbe: Context | undefined
  let rootContext: Context | undefined
  let rootLogger: Context['logger'] | undefined
  let rootBoot: Promise<Context> | undefined
  let rootClosing: Promise<void> | undefined
  let rootDisposing: Promise<void> | undefined
  let applicationClose: (() => Promise<void>) | undefined
  let failure: { cause: unknown } | undefined
  const startupExporters = new Set<Exporter>()
  const beforeRuntime = new Set<Exporter>()
  const serviceCalls = () => output.mock.calls.filter(([line]) => typeof line === 'string' && line.startsWith(PREFIX))
  try {
    const home = join(directory, 'native-private'), cwd = join(directory, 'native-project')
    const label = 'service-log-account', dir = join(home, 'profiles', label)
    mkdirSync(cwd, { recursive: true })
    initProfile(dir, [])
    writeFileSync(join(directory, 'package.json'), '{"name":"service-log-composition-fixture","private":true}\n')
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'probe', name: 'cordis:probe' }] }]) + '\n')
    const profile: ProfileContext = {
      name: label, dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(directory, 'package.json'),
      cwd, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    }
    nativeHandle = startNativeAccountBoot({
      binding: { accountId: brandString<AccountId>(label), epoch: brandString<OwnerEpoch>('9007199254740993'),
        recipeVersion: 'service-log-composition', lifetime: new AbortController().signal },
      profile, configPath: join(dir, 'cordis.yml'),
      bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
      environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: home } }]),
      requiredEntryIds: ['include', 'probe'], maxObservedEvents: 8,
      prepare(ctx) { ctx.loader.builtins.probe = { apply(scope: Context) { nativeProbe = scope } } },
    })
    const native = await nativeHandle.result
    if (native.status === 'failed') throw native.cause
    if (nativeProbe === undefined) throw new Error('The real Native Loader did not mount its probe')
    const account = native.context
    expect(nativeProbe.logger.exporters).toBe(account.logger.exporters)
    const accountExporters = new Set(account.logger.exporters.values())

    const rootDirectory = join(directory, 'root')
    mkdirSync(join(rootDirectory, 'profile'), { recursive: true })
    const configPath = join(rootDirectory, 'root.cordis.yml')
    writeFileSync(configPath, JSON.stringify([
      { id: 'credentials', name: 'cordis:root-credentials' },
      { id: 'runtime', name: 'cordis:actual-runtime-root', config: rootConfig(rootDirectory) },
    ]))
    const read = vi.fn(() => { entered.resolve(undefined); return secret.promise })
    const register = vi.fn((close: () => Promise<void>) => { applicationClose = close; return close })
    let bootSettled = false
    rootBoot = boot('iter015-service-log-composition', configPath, [], (ctx) => {
      rootContext = ctx; rootLogger = ctx.logger
      for (const exporter of ctx.logger.exporters.values()) startupExporters.add(exporter)
      sentinelOwner.logger = ctx.logger
      sentinelOwner.logger.exporter(sentinel)
      for (const exporter of ctx.logger.exporters.values()) beforeRuntime.add(exporter)
      ctx.provide('appShutdown', { register })
      Object.assign(ctx.loader.builtins, {
        'actual-runtime-root': Root,
        'root-credentials': { apply(scope: Context) { new RootCredentials(scope, read) } },
      })
    })
    void rootBoot.then(() => { bootSettled = true }, () => { bootSettled = true })
    await Promise.race([entered.promise, rootBoot.then(() => { throw new Error('Root boot ended before secret resolution entered') })])
    if (rootContext === undefined || rootLogger === undefined || applicationClose === undefined) {
      throw new Error('The actual Root did not retain its Context, Logger and original launcher close callback')
    }
    expect(rootLogger.exporters).not.toBe(account.logger.exporters)
    const added = [...rootLogger.exporters.values()].filter(value => !beforeRuntime.has(value))
    expect(added).toHaveLength(1)
    const exporter = added[0]
    if (exporter === undefined) throw new Error('The formal Root Loader did not install its service log exporter')
    expect([...account.logger.exporters.values()]).not.toContain(exporter)
    expect([...rootLogger.exporters.values()]).toContain(sentinel)
    for (const [level, text] of [['info', DRAIN], ['warn', OBSERVATION], ['error', CONTROL]] as const) {
      const count = serviceCalls().length
      rootLogger[level](text)
      expect(serviceCalls()).toHaveLength(count + 1)
      expect(serviceCalls().at(-1)).toHaveLength(1)
      expect(row(serviceCalls().at(-1)?.[0])).toEqual({ level, name: 'cloud-root', content: text })
      account.logger[level](text)
      expect(serviceCalls()).toHaveLength(count + 1)
    }

    rootClosing = applicationClose()
    expect(applicationClose()).toBe(rootClosing)
    let disposed = false
    rootDisposing = rootContext.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(bootSettled).toBe(false)
    expect([...rootLogger.exporters.values()]).toContain(exporter)
    // Boot owns its startup collector; it must survive pending work, but may leave in boot's finally.
    for (const original of startupExporters) expect([...rootLogger.exporters.values()]).toContain(original)
    for (const text of [DRAIN, CONTROL]) {
      const count = serviceCalls().length
      rootLogger.error(text)
      expect(serviceCalls()).toHaveLength(count + 1)
      expect(row(serviceCalls().at(-1)?.[0])).toEqual({ level: 'error', name: 'cloud-root', content: text })
      account.logger.error(text)
      expect(serviceCalls()).toHaveLength(count + 1)
    }

    secret.resolve(undefined)
    await rootClosing
    await rootDisposing
    expect(await rootBoot).toBe(rootContext)
    expect(disposed).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledOnce()
    expect([...rootLogger.exporters.values()]).not.toContain(exporter)
    expect([...rootLogger.exporters.values()]).toContain(sentinel)
    for (const original of accountExporters) expect([...account.logger.exporters.values()]).toContain(original)
    const count = serviceCalls().length, buffered = rootLogger.buffer.length, observed = sentinel.export.mock.calls.length
    exporter.export({ sn: 1, ts: 0, name: FAKE_KEY, type: 'warn', level: 2, args: [OBSERVATION] })
    rootLogger.info(DRAIN)
    expect(serviceCalls()).toHaveLength(count)
    expect(rootLogger.buffer).toHaveLength(buffered + 1)
    expect(rootLogger.buffer.at(-1)).toMatchObject({ type: 'info', args: [DRAIN] })
    expect(sentinel.export).toHaveBeenCalledTimes(observed + 1)
    expect(await nativeHandle.dispose()).toMatchObject({ status: 'confirmed' })
  } catch (cause) { failure = { cause } }
  finally {
    secret.resolve(undefined)
    const joins: Promise<unknown>[] = []
    if (rootBoot !== undefined) joins.push(rootBoot)
    if (rootClosing !== undefined) joins.push(rootClosing)
    if (rootContext !== undefined) joins.push(rootDisposing ?? rootContext.fiber.dispose())
    if (nativeHandle !== undefined) joins.push(nativeHandle.result, nativeHandle.dispose())
    const errors: unknown[] = failure === undefined ? [] : [failure.cause]
    for (const result of await Promise.allSettled(joins)) if (result.status === 'rejected') errors.push(result.reason)
    for (const result of await Promise.allSettled([sentinelOwner.fiber.dispose()])) {
      if (result.status === 'rejected') errors.push(result.reason)
    }
    try { rmSync(directory, { recursive: true, force: true }) } catch (cause) { errors.push(cause) }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Formal log composition or its owned cleanup failed')
  }
})
