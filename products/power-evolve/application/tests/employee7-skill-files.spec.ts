/** Real ZIP/YAML and owned filesystem validation; no parser or filesystem substitutes. */
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { zipSync, type Zippable } from 'fflate'
import { expect, test } from 'vitest'
import { BuiltinSkillCatalog, BuiltinSkillCatalogUnavailable, builtinSkillAssetRoot } from '../src/platform/builtin-skills.ts'
import { extractSkillPackage, MAX_ARCHIVE_BYTES } from '../src/platform/skill-package-extraction.ts'
import { makeSkillDirectoryTreeWritable, skillPackageManifest, skillPackageVersion, verifyPublishedSkillPackage } from '../src/platform/skill-package-manifest.ts'
import { readNativeSkillMetadata } from '../src/platform/skill-metadata.ts'
import { publishReportSuite, type ReportSuiteSource } from '../src/platform/report-skill-suite.ts'

const instructions = Buffer.from('---\nname: employee-seven\ndescription: "真实 YAML: 中文说明"\n---\nOwned instructions.\n')
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const zip = (files: Zippable): Buffer => Buffer.from(zipSync(files, { level: 6 }))

async function writable(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  await chmod(path, 0o700)
  for (const entry of await readdir(path)) await writable(join(path, entry))
}

async function fixture(run: (root: string) => Promise<void>, temporaryDirectory = tmpdir()): Promise<void> {
  const root = await mkdtemp(join(temporaryDirectory, 'pe-employee7-files-'))
  try { await run(root) }
  finally { await writable(root); await rm(root, { recursive: true, force: true }) }
}

async function unpack(root: string, bytes: Buffer): Promise<Awaited<ReturnType<typeof extractSkillPackage>>> {
  await writeFile(join(root, 'archive.zip'), bytes, { flag: 'wx', mode: 0o600 })
  return extractSkillPackage(join(root, 'archive.zip'), root)
}

function centralOffset(bytes: Buffer): number {
  const end = bytes.length - 22
  if (bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('Fixture ZIP has an unexpected footer')
  return bytes.readUInt32LE(end + 16)
}

test.each([
  { name: '80 character name', skillName: 'a'.repeat(80), description: 'bounded' },
  { name: '500 Unicode code points', skillName: 'employee-seven', description: '😀'.repeat(500) },
  { name: 'permitted text whitespace', skillName: 'employee-seven', description: 'a\tb\rc\nd' },
])('native metadata accepts $name without changing authored text', ({ skillName, description }) => fixture(async (root) => {
  await mkdir(join(root, 'skill'))
  await writeFile(join(root, 'skill/SKILL.md'), `---\nname: ${JSON.stringify(skillName)}\ndescription: ${JSON.stringify(description)}\n---\nOwned body.\n`)
  expect(await readNativeSkillMetadata(join(root, 'skill'))).toEqual({ name: skillName, description })
}))

test.each([
  { name: '81 character name', skillName: 'a'.repeat(81), description: 'bounded' },
  { name: '501 Unicode code points', skillName: 'employee-seven', description: '😀'.repeat(501) },
  { name: '1001 single-byte characters', skillName: 'employee-seven', description: 'a'.repeat(1001) },
  { name: 'description control character', skillName: 'employee-seven', description: 'a\u001fb' },
  { name: 'description delete character', skillName: 'employee-seven', description: 'a\u007fb' },
])('native metadata rejects $name from genuine YAML bytes', ({ skillName, description }) => fixture(async (root) => {
  await mkdir(join(root, 'skill'))
  const bytes = `---\nname: ${JSON.stringify(skillName)}\ndescription: ${JSON.stringify(description)}\n---\nOwned body.\n`
  await writeFile(join(root, 'skill/SKILL.md'), bytes)
  await expect(readNativeSkillMetadata(join(root, 'skill'))).rejects.toMatchObject({ status: 400, code: 'invalid_skill_metadata' })
  expect(await readFile(join(root, 'skill/SKILL.md'), 'utf8')).toBe(bytes)
}))

test.each(['root symlink', 'regular file root'] as const)('published package rejects a %s without altering its original tree', mode => fixture(async (root) => {
  const original = join(root, 'original')
  await mkdir(original)
  const bytes = zip({ 'SKILL.md': instructions })
  const files = await unpack(original, bytes)
  const manifest = skillPackageManifest(digest(bytes), files)
  await writeFile(join(original, 'manifest.json'), manifest)
  await rm(join(original, 'archive.zip'))
  await verifyPublishedSkillPackage(original, manifest, files)
  const path = join(root, 'published')
  if (mode === 'root symlink') await symlink(original, path)
  else await writeFile(path, 'owned regular file')
  await expect(verifyPublishedSkillPackage(path, manifest, files)).rejects.toMatchObject({ status: 503, code: 'skill_package_unavailable' })
  expect(await readFile(join(original, 'skill/SKILL.md'))).toEqual(instructions)
  await verifyPublishedSkillPackage(original, manifest, files)
}))

test('staging cleanup skips a symbolic root without changing its target', () => fixture(async (root) => {
  const target = join(root, 'sentinel'), path = join(root, 'staging')
  await mkdir(target, { mode: 0o700 })
  await writeFile(join(target, 'retained.txt'), 'retained cleanup sentinel')
  await chmod(target, 0o500)
  await symlink(target, path)
  let invalidCalls = 0
  await makeSkillDirectoryTreeWritable(path, () => { invalidCalls++ })
  expect(invalidCalls).toBe(1)
  expect((await lstat(path)).isSymbolicLink()).toBe(true)
  expect((await lstat(target)).mode & 0o777).toBe(0o500)
  expect(await readFile(join(target, 'retained.txt'), 'utf8')).toBe('retained cleanup sentinel')
}))

test('staging cleanup propagates a non-missing lookup failure without changing its parent file', () => fixture(async (root) => {
  const parent = join(root, 'retained.txt'), bytes = 'retained cleanup sentinel'
  await writeFile(parent, bytes, { mode: 0o400 })
  let invalidCalls = 0
  await expect(makeSkillDirectoryTreeWritable(join(parent, 'staging'), () => { invalidCalls++ }))
    .rejects.toMatchObject({ code: 'ENOTDIR' })
  expect(invalidCalls).toBe(0)
  expect((await lstat(parent)).mode & 0o777).toBe(0o400)
  expect(await readFile(parent, 'utf8')).toBe(bytes)
}))

test('published package rejects a live Unix socket occupying an expected regular resource path', () => fixture(async (root) => {
  const packageRoot = join(root, 'published')
  await mkdir(packageRoot)
  const bytes = zip({ 'SKILL.md': instructions, 'resource.txt': Buffer.from('owned resource') })
  const files = await unpack(packageRoot, bytes)
  const manifest = skillPackageManifest(digest(bytes), files)
  await writeFile(join(packageRoot, 'manifest.json'), manifest)
  await rm(join(packageRoot, 'archive.zip'))
  const resource = join(packageRoot, 'skill/resource.txt')
  await rm(resource)
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(resource, resolve) })
  try {
    expect((await lstat(resource)).isSocket()).toBe(true)
    await expect(verifyPublishedSkillPackage(packageRoot, manifest, files)).rejects.toMatchObject({ status: 503, code: 'skill_package_unavailable' })
    expect(await readFile(join(packageRoot, 'skill/SKILL.md'))).toEqual(instructions)
    expect((await lstat(resource)).isSocket()).toBe(true)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }
}, process.platform === 'linux' ? '/tmp' : tmpdir()))

test('native YAML and ZIP extraction preserve sorted digests, executable mode and authored semantic version', () => fixture(async (root) => {
  const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, version: '1.2.3-rc.1+owned' }))
  const script = Buffer.from('#!/bin/sh\nprintf employee7\n')
  const bytes = zip({ 'employee-seven/SKILL.md': instructions, 'employee-seven/scripts/run.sh': [script, { attrs: 0o100755 << 16 }],
    'employee-seven/skill-package.json': metadata, 'employee-seven/empty.txt': Buffer.alloc(0) })
  const files = await unpack(root, bytes)
  expect(files.map(file => file.path)).toEqual(['skill/SKILL.md', 'skill/empty.txt', 'skill/scripts/run.sh', 'skill/skill-package.json'])
  for (const file of files) {
    const actual = await readFile(join(root, file.path))
    expect(actual.length).toBe(file.size)
    expect(digest(actual)).toBe(file.sha256)
  }
  expect((await lstat(join(root, 'skill/scripts/run.sh'))).mode & 0o777).toBe(0o555)
  expect((await lstat(join(root, 'skill/SKILL.md'))).mode & 0o777).toBe(0o444)
  expect(await readNativeSkillMetadata(join(root, 'skill'))).toEqual({ name: 'employee-seven', description: '真实 YAML: 中文说明' })
  expect(await skillPackageVersion(join(root, 'skill'), digest(bytes), files)).toBe('1.2.3-rc.1+owned')
  const manifest = skillPackageManifest(digest(bytes), files)
  await writeFile(join(root, 'manifest.json'), manifest, { mode: 0o444 })
  await rm(join(root, 'archive.zip'))
  await verifyPublishedSkillPackage(root, manifest, files)
}))

const invalidPaths = ['../escape', 'a/../escape', '/absolute', 'a//b', 'a/./b', 'a\\b', 'a:b', 'a\u007fb', 'a\nb', 'e\u0301.txt', 'x'.repeat(513)]
test.each(invalidPaths)('ZIP path %j is rejected before any file is extracted', path => fixture(async (root) => {
  await expect(unpack(root, zip({ 'SKILL.md': instructions, [path]: Buffer.from('owned') })))
    .rejects.toMatchObject({ status: 400, code: 'invalid_skill_package' })
  expect(await readdir(root)).toEqual(['archive.zip'])
}))

test.each([
  { name: 'two skill roots', files: { 'SKILL.md': instructions, 'second/SKILL.md': instructions } },
  { name: 'files outside the sole skill root', files: { 'one/SKILL.md': instructions, 'outside.txt': instructions } },
  { name: 'empty instruction file', files: { 'SKILL.md': Buffer.alloc(0) } },
  { name: 'oversized instruction file', files: { 'SKILL.md': Buffer.alloc(262_145, 65) } },
  { name: 'no instruction file', files: { 'README.md': instructions } },
  { name: 'a file also used as a parent directory', files: { 'SKILL.md': instructions, scripts: instructions, 'scripts/run.sh': instructions } },
  { name: 'excess expanded bytes', files: { 'SKILL.md': instructions, 'bomb.txt': Buffer.alloc(8 * 1024 * 1024, 65) } },
] satisfies { name: string; files: Zippable }[])('ZIP rejects $name before creating a skill directory', ({ files }) => fixture(async (root) => {
  await expect(unpack(root, zip(files))).rejects.toMatchObject({ code: 'invalid_skill_package' })
  expect(await readdir(root)).toEqual(['archive.zip'])
}))

test.each([
  { name: 'encrypted central entry', offset: 8, value: 1, width: 2 },
  { name: 'unsupported compression', offset: 10, value: 12, width: 2 },
  { name: 'symlink mode', offset: 38, value: (0o120777 << 16) >>> 0, width: 4 },
  { name: 'directory mode on a regular file', offset: 38, value: (0o040755 << 16) >>> 0, width: 4 },
])('ZIP rejects $name from real central-directory bytes', ({ offset, value, width }) => fixture(async (root) => {
  const bytes = zip({ 'SKILL.md': instructions })
  const location = centralOffset(bytes) + offset
  if (width === 2) bytes.writeUInt16LE(value, location)
  else bytes.writeUInt32LE(value, location)
  await expect(unpack(root, bytes)).rejects.toMatchObject({ code: 'invalid_skill_package' })
}))

test('ZIP bounds entry counts, directory allocation and implicit directory tree before extraction', async () => {
  await fixture(async (root) => {
    const bytes = zip({ 'SKILL.md': instructions })
    bytes.writeUInt16LE(257, bytes.length - 22 + 8)
    bytes.writeUInt16LE(257, bytes.length - 22 + 10)
    await expect(unpack(root, bytes)).rejects.toMatchObject({ code: 'invalid_skill_package' })
  })
  await fixture(async (root) => {
    const files: Zippable = { 'SKILL.md': instructions }
    for (let index = 0; index < 180; index++) files[`a${index}/b/c/file.txt`] = Buffer.alloc(0)
    await expect(unpack(root, zip(files))).rejects.toMatchObject({ code: 'invalid_skill_package' })
  })
  await fixture(async (root) => {
    const bytes = zip({ 'SKILL.md': instructions })
    bytes.writeUInt32LE(0xffff_ffff, bytes.length - 22 + 16)
    await expect(unpack(root, bytes)).rejects.toMatchObject({ code: 'invalid_skill_package' })
  })
})

test.each(['missing footer', 'oversized archive', 'wrong declared expanded size', 'expanded stream exceeds declared size'])('%s fails with actual archive bytes', name => fixture(async (root) => {
  let bytes = zip({ 'SKILL.md': instructions, 'resource.txt': Buffer.from('resource') })
  if (name === 'missing footer') bytes = bytes.subarray(0, bytes.length - 22)
  else if (name === 'oversized archive') bytes = Buffer.alloc(MAX_ARCHIVE_BYTES + 1)
  else {
    const offset = centralOffset(bytes)
    bytes.writeUInt32LE(instructions.length + (name === 'wrong declared expanded size' ? 1 : -1), offset + 24)
  }
  await expect(unpack(root, bytes)).rejects.toMatchObject({ code: 'invalid_skill_package' })
}))

test('ZIP rejects CRC-corrupted stored bytes rather than publishing a newly hashed corrupt entry', () => fixture(async (root) => {
  const bytes = Buffer.from(zipSync({ 'SKILL.md': instructions }, { level: 0 }))
  const start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28)
  bytes[start + instructions.length - 2] = bytes.readUInt8(start + instructions.length - 2) ^ 1
  await expect(unpack(root, bytes)).rejects.toMatchObject({ code: 'invalid_skill_package' })
}))

test('ZIP rejects a corrupted central CRC for a valid deflated entry after decompressing all bytes', () => fixture(async (root) => {
  const body = Buffer.concat([instructions, Buffer.alloc(128 * 1024, 97)])
  const bytes = zip({ 'SKILL.md': body })
  const original = Buffer.from(bytes)
  const validRoot = join(root, 'valid')
  await mkdir(validRoot)
  expect(await unpack(validRoot, original)).toEqual([{ path: 'skill/SKILL.md', size: body.length, sha256: digest(body) }])
  expect(await readFile(join(validRoot, 'skill/SKILL.md'))).toEqual(body)
  const directory = centralOffset(bytes)
  expect(bytes.readUInt16LE(8)).toBe(8)
  expect(bytes.readUInt16LE(directory + 10)).toBe(8)
  const checksum = bytes.readUInt32LE(directory + 16)
  expect(bytes.readUInt32LE(14)).toBe(checksum)
  bytes.writeUInt32LE((checksum ^ 1) >>> 0, directory + 16)
  const start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28)
  const end = start + bytes.readUInt32LE(directory + 20)
  expect(bytes.subarray(start, end)).toEqual(original.subarray(start, end))
  expect(inflateRawSync(bytes.subarray(start, end))).toEqual(body)
  expect(bytes.readUInt32LE(14)).toBe(checksum)
  expect(bytes.readUInt32LE(directory + 16)).not.toBe(checksum)
  await expect(unpack(root, bytes)).rejects.toMatchObject({ status: 400, code: 'invalid_skill_package' })
}))

test('archive symlinks and cancellation do not read or write outside the owned extraction directory', () => fixture(async (root) => {
  const outside = join(root, 'external.zip')
  const bytes = zip({ 'SKILL.md': instructions })
  await writeFile(outside, bytes)
  await symlink(outside, join(root, 'archive.zip'))
  await expect(extractSkillPackage(join(root, 'archive.zip'), root)).rejects.toThrow()
  expect(await readFile(outside)).toEqual(bytes)
  const controller = new AbortController()
  const reason = new Error('Owned cancellation')
  controller.abort(reason)
  await expect(extractSkillPackage(outside, root, controller.signal)).rejects.toBe(reason)
  await expect(readNativeSkillMetadata(root, controller.signal)).rejects.toBe(reason)
  expect((await readdir(root)).sort()).toEqual(['archive.zip', 'external.zip'])
}))

test('explicit ZIP directories, legal footer comments and a live cancellation signal use the real parser', () => fixture(async (root) => {
  const bytes = Buffer.from(zipSync({ 'owned/': [Buffer.alloc(0), { attrs: (0o040755 << 16) >>> 0 }],
    'owned/SKILL.md': instructions, 'owned/references/': [Buffer.alloc(0), { attrs: (0o040755 << 16) >>> 0 }],
    'owned/references/guide.txt': Buffer.from('资料') }, { comment: 'Owned footer comment' }))
  await writeFile(join(root, 'archive.zip'), bytes)
  const controller = new AbortController()
  const files = await extractSkillPackage(join(root, 'archive.zip'), root, controller.signal)
  expect(files.map(file => file.path)).toEqual(['skill/SKILL.md', 'skill/references/guide.txt'])
  expect(await readNativeSkillMetadata(join(root, 'skill'), controller.signal)).toEqual({ name: 'employee-seven', description: '真实 YAML: 中文说明' })
  const cancelled = new AbortController()
  const reason = new Error('Cancelled during native metadata loading')
  const loading = readNativeSkillMetadata(join(root, 'skill'), cancelled.signal)
  cancelled.abort(reason)
  await expect(loading).rejects.toBe(reason)
}))

test('duplicate central-directory names are rejected even when local ZIP names differ', () => fixture(async (root) => {
  const bytes = zip({ 'SKILL.md': instructions, 'OTHER.md': instructions })
  const first = centralOffset(bytes)
  const second = first + 46 + bytes.readUInt16LE(first + 28) + bytes.readUInt16LE(first + 30) + bytes.readUInt16LE(first + 32)
  Buffer.from('SKILL.md').copy(bytes, second + 46)
  await expect(unpack(root, bytes)).rejects.toMatchObject({ code: 'invalid_skill_package' })
  expect(await readdir(root)).toEqual(['archive.zip'])
}))

test.each(['disk number', 'central disk', 'mismatched entry counts', 'empty directory'])('ZIP rejects unsupported %s in its actual footer', mode => fixture(async (root) => {
  const bytes = zip({ 'SKILL.md': instructions })
  const footer = bytes.length - 22
  if (mode === 'disk number') bytes.writeUInt16LE(1, footer + 4)
  if (mode === 'central disk') bytes.writeUInt16LE(1, footer + 6)
  if (mode === 'mismatched entry counts') bytes.writeUInt16LE(2, footer + 8)
  if (mode === 'empty directory') { bytes.writeUInt16LE(0, footer + 8); bytes.writeUInt16LE(0, footer + 10) }
  await expect(unpack(root, bytes)).rejects.toMatchObject({ code: 'invalid_skill_package' })
}))

test('authored package version refuses a symlink and never changes its target', () => fixture(async (root) => {
  const bytes = zip({ 'SKILL.md': instructions, 'skill-package.json': Buffer.from('{"schemaVersion":1,"version":"1.0.0"}') })
  const files = await unpack(root, bytes)
  const target = join(root, 'metadata-sentinel')
  await writeFile(target, '{"schemaVersion":1,"version":"9.0.0"}')
  await rm(join(root, 'skill/skill-package.json'))
  await symlink(target, join(root, 'skill/skill-package.json'))
  await expect(skillPackageVersion(join(root, 'skill'), digest(bytes), files)).rejects.toThrow()
  expect(await readFile(target, 'utf8')).toBe('{"schemaVersion":1,"version":"9.0.0"}')
}))

test.each(['{', '{}', '{"schemaVersion":1,"version":"01.0.0"}', '{"schemaVersion":1,"version":"1.0.0","extra":true}', 'x'.repeat(4097)])('package version rejects invalid durable metadata %j', text => fixture(async (root) => {
  const bytes = zip({ 'SKILL.md': instructions, 'skill-package.json': Buffer.from(text) })
  const files = await unpack(root, bytes)
  await expect(skillPackageVersion(join(root, 'skill'), digest(bytes), files)).rejects.toMatchObject({ code: 'invalid_skill_metadata' })
}))

test('packages without authored metadata retain the archive version and native YAML rejects invalid import names', async () => {
  await fixture(async (root) => {
    const bytes = zip({ 'SKILL.md': instructions })
    const files = await unpack(root, bytes)
    expect(await skillPackageVersion(join(root, 'skill'), digest(bytes), files)).toBe(`sha256:${digest(bytes)}`)
  })
  for (const body of ['---\nname: Upper_Name\ndescription: valid\n---\nbody', '---\nname: employee-seven\ndescription: [invalid]\n---\nbody', '---\nname: employee-seven\nname: duplicate\ndescription: valid\n---\nbody']) {
    await fixture(async (root) => {
      await unpack(root, zip({ 'SKILL.md': Buffer.from(body) }))
      await expect(readNativeSkillMetadata(join(root, 'skill'))).rejects.toMatchObject({ code: 'invalid_skill_metadata' })
    })
  }
})

test.each(['extra file', 'missing file', 'same-length corruption', 'symbolic file', 'symbolic directory', 'wrong manifest', 'cancelled'])('published package rejects %s and preserves external sentinels', mode => fixture(async (root) => {
  const packageRoot = join(root, 'published')
  await mkdir(packageRoot)
  const bytes = zip({ 'SKILL.md': instructions, 'resources/readme.txt': Buffer.from('resource') })
  const files = await unpack(packageRoot, bytes)
  const manifest = skillPackageManifest(digest(bytes), files)
  await writeFile(join(packageRoot, 'manifest.json'), manifest)
  await rm(join(packageRoot, 'archive.zip'))
  const sentinel = join(root, 'sentinel.txt')
  await writeFile(sentinel, 'sentinel')
  if (mode === 'extra file') await writeFile(join(packageRoot, 'extra.txt'), 'extra')
  if (mode === 'missing file') await rm(join(packageRoot, 'skill/resources/readme.txt'))
  if (mode === 'same-length corruption') {
    await chmod(join(packageRoot, 'skill/resources/readme.txt'), 0o600)
    await writeFile(join(packageRoot, 'skill/resources/readme.txt'), 'tampered')
  }
  if (mode === 'symbolic file') {
    await rm(join(packageRoot, 'skill/resources/readme.txt'))
    await symlink(sentinel, join(packageRoot, 'skill/resources/readme.txt'))
  }
  if (mode === 'symbolic directory') {
    await rm(join(packageRoot, 'skill/resources'), { recursive: true })
    await symlink(root, join(packageRoot, 'skill/resources'))
  }
  if (mode === 'wrong manifest') await writeFile(join(packageRoot, 'manifest.json'), '{}')
  const controller = new AbortController()
  if (mode === 'cancelled') controller.abort()
  await expect(verifyPublishedSkillPackage(packageRoot, manifest, files, controller.signal))
    .rejects.toMatchObject({ status: 503, code: 'skill_package_unavailable' })
  expect(await readFile(sentinel, 'utf8')).toBe('sentinel')
}))

test.each(['root symlink', 'extensions symlink', 'missing manifest', 'oversized manifest', 'same-length manifest corruption', 'empty catalog', 'oversized catalog', 'same-length archive corruption'])('pinned catalog rejects %s in a private copy', mode => fixture(async (root) => {
  const catalogRoot = join(root, 'catalog')
  await cp(builtinSkillAssetRoot(), catalogRoot, { recursive: true })
  const catalog = new BuiltinSkillCatalog(catalogRoot)
  const word = (await catalog.list()).find(item => item.id === 'builtin.word')!
  const manifestPath = join(catalogRoot, 'extensions', word.id, `${word.version}.manifest.json`)
  if (mode === 'root symlink') {
    await symlink(catalogRoot, join(root, 'link'))
    await expect(new BuiltinSkillCatalog(join(root, 'link')).list()).rejects.toBeInstanceOf(BuiltinSkillCatalogUnavailable)
    return
  }
  if (mode === 'extensions symlink') {
    await rm(join(catalogRoot, 'extensions'), { recursive: true })
    await symlink(join(builtinSkillAssetRoot(), 'extensions'), join(catalogRoot, 'extensions'))
  }
  if (mode === 'missing manifest') await rm(manifestPath)
  if (mode === 'oversized manifest') await writeFile(manifestPath, Buffer.alloc(4097))
  if (mode === 'same-length manifest corruption') {
    const bytes = await readFile(manifestPath); bytes[0] = 32; await writeFile(manifestPath, bytes)
  }
  if (mode === 'empty catalog') await writeFile(join(catalogRoot, 'catalog.json'), '')
  if (mode === 'oversized catalog') await writeFile(join(catalogRoot, 'catalog.json'), Buffer.alloc(262_145))
  if (mode === 'same-length archive corruption') {
    const path = join(catalogRoot, 'extensions', word.id, `${word.version}.zip`)
    const bytes = await readFile(path); bytes[0] = bytes.readUInt8(0) ^ 1; await writeFile(path, bytes)
    await expect(catalog.get(word.id, word.version)).rejects.toBeInstanceOf(BuiltinSkillCatalogUnavailable)
  } else await expect(catalog.list()).rejects.toBeInstanceOf(BuiltinSkillCatalogUnavailable)
}))

test('catalog IDs and versions cannot select a path or an unavailable release', async () => {
  const catalog = new BuiltinSkillCatalog()
  for (const [id, version] of [['../foreign', '1.0.0'], ['builtin.word', 'latest'], ['builtin.unknown', '1.0.0'], ['builtin.word', '99.0.0']] as const) {
    expect(await catalog.get(id, version)).toBeNull()
  }
})

async function reportSources(root: string): Promise<ReportSuiteSource[]> {
  const catalog = new BuiltinSkillCatalog()
  const ids = ['builtin.report-workflow-orchestrator', 'builtin.power-grid-technical-report-writer', 'builtin.report-reviewer', 'builtin.tech-report-writer']
  const sources: ReportSuiteSource[] = []
  for (const release of (await catalog.list()).filter(item => ids.includes(item.id))) {
    const loaded = await catalog.get(release.id, release.version)
    if (!loaded) throw new Error('Pinned report release missing')
    const packageRoot = join(root, release.id)
    await mkdir(packageRoot)
    const files = await unpack(packageRoot, loaded.archive)
    const manifest = skillPackageManifest(release.archiveDigest, files)
    await writeFile(join(packageRoot, 'manifest.json'), manifest)
    await rm(join(packageRoot, 'archive.zip'))
    const metadata = await readNativeSkillMetadata(join(packageRoot, 'skill'))
    sources.push({ folder: metadata.name, packageRoot, files, manifest })
  }
  return sources
}

test('report suite publishes four actual sibling trees atomically, preserves script modes and reuses verified bytes', () => fixture(async (root) => {
  const staging = join(root, 'staging'); await mkdir(staging)
  const owner = join(root, 'owner'); await mkdir(owner)
  const sources = await reportSources(root)
  await publishReportSuite(owner, staging, 'owned-key', sources)
  const suite = join(owner, 'report-suites/owned-key')
  expect((await readdir(suite)).sort()).toEqual([...sources.map(source => source.folder), 'suite-manifest.json'].sort())
  const before = await readFile(join(suite, 'suite-manifest.json'))
  for (const source of sources) for (const file of source.files) {
    const target = join(suite, source.folder, file.path.slice('skill/'.length))
    expect(await readFile(target)).toEqual(await readFile(join(source.packageRoot, file.path)))
    expect((await lstat(target)).mode & 0o777).toBe((await lstat(join(source.packageRoot, file.path))).mode & 0o777)
  }
  expect((await lstat(suite)).mode & 0o777).toBe(0o555)
  await publishReportSuite(owner, staging, 'owned-key', sources)
  expect(await readFile(join(suite, 'suite-manifest.json'))).toEqual(before)
  expect(await readdir(staging)).toEqual([])
}))

test.each(['source mode corruption', 'source byte corruption', 'target mode corruption', 'target extra file', 'target byte corruption', 'parent symlink'])('report publication rejects %s, cleans only staging and keeps sentinels', mode => fixture(async (root) => {
  const staging = join(root, 'staging'); await mkdir(staging)
  const owner = join(root, 'owner'); await mkdir(owner)
  const sentinel = join(root, 'sentinel'); await mkdir(sentinel); await writeFile(join(sentinel, 'keep'), 'owned sentinel')
  const sources = await reportSources(root)
  const selected = sources[0]
  if (!selected) throw new Error('Pinned report fixture is empty')
  if (mode.startsWith('target')) await publishReportSuite(owner, staging, 'owned-key', sources)
  const sourcePath = join(selected.packageRoot, 'skill/SKILL.md')
  const targetPath = join(owner, 'report-suites/owned-key', selected.folder, 'SKILL.md')
  if (mode === 'source mode corruption') await chmod(sourcePath, 0o600)
  if (mode === 'source byte corruption' || mode === 'target byte corruption') {
    const path = mode === 'source byte corruption' ? sourcePath : targetPath
    await chmod(path, 0o600)
    const bytes = await readFile(path); bytes[0] = bytes.readUInt8(0) ^ 1; await writeFile(path, bytes)
    await chmod(path, 0o444)
  }
  if (mode === 'target mode corruption') await chmod(targetPath, 0o600)
  if (mode === 'target extra file') {
    await chmod(join(owner, 'report-suites/owned-key'), 0o700)
    await writeFile(join(owner, 'report-suites/owned-key/extra'), 'extra')
  }
  if (mode === 'parent symlink') await symlink(sentinel, join(owner, 'report-suites'))
  await expect(publishReportSuite(owner, staging, 'owned-key', sources)).rejects.toMatchObject({ code: 'skill_package_unavailable' })
  expect(await readdir(staging)).toEqual([])
  expect(await readFile(join(sentinel, 'keep'), 'utf8')).toBe('owned sentinel')
}))
