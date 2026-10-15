// @vitest-environment jsdom
/** Current native bundle composition with account-scoped MCP and STDIO port substitutes. */
import type {} from '../src/client/index.ts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectorConfiguration, type ConnectorConfigurationProps } from '../src/client/ConnectorConfiguration.tsx'
import { McpMetadataFields } from '../src/client/McpMetadataFields.tsx'
import type { PersonalMcpConnectionPort } from '../src/client/personal-mcp-client.ts'
import type { StdioV2Port } from '../src/client/stdio-v2-api.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const metadataLabels: Readonly<Record<string, string | undefined>> = en
const metadataTranslate: ConnectorConfigurationProps['t'] = (key) => {
  const label = metadataLabels[key]
  if (label === undefined) throw new Error('Missing connector fixture label')
  return label
}

function controlledReaders() {
  const readers: ControlledFileReader[] = []
  class ControlledFileReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    abort = vi.fn()
    readAsDataURL = vi.fn((_file: Blob) => undefined)
    constructor() { readers.push(this) }
  }
  vi.stubGlobal('FileReader', ControlledFileReader)
  return readers
}

it('edits a note, reads inert raster artwork and removes it while retaining the other metadata', () => {
  const readers = controlledReaders(), onChange = vi.fn()
  const view = render(<McpMetadataFields value={undefined} onChange={onChange} t={metadataTranslate} />)
  const note = screen.getByRole('textbox', { name: en.mcpNote })
  expect(note).toHaveProperty('maxLength', 1000)
  fireEvent.change(note, { target: { value: 'Account connector' } })
  expect(onChange).toHaveBeenLastCalledWith({ note: 'Account connector', icon: null })
  const current = { note: 'Account connector', icon: null }
  view.rerender(<McpMetadataFields value={current} onChange={onChange} t={metadataTranslate} />)
  const file = new File(['raster'], 'icon.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText(en.mcpIcon), { target: { files: [file] } })
  const pending = readers[0]!
  expect(pending.readAsDataURL).toHaveBeenCalledWith(file)
  fireEvent.change(screen.getByRole('textbox', { name: en.mcpNote }), { target: { value: 'Edited while reading' } })
  const updated = { note: 'Edited while reading', icon: null }
  view.rerender(<McpMetadataFields value={updated} onChange={onChange} t={metadataTranslate} />)
  pending.result = 'data:image/png;base64,aWNvbg=='
  act(() => { pending.onload?.() })
  const uploaded = { ...updated, icon: pending.result }
  expect(onChange).toHaveBeenLastCalledWith(uploaded)
  view.rerender(<McpMetadataFields value={uploaded} onChange={onChange} t={metadataTranslate} />)
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(uploaded.icon)
  fireEvent.click(screen.getByRole('button', { name: en.mcpRemoveIcon }))
  expect(pending.abort).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenLastCalledWith(updated)
  view.unmount()
  expect(pending.abort).toHaveBeenCalledTimes(2)
})

it('rejects oversized or active artwork before reading and handles an empty selection', () => {
  const readers = controlledReaders(), onChange = vi.fn()
  render(<McpMetadataFields value={undefined} onChange={onChange} t={metadataTranslate} />)
  const upload = screen.getByLabelText(en.mcpIcon)
  fireEvent.change(upload, { target: { files: [] } })
  expect(screen.queryByRole('alert')).toBeNull()
  for (const file of [new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' }),
    new File([new Uint8Array(49_153)], 'large.png', { type: 'image/png' })]) {
    fireEvent.change(upload, { target: { files: [file] } })
    expect(screen.getByRole('alert').textContent).toBe(en.mcpIconInvalid)
  }
  expect(readers).toHaveLength(0)
  expect(onChange).not.toHaveBeenCalled()
})

it('ignores obsolete reader callbacks and clears read or envelope errors after a valid replacement', () => {
  const readers = controlledReaders(), onChange = vi.fn()
  render(<McpMetadataFields value={{ note: 'Keep this note', icon: null }} onChange={onChange} t={metadataTranslate} />)
  const upload = screen.getByLabelText(en.mcpIcon)
  const file = new File(['raster'], 'icon.webp', { type: 'image/webp' })
  fireEvent.change(upload, { target: { files: [file] } })
  fireEvent.change(upload, { target: { files: [file] } })
  const obsolete = readers[0]!, current = readers[1]!
  expect(obsolete.abort).toHaveBeenCalledOnce()
  obsolete.result = 'data:image/webp;base64,aWNvbg=='
  act(() => { obsolete.onload?.(); obsolete.onerror?.() })
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  act(() => { current.onerror?.() })
  expect(screen.getByRole('alert')).toBeTruthy()
  current.result = 'data:image/svg+xml;base64,c3Zn'
  act(() => { current.onload?.() })
  expect(onChange).not.toHaveBeenCalled()
  current.result = 'data:image/webp;base64,aWNvbg=='
  act(() => { current.onload?.() })
  expect(onChange).toHaveBeenLastCalledWith({ note: 'Keep this note', icon: current.result })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('mounts remote MCP and cloud STDIO in the native bundle configuration', async () => {
  const unexpected = async (): Promise<never> => { throw new Error('Unrequested connector mutation') }
  const list = vi.fn<PersonalMcpConnectionPort['list']>(async () => ({ available: false, items: [] }))
  const personalMcp: PersonalMcpConnectionPort = { list, create: unexpected, update: unexpected,
    toggle: unexpected, remove: unexpected, createCheck: unexpected, getCheck: unexpected,
    cancelCheck: unexpected, createDraftCheck: unexpected, getDraftCheck: unexpected, cancelDraftCheck: unexpected }
  const config = vi.fn<StdioV2Port['config']>(async () => ({ formatVersion: 2, available: false }))
  const stdioV2: StdioV2Port = { config, list: unexpected, create: unexpected, update: unexpected,
    toggle: unexpected, remove: unexpected, check: unexpected, receipt: unexpected,
    actions: unexpected, detail: unexpected, cancel: unexpected }
  const snapshot = { ids: [], byId: {}, current: undefined, phase: 'ready' as const }
  const unusedStandardHook = (): never => { throw new Error('Connector fixture does not provide global state') }
  const usePanelInfo: ConnectorConfigurationProps['usePanelInfo'] = selector => selector({ activePanelId: null })
  const standard = {
    usePanelInfo,
    useWorkspaces: unusedStandardHook, useSessions: unusedStandardHook,
    useSessionStatus: unusedStandardHook, useSessionRetainInfo: unusedStandardHook,
  }
  const labels: Readonly<Record<string, string | undefined>> = en
  const props: ConnectorConfigurationProps = { personalMcp, stdioV2, view: 'page',
    ...standard,
    sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } },
    approvalUrl: async () => 'https://platform.test/approval', t: (key) => {
      const label = labels[key]
      if (label === undefined) throw new Error('Missing connector fixture label')
      return label
    } }
  const root = render(<ConnectorConfiguration {...props} />)
  await screen.findByText(en.personalMcpUnavailable)
  await screen.findByText(en.stdioV2Unavailable)
  expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([en.personalMcpTitle])
  fireEvent.change(screen.getByRole('combobox', { name: en.mcpTransport }), { target: { value: 'stdio' } })
  expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([en.stdioV2Title])
  expect(root.container.querySelector('[data-power-evolve-bundle-config]')?.children).toHaveLength(3)
  expect(list).toHaveBeenCalledOnce()
  expect(config).toHaveBeenCalledOnce()
})
