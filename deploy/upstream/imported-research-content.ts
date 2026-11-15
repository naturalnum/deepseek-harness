/** Exact unchanged upstream content retained by the independently versioned research plugin. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const parsed: unknown = JSON.parse(readFileSync(new URL('./imported-research-content.json', import.meta.url), 'utf8'))
if (typeof parsed !== 'object' || parsed === null || !('schema' in parsed) || parsed.schema !== 1
  || !('files' in parsed) || typeof parsed.files !== 'object' || parsed.files === null
  || Array.isArray(parsed.files) || Object.keys(parsed).length !== 2) throw new Error('Invalid imported research content catalog')
const entries = Object.entries(parsed.files)
if (entries.length === 0 || entries.length > 4000) throw new Error('Invalid imported research content count')
const hashes = new Map<string, string>()
for (const [path, digest] of entries) {
  if (!(path === 'integrations/epri-research/src/server/archive.mjs'
    || /^integrations\/epri-research\/(?:src\/reused|upstream|licenses)\//u.test(path))
    || path.split('/').some(part => part === '..' || part === '.') || path.includes('\\')
    || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Invalid imported research content row')
  hashes.set(path, digest)
}

/**
 * Preserve original upstream wording only while the imported bytes remain exact.
 * @param file Repository-relative original source path.
 * @param content Bytes or text read from the selected worktree or index plane.
 * @returns Whether this exact catalogued upstream file remains unchanged.
 */
export function isUnchangedImportedResearchContent(file: string, content: string | Uint8Array): boolean {
  const digest = hashes.get(file)
  return digest !== undefined && createHash('sha256').update(content).digest('hex') === digest
}
