import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isUnchangedImportedResearchContent } from './imported-research-content.ts'
import { findConcreteTermViolations } from './verify-concrete-terms.ts'

describe('unchanged imported research content', () => {
  const file = 'integrations/epri-research/src/reused/common/science.ts'
  const content = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  it('retains exact original scientific field names without exempting modified or new adapter code', () => {
    expect(isUnchangedImportedResearchContent(file, content)).toBe(true)
    expect(findConcreteTermViolations(file, content)).toEqual([])
    expect(isUnchangedImportedResearchContent(file, content + '\n')).toBe(false)
    expect(findConcreteTermViolations(file, content + '\n').length).toBeGreaterThan(0)
    expect(isUnchangedImportedResearchContent('integrations/epri-research/plugins/cloud/new.ts', content)).toBe(false)
  })
  it('supports exact index bytes as well as worktree text', () => {
    expect(isUnchangedImportedResearchContent(file, Buffer.from(content))).toBe(true)
    expect(isUnchangedImportedResearchContent(file, Buffer.from('changed'))).toBe(false)
  })
})
