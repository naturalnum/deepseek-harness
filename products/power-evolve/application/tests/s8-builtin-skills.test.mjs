/** Pinned releases must match the current package importer before any user-facing route is added. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BuiltinSkillCatalog, BuiltinSkillCatalogUnavailable,
  builtinSkillAssetRoot } from '../lib/platform/builtin-skills.js'
import { extractSkillPackage } from '../lib/platform/skill-package-extraction.js'
import { readNativeSkillMetadata } from '../lib/platform/skill-metadata.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('all nine committed releases pass the current ZIP and native metadata validators', async t => {
  const catalog = new BuiltinSkillCatalog()
  const releases = await catalog.list()
  const committed = JSON.parse(await readFile(join(builtinSkillAssetRoot(), 'catalog.json'), 'utf8'))
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
    const office = ['builtin.word', 'builtin.excel', 'builtin.powerpoint'].includes(release.id)
    const targets = office ? ['cloud', 'desktop'] : ['cloud']
    const distributed = committed.items.find(item => item.extension.id === release.id).release
    assert.deepEqual(distributed.targets, targets)
    const manifest = JSON.parse(await readFile(join(builtinSkillAssetRoot(),
      `extensions/${release.id}/${release.version}.manifest.json`), 'utf8'))
    assert.deepEqual(manifest.targets, targets)
    if (office) {
      assert.equal(release.version, '1.0.2')
      const instructions = await readFile(join(extracted, 'skill/SKILL.md'), 'utf8')
      assert.match(instructions, /authorized execution image/u)
      assert.match(instructions, /`cloud_exec` for cloud work or `desktop_exec` for the selected, locally authorized Device/u)
      assert.match(instructions, /Keep rendering in the same target as the editable file/u)
      assert.match(instructions, /Use the `office` tool/u)
      assert.equal(JSON.parse(await readFile(join(extracted, 'skill/SOURCE.json'), 'utf8')).productVersion, '1.0.2')
    }
  }
})

test('the actual loader rejects unsupported targets and release/manifest mismatch with a valid fixture pin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pe-s8-targets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const loader = await readFile(new URL('../lib/platform/builtin-skills.js', import.meta.url), 'utf8')
  const pin = /const CATALOG_SHA256 = '[a-f0-9]{64}';/u
  assert.match(loader, pin)
  for (const [index, targets] of [['cloud'], ['desktop'], ['desktop', 'cloud'], ['cloud', 'desktop', 'desktop']].entries()) {
    const assets = join(root, String(index))
    await cp(builtinSkillAssetRoot(), assets, { recursive: true })
    const catalogFile = join(assets, 'catalog.json')
    const catalog = JSON.parse(await readFile(catalogFile, 'utf8'))
    catalog.items.find(item => item.extension.id === 'builtin.word').release.targets = targets
    const bytes = Buffer.from(JSON.stringify(catalog) + '\n')
    await writeFile(catalogFile, bytes)
    // Preserve the real parser and reader; only the trusted asset pin and zod resolution change.
    const module = loader.replace(pin, `const CATALOG_SHA256 = '${digest(bytes)}';`)
      .replace("from 'zod'", `from ${JSON.stringify(import.meta.resolve('zod'))}`)
    const path = join(root, `loader-${index}.mjs`)
    await writeFile(path, module)
    const { BuiltinSkillCatalog: FixtureCatalog, BuiltinSkillCatalogUnavailable: FixtureUnavailable }
      = await import(pathToFileURL(path).href)
    await assert.rejects(new FixtureCatalog(assets).list(), FixtureUnavailable)
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
  const zip = join(damagedZip, 'extensions/builtin.word/1.0.2.zip')
  const zipBytes = await readFile(zip)
  zipBytes[0] ^= 1
  await writeFile(zip, zipBytes)
  const lazyCatalog = new BuiltinSkillCatalog(damagedZip)
  assert.equal((await lazyCatalog.list()).length, 9)
  await assert.rejects(lazyCatalog.get('builtin.word', '1.0.2'), BuiltinSkillCatalogUnavailable)
  assert((await lazyCatalog.get('builtin.pdf', '1.0.0'))?.archive.length)

  const damagedManifest = await clone('manifest')
  const manifest = join(damagedManifest, 'extensions/builtin.word/1.0.2.manifest.json')
  await writeFile(manifest, '{}')
  await assert.rejects(new BuiltinSkillCatalog(damagedManifest).get('builtin.word', '1.0.2'),
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
