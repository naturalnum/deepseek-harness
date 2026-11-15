import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isUnchangedImportedResearchContent } from '../deploy/upstream/imported-research-content.ts'
import { findConcreteTermViolations } from './verify-concrete-terms.ts'

describe('unchanged imported research content', () => {
  const file = 'integrations/epri-research/src/reused/common/science.ts'
  const content = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  it('recognizes exact imported bytes without weakening the original Native source check', () => {
    expect(isUnchangedImportedResearchContent(file, content)).toBe(true)
    const nativeViolations = findConcreteTermViolations(file, content)
    expect(nativeViolations.length).toBeGreaterThan(0)
    expect(findConcreteTermViolations(file, content + '\n')).toEqual(nativeViolations)
    expect(isUnchangedImportedResearchContent(file, content + '\n')).toBe(false)
    expect(findConcreteTermViolations(file, content + '\n').length).toBeGreaterThan(0)
    expect(isUnchangedImportedResearchContent('integrations/epri-research/plugins/cloud/new.ts', content)).toBe(false)
  })
  it('supports exact index bytes as well as worktree text', () => {
    expect(isUnchangedImportedResearchContent(file, Buffer.from(content))).toBe(true)
    expect(isUnchangedImportedResearchContent(file, Buffer.from('changed'))).toBe(false)
  })
})
