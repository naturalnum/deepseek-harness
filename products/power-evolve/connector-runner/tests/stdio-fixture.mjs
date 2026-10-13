import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

serveStdio(() => {
  const server = new McpServer({ name: 'stdio-test', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.registerTool('whoami', { inputSchema: z.object({}),
    annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text',
    text: `user:${process.env.PE_MCP_ACCOUNT_ID}` }] }))
  return server
})
