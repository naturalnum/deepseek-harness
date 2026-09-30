/** Publish four complete, immutable report Skill trees as physical sibling directories. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PlatformError } from '../contracts.ts'
import type { ExtractedSkillFile } from './skill-package-extraction.ts'
import { verifyPublishedSkillPackage } from './skill-package-manifest.ts'

export interface ReportSuiteSource {
  readonly folder: string
  readonly packageRoot: string
  readonly manifest: string
  readonly files: readonly ExtractedSkillFile[]
}

interface SuiteFile { path: string; size: number; sha256: string; executable: boolean }

function unavailable(): never { throw new PlatformError(503, 'skill_package_unavailable') }
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function cleanup(path: string): Promise<void> {
  const writable = async (directory: string): Promise<void> => {
    let stat
    try { stat = await lstat(directory) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable()
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name))
    }
  }
  await writable(path)
  await rm(path, { recursive: true, force: true })
}

async function verifyFile(path: string, item: SuiteFile): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== item.size
      || (stat.mode & 0o777) !== (item.executable ? 0o555 : 0o444)) unavailable()
    const bytes = await handle.readFile()
    if (bytes.length !== item.size || hash(bytes) !== item.sha256) unavailable()
  } finally { await handle.close() }
}

async function verifySuite(root: string, manifest: Buffer, files: readonly SuiteFile[],
  writableRoot = false): Promise<void> {
  try {
    const expected = new Map<string, Set<string>>()
    const add = (directory: string, name: string): void => {
      if (!expected.has(directory)) expected.set(directory, new Set())
      expected.get(directory)!.add(name)
    }
    add('', 'suite-manifest.json')
    for (const item of files) {
      const parts = item.path.split('/')
      for (let index = 0; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/')
        add(parent, parts[index]!)
      }
    }
    for (const [relative, children] of expected) {
      const directory = join(root, relative)
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (stat.mode & 0o777) !== (writableRoot && relative === '' ? 0o700 : 0o555)) unavailable()
      const names = await readdir(directory)
      if (names.length !== children.size || names.some(name => !children.has(name))) unavailable()
    }
    await verifyFile(join(root, 'suite-manifest.json'), {
      path: 'suite-manifest.json', size: manifest.length, sha256: hash(manifest), executable: false })
    for (const item of files) await verifyFile(join(root, item.path), item)
  } catch (_error) { unavailable() }
}

async function copyFile(source: string, target: string, item: SuiteFile): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await input.stat()
    if (!stat.isFile() || stat.size !== item.size
      || (stat.mode & 0o777) !== (item.executable ? 0o555 : 0o444)) unavailable()
    const bytes = await input.readFile()
    if (bytes.length !== item.size || hash(bytes) !== item.sha256) unavailable()
    const mode = item.executable ? 0o555 : 0o444
    const output = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode)
    try { await output.writeFile(bytes); await output.sync() } finally { await output.close() }
    await chmod(target, mode)
  } finally { await input.close() }
}

/** Reuse or atomically publish a verified suite inside the existing per-user mount. */
export async function publishReportSuite(userRoot: string, stagingRoot: string, key: string,
  sources: readonly ReportSuiteSource[]): Promise<void> {
  const suiteParent = join(userRoot, 'report-suites')
  await mkdir(suiteParent, { recursive: true, mode: 0o755 })
  const parentStat = await lstat(suiteParent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) unavailable()
  await chmod(suiteParent, 0o755)
  const files: SuiteFile[] = []
  for (const source of sources) {
    await verifyPublishedSkillPackage(source.packageRoot, source.manifest, source.files)
    for (const file of source.files) {
      const relative = file.path.slice('skill/'.length)
      const original = await lstat(join(source.packageRoot, file.path))
      if (!original.isFile() || original.isSymbolicLink()) unavailable()
      files.push({ path: `${source.folder}/${relative}`, size: file.size, sha256: file.sha256,
        executable: (original.mode & 0o111) !== 0 })
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files }), 'utf8')
  const target = join(suiteParent, key)
  let exists = false
  try { await lstat(target); exists = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (exists) return verifySuite(target, manifest, files)
  const stage = await mkdtemp(join(stagingRoot, 'pe-suite-'))
  try {
    const directories = new Set<string>([''])
    for (const item of files) {
      let parent = dirname(item.path)
      while (parent !== '.') { directories.add(parent); parent = dirname(parent) }
      const destination = join(stage, item.path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const source = sources.find(candidate => item.path.startsWith(`${candidate.folder}/`))!
      await copyFile(join(source.packageRoot, 'skill', item.path.slice(source.folder.length + 1)), destination, item)
    }
    const manifestFile = await open(join(stage, 'suite-manifest.json'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444)
    try { await manifestFile.writeFile(manifest); await manifestFile.sync() } finally { await manifestFile.close() }
    await chmod(join(stage, 'suite-manifest.json'), 0o444)
    for (const directory of [...directories].filter(name => name !== '').sort((a, b) => b.length - a.length)) {
      await chmod(join(stage, directory), 0o555)
      await syncDirectory(join(stage, directory))
    }
    await verifySuite(stage, manifest, files, true)
    await syncDirectory(stage)
    await rename(stage, target)
    await chmod(target, 0o555)
    await syncDirectory(target)
    await syncDirectory(suiteParent)
    await verifySuite(target, manifest, files)
  } finally { await cleanup(stage) }
}
