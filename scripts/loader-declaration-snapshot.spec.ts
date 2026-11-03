/** Native declaration no-op plans retain literal expression source without executing it. */
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished, vi } from 'vitest'

async function fixture(config: unknown, declarative = true) {
  const ctx = new Context(), evaluate = vi.fn(() => true)
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('declarationProbe', evaluate)
  await ctx.plugin(Loader)
  class Declaration {
    static Config = z.object({ rows: z.any().required() })
    constructor(readonly ctx: Context) {}
  }
  if (declarative) Object.defineProperty(Declaration, EntryGroup.key, { value: true })
  ctx.loader.builtins.declaration = Declaration
  const id = await ctx.loader.create({ name: 'cordis:declaration', config })
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  return { ctx, entry, evaluate }
}

it('snapshots an unchanged original declaration expression as detached source, without evaluation', async () => {
  const config = { rows: [{ disabled: { __jsExpr: 'declarationProbe()' }, config: { prefix: 'original' } }] }
  const f = await fixture(config), plan = f.entry.prepareConfigUpdate(config)
  expect(plan.impact).toBe('none')
  expect(plan.stopped).toEqual([])
  expect(f.evaluate).not.toHaveBeenCalled()
  const snapshot: unknown = f.entry.snapshotConfigUpdatePlan(plan)
  expect(snapshot).toEqual(config)
  expect(snapshot).not.toBe(config)
  expect(() => { f.entry.assertConfigUpdatePlan(plan) }).not.toThrow()
  expect(f.evaluate).not.toHaveBeenCalled()
})

it('keeps ordinary runtime expressions unproven even when the raw options are unchanged', async () => {
  const config = { rows: [{ disabled: { __jsExpr: 'declarationProbe()' } }] }
  const f = await fixture(config, false)
  expect(f.evaluate).toHaveBeenCalledOnce()
  expect(f.entry.prepareConfigUpdate(config).impact).toBe('unknown')
  expect(f.evaluate).toHaveBeenCalledOnce()
})

it('refuses changed expression source and invalidates a retained declaration plan after source mutation', async () => {
  const expression = { __jsExpr: 'declarationProbe()' }, config = { rows: [{ disabled: expression }] }
  const f = await fixture(config), plan = f.entry.prepareConfigUpdate(config)
  expect(plan.impact).toBe('none')
  expect(f.entry.prepareConfigUpdate({ rows: [{ disabled: { __jsExpr: 'false' } }] }).impact).toBe('unknown')
  expression.__jsExpr = 'false'
  expect(() => { f.entry.assertConfigUpdatePlan(plan) }).toThrow('stale')
  expect(f.evaluate).not.toHaveBeenCalled()
})

it('refuses an otherwise ordinary config edit while a declaration retains literal expressions', async () => {
  const expression = { __jsExpr: 'declarationProbe()' }, config = { rows: [{ disabled: expression, prefix: 'original' }] }
  const f = await fixture(config)
  expect(f.entry.prepareConfigUpdate({ rows: [{ disabled: expression, prefix: 'changed' }] }).impact).toBe('unknown')
  expect(f.evaluate).not.toHaveBeenCalled()
})

it.each([
  { __jsExpr: 1 }, { __jsExpr: 'true', extra: true }, { __jsExpr: () => true },
  { callback: () => true },
])('refuses a malformed declaration snapshot %#', async (row) => {
  const config = { rows: [row] }, f = await fixture(config)
  expect(f.entry.prepareConfigUpdate(config).impact).toBe('unknown')
  expect(f.evaluate).not.toHaveBeenCalled()
})

it('does not execute an expression accessor to prepare a declaration snapshot', async () => {
  const getter = vi.fn(() => 'declarationProbe()')
  const row = Object.defineProperty({}, '__jsExpr', { get: getter, enumerable: true })
  const config = { rows: [row] }, f = await fixture(config)
  getter.mockClear()
  expect(f.entry.prepareConfigUpdate(config).impact).toBe('unknown')
  expect(getter).not.toHaveBeenCalled()
  expect(f.evaluate).not.toHaveBeenCalled()
})

it('refuses hidden and symbolic declaration properties instead of losing them in its snapshot', async () => {
  const hidden = Object.defineProperty({ __jsExpr: 'true' }, 'callback', { value: () => true })
  const symbolic = { __jsExpr: 'true', [Symbol('extra')]: 'hidden' }
  for (const row of [hidden, symbolic]) {
    const config = { rows: [row] }, f = await fixture(config)
    expect(f.entry.prepareConfigUpdate(config).impact).toBe('unknown')
  }
})

it('refuses recursive declarations rather than granting an inspectable no-op plan', async () => {
  const rows: unknown[] = []
  rows.push(rows)
  const config = { rows }, f = await fixture(config)
  expect(f.entry.prepareConfigUpdate(config).impact).toBe('unknown')
  expect(f.evaluate).not.toHaveBeenCalled()
})
