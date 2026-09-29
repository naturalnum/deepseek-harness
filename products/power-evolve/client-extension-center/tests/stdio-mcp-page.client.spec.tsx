import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { StdioMcpPage } from '../src/client/StdioMcpPage.tsx'
import { en } from '../src/client/locales.ts'
import type { StdioMcpList, StdioMcpPort } from '../src/client/stdio-mcp-api.ts'

afterEach(cleanup)
const t = (key: keyof typeof en) => en[key]
const connection = { connectionId: 'f76e4521-45b0-4829-91dd-9a205c7ef68c',
  name: 'Process identity', enabled: true, revision: 1, toolName: 'mcp__stdio__whoami' as const,
  description: 'Read account' }
const empty: StdioMcpList = { available: true,
  preset: { toolName: 'mcp__stdio__whoami', description: 'Fixed process' }, items: [] }

test('native Plugins detail installs an isolated connection and shows durable call results', async () => {
  const install = vi.fn(async () => connection)
  const toggle = vi.fn(async () => ({ ...connection, enabled: false, revision: 2 }))
  const port: StdioMcpPort = { list: vi.fn(), install, toggle,
    calls: async () => ({ items: [{ callId: connection.connectionId,
      state: 'succeeded', result: 'user:alice' }] }), status: vi.fn() }
  function Page() {
    const [data, setData] = useState(empty)
    return <StdioMcpPage data={data} port={port} t={t}
      onChange={items => { setData(current => ({ ...current, items })) }} />
  }
  render(<Page />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Connection name' }),
    { target: { value: 'Process identity' } })
  fireEvent.click(screen.getByRole('button', { name: 'Install connection' }))
  await waitFor(() => expect(install).toHaveBeenCalledOnce())
  expect(screen.getByText('Process identity')).toBeTruthy()
  expect(await screen.findByText('user:alice')).toBeTruthy()
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(toggle).toHaveBeenCalledOnce())
  expect(screen.getByText('State revision 2')).toBeTruthy()
})

test('uncertain install retries with one stable request ID', async () => {
  const install = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(connection)
  const port: StdioMcpPort = { list: vi.fn(), install, toggle: vi.fn(),
    calls: async () => ({ items: [] }), status: vi.fn() }
  render(<StdioMcpPage data={empty} port={port} t={t} onChange={vi.fn()} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Connection name' }),
    { target: { value: 'Process identity' } })
  fireEvent.click(screen.getByRole('button', { name: 'Install connection' }))
  await screen.findByText('The install result is uncertain. Retry uses the same request ID.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry installation' }))
  await waitFor(() => expect(install).toHaveBeenCalledTimes(2))
  expect(install.mock.calls[0]![0]).toEqual(install.mock.calls[1]![0])
})
