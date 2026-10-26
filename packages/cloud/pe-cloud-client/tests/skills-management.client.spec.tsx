// @vitest-environment jsdom
/** Migrated Skills presentation consumes current sources and explicit callbacks, without a legacy transport. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SkillsPage, type SkillsPageProps } from '../src/client/management/skills/SkillsPage.tsx'
import { skillsManagementDictionaries } from '../src/client/management/skills/locales.ts'
import type { SkillActionOutcome, SkillManagementView } from '../src/client/management/skills/types.ts'

afterEach(cleanup)
const en = skillsManagementDictionaries.en
function fixture() {
  const source = createSnapshotStore<SkillManagementView>({ phase: 'ready', items: [
    { id: 'sample', name: 'Sample', description: 'Existing account sample', category: 'writing-office',
      installed: true, recommended: true, status: 'published', enabled: true, canTry: true },
    { id: 'data', name: 'Data analysis', description: 'Analyze tables', category: 'data-analysis',
      installed: false, recommended: false, status: 'available' },
  ] })
  const unused = (): never => { throw new Error('No account service belongs in this presentation') }
  const props: SkillsPageProps = { ...allowAllAccess, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
    usePanelInfo: unused, useWorkspaces: unused, useResource: unused, scope: 'original-account-page',
    useSkillManagement: bindSnapshotSelector(source), t: makeTranslate(en), report: vi.fn(),
    limits: { nameCharacters: 80, descriptionCharacters: 500, instructionsBytes: 4096, archiveBytes: 1024 } }
  return { props, source }
}
it('filters original-source cards and reacts to its updates without fetching or copying an installation ledger', () => {
  const f = fixture(); render(<SkillsPage {...f.props}/>)
  expect(document.querySelectorAll('[data-skill-id]')).toHaveLength(2)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'tables' } })
  expect(document.querySelectorAll('[data-skill-id]')).toHaveLength(1)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('switch', { name: en.installed }))
  expect(document.querySelectorAll('[data-skill-id]')).toHaveLength(1)
  act(() => { f.source.set({ phase: 'ready', items: [] }) })
  expect(document.querySelectorAll('[data-skill-id]')).toHaveLength(0)
  expect(screen.getByText(en.noMatch)).toBeTruthy()
})
it('keeps missing account actions closed and does not claim an unavailable catalog is empty', () => {
  const f = fixture(); render(<SkillsPage {...f.props}/>)
  expect(screen.getByRole('button', { name: en.install })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en.import })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en.installCatalog })).toHaveProperty('disabled', true)
  act(() => { f.source.set({ phase: 'unavailable', items: [] }) })
  expect(screen.getByRole('alert').textContent).toBe(en.unavailable)
  expect(screen.queryByText(en.empty)).toBeNull()
})
it('submits a complete text draft once, keeps unknown visible and never retries or fabricates a row', async () => {
  const f = fixture(), held = Promise.withResolvers<SkillActionOutcome>()
  const installText = vi.fn<NonNullable<SkillsPageProps['installText']>>(() => held.promise)
  render(<SkillsPage {...f.props} installText={installText}/>)
  fireEvent.click(screen.getByRole('button', { name: en.install }))
  const dialog = screen.getByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText(en.name), { target: { value: 'New skill' } })
  fireEvent.change(within(dialog).getByLabelText(en.summary), { target: { value: 'Description' } })
  fireEvent.change(within(dialog).getByLabelText(en.instructions), { target: { value: '# 完整说明\n内容\n' } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.install }))
  fireEvent.click(within(dialog).getByRole('button', { name: en.pending }))
  expect(installText).toHaveBeenCalledTimes(1)
  expect(installText.mock.calls[0]![0]).toEqual({ name: 'New skill', description: 'Description', instructions: '# 完整说明\n内容\n' })
  await act(async () => { held.resolve('unknown'); await held.promise })
  expect(within(dialog).getByRole('alert').textContent).toBe(en.unknown)
  expect(within(dialog).getByRole('button', { name: en.install })).toHaveProperty('disabled', true)
  expect(document.querySelectorAll('[data-skill-id]')).toHaveLength(2)
})
it('validates archive selection locally and sends the original File only to the supplied callback', async () => {
  const f = fixture(), importPackage = vi.fn<NonNullable<SkillsPageProps['importPackage']>>(async () => 'unknown')
  render(<SkillsPage {...f.props} importPackage={importPackage}/>)
  fireEvent.click(screen.getByRole('button', { name: en.import }))
  const dialog = screen.getByRole('dialog'), input = within(dialog).getByLabelText(en.archive)
  fireEvent.change(input, { target: { files: [new File(['x'], 'wrong.txt')] } })
  expect(within(dialog).getByRole('button', { name: en.import })).toHaveProperty('disabled', true)
  const file = new File(['synthetic package'], 'owned.zip')
  fireEvent.change(input, { target: { files: [file] } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.import }))
  await screen.findByText(en.unknown)
  expect(importPackage).toHaveBeenCalledExactlyOnceWith(file, expect.any(AbortSignal))
})
it('reads inert Markdown in the detail dialog and invokes only the supplied draft callback', async () => {
  const f = fixture(), readDetail = vi.fn(async () => ({ instructions: '# Heading\n\n<script>window.bad = true</script>' }))
  const openDraft = vi.fn<NonNullable<SkillsPageProps['openDraft']>>(async () => 'confirmed')
  render(<SkillsPage {...f.props} readDetail={readDetail} openDraft={openDraft}/>)
  fireEvent.click(screen.getAllByRole('button', { name: 'Sample' })[0]!)
  const dialog = screen.getByRole('dialog')
  await within(dialog).findByRole('heading', { name: 'Heading' })
  expect(dialog.querySelector('script')).toBeNull()
  expect(within(dialog).getByText('<script>window.bad = true</script>')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: en.try }))
  await act(async () => {})
  expect(openDraft).toHaveBeenCalledExactlyOnceWith('sample', expect.any(AbortSignal))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('revokes local observation on scope replacement and ignores a late action response', async () => {
  const f = fixture(), held = Promise.withResolvers<SkillActionOutcome>()
  const installCatalog = vi.fn<NonNullable<SkillsPageProps['installCatalog']>>(() => held.promise)
  const view = render(<SkillsPage {...f.props} installCatalog={installCatalog}/>)
  fireEvent.click(screen.getByRole('button', { name: en.installCatalog }))
  const signal = installCatalog.mock.calls[0]![1]
  view.rerender(<SkillsPage {...f.props} scope="replacement-page" installCatalog={installCatalog}/>)
  expect(signal.aborted).toBe(true)
  await act(async () => { held.resolve('confirmed'); await held.promise })
  expect(f.props.report).not.toHaveBeenCalled()
  expect(document.querySelectorAll('[data-skill-id]')).toHaveLength(2)
})
