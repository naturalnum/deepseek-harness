/** Explicit native-operation answers for new managed-skill client checks; no actual account or transport. */
import { vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { attachManagedSkillEditing, type ManagedSkillDetail, type ManagedSkillLimits, type ManagedSkillList } from '../../src/client/managed-skill-editing.ts'
import type { SkillCard, SkillManagementView } from '../../src/client/management/skills/types.ts'

export const selectionLimits: ManagedSkillLimits = { maxFiles: 8, maxEntries: 16, maxDirectories: 8, maxPathDepth: 4,
  maxPathBytes: 128, maxFileBytes: 4096, maxTotalBytes: 8192, maxArchiveBytes: 8192 }
const card = (id: string, version = 'v1'): SkillCard => ({ id, name: id, description: id + ' description', category: 'imported',
  installed: true, recommended: false, status: 'published', version, sourceLabel: 'account', shadowed: false })

export function managedFixture() {
  const source = createSnapshotStore<SkillManagementView>({ phase: 'unavailable', items: [] })
  const install = vi.fn<NonNullable<ManagedSkillList['install']>>(async () => ({ kind: 'persisted', applied: true, item: card('third') }))
  const update = vi.fn<NonNullable<ManagedSkillDetail['update']>>(async () => ({ kind: 'persisted', applied: false, item: card('first', 'v2') }))
  const uninstall = vi.fn<NonNullable<ManagedSkillDetail['uninstall']>>(async () => ({ kind: 'persisted', applied: true, item: null }))
  const download = vi.fn<NonNullable<ManagedSkillDetail['download']>>(async () => {})
  const installed = vi.fn(async (): Promise<ManagedSkillList> => ({ items: [card('first'), card('second')], limits: selectionLimits, install }))
  const details = vi.fn(async (id: string): Promise<ManagedSkillDetail> => ({ item: card(id),
    files: [{ path: 'SKILL.md', bytes: 20 }, { path: 'references/guide.md', bytes: 20 }], update, uninstall, download }))
  const parent = new AbortController()
  let current = true
  const withdraw = attachManagedSkillEditing(source, { scope: 'original-page:dependency', signal: parent.signal,
    assertCurrent: () => { if (!current) throw new Error('withdrawn') }, installed, details })
  const editor = () => {
    const value = source.getSnapshot().managed
    if (value === undefined) throw new Error('missing original page source')
    return value
  }
  return { source, editor, installed, details, install, update, uninstall, download, parent, withdraw,
    revoke: () => { current = false; withdraw() } }
}
