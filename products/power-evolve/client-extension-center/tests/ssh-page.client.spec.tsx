import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PersonalSshPage } from '../src/client/PersonalSshPage.tsx'
import type { PersonalSshConnection, PersonalSshList, PersonalSshPort } from '../src/client/ssh-api.ts'
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
  const create = vi.fn().mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce(item)
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
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
  expect(create.mock.calls[0]![0]).toEqual(create.mock.calls[1]![0])
  expect(create.mock.calls[0]![0].configuration.hostKeySha256).toBe(item.hostKeySha256)
  await waitFor(() => expect(onChange).toHaveBeenCalledWith([item]))
})

test('SSH toggle retries with the same revision and request ID', async () => {
  const toggle = vi.fn().mockRejectedValueOnce(new Error('reply lost'))
    .mockResolvedValueOnce({ ...item, enabled: false, revision: 2 })
  const port: PersonalSshPort = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle,
    check: vi.fn(), callList: async () => [], callStatus: vi.fn(), callCancel: vi.fn() }
  render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByText('The enabled state is uncertain. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry this change' }))
  await waitFor(() => expect(toggle).toHaveBeenCalledTimes(2))
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
  const check = vi.fn().mockRejectedValueOnce(new Error('reply lost'))
    .mockResolvedValueOnce({ callId, state: 'running' })
  const callCancel = vi.fn(async () => ({ callId, state: 'uncertain' as const }))
  const port: PersonalSshPort = { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), toggle: vi.fn(), check,
    callList: async () => [], callStatus: vi.fn(), callCancel }
  render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Check SSH credentials' }))
  await screen.findByText('The check may have been accepted. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry check request' }))
  await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
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
    const saved = { ...keyItem, revision: 2, credentialRevision: 2, workingDirectory: "~/quote's space" }
    const check = vi.fn(async (input: SshCheckInput) => input.connectionRevision === 1 ? oldCall : newCall)
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
    fireEvent.change(screen.getByLabelText(locale.sshWorkingDirectory), { target: { value: saved.workingDirectory } })
    fireEvent.click(screen.getByRole('button', { name: locale.sshSaveServer }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([saved]))
    expect(update.mock.calls[0]![0]).toMatchObject({ baseRevision: 1,
      configuration: { workingDirectory: saved.workingDirectory,
        authentication: { kind: 'private_key', privateKey: 'replace', passphrase: 'replace' } },
      credentials: { formatVersion: 2, privateKey, passphrase: 'key passphrase' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
    await within(row).findByText(locale.sshCheckSucceeded)
    expect(check.mock.calls.map(([input]) => input.connectionRevision)).toEqual([1, 2])
    expect(within(row).queryByText(locale.mcpCheckStale)).toBeNull()
    await waitFor(() => expect(within(history).getAllByText(locale.sshCheckSucceeded)).toHaveLength(2))
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
    fireEvent.change(screen.getByLabelText(locale.sshWorkingDirectory), { target: { value: '~/project' } })
    fireEvent.change(screen.getByLabelText(locale.sshHostKey), { target: { value: item.hostKeySha256 } })
    fireEvent.click(screen.getByLabelText(locale.sshConnectionEnabled))
    fireEvent.click(screen.getByRole('button', { name: locale.sshSaveServer }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
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
    expect((screen.getByLabelText(locale.sshWorkingDirectory) as HTMLInputElement).value).toBe('~/project')
    expect((screen.getByLabelText(locale.sshClearPassphrase) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByLabelText(locale.sshClearPassphrase))
    expect(passphraseField.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: locale.sshSaveServer }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
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
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]![0].credentials).toEqual({ formatVersion: 2, privateKey })
    expect(update.mock.calls[0]![0].configuration.authentication)
      .toEqual({ kind: 'private_key', privateKey: 'replace', passphrase: 'clear' })
  })
}

test('a late check reply and subsequent status refresh cannot validate a newer saved revision', async () => {
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const oldCall = { callId, state: 'succeeded' as const }
  let finishCheck: ((call: typeof oldCall) => void) | undefined
  const check = vi.fn((_input: SshCheckInput) => new Promise<typeof oldCall>(resolve => { finishCheck = resolve }))
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
  await waitFor(() => expect(callStatus).toHaveBeenCalledWith(callId))
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
  const check = vi.fn().mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce(oldCall)
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
  const update = vi.fn().mockRejectedValueOnce(new Error('lost'))
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
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
  expect(update.mock.calls[0]![0]).toEqual(update.mock.calls[1]![0])
  expect(update.mock.calls[1]![0].baseRevision).toBe(1)
  expect(update.mock.calls[0]![0].configuration.authentication).toEqual({ kind: 'password', password: 'retain' })
  expect(update.mock.calls[0]![0].credentials).toBeUndefined()
  await waitFor(() => expect(onChange).toHaveBeenCalledWith([{ ...item, revision: 7 }]))
})

test('a definite conflict unlocks the editor and a new submit gets a new request ID', async () => {
  const update = vi.fn().mockRejectedValueOnce(new SshHttpError(409))
    .mockResolvedValueOnce({ ...item, displayName: 'Retry edit', revision: 2 })
  render(<PersonalSshPage data={data} port={testPort({ update })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  fireEvent.click(screen.getByRole('button', { name: en.sshSaveServer }))
  await screen.findByText(en.sshConflict)
  expect(screen.getByLabelText(en.sshDisplayName).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByRole('button', { name: en.sshRetryCreate })).toBeNull()
  fireEvent.change(screen.getByLabelText(en.sshDisplayName), { target: { value: 'Retry edit' } })
  fireEvent.click(screen.getByRole('button', { name: en.sshSaveServer }))
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
  expect(update.mock.calls[1]![0].requestId).not.toBe(update.mock.calls[0]![0].requestId)
})

test('delete requires confirmation, retries its original identity and retains recent checks after the tombstone', async () => {
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const remove = vi.fn().mockRejectedValueOnce(new Error('lost'))
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
  await waitFor(() => expect(onChange).toHaveBeenCalledWith([]))
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
  expect((screen.getByLabelText(en.sshHostKey) as HTMLInputElement).value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  fireEvent.click(screen.getByRole('button', { name: en.sshTestAuthentication }))
  await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
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
    privateKey: (screen.getByLabelText(en.sshPrivateKey) as HTMLTextAreaElement).value,
    retention: (screen.getByLabelText(en.sshPrivateKey) as HTMLTextAreaElement).placeholder,
    clearPassphrase: (screen.getByLabelText(en.sshClearPassphrase) as HTMLInputElement).checked,
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
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]![0].configuration.workingDirectory).toBe(expected)
  })
}

test('the form rejects directory controls, lossy UTF-8 and more than 1024 UTF16 units before saving', () => {
  const update = vi.fn()
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
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  expect(update.mock.calls[0]![0].configuration.username).toBe(username)
})

test('an out-of-range saved revision cannot be submitted from the editor', () => {
  const update = vi.fn()
  render(<PersonalSshPage data={{ ...data, items: [{ ...item, revision: 2_147_483_648 }] }}
    port={testPort({ update })} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.sshEditServer }))
  const save = screen.getByRole('button', { name: en.sshSaveServer })
  expect(save.hasAttribute('disabled')).toBe(true)
  fireEvent.click(save)
  expect(update).not.toHaveBeenCalled()
})
