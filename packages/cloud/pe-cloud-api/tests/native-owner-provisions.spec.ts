/** Real Loader service ownership across isolation, bounded inspection and pending disposal. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { nativeFiberProvisions, nativeProvision } from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { expect, it, onTestFinished } from 'vitest'
import { firstScreenNativeOwner } from '../src/native-first-screen.ts'

class OwnerService extends Service {
  constructor(ctx: Context) { super(ctx, 'goals') }
}

async function fixture(options: { duplicate?: boolean; holdDisposal?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'native-owner-provisions-')))
  const profile = join(directory, 'cordis.yml')
  writeFileSync(profile, JSON.stringify([{ id: 'owner', name: 'cordis:fixture-native-owner' }]))
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const owned: { value?: OwnerService; context?: Context } = {}
  onTestFinished(async () => {
    release.resolve(undefined)
    try { await owned.context?.fiber.dispose() } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  const ctx = await boot('native-owner-provisions', profile, [], (root) => {
    owned.context = root
    root.loader.builtins['fixture-native-owner'] = { apply(owner: Context) {
      owned.value = new OwnerService(owner)
      if (options.duplicate) new OwnerService(owner.isolate('goals'))
      if (options.holdDisposal) owner.effect(() => async () => {
        entered.resolve(undefined)
        await release.promise
      }, 'fixture: hold original provider cleanup')
    } }
  })
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'owner')
  if (entry?.fiber === undefined || owned.value === undefined) throw new Error('The native owner fixture did not activate')
  return { ctx, fiber: entry.fiber.ctx.fiber, value: owned.value, entered, release }
}

it('uses the sole original Loader provision and rejects isolated duplicates in that same fiber', async () => {
  const sole = await fixture()
  expect(firstScreenNativeOwner(sole.ctx, 'goals', sole.value, 64)).toEqual({ value: sole.value, fiber: sole.fiber })
  expect(nativeProvision(sole.fiber, 'goals')?.value).toBe(sole.value)
  const duplicate = await fixture({ duplicate: true })
  expect(duplicate.ctx.get('goals')).toBeDefined()
  expect([...nativeFiberProvisions(duplicate.fiber)].filter(row => row.name === 'goals')).toHaveLength(2)
  expect(nativeProvision(duplicate.fiber, 'goals')).toBeUndefined()
  expect(() => firstScreenNativeOwner(duplicate.ctx, 'goals', duplicate.value, 64))
    .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('charges the existing inspection bound for actual provisions, including unrelated service names', async () => {
  const f = await fixture()
  expect(firstScreenNativeOwner(f.ctx, 'goals', f.value, 64).fiber).toBe(f.fiber)
  for (let index = 0; index < 64; index++) f.fiber.ctx.provide(`fixture-extra-${index}`, {})
  expect(() => firstScreenNativeOwner(f.ctx, 'goals', f.value, 64))
    .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('retains the original provision until actual cleanup settles without treating it as an active owner', async () => {
  const f = await fixture({ holdDisposal: true })
  const provision = nativeProvision(f.fiber, 'goals')
  expect(provision?.value).toBe(f.value)
  if (provision === undefined) throw new Error('The original native provision is absent')
  const stopping = f.fiber.dispose()
  await f.entered.promise
  expect(nativeFiberProvisions(f.fiber).has(provision)).toBe(true)
  expect(() => firstScreenNativeOwner(f.ctx, 'goals', f.value, 64))
    .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  f.release.resolve(undefined)
  await stopping
  expect([...nativeFiberProvisions(f.fiber)].filter(row => row.name === 'goals')).toEqual([])
})
