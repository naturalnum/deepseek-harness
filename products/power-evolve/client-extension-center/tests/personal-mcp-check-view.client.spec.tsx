import { describe, expect, it } from 'vitest'
import type {
  PersonalMcpConnection,
  PersonalMcpConnectionCheck,
} from '../src/client/personal-mcp-client.ts'
import { personalMcpCheckView } from '../src/client/personal-mcp-check-view.ts'
import { en, zh } from '../src/client/locales.ts'

describe('Personal MCP check presentation', () => {
  it('distinguishes pending phases without claiming success', () => {
    expect(personalMcpCheckView(connection(check({ state: 'queued' })))).toMatchObject({
      state: 'queued', label: 'mcpCheckQueued', stale: false,
    })
    expect(personalMcpCheckView(connection(check({ state: 'running' })))).toMatchObject({
      state: 'running', label: 'mcpCheckRunning', stale: false,
    })
  })

  it('treats a successful zero-tool discovery as valid', () => {
    expect(personalMcpCheckView(connection(check({
      state: 'succeeded', discovered_tools: 0,
    })))).toMatchObject({
      state: 'succeeded', label: 'mcpCheckSucceededZero', discoveredTools: 0,
    })
    expect(personalMcpCheckView(connection(check({
      state: 'succeeded', discovered_tools: null,
    })))).toMatchObject({
      state: 'succeeded', label: 'mcpCheckSucceededUnknown', discoveredTools: null,
    })
  })

  it('marks old configuration results stale without changing their actual state', () => {
    expect(personalMcpCheckView(connection(check({
      configuration_revision: 1, state: 'failed', error_code: 'MCP_AUTH_REJECTED',
    }), 2))).toMatchObject({
      state: 'failed', stale: true, label: 'personalMcpCheckFailed', errorLabel: 'mcpCheckErrorAuth',
    })
  })

  it('keeps cancellation and timeout distinct', () => {
    expect(personalMcpCheckView(connection(check({ state: 'canceled', error_code: 'MCP_CANCELED' }))))
      .toMatchObject({ state: 'canceled', label: 'mcpCheckCanceled' })
    expect(personalMcpCheckView(connection(check({ state: 'timed_out', error_code: 'MCP_CONNECT_TIMEOUT' }))))
      .toMatchObject({ state: 'timed_out', label: 'mcpCheckTimedOut' })
  })

  it('shows unsupported tool definitions and directory budgets as check refusals in both languages', () => {
    const cases = [
      ['MCP_SCHEMA_UNSUPPORTED', 'mcpCheckErrorSchemaUnsupported'],
      ['MCP_TASKS_UNSUPPORTED', 'mcpCheckErrorTasksUnsupported'],
      ['MCP_TOOL_SIZE_LIMIT', 'mcpCheckErrorToolSizeLimit'],
      ['MCP_DESCRIPTION_SIZE_LIMIT', 'mcpCheckErrorDescriptionSizeLimit'],
      ['MCP_CATALOG_LIMIT', 'mcpCheckErrorCatalogLimit'],
    ] as const
    for (const [error_code, errorLabel] of cases) {
      const view = personalMcpCheckView(connection(check({ state: 'failed', error_code })))
      expect(view).toMatchObject({ state: 'failed', label: 'personalMcpCheckFailed', errorLabel, stale: false })
      expect(en[errorLabel]).not.toBe('Connection failed')
      expect(zh[errorLabel]).not.toBe('连接失败')
    }
    expect(en.mcpCheckErrorSchemaUnsupported).toBe('The tool JSON Schema is unsupported by this platform')
    expect(zh.mcpCheckErrorSchemaUnsupported).toBe('工具 JSON Schema 超出平台支持范围')
  })
})

function connection(latestCheck: PersonalMcpConnectionCheck, revision = 1): PersonalMcpConnection {
  return {
    connection_id: CONNECTION_ID,
    revision,
    display_name: 'Private MCP',
    server_name: 'mcp_00000000',
    server_url: 'https://mcp.example.test/mcp',
    authentication: { kind: 'none', secret_configured: false },
    enabled: false,
    latest_check: latestCheck,
    created_at: '2026-09-19T10:00:00.000Z',
    updated_at: '2026-09-19T10:00:00.000Z',
  }
}

function check(overrides: Partial<PersonalMcpConnectionCheck>): PersonalMcpConnectionCheck {
  return {
    check_id: 'check-1',
    connection_id: CONNECTION_ID,
    configuration_revision: 1,
    state: 'queued',
    error_code: null,
    discovered_tools: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  }
}

const CONNECTION_ID = '00000000-0000-4000-8000-000000000001'
