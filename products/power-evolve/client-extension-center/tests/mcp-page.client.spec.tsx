import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FixedMcpPage } from '../src/client/FixedMcpPage.tsx'
import type { FixedMcpConnection, FixedMcpList, FixedMcpPort } from '../src/client/mcp-api.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const item: FixedMcpConnection = { connectionId: 'f76e4521-45b0-4829-91dd-9a205c7ef68c',
  name: 'My whoami', enabled: true, revision: 1, toolName: 'mcp__personal__whoami',
  description: 'Read only identity' }
const data: FixedMcpList = { available: true,
  preset: { toolName: 'mcp__personal__whoami', description: 'Operator endpoint' }, items: [item] }
const t = (key: keyof typeof en) => en[key]

test('fixed MCP page shows personal connection and a bounded text-only whoami result', async () => {
  const check = vi.fn(async () => ({ toolName: 'mcp__personal__whoami' as const,
    result: '<script>window.stolen = true</script>' }))
  const port: FixedMcpPort = { list: vi.fn(), install: vi.fn(), toggle: vi.fn(), check }
  const view = render(<FixedMcpPage data={data} port={port} onChange={vi.fn()} onReload={vi.fn()} t={t} />)
  expect(screen.getByText('Operator endpoint')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Installed' }).getAttribute('disabled')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'My whoami' }))
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  await screen.findByText('<script>window.stolen = true</script>')
  expect(check).toHaveBeenCalledWith(item.connectionId)
  expect(view.container.querySelector('script')).toBeNull()
})

test('install retries the same name and request ID after an uncertain response', async () => {
  const install = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(item)
  const onChange = vi.fn()
  const port: FixedMcpPort = { list: vi.fn(), install, toggle: vi.fn(), check: vi.fn() }
  render(<FixedMcpPage data={{ ...data, items: [] }} port={port} onChange={onChange}
    onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Install connection' }))
  fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'My whoami' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'Install connection' }).at(-1)!)
  await screen.findByText('The install result is uncertain. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry installation' }))
  await waitFor(() => expect(install).toHaveBeenCalledTimes(2))
  expect(install.mock.calls[0]![0]).toEqual(install.mock.calls[1]![0])
  await waitFor(() => expect(onChange).toHaveBeenCalledWith([item]))
})

test('enabled state change uses an exact revision and stable retry', async () => {
  const toggle = vi.fn().mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce({ ...item, enabled: false, revision: 2 })
  const port: FixedMcpPort = { list: vi.fn(), install: vi.fn(), toggle, check: vi.fn() }
  const onChange = vi.fn()
  render(<FixedMcpPage data={data} port={port} onChange={onChange} onReload={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'My whoami' }))
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByText('The enabled state is uncertain. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry this change' }))
  await waitFor(() => expect(toggle).toHaveBeenCalledTimes(2))
  expect(toggle.mock.calls[0]![0]).toEqual(toggle.mock.calls[1]![0])
  expect(toggle.mock.calls[0]![0].baseRevision).toBe(1)
  await waitFor(() => expect(onChange).toHaveBeenCalled())
})
