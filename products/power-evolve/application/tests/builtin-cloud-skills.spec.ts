/** Cloud-only catalog bytes, native extraction and real per-owner package publication. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { BuiltinSkillCatalog, BuiltinSkillCatalogUnavailable, builtinSkillAssetRoot } from '../src/platform/builtin-skills.ts'
import { extractSkillPackage } from '../src/platform/skill-package-extraction.ts'
import { readNativeSkillMetadata } from '../src/platform/skill-metadata.ts'
import { SkillService } from '../src/platform/skills.ts'
import { cloudFixture } from './cloud-fixture.ts'

async function copiedCatalog(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pe-builtin-cloud-'))
  try { await cp(builtinSkillAssetRoot(), root, { recursive: true }); await run(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}

async function writableFixtureDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  await chmod(path, 0o700)
  for (const entry of await readdir(path)) await writableFixtureDirectory(join(path, entry))
}

test('all nine pinned cloud releases pass native ZIP and Skill metadata validation', async () => {
  const catalog = new BuiltinSkillCatalog()
  const releases = await catalog.list()
  expect(releases).toHaveLength(9)
  for (const release of releases) {
    const loaded = await catalog.get(release.id, release.version)
    if (!loaded) throw new Error('Pinned release unavailable')
    const root = await mkdtemp(join(tmpdir(), 'pe-builtin-extract-'))
    try {
      const archive = join(root, 'archive.zip'); await writeFile(archive, loaded.archive, { flag: 'wx' })
      const entries = await extractSkillPackage(archive, root)
      const metadata = await readNativeSkillMetadata(join(root, 'skill'))
      expect(metadata.name).toBeTruthy()
      expect(entries.some(entry => entry.path === 'skill/SKILL.md')).toBe(true)
      const instructions = await readFile(join(root, 'skill', 'SKILL.md'), 'utf8')
      expect(instructions).not.toMatch(/desktop_exec|\bDevice\b/u)
      const manifest = z.object({ targets: z.array(z.string()) }).loose().parse(JSON.parse(
        await readFile(join(builtinSkillAssetRoot(), 'extensions', release.id, `${release.version}.manifest.json`), 'utf8')))
      expect(manifest.targets).toEqual(['cloud'])
      if (release.id === 'builtin.report-reviewer' || release.id === 'builtin.report-workflow-orchestrator') {
        expect(instructions).toContain(`\nversion: ${release.version}\n`)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  }
  expect(await catalog.get('../foreign', '1.0.0')).toBeNull()
  expect(await catalog.get('builtin.word', 'latest')).toBeNull()
  expect(await catalog.get('builtin.unknown', '1.0.0')).toBeNull()
})

test('catalog metadata tampering and extra release files fail without returning package paths', async () => {
  await copiedCatalog(async (root) => {
    await writeFile(join(root, 'catalog.json'), '{}\n')
    await expect(new BuiltinSkillCatalog(root).list()).rejects.toBeInstanceOf(BuiltinSkillCatalogUnavailable)
  })
  await copiedCatalog(async (root) => {
    await writeFile(join(root, 'extensions', 'builtin.word', 'foreign.zip'), 'extra')
    await expect(new BuiltinSkillCatalog(root).list()).rejects.toBeInstanceOf(BuiltinSkillCatalogUnavailable)
  })
})

test('corrupted and symlinked archive bytes cannot become a successful catalog download', async () => {
  for (const change of ['corrupt', 'symlink'] as const) {
    await copiedCatalog(async (root) => {
      const catalog = new BuiltinSkillCatalog(root)
      const word = (await catalog.list()).find(release => release.id === 'builtin.word')!
      const path = join(root, 'extensions', word.id, `${word.version}.zip`)
      if (change === 'corrupt') await writeFile(path, 'bad archive')
      else { await rm(path); await symlink(join(builtinSkillAssetRoot(), 'extensions', word.id, `${word.version}.zip`), path) }
      await expect(catalog.get(word.id, word.version)).rejects.toBeInstanceOf(BuiltinSkillCatalogUnavailable)
    })
  }
})

test('cloud publication installs all nine private packages once and retains immutable bytes after reconstruction', async () => {
  await cloudFixture(async (f) => {
    const workspace = join(f.root, 'workspace'), library = join(f.root, 'library')
    const completeCatalog = (await new BuiltinSkillCatalog().list()).map(item => item.id)
    try {
      const service = new SkillService(f.pool, workspace, library, 64, completeCatalog); await service.init()
      const catalog = await service.catalog(f.alice.user)
      await service.ensurePreinstalled(f.alice.user, catalog.items.map(item => item.id))
      const versions = await f.pool.query<{ archive_digest: string; version: string }>(
        'SELECT archive_digest,version FROM pe_skill_package_versions WHERE user_id=$1 ORDER BY archive_digest', [f.alice.user.userId])
      expect(versions.rows).toHaveLength(9)
      const snapshots = await Promise.all(versions.rows.map(async (row) => {
        const path = join(library, 'skill-packages', f.alice.user.userId, 'sha256', row.archive_digest, 'skill', 'SKILL.md')
        return { path, bytes: await readFile(path) }
      }))
      const resumed = new SkillService(f.pool, workspace, library, 64, completeCatalog); await resumed.init()
      await resumed.ensurePreinstalled(f.alice.user, catalog.items.map(item => item.id))
      expect((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_skill_package_versions')).rows[0]!.count).toBe(9)
      for (const snapshot of snapshots) expect(await readFile(snapshot.path)).toEqual(snapshot.bytes)
      const bob = await resumed.catalog(f.bob.user)
      expect(bob.items.every(item => item.installedSkillId === null)).toBe(true)
      const word = bob.items.find(item => item.id === 'builtin.word')!
      const id = randomUUID()
      const installed = await resumed.installBuiltin(f.bob.user, id, word.id, word.version)
      expect(await resumed.installBuiltin(f.bob.user, id, word.id, word.version)).toEqual(installed)
      await expect(resumed.installBuiltin(f.alice.user, id, word.id, word.version)).rejects.toMatchObject({ code: 'request_id_conflict' })
    } finally { await writableFixtureDirectory(library) }
  })
})

test('the original imported catalog generation retains its pinned bytes', async () => {
  const old = await readFile(join(dirname(builtinSkillAssetRoot()), 'generated', 'catalog.json'))
  expect(createHash('sha256').update(old).digest('hex'))
    .toBe('cfb925c4258802fb93c2510eda4129d303ff08e146936676be4f4ff34de8e0b1')
})
