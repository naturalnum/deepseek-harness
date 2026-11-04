/** Readonly binary credits remain separate from unchanged user storage, import and JSON quotas. */
import { expect, it } from 'vitest'
import { ReleaseSkillBinaryBudget } from '../src/release-skill-binary-budget.ts'

const limits = { maxArchiveBytes: 10, chunkBytes: 2, maxResidentBytes: 12, maxConcurrent: 1, timeoutMs: 30000 }
it('holds complete ZIP and outgoing chunk credits until actual consumer settlement', async () => {
  const budget = new ReleaseSkillBinaryBudget(limits), held = Promise.withResolvers<undefined>()
  const active = budget.withArchive(10, () => held.promise)
  expect(budget.snapshot()).toEqual({ active: 1, residentBytes: 12, cleanupUnknown: 0 })
  await expect(budget.withArchive(1, async () => {})).rejects.toMatchObject({ code: 'cloud/capacity' })
  held.resolve(undefined); await active
  expect(budget.snapshot()).toEqual({ active: 0, residentBytes: 0, cleanupUnknown: 0 })
})
it('refuses oversized archives before calling the source and retains explicitly unknown credits', async () => {
  const budget = new ReleaseSkillBinaryBudget(limits)
  let called = false
  await expect(budget.withArchive(11, async () => { called = true })).rejects.toMatchObject({ code: 'cloud/capacity' })
  expect(called).toBe(false)
  await budget.withArchive(10, async (retain) => { retain(new Error('Original response close unknown')); retain(new Error('No duplicate credit')) })
  expect(budget.snapshot()).toEqual({ active: 1, residentBytes: 12, cleanupUnknown: 1 })
  await expect(budget.withArchive(1, async () => {})).rejects.toMatchObject({ code: 'cloud/capacity' })
})
it('rejects nonfinite and insufficient policies without inventing a deployment default', () => {
  expect(() => new ReleaseSkillBinaryBudget({ ...limits, timeoutMs: Infinity })).toThrow(RangeError)
  expect(() => new ReleaseSkillBinaryBudget({ ...limits, maxResidentBytes: 11 })).toThrow(RangeError)
})
