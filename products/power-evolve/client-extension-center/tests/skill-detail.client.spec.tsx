// @vitest-environment jsdom
/** Native detail dialogs retain selection and late-read ownership with only the Skill port substituted. */
import { deferredResult } from './deferred-result.ts'
import type {} from '../src/client/index.ts'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SkillDetailDialog } from '../src/client/SkillDetailDialog.tsx'
import { SkillHttpError, type PersonalSkill, type PersonalSkillDetail, type SkillPort } from '../src/client/skills-api.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const t = (key: keyof typeof en) => en[key]
const skill: PersonalSkill = { skillId: '5a010346-693c-4204-a386-29f66b11a057', name: 'First skill', description: 'First instructions',
  enabled: true, revision: 1, kind: 'package', version: '1.0.0', digest: 'a'.repeat(64), packageDigest: 'b'.repeat(64),
  manifestDigest: 'c'.repeat(64), observedState: 'ready' }
const unexpected = async (): Promise<never> => { throw new Error('Unexpected Skill operation') }
function client(read: SkillPort['read']): SkillPort {
  return { read, list: unexpected, catalog: unexpected, install: unexpected, installBuiltin: unexpected,
    importPackage: unexpected, toggle: unexpected, revoke: unexpected }
}
function props(overrides: Partial<Parameters<typeof SkillDetailDialog>[0]> = {}): Parameters<typeof SkillDetailDialog>[0] {
  return { skill, client: client(async () => ({ ...skill, instructions: 'First document' })), busy: false,
    mutationError: undefined, t, onClose: vi.fn(), onToggle: vi.fn(), onRevoke: vi.fn(), onTry: vi.fn(async () => undefined), ...overrides }
}

it.each([
  { cause: new SkillHttpError(401), message: en.sessionExpired },
  { cause: new SkillHttpError(404), message: en.skillMissing },
  { cause: new SkillHttpError(503), message: en.detailFailed },
  { cause: new TypeError('connection unavailable'), message: en.detailFailed },
])('shows $message and reloads the same selected document after a read refusal', async ({ cause, message }) => {
  const read = vi.fn<SkillPort['read']>().mockRejectedValueOnce(cause).mockResolvedValueOnce({ ...skill, instructions: 'Recovered document' })
  render(<SkillDetailDialog {...props({ client: client(read) })} />)
  await screen.findByText(message)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByText('Recovered document')
  expect(read.mock.calls.map(([id]) => id)).toEqual([skill.skillId, skill.skillId])
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['success', 'failure'] as const)('discards a late %s for an earlier document selection', async (outcome) => {
  const first = deferredResult<PersonalSkillDetail>()
  let signal: AbortSignal | undefined
  const next = { ...skill, skillId: 'f4a7b4e2-2d5b-47c1-a790-dc5d0bb70346', name: 'Second skill' }
  const read = vi.fn<SkillPort['read']>(async (id, current) => {
    if (id === skill.skillId) { signal = current; return first.promise }
    return { ...next, instructions: 'Second document' }
  })
  const input = props({ client: client(read) })
  const root = render(<SkillDetailDialog {...input} />)
  root.rerender(<SkillDetailDialog {...input} skill={next} />)
  await screen.findByText('Second document')
  expect(signal?.aborted).toBe(true)
  await act(async () => { if (outcome === 'success') first.resolve({ ...skill, instructions: 'Obsolete document' }); else first.reject(new SkillHttpError(401)) })
  expect(screen.queryByText('Obsolete document')).toBeNull()
  expect(screen.queryByText(en.sessionExpired)).toBeNull()
  expect(screen.getByRole('dialog', { name: next.name })).toBeTruthy()
})

it('requires a fresh revoke confirmation after cancellation and exposes a failed trial for explicit retry', async () => {
  const onTry = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('native draft refused')).mockResolvedValueOnce(undefined)
  const input = props({ onTry })
  render(<SkillDetailDialog {...input} />)
  await screen.findByText('First document')
  fireEvent.click(screen.getByRole('button', { name: en.revokeSkill }))
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(input.onRevoke).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.revokeSkill }))
  fireEvent.click(screen.getByRole('button', { name: en.confirmRevoke }))
  expect(input.onRevoke).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.tryNow }))
  await screen.findByText(en.skillTryFailed)
  fireEvent.click(screen.getByRole('button', { name: en.tryNow }))
  await waitFor(() => { expect(onTry).toHaveBeenCalledTimes(2) })
  await waitFor(() => { expect(screen.queryByText(en.skillTryFailed)).toBeNull() })
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(input.onClose).toHaveBeenCalledOnce()
})

it('keeps revoked packages readable while disabling trial, toggle and revoke actions', async () => {
  const input = props({ skill: { ...skill, enabled: false, observedState: 'revoked' }, mutationError: 'Original mutation refused' })
  render(<SkillDetailDialog {...input} />)
  await screen.findByText('First document')
  expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en.tryNow })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('button', { name: en.revokeSkill })).toBeNull()
  expect(screen.getByText('Original mutation refused')).toBeTruthy()
  expect(input.onTry).not.toHaveBeenCalled()
})
