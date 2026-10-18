/** Installation failures before the private native Controller can register a service. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { createNativeController, type NativeSessionGuards } from '../src/native.ts'
import { ExposurePolicy } from '../src/exposure.ts'

function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const lifetime = new AbortController()
  const binding: AccountBinding = Object.freeze({
    accountId: brandString<AccountId>('a'), epoch: brandString<OwnerEpoch>('1'),
    recipeVersion: 'd08-m3', lifetime: lifetime.signal,
  })
  const policy = new ExposurePolicy({
    recipeVersion: binding.recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [],
  })
  const guards: NativeSessionGuards = {
    projectDirectory: { binding, prepare: async () => {} },
    assertHandlerEnabled: vi.fn(), resolveCreate: vi.fn<NativeSessionGuards['resolveCreate']>(async request => request),
    assertSessionProject: vi.fn(async () => {}), assertActiveScope: vi.fn(),
  }
  const current = vi.fn()
  const install = (scope = ctx, expected = binding) =>
    createNativeController(scope, expected, current, policy, guards, { nativeOpen: false })
  return { ctx, binding, lifetime, install, current }
}

it('rejects a missing or copied installation binding before native service registration', () => {
  const { ctx, binding, install, current } = setup()
  expect(() => install()).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  ctx.provide('peAccount', { ...binding })
  expect(() => install()).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(ctx.get('sessionController')).toBeUndefined()
  expect(current).not.toHaveBeenCalled()
})

it('rejects a foreign independent root even when its child exposes the expected binding', () => {
  const { ctx, binding, install } = setup()
  ctx.provide('peAccount', { ...binding })
  const child = ctx.isolate('peAccount')
  child.provide('peAccount', binding)
  expect(() => install(child)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(ctx.get('sessionController')).toBeUndefined()
})

it('rejects an ended graph or mismatched recipe without constructing a native Controller', () => {
  const { ctx, binding, lifetime, install } = setup()
  const different = Object.freeze({ ...binding, recipeVersion: 'different' })
  ctx.provide('peAccount', different)
  expect(() => install(ctx, different)).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
  ctx.set('peAccount', binding)
  lifetime.abort()
  expect(() => install()).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(ctx.get('sessionController')).toBeUndefined()
})
