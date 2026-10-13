/** Create one new Platform-only journal key in two owned 0600 files; no old Host memory is copied. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, lstat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** Materialize matching canonical 32-byte base64url key files for an owned fresh replica fixture.
 * @param home Absolute owned fixture home. Existing key files refuse rather than being replaced.
 * @returns File paths and non-secret verification only; Host receives neither a path nor key bytes.
 */
export async function materializeNativeIntentKeys(home) {
  assert(isAbsolute(home) && !/[\u0000-\u001f\u007f]/u.test(home))
  const paths = ['p1', 'p2'].map(id => join(home, 'private', id, 'native-intent-key'))
  const key = randomBytes(32), encoded = Buffer.from(key.toString('base64url'))
  try {
    for (const [index, id] of ['p1', 'p2'].entries()) {
      await mkdir(join(home, 'private', id), { recursive: true, mode: 0o700 })
      await writeFile(paths[index], encoded, { flag: 'wx', mode: 0o600 })
    }
    const copies = await Promise.all(paths.map(path => readFile(path)))
    try {
      assert(copies[0].equals(copies[1]) && copies[0].equals(encoded))
      for (const copy of copies) {
        const decoded = Buffer.from(copy.toString('utf8'), 'base64url')
        try { assert(decoded.length === 32 && decoded.toString('base64url') === copy.toString('utf8')) }
        finally { decoded.fill(0) }
      }
      const modes = await Promise.all(paths.map(async path => (await lstat(path)).mode & 0o777))
      assert(modes.every(mode => mode === 0o600))
      return { paths, sameEncodedBytes: true, canonicalDecodedBytes: 32, modes }
    } finally { for (const copy of copies) copy.fill(0) }
  } finally { key.fill(0); encoded.fill(0) }
}
