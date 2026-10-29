import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { initProfile, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { startNativeAccountBoot } from '../../../cloud/pe-cloud-runtime/src/native-boot.ts'
import type { AccountId, OwnerEpoch } from '../../../cloud/pe-cloud-runtime/src/types.ts'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const hooks = vi.hoisted(() => ({ started: false, forcePublic: false, privateDecoder: false, closes: 0,
  closeFailure: undefined as Error | undefined }))

vi.mock('../src/zstd.ts', async (load) => {
  const actual = await load<typeof import('../src/zstd.ts')>()
  const { PublicZstdFrameDecoder } = await import('../src/zstd-public-decoder.ts')
  return { ...actual, createZstdFrameDecoder: () => {
    const decoder = hooks.forcePublic ? new PublicZstdFrameDecoder() : actual.createZstdFrameDecoder()
    hooks.privateDecoder = Reflect.get(decoder, 'stream') !== undefined
    const decode = decoder.decode.bind(decoder), close = decoder.close.bind(decoder)
    decoder.decode = (...args: Parameters<typeof decoder.decode>) => { hooks.started = true; return decode(...args) }
    decoder.close = () => { hooks.closes += 1; close(); if (hooks.closeFailure !== undefined) throw hooks.closeFailure }
    return decoder
  } }
})

async function parentFile(root: string, id: SessionId, cwd?: string, malformed = false) {
  const path = generationLogPath(root, cwd, id, 3, 'zstd')
  const header = { type: 'session', id, version: 3, createdAt: 1, isSeeded: false, delegationDepth: 0,
    ...cwd === undefined ? {} : { cwd } }
  const rows = [
    { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ].map(row => JSON.stringify(row) + '\n').join('')
  await mkdir(dirname(path), { recursive: true })
  const body = await compressZstdFrame(rows)
  if (malformed) body[body.length - 1] = (body[body.length - 1] as number) ^ 0xff
  await writeFile(path, Buffer.concat([await compressZstdFrame(JSON.stringify(header) + '\n'), body]))
}

function pauseInsideDecoder() {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const now = performance.now.bind(performance), yieldActual = scheduler.yield.bind(scheduler)
  let syntheticTime = 0
  vi.spyOn(performance, 'now').mockImplementation(() => hooks.started ? (syntheticTime += 1000) : now())
  vi.spyOn(scheduler, 'yield').mockImplementation(async () => {
    if (!hooks.started) { await yieldActual(); return }
    entered.resolve(undefined); await release.promise
  })
  onTestFinished(() => {
    release.resolve(undefined); vi.restoreAllMocks()
    hooks.started = false; hooks.forcePublic = false; hooks.privateDecoder = false; hooks.closes = 0; hooks.closeFailure = undefined
  })
  return { entered, release }
}

it.each(['private', 'public'] as const)('retains a late first internal %s parent decoder close failure', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-parent-decoder-')), ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId(`parent-${kind}`)
  await parentFile(root, id)
  await ctx.plugin(JsonlPersistence, { root, compression: 'zstd' })
  const persistence = ctx.sessionPersistence, reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
  const gate = pauseInsideDecoder(), abort = new AbortController(), reason = new Error('last waiter cancelled')
  const failure = new Error('actual decoder close failed')
  hooks.forcePublic = kind === 'public'; hooks.closeFailure = failure
  const opening = persistence.open(id, 'read', { signal: abort.signal })
  void opening.catch(() => {})
  await gate.entered.promise
  abort.abort(reason); await expect(opening).rejects.toBe(reason)
  expect(persistence.isQuiescent(8)).toBe(false)
  gate.release.resolve(undefined)
  await vi.waitFor(() => { expect(reported).toHaveBeenCalled() })
  expect(persistence.isQuiescent(8)).toBe(false)
  expect(hooks.privateDecoder).toBe(kind === 'private')
  expect(hooks.closes).toBe(1)
  expect(reported.mock.calls.map(call => call[0] as unknown))
    .toContainEqual(expect.objectContaining({ name: 'JsonlReadCleanupError', cause: failure }))
})

it.each(['private', 'public'] as const)('does not treat an ordinary %s parent decode failure as a cleanup failure', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-parent-bad-decode-')), ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const id = SessionId(`bad-${kind}`)
  await parentFile(root, id, undefined, true)
  await ctx.plugin(JsonlPersistence, { root, compression: 'zstd' })
  hooks.forcePublic = kind === 'public'
  const reported = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
  const error: unknown = await ctx.sessionPersistence.open(id, 'read').catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).name).toBe('SessionPersistenceCorruptionError')
  expect(ctx.sessionPersistence.isQuiescent(8)).toBe(true)
  expect(reported.mock.calls.length).toBe(0)
  expect(hooks.closes).toBe(1)
  hooks.started = false; hooks.forcePublic = false; hooks.closes = 0
})

it('waits for a cancelled parent decoder and reports its late close failure through native root disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-parent-native-'))
  const home = join(root, 'home'), cwd = join(root, 'project'), dir = join(home, 'profiles', 'account')
  mkdirSync(cwd, { recursive: true }); initProfile(dir, [])
  const configPath = join(dir, 'cordis.yml'), anchor = join(root, 'package.json'), storage = join(root, 'storage')
  writeFileSync(configPath, '[]\n'); writeFileSync(anchor, '{"name":"native-decoder-fixture","private":true}\n')
  const profile: ProfileContext = { name: 'decoder', dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: anchor, cwd, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined }
  const id = SessionId('native-parent'), lifetime = new AbortController()
  await parentFile(storage, id, cwd)
  const handle = startNativeAccountBoot({
    binding: { accountId: brandString<AccountId>('decoder'), epoch: brandString<OwnerEpoch>('1'),
      recipeVersion: 'decoder-fixture', lifetime: lifetime.signal },
    profile, configPath, bareModuleBaseUrl: new URL('../../../../package.json', import.meta.url).href,
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { HOME: home } }]),
    requiredEntryIds: ['include'], maxObservedEvents: 8,
    prepare: async (ctx) => { await ctx.plugin(JsonlPersistence, { root: storage, compression: 'zstd' }) },
  })
  const gate = pauseInsideDecoder()
  try {
    const outcome = await handle.result
    if (outcome.status !== 'mounted') throw outcome.cause
    const persistence = outcome.context.sessionPersistence, abort = new AbortController()
    const reason = new Error('cancel parent'), failure = new Error('actual decoder close failed')
    hooks.closeFailure = failure
    const opening = persistence.open(id, 'read', { signal: abort.signal })
    void opening.catch(() => {})
    await gate.entered.promise
    abort.abort(reason); await expect(opening).rejects.toBe(reason)
    expect(persistence.isQuiescent(8)).toBe(false)
    let settled = false
    const disposal = handle.dispose().then((result) => { settled = true; return result })
    await Promise.resolve(); expect(settled).toBe(false)
    gate.release.resolve(undefined)
    const observed = await disposal
    expect(observed).toMatchObject({ status: 'unknown', overflow: false })
    expect(observed.errorEvents).toBeGreaterThan(0)
    expect(hooks.closes).toBe(1)
    expect(persistence.isQuiescent(8)).toBe(false)
  } finally {
    gate.release.resolve(undefined)
    await handle.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
