/** Read current cloud-only deployment metadata; tests never rewrite business assets. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BuiltinSkill } from '../src/client/skills-api.ts'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid deployment catalog text')
  return value
}
const catalog: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../application/assets/builtin-skills/generated-cloud-v2/catalog.json'), 'utf8'))
if (!record(catalog) || !Array.isArray(catalog.items)) throw new Error('Invalid deployment catalog')
export const builtinCatalog: readonly BuiltinSkill[] = catalog.items.map((item: unknown) => {
  if (!record(item) || !record(item.extension) || !record(item.release)) throw new Error('Invalid deployment release')
  const extension = item.extension, release = item.release
  if (typeof release.artifactSize !== 'number' || !Array.isArray(release.targets) || release.targets.some(target => target !== 'cloud')) throw new Error('Invalid cloud deployment release')
  return { id: text(extension.id), name: text(extension.name), summary: text(extension.summary), description: text(extension.description),
    category: text(extension.category), publisher: text(extension.publisher), version: text(release.version),
    manifestDigest: text(release.manifestDigest),
    archiveDigest: text(release.artifactDigest), archiveSize: release.artifactSize, installedSkillId: null }
})
const word = builtinCatalog.find(item => item.id === 'builtin.word')
if (!word) throw new Error('Current cloud catalog has no Word skill')
export const builtinWord = word
