/** Browser client for owner-scoped process MCP metadata and durable call results. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const TOOL = 'mcp__stdio__whoami'
const states = new Set(['accepted', 'preparing', 'ready', 'dispatch-intent', 'running',
  'succeeded', 'failed', 'uncertain'])
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exact = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).sort().join(',') === [...fields].sort().join(',')

export interface StdioMcpConnection { readonly connectionId: string; readonly name: string;
  readonly enabled: boolean; readonly revision: number; readonly toolName: typeof TOOL;
  readonly description: string }
export interface StdioMcpList { readonly available: boolean;
  readonly preset: { readonly toolName: typeof TOOL; readonly description: string };
  readonly items: readonly StdioMcpConnection[] }
export interface StdioMcpCall { readonly callId: string; readonly state: string;
  readonly result?: string; readonly errorCode?: string }

function connection(value: unknown): StdioMcpConnection {
  if (!record(value) || !exact(value, ['connectionId', 'name', 'enabled', 'revision',
    'toolName', 'description']) || typeof value.connectionId !== 'string' || !UUID.test(value.connectionId)
    || typeof value.name !== 'string' || !value.name || value.name.length > 80
    || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1 || value.toolName !== TOOL
    || typeof value.description !== 'string' || value.description.length > 500) {
    throw new Error('Invalid process MCP connection response')
  }
  return { connectionId: value.connectionId, name: value.name, enabled: value.enabled,
    revision: Number(value.revision), toolName: TOOL, description: value.description }
}
function call(value: unknown): StdioMcpCall {
  if (!record(value) || !exact(value, ['callId', 'state',
    ...(value.result === undefined ? [] : ['result']),
    ...(value.errorCode === undefined ? [] : ['errorCode'])])
    || typeof value.callId !== 'string' || !UUID.test(value.callId)
    || typeof value.state !== 'string' || !states.has(value.state)
    || value.result !== undefined && (typeof value.result !== 'string'
      || new TextEncoder().encode(value.result).byteLength > 8192)
    || value.errorCode !== undefined && (typeof value.errorCode !== 'string'
      || !/^[a-z][a-z0-9_]{0,99}$/u.test(value.errorCode))) {
    throw new Error('Invalid process MCP call response')
  }
  return { callId: value.callId, state: value.state,
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }) }
}

export class StdioMcpHttpError extends Error {
  constructor(readonly status: number) { super(`Process MCP request failed: ${status}`) }
}

export interface StdioMcpPort {
  list(signal?: AbortSignal): Promise<StdioMcpList>
  install(input: { readonly requestId: string; readonly name: string }): Promise<StdioMcpConnection>
  toggle(input: { readonly connectionId: string; readonly requestId: string;
    readonly baseRevision: number; readonly enabled: boolean }): Promise<StdioMcpConnection>
  calls(signal?: AbortSignal): Promise<{ readonly items: readonly StdioMcpCall[] }>
  status(callId: string): Promise<StdioMcpCall>
}

/** The browser sends no executable path, environment, command, or credential. */
export class StdioMcpHttpClient implements StdioMcpPort {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}
  private async post(method: string, request: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(`/api/powerEvolve/${method}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new StdioMcpHttpError(response.status)
    return response.json() as Promise<unknown>
  }
  async list(signal?: AbortSignal): Promise<StdioMcpList> {
    const value = await this.post('stdioMcpList', {}, signal)
    if (!record(value) || !exact(value, ['available', 'preset', 'items'])
      || typeof value.available !== 'boolean' || !record(value.preset)
      || !exact(value.preset, ['toolName', 'description'])
      || value.preset.toolName !== TOOL || typeof value.preset.description !== 'string'
      || !Array.isArray(value.items) || value.items.length > 1) {
      throw new Error('Invalid process MCP list response')
    }
    return { available: value.available,
      preset: { toolName: TOOL, description: value.preset.description }, items: value.items.map(connection) }
  }
  async install(input: { readonly requestId: string; readonly name: string }): Promise<StdioMcpConnection> {
    if (!UUID.test(input.requestId) || !input.name.trim() || input.name.length > 80) {
      throw new Error('Invalid process MCP install request')
    }
    return connection(await this.post('stdioMcpInstall', input))
  }
  async toggle(input: { readonly connectionId: string; readonly requestId: string;
    readonly baseRevision: number; readonly enabled: boolean }): Promise<StdioMcpConnection> {
    if (!UUID.test(input.connectionId) || !UUID.test(input.requestId)
      || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1
      || typeof input.enabled !== 'boolean') throw new Error('Invalid process MCP toggle request')
    const result = connection(await this.post('stdioMcpToggle', input))
    if (result.connectionId !== input.connectionId || result.enabled !== input.enabled
      || result.revision <= input.baseRevision) throw new Error('Process MCP toggle response mismatch')
    return result
  }
  async calls(signal?: AbortSignal): Promise<{ readonly items: readonly StdioMcpCall[] }> {
    const value = await this.post('stdioMcpCalls', {}, signal)
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 100) {
      throw new Error('Invalid process MCP calls response')
    }
    return { items: value.items.map(call) }
  }
  async status(callId: string): Promise<StdioMcpCall> {
    if (!UUID.test(callId)) throw new Error('Invalid process MCP call ID')
    const value = call(await this.post('stdioMcpStatus', { callId }))
    if (value.callId !== callId) throw new Error('Process MCP call ID mismatch')
    return value
  }
}
