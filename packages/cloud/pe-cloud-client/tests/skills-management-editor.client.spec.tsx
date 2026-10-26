// @vitest-environment jsdom
/** The management page edits its original source through a test renderer hook and scripted native edit callback. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SkillsPage, type SkillsPageProps } from '../src/client/management/skills/SkillsPage.tsx'
import { skillsManagementDictionaries } from '../src/client/management/skills/locales.ts'
import { attachSkillVersionEditing } from '../src/client/skill-version-editing.ts'
import { prepareCloudSkillEdit, type CloudSkillRemote, type PreparedSkillEdit } from '../src/client/skill-edit.ts'
import type { SkillManagementView } from '../src/client/management/skills/types.ts'

afterEach(cleanup)
const en = skillsManagementDictionaries.en
const metadata = { id: 'published-original', skillSha256: 'a'.repeat(64), resourceSha256: 'b'.repeat(64), skillBytes: 10, resourceBytes: 3 }
function file(name: string, bytes: Uint8Array): File {
  return Object.assign(new File([bytes.slice().buffer], name), { arrayBuffer: async () => bytes.slice().buffer })
}
function fixture() {
  const source = createSnapshotStore<SkillManagementView>({ phase: 'unavailable', items: [] })
  const publish = vi.fn<PreparedSkillEdit['publish']>(async () => ({ kind: 'unknown' }))
  const prepare = vi.fn<(signal: AbortSignal) => Promise<PreparedSkillEdit>>(async () => ({ source: metadata, installed: true, applied: false, resources: 'unavailable', publish }))
  const withdraw = attachSkillVersionEditing(source, { scope: 'page:dependency', signal: new AbortController().signal, maxFileBytes: 4096,
    assertCurrent: () => {}, prepare, title: () => 'Actual sample' })
  const unused = (): never => { throw new Error('No session or service belongs in this sample editor') }
  const props: SkillsPageProps = { ...allowAllAccess, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
    usePanelInfo: unused, useWorkspaces: unused, useResource: unused, scope: 'original-page', useSkillManagement: bindSnapshotSelector(source),
    t: makeTranslate(en), report: vi.fn() }
  return { source, props, publish, prepare, withdraw }
}
it('copies complete UTF-8/binary files into an independent draft and retains it after an uncertain publication and remount', async () => {
  const f = fixture(), view = render(<SkillsPage {...f.props}/>)
  expect(f.prepare).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: en.install })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en.import })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: en.sampleOpen }))
  await screen.findByText(en.samplePresent)
  expect(screen.getByText(en.sampleBodyUnavailable)).toBeTruthy()
  const original = '\uFEFF---\nname: sample\n---\n完整原始说明\n'
  fireEvent.change(screen.getByLabelText(en.sampleMarkdownFile), { target: { files: [file('SKILL.md', new TextEncoder().encode(original))] } })
  fireEvent.change(screen.getByLabelText(en.sampleResourceFile), { target: { files: [file('resource.bin', Uint8Array.from([0, 255, 1]))] } })
  fireEvent.click(screen.getByRole('button', { name: en.sampleCopy }))
  const editable = await screen.findByLabelText(en.sampleEditable)
  expect(editable).toHaveProperty('value', original)
  fireEvent.change(editable, { target: { value: '修改后的完整说明\n' } })
  expect(f.source.getSnapshot().sample?.draft?.original.markdown).toBe(original)
  expect(f.source.getSnapshot().sample?.source).toEqual(metadata)
  fireEvent.click(screen.getByRole('button', { name: en.samplePublish }))
  await screen.findByText(en.sampleUnknown)
  expect(f.publish).toHaveBeenCalledExactlyOnceWith('修改后的完整说明\n', 'AP8B', expect.any(AbortSignal))
  expect(screen.getByRole('button', { name: en.samplePublish })).toHaveProperty('disabled', true)
  expect(f.prepare).toHaveBeenCalledTimes(1)
  view.unmount(); render(<SkillsPage {...f.props}/>)
  expect(screen.getByLabelText(en.sampleEditable)).toHaveProperty('value', '修改后的完整说明\n')
  expect(screen.getByText(en.sampleUnknown)).toBeTruthy()
  expect(f.prepare).toHaveBeenCalledTimes(1)
  act(f.withdraw)
  expect(f.source.getSnapshot().sample?.draft?.original.markdown).toBe(original)
})
it('rejects invalid UTF-8 and prevents a pending local file read from changing the source after unmount', async () => {
  const f = fixture(), view = render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.sampleOpen }))
  await screen.findByLabelText(en.sampleMarkdownFile)
  fireEvent.change(screen.getByLabelText(en.sampleMarkdownFile), { target: { files: [file('SKILL.md', Uint8Array.from([0xc3, 0x28]))] } })
  fireEvent.change(screen.getByLabelText(en.sampleResourceFile), { target: { files: [file('resource.bin', new Uint8Array())] } })
  fireEvent.click(screen.getByRole('button', { name: en.sampleCopy }))
  await screen.findByText(en.sampleInvalid)
  expect(f.source.getSnapshot().sample?.draft).toBeUndefined()
  await waitFor(() => { expect(screen.getByRole('button', { name: en.sampleCopy })).toHaveProperty('disabled', false) })
  const held = Promise.withResolvers<ArrayBuffer>()
  const late = Object.assign(new File(['late'], 'SKILL.md'), { arrayBuffer: () => held.promise })
  fireEvent.change(screen.getByLabelText(en.sampleMarkdownFile), { target: { files: [late] } })
  fireEvent.click(screen.getByRole('button', { name: en.sampleCopy }))
  view.unmount()
  await act(async () => { held.resolve(new TextEncoder().encode('Late original').buffer); await held.promise })
  expect(f.source.getSnapshot().sample?.draft).toBeUndefined()
  expect(f.publish).not.toHaveBeenCalled()
})

it('retires an unused edit on navigation and preserves the draft until an explicit new edit', async () => {
  type Current = Extract<Awaited<ReturnType<CloudSkillRemote['current']>>, { ok: true }>['value']
  const version: Current['version'] = { epoch: brandString<Current['version']['epoch']>('original-epoch'),
    editToken: brandString<Current['version']['editToken']>('first-edit') }
  const next = { ...version, editToken: brandString<Current['version']['editToken']>('explicit-new-edit') }
  const current = vi.fn<CloudSkillRemote['current']>(async () => ({ ok: true,
    value: { slot: 'sample', version, current: metadata, applied: false, resources: 'unavailable' } }))
  const publish = vi.fn<CloudSkillRemote['publish']>(async () => ({ ok: true,
    value: { persisted: true, version: next, current: metadata, applied: false, resources: 'unavailable' } }))
  const remote: CloudSkillRemote = { current, publish }, lifetime = new AbortController(), f = fixture()
  f.prepare.mockImplementation(observer => prepareCloudSkillEdit(remote, {
    signal: lifetime.signal, timeoutMs: 1000, assertCurrent: () => {},
  }, observer))
  const view = render(<SkillsPage {...f.props}/>), stable = f.source
  fireEvent.click(screen.getByRole('button', { name: en.sampleOpen }))
  await screen.findByLabelText(en.sampleMarkdownFile)
  const original = 'Complete original instructions\n', edited = 'Complete edited instructions\n'
  fireEvent.change(screen.getByLabelText(en.sampleMarkdownFile), {
    target: { files: [file('SKILL.md', new TextEncoder().encode(original))] },
  })
  fireEvent.change(screen.getByLabelText(en.sampleResourceFile), {
    target: { files: [file('resource.bin', Uint8Array.from([0, 255, 1]))] },
  })
  fireEvent.click(screen.getByRole('button', { name: en.sampleCopy }))
  await screen.findByLabelText(en.sampleEditable)
  fireEvent.change(screen.getByLabelText(en.sampleEditable), { target: { value: edited } })
  const draft = stable.getSnapshot().sample?.draft, observer = f.prepare.mock.calls[0]?.[0]
  expect(screen.getByRole('button', { name: en.samplePublish })).toHaveProperty('disabled', false)
  view.unmount()
  expect(observer?.aborted).toBe(true)
  render(<SkillsPage {...f.props}/>)
  expect(f.source).toBe(stable)
  expect(stable.getSnapshot().sample?.phase).toBe('idle')
  expect(stable.getSnapshot().sample?.draft).toBe(draft)
  expect(draft?.original.markdown).toBe(original)
  expect(screen.getByLabelText(en.sampleEditable)).toHaveProperty('value', edited)
  expect(screen.getByRole('button', { name: en.samplePublish })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: en.samplePublish }))
  expect(current).toHaveBeenCalledTimes(1)
  expect(publish).not.toHaveBeenCalled()
  expect(screen.queryByText(en.sampleUnknown)).toBeNull()

  current.mockResolvedValue({ ok: true, value: { slot: 'sample', version: next,
    current: metadata, applied: false, resources: 'unavailable' } })
  fireEvent.click(screen.getByRole('button', { name: en.sampleOpen }))
  await waitFor(() => { expect(screen.getByRole('button', { name: en.samplePublish })).toHaveProperty('disabled', false) })
  expect(stable.getSnapshot().sample?.draft).toBe(draft)
  expect(current).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: en.samplePublish }))
  await screen.findByText(en.samplePersisted)
  expect(publish).toHaveBeenCalledExactlyOnceWith({ slot: 'sample', version: next,
    skillMarkdown: edited, resourceBase64: 'AP8B' }, expect.any(AbortSignal))
  expect(current).toHaveBeenCalledTimes(2)
  expect(stable.getSnapshot().sample?.draft).toBe(draft)
})
