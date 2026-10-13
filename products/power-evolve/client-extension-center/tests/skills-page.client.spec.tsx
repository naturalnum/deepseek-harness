// @vitest-environment jsdom
import { deferredResult } from './deferred-result.ts'
import type {} from '../src/client/index.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SkillsPageProps } from '../src/client/SkillsPage.tsx'
import { SkillsPage } from '../src/client/SkillsPage.tsx'
import type { BuiltinSkill, PersonalSkill, SkillPort } from '../src/client/skills-api.ts'
import { SkillHttpClient, SkillHttpError } from '../src/client/skills-api.ts'
import { requestUrl } from './fetch-fixture.ts'
import { SkillMarkdown } from '../src/client/SkillMarkdown.tsx'
import { en } from '../src/client/locales.ts'
import { builtinCatalog as catalog, builtinWord } from './builtin-catalog-fixture.ts'

afterEach(cleanup)

const id = '5a010346-693c-4204-a386-29f66b11a057'
const item: PersonalSkill = { skillId: id, name: 'Proofreading', description: 'Check wording', enabled: true, revision: 1,
  kind: 'text', version: null, digest: 'a'.repeat(64), packageDigest: null, manifestDigest: null, observedState: 'ready' }
const t = (key: keyof typeof en) => en[key]

type FixtureSkillPort = {
  [Key in keyof SkillPort]: (...args: Parameters<SkillPort[Key]>) => ReturnType<SkillPort[Key]>
}

function port(overrides: Partial<SkillPort> = {}): FixtureSkillPort {
  return { list: vi.fn(async () => []), catalog: vi.fn(async () => catalog), read: vi.fn(),
    install: vi.fn(), installBuiltin: vi.fn(), importPackage: vi.fn(), toggle: vi.fn(), revoke: vi.fn(),
    ...overrides }
}

function fixture(client: SkillPort) {
  return render(<SkillsPage client={client} t={t} trySkill={vi.fn()} usePanelInfo={selector => selector({ activePanelId: null })} />)
}

test.each(['list', 'catalog'] as const)('a late old-account %s refusal cannot publish an error into the replacement library', async (operation) => {
  const listReply = deferredResult<readonly PersonalSkill[]>(), catalogReply = deferredResult<readonly BuiltinSkill[]>()
  const list = vi.fn<SkillPort['list']>(() => operation === 'list' ? listReply.promise : Promise.resolve([item]))
  const catalogRead = vi.fn<SkillPort['catalog']>(() => catalogReply.promise)
  const page = fixture(port({ list, catalog: catalogRead }))
  if (operation === 'catalog') await waitFor(() => { expect(catalogRead).toHaveBeenCalledOnce() })
  const bob = { ...item, skillId: 'da95a0a2-a53d-490b-a7eb-f0608ad6f2b0', name: 'Bob skill' }
  const next = port({ list: async () => [bob], catalog: async () => [] })
  page.rerender(<SkillsPage client={next} t={t} trySkill={vi.fn()} usePanelInfo={selector => selector({ activePanelId: null })} />)
  await screen.findByRole('button', { name: bob.name })
  const read = operation === 'list' ? list : catalogRead
  expect(read.mock.calls[0]?.[0]?.aborted).toBe(true)
  await act(async () => {
    if (operation === 'list') listReply.reject(new SkillHttpError(401))
    else catalogReply.reject(new SkillHttpError(401))
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: bob.name })).toBeTruthy()
  expect(read).toHaveBeenCalledOnce()
})

test.each(['success', 'failure'] as const)('a late built-in install %s cannot populate or unlock the replacement account', async (outcome) => {
  const oldReply = deferredResult<PersonalSkill>(), newReply = deferredResult<PersonalSkill>()
  const installBuiltin = vi.fn<SkillPort['installBuiltin']>(() => oldReply.promise)
  const page = fixture(port({ catalog: async () => [builtinWord], installBuiltin }))
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  fireEvent.click(await screen.findByRole('button', { name: builtinWord.name }))
  fireEvent.click(within(screen.getByRole('dialog', { name: builtinWord.name })).getByRole('button', { name: en.builtinInstall }))
  expect(installBuiltin).toHaveBeenCalledOnce()
  const bob = { ...item, skillId: 'da95a0a2-a53d-490b-a7eb-f0608ad6f2b0', name: 'Bob skill' }
  const toggle = vi.fn<SkillPort['toggle']>(() => newReply.promise)
  const next = port({ list: async () => [bob], catalog: async () => [], toggle })
  page.rerender(<SkillsPage client={next} t={t} trySkill={vi.fn()} usePanelInfo={selector => selector({ activePanelId: null })} />)
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(en.mySkills, 'u') }))
  await screen.findByRole('button', { name: bob.name })
  fireEvent.click(screen.getByRole('switch'))
  expect(toggle).toHaveBeenCalledOnce()
  expect(installBuiltin.mock.calls[0]?.[1]?.aborted).toBe(true)
  await act(async () => {
    if (outcome === 'success') oldReply.resolve({ ...item, kind: 'package', name: builtinWord.name,
      version: builtinWord.version, packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7) })
    else oldReply.reject(new SkillHttpError(401))
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText(en.installed)).toBeNull()
  expect(screen.queryByRole('button', { name: builtinWord.name })).toBeNull()
  expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
  await act(async () => { newReply.resolve({ ...bob, revision: 2, enabled: false }) })
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})

test('personal cards search, read instructions, and change enabled state', async () => {
  const client = port({
    list: vi.fn(async () => [item]),
    read: vi.fn(async () => ({ ...item, instructions: '# Instructions\nCheck wording.' })),
    install: vi.fn(),
    importPackage: vi.fn(),
    toggle: vi.fn(async () => ({ ...item, enabled: false, revision: 2 })),
    revoke: vi.fn(),
  })
  fixture(client)
  await screen.findByRole('button', { name: 'Proofreading' })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  expect(screen.getByText('No matching skills')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'proof' } })
  fireEvent.click(screen.getByRole('button', { name: 'Proofreading' }))
  const dialog = await screen.findByRole('dialog', { name: 'Proofreading' })
  await within(dialog).findByRole('heading', { name: 'Instructions' })
  fireEvent.click(within(dialog).getByRole('switch'))
  await waitFor(() => { expect(client.toggle).toHaveBeenCalledWith(id, false) })
  await waitFor(() => { expect(within(dialog).getByRole('switch').getAttribute('aria-checked')).toBe('false') })
})

test('uncertain install retries the same request and body', async () => {
  const install = vi.fn().mockRejectedValueOnce(new Error('connection lost'))
    .mockImplementationOnce(async (input: { requestId: string }) => ({ ...item, skillId: input.requestId }))
  const client = port({ list: vi.fn(async () => []), install })
  fixture(client)
  await screen.findByText('No skills are installed for this account')
  fireEvent.click(screen.getByRole('button', { name: 'Install skill' }))
  const dialog = screen.getByRole('dialog', { name: 'Install text skill' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Proofreading' } })
  fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Check wording' } })
  fireEvent.change(within(dialog).getByLabelText('Skill instructions'), { target: { value: 'Check wording.' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Install skill' }))
  await within(dialog).findByText('The installation result is uncertain. Retry will use the same request ID.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry installation' }))
  await waitFor(() => { expect(install).toHaveBeenCalledTimes(2) })
  expect(install.mock.calls[0]![0]).toEqual(install.mock.calls[1]![0])
  await screen.findByRole('button', { name: 'Proofreading' })
})

test('missing skill detail reports denial and supports a retry', async () => {
  const read = vi.fn().mockRejectedValueOnce(new SkillHttpError(404))
    .mockResolvedValueOnce({ ...item, instructions: 'Read only' })
  fixture(port({ list: async () => [item], read }))
  fireEvent.click(await screen.findByRole('button', { name: 'Proofreading' }))
  const dialog = await screen.findByRole('dialog', { name: 'Proofreading' })
  await within(dialog).findByText('This skill is unavailable to your account. Refresh the list.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
  await within(dialog).findByText('Read only')
})

test('list failure shows a retry path without presenting an empty library', async () => {
  const list = vi.fn().mockRejectedValueOnce(new SkillHttpError(401)).mockResolvedValueOnce([item])
  fixture(port({ list }))
  await screen.findByText('Your sign-in expired. Please sign in again.')
  expect(screen.queryByText('No skills are installed for this account')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }))
  await screen.findByRole('button', { name: 'Proofreading' })
})

test('instructions are rendered as text and never injected as HTML', () => {
  const view = render(<SkillMarkdown document={'# Instructions\n<script>window.stolen = true</script>'} />)
  expect(view.container.querySelector('script')).toBeNull()
  expect(view.container.textContent).toContain('<script>window.stolen = true</script>')
})

test('package import retries the same file and request, then shows version and ready status', async () => {
  const packaged: PersonalSkill = { ...item, kind: 'package', version: '1.2.3',
    packageDigest: 'b'.repeat(64), manifestDigest: 'c'.repeat(64) }
  let listed = false
  const importPackage = vi.fn().mockRejectedValueOnce(new Error('upload response lost'))
    .mockImplementationOnce(async () => { listed = true; return packaged })
  const client = port({ list: vi.fn(async () => listed ? [packaged] : []), importPackage })
  fixture(client)
  fireEvent.click(screen.getByRole('button', { name: 'Import skill package' }))
  const dialog = screen.getByRole('dialog', { name: 'Import ZIP skill package' })
  const file = new File(['ZIP bytes'], 'proofreading.zip', { type: 'application/zip' })
  fireEvent.change(within(dialog).getByLabelText<HTMLInputElement>('Skill package file'), { target: { files: [file] } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Import package' }))
  await within(dialog).findByText('The import result is uncertain. Retry uses the same file and request ID.')
  expect((within(dialog).getByLabelText<HTMLInputElement>('Skill package file')).disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry installation' }))
  await waitFor(() => { expect(importPackage).toHaveBeenCalledTimes(2) })
  expect(importPackage.mock.calls[0]![0]).toBe(file)
  expect(importPackage.mock.calls[0]![1]).toBe(importPackage.mock.calls[1]![1])
  await screen.findByText('Version 1.2.3 · Ready')
})

test('package trial opens the native draft and revoke disables later trials', async () => {
  const packaged: PersonalSkill = { ...item, kind: 'package', version: '1.2.3',
    packageDigest: 'b'.repeat(64), manifestDigest: 'c'.repeat(64) }
  const trySkill = vi.fn(async () => {})
  const revoke = vi.fn(async () => ({ ...packaged, enabled: false, observedState: 'revoked' as const, revision: 2 }))
  const client = port({ list: vi.fn(async () => [packaged]),
    read: vi.fn(async () => ({ ...packaged, instructions: '# Instructions' })),
    revoke })
  render(<SkillsPage {...({ client, t, trySkill } as SkillsPageProps)} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Proofreading' }))
  const dialog = await screen.findByRole('dialog', { name: 'Proofreading' })
  await within(dialog).findByText('Package SHA-256: ' + 'b'.repeat(64))
  fireEvent.click(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Try skill' }))
  await waitFor(() => { expect(trySkill).toHaveBeenCalledWith(packaged) })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke skill' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm revoke' }))
  await waitFor(() => { expect(revoke).toHaveBeenCalledWith(id) })
  await within(dialog).findByText('Revoked')
  expect((within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Try skill' })).disabled).toBe(true)
})

test('all skills filters the nine-item catalog and previews metadata without a Sandbox', async () => {
  const client = port()
  fixture(client)
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  await screen.findByRole('button', { name: builtinWord.name })
  expect(client.catalog).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Writing & office' }))
  expect(screen.getByRole('button', { name: builtinWord.name })).toBeTruthy()
  const excluded = catalog.find(skill => skill.id === 'builtin.excel')
  if (!excluded) throw new Error('Missing non-office catalog fixture')
  expect(screen.queryByRole('button', { name: excluded.name })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: builtinWord.name }))
  const dialog = screen.getByRole('dialog', { name: builtinWord.name })
  expect(within(dialog).getByText(builtinWord.description)).toBeTruthy()
  expect(within(dialog).getByText(/without starting a Sandbox/u)).toBeTruthy()
  expect(client.read).not.toHaveBeenCalled()
})

test('catalog failure stays visible and refresh retries without sample data', async () => {
  const catalogCall = vi.fn().mockRejectedValueOnce(new SkillHttpError(503)).mockResolvedValueOnce(catalog)
  fixture(port({ catalog: catalogCall }))
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  await screen.findByText('Could not load the built-in skill catalog. Please retry.')
  expect(screen.queryByRole('button', { name: builtinWord.name })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }))
  await screen.findByRole('button', { name: builtinWord.name })
  expect(catalogCall).toHaveBeenCalledTimes(2)
})

test('uncertain built-in install reuses request ID and updates My skills after success', async () => {
  const packaged: PersonalSkill = { ...item, name: builtinWord.name, kind: 'package', version: builtinWord.version,
    packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7) }
  const installBuiltin = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(packaged)
  const client = port({ installBuiltin, read: vi.fn(async () => ({ ...packaged, instructions: '# word instructions' })) })
  fixture(client)
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  await screen.findByRole('button', { name: builtinWord.name })
  fireEvent.click(screen.getAllByRole('button', { name: 'Install built-in skill' })[0]!)
  await screen.findByText('The installation result is uncertain. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry installation' }))
  await waitFor(() => { expect(installBuiltin).toHaveBeenCalledTimes(2) })
  expect(installBuiltin.mock.calls[0]![0]).toEqual(installBuiltin.mock.calls[1]![0])
  expect(installBuiltin.mock.calls[0]![0]).toMatchObject({ catalogId: builtinWord.id, version: builtinWord.version })
  await waitFor(() => { expect(screen.getByRole('tab', { name: /My skills/u }).getAttribute('aria-selected')).toBe('true') })
  expect(screen.getByRole('button', { name: builtinWord.name })).toBeTruthy()
  await within(screen.getByRole('dialog', { name: builtinWord.name })).findByText('word instructions')
})

test('revoked catalog installation cannot be directly reenabled', async () => {
  const revoked: PersonalSkill = { ...item, name: builtinWord.name, kind: 'package', version: builtinWord.version,
    packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7), enabled: false, observedState: 'revoked' }
  fixture(port({ list: async () => [revoked], catalog: async () => [{ ...catalog[0]!, installedSkillId: id }, ...catalog.slice(1)] }))
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  const card = (await screen.findByRole('button', { name: builtinWord.name })).closest('article')!
  expect(within(card).getByText('Revoked')).toBeTruthy()
  expect(within(card).queryByRole('switch')).toBeNull()
  expect(within(card).queryByRole('button', { name: 'Install built-in skill' })).toBeNull()
})

test('disabled catalog installation uses the personal state and can be enabled', async () => {
  const disabled: PersonalSkill = { ...item, name: builtinWord.name, kind: 'package', version: builtinWord.version,
    packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7), enabled: false }
  const toggle = vi.fn(async () => ({ ...disabled, enabled: true, revision: 2 }))
  fixture(port({ list: async () => [disabled],
    catalog: async () => [{ ...catalog[0]!, installedSkillId: id }, ...catalog.slice(1)], toggle }))
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  const card = (await screen.findByRole('button', { name: builtinWord.name })).closest('article')!
  expect(within(card).getByText('Disabled')).toBeTruthy()
  fireEvent.click(within(card).getByRole('switch'))
  await waitFor(() => { expect(toggle).toHaveBeenCalledWith(id, true) })
  await within(card).findByText('Enabled')
})

test('catalog waits for the personal list to finish preinstalling', async () => {
  const packaged: PersonalSkill = { ...item, name: builtinWord.name, kind: 'package', version: builtinWord.version,
    packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7) }
  let finishPreinstall!: () => void
  let preinstalled = false
  const list = vi.fn(() => new Promise<readonly PersonalSkill[]>((resolve) => {
    finishPreinstall = () => { preinstalled = true; resolve([packaged]) }
  }))
  const catalogCall = vi.fn(async () => [{ ...catalog[0]!, installedSkillId: preinstalled ? id : null }, ...catalog.slice(1)])
  fixture(port({ list, catalog: catalogCall }))
  fireEvent.click(screen.getByRole('tab', { name: 'All skills' }))
  expect(catalogCall).not.toHaveBeenCalled()
  await act(async () => { finishPreinstall() })
  const card = (await screen.findByRole('button', { name: builtinWord.name })).closest('article')!
  expect(catalogCall).toHaveBeenCalledTimes(1)
  expect(within(card).getByText('Enabled')).toBeTruthy()
  expect(within(card).queryByRole('button', { name: 'Install built-in skill' })).toBeNull()
})

test('unmount aborts a pending personal read before starting the catalog', async () => {
  let listSignal: AbortSignal | undefined
  const catalogCall = vi.fn(async () => catalog)
  const client = port({
    list: (signal?: AbortSignal) => { listSignal = signal; return new Promise(() => {}) },
    catalog: catalogCall,
  })
  const page = fixture(client)
  expect(listSignal?.aborted).toBe(false)
  expect(catalogCall).not.toHaveBeenCalled()
  page.unmount()
  expect(listSignal?.aborted).toBe(true)
  expect(catalogCall).not.toHaveBeenCalled()
})

test('unmount aborts the catalog once the personal list has settled', async () => {
  let catalogSignal: AbortSignal | undefined
  const catalogCall = vi.fn((signal?: AbortSignal): Promise<readonly BuiltinSkill[]> => {
    catalogSignal = signal; return new Promise(() => {})
  })
  const page = fixture(port({ catalog: catalogCall }))
  await waitFor(() => { expect(catalogCall).toHaveBeenCalledTimes(1) })
  expect(catalogSignal?.aborted).toBe(false)
  page.unmount()
  expect(catalogSignal?.aborted).toBe(true)
})

test('changing the injected client aborts reads from the prior account', async () => {
  let oldList: AbortSignal | undefined
  let resolveOld!: (items: readonly PersonalSkill[]) => void
  const oldCatalog = vi.fn(async () => catalog)
  const prior = port({
    list: (signal?: AbortSignal) => {
      oldList = signal; return new Promise<readonly PersonalSkill[]>((resolve) => { resolveOld = resolve })
    },
    catalog: oldCatalog,
  })
  const next = port()
  const page = fixture(prior)
  page.rerender(<SkillsPage {...({ client: next, t, trySkill: vi.fn() } as SkillsPageProps)} />)
  expect(oldList?.aborted).toBe(true)
  await act(async () => { resolveOld([item]) })
  expect(oldCatalog).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Proofreading' })).toBeNull()
  await screen.findByText('No skills are installed for this account')
})

test('changing accounts immediately hides the prior personal library', async () => {
  const prior = port({ list: async () => [item] })
  const next = port({ list: () => new Promise(() => {}), catalog: () => new Promise(() => {}) })
  const page = fixture(prior)
  await screen.findByRole('button', { name: 'Proofreading' })
  page.rerender(<SkillsPage {...({ client: next, t, trySkill: vi.fn() } as SkillsPageProps)} />)
  expect(screen.queryByRole('button', { name: 'Proofreading' })).toBeNull()
  expect(screen.getByText('Loading skills…')).toBeTruthy()
})

test('changing accounts aborts a catalog read already in progress', async () => {
  let priorCatalogSignal: AbortSignal | undefined
  const priorCatalog = vi.fn((signal?: AbortSignal): Promise<readonly BuiltinSkill[]> => {
    priorCatalogSignal = signal; return new Promise(() => {})
  })
  const page = fixture(port({ catalog: priorCatalog }))
  await waitFor(() => { expect(priorCatalog).toHaveBeenCalledTimes(1) })
  page.rerender(<SkillsPage {...({ client: port(), t, trySkill: vi.fn() } as SkillsPageProps)} />)
  expect(priorCatalogSignal?.aborted).toBe(true)
})

test.each([
  { error: new SkillHttpError(401), message: en.sessionExpired },
  { error: new SkillHttpError(404), message: en.skillMissing },
  { error: new SkillHttpError(503), message: en.toggleFailed },
  { error: new TypeError('connection lost'), message: en.toggleFailed },
])('retains the shown Skill state when a toggle reports $message', async ({ error, message }) => {
  const toggle = vi.fn<SkillPort['toggle']>(async () => { throw error })
  fixture(port({ list: async () => [item], toggle }))
  await screen.findByRole('button', { name: item.name })
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByText(message)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect(toggle).toHaveBeenCalledWith(item.skillId, false)
})

test.each([
  { error: new SkillHttpError(401), message: en.sessionExpired },
  { error: new SkillHttpError(403), message: en.revokeFailed },
  { error: new TypeError('connection lost'), message: en.revokeFailed },
])('does not replace a Skill with a revoked record after $message', async ({ error, message }) => {
  const revoke = vi.fn<SkillPort['revoke']>(async () => { throw error })
  fixture(port({ list: async () => [item], read: async () => ({ ...item, instructions: 'Original document' }), revoke }))
  fireEvent.click(await screen.findByRole('button', { name: item.name }))
  const dialog = within(screen.getByRole('dialog', { name: item.name }))
  await dialog.findByText('Original document')
  fireEvent.click(dialog.getByRole('button', { name: en.revokeSkill }))
  fireEvent.click(dialog.getByRole('button', { name: en.confirmRevoke }))
  await dialog.findByText(message)
  expect(dialog.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect(dialog.queryByText(en.revokedState)).toBeNull()
  expect(revoke).toHaveBeenCalledWith(item.skillId)
})

test.each([
  { status: 400, message: en.builtinInstallFailed }, { status: 401, message: en.sessionExpired },
  { status: 404, message: en.builtinInstallFailed }, { status: 409, message: en.builtinInstallConflict },
  { status: 413, message: en.skillLimit },
])('a definitive built-in $status refusal allows a new explicit gesture for the same pinned version', async ({ status, message }) => {
  const packaged: PersonalSkill = { ...item, name: builtinWord.name, kind: 'package', version: builtinWord.version,
    packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7) }
  const installBuiltin = vi.fn<SkillPort['installBuiltin']>().mockRejectedValueOnce(new SkillHttpError(status)).mockResolvedValueOnce(packaged)
  fixture(port({ catalog: async () => [builtinWord], installBuiltin, read: async () => ({ ...packaged, instructions: 'Pinned document' }) }))
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  fireEvent.click(await screen.findByRole('button', { name: builtinWord.name }))
  const dialog = within(screen.getByRole('dialog', { name: builtinWord.name }))
  fireEvent.click(dialog.getByRole('button', { name: en.builtinInstall }))
  await dialog.findByText(message)
  fireEvent.click(dialog.getByRole('button', { name: en.builtinInstall }))
  await screen.findByText('Pinned document')
  expect(installBuiltin).toHaveBeenCalledTimes(2)
  expect(installBuiltin.mock.calls[1]?.[0].requestId).not.toBe(installBuiltin.mock.calls[0]?.[0].requestId)
  expect(installBuiltin.mock.calls.map(([input]) => [input.catalogId, input.version])).toEqual([
    [builtinWord.id, builtinWord.version], [builtinWord.id, builtinWord.version],
  ])
})

test.each([
  { kind: 'toggle', outcome: 'success' }, { kind: 'toggle', outcome: 'failure' },
  { kind: 'revoke', outcome: 'success' }, { kind: 'revoke', outcome: 'failure' },
] as const)('a late old-account $kind $outcome cannot release the replacement account gesture', async ({ kind, outcome }) => {
  const old = deferredResult<PersonalSkill>(), fresh = deferredResult<PersonalSkill>()
  const original = port({ list: async () => [item], read: async () => ({ ...item, instructions: 'Original document' }),
    toggle: () => old.promise, revoke: () => old.promise })
  const page = fixture(original)
  fireEvent.click(await screen.findByRole('button', { name: item.name }))
  const dialog = within(screen.getByRole('dialog', { name: item.name }))
  await dialog.findByText('Original document')
  if (kind === 'toggle') fireEvent.click(dialog.getByRole('switch'))
  else {
    fireEvent.click(dialog.getByRole('button', { name: en.revokeSkill }))
    fireEvent.click(dialog.getByRole('button', { name: en.confirmRevoke }))
  }
  const bob = { ...item, skillId: 'f4a7b4e2-2d5b-47c1-a790-dc5d0bb70346', name: 'Bob skill' }
  const next = port({ list: async () => [bob], toggle: vi.fn(() => fresh.promise) })
  page.rerender(<SkillsPage client={next} t={t} trySkill={vi.fn()} usePanelInfo={selector => selector({ activePanelId: null })} />)
  await screen.findByRole('button', { name: bob.name })
  fireEvent.click(screen.getByRole('switch'))
  await act(async () => {
    if (outcome === 'success') old.resolve({ ...item, enabled: false, observedState: kind === 'revoke' ? 'revoked' : 'ready' })
    else old.reject(new SkillHttpError(401))
  })
  expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { fresh.resolve({ ...bob, enabled: false, revision: 2 }) })
  expect(screen.getByRole('switch')).toHaveProperty('disabled', false)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})

test.each(['success', 'failure'] as const)('refresh discards a superseded catalog %s from the same account', async (outcome) => {
  const old = deferredResult<readonly BuiltinSkill[]>()
  const catalogRead = vi.fn<SkillPort['catalog']>().mockImplementationOnce(() => old.promise).mockResolvedValueOnce([])
  fixture(port({ catalog: catalogRead }))
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  await waitFor(() => { expect(catalogRead).toHaveBeenCalledOnce() })
  fireEvent.click(screen.getByRole('button', { name: en.refreshList }))
  await screen.findByText(en.builtinCatalogEmpty)
  expect(catalogRead.mock.calls[0]?.[0]?.aborted).toBe(true)
  await act(async () => {
    if (outcome === 'success') old.resolve([builtinWord])
    else old.reject(new SkillHttpError(401))
  })
  expect(screen.queryByRole('button', { name: builtinWord.name })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(en.builtinCatalogEmpty)).toBeTruthy()
})

test.each([
  { operation: 'catalog', cause: new SkillHttpError(401), message: en.sessionExpired },
  { operation: 'catalog', cause: new TypeError('network unavailable'), message: en.builtinCatalogFailed },
  { operation: 'list', cause: new Error('invalid skill response'), message: en.loadFailed },
] as const)('refresh recovers a $operation error without showing an empty result', async ({ operation, cause, message }) => {
  const list = vi.fn<SkillPort['list']>().mockResolvedValue([item])
  const catalogRead = vi.fn<SkillPort['catalog']>().mockResolvedValue([builtinWord])
  if (operation === 'list') list.mockRejectedValueOnce(cause)
  else catalogRead.mockRejectedValueOnce(cause)
  fixture(port({ list, catalog: catalogRead }))
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toBe(message)
  expect(screen.queryByText(en.builtinCatalogEmpty)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.refreshList }))
  await screen.findByRole('button', { name: builtinWord.name })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(list).toHaveBeenCalledTimes(2)
})

test.each(['toggle', 'revoke', 'builtin'] as const)('unmount fences a pending %s response', async (operation) => {
  const result = deferredResult<PersonalSkill>()
  const toggle = vi.fn<SkillPort['toggle']>(() => result.promise)
  const revoke = vi.fn<SkillPort['revoke']>(() => result.promise)
  const installBuiltin = vi.fn<SkillPort['installBuiltin']>(() => result.promise)
  const page = fixture(port({ list: async () => [item], catalog: async () => [builtinWord],
    read: async () => ({ ...item, instructions: 'Account-owned document' }), toggle, revoke, installBuiltin }))
  await screen.findByRole('button', { name: item.name })
  if (operation === 'toggle') fireEvent.click(screen.getByRole('switch'))
  else if (operation === 'revoke') {
    fireEvent.click(screen.getByRole('button', { name: item.name }))
    const dialog = within(screen.getByRole('dialog', { name: item.name }))
    await dialog.findByText('Account-owned document')
    fireEvent.click(dialog.getByRole('button', { name: en.revokeSkill }))
    fireEvent.click(dialog.getByRole('button', { name: en.confirmRevoke }))
  } else {
    fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
    fireEvent.click(await screen.findByRole('button', { name: builtinWord.name }))
    fireEvent.click(within(screen.getByRole('dialog', { name: builtinWord.name })).getByRole('button', { name: en.builtinInstall }))
  }
  const mutation = operation === 'toggle' ? toggle : operation === 'revoke' ? revoke : installBuiltin
  expect(mutation).toHaveBeenCalledOnce()
  page.unmount()
  await act(async () => { result.resolve({ ...item, revision: 2 }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText(en.installed)).toBeNull()
  if (operation === 'builtin') expect(installBuiltin.mock.calls[0]?.[1]?.aborted).toBe(true)
})

test('installed category filters distinguish catalog skills from imports and can return to all categories', async () => {
  const pdf = { ...builtinWord, id: 'builtin.pdf', name: 'PDF', installedSkillId: item.skillId }
  const imported = { ...item, skillId: '00000000-0000-4000-8000-000000000207', name: 'Personal import' }
  fixture(port({ list: async () => [item, imported], catalog: async () => [pdf] }))
  await screen.findByRole('button', { name: item.name })
  fireEvent.click(screen.getByRole('button', { name: en.skillCategoryResearchKnowledge }))
  expect(screen.getByRole('button', { name: item.name })).toBeTruthy()
  expect(screen.queryByRole('button', { name: imported.name })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.skillCategoryImported }))
  expect(screen.getByRole('button', { name: imported.name })).toBeTruthy()
  expect(screen.queryByRole('button', { name: item.name })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.allCategories }))
  expect(screen.getByRole('button', { name: item.name })).toBeTruthy()
  expect(screen.getByRole('button', { name: imported.name })).toBeTruthy()
})

test('an uncertain built-in installation stays retryable in its detail dialog while another request is pending', async () => {
  const response = deferredResult<PersonalSkill>()
  const installBuiltin = vi.fn<SkillPort['installBuiltin']>()
    .mockRejectedValueOnce(new Error('reply lost')).mockImplementationOnce(() => response.promise)
  const packaged = { ...item, name: builtinWord.name, kind: 'package' as const, version: builtinWord.version,
    packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7) }
  fixture(port({ list: async () => [], catalog: async () => [builtinWord], installBuiltin,
    read: async () => ({ ...packaged, instructions: 'Installed document' }) }))
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  fireEvent.click(await screen.findByRole('button', { name: builtinWord.name }))
  const dialog = within(screen.getByRole('dialog', { name: builtinWord.name }))
  fireEvent.click(dialog.getByRole('button', { name: en.builtinInstall }))
  await dialog.findByText(en.builtinInstallUncertain)
  fireEvent.click(dialog.getByRole('button', { name: en.retryInstall }))
  expect(dialog.getByRole('button', { name: en.builtinInstalling })).toHaveProperty('disabled', true)
  expect(installBuiltin.mock.calls[1]?.[0]).toEqual(installBuiltin.mock.calls[0]?.[0])
  await act(async () => { response.resolve(packaged) })
  await screen.findByText('Installed document')
  expect(installBuiltin).toHaveBeenCalledTimes(2)
})

test.each(['install', 'import'] as const)('account switching withdraws a pending %s dialog and fences its successful reply', async (operation) => {
  const response = deferredResult<PersonalSkill>()
  const install = vi.fn<SkillPort['install']>(() => response.promise)
  const importPackage = vi.fn<SkillPort['importPackage']>(() => response.promise)
  const page = fixture(port({ list: async () => [item], install, importPackage }))
  await screen.findByRole('button', { name: item.name })
  fireEvent.click(screen.getByRole('button', { name: operation === 'install' ? en.installSkill : en.importSkillPackage }))
  const dialog = within(screen.getByRole('dialog'))
  if (operation === 'install') {
    fireEvent.change(dialog.getByLabelText(en.name), { target: { value: 'Late installation' } })
    fireEvent.change(dialog.getByLabelText(en.description), { target: { value: 'First account' } })
    fireEvent.change(dialog.getByLabelText(en.instructions), { target: { value: 'Read carefully.' } })
    fireEvent.click(dialog.getByRole('button', { name: en.installSkill }))
  } else {
    fireEvent.change(dialog.getByLabelText(en.skillImportFile), { target: { files: [new File(['zip'], 'a.zip')] } })
    fireEvent.click(dialog.getByRole('button', { name: en.skillImportAction }))
  }
  const bob = { ...item, skillId: '00000000-0000-4000-8000-000000000208', name: 'Bob skill' }
  const list = vi.fn<SkillPort['list']>(async () => [bob])
  const next = port({ list, catalog: async () => [] })
  page.rerender(<SkillsPage client={next} t={t} trySkill={vi.fn()} usePanelInfo={selector => selector({ activePanelId: null })} />)
  await screen.findByRole('button', { name: bob.name })
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { response.resolve({ ...item, name: 'Late installation' }) })
  expect(screen.getByRole('button', { name: bob.name })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Late installation' })).toBeNull()
  expect(screen.queryByText(en.installed)).toBeNull()
  expect(list).toHaveBeenCalledOnce()
  if (operation === 'import') expect(importPackage.mock.calls[0]?.[2]?.aborted).toBe(true)
})

test.each(['install', 'import', 'builtin'] as const)('a plain HTTP browser can submit a %s request without crypto.randomUUID', async (operation) => {
  const availableCrypto = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: availableCrypto.getRandomValues.bind(availableCrypto) })
  try {
    const installed = operation === 'install' ? item : { ...item, kind: 'package' as const, version: '1.0.0',
      packageDigest: 'b'.repeat(64), manifestDigest: 'c'.repeat(64) }
    let imported = false
    const install = vi.fn<SkillPort['install']>(async () => installed)
    const importPackage = vi.fn<SkillPort['importPackage']>(async () => { imported = true; return installed })
    const installBuiltin = vi.fn<SkillPort['installBuiltin']>(async () => installed)
    fixture(port({ list: async () => imported ? [installed] : [], catalog: async () => [builtinWord],
      read: async () => ({ ...installed, instructions: 'Installed document' }), install, importPackage, installBuiltin }))
    await screen.findByText(en.mySkillsEmpty)
    if (operation === 'builtin') {
      fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
      fireEvent.click(await screen.findByRole('button', { name: builtinWord.name }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.builtinInstall }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: operation === 'install' ? en.installSkill : en.importSkillPackage }))
      const dialog = within(screen.getByRole('dialog'))
      if (operation === 'install') {
        fireEvent.change(dialog.getByLabelText(en.name), { target: { value: item.name } })
        fireEvent.change(dialog.getByLabelText(en.description), { target: { value: item.description } })
        fireEvent.change(dialog.getByLabelText(en.instructions), { target: { value: 'Read carefully.' } })
        fireEvent.click(dialog.getByRole('button', { name: en.installSkill }))
      } else {
        fireEvent.change(dialog.getByLabelText(en.skillImportFile), { target: { files: [new File(['zip'], 'a.zip')] } })
        fireEvent.click(dialog.getByRole('button', { name: en.skillImportAction }))
      }
    }
    await screen.findByRole('button', { name: installed.name })
    const requestId = operation === 'import' ? importPackage.mock.calls[0]?.[1]
      : operation === 'builtin' ? installBuiltin.mock.calls[0]?.[0].requestId : install.mock.calls[0]?.[0].requestId
    expect(requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
    expect(screen.queryByRole('alert')).toBeNull()
  } finally { vi.unstubAllGlobals() }
})

test('the HTTP client and Skills page install the PDF-only catalog while retaining an earlier Word package', async () => {
  const pdf = catalog.find(entry => entry.id === 'builtin.pdf')
  if (!pdf) throw new Error('Missing PDF deployment fixture')
  const word: PersonalSkill = { ...item, name: builtinWord.name, kind: 'package', version: builtinWord.version,
    packageDigest: builtinWord.archiveDigest, manifestDigest: builtinWord.manifestDigest.slice(7) }
  const installedPdf: PersonalSkill = { ...item, skillId: '00000000-0000-4000-8000-000000000209',
    name: pdf.name, description: pdf.summary, kind: 'package', version: pdf.version,
    packageDigest: pdf.archiveDigest, manifestDigest: pdf.manifestDigest.slice(7) }
  const calls: Request[] = []
  const client = new SkillHttpClient(async (input, init) => {
    const request = new Request(new URL(requestUrl(input), 'http://localhost'), init)
    calls.push(request)
    const route = new URL(request.url).pathname
    if (route.endsWith('skillsList')) return Response.json({ items: [word] })
    if (route.endsWith('skillsCatalog')) return Response.json({ items: [pdf] })
    if (route.endsWith('skillsInstallBuiltin')) return Response.json(installedPdf)
    if (route.endsWith('skillsRead')) {
      const body: unknown = await request.clone().json()
      if (typeof body !== 'object' || body === null || !('request' in body)
        || typeof body.request !== 'object' || body.request === null || !('skillId' in body.request)) {
        throw new Error('Invalid detail request')
      }
      return Response.json(body.request.skillId === word.skillId
        ? { ...word, instructions: 'Retained historical Word document' }
        : { ...installedPdf, instructions: 'Current PDF document' })
    }
    throw new Error(`Unexpected Skill route: ${route}`)
  })
  fixture(client)
  await screen.findByRole('button', { name: word.name })
  fireEvent.click(screen.getByRole('tab', { name: en.allSkills }))
  fireEvent.click(await screen.findByRole('button', { name: pdf.name }))
  expect(screen.queryByRole('button', { name: word.name })).toBeNull()
  fireEvent.click(within(screen.getByRole('dialog', { name: pdf.name })).getByRole('button', { name: en.builtinInstall }))
  await screen.findByText('Current PDF document')
  fireEvent.click(within(screen.getByRole('dialog', { name: pdf.name })).getByRole('button', { name: en.close }))
  expect(screen.getByRole('button', { name: word.name })).toBeTruthy()
  expect(screen.getByRole('button', { name: installedPdf.name })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: word.name }))
  await within(screen.getByRole('dialog', { name: word.name })).findByText('Retained historical Word document')
  expect(screen.queryByRole('alert')).toBeNull()
  const installation = calls.find(call => call.url.endsWith('skillsInstallBuiltin'))
  if (!installation) throw new Error('Missing PDF installation request')
  expect(await installation.json()).toMatchObject({ request: { catalogId: pdf.id, version: pdf.version } })
  expect(calls.filter(call => call.url.endsWith('skillsInstallBuiltin'))).toHaveLength(1)
  expect(calls.every(call => call.method === 'POST' && call.credentials === 'same-origin')).toBe(true)
})
