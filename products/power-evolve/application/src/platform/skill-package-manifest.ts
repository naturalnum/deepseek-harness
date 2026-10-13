/** Immutable package manifests, published-file verification and staging directory permissions. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, open, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ExtractedSkillFile } from './skill-package-extraction.ts'
import { PlatformError } from '../contracts.ts'

const versionFile = z.object({ schemaVersion: z.literal(1),
  version: z.string().max(128).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
}).strict()

/** Read a package-authored version or derive one from the immutable archive digest.
 * @param skillRoot - normalized extracted skill directory.
 * @param archiveDigest - uploaded ZIP digest.
 * @param files - verified extracted files.
 * @returns bounded semantic or content-addressed version.
 */
export async function skillPackageVersion(skillRoot: string, archiveDigest: string,
  files: readonly ExtractedSkillFile[]): Promise<string> {
  if (!files.some(file => file.path === 'skill/skill-package.json')) return `sha256:${archiveDigest}`
  const file = await open(join(skillRoot, 'skill-package.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 4096) throw new PlatformError(400, 'invalid_skill_metadata')
    try { return versionFile.parse(JSON.parse(await file.readFile({ encoding: 'utf8' }))).version }
    catch { throw new PlatformError(400, 'invalid_skill_metadata') }
  } finally { await file.close() }
}

/** Serialize the platform-owned per-file integrity record.
 * @param artifactSha256 - digest of the uploaded ZIP.
 * @param files - extracted regular files.
 * @returns stable manifest text to persist with its digest.
 */
export function skillPackageManifest(artifactSha256: string, files: readonly ExtractedSkillFile[]): string {
  return JSON.stringify({ schemaVersion: 1, artifactSha256, files })
}

/** Compare an already-published directory with the validated archive.
 * @param root - published package directory.
 * @param manifest - expected platform manifest text.
 * @param files - expected regular files.
 * @param signal - optional cancellation signal.
 * @returns when the entire tree and file contents match.
 */
export async function verifyPublishedSkillPackage(
  root: string,
  manifest: string,
  files: readonly ExtractedSkillFile[],
  signal?: AbortSignal,
): Promise<void> {
  const expected = new Set(['manifest.json', 'skill'])
  for (const file of files) {
    expected.add(file.path)
    let directory = dirname(file.path)
    while (directory !== '.') {
      expected.add(directory)
      directory = dirname(directory)
    }
  }
  try {
    const pending = ['']
    const found = new Set<string>()
    while (pending.length > 0) {
      signal?.throwIfAborted()
      const relative = pending.pop()
      assert(relative !== undefined)
      const path = join(root, relative)
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid package directory')
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`
        if (!expected.has(child) || entry.isSymbolicLink()) throw new Error('Unexpected package file')
        found.add(child)
        if (entry.isDirectory()) pending.push(child)
        else if (!entry.isFile()) throw new Error('Invalid package file')
      }
    }
    if (found.size !== expected.size) throw new Error('Incomplete package')
    await verifyFile(join(root, 'manifest.json'), Buffer.byteLength(manifest),
      createHash('sha256').update(manifest).digest('hex'), signal)
    for (const file of files) await verifyFile(join(root, file.path), file.size, file.sha256, signal)
  } catch (_cause) {
    throw new PlatformError(503, 'skill_package_unavailable')
  }
}

async function verifyFile(path: string, size: number, sha256: string, signal?: AbortSignal): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== size) throw new Error('Invalid file size')
    let actualSize = 0
    const hash = createHash('sha256')
    const stream: AsyncIterable<Buffer> = handle.createReadStream({ autoClose: false, signal })
    for await (const bytes of stream) {
      actualSize += bytes.length
      if (actualSize > size) throw new Error('File exceeded size')
      hash.update(bytes)
    }
    if (actualSize !== size || hash.digest('hex') !== sha256) throw new Error('Invalid file digest')
  } finally { await handle.close() }
}

/** Make staging directories writable before removal without following symbolic links.
 * @param root Exact caller-owned staging root; a missing directory needs no permission change.
 * @param invalidDirectory Caller policy for non-directories or symbolic links; throwing rejects cleanup, returning skips them.
 * @returns After each real directory has mode 0700; filesystem failures propagate to the caller.
 */
export async function makeSkillDirectoryTreeWritable(root: string, invalidDirectory: () => void): Promise<void> {
  let stat
  try { stat = await lstat(root) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) { invalidDirectory(); return }
  await chmod(root, 0o700)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeSkillDirectoryTreeWritable(join(root, entry.name), invalidDirectory)
  }
}
