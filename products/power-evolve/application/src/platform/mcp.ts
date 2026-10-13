/** One operator-owned remote MCP preset, installed and enabled independently per user. */
import { createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Pool } from 'pg'
import { z } from 'zod'
import { executionTarget, mcpSelection, PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import type { TaskStore } from './tasks.ts'

const TOOL = 'whoami'
const TOOL_NAME = 'mcp__personal__whoami'
const MAX_RESPONSE_BYTES = 65_536
const selections = z.array(mcpSelection).max(1)
type ConnectionRow = { id: string
  user_id: string
  install_request_id: string
  name: string
  enabled: boolean
  revision: number }

function writtenConnection(row: ConnectionRow | undefined): ConnectionRow {
  if (!row) throw new PlatformError(503, 'mcp_connection_write_failed')
  return row
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/** No user-supplied URL, tool name, headers, or bearer enters this service. */
export class PersonalMcpService {
  private readonly endpoint: string

  constructor(private readonly tasks: TaskStore, endpoint: string, private readonly bearer: string,
    private readonly timeoutMs: number) {
    if (!endpoint) { this.endpoint = ''; return }
    const url = new URL(endpoint)
    const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !loopback)
      || !url.pathname || bearer.length < 24) {
      throw new Error('MCP preset requires a fixed HTTPS or loopback endpoint and platform-owned bearer')
    }
    this.endpoint = url.href
  }

  private get pool(): Pool { return this.tasks.pool }
  private requireAvailable(): void { if (!this.endpoint) throw new PlatformError(503, 'mcp_unavailable') }

  private present(row: ConnectionRow) {
    return { connectionId: row.id, name: row.name, enabled: row.enabled, revision: row.revision,
      toolName: TOOL_NAME, description: '读取当前账户标识（只读）' }
  }

  async list(user: Identity) {
    const rows = await this.pool.query<ConnectionRow>('SELECT * FROM pe_mcp_connections WHERE user_id=$1', [user.userId])
    return { available: !!this.endpoint,
      preset: { toolName: TOOL_NAME, description: '读取当前账户标识（只读）' },
      items: rows.rows.map(row => this.present(row)) }
  }

  /** One installation per user. Identical request ID and name recover the original item. */
  async install(user: Identity, requestId: string, name: string) {
    return transaction(this.pool, async (client) => {
      const owned = await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      if (!owned.rowCount) throw new PlatformError(401, 'unauthorized')
      const existing = await client.query<ConnectionRow>('SELECT * FROM pe_mcp_connections WHERE user_id=$1', [user.userId])
      const row = existing.rows[0]
      if (row) {
        if (row.install_request_id === requestId && row.name === name) {
          return this.present({ ...row, enabled: true, revision: 1 })
        }
        throw new PlatformError(409, row.install_request_id === requestId ? 'request_id_conflict' : 'mcp_already_installed')
      }
      this.requireAvailable()
      const inserted = await client.query<ConnectionRow>(
        'INSERT INTO pe_mcp_connections(id,user_id,install_request_id,name) VALUES($1,$2,$3,$4) RETURNING *',
        [requestId, user.userId, requestId, name])
      return this.present(writtenConnection(inserted.rows[0]))
    })
  }

  /** Revisioned, idempotent enablement with a durable original result. */
  async toggle(user: Identity, connectionId: string, requestId: string, baseRevision: number, enabled: boolean) {
    const fingerprint = digest({ connectionId, baseRevision, enabled })
    return transaction(this.pool, async (client) => {
      const owned = await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId])
      if (!owned.rowCount) throw new PlatformError(401, 'unauthorized')
      const prior = await client.query<{ request_digest: string; result: ReturnType<PersonalMcpService['present']> }>(
        'SELECT request_digest,result FROM pe_mcp_updates WHERE user_id=$1 AND request_id=$2', [user.userId, requestId])
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== fingerprint) throw new PlatformError(409, 'request_id_conflict')
        return prior.rows[0].result
      }
      const current = await client.query<ConnectionRow>(
        'SELECT * FROM pe_mcp_connections WHERE id=$1 AND user_id=$2 FOR UPDATE', [connectionId, user.userId])
      const row = current.rows[0]
      if (!row) throw new PlatformError(404, 'mcp_connection_not_found')
      if (row.revision !== baseRevision) throw new PlatformError(409, 'revision_conflict')
      if (enabled) this.requireAvailable()
      const updated = await client.query<ConnectionRow>(
        'UPDATE pe_mcp_connections SET enabled=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *',
        [connectionId, user.userId, enabled])
      const result = this.present(writtenConnection(updated.rows[0]))
      await client.query(
        'INSERT INTO pe_mcp_updates(user_id,request_id,connection_id,request_digest,result) VALUES($1,$2,$3,$4,$5)',
        [user.userId, requestId, connectionId, fingerprint, result])
      return result
    })
  }

  /** A direct, bounded read-only check requires current user ownership and enablement. */
  async check(user: Identity, connectionId: string) {
    this.requireAvailable()
    return transaction(this.pool, async (client) => {
      const current = await client.query<ConnectionRow>(
        'SELECT * FROM pe_mcp_connections WHERE id=$1 AND user_id=$2 AND enabled=true FOR SHARE',
        [connectionId, user.userId])
      if (!current.rows[0]) throw new PlatformError(404, 'mcp_connection_not_found')
      return { toolName: TOOL_NAME, result: await this.invoke(user.userId) }
    })
  }

  /** The exact admitted Operation version and live connection must both authorize egress. */
  async call(token: string, connectionId: string, revision: number) {
    this.requireAvailable()
    return transaction(this.pool, async (client) => {
      const grant = await this.tasks.authorized(client, token)
      executionTarget.parse(grant.execution_target)
      const operation = await client.query<{ mcp_selection: unknown }>(
        'SELECT mcp_selection FROM pe_operations WHERE id=$1', [grant.operation_id])
      const pinned = selections.parse(operation.rows[0]?.mcp_selection).some(item =>
        item.connectionId === connectionId && item.revision === revision)
      if (!pinned) throw new PlatformError(403, 'mcp_not_in_operation')
      const current = await client.query<ConnectionRow>(
        `SELECT * FROM pe_mcp_connections WHERE id=$1 AND user_id=$2
         AND enabled=true AND revision=$3 FOR SHARE`, [connectionId, grant.user_id, revision])
      if (!current.rows[0]) throw new PlatformError(403, 'mcp_connection_revoked')
      return { toolName: TOOL_NAME, result: await this.invoke(grant.user_id) }
    })
  }

  private async invoke(userId: string): Promise<string> {
    const deadline = AbortSignal.timeout(this.timeoutMs)
    const client = new Client({ name: 'power-evolve-platform', version: '0.1.0' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint), {
      requestInit: { redirect: 'error', headers: { Authorization: `Bearer ${this.bearer}`,
        'x-power-evolve-user': userId } },
      fetch: async (input, init) => {
        const actual = input instanceof Request ? input.url : String(input)
        if (new URL(actual).href !== this.endpoint) throw new PlatformError(502, 'mcp_endpoint_changed')
        const response = await fetch(input, { ...init, redirect: 'error', signal: deadline })
        if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
          await response.body?.cancel()
          throw new PlatformError(502, 'mcp_response_limit')
        }
        if (!response.body || response.status === 204 || response.status === 304) return response
        let bytes = 0
        const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength
            if (bytes > MAX_RESPONSE_BYTES) throw new PlatformError(502, 'mcp_response_limit')
            controller.enqueue(chunk)
          },
        }))
        return new Response(bounded, { status: response.status, statusText: response.statusText,
          headers: response.headers })
      },
    })
    try {
      await client.connect(transport, { signal: deadline, timeout: this.timeoutMs })
      const tools = await client.listTools(undefined, { signal: deadline, timeout: this.timeoutMs })
      const offered = tools.tools.find(tool => tool.name === TOOL)
      if (!offered || offered.annotations?.readOnlyHint !== true) {
        throw new PlatformError(502, 'mcp_tool_unavailable')
      }
      const result = await client.callTool({ name: TOOL, arguments: { accountId: userId } },
        { signal: deadline, timeout: this.timeoutMs })
      if (result.isError) throw new PlatformError(502, 'mcp_tool_error')
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (!text || Buffer.byteLength(text, 'utf8') > 8192) throw new PlatformError(502, 'mcp_response_limit')
      return text
    } catch (error) {
      if (error instanceof PlatformError) throw error
      throw new PlatformError(deadline.aborted ? 504 : 502,
        deadline.aborted ? 'mcp_timeout' : 'mcp_connection_failed')
    } finally { await client.close().catch(() => {}) }
  }
}
