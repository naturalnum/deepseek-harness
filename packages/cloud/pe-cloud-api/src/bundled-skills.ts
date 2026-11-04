/** Management projection of immutable packages contributed by the original native registry. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SkillCandidateInspection } from '@deepseek-ai/dsh-skill'
import type { ManagedSkillEntry, ManagedSkillId, ManagedSkillContentVersion } from './managed-skill-types.ts'

/**
 * Project immutable built-in metadata without source paths or callbacks.
 * @param row Native inspection row.
 * @returns Read-only metadata, or undefined for a candidate without a bundled package.
 */
export function bundledSkillEntry(row: SkillCandidateInspection): ManagedSkillEntry | undefined {
  const candidate = row.candidate, bundle = candidate.package
  if (candidate.source !== 'bundled' || bundle === undefined) return undefined
  const hex = createHash('sha256').update(`${candidate.provider}/${candidate.name}`).digest('hex')
  const skillId = brandString<ManagedSkillId>(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`)
  return { skillId, name: candidate.name, description: candidate.description, invocation: candidate.invocation,
    provider: candidate.provider, source: candidate.source, contentVersion: brandString<ManagedSkillContentVersion>(bundle.version),
    fileCount: bundle.files.length, contentBytes: bundle.files.reduce((sum, file) => sum + file.bytes, 0),
    legacySample: false, mutable: false, actions: { update: false, uninstall: false, download: true },
    selection: row.selected ? { kind: 'effective' } : row.overriddenBy === undefined ? { kind: 'incomplete' }
      : { kind: 'shadowed', by: { name: row.overriddenBy.name, provider: row.overriddenBy.provider, source: row.overriddenBy.source } } }
}
