/** Bounded package decoding and canonical manifests. Archive parsing belongs to yauzl, never a host extractor. */
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { fromBuffer } from 'yauzl'
import * as archiveLibrary from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import { Zip, ZipPassThrough } from 'fflate'
import type { SkillBundleFile, SkillBundleInput, SkillBundleLimits } from './skill-bundles.ts'
import { FdMutationFailure } from './worker-client.ts'

/** Expanded owned content; buffers remain under the original operation reservation. */
export interface BundleTree {
  readonly files: readonly { readonly relativePath: string; readonly data: Uint8Array<ArrayBuffer> }[]
  readonly directories: readonly string[]
}

/** Durable manifest excludes process-local binding and source paths. */
export interface BundleManifest {
  readonly schema: 1
  readonly files: readonly SkillBundleFile[]
  readonly directories: readonly string[]
  readonly treeSha256: string
  readonly contentBytes: number
}

/**
 * Reject before mutation; malformed packages never become unknown durable publications.
 * @param large Whether the complete package exceeded a configured capacity.
 * @returns Never returns; throws a confirmed not-published files failure.
 */
export function rejectBundle(large = false): never {
  throw new FdMutationFailure('not-published', large ? 'FS_TOO_LARGE' : 'FS_PERMISSION_DENIED')
}

/**
 * Hash actual owned bytes, including binary resources.
 * @param bytes Complete owned bytes or canonical UTF-8 metadata.
 * @returns Lowercase SHA-256 content digest.
 */
export function bundleHash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Decode complete explicit deployment values at Config/worker boundaries.
 * @param value Untrusted configuration or cloned worker fields.
 * @returns Complete finite limits, or undefined for missing, extra or invalid fields.
 */
export function skillBundleLimits(value: unknown): SkillBundleLimits | undefined {
  if (!object(value)) return undefined
  const names = ['maxInstallations', 'maxFiles', 'maxDirectories', 'maxDepth', 'maxPathBytes', 'maxFileBytes',
    'maxContentBytes', 'maxArchiveBytes', 'maxArchiveEntries', 'maxExpandedArchiveBytes', 'maxInputBytes', 'maxManifestBytes',
    'maxCatalogBytes', 'maxDownloadBytes', 'maxRequestBytes', 'maxReplyBytes', 'maxStagingBytes', 'reservationBytes'] as const
  if (Object.keys(value).length !== names.length || names.some(k => typeof value[k] !== 'number'
    || !Number.isSafeInteger(value[k]) || value[k] < 1 || value[k] > 2147483647)) return undefined
  if (number(value, 'maxDepth') > 64) return undefined
  const result = Object.fromEntries(names.map(k => [k, value[k]]))
  // Each field was checked above. Return an explicit object so adding a field cannot bypass this decoder.
  return Object.freeze({ maxInstallations: number(result, 'maxInstallations'), maxFiles: number(result, 'maxFiles'),
    maxDirectories: number(result, 'maxDirectories'), maxDepth: number(result, 'maxDepth'), maxPathBytes: number(result, 'maxPathBytes'),
    maxFileBytes: number(result, 'maxFileBytes'), maxContentBytes: number(result, 'maxContentBytes'),
    maxArchiveBytes: number(result, 'maxArchiveBytes'), maxArchiveEntries: number(result, 'maxArchiveEntries'),
    maxExpandedArchiveBytes: number(result, 'maxExpandedArchiveBytes'), maxInputBytes: number(result, 'maxInputBytes'),
    maxManifestBytes: number(result, 'maxManifestBytes'), maxCatalogBytes: number(result, 'maxCatalogBytes'),
    maxDownloadBytes: number(result, 'maxDownloadBytes'), maxRequestBytes: number(result, 'maxRequestBytes'),
    maxReplyBytes: number(result, 'maxReplyBytes'), maxStagingBytes: number(result, 'maxStagingBytes'),
    reservationBytes: number(result, 'reservationBytes') })
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function number(value: Record<string, unknown>, key: string): number {
  const result = value[key]
  if (typeof result !== 'number') rejectBundle()
  return result
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))
}
function order(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)) }

/**
 * Canonical portable relative names; normalization aliases and ambiguous filesystem names are refused.
 * @param value Untrusted relative member name.
 * @param limits Explicit depth and UTF-8 path capacities.
 * @returns The unchanged canonical relative path, rejecting aliases and escape paths.
 */
export function bundlePath(value: unknown, limits: SkillBundleLimits): string {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') || /[\\:\x00-\x1f\x7f]/u.test(value)
    || value.startsWith('/') || Buffer.byteLength(value) > limits.maxPathBytes || Buffer.from(value).toString('utf8') !== value) rejectBundle()
  const parts = value.split('/')
  if (parts.length > limits.maxDepth || parts.some(p => !p || p === '.' || p === '..' || /[. ]$/u.test(p))) rejectBundle()
  return value
}

function decoded(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maximum / 3)
    || value.length % 4 !== 0) rejectBundle(true)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength > maximum || bytes.toString('base64') !== value) rejectBundle(true)
  return Uint8Array.from(bytes)
}

/**
 * Validate paths/types/counts as one tree, retaining explicit empty directories.
 * @param tree Complete expanded owned members and explicit directories.
 * @param limits Explicit content, path and entry capacities.
 * @returns A sorted complete tree with derived parent directories; malformed input is rejected before mutation.
 */
export function validateBundleTree(tree: BundleTree, limits: SkillBundleLimits): BundleTree {
  if (!tree.files.length || tree.files.length > limits.maxFiles || tree.directories.length > limits.maxDirectories) rejectBundle(true)
  const files = new Map<string, Uint8Array<ArrayBuffer>>(), directories = new Set<string>()
  let total = 0
  const parents = (path: string): void => {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
  }
  for (const name of tree.directories) {
    const path = bundlePath(name, limits)
    if (directories.has(path) && tree.directories.indexOf(path) !== tree.directories.lastIndexOf(path)) rejectBundle()
    directories.add(path); parents(path)
  }
  for (const file of tree.files) {
    const path = bundlePath(file.relativePath, limits), data = file.data
    if (files.has(path) || directories.has(path) || !(data.buffer instanceof ArrayBuffer)
      || data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) rejectBundle()
    if (data.byteLength > limits.maxFileBytes || total + data.byteLength > limits.maxContentBytes) rejectBundle(true)
    files.set(path, data); total += data.byteLength; parents(path)
  }
  if (directories.size > limits.maxDirectories) rejectBundle(true)
  if ([...directories].some(path => files.has(path)) || !files.has('SKILL.md')) rejectBundle()
  new TextDecoder('utf-8', { fatal: true }).decode(files.get('SKILL.md'))
  return Object.freeze({ files: Object.freeze([...files].sort(([a], [b]) => order(a, b))
    .map(([relativePath, data]) => Object.freeze({ relativePath, data }))),
  directories: Object.freeze([...directories].sort(order)) })
}

function zipEntry(entry: Entry, limits: SkillBundleLimits): { path: string; directory: boolean } {
  if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x41) !== 0 || ![0, 8].includes(entry.compressionMethod)
    || entry.extraFields.some(field => field.id === 0x000d || field.id === 0x756e)) rejectBundle()
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000, directory = entry.fileName.endsWith('/')
  const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0
  if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000 || mode === 0x4000 && !directory
    || mode === 0x8000 && directory || dosDirectory && !directory) rejectBundle()
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
    || entry.uncompressedSize > limits.maxFileBytes || directory && entry.uncompressedSize !== 0) rejectBundle(true)
  return { path: bundlePath(directory ? entry.fileName.slice(0, -1) : entry.fileName, limits), directory }
}

interface ArchiveExtensions {
  parseExtraFields(bytes: Buffer): readonly { readonly id: number; readonly data: Buffer }[]
  getFileNameLowLevel(flags: number, name: Buffer,
    extra: readonly { readonly id: number; readonly data: Buffer }[], strict: boolean): string
}
interface HeaderZip extends ZipFile {
  readLocalFileHeader(entry: Entry, options: { readonly minimal: false }, callback: (error: Error | null, header: unknown) => void): void
}
function archiveExtensions(value: object): value is ArchiveExtensions {
  return 'parseExtraFields' in value && typeof value.parseExtraFields === 'function'
    && 'getFileNameLowLevel' in value && typeof value.getFileNameLowLevel === 'function'
}
function headerZip(value: ZipFile): value is HeaderZip {
  return 'readLocalFileHeader' in value && typeof value.readLocalFileHeader === 'function'
}
async function checkLocalHeader(zip: ZipFile, entry: Entry, limits: SkillBundleLimits): Promise<void> {
  if (!headerZip(zip) || !archiveExtensions(archiveLibrary)) rejectBundle()
  const header = await new Promise<unknown>((resolve, reject) =>{  zip.readLocalFileHeader(entry, { minimal: false },
    (error, header) => { if (error) reject(error); else resolve(header) }) })
  if (!object(header) || header.generalPurposeBitFlag !== entry.generalPurposeBitFlag
    || header.compressionMethod !== entry.compressionMethod
    || !Buffer.isBuffer(header.fileName) || !Buffer.isBuffer(header.extraField)) rejectBundle()
  const extras = archiveLibrary.parseExtraFields(header.extraField)
  if (extras.some(field => field.id === 0x000d || field.id === 0x756e)) rejectBundle()
  if ((entry.generalPurposeBitFlag & 0x800) !== 0) {
    new TextDecoder('utf-8', { fatal: true }).decode(header.fileName)
    if (!('fileNameRaw' in entry) || !Buffer.isBuffer(entry.fileNameRaw)) rejectBundle()
    new TextDecoder('utf-8', { fatal: true }).decode(entry.fileNameRaw)
  }
  const localName = archiveLibrary.getFileNameLowLevel(entry.generalPurposeBitFlag, header.fileName, extras, true)
  if (localName !== entry.fileName) rejectBundle()
  bundlePath(localName.endsWith('/') ? localName.slice(0, -1) : localName, limits)
  if ((entry.generalPurposeBitFlag & 8) === 0 && (header.crc32 !== entry.crc32
    || header.compressedSize !== entry.compressedSize && header.compressedSize !== 0xffffffff
    || header.uncompressedSize !== entry.uncompressedSize && header.uncompressedSize !== 0xffffffff)) rejectBundle()
}

async function expandZip(bytes: Uint8Array<ArrayBuffer>, limits: SkillBundleLimits, signal: AbortSignal): Promise<BundleTree> {
  const zip = await new Promise<ZipFile>((resolve, reject) =>{  fromBuffer(Buffer.from(bytes.buffer), {
    lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: true, validateEntrySizes: true,
  }, (error, file) => { if (error) reject(error); else resolve(file) }) })
  const files: Array<{ relativePath: string; data: Uint8Array<ArrayBuffer> }> = [], directories: string[] = []
  const seen = new Set<string>()
  let total = 0, entries = 0
  try {
    if (zip.entryCount > limits.maxArchiveEntries) rejectBundle(true)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true; signal.removeEventListener('abort', abort)
        if (error !== undefined) {
          zip.close(); reject(error instanceof Error ? error : new Error('The skill archive read failed.', { cause: error }))
        } else resolve()
      }
      const abort = (): void => { finish(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      zip.once('error', finish); zip.once('end', () => { finish() })
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          signal.throwIfAborted()
          if (++entries > limits.maxArchiveEntries) rejectBundle(true)
          const value = zipEntry(entry, limits)
          if (seen.has(value.path)) rejectBundle()
          seen.add(value.path)
          if (value.directory ? directories.length >= limits.maxDirectories : files.length >= limits.maxFiles
            || total + entry.uncompressedSize > limits.maxExpandedArchiveBytes) rejectBundle(true)
          await checkLocalHeader(zip, entry, limits)
          const stream = await new Promise<import('node:stream').Readable>((resolve, reject) => {
            zip.openReadStream(entry, (error, stream) => { if (error) reject(error); else resolve(stream) })
          })
          const stop = (): void => { stream.destroy(new Error('Package expansion aborted')) }
          signal.addEventListener('abort', stop, { once: true })
          const data = new Uint8Array(entry.uncompressedSize)
          let offset = 0, checksum = 0
          try {
            for await (const chunk of stream) {
              signal.throwIfAborted()
              if (!(chunk instanceof Uint8Array)) rejectBundle()
              if (offset + chunk.byteLength > data.byteLength || total + chunk.byteLength > limits.maxExpandedArchiveBytes
                || total + chunk.byteLength > limits.maxContentBytes) rejectBundle(true)
              data.set(chunk, offset); offset += chunk.byteLength; total += chunk.byteLength
              checksum = crc32(chunk, checksum)
            }
          } finally { signal.removeEventListener('abort', stop); stream.destroy() }
          if (offset !== entry.uncompressedSize || checksum !== entry.crc32) rejectBundle()
          if (value.directory) directories.push(value.path)
          else files.push({ relativePath: value.path, data })
          if (!settled) zip.readEntry()
        })().catch(finish)
      })
      if (signal.aborted) abort(); else zip.readEntry()
    })
    if (entries !== zip.entryCount) rejectBundle()
    return validateBundleTree({ files, directories }, limits)
  } finally { zip.close() }
}

/**
 * Decode a complete bounded package after original-lane admission; no filesystem I/O occurs here.
 * @param input Complete files or ZIP bytes encoded in base64.
 * @param limits Explicit input, archive and expanded-tree capacities.
 * @param signal Actual decode cancellation.
 * @returns The complete validated owned tree; no partial extraction is returned.
 */
export async function decodeBundle(input: SkillBundleInput, limits: SkillBundleLimits, signal: AbortSignal): Promise<BundleTree> {
  signal.throwIfAborted()
  if (input.kind === 'zip') {
    if (Buffer.byteLength(input.dataBase64) + 64 > limits.maxInputBytes) rejectBundle(true)
    return expandZip(decoded(input.dataBase64, limits.maxArchiveBytes), limits, signal)
  }
  if (input.files.length > limits.maxFiles) rejectBundle(true)
  let inputBytes = 64
  const files = input.files.map((file) => {
    inputBytes += Buffer.byteLength(file.relativePath) + Buffer.byteLength(file.dataBase64) + 64
    if (inputBytes > limits.maxInputBytes) rejectBundle(true)
    return { relativePath: file.relativePath, data: decoded(file.dataBase64, limits.maxFileBytes) }
  })
  return validateBundleTree({ files, directories: [] }, limits)
}

/**
 * Canonical UTF-8 ordered descriptor digest binds every path, empty directory, size and content digest.
 * @param tree A complete canonical tree returned by the validator.
 * @returns The complete immutable source manifest.
 */
export function describeBundle(tree: BundleTree): BundleManifest {
  const files = Object.freeze(tree.files.map(f => Object.freeze({ relativePath: f.relativePath, bytes: f.data.byteLength,
      sha256: bundleHash(f.data) }))), directories = Object.freeze([...tree.directories])
  const contentBytes = files.reduce((sum, f) => sum + f.bytes, 0)
  return Object.freeze({ schema: 1, files, directories, contentBytes,
    treeSha256: bundleHash(JSON.stringify({ files, directories })) })
}

/**
 * Strict durable descriptor reader; malformed or incomplete metadata never becomes an empty source.
 * @param raw Untrusted parsed durable manifest.
 * @param limits Explicit member and manifest capacities.
 * @returns A validated complete manifest with matching tree digest.
 */
export function parseBundleManifest(raw: unknown, limits: SkillBundleLimits): BundleManifest {
  if (!object(raw) || !exact(raw, ['schema', 'files', 'directories', 'contentBytes', 'treeSha256']) || raw.schema !== 1
    || !Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > limits.maxFiles
    || !Array.isArray(raw.directories) || raw.directories.length > limits.maxDirectories) rejectBundle()
  const directories = raw.directories.map((v: unknown) => bundlePath(v, limits))
  const files = raw.files.map((v: unknown): SkillBundleFile => {
    if (!object(v) || !exact(v, ['relativePath', 'bytes', 'sha256']) || typeof v.bytes !== 'number'
      || !Number.isSafeInteger(v.bytes) || v.bytes < 0 || v.bytes > limits.maxFileBytes
      || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)) rejectBundle()
    return Object.freeze({ relativePath: bundlePath(v.relativePath, limits), bytes: v.bytes, sha256: v.sha256 })
  })
  const paths = new Set(files.map(f => f.relativePath)), dirs = new Set(directories)
  const sortedUnique = (values: readonly string[]): boolean => values.every((v, i) => i === 0 || order(values[i - 1] ?? '', v) < 0)
  const parentsExist = (path: string): boolean => {
    const parts = path.split('/')
    return parts.every((_, i) => i === 0 || dirs.has(parts.slice(0, i).join('/')))
  }
  const contentBytes = files.reduce((sum, f) => sum + f.bytes, 0)
  if (!paths.has('SKILL.md') || contentBytes > limits.maxContentBytes || contentBytes !== raw.contentBytes
    || !sortedUnique(files.map(f => f.relativePath)) || !sortedUnique(directories)
    || directories.some(d => paths.has(d) || !parentsExist(d)) || files.some(f => !parentsExist(f.relativePath))
    || raw.treeSha256 !== bundleHash(JSON.stringify({ files, directories }))) rejectBundle()
  return Object.freeze({ schema: 1, files: Object.freeze(files), directories: Object.freeze(directories), contentBytes,
    treeSha256: raw.treeSha256 })
}

/**
 * Full stored ZIP export with bounded final output, including explicit empty directories.
 * @param tree Complete authorized source bytes and directories.
 * @param maximum Explicit complete ZIP output capacity.
 * @returns One owned ZIP buffer; exceeding the final output capacity rejects the export.
 */
export function encodeBundleZip(tree: BundleTree, maximum: number): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [], output = { length: 0, finished: false }
  const zip = new Zip((error, chunk, final) => {
    if (error) throw error
    if (output.length + chunk.byteLength > maximum) rejectBundle(true)
    chunks.push(chunk); output.length += chunk.byteLength; output.finished = final
  })
  for (const path of tree.directories) { const entry = new ZipPassThrough(`${path}/`); zip.add(entry); entry.push(new Uint8Array(), true) }
  for (const file of tree.files) { const entry = new ZipPassThrough(file.relativePath); zip.add(entry); entry.push(file.data, true) }
  zip.end()
  if (!output.finished) rejectBundle()
  const result = new Uint8Array(output.length); let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}
