import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, createReadStream, createWriteStream, type ReadStream } from 'node:fs'
import { chmod, mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as unzipper from 'unzipper'
import { PlatformError } from '../contracts.ts'

/** Maximum compressed bytes accepted from one browser upload. */
export const MAX_ARCHIVE_BYTES = 1024 * 1024
const MAX_ENTRIES = 256
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024
const MAX_SKILL_BYTES = 256 * 1024

/** One verified regular file beneath the normalized skill directory. */
export interface ExtractedSkillFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

/** Extract into a fresh, private staging directory; callers publish only after this resolves.
 * @param archivePath - private ZIP file written by the platform.
 * @param stagingRoot - fresh destination outside the shared Host.
 * @param signal - optional cancellation signal.
 * @returns normalized file paths with actual byte counts and digests.
 */
export async function extractSkillPackage(
  archivePath: string,
  stagingRoot: string,
  signal?: AbortSignal,
): Promise<readonly ExtractedSkillFile[]> {
  signal?.throwIfAborted()
  const handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  const streams = new Set<ReadStream>()
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) invalid('Archive exceeds its limit')
    const tailSize = await boundedZipDirectory(handle, stat.size)
    const source = {
      size: async () => stat.size,
      stream(offset: number, length?: number): ReadStream {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size
          || length !== undefined && (!Number.isSafeInteger(length) || length < 0)) invalid('Invalid ZIP offset')
        const fd = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stream = createReadStream(archivePath, { fd, autoClose: true, start: offset,
            ...(length === undefined || length === 0 ? {} : { end: Math.min(stat.size, offset + length) - 1 }) })
          streams.add(stream)
          return stream
        } catch (error) { closeSync(fd); throw error }
      },
    }
    const api = unzipper.Open as typeof unzipper.Open & {
      custom(input: typeof source, options: { tailSize: number }): Promise<unzipper.CentralDirectory>
    }
    const archive = await api.custom(source, { tailSize })
    return await extractEntries(validateEntries(archive), stagingRoot, signal)
  } finally {
    for (const stream of streams) stream.destroy()
    await handle.close()
  }
}

/** Bound directory allocation before handing untrusted entry counts to the ZIP library. ZIP64 is unnecessary at 1 MiB. */
async function boundedZipDirectory(handle: FileHandle, size: number): Promise<number> {
  const tail = Buffer.alloc(Math.min(size, 22 + 65_535))
  const read = await handle.read(tail, 0, tail.byteLength, size - tail.byteLength)
  if (read.bytesRead !== tail.byteLength) invalid('ZIP directory is truncated')
  for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) !== 0x06054b50 || tail.readUInt16LE(offset + 20) !== tail.byteLength - offset - 22) continue
    const count = tail.readUInt16LE(offset + 10)
    const centralSize = tail.readUInt32LE(offset + 12)
    const centralOffset = tail.readUInt32LE(offset + 16)
    if (tail.readUInt16LE(offset + 4) !== 0 || tail.readUInt16LE(offset + 6) !== 0
      || count < 1 || count > MAX_ENTRIES || tail.readUInt16LE(offset + 8) !== count
      || centralOffset + centralSize > size - tail.byteLength + offset) invalid('Unsupported ZIP directory')
    return tail.byteLength - offset
  }
  invalid('ZIP directory is missing')
}

async function extractEntries(
  files: readonly { entry: unzipper.File; path: string }[], stagingRoot: string, signal?: AbortSignal,
): Promise<readonly ExtractedSkillFile[]> {
  await mkdir(join(stagingRoot, 'skill'), { mode: 0o750 })
  const result: ExtractedSkillFile[] = []
  let remaining = MAX_EXPANDED_BYTES
  for (const { entry, path } of files) {
    signal?.throwIfAborted()
    const target = join(stagingRoot, 'skill', path)
    await mkdir(dirname(target), { recursive: true, mode: 0o750 })
    const counter = new ExpandedFileLimit(Math.min(entry.uncompressedSize, remaining,
      path === 'SKILL.md' ? MAX_SKILL_BYTES : MAX_EXPANDED_BYTES))
    await pipeline(entry.stream(), counter, createWriteStream(target, { flags: 'wx', mode: 0o444 }),
      signal === undefined ? {} : { signal })
    if (counter.size !== entry.uncompressedSize) invalid('File size differs from ZIP metadata')
    await chmod(target, ((entry.externalFileAttributes >>> 16) & 0o111) !== 0 ? 0o555 : 0o444)
    const handle = await open(target, 'r')
    try { await handle.sync() } finally { await handle.close() }
    remaining -= counter.size
    result.push({ path: `skill/${path}`, size: counter.size, sha256: counter.sha256 })
  }
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

function validateEntries(archive: unzipper.CentralDirectory): { entry: unzipper.File; path: string }[] {
  if (archive.diskNumber !== 0 || archive.diskStart !== 0
    || archive.files.length < 1 || archive.files.length > MAX_ENTRIES) invalid('Unsupported ZIP directory')
  const seen = new Set<string>()
  let expanded = 0
  const files: unzipper.File[] = []
  for (const entry of archive.files) {
    const path = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path
    const modeType = (entry.externalFileAttributes >>> 16) & 0o170000
    if (!safePath(path) || !entry.pathBuffer.equals(Buffer.from(entry.path, 'utf8')) || seen.has(path) || (entry.flags & 1) !== 0
      || ![0, 8].includes(entry.compressionMethod)
      || ![0, 0o100000, 0o040000].includes(modeType)
      || (modeType === 0o040000 && entry.type !== 'Directory')
      || (modeType === 0o100000 && entry.type !== 'File')) invalid('Unsafe or duplicate ZIP entry')
    seen.add(path)
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) invalid('Invalid ZIP size')
    expanded += entry.uncompressedSize
    if (expanded > MAX_EXPANDED_BYTES) invalid('Skill package expands beyond its limit')
    if (entry.type === 'File') files.push(entry)
  }
  const skills = files.filter(entry => entry.path === 'SKILL.md' || /^[^/]+\/SKILL\.md$/u.test(entry.path))
  if (skills.length !== 1 || skills[0]!.uncompressedSize < 1
    || skills[0]!.uncompressedSize > MAX_SKILL_BYTES) invalid('Package must contain one bounded SKILL.md')
  const prefix = skills[0]!.path.slice(0, -'SKILL.md'.length)
  const result = files.map(entry => {
    if (!entry.path.startsWith(prefix)) invalid('Files must belong to one skill directory')
    const path = entry.path.slice(prefix.length)
    if (!safePath(path)) invalid('Invalid skill-relative path')
    return { entry, path }
  })
  const filePaths = new Set(result.map(file => file.path))
  const treePaths = new Set(filePaths)
  for (const { path } of result) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join('/')
      if (filePaths.has(directory)) invalid('File and directory paths overlap')
      treePaths.add(directory)
      if (treePaths.size > 512) invalid('Skill directory tree exceeds its entry limit')
    }
  }
  return result
}

function safePath(path: string): boolean {
  return path.length > 0 && Buffer.byteLength(path, 'utf8') <= 512
    && !/[\\:]/u.test(path)
    && ![...path].some(character => {
      const code = character.codePointAt(0)!
      return code < 32 || code === 127
    })
    && !path.split('/').some(part => part === '' || part === '.' || part === '..')
    && path.normalize('NFC') === path
}

class ExpandedFileLimit extends Transform {
  #size = 0
  readonly #hash = createHash('sha256')
  constructor(private readonly maximum: number) { super() }
  get size(): number { return this.#size }
  get sha256(): string { return this.#hash.copy().digest('hex') }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#size += chunk.byteLength
    if (this.#size > this.maximum) {
      callback(new PlatformError(400, 'invalid_skill_package'))
      return
    }
    this.#hash.update(chunk)
    callback(null, chunk)
  }
}

function invalid(message: string): never {
  void message
  throw new PlatformError(400, 'invalid_skill_package')
}
