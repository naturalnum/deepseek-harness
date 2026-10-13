/** One short-lived, image-owned MCP process per authorized Runner call. */
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { CallResult, StdioCallInput } from './protocol.ts'

export class StdioFailure extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}

/** The server script is built into the Runner image, never supplied by a browser or Host. */
export class StdioMcpTransport {
  constructor(private readonly serverScript = fileURLToPath(new URL('./stdio-identity-server.js', import.meta.url))) {}

  async call(input: StdioCallInput, signal: AbortSignal): Promise<CallResult> {
    const cancelled = () => signal.aborted
    if (cancelled()) throw new StdioFailure('mcp_cancelled')
    const timeout = AbortSignal.timeout(input.timeoutMs)
    const deadline = AbortSignal.any([signal, timeout])
    const client = new Client({ name: 'power-evolve-connector-runner', version: '0.1.0' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [this.serverScript], cwd: '/tmp', stderr: 'ignore', maxBufferSize: 16_384,
      env: { HOME: '/tmp', PATH: '/usr/bin:/bin', PE_MCP_ACCOUNT_ID: input.accountId } })
    try {
      await client.connect(transport, { signal: deadline, timeout: input.timeoutMs })
      const listed = await client.listTools(undefined, { signal: deadline, timeout: input.timeoutMs })
      const tool = listed.tools.find(value => value.name === 'whoami')
      if (!tool || tool.annotations?.readOnlyHint !== true) throw new StdioFailure('mcp_tool_unavailable')
      const result = await client.callTool({ name: 'whoami', arguments: {} },
        { signal: deadline, timeout: input.timeoutMs })
      if (result.isError) throw new StdioFailure('mcp_tool_error')
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (!text || Buffer.byteLength(text, 'utf8') > input.maxOutputBytes) {
        throw new StdioFailure('mcp_output_limit')
      }
      return { kind: 'mcp.stdio.whoami', text }
    } catch (error) {
      if (error instanceof StdioFailure) throw error
      throw new StdioFailure(cancelled() ? 'mcp_cancelled'
        : timeout.aborted ? 'mcp_timeout' : 'mcp_process_failed')
    } finally { await client.close().catch(() => {}) }
  }
}
