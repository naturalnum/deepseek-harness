/** The real runtime seal refuses issuance; these tests never supply a ready AccountUse or a seal flag. */
import { Context } from '@deepseek-ai/cordis'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionGenerations } from '../src/generations.ts'

const id = 'generation-denial-test' as Branded<'pe-request-id'>

describe('runtime-bound generation ownership', () => {
  it('cannot issue a token from an unsealed component runtime or client-like binding', async () => {
    const ctx = new Context()
    const runtime = new PeAccountRuntime(ctx, { maxMountedAccounts: 1, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
    const owner = new ConnectionGenerations(runtime, 1)
    const current = vi.spyOn(runtime, 'assertBusinessCurrent')
    const lifetime = new AbortController()
    const binding: AccountBinding = {
      accountId: 'not-authenticated' as AccountBinding['accountId'], epoch: '1' as AccountBinding['epoch'],
      recipeVersion: 'not-ready', lifetime: lifetime.signal,
    }
    try {
      expect(() => owner.current(binding, id)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
      expect(current).toHaveBeenCalledTimes(1)
      lifetime.abort()
      expect(() => owner.current(binding, id)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
      owner.close()
      expect(() => owner.current({ ...binding, lifetime: new AbortController().signal }, id)).toThrow()
      expect(current).toHaveBeenCalledTimes(1)
    } finally { owner.close(); await ctx.fiber.dispose() }
  })
})
