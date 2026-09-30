import { describe, expect, it } from 'vitest'
import type { PersonalMcpConnection } from '../src/client/personal-mcp-client.ts'
import {
  buildPersonalMcpCreateRequest,
  buildPersonalMcpUpdateRequest,
  emptyPersonalMcpForm,
  matchesPersonalMcpSearch,
  personalMcpFormFromConnection,
  validatePersonalMcpForm,
} from '../src/client/personal-mcp-view.ts'

describe('Personal MCP form semantics', () => {
  it('keeps secrets absent when an edit leaves the write-only field empty', () => {
    const current = connection()
    const request = buildPersonalMcpUpdateRequest(personalMcpFormFromConnection(current), current)

    expect(request).not.toHaveProperty('secrets')
    expect(request).not.toHaveProperty('clear_secret_keys')
  })

  it('uses only the explicit clear key and never an empty or null secret', () => {
    const current = connection()
    const form = { ...personalMcpFormFromConnection(current), clearBearerSecret: true }
    const request = buildPersonalMcpUpdateRequest(form, current)

    expect(request).toMatchObject({ clear_secret_keys: ['bearer_token'] })
    expect(request).not.toHaveProperty('secrets')
    expect(JSON.stringify(request)).not.toContain('null')
  })

  it('preserves explicit clearing in an edit draft and rejects credential control characters', () => {
    const current = connection()
    const form = { ...personalMcpFormFromConnection(current), clearBearerSecret: true }
    expect(buildPersonalMcpCreateRequest(form, current).clear_secret_keys).toEqual(['bearer_token'])
    expect(validatePersonalMcpForm({ ...form, bearerToken: 'fixture\nvalue' }, current)).toBe('bearer-token')
    expect(validatePersonalMcpForm({ ...form, authenticationKind: 'headers',
      headers: [{ id: 'new', name: 'X-API-Key', value: 'fixture\rvalue' }] }, current)).toBe('header-value')
  })

  it('clears an existing bearer secret when authentication changes to none', () => {
    const current = connection()
    const form = { ...personalMcpFormFromConnection(current), authenticationKind: 'none' as const }

    expect(buildPersonalMcpUpdateRequest(form, current)).toMatchObject({
      authentication: { kind: 'none' }, clear_secret_keys: ['bearer_token'],
    })
  })

  it('writes a staged bearer token without also requesting a clear', () => {
    const current = connection()
    const form = {
      ...personalMcpFormFromConnection(current), bearerToken: 'replacement', clearBearerSecret: true,
    }
    const request = buildPersonalMcpUpdateRequest(form, current)

    expect(request).toMatchObject({ secrets: { bearer_token: 'replacement' } })
    expect(request).not.toHaveProperty('clear_secret_keys')
  })

  it('normalizes ordinary fields while preserving token bytes', () => {
    const form = {
      ...emptyPersonalMcpForm(), displayName: '  Private MCP  ',
      serverUrl: ' https://mcp.example.test/mcp ', authenticationKind: 'bearer' as const,
      bearerToken: ' token with spaces ',
    }

    expect(buildPersonalMcpCreateRequest(form)).toEqual({
      display_name: 'Private MCP', server_url: 'https://mcp.example.test/mcp',
      authentication: { kind: 'bearer' }, secrets: { bearer_token: ' token with spaces ' },
      enabled: false,
    })
  })

  it('validates names, URLs, and enabled bearer availability', () => {
    expect(validatePersonalMcpForm({
      ...emptyPersonalMcpForm(), displayName: '\u0000', serverUrl: 'https://mcp.example.test',
    })).toBe('display-name')
    expect(validatePersonalMcpForm({
      ...emptyPersonalMcpForm(), displayName: 'MCP', serverUrl: 'https://user@example.test/mcp',
    })).toBe('server-url')
    expect(validatePersonalMcpForm({
      ...emptyPersonalMcpForm(), displayName: 'MCP', serverUrl: 'https://example.test/mcp',
      authenticationKind: 'bearer', enabled: true,
    })).toBe('bearer-token')
    expect(validatePersonalMcpForm({
      ...personalMcpFormFromConnection(connection()), enabled: true,
    }, connection())).toBeUndefined()
    expect(validatePersonalMcpForm({
      ...emptyPersonalMcpForm(), displayName: 'MCP', serverUrl: 'https://example.test/mcp',
      authenticationKind: 'bearer', bearerToken: '界'.repeat(2731),
    })).toBe('bearer-token')
    expect(validatePersonalMcpForm({
      ...emptyPersonalMcpForm(), displayName: 'MCP', serverUrl: `https://example.test/${'a'.repeat(2028)}`,
    })).toBe('server-url')
    expect(validatePersonalMcpForm({
      ...emptyPersonalMcpForm(), displayName: 'MCP', serverUrl: `https://example.test/${'界'.repeat(300)}`,
    })).toBe('server-url')
  })

  it('searches only real display, stable server, and URL fields', () => {
    const item = connection()
    expect(matchesPersonalMcpSearch(item, 'PRIVATE')).toBe(true)
    expect(matchesPersonalMcpSearch(item, 'mcp_000')).toBe(true)
    expect(matchesPersonalMcpSearch(item, 'example.test')).toBe(true)
    expect(matchesPersonalMcpSearch(item, 'fabricated health')).toBe(false)
  })

  it('serializes headers as a complete replacement without replaying saved values', () => {
    const current: PersonalMcpConnection = {
      ...connection(),
      authentication: { kind: 'headers', secret_configured: true },
      headers: [{ name: 'Authorization', value_configured: true }],
    }
    const form = personalMcpFormFromConnection(current)

    expect(form.headers).toMatchObject([{ name: 'Authorization', value: '' }])
    expect(buildPersonalMcpUpdateRequest(form, current)).toMatchObject({
      authentication: { kind: 'headers' },
      headers: [{ name: 'Authorization' }],
    })
    expect(JSON.stringify(buildPersonalMcpUpdateRequest(form, current))).not.toContain('value_configured')
  })

  it('rejects duplicate or missing header values and maps an empty header set to none', () => {
    const base = {
      ...emptyPersonalMcpForm(), displayName: 'MCP', serverUrl: 'https://example.test/mcp',
      authenticationKind: 'headers' as const,
    }
    expect(validatePersonalMcpForm({
      ...base,
      headers: [
        { id: '1', name: 'Authorization', value: 'one' },
        { id: '2', name: 'authorization', value: 'two' },
      ],
    })).toBe('header-duplicate')
    expect(validatePersonalMcpForm({
      ...base, headers: [{ id: '1', name: 'X-API-Key', value: '' }],
    })).toBe('header-value')
    expect(buildPersonalMcpCreateRequest(base)).toMatchObject({ authentication: { kind: 'none' } })
    expect(buildPersonalMcpCreateRequest(base)).not.toHaveProperty('headers')
  })
})

function connection(): PersonalMcpConnection {
  return {
    connection_id: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    display_name: 'Private MCP',
    server_name: 'mcp_00000000',
    server_url: 'https://mcp.example.test/mcp',
    authentication: { kind: 'bearer', secret_configured: true },
    enabled: false,
    latest_check: null,
    created_at: '2026-09-19T10:00:00.000Z',
    updated_at: '2026-09-19T10:00:00.000Z',
  }
}
