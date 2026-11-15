import { z } from 'zod'
/** Keyless stateless Streamable HTTP MCP fixture for integration tests. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'

/** Running HTTP fixture and the request headers it observed. */
export interface HttpMcpFixture {
  url: string
  calls: string[]
  authorization: Array<string | undefined>
  /** Refuse actual HTTP requests with 503 while the listener remains owned by this fixture. */
  setAvailable: (available: boolean) => void
  /** Select the next real SDK tool reply without changing Client-side execution. */
  setToolText: (text: string) => void
  /** Delay the real SDK tool handler, allowing Client-side timeout and late settlement. */
  setToolDelay: (milliseconds: number) => void
  /** Hold one actual HTTP request until release or physical response closure. */
  holdNextRequest: () => { entered: Promise<void>; release: () => void }
  close: () => Promise<void>
}

/** Start the real stateless MCP SDK endpoint; omission keeps its original available, immediate `pong` reply. */
export async function startHttpMcpFixture(options: {
  rejectToolCalls?: boolean
  requiredAuthorization?: string
} = {}): Promise<HttpMcpFixture> {
  const calls: string[] = []
  const authorization: Array<string | undefined> = []
  let available = true, toolText = 'pong', toolDelay = 0
  const heldRequests = new Set<() => void>()
  let nextRequest: { entered: () => void; resumed: Promise<void>; release: () => void } | undefined
  const handler = createMcpHandler(({ requestInfo }) => {
    const mcp = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    mcp.registerTool('ping', { description: 'Replies pong.', inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
      calls.push('ping')
      if (toolDelay > 0) await new Promise<void>((resolve) => { setTimeout(resolve, toolDelay) })
      if (options.rejectToolCalls) {
        return { isError: true, content: [{ type: 'text', text: `MCP fixture rejected ${requestInfo?.headers.get('authorization')}` }] }
      }
      return { content: [{ type: 'text', text: toolText }] }
    })
    return mcp
  })
  const handle = toNodeHandler(handler)
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    authorization.push(request.headers.authorization)
    if (!available) { response.writeHead(503).end('MCP fixture is temporarily unavailable.'); return }
    if (options.requiredAuthorization !== undefined && request.headers.authorization !== options.requiredAuthorization) {
      response.writeHead(401).end('MCP fixture requires its configured authorization.'); return
    }
    const pending = nextRequest
    if (pending !== undefined) {
      nextRequest = undefined
      response.once('close', pending.release)
      pending.entered()
      try { await pending.resumed }
      finally { response.off('close', pending.release) }
      if (response.destroyed) return
      if (!available) { response.writeHead(503).end('MCP fixture is temporarily unavailable.'); return }
    }
    // The adapter excludes explicit undefined on Node's optional HTTP fields.
    await handle(request as NodeIncomingMessageLike, response)
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      if (response.destroyed) return
      if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)))
      else response.writeHead(500).end(String(error))
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP MCP fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorization,
    calls,
    setAvailable: (value) => { available = value },
    setToolText: (value) => { toolText = value },
    setToolDelay: (value) => { toolDelay = value },
    holdNextRequest: () => {
      if (nextRequest !== undefined) throw new Error('The next HTTP MCP request is already held.')
      const entered = Promise.withResolvers<undefined>(), resumed = Promise.withResolvers<undefined>()
      const release = (): void => { heldRequests.delete(release); resumed.resolve(undefined) }
      heldRequests.add(release)
      nextRequest = { entered: () => entered.resolve(undefined), resumed: resumed.promise, release }
      return { entered: entered.promise, release }
    },
    close: async () => {
      available = false
      for (const release of heldRequests) release()
      await handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
