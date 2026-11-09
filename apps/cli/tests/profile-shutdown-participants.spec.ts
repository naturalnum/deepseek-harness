/** Required close outcomes cross the real runProfile and Cordis disposal paths. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { boot, type Profile } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProfile } from '../src/profile-boot.ts'

vi.mock('@deepseek-ai/dsh-app-boot', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>(),
  boot: vi.fn(),
  installFailLoud: vi.fn(),
}))
vi.mock('@deepseek-ai/dsh-http-proxy', () => ({ installProxyFromEnvironment: vi.fn() }))

const homes: string[] = []
const oldExitCode = process.exitCode
afterEach(() => {
  process.exitCode = oldExitCode
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function launch(close: (ctx: Context) => Promise<void>, early = false, shutdownTimeoutMs = 1000) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-close-participant-'))
  homes.push(home)
  mkdirSync(join(home, 'runtime'))
  writeFileSync(join(home, 'runtime/package.json'), '{"name":"test-runtime","version":"1.0.0"}')
  writeFileSync(join(home, 'package.json'), '{"name":"test-bundle","version":"1.0.0"}')
  vi.stubEnv('DSH_HOME', home)
  vi.spyOn(process, 'on').mockReturnValue(process)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  const ctx = new Context(), cleanup = vi.fn(), proxy = vi.fn().mockResolvedValue(undefined)
  ctx.provide('loader', { create: vi.fn() })
  let joinClose: (() => Promise<void>) | undefined
  vi.mocked(installProxyFromEnvironment).mockResolvedValue(proxy)
  vi.mocked(boot).mockImplementation(async (_name, _path, _patches, setup) => {
    await setup?.(ctx)
    const participant = await ctx.plugin({ name: 'test-original-close', apply(scope: Context) {
      const shutdown = scope.get('appShutdown')
      if (shutdown === undefined) throw new Error('Original launcher shutdown participation is missing')
      scope.effect(() => {
        const release = shutdown.register(() => close(scope))
        joinClose = release
        return release
      }, 'test: original close outcome')
    } })
    ctx.effect(() => cleanup, 'test: unrelated native cleanup')
    if (early) await participant.dispose()
    return ctx
  })
  const profile: Profile = { name: 'close-participant', dir: home, patchPath: join(home, 'cordis.patch.yml'),
    patches: [], layers: [], skippedBundles: [] }
  const running = await runProfile({ environment: createLaunchEnvironmentSnapshot([]), profile: profile.name,
    patchFiles: [], args: [], shutdownTimeoutMs,
    resolvedProfile: { profile, installAnchor: join(home, 'runtime/package.json') } })
  if (joinClose === undefined) throw new Error('Participant was not registered')
  return { ...running, cleanup, proxy, exit, joinClose }
}

describe('original profile shutdown participants', () => {
  it.each(['clean', 'unknown', 'sync-throw', 'historical-mcp-error'] as const)(
    'preserves the actual %s close outcome through real Fiber disposal', async (mode) => {
      const states: FiberState[] = []
      const close = vi.fn((ctx: Context): Promise<void> => {
        states.push(ctx.fiber.state)
        if (mode === 'sync-throw') throw new Error('original close is unknown')
        if (mode === 'unknown') return Promise.reject(new Error('original close is unknown'))
        return Promise.resolve()
      })
      const app = await launch(close)
      if (mode === 'historical-mcp-error') app.ctx.logger.error('Historical optional MCP diagnostic; actual close is clean')
      await app.shutdown.shutdown(0)
      expect(states).toEqual([FiberState.ACTIVE])
      expect(close).toHaveBeenCalledOnce()
      await expect(app.ctx.fiber.dispose()).resolves.toBeUndefined()
      expect(app.cleanup).toHaveBeenCalledOnce()
      expect(app.proxy).toHaveBeenCalledOnce()
      if (mode === 'unknown' || mode === 'sync-throw') expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
      else {
        expect(app.exit).not.toHaveBeenCalled()
        expect(process.exitCode).toBe(0)
      }
    },
  )

  it.each([false, true])('retains an early unloaded close only when it fails (%s)', async (failed) => {
    const close = vi.fn(() => failed ? Promise.reject(new Error('retained early unknown')) : Promise.resolve())
    const app = await launch(close, true)
    expect(close).toHaveBeenCalledOnce()
    await app.shutdown.shutdown(0)
    expect(close).toHaveBeenCalledOnce()
    expect(app.cleanup).toHaveBeenCalledOnce()
    expect(app.proxy).toHaveBeenCalledOnce()
    if (failed) expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
    else expect(process.exitCode).toBe(0)
  })

  it('joins repeated scope and process closes once', async () => {
    const close = vi.fn(() => Promise.resolve())
    const app = await launch(close)
    const first = app.joinClose()
    expect(app.joinClose()).toBe(first)
    await first
    await app.shutdown.shutdown(0)
    await app.shutdown.shutdown(0)
    expect(close).toHaveBeenCalledOnce()
    expect(app.cleanup).toHaveBeenCalledOnce()
    expect(app.proxy).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(0)
  })

  it('continues other participants and proxy cleanup after an original close fails', async () => {
    const original = vi.fn(() => Promise.reject(new Error('original close remains unknown')))
    const app = await launch(original)
    const other = vi.fn(() => Promise.resolve())
    app.ctx.get('appShutdown')?.register(other)
    app.proxy.mockRejectedValueOnce(new Error('proxy cleanup also failed'))
    await app.shutdown.shutdown(0)
    expect(original).toHaveBeenCalledOnce()
    expect(other).toHaveBeenCalledOnce()
    expect(app.cleanup).toHaveBeenCalledOnce()
    expect(app.proxy).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('keeps the original deadline nonzero and rejects late registration', async () => {
    const held = Promise.withResolvers<undefined>()
    const app = await launch(() => held.promise, false, 20)
    const participant = app.ctx.get('appShutdown')
    vi.useFakeTimers()
    const pending = app.shutdown.shutdown(0)
    await vi.advanceTimersByTimeAsync(21)
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(() => participant?.register(() => Promise.resolve())).toThrow('shutdown has already started')
    held.resolve(undefined)
    await pending
    expect(app.proxy).toHaveBeenCalledOnce()
    expect(app.cleanup).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledOnce()
  })
})
