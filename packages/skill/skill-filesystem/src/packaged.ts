/** Verified read-only carriers for bundled skill resources; no user filesystem discovery. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillPackage } from '@deepseek-ai/dsh-skill'

/**
 * Open a build-generated inventory beside a packaged skill. Missing or malformed carriers fail activation.
 * @param directory Trusted deployment asset directory, outside tenant writable storage.
 * @returns Inventory and hash-checked readers for that exact tree.
 */
export function readSkillPackage(directory: string): SkillPackage {
  const raw: unknown = JSON.parse(readFileSync(join(directory, '.dsh-package.json'), 'utf8'))
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
  const size = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!record(raw) || !digest(raw.version) || !record(raw.archive) || !size(raw.archive.bytes)
    || !digest(raw.archive.sha256) || !Array.isArray(raw.files)) throw new Error('Invalid packaged skill inventory')
  const names = new Set<string>()
  const files = raw.files.map((file: unknown) => {
    if (!record(file) || typeof file.relativePath !== 'string' || file.relativePath === ''
      || file.relativePath.split('/').some(part => part === '' || part === '.' || part === '..')
      || /[\\\x00-\x1f\x7f]/u.test(file.relativePath) || names.has(file.relativePath)
      || !size(file.bytes) || !digest(file.sha256)) throw new Error('Invalid packaged skill file')
    names.add(file.relativePath)
    return Object.freeze({ relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 })
  })
  if (!names.has('SKILL.md')) throw new Error('Packaged skill has no SKILL.md')
  const archive = Object.freeze({ bytes: raw.archive.bytes, sha256: raw.archive.sha256 })
  const verified = async (path: string, expected: typeof archive, signal?: AbortSignal): Promise<Uint8Array> => {
    const bytes = await readFile(join(directory, path), { signal })
    if (bytes.byteLength !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw new Error('Packaged skill bytes differ from the installed inventory')
    }
    signal?.throwIfAborted()
    return bytes
  }
  return Object.freeze({ version: raw.version, files: Object.freeze(files), archive,
    readFile(path: string, signal?: AbortSignal) {
      const file = files.find(entry => entry.relativePath === path)
      if (file === undefined) return Promise.reject(new Error('Packaged skill member is unavailable'))
      return verified(path, file, signal)
    },
    readArchive: (signal?: AbortSignal) => verified('.dsh-package.zip', archive, signal),
  })
}
