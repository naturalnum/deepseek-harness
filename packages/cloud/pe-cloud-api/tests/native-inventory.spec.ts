/** Probe the actual Native proxy and registry records used by account admission. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'
import { nativeAccountFibers, nativeOriginal } from '../src/native-inventory.ts'

it('reads the actual Cordis proxy target and filters foreign roots before charging account inventory', async () => {
  const account = new Context(), foreign = new Context()
  onTestFinished(async () => { await account.fiber.dispose(); await foreign.fiber.dispose() })
  const owner = account.plugin(LlmRuntime)
  await owner
  const foreignOwners: Fiber[] = []
  for (let index = 0; index < 8; index++) {
    const fiber = foreign.plugin({ apply(ctx) { new LlmRuntime(ctx.isolate('llm')) } })
    await fiber
    foreignOwners.push(fiber.ctx.fiber)
  }
  const scoped = account.get('llm')
  expect(scoped).toBeInstanceOf(LlmRuntime)
  if (scoped === undefined) throw new Error('Native LlmRuntime proxy is absent')
  const target = nativeOriginal(scoped)
  expect(target, 'Cordis symbols.original must return the actual registered LlmRuntime').toBeInstanceOf(LlmRuntime)
  expect(target).not.toBe(scoped)
  if (!(target instanceof LlmRuntime)) throw new Error('Native proxy target is not the registered LlmRuntime')
  expect(nativeOriginal(target)).toBeUndefined()
  let charged = 0
  const fibers = [...nativeAccountFibers(account, () => {
    if (++charged > 2) throw new Error('Foreign runtime/fiber consumed the account inventory budget')
  })]
  expect(fibers).toEqual([owner.ctx.fiber])
  expect(charged).toBe(2)
  expect(foreignOwners.every(fiber => !fibers.includes(fiber))).toBe(true)
})
