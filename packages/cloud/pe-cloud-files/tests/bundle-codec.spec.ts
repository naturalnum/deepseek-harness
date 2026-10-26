/** Real locked archive libraries, complete exports, hostile member types and actual CRC checks. */
import { expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { decodeBundle, describeBundle, encodeBundleZip, parseBundleManifest, validateBundleTree } from '../src/bundle-codec.ts'
import type { SkillBundleLimits } from '../src/skill-bundles.ts'

const limits: SkillBundleLimits = { maxInstallations: 8, maxFiles: 16, maxDirectories: 16, maxDepth: 8, maxPathBytes: 128,
  maxFileBytes: 4096, maxContentBytes: 8192, maxArchiveBytes: 16384, maxArchiveEntries: 32, maxExpandedArchiveBytes: 8192,
  maxInputBytes: 32768, maxManifestBytes: 8192, maxCatalogBytes: 16384, maxDownloadBytes: 16384,
  maxRequestBytes: 65536, maxReplyBytes: 16384, maxStagingBytes: 32768, reservationBytes: 1048576 }
const signal = (): AbortSignal => new AbortController().signal
const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value)
function fixture() { return validateBundleTree({ directories: ['empty'], files: [
  { relativePath: 'SKILL.md', data: text('---\nname: test\n---\nRead resources/a.bin') },
  { relativePath: 'resources/a.bin', data: Uint8Array.of(0, 255, 13, 10) },
  { relativePath: 'scripts/run.sh', data: text('exit 99\n') },
] }, limits) }

it('round trips every nested resource, binary byte and empty directory with the locked libraries', async () => {
  const original = fixture(), bytes = encodeBundleZip(original, limits.maxDownloadBytes)
  const actual = await decodeBundle({ kind: 'zip', dataBase64: Buffer.from(bytes).toString('base64') }, limits, signal())
  expect(actual).toEqual(original)
  const manifest = describeBundle(actual)
  expect(parseBundleManifest(JSON.parse(JSON.stringify(manifest)), limits)).toEqual(manifest)
  expect(manifest.contentBytes).toBe(original.files.reduce((sum, file) => sum + file.data.byteLength, 0))
})

it.each(['../escape', '/absolute', 'C:/drive', 'a\\b', 'a/./b', 'a//b', 'a/../b', 'a\0b', 'e\u0301.txt', 'a./b'])(
  'refuses ambiguous or escaping member %s before any native operation', async (relativePath) => {
    await expect(decodeBundle({ kind: 'files', files: [{ relativePath: 'SKILL.md', dataBase64: '' },
      { relativePath, dataBase64: '' }] }, limits, signal())).rejects.toThrow()
  })

it('rejects duplicate entries, file-directory collisions, missing roots and forged descriptors', async () => {
  const root = { relativePath: 'SKILL.md', dataBase64: '' }
  for (const files of [[root, root], [root, { relativePath: 'a', dataBase64: '' }, { relativePath: 'a/b', dataBase64: '' }],
    [{ relativePath: 'resources/a', dataBase64: '' }]]) {
    await expect(decodeBundle({ kind: 'files', files }, limits, signal())).rejects.toThrow()
  }
  const manifest = describeBundle(fixture())
  expect(() => parseBundleManifest({ ...manifest, directories: [] }, limits)).toThrow()
  expect(() => parseBundleManifest({ ...manifest, contentBytes: manifest.contentBytes - 1 }, limits)).toThrow()
})

it('checks CRC over actual expanded bytes rather than trusting archive declarations', async () => {
  const archive = zipSync({ 'SKILL.md': text('actual content') }, { level: 0 })
  const payload = Buffer.from(archive).indexOf(Buffer.from('actual content'))
  expect(payload).toBeGreaterThan(0)
  archive[payload] = 0
  await expect(decodeBundle({ kind: 'zip', dataBase64: Buffer.from(archive).toString('base64') }, limits, signal())).rejects.toThrow()
})

it('refuses encrypted, link and special archive entries through the actual parser', async () => {
  const archive = zipSync({ 'SKILL.md': text('root') }, { level: 0 })
  const central = Buffer.from(archive).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  expect(central).toBeGreaterThan(0)
  for (const mode of [0xa000, 0x1000, 0x6000]) {
    const altered = Buffer.from(archive)
    altered.writeUInt32LE(mode * 65536, central + 38)
    await expect(decodeBundle({ kind: 'zip', dataBase64: altered.toString('base64') }, limits, signal())).rejects.toThrow()
  }
  const encrypted = Buffer.from(archive); encrypted.writeUInt16LE(1, central + 8)
  await expect(decodeBundle({ kind: 'zip', dataBase64: encrypted.toString('base64') }, limits, signal())).rejects.toThrow()
})

it('keeps a non-Error archive cancellation reason as the failure cause', async () => {
  const bytes = encodeBundleZip(fixture(), limits.maxDownloadBytes), observer = new AbortController()
  const pending = decodeBundle({ kind: 'zip', dataBase64: Buffer.from(bytes).toString('base64') }, limits, observer.signal)
  observer.abort('Archive selection ended')
  await expect(pending).rejects.toBeInstanceOf(Error)
  await expect(pending).rejects.toMatchObject({ cause: 'Archive selection ended' })
})

it('applies complete compressed, expanded, metadata and output bounds', async () => {
  const original = fixture(), bytes = encodeBundleZip(original, limits.maxDownloadBytes)
  await expect(decodeBundle({ kind: 'zip', dataBase64: Buffer.from(bytes).toString('base64') },
    { ...limits, maxExpandedArchiveBytes: 1 }, signal())).rejects.toThrow()
  expect(() => encodeBundleZip(original, bytes.byteLength - 1)).toThrow()
  expect(() => encodeBundleZip(original, bytes.byteLength)).not.toThrow()
  expect(() => validateBundleTree(original, { ...limits, maxDirectories: 1 })).toThrow()
})
