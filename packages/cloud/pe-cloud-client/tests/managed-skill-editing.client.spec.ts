/** Original stable-source lifecycle with explicit native-operation answers; no actual account or generated transport is claimed. */
import { expect, it } from 'vitest'
import { attachManagedSkillEditing, type ManagedSkillOutcome } from '../src/client/managed-skill-editing.ts'
import type { SkillCard } from '../src/client/management/skills/types.ts'
import { readSelectedSkillBundle } from '../src/client/management/skills/selected-bundle.ts'

import { attachSkillVersionEditing } from '../src/client/skill-version-editing.ts'
import type { PreparedSkillEdit } from '../src/client/skill-edit.ts'
import { managedFixture, selectionLimits } from './fixtures/managed-skills.client.ts'
const signal = (): AbortSignal => new AbortController().signal
const card = (id: string, version: string): SkillCard => ({ id, name: id, description: '', category: 'imported', installed: true, recommended: false, status: 'published', version })

async function files() {
  const result = await readSelectedSkillBundle([{ path: 'SKILL.md', file: new File(['instructions'], 'SKILL.md') },
    { path: 'references/guide.md', file: new File(['binary resource'], 'guide.md') }], selectionLimits, signal())
  if (!result.ok) throw new Error('invalid test package')
  return { kind: 'files' as const, selection: result.value, markdown: result.value.markdown }
}

it('shows multiple actual items only after an explicit list and updates one complete version without altering another item', async () => {
  const f = managedFixture()
  expect(f.installed).not.toHaveBeenCalled()
  await f.editor().refresh(signal())
  expect(f.source.getSnapshot().items.map(row => row.id)).toEqual(['first', 'second'])
  const second = f.source.getSnapshot().items[1]
  await f.editor().open('first', signal())
  const bundle = await files()
  f.editor().choose(bundle)
  f.editor().editMarkdown('edited complete instructions')
  expect(bundle.selection.markdown).toBe('instructions')
  expect(await f.editor().publish(signal())).toMatchObject({ kind: 'persisted', applied: false })
  expect(f.update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ markdown: 'edited complete instructions' }), expect.any(AbortSignal))
  expect(f.source.getSnapshot().items[0]?.version).toBe('v2')
  expect(f.source.getSnapshot().items[1]?.id).toBe(second?.id)
  expect(f.source.getSnapshot().items[1]?.version).toBe(second?.version)
  expect(f.source.getSnapshot().items[1]?.shadowed).toBeUndefined()
  expect(f.editor().needsRefresh).toBe(true)
  await expect(f.editor().publish(signal())).rejects.toThrow()
})

it('preserves an unknown or conflicting package without renewing its captured native edit or replaying', async () => {
  for (const kind of ['conflict', 'unknown'] as const) {
    const f = managedFixture()
    f.update.mockResolvedValueOnce({ kind })
    await f.editor().refresh(signal()); await f.editor().open('first', signal())
    f.editor().choose(await files())
    await f.editor().publish(signal())
    expect(f.editor().outcome).toEqual({ kind })
    expect(f.editor().draft?.bundle.kind).toBe('files')
    expect(f.details).toHaveBeenCalledTimes(1)
    expect(f.installed).toHaveBeenCalledTimes(1)
    await expect(f.editor().publish(signal())).rejects.toThrow()
    expect(f.update).toHaveBeenCalledTimes(1)
  }
})

it('passes a complete ZIP once and installs only the returned native item', async () => {
  const f = managedFixture()
  await f.editor().open(undefined, signal())
  const file = new File(['ZIP bytes'], 'package.skill')
  f.editor().choose({ kind: 'zip', file })
  await f.editor().publish(signal())
  expect(f.install).toHaveBeenCalledExactlyOnceWith({ kind: 'zip', file }, expect.any(AbortSignal))
  expect(f.source.getSnapshot().items.map(row => row.id)).toEqual(['first', 'second', 'third'])
})

it('does not replace an opened edit during list refresh and rejects delayed local copies after a new edit', async () => {
  const f = managedFixture()
  await f.editor().refresh(signal()); await f.editor().open('first', signal())
  const old = f.editor()
  await f.editor().refresh(signal())
  old.choose(await files())
  expect(f.details).toHaveBeenCalledTimes(1)
  await f.editor().open('second', signal())
  expect(() => { old.choose({ kind: 'zip', file: new File(['x'], 'x.zip') }) }).toThrow()
  await expect(f.editor().publish(signal())).rejects.toThrow()
  expect(f.update).not.toHaveBeenCalled()
})

it('removes future discovery from the confirmed response without clearing local drafts or inventing resource cleanup', async () => {
  const f = managedFixture()
  await f.editor().refresh(signal()); await f.editor().open('first', signal())
  f.editor().choose(await files())
  await f.editor().uninstall(signal())
  expect(f.source.getSnapshot().items.map(row => row.id)).toEqual(['second'])
  expect(f.editor().draft).toBeDefined()
  expect(f.uninstall).toHaveBeenCalledTimes(1)
  expect(f.update).not.toHaveBeenCalled()
  expect(f.editor().outcome).toEqual({ kind: 'persisted', applied: true, item: null })
})

it('does not publish a late native success after original dependency withdrawal', async () => {
  const f = managedFixture(), held = Promise.withResolvers<ManagedSkillOutcome>()
  f.update.mockReturnValueOnce(held.promise)
  await f.editor().refresh(signal()); await f.editor().open('first', signal()); f.editor().choose(await files())
  const publication = f.editor().publish(signal())
  f.revoke()
  held.resolve({ kind: 'persisted', applied: true, item: card('first', 'late-v2') })
  await publication
  expect(f.source.getSnapshot().phase).toBe('unavailable')
  expect(f.source.getSnapshot().items[0]?.version).toBe('v1')
  expect(f.source.getSnapshot().managed?.outcome).toEqual({ kind: 'unknown' })
  expect(f.source.getSnapshot().managed?.draft).toBeDefined()
})

it('joins one download observation at a time and reports browser initiation separately', async () => {
  const f = managedFixture(), held = Promise.withResolvers<undefined>()
  f.download.mockReturnValueOnce(held.promise)
  await f.editor().refresh(signal()); await f.editor().open('first', signal())
  const request = f.editor().download(signal())
  expect(f.editor().phase).toBe('downloading')
  await expect(f.editor().download(signal())).rejects.toThrow()
  held.resolve(undefined); await request
  expect(f.editor().downloadStarted).toBe(true)
  expect(f.editor().phase).toBe('editing')
  expect(f.update).not.toHaveBeenCalled()
})

it('clears A file content on a different scope even with the same installation id and ignores A late publication', async () => {
  const f = managedFixture(), held = Promise.withResolvers<ManagedSkillOutcome>()
  f.update.mockReturnValueOnce(held.promise)
  await f.editor().refresh(signal()); await f.editor().open('first', signal())
  const local = await files()
  f.editor().choose({ ...local, markdown: 'A-private-draft' })
  const publication = f.editor().publish(signal())
  attachManagedSkillEditing(f.source, { scope: 'account-B:dependency', signal: signal(), assertCurrent: () => {},
    installed: f.installed, details: f.details })
  expect(f.source.getSnapshot().managed?.draft).toBeUndefined()
  expect(f.source.getSnapshot().managed?.outcome).toBeUndefined()
  await f.editor().refresh(signal())
  held.resolve({ kind: 'persisted', applied: true, item: card('first', 'A-late') })
  await publication
  f.withdraw()
  expect(f.source.getSnapshot().managed?.scope).toBe('account-B:dependency')
  expect(f.source.getSnapshot().managed?.draft).toBeUndefined()
  expect(f.source.getSnapshot().items[0]?.version).toBe('v1')
  expect(f.source.getSnapshot().phase).toBe('ready')
})

it('retains a local draft only when reattaching the exact original scope', async () => {
  const f = managedFixture()
  await f.editor().open('first', signal()); f.editor().choose(await files())
  const draft = f.editor().draft
  f.withdraw()
  attachManagedSkillEditing(f.source, { scope: 'original-page:dependency', signal: signal(), assertCurrent: () => {},
    installed: f.installed, details: f.details })
  expect(f.editor().draft).toBe(draft)
  expect(f.editor().phase).toBe('idle')
  await expect(f.editor().publish(signal())).rejects.toThrow()
  expect(f.update).not.toHaveBeenCalled()
})

it('keeps the legacy two-file editor on the same stable source without replacing managed rows or leaking it into B', async () => {
  const f = managedFixture()
  const publish = async (): Promise<Awaited<ReturnType<PreparedSkillEdit['publish']>>> => ({ kind: 'unknown' })
  attachSkillVersionEditing(f.source, { scope: 'original-page:dependency', signal: signal(), maxFileBytes: 4096,
    assertCurrent: () => {}, title: () => 'Legacy sample', prepare: async () => ({ source: null, installed: false,
      applied: false, resources: 'unavailable', publish }) })
  await f.editor().refresh(signal())
  const rows = f.source.getSnapshot().items
  await f.source.getSnapshot().sample?.open(signal())
  f.source.getSnapshot().sample?.copyFiles({ markdown: 'A legacy draft', resourceBase64: 'AA==' })
  await f.source.getSnapshot().sample?.publish(signal())
  expect(f.source.getSnapshot().managed?.scope).toBe('original-page:dependency')
  expect(f.source.getSnapshot().items).toBe(rows)
  expect(f.source.getSnapshot().sample?.draft?.markdown).toBe('A legacy draft')
  attachManagedSkillEditing(f.source, { scope: 'account-B:dependency', signal: signal(), assertCurrent: () => {},
    installed: f.installed, details: f.details })
  expect(f.source.getSnapshot().sample).toBeUndefined()
  expect(f.source.getSnapshot().managed?.draft).toBeUndefined()
})

it('invalidates native coverage after a confirmed legacy change without renewing a generic edit', async () => {
  const f = managedFixture()
  await f.editor().refresh(signal()); await f.editor().open('first', signal())
  const editNumber = f.editor().editNumber
  attachSkillVersionEditing(f.source, { scope: 'original-page:dependency', signal: signal(), maxFileBytes: 4096,
    assertCurrent: () => {}, title: () => 'Legacy sample', prepare: async () => ({ source: null, installed: false,
      applied: false, resources: 'unavailable', publish: async () => ({ kind: 'persisted', applied: true, resources: 'unavailable',
        source: { id: 'legacy-new-version', skillSha256: 'a'.repeat(64), resourceSha256: 'b'.repeat(64), skillBytes: 12, resourceBytes: 1 } }) }) })
  await f.source.getSnapshot().sample?.open(signal())
  f.source.getSnapshot().sample?.copyFiles({ markdown: 'legacy complete', resourceBase64: 'AA==' })
  await f.source.getSnapshot().sample?.publish(signal())
  expect(f.editor().needsRefresh).toBe(true)
  expect(f.editor().editNumber).toBe(editNumber)
  expect(f.source.getSnapshot().items.map(row => row.id)).toEqual(['first', 'second'])
  expect(f.source.getSnapshot().items[0]?.shadowed).toBeUndefined()
  expect(f.installed).toHaveBeenCalledTimes(1)
  expect(f.details).toHaveBeenCalledTimes(1)
})
