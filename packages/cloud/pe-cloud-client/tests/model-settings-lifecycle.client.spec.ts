// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { expect, it, vi, onTestFinished } from 'vitest'
import { installCloudModelSettings } from '../src/client/model-settings.ts'
import type { CloudModelSettingsCallbacks } from '../src/client/prepared-page.ts'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'

it('a retired model callback never uses its replacement settings writer', async () => {
  const ctx = new Context(), lifetime = new AbortController(), locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  onTestFinished(async () => { lifetime.abort(); await ctx.fiber.dispose() })
  const unused = async () => { throw new Error('unused key operation') }
  const remote = new TestRemote(ctx, { cloudModelKey: { metadata: unused, describe: unused, set: unused, unset: unused } })
  let activeSettings: Pick<TypertClientRemote['settings'], 'mutate'> | undefined
  Object.defineProperty(remote, 'settings', { get: () => activeSettings })
  let current: CloudModelSettingsCallbacks | undefined, removed = 0
  const page = { modelSettingsRequestTimeoutMs: 1000, lifetime: { transport: { signal: lifetime.signal } },
    attachModels(_owner: Context, callbacks: CloudModelSettingsCallbacks) {
      current = callbacks; return () => { current = undefined; removed++ }
    } }
  const result = (tag: string) => ({ ok: true as const, value: { ns: tag, schema: {}, value: {}, user: {}, base: {}, revision: 7, secrets: [], autoGenerate: true, applies: 'live' as const } })
  const writerA = vi.fn(async () => result('A')), writerB = vi.fn(async () => result('B'))
  const settingsA = ctx.plugin((scope) => { activeSettings = { mutate: writerA }; scope.provide('remote.settings', activeSettings) })
  await settingsA.await()
  await ctx.plugin((scope) => { installCloudModelSettings(scope, page as never) }).await()
  await vi.waitFor(() => { expect(current).toBeDefined() })
  const original = current!
  await expect(original.writeSettings!('provider', [{ op: 'set', path: ['models'], value: [] }], 7)).resolves.toMatchObject({ kind: 'written', view: { ns: 'A' } })
  await settingsA.dispose()
  activeSettings = undefined
  expect(removed).toBe(1)
  expect(current).toBeUndefined()
  await ctx.plugin((scope) => { activeSettings = { mutate: writerB }; scope.provide('remote.settings', activeSettings) }).await()
  await expect(original.writeSettings!('provider', [{ op: 'set', path: ['models'], value: [] }], 7)).resolves.toMatchObject({ kind: 'unknown' })
  expect(writerB).not.toHaveBeenCalled()
  expect(removed).toBe(1)
})

it('an in-flight retired writer response remains unconfirmed', async () => {
  const ctx = new Context(), lifetime = new AbortController(), locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  onTestFinished(async () => { lifetime.abort(); await ctx.fiber.dispose() })
  const unused = async () => { throw new Error('unused key operation') }
  const remote = new TestRemote(ctx, { cloudModelKey: { metadata: unused, describe: unused, set: unused, unset: unused } })
  let activeSettings: Pick<TypertClientRemote['settings'], 'mutate'> | undefined
  Object.defineProperty(remote, 'settings', { get: () => activeSettings })
  let current: CloudModelSettingsCallbacks | undefined
  const page = { modelSettingsRequestTimeoutMs: 1000, lifetime: { transport: { signal: lifetime.signal } },
    attachModels(_owner: Context, callbacks: CloudModelSettingsCallbacks) { current = callbacks; return () => { current = undefined } } }
  const response = Promise.withResolvers<Awaited<ReturnType<TypertClientRemote['settings']['mutate']>>>()
  const mutate = vi.fn(() => response.promise)
  const settings = ctx.plugin((scope) => { activeSettings = { mutate }; scope.provide('remote.settings', activeSettings) })
  await settings.await()
  await ctx.plugin((scope) => { installCloudModelSettings(scope, page as never) }).await()
  await vi.waitFor(() => { expect(current).toBeDefined() })
  const pending = current!.writeSettings!('provider', [{ op: 'set', path: ['models'], value: [] }], 7)
  await vi.waitFor(() => { expect(mutate).toHaveBeenCalledOnce() })
  await settings.dispose()
  activeSettings = undefined
  response.resolve({ ok: true, value: { ns: 'provider', schema: {}, value: {}, user: {}, base: {}, revision: 8, secrets: [], autoGenerate: true, applies: 'live' } })
  await expect(pending).resolves.toMatchObject({ kind: 'unknown' })
})
