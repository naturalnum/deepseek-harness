/** Pinned releases must match the current package importer before any user-facing route is added. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuiltinSkillCatalog, BuiltinSkillCatalogUnavailable,
  builtinSkillAssetRoot } from '../lib/platform/builtin-skills.js'
import { extractSkillPackage } from '../lib/platform/skill-package-extraction.js'
import { readNativeSkillMetadata } from '../lib/platform/skill-metadata.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('all nine committed releases pass the current ZIP and native metadata validators', async t => {
  const catalog = new BuiltinSkillCatalog()
  const releases = await catalog.list()
  assert.equal(releases.length, 9)
  assert.equal(new Set(releases.map(item => item.id)).size, 9)
  const root = await mkdtemp(join(tmpdir(), 'pe-s8-builtin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const release of releases) {
    const loaded = await catalog.get(release.id, release.version)
    assert(loaded)
    assert.deepEqual(loaded.release, release)
    assert.equal(loaded.archive.length, release.archiveSize)
    assert.equal(digest(loaded.archive), release.archiveDigest)
    const folder = join(root, release.id)
    await mkdir(folder)
    const archive = join(folder, 'archive.zip'), extracted = join(folder, 'unpacked')
    await writeFile(archive, loaded.archive)
    await mkdir(extracted)
    const files = await extractSkillPackage(archive, extracted)
    const metadata = await readNativeSkillMetadata(join(extracted, 'skill'))
    assert(metadata.name.length > 0)
    assert(metadata.description.length > 0)
    assert(files.some(file => file.path === 'skill/SKILL.md'))
    assert(files.length <= 256)
    assert(files.reduce((size, file) => size + file.size, 0) <= 8 * 1024 * 1024)
  }
})

test('unknown IDs and versions cannot name filesystem paths', async () => {
  const catalog = new BuiltinSkillCatalog()
  assert.equal(await catalog.get('builtin.missing', '1.0.0'), null)
  assert.equal(await catalog.get('builtin.word', '9.0.0'), null)
  for (const id of ['../pdf', 'builtin.word/../../pdf', 'builtin.word%2f..', '/tmp', 'builtin..word']) {
    assert.equal(await catalog.get(id, '1.0.0'), null)
  }
  assert.equal(await catalog.get('builtin.word', '../1.0.0'), null)
})

test('catalog, manifest, archive and directory tampering fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pe-s8-tamper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = builtinSkillAssetRoot()
  const clone = async name => {
    const target = join(root, name)
    await cp(source, target, { recursive: true })
    return target
  }
  const damagedZip = await clone('zip')
  const zip = join(damagedZip, 'extensions/builtin.word/1.0.0.zip')
  const zipBytes = await readFile(zip)
  zipBytes[0] ^= 1
  await writeFile(zip, zipBytes)
  const lazyCatalog = new BuiltinSkillCatalog(damagedZip)
  assert.equal((await lazyCatalog.list()).length, 9)
  await assert.rejects(lazyCatalog.get('builtin.word', '1.0.0'), BuiltinSkillCatalogUnavailable)
  assert((await lazyCatalog.get('builtin.pdf', '1.0.0'))?.archive.length)

  const damagedManifest = await clone('manifest')
  const manifest = join(damagedManifest, 'extensions/builtin.word/1.0.0.manifest.json')
  await writeFile(manifest, '{}')
  await assert.rejects(new BuiltinSkillCatalog(damagedManifest).get('builtin.word', '1.0.0'),
    BuiltinSkillCatalogUnavailable)

  const damagedCatalog = await clone('catalog')
  const catalogFile = join(damagedCatalog, 'catalog.json')
  const catalogBytes = await readFile(catalogFile, 'utf8')
  await writeFile(catalogFile, catalogBytes.replace('builtin.word', 'builtin.xord'))
  await assert.rejects(new BuiltinSkillCatalog(damagedCatalog).list(), BuiltinSkillCatalogUnavailable)

  const escapedDirectory = await clone('symlink')
  const directory = join(escapedDirectory, 'extensions/builtin.word')
  await rm(directory, { recursive: true })
  await symlink(join(source, 'extensions/builtin.word'), directory, 'dir')
  await assert.rejects(new BuiltinSkillCatalog(escapedDirectory).list(), BuiltinSkillCatalogUnavailable)

  const unexpectedFile = await clone('extra')
  const extra = await open(join(unexpectedFile, 'extensions/builtin.word/extra.zip'),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  await extra.close()
  assert((await readdir(join(unexpectedFile, 'extensions/builtin.word'))).includes('extra.zip'))
  await assert.rejects(new BuiltinSkillCatalog(unexpectedFile).list(), BuiltinSkillCatalogUnavailable)
})
