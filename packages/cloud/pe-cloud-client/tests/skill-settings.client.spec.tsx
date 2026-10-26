// @vitest-environment jsdom
/** Original native controls drive complete files and an explicitly opened, once-only sample edit. */
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate, allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SkillSettings, type SkillSettingsProps } from '../src/client/SkillSettings.tsx'
import { skillSettingsDictionaries } from '../src/client/skill-settings-locales.ts'
import type { PreparedSkillEdit, SkillPublicationOutcome } from '../src/client/skill-edit.ts'

afterEach(cleanup)
const en = skillSettingsDictionaries.en
const source = { id: 'published', skillSha256: 'a'.repeat(64), resourceSha256: 'b'.repeat(64), skillBytes: 12, resourceBytes: 3 }
function file(name: string, bytes: readonly number[]): File {
  const value = Uint8Array.from(bytes)
  return Object.assign(new File([value], name), { arrayBuffer: async () => value.slice().buffer })
}
function fixture(outcome: SkillPublicationOutcome = { kind: 'persisted', applied: true, resources: 'unavailable', source }) {
  const publish = vi.fn<PreparedSkillEdit['publish']>(async () => outcome)
  const prepare = vi.fn<SkillSettingsProps['prepare']>(async (): Promise<PreparedSkillEdit> => ({ source: null, installed: false, applied: false, resources: 'unavailable', publish }))
  const unused = (): never => { throw new Error('No global session hook belongs to this local file editor') }
  const props: SkillSettingsProps = { ...allowAllAccess, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
    usePanelInfo: unused, useWorkspaces: unused, useResource: unused, scope: 'G:original', maxFileBytes: 4096, prepare, close: () => {}, t: makeTranslate(en) }
  return { props, prepare, publish }
}
async function openAndChoose() {
  fireEvent.click(screen.getByRole('button', { name: en.open }))
  await screen.findByLabelText(en.markdown)
  const text = '\uFEFF---\nname: sample\n---\n完整内容\n'
  fireEvent.change(screen.getByLabelText(en.markdown), { target: { files: [file('SKILL.md', [...new TextEncoder().encode(text)])] } })
  fireEvent.change(screen.getByLabelText(en.resource), { target: { files: [file('resource.bin', [0, 255, 1])] } })
  return text
}
it('does not read on mount, preserves complete UTF-8/binary files, and requires a deliberate new edit after one publish', async () => {
  const f = fixture({ kind: 'persisted', applied: false, resources: 'unavailable', source }); render(<SkillSettings {...f.props}/>)
  expect(f.prepare).not.toHaveBeenCalled()
  const text = await openAndChoose()
  fireEvent.click(screen.getByRole('button', { name: en.publish }))
  await screen.findByText(en.persisted); expect(screen.getByText(en.notApplied)).toBeTruthy()
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(text, 'AP8B', expect.any(AbortSignal))
  expect(screen.queryByRole('button', { name: en.publish })).toBeNull()
  expect(screen.getByText(en.resources)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.reopen }))
  await screen.findByLabelText(en.markdown)
  expect(f.prepare).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button', { name: en.publish })).toHaveProperty('disabled', true)
})
it.each(['unknown', 'conflict'] as const)('shows %s without a retry or replacement current read', async (kind) => {
  const f = fixture({ kind }); render(<SkillSettings {...f.props}/>); await openAndChoose()
  fireEvent.click(screen.getByRole('button', { name: en.publish }))
  await screen.findByRole('alert'); expect(screen.getByText(en[kind])).toBeTruthy()
  expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.publish).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: en.publish })).toBeNull()
})
it('keeps invalid filenames/oversized files out of the publication callback', async () => {
  const f = fixture(); render(<SkillSettings {...f.props}/>); await openAndChoose()
  fireEvent.change(screen.getByLabelText(en.markdown), { target: { files: [file('other.md', [65])] } })
  expect(screen.getByRole('button', { name: en.publish })).toHaveProperty('disabled', true)
  expect(screen.getByRole('alert').textContent).toBe(en.invalid)
  fireEvent.change(screen.getByLabelText(en.resource), { target: { files: [file('resource.bin', Array.from({ length: 4097 }, () => 0))] } })
  expect(f.publish).not.toHaveBeenCalled()
})
it('cancels an issued edit when it is closed and never adopts a late prepare after unmount', async () => {
  const f = fixture(); const view = render(<SkillSettings {...f.props}/>); await openAndChoose()
  const first = f.prepare.mock.calls[0]?.[0]
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(first?.aborted).toBe(true)
  const late = Promise.withResolvers<PreparedSkillEdit>(); f.prepare.mockReturnValue(late.promise)
  fireEvent.click(screen.getByRole('button', { name: en.open }))
  const signal = f.prepare.mock.calls[1]?.[0]; view.unmount()
  expect(signal?.aborted).toBe(true)
  late.resolve({ source: null, installed: false, applied: false, resources: 'unavailable', publish: f.publish })
  await Promise.resolve(); expect(f.publish).not.toHaveBeenCalled()
})
it('scope replacement unmounts the old pending publication and starts with no draft or read', async () => {
  const f = fixture(), gate = Promise.withResolvers<SkillPublicationOutcome>(); f.publish.mockReturnValue(gate.promise)
  const view = render(<SkillSettings {...f.props}/>); await openAndChoose()
  fireEvent.click(screen.getByRole('button', { name: en.publish }))
  await waitFor(() => { expect(f.publish).toHaveBeenCalledTimes(1) })
  const signal = f.publish.mock.calls[0]?.[2]
  view.rerender(<SkillSettings {...f.props} scope="G:new-dependency"/>)
  expect(signal?.aborted).toBe(true)
  expect(screen.getByRole('button', { name: en.open })).toBeTruthy()
  gate.resolve({ kind: 'persisted', applied: true, resources: 'unavailable', source }); await Promise.resolve()
  expect(screen.queryByText(en.persisted)).toBeNull(); expect(f.prepare).toHaveBeenCalledTimes(1)
})

it('shows project-on-load as future authorized preparation rather than a completed load', async () => {
  const f = fixture({ kind: 'persisted', applied: true, resources: 'project-on-load', source })
  f.prepare.mockResolvedValue({ source: null, installed: true, applied: true, resources: 'project-on-load', publish: f.publish })
  render(<SkillSettings {...f.props}/>); await openAndChoose()
  expect(screen.getByText(en.resourcesOnLoad)).toBeTruthy()
  expect(screen.queryByText(en.resourcesUnavailable)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.publish }))
  await screen.findByText(en.persisted)
  expect(screen.getByText(en.resourcesOnLoad)).toBeTruthy()
  expect(screen.queryByText(en.resourcesUnavailable)).toBeNull()
})
