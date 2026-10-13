// @vitest-environment jsdom
import { deferredResult } from './deferred-result.ts'
import type {} from '../src/client/index.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PersonalSshPage } from '../src/client/PersonalSshPage.tsx'
import type { PersonalSshConnection, PersonalSshList, PersonalSshPort, SshCheckCall } from '../src/client/ssh-api.ts'
import { en, zh } from '../src/client/locales.ts'
import { SshHttpError, type SshUpdateInput, type SshCreateInput, type SshCheckInput } from '../src/client/ssh-api.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const item: PersonalSshConnection = { connectionId: 'f76e4521-45b0-4829-91dd-9a205c7ef68c',
  displayName: 'My server', host: 'server.example.com', port: 22, username: 'alice',
  hostKeySha256: 'SHA256:1234567890123456789012345678901234567890123',
  enabled: true, revision: 1, credentialRevision: 1, workingDirectory: null, authentication: 'password',
  secretConfigured: true, passphraseConfigured: false, deletedAt: null,
  createdAt: '2026-09-29T11:00:00.000Z', updatedAt: '2026-09-29T11:00:00.000Z' }
const data: PersonalSshList = { available: true, items: [item] }
const t = (key: keyof typeof en) => en[key]

type LifecycleSshPort = {
  [Key in keyof PersonalSshPort]: (...args: Parameters<PersonalSshPort[Key]>) => ReturnType<PersonalSshPort[Key]>
}
function lifecyclePort(overrides: Partial<PersonalSshPort> = {}): LifecycleSshPort {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected SSH operation') }
  return { list: unexpected, create: unexpected, update: unexpected, toggle: unexpected, remove: unexpected,
    check: unexpected, callList: async () => [], callStatus: unexpected, callCancel: unexpected, ...overrides }
}

test('two native SSH check clicks in one batch admit one request', async () => {
  const reply = deferredResult<SshCheckCall>()
  const check = vi.fn<PersonalSshPort['check']>(() => reply.promise)
  render(<PersonalSshPage data={data} port={lifecyclePort({ check })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  const button = screen.getByRole<HTMLButtonElement>('button', { name: en.sshTestAuthentication })
  act(() => { button.click(); button.click() })
  expect(check).toHaveBeenCalledOnce()
  await act(async () => { reply.resolve({ callId: 'c7316d18-53ca-4c98-87f6-75d155b8d153', state: 'succeeded' }) })
  expect(screen.getByRole('status').textContent).toContain(en.sshCheckSucceeded)
})

test('two native SSH cancellation clicks in one batch send one cancellation', async () => {
  const running: SshCheckCall = { callId: 'c7316d18-53ca-4c98-87f6-75d155b8d153', state: 'running' }
  const reply = deferredResult<SshCheckCall>()
  const callCancel = vi.fn<PersonalSshPort['callCancel']>(() => reply.promise)
  render(<PersonalSshPage data={data} port={lifecyclePort({ check: async () => running, callCancel })}
    onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshTestAuthentication }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain(en.sshCheckRunning) })
  const button = within(screen.getByRole('status')).getByRole<HTMLButtonElement>('button', { name: en.sshCancelCheck })
  act(() => { button.click(); button.click() })
  expect(callCancel).toHaveBeenCalledOnce()
  await act(async () => { reply.resolve({ ...running, state: 'cancelled' }) })
  expect(screen.getByRole('status').textContent).toContain(en.sshCheckCancelled)
})

test.each(['success', 'failure'] as const)('an old-account SSH mutation %s cannot change or unlock the new Port', async (outcome) => {
  const oldReply = deferredResult<PersonalSshConnection>(), newReply = deferredResult<PersonalSshConnection>()
  const oldToggle = vi.fn<PersonalSshPort['toggle']>(() => oldReply.promise)
  const onChange = vi.fn()
  const page = render(<PersonalSshPage data={data} port={lifecyclePort({ toggle: oldToggle })}
    onChange={onChange} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('switch'))
  const bob: PersonalSshConnection = { ...item, connectionId: 'da95a0a2-a53d-490b-a7eb-f0608ad6f2b0', displayName: 'Bob server' }
  const newToggle = vi.fn<PersonalSshPort['toggle']>(() => newReply.promise)
  page.rerender(<PersonalSshPage data={{ available: true, items: [bob] }} port={lifecyclePort({ toggle: newToggle })}
    onChange={onChange} onReload={vi.fn()} t={t} />)
  expect(screen.getByRole('switch')).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('switch'))
  expect(newToggle).toHaveBeenCalledOnce()
  await act(async () => {
    if (outcome === 'success') oldReply.resolve({ ...item, enabled: false, revision: 2 })
    else oldReply.reject(new SshHttpError(401))
  })
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
  const updated = { ...bob, enabled: false, revision: 2 }
  await act(async () => { newReply.resolve(updated) })
  expect(onChange).toHaveBeenCalledWith([updated])
})

test.each([
  { operation: 'status', outcome: 'success' }, { operation: 'status', outcome: 'failure' },
  { operation: 'cancel', outcome: 'success' }, { operation: 'cancel', outcome: 'failure' },
] as const)('an old SSH $operation $outcome cannot populate new-account history or release its pending check', async ({ operation, outcome }) => {
  const oldCall: SshCheckCall = { callId: 'c7316d18-53ca-4c98-87f6-75d155b8d153', state: 'running' }
  const oldReply = deferredResult<SshCheckCall>(), newReply = deferredResult<SshCheckCall>()
  const oldStatus = vi.fn<PersonalSshPort['callStatus']>(() => oldReply.promise)
  const oldCancel = vi.fn<PersonalSshPort['callCancel']>(() => oldReply.promise)
  const page = render(<PersonalSshPage data={data} port={lifecyclePort({ check: async () => oldCall,
    callStatus: oldStatus, callCancel: oldCancel })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshTestAuthentication }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain(en.sshCheckRunning) })
  fireEvent.click(within(screen.getByRole('status')).getByRole('button', {
    name: operation === 'status' ? en.refreshList : en.sshCancelCheck,
  }))
  const bob: PersonalSshConnection = { ...item, connectionId: 'da95a0a2-a53d-490b-a7eb-f0608ad6f2b0', displayName: 'Bob server' }
  const newCheck = vi.fn<PersonalSshPort['check']>(() => newReply.promise)
  page.rerender(<PersonalSshPage data={{ available: true, items: [bob] }} port={lifecyclePort({ check: newCheck })}
    onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  expect(screen.getByRole('button', { name: en.sshTestAuthentication })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: en.sshTestAuthentication }))
  expect(newCheck).toHaveBeenCalledOnce()
  await act(async () => {
    if (outcome === 'success') oldReply.resolve({ ...oldCall, state: 'succeeded' })
    else oldReply.reject(new SshHttpError(401))
  })
  expect(screen.queryByText(oldCall.callId.slice(0, 8))).toBeNull()
  expect(screen.queryByText(en.sshCheckStatusUncertain)).toBeNull()
  expect(screen.queryByText(en.sshCancelUncertain)).toBeNull()
  expect(screen.getByRole('button', { name: en.sshTestAuthentication })).toHaveProperty('disabled', true)
  expect(operation === 'status' ? oldStatus : oldCancel).toHaveBeenCalledOnce()
  await act(async () => { newReply.resolve({ callId: 'b18a84f0-3561-48c6-b1b4-9921bf2f3421', state: 'succeeded' }) })
  expect(screen.getByRole('status').textContent).toContain(en.sshCheckSucceeded)
})

test('unavailable service shows existing server metadata but disables new installation', () => {
  const callList = vi.fn(async () => [])
  const port: PersonalSshPort = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(),
    check: vi.fn(), callList, callStatus: vi.fn(), callCancel: vi.fn() }
  render(<PersonalSshPage data={{ ...data, available: false }} port={port} onChange={vi.fn()}
    onReload={vi.fn()} t={t} />)
  expect(screen.getByText('My server')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Add server' }).getAttribute('disabled')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Check SSH credentials' }).getAttribute('disabled')).not.toBeNull()
  expect(callList).not.toHaveBeenCalled()
})

test('password form requires a pinned fingerprint and retries with stable request ID', async () => {
  const create = vi.fn<PersonalSshPort['create']>().mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce(item)
  const port: PersonalSshPort = { list: vi.fn(), create, update: vi.fn(), remove: vi.fn(), toggle: vi.fn(),
    check: vi.fn(), callList: async () => [], callStatus: vi.fn(), callCancel: vi.fn() }
  const onChange = vi.fn()
  render(<PersonalSshPage data={{ ...data, items: [] }} port={port} onChange={onChange}
    onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'My server' } })
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'server.example.com' } })
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } })
  expect(screen.getByRole('button', { name: 'Save server' }).getAttribute('disabled')).not.toBeNull()
  fireEvent.change(screen.getByLabelText('Host-key SHA-256 fingerprint'),
    { target: { value: `${item.hostKeySha256}=` } })
  fireEvent.click(screen.getByRole('button', { name: 'Save server' }))
  await screen.findByText('The save result is uncertain. Retry uses the same request ID and credential.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
  await waitFor(() => { expect(create).toHaveBeenCalledTimes(2) })
  expect(create.mock.calls[0]![0]).toEqual(create.mock.calls[1]![0])
  expect(create.mock.calls[0]![0].configuration.hostKeySha256).toBe(item.hostKeySha256)
  await waitFor(() => { expect(onChange).toHaveBeenCalledWith([item]) })
})

test('SSH toggle retries with the same revision and request ID', async () => {
  const toggle = vi.fn<PersonalSshPort['toggle']>().mockRejectedValueOnce(new Error('reply lost'))
    .mockResolvedValueOnce({ ...item, enabled: false, revision: 2 })
  const port: PersonalSshPort = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle,
    check: vi.fn(), callList: async () => [], callStatus: vi.fn(), callCancel: vi.fn() }
  render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByText('The enabled state is uncertain. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry this change' }))
  await waitFor(() => { expect(toggle).toHaveBeenCalledTimes(2) })
  expect(toggle.mock.calls[0]![0]).toEqual(toggle.mock.calls[1]![0])
  expect(toggle.mock.calls[0]![0].baseRevision).toBe(1)
})

test('recent SSH checks restore after refresh and one list poll advances pending calls', async () => {
  vi.useFakeTimers()
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const callList = vi.fn().mockResolvedValueOnce([{ callId, state: 'accepted' }])
    .mockResolvedValueOnce([{ callId, state: 'succeeded', result: { kind: 'ssh.authenticate', serverBanner: null } }])
  const port: PersonalSshPort = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(),
    check: vi.fn(), callList, callStatus: vi.fn(), callCancel: vi.fn() }
  render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByText('Check pending')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(callList).toHaveBeenCalledTimes(2)
  expect(screen.getByText('SSH authentication succeeded')).toBeTruthy()
  const row = screen.getByText(item.displayName).closest('article')!
  expect(within(row).queryByText(en.sshCheckSucceeded)).toBeNull()
  expect(screen.queryByText('ssh.authenticate')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(callList).toHaveBeenCalledTimes(2)
})

test('an uncertain admission retries the exact request and cancel never claims success', async () => {
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const check = vi.fn<PersonalSshPort['check']>().mockRejectedValueOnce(new Error('reply lost'))
    .mockResolvedValueOnce({ callId, state: 'running' })
  const callCancel = vi.fn(async () => ({ callId, state: 'uncertain' as const }))
  const port: PersonalSshPort = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(), check,
    callList: async () => [], callStatus: vi.fn(), callCancel }
  render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check SSH credentials' }))
  await screen.findByText('The check may have been accepted. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry check request' }))
  await waitFor(() => { expect(check).toHaveBeenCalledTimes(2) })
  expect(check.mock.calls[0]![0]).toEqual(check.mock.calls[1]![0])
  fireEvent.click(screen.getByRole('button', { name: 'Cancel check' }))
  expect((await screen.findAllByText('Check outcome uncertain')).length).toBeGreaterThan(0)
  expect(callCancel).toHaveBeenCalledWith(callId)
  expect(screen.queryByText('Check cancelled')).toBeNull()
  expect(screen.getAllByText('Cancellation requested. The remote outcome is still being confirmed.').length)
    .toBeGreaterThan(0)
})

test('a lost cancellation response remains explicitly uncertain', async () => {
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const port: PersonalSshPort = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(),
    check: async () => ({ callId, state: 'running' }), callList: async () => [], callStatus: vi.fn(),
    callCancel: vi.fn(async () => { throw new Error('lost reply') }) }
  render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check SSH credentials' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel check' }))
  await screen.findByText('The cancellation result is uncertain. Keep checking the call status.')
  expect(screen.queryByText('Check cancelled')).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Refresh list' }).length).toBeGreaterThan(0)
})

test('unmount aborts an in-flight recent-call poll', async () => {
  vi.useFakeTimers()
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  let pollSignal: AbortSignal | undefined
  const callList = vi.fn().mockResolvedValueOnce([{ callId, state: 'running' }])
    .mockImplementationOnce(async (signal: AbortSignal) => { pollSignal = signal
      return new Promise(() => {}) })
  const port: PersonalSshPort = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(), callList,
    check: vi.fn(), callStatus: vi.fn(), callCancel: vi.fn() }
  const view = render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  await act(async () => { await Promise.resolve() })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(pollSignal).toBeDefined()
  view.unmount()
  expect(pollSignal?.aborted).toBe(true)
})

const privateKey = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nfixture\n-----END ENCRYPTED PRIVATE KEY-----'
const keyItem: PersonalSshConnection = { ...item, authentication: 'private_key', passphraseConfigured: true,
  workingDirectory: '~/project' }
const testPort = (overrides: Partial<PersonalSshPort> = {}): PersonalSshPort => ({ list: vi.fn(),
  create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(), check: vi.fn(), callList: async () => [],
  callStatus: vi.fn(), callCancel: vi.fn(), ...overrides })

for (const [language, locale] of [['en', en], ['zh', zh]] as const) {
  const translate = (key: keyof typeof en) => locale[key]

  test(`${language}: changing password authentication to an encrypted key makes the old success historical`, async () => {
    const oldCall = { callId: '217d9a46-3b52-455b-bba6-7d9389c990bb', state: 'succeeded' as const }
    const newCall = { callId: 'b12820cb-9e7d-4c41-8512-6f678115ea89', state: 'succeeded' as const }
    let finishNewCheck: ((call: SshCheckCall) => void) | undefined
    const newAdmission = new Promise<SshCheckCall>((resolve) => { finishNewCheck = resolve })
    const saved = { ...keyItem, revision: 2, credentialRevision: 2, workingDirectory: "~/quote's space" }
    const check = vi.fn(async (input: SshCheckInput) => input.connectionRevision === 1 ? oldCall : newAdmission)
    const update = vi.fn(async (_input: SshUpdateInput) => saved)
    const port = testPort({ check, update, callList: async () => check.mock.calls.length === 0 ? []
      : check.mock.calls.length === 1 ? [oldCall] : [newCall, oldCall] })
    const onChange = vi.fn()
    const view = render(<PersonalSshPage data={data} port={port} onChange={onChange} onReload={vi.fn()} t={translate} />)
    const row = screen.getByText(item.displayName).closest('article')!
    fireEvent.click(within(row).getByRole('button', { name: locale.sshTestAuthentication }))
    await within(row).findByText(locale.sshCheckSucceeded)
    fireEvent.click(within(row).getByRole('button', { name: locale.sshEditServer }))
    fireEvent.change(screen.getByLabelText(locale.mcpAuthentication), { target: { value: 'private_key' } })
    fireEvent.change(screen.getByLabelText(locale.sshPrivateKey), { target: { value: privateKey } })
    fireEvent.change(screen.getByLabelText(locale.sshPassphrase), { target: { value: 'key passphrase' } })
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(locale.sshWorkingDirectory), { target: { value: saved.workingDirectory } })
    fireEvent.click(screen.getByRole('button', { name: locale.sshSaveServer }))
    await waitFor(() => { expect(onChange).toHaveBeenCalledWith([saved]) })
    expect(update.mock.calls[0]![0]).toMatchObject({ baseRevision: 1,
      configuration: { workingDirectory: saved.workingDirectory,
        authentication: { kind: 'private_key', privateKey: 'replace', passphrase: 'replace' } },
      credentials: { formatVersion: 2, privateKey, passphrase: 'key passphrase' } })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    view.rerender(<PersonalSshPage data={{ ...data, items: [saved] }} port={port}
      onChange={onChange} onReload={vi.fn()} t={translate} />)
    const status = within(row).getByRole('status')
    const history = screen.getByRole('region', { name: locale.sshRecentChecks })
    expect(status.querySelector('strong')?.textContent).toBe(locale.mcpCheckCurrentNotChecked)
    expect(within(status).queryByText(locale.sshCheckSucceeded)).toBeNull()
    expect(within(history).getByText(locale.sshCheckSucceeded)).toBeTruthy()
    expect({ revision: within(row).getByText(locale.revision.replace('{count}', '2')).textContent,
      current: status.querySelector('strong')?.textContent,
      messages: Array.from(status.querySelectorAll('p'), element => element.textContent),
      history: Array.from(history.querySelectorAll('article strong'), element => element.textContent),
    }).toMatchSnapshot()
    fireEvent.click(within(row).getByRole('button', { name: locale.sshTestAuthentication }))
    expect(status.querySelector('strong')?.textContent).toBe(locale.sshCheckPending)
    expect(within(row).queryByText(locale.sshCheckSucceeded)).toBeNull()
    expect(within(row).queryByText(locale.mcpCheckPreviousResult.replace('{result}', locale.sshCheckSucceeded))).toBeNull()
    expect(within(history).getByText(locale.sshCheckSucceeded)).toBeTruthy()
    expect({ current: status.querySelector('strong')?.textContent, state: status.getAttribute('data-state'),
      history: Array.from(history.querySelectorAll('article strong'), element => element.textContent),
      checkDisabled: within(row).getByRole('button', { name: locale.sshTestAuthentication }).hasAttribute('disabled'),
    }).toMatchSnapshot('new revision awaiting admission')
    await act(async () => { finishNewCheck!(newCall) })
    await within(row).findByText(locale.sshCheckSucceeded)
    expect(check.mock.calls.map(([input]) => input.connectionRevision)).toEqual([1, 2])
    expect(within(row).queryByText(locale.mcpCheckStale)).toBeNull()
    await waitFor(() => { expect(within(history).getAllByText(locale.sshCheckSucceeded)).toHaveLength(2) })
  })

  test(`${language}: private-key creation preserves the original fields and home-relative working directory`, async () => {
    const create = vi.fn(async (_input: SshCreateInput) => keyItem)
    render(<PersonalSshPage data={{ available: true, items: [] }} port={testPort({ create })}
      onChange={vi.fn()} onReload={vi.fn()} t={translate} />)
    fireEvent.click(screen.getByRole('button', { name: locale.sshAddServer }))
    fireEvent.change(screen.getByLabelText(locale.sshDisplayName), { target: { value: 'My server' } })
    fireEvent.change(screen.getByLabelText(locale.sshHost), { target: { value: item.host } })
    fireEvent.change(screen.getByLabelText(locale.sshUsername), { target: { value: item.username } })
    fireEvent.change(screen.getByLabelText(locale.mcpAuthentication), { target: { value: 'private_key' } })
    fireEvent.change(screen.getByLabelText(locale.sshPrivateKey), { target: { value: privateKey } })
    fireEvent.change(screen.getByLabelText(locale.sshPassphrase), { target: { value: '密语' } })
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(locale.sshWorkingDirectory), { target: { value: '~/project' } })
    fireEvent.change(screen.getByLabelText(locale.sshHostKey), { target: { value: item.hostKeySha256 } })
    fireEvent.click(screen.getByLabelText(locale.sshConnectionEnabled))
    fireEvent.click(screen.getByRole('button', { name: locale.sshSaveServer }))
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
    const value = create.mock.calls[0]![0]
    expect(value.configuration).toMatchObject({ workingDirectory: '~/project',
      authentication: { kind: 'private_key', privateKey: 'replace', passphrase: 'replace' } })
    expect(value.credentials).toEqual({ formatVersion: 2, privateKey, passphrase: '密语' })
  })

  test(`${language}: editing fills metadata only and clear passphrase is an explicit choice`, async () => {
    const update = vi.fn(async (_input: SshUpdateInput) => ({ ...keyItem, revision: 2, passphraseConfigured: false }))
    render(<PersonalSshPage data={{ available: true, items: [keyItem] }} port={testPort({ update })}
      onChange={vi.fn()} onReload={vi.fn()} t={translate} />)
    fireEvent.click(screen.getByRole('button', { name: locale.sshEditServer }))
    const keyField = screen.getByLabelText(locale.sshPrivateKey) as HTMLTextAreaElement
    const passphraseField = screen.getByLabelText(locale.sshPassphrase) as HTMLInputElement
    expect(keyField.value).toBe('')
    expect(passphraseField.value).toBe('')
    expect(keyField.placeholder).toBe(locale.sshSecretPreserve)
    expect(passphraseField.placeholder).toBe(locale.sshSecretPreserve)
    expect((screen.getByLabelText<HTMLInputElement>(locale.sshWorkingDirectory)).value).toBe('~/project')
    expect((screen.getByLabelText<HTMLInputElement>(locale.sshClearPassphrase)).checked).toBe(false)
    fireEvent.click(screen.getByLabelText<HTMLInputElement>(locale.sshClearPassphrase))
    expect(passphraseField.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: locale.sshSaveServer }))
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    expect(update.mock.calls[0]![0]).toMatchObject({ connectionId: item.connectionId, baseRevision: 1,
      configuration: { authentication: { kind: 'private_key', privateKey: 'retain', passphrase: 'clear' } } })
    expect(update.mock.calls[0]![0].credentials).toBeUndefined()
  })

  test(`${language}: a changed authentication kind requires a replacement and invalidates old secret fields`, async () => {
    const update = vi.fn(async (_input: SshUpdateInput) => ({ ...item, authentication: 'private_key' as const, revision: 2 }))
    render(<PersonalSshPage data={data} port={testPort({ update })} onChange={vi.fn()} onReload={vi.fn()} t={translate} />)
    fireEvent.click(screen.getByRole('button', { name: locale.sshEditServer }))
    const save = screen.getByRole('button', { name: locale.sshSaveServer })
    expect(save.hasAttribute('disabled')).toBe(false)
    fireEvent.change(screen.getByLabelText(locale.sshPassword), { target: { value: 'discard on switch' } })
    fireEvent.change(screen.getByLabelText(locale.mcpAuthentication), { target: { value: 'private_key' } })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText(locale.sshPrivateKey), { target: { value: privateKey } })
    expect(save.hasAttribute('disabled')).toBe(false)
    fireEvent.click(save)
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    expect(update.mock.calls[0]![0].credentials).toEqual({ formatVersion: 2, privateKey })
    expect(update.mock.calls[0]![0].configuration.authentication)
      .toEqual({ kind: 'private_key', privateKey: 'replace', passphrase: 'clear' })
  })
}

for (const [failure, cause, message, canRetry] of [
  ['uncertain', new Error('reply lost'), en.sshCheckAdmissionUncertain, true],
  ['rejected', new SshHttpError(409), en.sshCheckRejected, false],
] as const) {
  test(`a ${failure} POST for a new revision cannot restore the previous successful call`, async () => {
    const oldCall = { callId: '217d9a46-3b52-455b-bba6-7d9389c990bb', state: 'succeeded' as const }
    let failNewCheck: ((cause: Error) => void) | undefined
    const newAdmission = new Promise<SshCheckCall>((_resolve, reject) => { failNewCheck = reject })
    const check = vi.fn(async (input: SshCheckInput) => input.connectionRevision === 1 ? oldCall : newAdmission)
    const port = testPort({ check, callList: async () => check.mock.calls.length === 0 ? [] : [oldCall] })
    const view = render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
    const row = screen.getByText(item.displayName).closest('article')!
    fireEvent.click(within(row).getByRole('button', { name: en.sshTestAuthentication }))
    await within(row).findByText(en.sshCheckSucceeded)
    view.rerender(<PersonalSshPage data={{ ...data, items: [{ ...item, revision: 2 }] }}
      port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
    fireEvent.click(within(row).getByRole('button', { name: en.sshTestAuthentication }))
    const status = within(row).getByRole('status')
    expect(status.querySelector('strong')?.textContent).toBe(en.sshCheckPending)
    await act(async () => { failNewCheck!(cause) })
    expect(status.querySelector('strong')?.textContent).toBe(en.sshCheckUncertain)
    expect(within(status).getByText(message)).toBeTruthy()
    expect(within(status).queryByText(en.sshCheckSucceeded)).toBeNull()
    expect(within(status).queryByText(en.mcpCheckPreviousResult.replace('{result}', en.sshCheckSucceeded))).toBeNull()
    expect(Boolean(within(status).queryByRole('button', { name: en.sshRetryCheck }))).toBe(canRetry)
    const history = screen.getByRole('region', { name: en.sshRecentChecks })
    expect(within(history).getByText(en.sshCheckSucceeded)).toBeTruthy()
    expect(check.mock.calls[1]![0]).toMatchObject({ connectionId: item.connectionId, connectionRevision: 2 })
    expect(check.mock.calls[1]![0].requestId).not.toBe(check.mock.calls[0]![0].requestId)
  })
}

test('old list results arriving during and after a new POST cannot supply its current call', async () => {
  const oldCall = { callId: '217d9a46-3b52-455b-bba6-7d9389c990bb', state: 'succeeded' as const }
  const newCall = { callId: 'b12820cb-9e7d-4c41-8512-6f678115ea89', state: 'running' as const }
  let finishOldPoll: ((calls: readonly SshCheckCall[]) => void) | undefined
  let finishStaleList: ((calls: readonly SshCheckCall[]) => void) | undefined
  let finishNewCheck: ((call: SshCheckCall) => void) | undefined
  const oldPoll = new Promise<readonly SshCheckCall[]>((resolve) => { finishOldPoll = resolve })
  const staleList = new Promise<readonly SshCheckCall[]>((resolve) => { finishStaleList = resolve })
  const newAdmission = new Promise<SshCheckCall>((resolve) => { finishNewCheck = resolve })
  const callList = vi.fn<PersonalSshPort['callList']>().mockResolvedValueOnce([]).mockResolvedValueOnce([oldCall])
    .mockReturnValueOnce(oldPoll).mockReturnValueOnce(staleList)
  const check = vi.fn(async (input: SshCheckInput) => input.connectionRevision === 1 ? oldCall : newAdmission)
  const port = testPort({ check, callList })
  const view = render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  await act(async () => { await Promise.resolve() })
  const row = screen.getByText(item.displayName).closest('article')!
  fireEvent.click(within(row).getByRole('button', { name: en.sshTestAuthentication }))
  await within(row).findByText(en.sshCheckSucceeded)
  await waitFor(() => { expect(callList).toHaveBeenCalledTimes(2) })
  view.rerender(<PersonalSshPage data={{ ...data, items: [{ ...item, revision: 2 }] }}
    port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  const history = screen.getByRole('region', { name: en.sshRecentChecks })
  fireEvent.click(within(history).getByRole('button', { name: en.refreshList }))
  await waitFor(() => { expect(callList).toHaveBeenCalledTimes(3) })
  fireEvent.click(within(row).getByRole('button', { name: en.sshTestAuthentication }))
  const status = within(row).getByRole('status')
  expect(status.querySelector('strong')?.textContent).toBe(en.sshCheckPending)
  await act(async () => { finishOldPoll!([oldCall]) })
  expect(status.querySelector('strong')?.textContent).toBe(en.sshCheckPending)
  expect(within(row).queryByText(en.sshCheckSucceeded)).toBeNull()
  expect(within(history).getByText(en.sshCheckSucceeded)).toBeTruthy()
  await act(async () => { finishNewCheck!(newCall) })
  await waitFor(() => { expect(callList).toHaveBeenCalledTimes(4) })
  expect(status.querySelector('strong')?.textContent).toBe(en.sshCheckRunning)
  await act(async () => { finishStaleList!([oldCall]) })
  expect(status.querySelector('strong')?.textContent).toBe(en.sshCheckRunning)
  expect(within(row).queryByText(en.sshCheckSucceeded)).toBeNull()
  expect(within(row).getByRole('button', { name: en.sshTestAuthentication }).hasAttribute('disabled')).toBe(true)
})

test('a late check reply and subsequent status refresh cannot validate a newer saved revision', async () => {
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const oldCall = { callId, state: 'succeeded' as const }
  let finishCheck: ((call: typeof oldCall) => void) | undefined
  const check = vi.fn((_input: SshCheckInput) => new Promise<typeof oldCall>((resolve) => { finishCheck = resolve }))
  const callStatus = vi.fn(async () => oldCall)
  const port = testPort({ check, callStatus, callList: async () => finishCheck ? [oldCall] : [] })
  const view = render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  await act(async () => { await Promise.resolve() })
  const row = screen.getByText(item.displayName).closest('article')!
  fireEvent.click(within(row).getByRole('button', { name: en.sshTestAuthentication }))
  view.rerender(<PersonalSshPage data={{ ...data, items: [{ ...item, revision: 2, credentialRevision: 2 }] }}
    port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  await act(async () => { finishCheck!(oldCall) })
  const status = within(row).getByRole('status')
  expect(status.querySelector('strong')?.textContent).toBe(en.mcpCheckCurrentNotChecked)
  const history = screen.getByRole('region', { name: en.sshRecentChecks })
  fireEvent.click(within(history).getByRole('button', { name: en.sshRefreshCheck }))
  await waitFor(() => { expect(callStatus).toHaveBeenCalledWith(callId) })
  expect(status.querySelector('strong')?.textContent).toBe(en.mcpCheckCurrentNotChecked)
  expect(check.mock.calls[0]![0].connectionRevision).toBe(1)
})

test('a late list poll updates the old running check while the newer revision remains unchecked', async () => {
  vi.useFakeTimers()
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const callList = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ callId, state: 'running' }])
    .mockResolvedValueOnce([{ callId, state: 'succeeded' }])
  const port = testPort({ callList, check: async () => ({ callId, state: 'running' }) })
  const view = render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  await act(async () => { await Promise.resolve() })
  const row = screen.getByText(item.displayName).closest('article')!
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: en.sshTestAuthentication })) })
  expect(within(row).getByText(en.sshCheckRunning)).toBeTruthy()
  view.rerender(<PersonalSshPage data={{ ...data, items: [{ ...item, revision: 2 }] }}
    port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  const status = within(row).getByRole('status')
  expect(status.querySelector('strong')?.textContent).toBe(en.mcpCheckCurrentNotChecked)
  expect(within(status).getByRole('button', { name: en.sshCancelCheck }).hasAttribute('disabled')).toBe(false)
  expect(within(row).getByRole('button', { name: en.sshTestAuthentication }).hasAttribute('disabled')).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(callList).toHaveBeenCalledTimes(3)
  expect(status.querySelector('strong')?.textContent).toBe(en.mcpCheckCurrentNotChecked)
  expect(within(status).getByText(en.mcpCheckPreviousResult.replace('{result}', en.sshCheckSucceeded))).toBeTruthy()
  expect(within(row).getByRole('button', { name: en.sshTestAuthentication }).hasAttribute('disabled')).toBe(false)
})

test('retrying an uncertain admission after an edit retains the original request and cannot validate the new revision', async () => {
  const oldCall = { callId: '217d9a46-3b52-455b-bba6-7d9389c990bb', state: 'succeeded' as const }
  const check = vi.fn<PersonalSshPort['check']>().mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce(oldCall)
  const port = testPort({ check, callList: async () => check.mock.calls.length < 2 ? [] : [oldCall] })
  const view = render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  const row = screen.getByText(item.displayName).closest('article')!
  fireEvent.click(within(row).getByRole('button', { name: en.sshTestAuthentication }))
  await within(row).findByText(en.sshCheckAdmissionUncertain)
  view.rerender(<PersonalSshPage data={{ ...data, items: [{ ...item, revision: 2, credentialRevision: 2 }] }}
    port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  const status = within(row).getByRole('status')
  expect(status.querySelector('strong')?.textContent).toBe(en.mcpCheckCurrentNotChecked)
  expect(within(row).getByRole('button', { name: en.sshTestAuthentication }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(within(status).getByRole('button', { name: en.sshRetryCheck }))
  await within(status).findByText(en.mcpCheckPreviousResult.replace('{result}', en.sshCheckSucceeded))
  expect(check.mock.calls[1]![0]).toEqual(check.mock.calls[0]![0])
  expect(check.mock.calls[1]![0].connectionRevision).toBe(1)
  expect(status.querySelector('strong')?.textContent).toBe(en.mcpCheckCurrentNotChecked)
  expect(within(row).getByRole('button', { name: en.sshTestAuthentication }).hasAttribute('disabled')).toBe(false)
})

test('metadata edit retries the captured revision and freezes all draft inputs after an ambiguous reply', async () => {
  const update = vi.fn<PersonalSshPort['update']>().mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValueOnce({ ...item, displayName: 'Edited', revision: 2 })
  const port = testPort({ update })
  const onChange = vi.fn()
  const view = render(<PersonalSshPage data={data} port={port} onChange={onChange} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  fireEvent.change(screen.getByLabelText(en.sshDisplayName), { target: { value: 'Edited' } })
  fireEvent.click(screen.getByRole('button', { name: en.sshSaveServer }))
  await screen.findByText(en.sshCreateUncertain)
  expect(screen.getByLabelText(en.sshDisplayName).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: en.cancel }).hasAttribute('disabled')).toBe(true)
  view.rerender(<PersonalSshPage data={{ ...data, items: [{ ...item, revision: 7 }] }} port={port}
    onChange={onChange} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshRetryCreate }))
  await waitFor(() => { expect(update).toHaveBeenCalledTimes(2) })
  expect(update.mock.calls[0]![0]).toEqual(update.mock.calls[1]![0])
  expect(update.mock.calls[1]![0].baseRevision).toBe(1)
  expect(update.mock.calls[0]![0].configuration.authentication).toEqual({ kind: 'password', password: 'retain' })
  expect(update.mock.calls[0]![0].credentials).toBeUndefined()
  await waitFor(() => { expect(onChange).toHaveBeenCalledWith([{ ...item, revision: 7 }]) })
})

test('a definite conflict unlocks the editor and a new submit gets a new request ID', async () => {
  const update = vi.fn<PersonalSshPort['update']>().mockRejectedValueOnce(new SshHttpError(409))
    .mockResolvedValueOnce({ ...item, displayName: 'Retry edit', revision: 2 })
  render(<PersonalSshPage data={data} port={testPort({ update })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  fireEvent.click(screen.getByRole('button', { name: en.sshSaveServer }))
  await screen.findByText(en.sshConflict)
  expect(screen.getByLabelText(en.sshDisplayName).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByRole('button', { name: en.sshRetryCreate })).toBeNull()
  fireEvent.change(screen.getByLabelText(en.sshDisplayName), { target: { value: 'Retry edit' } })
  fireEvent.click(screen.getByRole('button', { name: en.sshSaveServer }))
  await waitFor(() => { expect(update).toHaveBeenCalledTimes(2) })
  expect(update.mock.calls[1]![0].requestId).not.toBe(update.mock.calls[0]![0].requestId)
})

test('delete requires confirmation, retries its original identity and retains recent checks after the tombstone', async () => {
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const remove = vi.fn<PersonalSshPort['remove']>().mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValueOnce({ ...item, enabled: false, revision: 2, deletedAt: item.updatedAt })
  const port = testPort({ remove, callList: async () => [{ callId, state: 'succeeded' }] })
  const onChange = vi.fn()
  const view = render(<PersonalSshPage data={data} port={port} onChange={onChange} onReload={vi.fn()} t={t} />)
  await screen.findByText(en.sshCheckSucceeded)
  fireEvent.click(screen.getByRole('button', { name: en.sshDeleteServer }))
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.sshConfirmDeleteServer }))
  await screen.findByText(en.sshDeleteUncertain)
  expect(screen.getByRole('button', { name: en.sshEditServer }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.sshRetryDelete }))
  await waitFor(() => { expect(onChange).toHaveBeenCalledWith([]) })
  expect(remove.mock.calls[0]![0]).toEqual(remove.mock.calls[1]![0])
  expect(remove.mock.calls[0]![0].baseRevision).toBe(1)
  view.rerender(<PersonalSshPage data={{ ...data, items: [] }} port={port} onChange={onChange} onReload={vi.fn()} t={t} />)
  expect(screen.queryByText(item.displayName)).toBeNull()
  expect(screen.getByText(en.sshCheckSucceeded)).toBeTruthy()
})

test('opening and changing a draft never sends a draft check; the check still uses the saved revision', async () => {
  const check = vi.fn(async (_input: SshCheckInput) => ({ callId: '217d9a46-3b52-455b-bba6-7d9389c990bb', state: 'succeeded' as const }))
  render(<PersonalSshPage data={data} port={testPort({ check })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  fireEvent.change(screen.getByLabelText(en.sshHost), { target: { value: 'draft.example.com' } })
  expect(check).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).queryByRole('button', { name: en.sshTestAuthentication })).toBeNull()
  expect((screen.getByLabelText<HTMLInputElement>(en.sshHostKey)).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  fireEvent.click(screen.getByRole('button', { name: en.sshTestAuthentication }))
  await waitFor(() => { expect(check).toHaveBeenCalledTimes(1) })
  expect(check.mock.calls[0]![0]).toMatchObject({ connectionId: item.connectionId, connectionRevision: 1 })
  expect(check.mock.calls[0]![0]).not.toHaveProperty('configuration')
})

test('English SSH editor records localized labels, retention and available actions', async () => {
  render(<PersonalSshPage data={{ available: true, items: [keyItem] }} port={testPort()}
    onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  const dialog = screen.getByRole('dialog')
  await act(async () => { await Promise.resolve() })
  expect({ title: dialog.getAttribute('aria-label'),
    fields: Array.from(dialog.querySelectorAll('.pext-mcp-form-field > span'), element => element.textContent),
    privateKey: (screen.getByLabelText<HTMLTextAreaElement>(en.sshPrivateKey)).value,
    retention: (screen.getByLabelText<HTMLTextAreaElement>(en.sshPrivateKey)).placeholder,
    clearPassphrase: (screen.getByLabelText<HTMLInputElement>(en.sshClearPassphrase)).checked,
    actions: Array.from(dialog.querySelectorAll('button'), element => element.getAttribute('aria-label') ?? element.textContent),
  }).toMatchInlineSnapshot(`
    {
      "actions": [
        "Close",
        "Cancel",
        "Save server",
      ],
      "clearPassphrase": false,
      "fields": [
        "Display name",
        "Host",
        "Port",
        "Username",
        "Authentication",
        "Private key",
        "Private-key passphrase",
        "Working directory",
        "Host-key SHA-256 fingerprint",
      ],
      "privateKey": "",
      "retention": "Leave blank to retain the saved secret",
      "title": "Edit server",
    }
  `)
})

for (const directory of [' ~/project ', ' relative directory ', '  ', '', '\uFEFFrelative']) {
  test(`editing sends the literal directory ${JSON.stringify(directory)} with only empty mapped to null`, async () => {
    const expected = directory === '' ? null : directory
    const update = vi.fn(async (_input: SshUpdateInput) => ({ ...keyItem, workingDirectory: expected, revision: 2 }))
    render(<PersonalSshPage data={{ available: true, items: [keyItem] }} port={testPort({ update })}
      onChange={vi.fn()} onReload={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
    fireEvent.change(screen.getByLabelText(en.sshWorkingDirectory), { target: { value: directory } })
    const save = screen.getByRole('button', { name: en.sshSaveServer })
    expect(save.hasAttribute('disabled')).toBe(false)
    fireEvent.click(save)
    await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
    expect(update.mock.calls[0]![0].configuration.workingDirectory).toBe(expected)
  })
}

test('the form rejects directory controls, lossy UTF-8 and more than 1024 UTF16 units before saving', () => {
  const update = vi.fn<PersonalSshPort['update']>()
  render(<PersonalSshPage data={data} port={testPort({ update })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  const field = screen.getByLabelText(en.sshWorkingDirectory)
  const save = screen.getByRole('button', { name: en.sshSaveServer })
  for (const value of ['\0', 'a\tpath', '\u007f', '\u0085', '\u009f', '\ud800', '\udc00', 'x'.repeat(1025), '😀'.repeat(513)]) {
    fireEvent.change(field, { target: { value } })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.click(save)
  }
  expect(update).not.toHaveBeenCalled()
  fireEvent.change(field, { target: { value: '😀'.repeat(512) } })
  expect(save.hasAttribute('disabled')).toBe(false)
})

test('the editor trims usernames while enforcing the 256-byte and lossless UTF-8 limits', async () => {
  const username = `${'你'.repeat(85)}a`
  const update = vi.fn(async (_input: SshUpdateInput) => ({ ...item, username, revision: 2 }))
  render(<PersonalSshPage data={data} port={testPort({ update })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  const field = screen.getByLabelText(en.sshUsername)
  const save = screen.getByRole('button', { name: en.sshSaveServer })
  for (const value of ['你'.repeat(86), '\ud800', '\udc00', 'a b', ' ']) {
    fireEvent.change(field, { target: { value } })
    expect(save.hasAttribute('disabled')).toBe(true)
  }
  fireEvent.change(field, { target: { value: ` ${username} ` } })
  expect(save.hasAttribute('disabled')).toBe(false)
  fireEvent.click(save)
  await waitFor(() => { expect(update).toHaveBeenCalledTimes(1) })
  expect(update.mock.calls[0]![0].configuration.username).toBe(username)
})

test('an out-of-range saved revision cannot be submitted from the editor', () => {
  const update = vi.fn<PersonalSshPort['update']>()
  render(<PersonalSshPage data={{ ...data, items: [{ ...item, revision: 2_147_483_648 }] }}
    port={testPort({ update })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  const save = screen.getByRole('button', { name: en.sshSaveServer })
  expect(save.hasAttribute('disabled')).toBe(true)
  fireEvent.click(save)
  expect(update).not.toHaveBeenCalled()
})

test('a late running status cannot regress a terminal selected check or its recent history', async () => {
  const completed: SshCheckCall = { callId: '217d9a46-3b52-455b-bba6-7d9389c990bb', state: 'succeeded' }
  const callStatus = vi.fn<PersonalSshPort['callStatus']>(async () => ({ ...completed, state: 'running' }))
  const port = testPort({ check: async () => completed, callList: async () => [completed], callStatus })
  render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  const row = within(screen.getByText(item.displayName).closest('article')!)
  fireEvent.click(row.getByRole('button', { name: en.sshTestAuthentication }))
  await row.findByText(en.sshCheckSucceeded)
  const history = within(screen.getByRole('region', { name: en.sshRecentChecks }))
  fireEvent.click(history.getByRole('button', { name: en.sshRefreshCheck }))
  await waitFor(() => { expect(callStatus).toHaveBeenCalledOnce() })
  expect(row.getByText(en.sshCheckSucceeded)).toBeTruthy()
  expect(history.getByText(en.sshCheckSucceeded)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.sshCancelCheck })).toBeNull()
})

test('an explicit recent-list refresh clears a lost status read and owns the old polling timer', async () => {
  vi.useFakeTimers()
  const callList = vi.fn<PersonalSshPort['callList']>().mockRejectedValueOnce(new TypeError('lost status response')).mockResolvedValueOnce([])
  const onReload = vi.fn()
  render(<PersonalSshPage data={data} port={testPort({ callList })} onChange={vi.fn()} onReload={onReload} t={t} />)
  await act(async () => { await Promise.resolve() })
  const history = within(screen.getByRole('region', { name: en.sshRecentChecks }))
  expect(history.getByText(en.sshCheckStatusUncertain)).toBeTruthy()
  await act(async () => { fireEvent.click(history.getByRole('button', { name: en.refreshList })) })
  expect(history.queryByRole('alert')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(callList).toHaveBeenCalledTimes(2)
  expect(onReload).not.toHaveBeenCalled()
})

test('closing an SSH editor clears the unsaved write-only password before reopening', () => {
  const update = vi.fn<PersonalSshPort['update']>()
  const port = testPort({ update })
  render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  fireEvent.change(screen.getByLabelText(en.sshPassword), { target: { value: 'unsaved-replacement' } })
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  expect(screen.getByLabelText(en.sshPassword)).toHaveProperty('value', '')
  expect(update).not.toHaveBeenCalled()
})

test.each([
  { operation: 'toggle', outcome: 'success' }, { operation: 'toggle', outcome: 'failure' },
  { operation: 'update', outcome: 'success' }, { operation: 'update', outcome: 'failure' },
  { operation: 'check', outcome: 'success' }, { operation: 'check', outcome: 'failure' },
] as const)('a late SSH $operation $outcome after teardown cannot publish rows or restart call polling', async ({ operation, outcome }) => {
  const mutation = deferredResult<PersonalSshConnection>(), admission = deferredResult<SshCheckCall>()
  const callList = vi.fn<PersonalSshPort['callList']>(async () => [])
  const port = testPort({ toggle: () => mutation.promise, update: () => mutation.promise, check: () => admission.promise, callList })
  const onChange = vi.fn()
  const page = render(<PersonalSshPage data={data} port={port} onChange={onChange} onReload={vi.fn()} t={t} />)
  if (operation === 'toggle') fireEvent.click(screen.getByRole('switch'))
  else if (operation === 'check') fireEvent.click(screen.getByRole('button', { name: en.sshTestAuthentication }))
  else {
    fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
    fireEvent.change(screen.getByLabelText(en.sshDisplayName), { target: { value: 'Edited server' } })
    fireEvent.click(screen.getByRole('button', { name: en.sshSaveServer }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  }
  page.unmount()
  await act(async () => {
    if (operation === 'check') {
      if (outcome === 'success') admission.resolve({ callId: '217d9a46-3b52-455b-bba6-7d9389c990bb', state: 'running' })
      else admission.reject(new SshHttpError(401))
    } else if (outcome === 'success') mutation.resolve({ ...item, revision: 2 })
    else mutation.reject(new SshHttpError(401))
  })
  expect(onChange).not.toHaveBeenCalled()
  expect(callList).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})

test.each([401, 403])('a definite SSH check %i refusal permits a new gesture without treating it as uncertain admission', async (status) => {
  const check = vi.fn<PersonalSshPort['check']>().mockRejectedValueOnce(new SshHttpError(status))
    .mockResolvedValueOnce({ callId: '217d9a46-3b52-455b-bba6-7d9389c990bb', state: 'succeeded' })
  render(<PersonalSshPage data={data} port={testPort({ check })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshTestAuthentication }))
  await screen.findByText(status === 401 ? en.sessionExpired : en.sshCheckRejected)
  expect(screen.queryByRole('button', { name: en.sshRetryCheck })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.sshTestAuthentication }))
  const row = within(screen.getByText(item.displayName).closest('article')!)
  await row.findByText(en.sshCheckSucceeded)
  expect(check.mock.calls[1]?.[0].requestId).not.toBe(check.mock.calls[0]?.[0].requestId)
  expect(check.mock.calls.map(([input]) => input.connectionRevision)).toEqual([1, 1])
})
