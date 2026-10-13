/** Deployment availability over the complete pinned assets and retained real per-owner PG history. */
import { randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { requestId, skillSelection } from '../src/contracts.ts'
import { BuiltinSkillCatalog, BuiltinSkillCatalogUnavailable, builtinSkillAssetRoot } from '../src/platform/builtin-skills.ts'
import { SkillService } from '../src/platform/skills.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

async function writableDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  await chmod(path, 0o700)
  for (const entry of await readdir(path)) await writableDirectory(join(path, entry))
}

test.each([{ ids: ['builtin.missing'] }, { ids: ['builtin.pdf', 'builtin.pdf'] }])('availability rejects invalid configured IDs $ids', ({ ids }) => {
  expect(() => new BuiltinSkillCatalog(undefined, ids)).toThrow()
})

test('availability copies configured IDs and an empty selection disables every retained release', async () => {
  const ids = ['builtin.pdf']
  const catalog = new BuiltinSkillCatalog(undefined, ids)
  ids.push('builtin.word')
  expect((await catalog.list()).map(item => item.id)).toEqual(['builtin.pdf'])
  expect(await catalog.get('builtin.word', '1.0.3')).toBeNull()
  const disabled = new BuiltinSkillCatalog(undefined, [])
  expect(await disabled.list()).toEqual([])
  expect(await disabled.get('builtin.pdf', '1.0.0')).toBeNull()
})

test('PDF availability still verifies the retained non-PDF manifests before filtering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pe-builtin-availability-'))
  try {
    await cp(builtinSkillAssetRoot(), root, { recursive: true })
    await writeFile(join(root, 'extensions', 'builtin.word', '1.0.3.manifest.json'), '{}\n')
    const catalog = new BuiltinSkillCatalog(root, ['builtin.pdf'])
    await expect(catalog.list()).rejects.toBeInstanceOf(BuiltinSkillCatalogUnavailable)
    await expect(catalog.get('builtin.pdf', '1.0.0')).rejects.toBeInstanceOf(BuiltinSkillCatalogUnavailable)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('PDF-only catalog and installation retain the prior non-PDF package and frozen task selection', async () => {
  await cloudFixture(async (f) => {
    const workspace = join(f.root, 'workspace'), library = join(f.root, 'library')
    try {
      const prior = new SkillService(f.pool, workspace, library, 64, ['builtin.word'])
      await prior.init()
      const word = (await prior.catalog(f.alice.user)).items[0]!
      const installed = z.object({ skillId: z.uuid(), packageDigest: z.string() }).loose().parse(
        await prior.installBuiltin(f.alice.user, randomUUID(), word.id, word.version))
      const original = await prior.read(f.alice.user, installed.skillId)
      const path = join(library, 'skill-packages', f.alice.user.userId, 'sha256', installed.packageDigest, 'skill', 'SKILL.md')
      const bytes = await readFile(path)
      const tasks = new TaskStore(f.pool, { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 })
      const session = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
      const accepted = requestId.parse(randomUUID())
      await tasks.accept(f.alice.user, session.sessionId, accepted, 'Retained Word selection', f.alice.token)
      const select = async () => z.array(skillSelection).parse((await f.pool.query<{ skill_selection: unknown }>(
        'SELECT skill_selection FROM pe_operations WHERE session_id=$1 AND request_id=$2', [session.sessionId, accepted])).rows[0]!.skill_selection)
      const frozen = await select()
      expect(frozen).toHaveLength(1)
      expect(frozen[0]!.skillId).toBe(installed.skillId)
      const ids = ['builtin.pdf']
      const service = new SkillService(f.pool, workspace, library, 64, ids)
      ids.push('builtin.word')
      await service.init()
      expect((await service.catalog(f.alice.user)).items.map(item => item.id)).toEqual(['builtin.pdf'])
      const defaultService = new SkillService(f.pool, workspace, library)
      expect((await defaultService.catalog(f.alice.user)).items.map(item => item.id)).toEqual(['builtin.pdf'])
      await expect(service.installBuiltin(f.alice.user, randomUUID(), word.id, word.version))
        .rejects.toMatchObject({ status: 404, code: 'builtin_skill_not_found' })
      await expect(service.ensurePreinstalled(f.alice.user, ['builtin.word']))
        .rejects.toMatchObject({ status: 404, code: 'builtin_skill_not_found' })
      const availablePdf = (await service.catalog(f.alice.user)).items[0]!
      const pdfRequest = randomUUID()
      const installedPdf = z.object({ skillId: z.uuid(), kind: z.literal('package'), version: z.string(),
        packageDigest: z.string() }).loose().parse(
        await service.installBuiltin(f.alice.user, pdfRequest, availablePdf.id, availablePdf.version))
      expect(installedPdf.version).toBe(availablePdf.version)
      expect(installedPdf.packageDigest).toBe(availablePdf.archiveDigest)
      expect(await service.installBuiltin(f.alice.user, pdfRequest, availablePdf.id, availablePdf.version)).toEqual(installedPdf)
      await service.ensurePreinstalled(f.alice.user, ['builtin.pdf'])
      const pdf = (await service.catalog(f.alice.user)).items[0]!
      expect(pdf.id).toBe('builtin.pdf')
      expect(pdf.installedSkillId).toBe(installedPdf.skillId)
      expect((await service.list(f.alice.user)).items).toHaveLength(2)
      expect(await service.read(f.alice.user, installed.skillId)).toEqual(original)
      expect(await readFile(path)).toEqual(bytes)
      expect(await select()).toEqual(frozen)
      const snapshots = z.array(z.object({ instructions: z.string(), packageDigest: z.string() }).loose())
        .parse(await service.snapshot(f.alice.user.userId, frozen))
      expect(snapshots[0]!.instructions).toBe(original.instructions)
      expect(snapshots[0]!.packageDigest).toBe(installed.packageDigest)
      expect((await f.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM pe_skill_package_versions')).rows[0]!.count).toBe(2)
    } finally { await writableDirectory(library) }
  })
})
