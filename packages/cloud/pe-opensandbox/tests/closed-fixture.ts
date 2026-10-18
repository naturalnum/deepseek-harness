/** Real Cordis registrations and runtime-installed bindings; no PG owner or product-ready graph is claimed. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PeAccountRuntime } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import type { AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { onTestFinished, vi } from 'vitest'
import { installAccountExecutionPort } from '../src/closed-owner.ts'
import * as root from '../src/root.ts'
import * as account from '../src/account.ts'
import type { SandboxCoordinator } from '../src/coordinator.ts'

export function context(): Context {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return ctx
}

export async function closedRoot(maxBoundAccounts = 2) {
  const ctx = context()
  const runtimeFiber = await ctx.plugin(PeAccountRuntime, { maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 2 })
  const fiber = await ctx.plugin(root, { mode: 'closed', requiredCapabilities: [], maxBoundAccounts })
  const owner = ctx.peSandboxCoordinator
  return { ctx, fiber, owner, runtimeFiber }
}

export function installedAccount(accountId = 'a', epoch = '1') {
  const ctx = context(), lifetime = new AbortController()
  const binding = installAccountBinding(ctx, {
    accountId: brandString<AccountId>(accountId), epoch: brandString<OwnerEpoch>(epoch),
    recipeVersion: 'closed-consumer-test', lifetime: lifetime.signal,
  })
  const current = vi.fn(() => { lifetime.signal.throwIfAborted() })
  return { ctx, binding, lifetime, current }
}

export async function closedAccount(owner: SandboxCoordinator,
  accountId = 'a', epoch = '1') {
  const installed = installedAccount(accountId, epoch)
  const port = owner.bindAccount(installed.ctx, installed.binding, installed.current)
  installAccountExecutionPort(installed.ctx, port)
  const fiber = await installed.ctx.plugin(account, { mode: 'closed', requiredCapabilities: [] })
  return { ...installed, port, fiber }
}
