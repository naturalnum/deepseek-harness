/** Loader composition exercises registration and capacity only; it never supplies a PG owner or a ready graph. */
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import { PeAccountRuntime, AccountRuntimeError } from '@deepseek-ai/dsh-pe-cloud-runtime/root'
import * as AccountEntry from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { installAccountBinding, requireAccountBinding } from '../src/binding.ts'
import { RuntimeConfigSchema } from '@deepseek-ai/dsh-pe-cloud-runtime/schema'
import type { AccountBinding, AccountId, DrainParticipant, OwnerEpoch, ParticipantId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const A = brandString<AccountId>('a')
const B = brandString<AccountId>('b')
const C = brandString<AccountId>('c')

async function root(): Promise<Context> {
  const ctx = await boot('runtime-m0-test', fileURLToPath(new URL('./fixtures/root.cordis.yml', import.meta.url)), [], (setup) => {
    setup.loader.builtins['runtime-m0'] = PeAccountRuntime
  })
  contexts.push(ctx)
  return ctx
}

function participant(id: ParticipantId): DrainParticipant {
  return {
    id,
    stopEpoch: async binding => ({
      participant: id, accountId: binding.accountId, epoch: binding.epoch,
      status: 'unknown', pendingOperationIds: [], evidenceRefs: [], reason: 'registration-only-test',
    }),
  }
}

function registerBoth(ctx: Context): void {
  ctx.peAccountRuntime.registerDrainParticipant(participant('files'))
  ctx.peAccountRuntime.registerDrainParticipant(participant('execution'))
}

function binding(accountId = A): AccountBinding {
  return { accountId, epoch: brandString<OwnerEpoch>('9007199254740993'), recipeVersion: 'test-recipe', lifetime: new AbortController().signal }
}

describe('required root participants through the Loader', () => {
  it('rejects missing and duplicate participants, and removes a contribution with its calling fiber', async () => {
    const ctx = await root()
    const runtime = ctx.peAccountRuntime
    expect(() => { runtime.assertRequiredParticipants() }).toThrow('files')
    expect(() => runtime.reserveMountCapacity(A)).toThrow(AccountRuntimeError)
    const files = await ctx.plugin({
      name: 'files-registration-test',
      inject: ['peAccountRuntime'],
      apply(child: Context) { child.peAccountRuntime.registerDrainParticipant(participant('files')) },
    })
    expect(() => { runtime.assertRequiredParticipants() }).toThrow('execution')
    const removeExecution = runtime.registerDrainParticipant(participant('execution'))
    expect(() => { runtime.assertRequiredParticipants() }).not.toThrow()
    expect(() => runtime.registerDrainParticipant(participant('execution'))).toThrow('Duplicate')
    await files.dispose()
    expect(() => { runtime.assertRequiredParticipants() }).toThrow('files')
    const removeFiles = runtime.registerDrainParticipant(participant('files'))
    expect(() => { runtime.assertRequiredParticipants() }).not.toThrow()
    await removeExecution()
    await removeExecution()
    expect(() => { runtime.assertRequiredParticipants() }).toThrow('execution')
    await removeFiles()
  })

  it('closes local admission when its root fiber unloads', async () => {
    const ctx = await root()
    registerBoth(ctx)
    const runtime = ctx.peAccountRuntime
    const mount = runtime.reserveMountCapacity(A)
    await ctx.fiber.dispose()
    expect(() => runtime.registerDrainParticipant(participant('files'))).toThrow('closed')
    expect(() => runtime.reserveMountCapacity(B)).toThrow('closed')
    expect(() => runtime.reserveDrainCapacity(A)).toThrow('closed')
    mount.settleMount()
    mount.releaseAccount()
  })
})

describe('local capacity ownership', () => {
  it('holds account capacity after mounting settles and refuses premature release', async () => {
    const ctx = await root()
    registerBoth(ctx)
    const runtime = ctx.peAccountRuntime
    const a = runtime.reserveMountCapacity(A)
    expect(() => { a.releaseAccount() }).toThrow('actual mount')
    expect(() => runtime.reserveMountCapacity(A)).toThrow('already reserved')
    expect(() => runtime.reserveMountCapacity(B)).toThrow('capacity')
    a.settleMount()
    a.settleMount()
    const b = runtime.reserveMountCapacity(B)
    b.settleMount()
    expect(() => runtime.reserveMountCapacity(C)).toThrow('capacity')
    a.releaseAccount()
    a.releaseAccount()
    const c = runtime.reserveMountCapacity(C)
    c.settleMount()
    c.releaseAccount()
    b.releaseAccount()
  })

  it('bounds drain slots and retains the account reservation during drain work', async () => {
    const ctx = await root()
    registerBoth(ctx)
    const runtime = ctx.peAccountRuntime
    expect(() => runtime.reserveDrainCapacity(A)).toThrow('no local capacity')
    const a = runtime.reserveMountCapacity(A)
    a.settleMount()
    const b = runtime.reserveMountCapacity(B)
    b.settleMount()
    const drain = runtime.reserveDrainCapacity(A)
    expect(() => { a.releaseAccount() }).toThrow('actual mount or drain')
    expect(() => runtime.reserveDrainCapacity(A)).toThrow('capacity')
    expect(() => runtime.reserveDrainCapacity(B)).toThrow('capacity')
    drain.release()
    drain.release()
    const next = runtime.reserveDrainCapacity(B)
    next.release()
    a.releaseAccount()
    b.releaseAccount()
  })
})

describe('deployment capacity parsing', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid capacity %s', (value) => {
    expect(() => RuntimeConfigSchema({ maxMountedAccounts: value, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })).toThrow()
  })

  it('requires every deployment limit and preserves explicit values', () => {
    expect(() => z.resolve({}, RuntimeConfigSchema, {})).toThrow()
    expect(RuntimeConfigSchema({ maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 }))
      .toEqual({ maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
  })
})

describe('private account binding handoff', () => {
  it('accepts only empty account configuration and rejects identity JSON before binding admission', () => {
    expect(AccountEntry.Config({})).toEqual({})
    expect(() => AccountEntry.Config({ accountId: 'client-selected', epoch: '1' })).toThrow('must be empty')
    const ctx = new Context()
    contexts.push(ctx)
    installAccountBinding(ctx, binding())
    expect(() => { AccountEntry.apply(ctx, { accountId: 'client-selected' }) }).toThrow('must be empty')
    expect(ctx.peAccount.accountId).toBe(A)
  })

  it('fails the actual Loader account entry without a factory binding', async () => {
    const ctx = await boot('runtime-m0-test', fileURLToPath(new URL('./fixtures/account.cordis.yml', import.meta.url)), [], (setup) => {
      setup.loader.builtins['runtime-account-m0'] = AccountEntry
    })
    contexts.push(ctx)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'runtime-account')
    expect(entry?.fiber).toBeDefined()
    await expect(entry?.fiber?.await()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(ctx.get('peAccount')).toBeUndefined()
  })

  it('keeps independent roots and immutable lossless generation inputs', async () => {
    const inputs = [binding(A), binding(B)]
    const mounted: AccountBinding[] = []
    for (const input of inputs) {
      const ctx = await boot('runtime-m0-test', fileURLToPath(new URL('./fixtures/account.cordis.yml', import.meta.url)), [], (setup) => {
        setup.loader.builtins['runtime-account-m0'] = AccountEntry
        mounted.push(installAccountBinding(setup, input))
      })
      contexts.push(ctx)
      expect(requireAccountBinding(ctx)).toBe(mounted.at(-1))
      expect(ctx.peAccount.epoch).toBe('9007199254740993')
      expect(Object.isFrozen(ctx.peAccount)).toBe(true)
      expect(() => Reflect.set(ctx.peAccount, 'epoch', '1')).not.toThrow()
      expect(ctx.peAccount.epoch).toBe(input.epoch)
    }
    expect(mounted[0]).not.toBe(mounted[1])
    expect(contexts[0]?.root).not.toBe(contexts[1]?.root)
    await contexts[0]?.fiber.dispose()
    expect(contexts[1]?.get('peAccount')?.accountId).toBe(B)
  })

  it('rejects a structural service object, ended lifetime, and child Context handoff', () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('peAccount', binding())
    expect(() => { AccountEntry.apply(ctx) }).toThrow('factory binding')
    const independent = new Context()
    contexts.push(independent)
    const controller = new AbortController()
    controller.abort()
    expect(() => installAccountBinding(independent, { ...binding(), lifetime: controller.signal })).toThrow('ended')
    expect(() => installAccountBinding(independent.extend(), binding())).toThrow('independent root')
    const live = new AbortController()
    installAccountBinding(independent, { ...binding(), lifetime: live.signal })
    live.abort()
    expect(() => requireAccountBinding(independent)).toThrow('ended')
  })
})
