/** Actual root Include composition, replacement guards and original live references. */
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it, onTestFinished, vi } from 'vitest'
import { configurationFixture } from './configuration-fixture.ts'

const rootEntries = Array.from({ length: 5 }, (_, index) => ({
  id: `base-${index}`, name: 'cordis:probe', config: { ordinary: `base-${index}` },
}))

it('applies a live profile row above five immutable base rows through native Include patch semantics', async () => {
  const dispose = vi.fn()
  const f = await configurationFixture({ hmr: false, rootEntries, apply(owner) { owner.effect(() => dispose) } })
  const entries = f.ctx.configEditor.entries()
  const identities = entries.map(row => [row, row.fiber] as const)
  const target = entries.find(row => row.options.id === 'first')!
  const pinned = entries.map(entry => entry.prepareConfigUpdate(entry.options.config))
  const beforeRoot = readFileSync(f.profile.dir + '/cordis.yml', 'utf8')
  const targetConfig: unknown = target.fiber!.config
  onTestFinished(f.ctx.configEditor.registerImpactGuard({ check(plan) {
    expect(plan.impact).toBe('live')
    expect(plan.entries).toHaveLength(10)
    expect(plan.entries.every(row => row.stopped?.length === 0)).toBe(true)
  } }))
  await f.ctx.settings.update('first', { count: 5 })
  expect(f.ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 5 })
  expect(target.fiber!.config).toBe(targetConfig)
  for (const [entry, fiber] of identities) expect(entry.fiber).toBe(fiber)
  for (const plan of pinned) {
    if (plan.entry === target) expect(() => { plan.entry.assertConfigUpdatePlan(plan) }).toThrow('stale')
    else expect(() => { plan.entry.assertConfigUpdatePlan(plan) }).not.toThrow()
  }
  expect(readFileSync(f.profile.dir + '/cordis.yml', 'utf8')).toBe(beforeRoot)
  expect(readFileSync(f.profile.patchPath, 'utf8')).toContain('count: 5')
  expect(dispose).not.toHaveBeenCalled()
})

it('refuses a changed nonempty base before replacement with an owner-issued not-published receipt', async () => {
  const f = await configurationFixture({ hmr: false, rootEntries })
  const path = f.profile.dir + '/cordis.yml'
  const before = readFileSync(f.profile.patchPath, 'utf8')
  onTestFinished(f.ctx.configEditor.registerImpactGuard({ check() {
    writeFileSync(path, JSON.stringify([...rootEntries, { id: 'extra', name: 'cordis:probe', config: { ordinary: 'extra' } }]))
  } }))
  const error: unknown = await f.ctx.settings.update('first', { count: 5 }).catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(Error)
  expect(f.ctx.configEditor.editFailureOutcome(error)).toBe('not-published')
  expect(f.ctx.configEditor.editFailureOutcome(new Error('copied'))).toBeUndefined()
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe(before)
})

it('rechecks an original caller after asynchronous policy work before atomic replacement', async () => {
  const f = await configurationFixture({ hmr: false, rootEntries })
  const entry = f.ctx.configEditor.entries().find(row => row.options.id === 'first')!
  const before = readFileSync(f.profile.patchPath, 'utf8')
  let current = true
  const refusal = Object.freeze(new Error('original caller ended'))
  onTestFinished(f.ctx.configEditor.registerImpactGuard({ async check() { await Promise.resolve(); current = false } }))
  await expect(f.ctx.configEditor.edit(entry, raw => ({ ...raw, count: 5 }), {
    assertCurrent() { if (!current) throw refusal },
  })).rejects.toBe(refusal)
  expect(f.ctx.configEditor.editFailureOutcome(refusal)).toBe('not-published')
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe(before)
})
