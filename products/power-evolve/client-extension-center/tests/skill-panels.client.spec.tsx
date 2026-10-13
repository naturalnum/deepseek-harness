import type {} from '../src/client/index.ts'
// @vitest-environment jsdom
/** Native dialogs and real form gestures; only HTTP ports are substituted. */
import { deferredResult } from './deferred-result.ts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SkillImportPanel } from '../src/client/SkillImportPanel.tsx'
import { SkillInstallPanel } from '../src/client/SkillInstallPanel.tsx'
import { SkillHttpError, type PersonalSkill, type SkillPort } from '../src/client/skills-api.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const t = (key: keyof typeof en) => en[key]
const skill: PersonalSkill = { skillId: '5a010346-693c-4204-a386-29f66b11a057', name: 'Proofreading', description: 'Read',
  enabled: true, revision: 1, kind: 'text', version: null, digest: 'a'.repeat(64), packageDigest: null, manifestDigest: null, observedState: 'ready' }
const unexpected = async (): Promise<never> => { throw new Error('Unexpected skill operation') }
function client(overrides: Partial<SkillPort> = {}): SkillPort {
  return { list: unexpected, catalog: unexpected, read: unexpected, install: unexpected, installBuiltin: unexpected,
    importPackage: unexpected, toggle: unexpected, revoke: unexpected, ...overrides }
}
function fillInstall(): void {
  fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'Proofreading' } })
  fireEvent.change(screen.getByLabelText(en.description), { target: { value: 'Read' } })
  fireEvent.change(screen.getByLabelText(en.instructions), { target: { value: 'Read carefully.' } })
}

it.each(['import', 'install'] as const)('does not publish a late %s result after its dialog unmounts', async (mode) => {
  const result = deferredResult<PersonalSkill>()
  const complete = vi.fn()
  const port = client({ install: () => result.promise, importPackage: () => result.promise })
  const root = mode === 'import'
    ? render(<SkillImportPanel open client={port} t={t} onClose={vi.fn()} onImported={complete} />)
    : render(<SkillInstallPanel open client={port} t={t} onClose={vi.fn()} onInstalled={complete} />)
  if (mode === 'import') {
    fireEvent.change(screen.getByLabelText(en.skillImportFile), { target: { files: [new File(['zip'], 'a.zip')] } })
    fireEvent.click(screen.getByRole('button', { name: en.skillImportAction }))
  } else { fillInstall(); fireEvent.click(screen.getByRole('button', { name: en.installSkill })) }
  root.unmount()
  await act(async () => { result.resolve(skill) })
  expect(complete).not.toHaveBeenCalled()
})

it('does not publish a late package result after explicit cancellation', async () => {
  const result = deferredResult<PersonalSkill>()
  let signal: AbortSignal | undefined
  const complete = vi.fn()
  const port = client({ importPackage: async (_file, _id, current) => { signal = current; return result.promise } })
  render(<SkillImportPanel open client={port}
    t={t} onClose={vi.fn()} onImported={complete} />)
  fireEvent.change(screen.getByLabelText(en.skillImportFile), { target: { files: [new File(['zip'], 'a.zip')] } })
  fireEvent.click(screen.getByRole('button', { name: en.skillImportAction }))
  fireEvent.click(screen.getByRole('button', { name: en.skillImportCancel }))
  expect(signal?.aborted).toBe(true)
  expect(screen.getByText(en.skillImportUncertain)).toBeTruthy()
  await act(async () => { result.resolve(skill) })
  expect(complete).not.toHaveBeenCalled()
})

it.each(['import', 'install'] as const)('fences obsolete %s failures after an account port changes', async (mode) => {
  const result = deferredResult<PersonalSkill>()
  const complete = vi.fn(), old = client({ install: () => result.promise, importPackage: () => result.promise }), next = client()
  const page = (port: SkillPort) => mode === 'import'
    ? <SkillImportPanel open client={port} t={t} onClose={vi.fn()} onImported={complete} />
    : <SkillInstallPanel open client={port} t={t} onClose={vi.fn()} onInstalled={complete} />
  const root = render(page(old))
  if (mode === 'import') {
    fireEvent.change(screen.getByLabelText(en.skillImportFile), { target: { files: [new File(['zip'], 'a.zip')] } })
    fireEvent.click(screen.getByRole('button', { name: en.skillImportAction }))
  } else { fillInstall(); fireEvent.click(screen.getByRole('button', { name: en.installSkill })) }
  root.rerender(page(next))
  await act(async () => { result.reject(new SkillHttpError(401)) })
  expect(screen.queryByRole('alert')).toBeNull(); expect(complete).not.toHaveBeenCalled()
  if (mode === 'install') expect(screen.getByLabelText(en.name)).toHaveProperty('value', '')
  else expect(screen.getByLabelText(en.skillImportFile)).toHaveProperty('disabled', false)
})

it.each([409, 413, 401, 503])('presents a text install %i refusal and preserves only uncertain request IDs', async (status) => {
  const install = vi.fn<SkillPort['install']>(async () => { throw new SkillHttpError(status) })
  const close = vi.fn()
  render(<SkillInstallPanel open client={client({ install })} t={t} onClose={close} onInstalled={vi.fn()} />)
  fireEvent.submit(screen.getByLabelText(en.name).closest('form')!)
  expect(install).not.toHaveBeenCalled()
  fillInstall(); fireEvent.click(screen.getByRole('button', { name: en.installSkill }))
  await screen.findByText(status === 409 ? en.nameConflict : status === 413 ? en.skillLimit
    : status === 401 ? en.sessionExpired : en.installUncertain)
  expect(screen.getByLabelText(en.name)).toHaveProperty('disabled', status === 401 || status === 503)
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(close).toHaveBeenCalledOnce()
})

it.each([
  [401, 'invalid_upload_ticket', 'skillImportUncertain'], [401, undefined, 'sessionExpired'],
  [413, 'skill_limit', 'skillLimit'], [413, undefined, 'skillImportTooLarge'], [409, undefined, 'skillImportConflict'],
  [400, undefined, 'skillImportInvalidPackage'], [415, undefined, 'skillImportInvalidPackage'], [422, undefined, 'skillImportInvalidPackage'],
  [503, undefined, 'skillImportUncertain'],
] as const)('presents package import %i/%s refusal without replaying bytes', async (status, code, label) => {
  const upload = vi.fn<SkillPort['importPackage']>(async () => { throw new SkillHttpError(status, code) })
  const close = vi.fn()
  render(<SkillImportPanel open client={client({ importPackage: upload })} t={t} onClose={close} onImported={vi.fn()} />)
  fireEvent.change(screen.getByLabelText(en.skillImportFile), { target: { files: [new File(['zip'], 'a.zip')] } })
  fireEvent.click(screen.getByRole('button', { name: en.skillImportAction }))
  await screen.findByText(en[label]); expect(upload).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.skillImportChooseAnother }))
  expect(screen.getByLabelText(en.skillImportFile)).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: en.cancel })); expect(close).toHaveBeenCalledOnce()
})

it.each([
  { name: 'empty.zip', content: '', label: 'skillImportEmpty' }, { name: 'bad\u0000.zip', content: 'zip', label: 'skillImportInvalidName' },
  { name: 'data.txt', content: 'data', label: 'skillImportInvalidType' }, { name: 'large.zip', content: 'large', label: 'skillImportTooLarge' },
] as const)('validates a chosen $name archive before importing', ({ name, content, label }) => {
  const upload = vi.fn<SkillPort['importPackage']>()
  render(<SkillImportPanel open client={client({ importPackage: upload })} t={t} onClose={vi.fn()} onImported={vi.fn()} />)
  const file = new File([content === 'large' ? 'x'.repeat(1024 * 1024 + 1) : content], name)
  fireEvent.change(screen.getByLabelText(en.skillImportFile), { target: { files: [file] } })
  expect(screen.getByText(en[label])).toBeTruthy()
  expect(screen.getByRole('button', { name: en.skillImportAction })).toHaveProperty('disabled', true)
  expect(upload).not.toHaveBeenCalled()
})

it.each(['import', 'install'] as const)('keeps a busy %s dialog open for native close gestures and admits one submission', async (mode) => {
  const result = deferredResult<PersonalSkill>()
  const close = vi.fn(), complete = vi.fn()
  const install = vi.fn<SkillPort['install']>(() => result.promise)
  const importPackage = vi.fn<SkillPort['importPackage']>(() => result.promise)
  const port = client({ install, importPackage })
  if (mode === 'import') {
    render(<SkillImportPanel open client={port} t={t} onClose={close} onImported={complete} />)
    fireEvent.change(screen.getByLabelText(en.skillImportFile), { target: { files: [new File(['zip'], 'a.zip')] } })
    const button = screen.getByRole('button', { name: en.skillImportAction })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(importPackage).toHaveBeenCalledOnce()
  } else {
    render(<SkillInstallPanel open client={port} t={t} onClose={close} onInstalled={complete} />)
    fillInstall()
    const form = screen.getByLabelText(en.name).closest('form')!
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    expect(install).toHaveBeenCalledOnce()
  }
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeTruthy()
  await act(async () => { result.resolve(skill) })
  expect(complete).toHaveBeenCalledWith(skill)
})

it('retains one text installation when the form submits again while its response is pending', async () => {
  const result = deferredResult<PersonalSkill>()
  const install = vi.fn<SkillPort['install']>(() => result.promise), complete = vi.fn()
  render(<SkillInstallPanel open client={client({ install })} t={t} onClose={vi.fn()} onInstalled={complete} />)
  fillInstall()
  const form = screen.getByRole('textbox', { name: en.name }).closest('form')
  if (!form) throw new Error('Missing text installation form')
  fireEvent.submit(form)
  expect(screen.getByRole('button', { name: en.installing })).toHaveProperty('disabled', true)
  fireEvent.submit(form)
  expect(install).toHaveBeenCalledOnce()
  await act(async () => { result.resolve(skill) })
  expect(complete).toHaveBeenCalledOnce()
  expect(complete).toHaveBeenCalledWith(skill)
})

it('keeps cancellation uncertainty visible when the cancelled upload later fails', async () => {
  const result = deferredResult<PersonalSkill>()
  const complete = vi.fn(), upload = vi.fn<SkillPort['importPackage']>(() => result.promise)
  render(<SkillImportPanel open client={client({ importPackage: upload })} t={t} onClose={vi.fn()} onImported={complete} />)
  fireEvent.change(screen.getByLabelText(en.skillImportFile), { target: { files: [new File(['zip'], 'a.zip')] } })
  fireEvent.click(screen.getByRole('button', { name: en.skillImportAction }))
  fireEvent.click(screen.getByRole('button', { name: en.skillImportCancel }))
  await act(async () => { result.reject(new SkillHttpError(401)) })
  expect(screen.getByRole('alert').textContent).toBe(en.skillImportUncertain)
  expect(screen.getByRole('button', { name: en.retryInstall })).toHaveProperty('disabled', false)
  expect(complete).not.toHaveBeenCalled()
})

it('completes an account-owned upload if its parent hides the dialog during the request', async () => {
  const result = deferredResult<PersonalSkill>(), complete = vi.fn()
  const port = client({ importPackage: () => result.promise })
  const root = render(<SkillImportPanel open client={port} t={t} onClose={vi.fn()} onImported={complete} />)
  fireEvent.change(screen.getByLabelText(en.skillImportFile), { target: { files: [new File(['zip'], 'a.zip')] } })
  fireEvent.click(screen.getByRole('button', { name: en.skillImportAction }))
  root.rerender(<SkillImportPanel open={false} client={port} t={t} onClose={vi.fn()} onImported={complete} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { result.resolve(skill) })
  expect(complete).toHaveBeenCalledOnce()
  expect(complete).toHaveBeenCalledWith(skill)
})
