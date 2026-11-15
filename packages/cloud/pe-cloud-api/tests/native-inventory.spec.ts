/** Probe the actual Native proxy and registry records used by account admission. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished } from 'vitest'
import { nativeAccountImplementations, nativeOriginal } from '../src/native-inventory.ts'

it('reads the actual Cordis proxy target and reads account-local implementation records', async () => {
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
  const records = [...nativeAccountImplementations(account)]
  const llm = records.filter(record => record.name === 'llm')
  expect(llm, 'Native implementation registry must contain exactly this account LlmRuntime').toHaveLength(1)
  expect(llm[0]?.value).toBe(target)
  expect(llm[0]?.ctx.fiber).toBe(owner.ctx.fiber)
  expect(records.every(record => record.ctx.root === account.root)).toBe(true)
  expect(foreignOwners.every(fiber => !records.some(record => record.ctx.fiber === fiber))).toBe(true)
})
