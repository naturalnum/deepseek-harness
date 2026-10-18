/** Source Loader refusal and service ownership checks; no target, owner lease or ready graph is supplied. */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { AccountBinding, ParticipantReceipt } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { SandboxCoordinator } from '../src/coordinator.ts'
import { requireExecution } from '../src/capabilities.ts'
import * as root from '../src/root.ts'
import * as account from '../src/account.ts'

class UnverifiedCoordinator extends SandboxCoordinator {
  assertReady(): void { requireExecution({ requiredCapabilities: ['argv-collect'] }) }
  bindAccount(): never { return requireExecution({ requiredCapabilities: ['argv-collect'] }) }
  async stopEpoch(binding: AccountBinding): Promise<ParticipantReceipt> {
    return {
      participant: 'execution', accountId: binding.accountId, epoch: binding.epoch,
      status: 'unknown', pendingOperationIds: [], evidenceRefs: [], reason: 'unit-service-definition-only',
    }
  }
}

describe('execution composition foundation', () => {
  it('keeps incomplete Loader entries failed and publishes no coordinator or providers', async () => {
    const ctx = await boot('opensandbox-m0-test', fileURLToPath(new URL('./fixtures/entries.cordis.yml', import.meta.url)), [], (setup) => {
      setup.loader.builtins['opensandbox-root-m0'] = root
      setup.loader.builtins['opensandbox-account-m0'] = account
    })
    try {
      expect('default' in root).toBe(false)
      expect('default' in account).toBe(false)
      expect(ctx.loader.unwrapExports(root)).toBe(root)
      expect(ctx.loader.unwrapExports(account)).toBe(account)
      for (const id of ['execution-root', 'execution-account']) {
        const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
        expect(entry?.fiber).toBeDefined()
        await expect(entry?.fiber?.await()).rejects.toMatchObject({ code: 'cloud/execution-unavailable' })
      }
      expect(ctx.get('peSandboxCoordinator')).toBeUndefined()
      expect(ctx.get('shell')).toBeUndefined()
      expect(ctx.get('subprocess')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('uses Cordis uniqueness and removes the coordinator definition with its fiber', async () => {
    const ctx = new Context()
    try {
      const fiber = await ctx.plugin(UnverifiedCoordinator)
      expect(ctx.peSandboxCoordinator.id).toBe('execution')
      expect(() => { ctx.peSandboxCoordinator.assertReady() }).toThrow('execution is unavailable')
      class DuplicateCoordinator extends UnverifiedCoordinator {}
      await expect(ctx.plugin(DuplicateCoordinator)).rejects.toThrow('service "peSandboxCoordinator" has been registered')
      await fiber.dispose()
      expect(ctx.get('peSandboxCoordinator')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})
