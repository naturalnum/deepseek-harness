const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const TOOL = 'mcp__personal__whoami'

export interface FixedMcpConnection {
  readonly connectionId: string
  readonly name: string
  readonly enabled: boolean
  readonly revision: number
  readonly toolName: typeof TOOL
  readonly description: string
}

export interface FixedMcpList {
  readonly available: boolean
  readonly preset: { readonly toolName: typeof TOOL; readonly description: string }
  readonly items: readonly FixedMcpConnection[]
}

export interface FixedMcpToggle {
  readonly connectionId: string
  readonly requestId: string
  readonly baseRevision: number
  readonly enabled: boolean
}

export interface FixedMcpPort {
  list(signal?: AbortSignal): Promise<FixedMcpList>
  install(input: { readonly requestId: string; readonly name: string }): Promise<FixedMcpConnection>
  toggle(input: FixedMcpToggle): Promise<FixedMcpConnection>
  check(connectionId: string): Promise<{ readonly toolName: typeof TOOL; readonly result: string }>
}

export class FixedMcpHttpError extends Error {
  constructor(readonly status: number) { super(`MCP request failed: ${status}`) }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const boundedDescription = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 500

function connection(value: unknown): FixedMcpConnection {
  if (!record(value) || typeof value.connectionId !== 'string' || !UUID.test(value.connectionId)
    || !bounded(value.name, 80) || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || value.toolName !== TOOL || !boundedDescription(value.description)) {
    throw new Error('Invalid MCP connection response')
  }
  return { connectionId: value.connectionId, name: value.name, enabled: value.enabled,
    revision: Number(value.revision), toolName: TOOL, description: value.description }
}

/** Browser operations address only the operator-fixed whoami preset. */
export class FixedMcpHttpClient implements FixedMcpPort {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  private async post(method: string, request: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${method}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new FixedMcpHttpError(response.status)
    return response.json() as Promise<unknown>
  }

  async list(signal?: AbortSignal): Promise<FixedMcpList> {
    const value = await this.post('mcpList', {}, signal)
    if (!record(value) || typeof value.available !== 'boolean' || !record(value.preset)
      || value.preset.toolName !== TOOL || !boundedDescription(value.preset.description)
      || !Array.isArray(value.items) || value.items.length > 1) throw new Error('Invalid MCP list response')
    const items = value.items.map(connection)
    if (new Set(items.map(item => item.connectionId)).size !== items.length) throw new Error('Invalid MCP list response')
    return { available: value.available, preset: { toolName: TOOL, description: value.preset.description }, items }
  }

  async install(input: { readonly requestId: string; readonly name: string }): Promise<FixedMcpConnection> {
    if (!UUID.test(input.requestId) || !bounded(input.name.trim(), 80)) throw new Error('Invalid MCP install request')
    return connection(await this.post('mcpInstall', input))
  }

  async toggle(input: FixedMcpToggle): Promise<FixedMcpConnection> {
    if (!UUID.test(input.connectionId) || !UUID.test(input.requestId)
      || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1
      || typeof input.enabled !== 'boolean') throw new Error('Invalid MCP toggle request')
    const value = connection(await this.post('mcpToggle', input))
    if (value.connectionId !== input.connectionId || value.enabled !== input.enabled
      || value.revision < input.baseRevision) throw new Error('MCP toggle response mismatch')
    return value
  }

  async check(connectionId: string): Promise<{ readonly toolName: typeof TOOL; readonly result: string }> {
    if (!UUID.test(connectionId)) throw new Error('Invalid MCP connection ID')
    const value = await this.post('mcpCheck', { connectionId })
    if (!record(value) || value.toolName !== TOOL || typeof value.result !== 'string'
      || new TextEncoder().encode(value.result).byteLength > 8192) throw new Error('Invalid MCP check response')
    return { toolName: TOOL, result: value.result }
  }
}
