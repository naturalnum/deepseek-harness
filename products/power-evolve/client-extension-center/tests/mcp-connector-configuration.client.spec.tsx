// @vitest-environment jsdom
/** Current native bundle composition with account-scoped MCP and STDIO port substitutes. */
import type {} from '../src/client/index.ts'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectorConfiguration, type ConnectorConfigurationProps } from '../src/client/ConnectorConfiguration.tsx'
import type { PersonalMcpConnectionPort } from '../src/client/personal-mcp-client.ts'
import type { StdioV2Port } from '../src/client/stdio-v2-api.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

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
  expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
    .toEqual([en.personalMcpTitle, en.stdioV2Title])
  expect(root.container.querySelector('[data-power-evolve-bundle-config]')?.children).toHaveLength(2)
  expect(list).toHaveBeenCalledOnce()
  expect(config).toHaveBeenCalledOnce()
})
