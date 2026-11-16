/** Project-copy publication and reuse; native staging/FD isolation remains in the existing Linux interop suite. */
import { expect, it, vi } from 'vitest'
import { FdMutationFailure } from '../src/worker-client.ts'
import { materializeWorkspaceSkill } from '../src/workspace-skill.ts'
import { workspaceSkillFixture as fixture } from './fixtures/workspace-skill.ts'

it('publishes complete nested resources and binary bytes before the instruction file', async () => {
  const f = fixture(), base = await materializeWorkspaceSkill(f.work)
  expect(base).toBe(`.skills/${f.version.id}`)
  expect(f.order.at(-1)).toBe(`${base}/SKILL.md`)
  for (const [name, data] of f.members) expect(f.published.get(`${base}/${name}`)).toEqual(data)
  expect(f.directories).toEqual(new Set(['.skills', base, `${base}/scripts`, `${base}/data`]))
})

it('reuses complete Workspace copies and preserves user modifications without another publication', async () => {
  const f = fixture(), base = await materializeWorkspaceSkill(f.work), custom = Uint8Array.from([42, 0, 255])
  f.published.set(`${base}/data/value.bin`, custom)
  const before = f.order.length
  await expect(materializeWorkspaceSkill(f.work)).resolves.toBe(base)
  expect(f.published.get(`${base}/data/value.bin`)).toBe(custom)
  expect(f.order).toHaveLength(before)
})

it('refuses an incomplete prior copy without overwriting, deleting or replaying it', async () => {
  const f = fixture(), base = `.skills/${f.version.id}`
  f.directories.add('.skills'); f.directories.add(base)
  const original = Uint8Array.from([9]); f.published.set(`${base}/partial.bin`, original)
  await expect(materializeWorkspaceSkill(f.work)).rejects.toMatchObject({ code: 'files/prerequisite-missing' })
  // oxlint-disable-next-line typescript/unbound-method -- These fixture methods are spies inspected without invocation.
  expect(f.work.publish).not.toHaveBeenCalled(); expect(f.work.createDirectory).not.toHaveBeenCalled()
  expect(f.published.get(`${base}/partial.bin`)).toBe(original)
})

it('retains the exact unknown publication failure and never advertises incomplete instructions', async () => {
  const f = fixture(), failure = new FdMutationFailure('unknown', 'FS_IO_ERROR')
  f.work.publish = vi.fn().mockRejectedValue(failure)
  await expect(materializeWorkspaceSkill(f.work)).rejects.toBe(failure)
  expect(f.order).toHaveLength(0)
  expect(f.published.has(`.skills/${f.version.id}/SKILL.md`)).toBe(false)
})
