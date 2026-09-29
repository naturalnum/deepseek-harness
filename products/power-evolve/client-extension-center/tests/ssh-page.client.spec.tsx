import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PersonalSshPage } from '../src/client/PersonalSshPage.tsx'
import type { PersonalSshConnection, PersonalSshList, PersonalSshPort } from '../src/client/ssh-api.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const item: PersonalSshConnection = { connectionId: 'f76e4521-45b0-4829-91dd-9a205c7ef68c',
  displayName: 'My server', host: 'server.example.com', port: 22, username: 'alice',
  hostKeySha256: 'SHA256:1234567890123456789012345678901234567890123',
  enabled: true, revision: 1, credentialRevision: 1 }
const data: PersonalSshList = { available: true, items: [item] }
const t = (key: keyof typeof en) => en[key]

test('unavailable service shows existing server metadata but disables new installation', () => {
  const callList = vi.fn(async () => [])
  const port: PersonalSshPort = { list: vi.fn(), createPassword: vi.fn(), toggle: vi.fn(),
    check: vi.fn(), callList, callStatus: vi.fn(), callCancel: vi.fn() }
  render(<PersonalSshPage data={{ ...data, available: false }} port={port} onChange={vi.fn()}
    onReload={vi.fn()} t={t} />)
  expect(screen.getByText('My server')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Add server' }).getAttribute('disabled')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Check SSH credentials' }).getAttribute('disabled')).not.toBeNull()
  expect(callList).not.toHaveBeenCalled()
})

test('password form requires a pinned fingerprint and retries with stable request ID', async () => {
  const createPassword = vi.fn().mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce(item)
  const port: PersonalSshPort = { list: vi.fn(), createPassword, toggle: vi.fn(),
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
  await waitFor(() => expect(createPassword).toHaveBeenCalledTimes(2))
  expect(createPassword.mock.calls[0]![0]).toEqual(createPassword.mock.calls[1]![0])
  expect(createPassword.mock.calls[0]![0].hostKeySha256).toBe(item.hostKeySha256)
  await waitFor(() => expect(onChange).toHaveBeenCalledWith([item]))
})

test('SSH toggle retries with the same revision and request ID', async () => {
  const toggle = vi.fn().mockRejectedValueOnce(new Error('reply lost'))
    .mockResolvedValueOnce({ ...item, enabled: false, revision: 2 })
  const port: PersonalSshPort = { list: vi.fn(), createPassword: vi.fn(), toggle,
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
  const port: PersonalSshPort = { list: vi.fn(), createPassword: vi.fn(), toggle: vi.fn(),
    check: vi.fn(), callList, callStatus: vi.fn(), callCancel: vi.fn() }
  render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByText('Check pending')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(callList).toHaveBeenCalledTimes(2)
  expect(screen.getByText('SSH authentication succeeded')).toBeTruthy()
  expect(screen.queryByText('ssh.authenticate')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(callList).toHaveBeenCalledTimes(2)
})

test('an uncertain admission retries the exact request and cancel never claims success', async () => {
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const check = vi.fn().mockRejectedValueOnce(new Error('reply lost'))
    .mockResolvedValueOnce({ callId, state: 'running' })
  const callCancel = vi.fn(async () => ({ callId, state: 'uncertain' as const }))
  const port: PersonalSshPort = { list: vi.fn(), createPassword: vi.fn(), toggle: vi.fn(), check,
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
  const port: PersonalSshPort = { list: vi.fn(), createPassword: vi.fn(), toggle: vi.fn(),
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
  const port: PersonalSshPort = { list: vi.fn(), createPassword: vi.fn(), toggle: vi.fn(), callList,
    check: vi.fn(), callStatus: vi.fn(), callCancel: vi.fn() }
  const view = render(<PersonalSshPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  await act(async () => { await Promise.resolve() })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(pollSignal).toBeDefined()
  view.unmount()
  expect(pollSignal?.aborted).toBe(true)
})
