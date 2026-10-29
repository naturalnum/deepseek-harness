// @vitest-environment jsdom
/** Actual management presentation and original stable source, with explicit backend callback answers. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

it('keeps an oversized ZIP distinct from a failure to read the installation source', async () => {
  const f = page()
  render(<SkillsPage {...f.props}/>)
  fireEvent.change(screen.getByLabelText(en.chooseArchive), { target: { files: [new File([new Uint8Array(8193)], 'large.zip')] } })
  await screen.findByText(en.invalidZip)
  expect(screen.queryByText(en.unavailable)).toBeNull()
  expect(f.install).not.toHaveBeenCalled()
})

it.each(['unavailable', 'conflict'] as const)('retains the prior %s result when the next ZIP source read fails', async (kind) => {
  const f = page()
  f.install.mockResolvedValueOnce({ kind })
  render(<SkillsPage {...f.props}/>)
  const archive = screen.getByLabelText(en.chooseArchive), message = kind === 'conflict' ? en.sampleConflict : en.bundleCapacity
  fireEvent.change(archive, { target: { files: [new File(['first'], 'first.zip')] } })
  await screen.findByText(message)
  const draft = f.editor().draft
  f.installed.mockRejectedValueOnce(new Error('synthetic source read failure'))
  fireEvent.change(archive, { target: { files: [new File(['second'], 'second.zip')] } })
  await screen.findByText(en.unavailable)
  expect(screen.getByText(message)).toBeTruthy()
  expect(f.editor().draft).toBe(draft)
  expect(f.install).toHaveBeenCalledTimes(1)
})

it.each([true, false])('replaces a previous applied=%s success with the next ZIP source-read failure', async (applied) => {
  const f = page()
  f.install.mockResolvedValueOnce({ kind: 'persisted', applied, item: null })
  render(<SkillsPage {...f.props}/>)
  const archive = screen.getByLabelText(en.chooseArchive)
  fireEvent.change(archive, { target: { files: [new File(['first'], 'first.zip')] } })
  const success = applied ? en.bundleApplied : en.bundleSavedPending
  await screen.findByText(success)
  const draft = f.editor().draft
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.installed>>>()
  f.installed.mockReturnValueOnce(held.promise)
  fireEvent.change(archive, { target: { files: [new File(['second'], 'second.zip')] } })
  expect(screen.queryByText(success)).toBeNull()
  await act(async () => { held.reject(new Error('synthetic source read failure')); await held.promise.catch(() => {}) })
  await screen.findByText(en.unavailable)
  expect(screen.queryByText(success)).toBeNull()
  expect(screen.queryByText(en.invalidZip)).toBeNull()
  expect(f.editor().draft).toBe(draft)
  expect(f.install).toHaveBeenCalledTimes(1)
  await waitFor(() => { expect(f.props.report).toHaveBeenLastCalledWith('install', 'unavailable') })
})

it.each(['en', 'zh'] as const)('distinguishes a failed download from an invalid package in %s and clears only the download error on retry', async (locale) => {
  const f = page(), copy = skillsManagementDictionaries[locale]
  render(<SkillsPage {...f.props} t={makeTranslate(copy)}/>)
  fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
  await screen.findByRole('button', { name: 'first' })
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  const download = await screen.findByRole('button', { name: copy.bundleDownload })
  f.download.mockRejectedValueOnce(new Error('synthetic download failure'))
  fireEvent.click(download)
  await screen.findByRole('alert')
  expect(screen.queryByText(copy.bundleInvalid)).toBeNull()
  expect(f.download).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByLabelText(copy.archive), { target: { files: [new File(['x'], 'wrong.txt')] } })
  expect(screen.getByText(copy.bundleInvalid)).toBeTruthy()
  expect(screen.getByText(copy.bundleDownloadFailed)).toBeTruthy()
  fireEvent.click(download)
  await screen.findByText(copy.bundleDownloadStarted)
  expect(screen.queryByText(copy.bundleDownloadFailed)).toBeNull()
  expect(screen.getByText(copy.bundleInvalid)).toBeTruthy()
  expect(f.download).toHaveBeenCalledTimes(2)
  expect(f.update).not.toHaveBeenCalled()
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

it.each(['unknown', 'conflict'] as const)('keeps a %s write and draft visible after a failed re-open without publishing again', async (kind) => {
  const f = page()
  f.update.mockResolvedValueOnce({ kind })
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('button', { name: 'first' })
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  const archive = await screen.findByLabelText(en.archive)
  fireEvent.change(archive, { target: { files: [new File(['archive bytes'], 'skill.zip')] } })
  fireEvent.click(screen.getByRole('button', { name: en.bundleUpdate }))
  const result = kind === 'unknown' ? en.sampleUnknown : en.sampleConflict
  await screen.findByText(result)
  const draft = f.editor().draft
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.getByText(result)).toBeTruthy()
  expect(screen.getByText(en.bundleRetained)).toBeTruthy()
  expect(f.details).toHaveBeenCalledTimes(1)
  f.details.mockRejectedValueOnce(new Error('read unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  await screen.findByText(en.unavailable)
  expect(screen.getByText(result)).toBeTruthy()
  expect(f.editor().draft).toBe(draft)
  expect(f.details).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  await screen.findByLabelText(en.archive)
  expect(f.details).toHaveBeenCalledTimes(3)
  expect(f.update).toHaveBeenCalledTimes(1)
})
