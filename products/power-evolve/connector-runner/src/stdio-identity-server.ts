/** Image-owned read-only MCP fixture for the first process connector trial. */
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const accountId = process.env.PE_MCP_ACCOUNT_ID
if (!accountId || !z.uuid().safeParse(accountId).success) throw new Error('Invalid account scope')

serveStdio(() => {
  const server = new McpServer({ name: 'power-evolve-stdio-identity', version: '0.1.0' },
    { capabilities: { tools: {} } })
  server.registerTool('whoami', { description: 'Read the account assigned to this isolated MCP process.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  () => ({ content: [{ type: 'text', text: `user:${accountId}` }] }))
  return server
})
