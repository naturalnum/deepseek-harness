// @vitest-environment jsdom
/** Actual management presentation and original stable source, with explicit backend callback answers. */
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SkillsPage, type SkillsPageProps } from '../src/client/management/skills/SkillsPage.tsx'
import { skillsManagementDictionaries } from '../src/client/management/skills/locales.ts'
import { managedSkillCallbacks } from '../src/client/managed-skill-remote.ts'
import { remoteFixture } from './fixtures/managed-remote.client.ts'
import { managedFixture } from './fixtures/managed-skills.client.ts'
import type { ManagedSkillDetail, ManagedSkillFileContent } from '../src/client/managed-skill-editing.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
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
function withFiles(f: ReturnType<typeof page>, readFile: NonNullable<ManagedSkillDetail['readFile']>): void {
  const original = f.details.getMockImplementation()
  if (original === undefined) throw new Error('Missing fixture detail callback')
  f.details.mockImplementation(async (id, signal) => ({ ...await original(id, signal), readFile, files: [
    { path: 'SKILL.md', bytes: 20 }, { path: 'scripts/run.py', bytes: 35 }, { path: 'resource.bin', bytes: 3 },
  ] }))
}

it('opens a metadata-only dialog and reads exact selected files only after a user request', async () => {
  const f = page(), readFile = vi.fn<NonNullable<ManagedSkillDetail['readFile']>>(async path => path === 'resource.bin'
    ? { kind: 'binary' } : { kind: 'text', text: path === 'SKILL.md' ? '# Actual installed instructions' : '<script>never_execute()</script>' })
  withFiles(f, readFile)
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  fireEvent.click(await screen.findByRole('button', { name: 'first' }))
  const dialog = await screen.findByRole('dialog', { name: 'first' })
  expect(within(dialog).getByText('first description')).toBeTruthy()
  expect(within(dialog).queryByRole('navigation')).toBeNull()
  expect(within(dialog).queryByLabelText(en.archive)).toBeNull()
  expect(readFile).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: en.details }))
  await within(dialog).findByRole('heading', { name: 'Actual installed instructions' })
  expect(readFile).toHaveBeenCalledExactlyOnceWith('SKILL.md', expect.any(AbortSignal))
  fireEvent.click(within(dialog).getByRole('button', { name: 'scripts/run.py (35)' }))
  await within(dialog).findByText('<script>never_execute()</script>')
  expect(dialog.querySelector('script')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'resource.bin (3)' }))
  await within(dialog).findByText(en.binaryFile)
  expect(readFile).toHaveBeenCalledTimes(3)
  expect(f.update).not.toHaveBeenCalled()
})

it('cancels replaced file reads and ignores their late answers after switching or closing the dialog', async () => {
  const f = page(), held = Promise.withResolvers<ManagedSkillFileContent>()
  const readFile = vi.fn<NonNullable<ManagedSkillDetail['readFile']>>(async path => path === 'SKILL.md'
    ? held.promise : { kind: 'text', text: 'print("actual script")' })
  withFiles(f, readFile)
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  fireEvent.click(await screen.findByRole('button', { name: 'first' }))
  fireEvent.click(await screen.findByRole('button', { name: en.details }))
  expect(screen.getByRole('status').textContent).toBe(en.fileLoading)
  const firstSignal = readFile.mock.calls[0]?.[1]
  fireEvent.click(screen.getByRole('button', { name: 'scripts/run.py (35)' }))
  await screen.findByText('print("actual script")')
  expect(firstSignal?.aborted).toBe(true)
  await act(async () => { held.resolve({ kind: 'text', text: '# Late instructions' }); await held.promise })
  expect(screen.queryByRole('heading', { name: 'Late instructions' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'SKILL.md (20)' }))
  const lastSignal = readFile.mock.calls.at(-1)?.[1]
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(lastSignal?.aborted).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.update).not.toHaveBeenCalled()
})

it('reports a file read failure locally and retries only that exact file on request', async () => {
  const f = page(), readFile = vi.fn<NonNullable<ManagedSkillDetail['readFile']>>()
    .mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ kind: 'text', text: '# Retry instructions' })
  withFiles(f, readFile)
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  fireEvent.click(await screen.findByRole('button', { name: 'first' }))
  fireEvent.click(await screen.findByRole('button', { name: en.details }))
  await screen.findByText(en.fileReadFailed)
  expect(readFile).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByRole('heading', { name: 'Retry instructions' })
  expect(readFile).toHaveBeenCalledTimes(2)
  expect(readFile.mock.calls.map(call => call[0])).toEqual(['SKILL.md', 'SKILL.md'])
})

it('keeps a pending publication in its dialog and retains the uncertain draft after an explicit close', async () => {
  const f = page(), held = Promise.withResolvers<Awaited<ReturnType<typeof f.update>>>()
  f.update.mockReturnValueOnce(held.promise)
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  fireEvent.click(await screen.findByRole('button', { name: 'first' }))
  fireEvent.click(await screen.findByRole('button', { name: en.bundleEdit }))
  fireEvent.change(screen.getByLabelText(en.archive), { target: { files: [new File(['owned'], 'owned.zip')] } })
  fireEvent.click(screen.getByRole('button', { name: en.bundleUpdate }))
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(f.update).toHaveBeenCalledTimes(1)
  await act(async () => { held.resolve({ kind: 'unknown' }); await held.promise })
  await screen.findByText(en.sampleUnknown)
  const draft = f.editor().draft
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByText(en.bundleRetained)).toBeTruthy()
  expect(f.editor().draft).toBe(draft)
  expect(f.update).toHaveBeenCalledTimes(1)
})

it('renders multiple native installations and selects one exact detail without eager RPC or fabricated document text', async () => {
  const f = page()
  render(<SkillsPage {...f.props}/>)
  expect(f.installed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('button', { name: 'first' })
  expect(screen.getByRole('button', { name: 'second' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  const dialog = await screen.findByRole('dialog', { name: 'first' })
  expect(within(dialog).getByText('first description')).toBeTruthy()
  expect(within(dialog).queryByRole('button', { name: 'references/guide.md (20)' })).toBeNull()
  expect(within(dialog).queryByLabelText(en.bundleDirectory)).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: en.details }))
  expect(within(dialog).getByRole('button', { name: 'references/guide.md (20)' })).toBeTruthy()
  expect(within(dialog).getByText(en.documentUnavailable)).toBeTruthy()
  expect(f.details).toHaveBeenCalledExactlyOnceWith('first', expect.any(AbortSignal))
})

it('copies a complete directory with nested resources and publishes an independent edited version once', async () => {
  const f = page()
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('button', { name: 'first' })
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  fireEvent.click(await screen.findByRole('button', { name: en.bundleEdit }))
  const input = screen.getByLabelText(en.bundleDirectory)
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
  fireEvent.click(screen.getByRole('button', { name: en.import }))
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
  expect(document.querySelector('[data-skill-id=first]')).toBeNull()
})

it('rejects unsupported package selection and does not repeat an uncertain install', async () => {
  const f = page()
  f.install.mockResolvedValueOnce({ kind: 'unknown' })
  render(<SkillsPage {...f.props}/>)
  const archive = screen.getByLabelText(en.chooseArchive)
  fireEvent.change(archive, { target: { files: [new File(['not zip'], 'skill.txt')] } })
  expect(screen.getByText(en.invalidZip)).toBeTruthy()
  expect(f.installed).not.toHaveBeenCalled()
  fireEvent.change(archive, { target: { files: [new File(['zip'], 'skill.zip')] } })
  await screen.findByText(en.sampleUnknown)
  expect(f.install).toHaveBeenCalledTimes(1)
  await waitFor(() => { expect(f.props.report).toHaveBeenCalledWith('install', 'unknown') })
  expect(screen.getByRole('button', { name: en.import })).toHaveProperty('disabled', true)
})

it('shows a confirmed capacity refusal as not installed rather than an unknown outcome', async () => {
  const f = page()
  f.install.mockResolvedValueOnce({ kind: 'unavailable' })
  render(<SkillsPage {...f.props}/>)
  fireEvent.change(screen.getByLabelText(en.chooseArchive), { target: { files: [new File(['zip'], 'skill.zip')] } })
  await screen.findByText(en.bundleCapacity)
  expect(screen.queryByText(en.sampleUnknown)).toBeNull()
  expect(f.install).toHaveBeenCalledTimes(1)
  await waitFor(() => { expect(f.props.report).toHaveBeenCalledWith('install', 'unavailable') })
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
  fireEvent.click(screen.getByRole('button', { name: copy.bundleEdit }))
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
  fireEvent.click(await screen.findByRole('button', { name: en.bundleEdit }))
  const archive = screen.getByLabelText(en.archive)
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
  fireEvent.click(await screen.findByRole('button', { name: en.bundleEdit }))
  const archive = screen.getByLabelText(en.archive)
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
  fireEvent.click(await screen.findByRole('button', { name: en.bundleEdit }))
  await screen.findByLabelText(en.archive)
  expect(f.details).toHaveBeenCalledTimes(3)
  expect(f.update).toHaveBeenCalledTimes(1)
})


it.each(['en', 'zh'] as const)('shows the confirmed missing SKILL.md refusal in %s without automatically retrying', async (locale) => {
  const f = page(), copy = skillsManagementDictionaries[locale]
  f.install.mockResolvedValueOnce({ kind: 'invalid-bundle' })
  render(<SkillsPage {...f.props} t={makeTranslate(copy)}/>)
  fireEvent.change(screen.getByLabelText(copy.chooseArchive), { target: { files: [new File(['zip'], 'missing.zip')] } })
  await screen.findByText(copy.bundleMissingManifest)
  await act(async () => {})
  expect(screen.queryByText(copy.sampleUnknown)).toBeNull()
  expect(f.install).toHaveBeenCalledTimes(1)
  expect(f.editor().draft).toBeDefined()
  expect(f.props.report).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.import }).disabled).toBe(false)
  fireEvent.change(screen.getByLabelText(copy.chooseArchive), { target: { files: [new File(['fixed zip'], 'fixed.zip')] } })
  await screen.findByText(copy.bundleApplied)
  expect(f.install).toHaveBeenCalledTimes(2)
  await waitFor(() => { expect(f.props.report).toHaveBeenCalledExactlyOnceWith('install', 'confirmed') })
})

it('keeps an invalid update in the editor without reporting a permission failure', async () => {
  const f = page()
  f.update.mockResolvedValueOnce({ kind: 'invalid-bundle' })
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('button', { name: 'first' })
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  fireEvent.click(await screen.findByRole('button', { name: en.bundleEdit }))
  const archive = screen.getByLabelText(en.archive)
  vi.mocked(f.props.report).mockClear()
  fireEvent.change(archive, { target: { files: [new File(['zip'], 'missing.zip')] } })
  fireEvent.click(screen.getByRole('button', { name: en.bundleUpdate }))
  await screen.findByText(en.bundleMissingManifest)
  await act(async () => {})
  expect(f.update).toHaveBeenCalledTimes(1)
  expect(f.props.report).not.toHaveBeenCalled()
})

it('clears the missing-manifest message when opening a skill and choosing a valid replacement ZIP', async () => {
  const f = page()
  f.install.mockResolvedValueOnce({ kind: 'invalid-bundle' })
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await screen.findByRole('button', { name: 'first' })
  await waitFor(() => { expect(f.props.report).toHaveBeenCalledWith('refresh', 'confirmed') })
  vi.mocked(f.props.report).mockClear()
  fireEvent.change(screen.getByLabelText(en.chooseArchive), { target: { files: [new File(['zip'], 'missing.zip')] } })
  await screen.findByText(en.bundleMissingManifest)
  fireEvent.click(screen.getByRole('button', { name: 'first' }))
  fireEvent.click(await screen.findByRole('button', { name: en.bundleEdit }))
  const archive = screen.getByLabelText(en.archive)
  expect(screen.queryByText(en.bundleMissingManifest)).toBeNull()
  expect(screen.queryByText(en.invalidZip)).toBeNull()
  fireEvent.change(archive, { target: { files: [new File([new Uint8Array(7462)], 'fixed.zip')] } })
  expect(screen.getByText('fixed.zip (7462)')).toBeTruthy()
  expect(screen.queryByText(en.invalidZip)).toBeNull()
  expect(f.props.report).not.toHaveBeenCalled()
})

it('opens the native picker before any webpage import dialog and ignores an empty selection', () => {
  const f = page()
  render(<SkillsPage {...f.props}/>)
  const input = screen.getByLabelText(en.chooseArchive), choose = vi.spyOn(input, 'click')
  fireEvent.click(screen.getByRole('button', { name: en.import }))
  expect(choose).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.change(input, { target: { files: [] } })
  expect(f.installed).not.toHaveBeenCalled()
  expect(f.install).not.toHaveBeenCalled()
})

it('imports the original .skill archive once through installZip while its native publication is pending', async () => {
  const f = page(), held = Promise.withResolvers<Awaited<ReturnType<typeof f.install>>>()
  f.install.mockReturnValueOnce(held.promise)
  render(<SkillsPage {...f.props}/>)
  const input = screen.getByLabelText(en.chooseArchive), file = new File(['selected complete package'], 'actual.skill')
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => { expect(f.install).toHaveBeenCalledTimes(1) })
  fireEvent.change(input, { target: { files: [file] } })
  expect(f.install.mock.calls[0]?.[0]).toEqual({ kind: 'zip', file })
  await act(async () => { held.resolve({ kind: 'unknown' }); await held.promise })
  await screen.findByText(en.sampleUnknown)
  fireEvent.change(input, { target: { files: [file] } })
  expect(f.install).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: en.import })).toHaveProperty('disabled', true)
})

it('renders supplied root Markdown in the summary and keeps complete-package download separate from file reads', async () => {
  const f = page(), readFile = vi.fn<NonNullable<ManagedSkillDetail['readFile']>>()
  const original = f.details.getMockImplementation()
  if (original === undefined) throw new Error('Missing fixture detail callback')
  f.details.mockImplementation(async (id, signal) => ({ ...await original(id, signal), readFile,
    markdown: '# Installed instructions\n\n**Read** `references/guide.md`\n\n<script>never_execute()</script>' }))
  render(<SkillsPage {...f.props}/>)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  fireEvent.click(await screen.findByRole('button', { name: 'first' }))
  const dialog = screen.getByRole('dialog')
  await within(dialog).findByRole('heading', { name: 'Installed instructions' })
  expect(dialog.querySelector('script')).toBeNull()
  expect(readFile).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: en.bundleDownload }))
  await within(dialog).findByText(en.bundleDownloadStarted)
  expect(f.download).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
  expect(f.source.getSnapshot().items[0]?.version).toBe('v1')
})

it('aborts import preparation on scope replacement without publishing a late selected package', async () => {
  const f = page(), held = Promise.withResolvers<Awaited<ReturnType<typeof f.installed>>>()
  f.installed.mockReturnValueOnce(held.promise)
  const view = render(<SkillsPage {...f.props}/>)
  fireEvent.change(screen.getByLabelText(en.chooseArchive), { target: { files: [new File(['package'], 'late.skill')] } })
  const signal = f.installed.mock.calls[0]?.[0]
  view.rerender(<SkillsPage {...f.props} scope="replacement-account"/>)
  expect(signal?.aborted).toBe(true)
  await act(async () => { held.resolve({ items: [], limits: { maxFiles: 8, maxEntries: 16, maxDirectories: 8, maxPathDepth: 4,
    maxPathBytes: 128, maxFileBytes: 4096, maxTotalBytes: 8192, maxArchiveBytes: 8192 }, install: f.install }); await held.promise })
  expect(f.install).not.toHaveBeenCalled()
  expect(f.props.report).not.toHaveBeenCalled()
})

it.each(['en', 'zh'] as const)('renders actual managed import metadata in %s and filters it as personal import', async (locale) => {
  const f = page(), native = remoteFixture(), copy = skillsManagementDictionaries[locale]
  const api = managedSkillCallbacks(native.remote, native.input)
  f.installed.mockImplementation(api.installed)
  f.details.mockImplementation(api.details)
  render(<SkillsPage {...f.props} t={makeTranslate(copy)}/>)
  fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
  const title = await screen.findByRole('button', { name: native.entry.name })
  const card = screen.getByRole('article')
  expect(within(card).getByText(copy.importedSource)).toBeTruthy()
  expect(within(card).queryByText(native.entry.contentVersion)).toBeNull()
  expect(within(card).getByText(copy.invocationBoth)).toBeTruthy()
  expect(within(card).queryByRole('switch')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: copy.imported }))
  expect(screen.getAllByRole('article')).toHaveLength(1)
  fireEvent.click(title)
  const dialog = await screen.findByRole('dialog', { name: native.entry.name })
  expect(within(dialog).getByText(copy.importedSource)).toBeTruthy()
  expect(within(dialog).queryByText(`${copy.version} ${native.entry.contentVersion}`)).toBeNull()
  fireEvent.click(within(dialog).getByText(copy.packageMetadata))
  expect(within(dialog).getByText(copy.contentId)).toBeTruthy()
  expect(within(dialog).getByText(native.entry.contentVersion)).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: copy.bundleDownload })).toHaveProperty('disabled', false)
  expect(within(dialog).getByRole('button', { name: copy.bundleEdit })).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: copy.remove })).toBeTruthy()
  expect(within(dialog).queryByRole('switch')).toBeNull()
})

it.each(['en', 'zh'] as const)('shows bundled deployment restrictions in %s without an editable switch or claiming dependency availability', async (locale) => {
  const f = page(), native = remoteFixture(), copy = skillsManagementDictionaries[locale]
  const entry = { ...native.entry, name: 'office-docx', source: 'bundled', provider: 'dsh-office', mutable: false,
    invocation: { modelInvocable: false, userInvocable: false }, actions: { update: false, uninstall: false, download: true } }
  native.installed.mockResolvedValue({ ok: true, value: { ...native.state, entries: [entry] } })
  native.details.mockResolvedValue({ ok: true, value: { entry, files: [], markdown: '# Native package instructions', version: { ...native.state.version } } })
  const api = managedSkillCallbacks(native.remote, native.input)
  f.installed.mockImplementation(api.installed); f.details.mockImplementation(api.details)
  render(<SkillsPage {...f.props} t={makeTranslate(copy)}/>)
  fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
  const title = await screen.findByRole('button', { name: 'office-docx' })
  const card = screen.getByRole('article')
  expect(within(card).getByText(copy.bundledSource)).toBeTruthy()
  expect(within(card).getByText(copy.invocationNone)).toBeTruthy()
  expect(within(card).queryByRole('switch')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: copy['writing-office'] }))
  expect(screen.getAllByRole('article')).toHaveLength(1)
  fireEvent.click(title)
  const dialog = await screen.findByRole('dialog', { name: 'office-docx' })
  expect(within(dialog).getByText(copy.invocationNone)).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: copy.bundleDownload })).toHaveProperty('disabled', false)
  expect(within(dialog).queryByRole('button', { name: copy.bundleEdit })).toBeNull()
  expect(within(dialog).queryByRole('button', { name: copy.remove })).toBeNull()
  expect(within(dialog).queryByRole('switch')).toBeNull()
})

it.each(['incomplete', 'shadowed'] as const)('preserves %s selection separately from invocation policy', async (kind) => {
  const f = page(), native = remoteFixture()
  const selection = kind === 'incomplete' ? { kind: 'incomplete' as const }
    : { kind: 'shadowed' as const, by: { name: 'office', source: 'bundled', provider: 'dsh-office' } }
  native.installed.mockResolvedValueOnce({ ok: true, value: { ...native.state, entries: [{ ...native.entry, selection }] } })
  f.installed.mockImplementation(managedSkillCallbacks(native.remote, native.input).installed)
  render(<SkillsPage {...f.props} t={makeTranslate(skillsManagementDictionaries.zh)}/>)
  fireEvent.click(screen.getByRole('button', { name: skillsManagementDictionaries.zh.refresh }))
  await screen.findByRole('button', { name: native.entry.name })
  const card = screen.getByRole('article')
  expect(within(card).getByText(skillsManagementDictionaries.zh.invocationBoth)).toBeTruthy()
  expect(within(card).queryByRole('switch')).toBeNull()
  expect(within(card).getByText(kind === 'incomplete' ? skillsManagementDictionaries.zh.bundleSelectionUnknown
    : '优先于此项：office（内置）')).toBeTruthy()
})


it.each(['en', 'zh'] as const)('keeps a native restricted report download disabled with a generic hint in %s', async (locale) => {
  const f = page(), native = remoteFixture(), copy = skillsManagementDictionaries[locale]
  const entry = { ...native.entry, name: 'technical-report', source: 'bundled', provider: 'dsh-reports', mutable: false,
    invocation: { modelInvocable: false, userInvocable: false }, actions: { update: false, uninstall: false, download: false } }
  native.installed.mockResolvedValue({ ok: true, value: { ...native.state, entries: [entry] } })
  native.details.mockResolvedValue({ ok: true, value: { entry, files: [], markdown: '# Native report instructions', version: { ...native.state.version } } })
  const api = managedSkillCallbacks(native.remote, native.input)
  f.installed.mockImplementation(api.installed); f.details.mockImplementation(api.details)
  render(<SkillsPage {...f.props} t={makeTranslate(copy)}/>)
  fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
  await screen.findByRole('button', { name: entry.name })
  fireEvent.click(screen.getByRole('button', { name: copy['writing-office'] }))
  fireEvent.click(screen.getByRole('button', { name: entry.name }))
  const dialog = await screen.findByRole('dialog', { name: entry.name })
  const download = within(dialog).getByRole('button', { name: copy.bundleDownload })
  expect(download).toHaveProperty('disabled', true)
  expect(within(dialog).getByText(copy.bundleDownloadUnavailable)).toBeTruthy()
  expect(download.getAttribute('aria-describedby')).toBe(within(dialog).getByText(copy.bundleDownloadUnavailable).id)
  fireEvent.click(download)
  expect(native.download).not.toHaveBeenCalled()
  expect(within(dialog).getByText(copy.invocationNone)).toBeTruthy()
  expect(within(dialog).queryByRole('switch')).toBeNull()
})


it.each(['en', 'zh'] as const)('shows the complete18428-byte immutable root in the %s file view and revokes it on observed version replacement', async (locale) => {
  const f = page(), native = remoteFixture(), copy = skillsManagementDictionaries[locale]
  const markdown = readFileSync(resolve(import.meta.dirname, '../../../skill/skill-office/assets/reports/tech-report-writer/SKILL.md'), 'utf8')
  const entry = { ...native.entry, name: 'tech-report-writer', source: 'bundled', mutable: false,
    actions: { update: false, uninstall: false, download: false } }
  const state = { ...native.state, entries: [entry], limits: { ...native.state.limits, maxFileBytes: 8192 } }
  native.installed.mockResolvedValue({ ok: true, value: state })
  native.details.mockResolvedValue({ ok: true, value: { entry, markdown, version: state.version,
    files: [{ relativePath: 'SKILL.md', bytes: Buffer.byteLength(markdown), sha256: createHash('sha256').update(markdown).digest('hex') }] } })
  const api = managedSkillCallbacks(native.remote, native.input)
  f.installed.mockImplementation(api.installed); f.details.mockImplementation(api.details)
  render(<SkillsPage {...f.props} t={makeTranslate(copy)}/>)
  fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
  fireEvent.click(await screen.findByRole('button', { name: entry.name }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: copy.details }))
  const document = within(dialog).getByRole('region', { name: copy.document })
  await within(document).findByRole('heading', { name: 'JSON 写入要求' })
  expect(within(dialog).getByRole('button', { name: 'SKILL.md (18428)' })).toBeTruthy()
  expect(within(document).queryByRole('alert')).toBeNull()
  expect(native.readFile).not.toHaveBeenCalled()
  native.installed.mockResolvedValue({ ok: true, value: { ...state,
    entries: [{ ...entry, contentVersion: brandString<typeof entry.contentVersion>('replaced') }] } })
  await act(async () => { await f.editor().refresh(new AbortController().signal) })
  expect(screen.queryByRole('dialog')).toBeNull()
})
