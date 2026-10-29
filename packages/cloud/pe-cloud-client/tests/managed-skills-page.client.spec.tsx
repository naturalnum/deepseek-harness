// @vitest-environment jsdom
/** Actual management presentation and original stable source, with explicit backend callback answers. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SkillsPage, type SkillsPageProps } from '../src/client/management/skills/SkillsPage.tsx'
import { skillsManagementDictionaries } from '../src/client/management/skills/locales.ts'
import { managedFixture } from './fixtures/managed-skills.client.ts'

afterEach(cleanup)
const en = skillsManagementDictionaries.en
function page() {
  const f = managedFixture()
  const unused = (): never => { throw new Error('No Session service belongs in this management presentation') }
  const props: SkillsPageProps = { ...allowAllAccess, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
    usePanelInfo: unused, useWorkspaces: unused, useResource: unused, scope: 'original-page', useSkillManagement: bindSnapshotSelector(f.source),
    t: makeTranslate(en), report: vi.fn() }
  return { ...f, props }
}
function file(path: string, text: string): File {
  const bytes = new TextEncoder().encode(text)
  return Object.assign(new File([bytes], path.split('/').at(-1) ?? path), { webkitRelativePath: path, arrayBuffer: async () => bytes.slice().buffer })
}

it('renders multiple native installations and selects one exact detail without eager RPC or fabricated document text', async () => {
  const f = page()
  render(<SkillsPage {...f.props}/>)
  expect(f.installed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('button', { name: 'first' })
  expect(screen.getByRole('button', { name: 'second' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  await screen.findByText('references/guide.md (20)')
  expect(screen.getByText(en.documentUnavailable)).toBeTruthy()
  expect(f.details).toHaveBeenCalledExactlyOnceWith('first', expect.any(AbortSignal))
})

it('copies a complete directory with nested resources and publishes an independent edited version once', async () => {
  const f = page()
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('button', { name: 'first' })
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  const input = await screen.findByLabelText(en.bundleDirectory)
  fireEvent.change(input, { target: { files: [file('bundle/SKILL.md', 'original instructions'), file('bundle/scripts/run.sh', 'echo safe-as-data')] } })
  const editable = await screen.findByLabelText(en.sampleEditable)
  expect(editable).toHaveProperty('value', 'original instructions')
  fireEvent.change(editable, { target: { value: 'edited instructions' } })
  fireEvent.click(screen.getByRole('button', { name: en.bundleUpdate }))
  await screen.findByText(en.bundleSavedPending)
  expect(f.update).toHaveBeenCalledTimes(1)
  expect(f.update.mock.calls[0]?.[0]).toMatchObject({ kind: 'files', markdown: 'edited instructions', selection: { markdown: 'original instructions' } })
  expect(screen.getByRole('button', { name: en.bundleUpdate })).toHaveProperty('disabled', true)
  expect(f.details).toHaveBeenCalledTimes(1)
})

it('imports a selected ZIP through the owner and confirms uninstall without claiming deletion of history or working copies', async () => {
  const f = page()
  render(<SkillsPage {...f.props}/>)
  const archive = screen.getByLabelText(en.chooseArchive)
  const choose = vi.spyOn(archive, 'click')
  fireEvent.click(screen.getByRole('button', { name: en.installBundle }))
  expect(choose).toHaveBeenCalledOnce()
  expect(archive.getAttribute('accept')).toContain('.zip')
  fireEvent.change(archive, { target: { files: [new File(['archive bytes'], 'skill.zip')] } })
  await screen.findByText(en.bundleApplied)
  expect(f.install).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  const remove = await screen.findByRole('button', { name: en.remove })
  fireEvent.click(remove)
  expect(screen.getByText(en.bundleRemoveHint)).toBeTruthy()
  expect(f.uninstall).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.confirmRemove }))
  await screen.findByText(en.bundleApplied)
  expect(f.uninstall).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'first' })).toBeNull()
})

it('rejects non-ZIP selection and does not repeat an uncertain install', async () => {
  const f = page()
  f.install.mockResolvedValueOnce({ kind: 'unknown' })
  render(<SkillsPage {...f.props}/>)
  const archive = screen.getByLabelText(en.chooseArchive)
  fireEvent.change(archive, { target: { files: [new File(['not zip'], 'skill.skill')] } })
  expect(screen.getByText(en.invalidZip)).toBeTruthy()
  expect(f.installed).not.toHaveBeenCalled()
  fireEvent.change(archive, { target: { files: [new File(['zip'], 'skill.zip')] } })
  await screen.findByText(en.sampleUnknown)
  expect(f.install).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: en.installBundle })).toHaveProperty('disabled', true)
})

it('shows a confirmed capacity refusal as not installed rather than an unknown outcome', async () => {
  const f = page()
  f.install.mockResolvedValueOnce({ kind: 'unavailable' })
  render(<SkillsPage {...f.props}/>)
  fireEvent.change(screen.getByLabelText(en.chooseArchive), { target: { files: [new File(['zip'], 'skill.zip')] } })
  await screen.findByText(en.bundleCapacity)
  expect(screen.queryByText(en.sampleUnknown)).toBeNull()
  expect(f.install).toHaveBeenCalledTimes(1)
})

it('leaves an uncertain draft visible after dependency withdrawal and never reopens its edit automatically', async () => {
  const f = page()
  f.update.mockResolvedValueOnce({ kind: 'unknown' })
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('button', { name: 'first' })
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  const archive = await screen.findByLabelText(en.archive)
  fireEvent.change(archive, { target: { files: [new File(['archive bytes'], 'skill.zip')] } })
  fireEvent.click(screen.getByRole('button', { name: en.bundleUpdate }))
  await screen.findByText(en.sampleUnknown)
  act(f.withdraw)
  expect(screen.getByText('skill.zip (13)')).toBeTruthy()
  expect(f.details).toHaveBeenCalledTimes(1)
  expect(f.installed).toHaveBeenCalledTimes(1)
})

it('keeps an uncertain write visible after closing the editor without calling current or publishing again', async () => {
  const f = page()
  f.update.mockResolvedValueOnce({ kind: 'unknown' })
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('button', { name: 'first' })
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  const archive = await screen.findByLabelText(en.archive)
  fireEvent.change(archive, { target: { files: [new File(['archive bytes'], 'skill.zip')] } })
  fireEvent.click(screen.getByRole('button', { name: en.bundleUpdate }))
  await screen.findByText(en.sampleUnknown)
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.getByText(en.sampleUnknown)).toBeTruthy()
  expect(screen.getByText(en.bundleRetained)).toBeTruthy()
  expect(f.details).toHaveBeenCalledTimes(1)
  f.details.mockRejectedValueOnce(new Error('read unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  await screen.findByText(en.unavailable)
  expect(screen.getByText(en.sampleUnknown)).toBeTruthy()
  expect(f.details).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  await screen.findByLabelText(en.archive)
  expect(f.details).toHaveBeenCalledTimes(3)
  expect(f.update).toHaveBeenCalledTimes(1)
})
