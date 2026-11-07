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
  setAvailable: (available: boolean) => void
  setToolDelay: (milliseconds: number) => void
  setToolText: (text: string) => void
  setInstructions: (text: string) => void
  setToolDescription: (text: string) => void
  setSsePadding: (bytes: number) => void
  setListPageCount: (pages: number) => void
  listRequests: string[]
  holdNextRequest: () => { entered: Promise<void>; release: () => void }
  close: () => Promise<void>
}

/** Start a local stateless MCP endpoint exposing one `ping` tool. */
export async function startHttpMcpFixture(options?: { requiredAuthorization: string }): Promise<HttpMcpFixture> {
  const calls: string[] = []
  const listRequests: string[] = []
  const authorization: Array<string | undefined> = []
  let available = true, toolDelayMs = 0
  let toolText = 'pong', instructions = '', description = 'Replies pong.', ssePadding = 0
  let listPages = 1
  let heldRequest: { entered: PromiseWithResolvers<void>; released: PromiseWithResolvers<void> } | undefined
  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions },
    )
    mcp.registerTool('ping', { description, inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
      calls.push('ping')
      if (toolDelayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, toolDelayMs))
      return { content: [{ type: 'text', text: toolText }] }
    })
    if (listPages > 1) mcp.server.setRequestHandler('tools/list', (request) => {
      const page = Number(request.params?.cursor ?? '0')
      listRequests.push(String(page))
      return { tools: [{ name: `ping_${page}`, description, inputSchema: { type: 'object' } }],
        ...page + 1 < listPages ? { nextCursor: String(page + 1) } : {} }
    })
    return mcp
  })
  const handle = toNodeHandler({ async fetch(request, context) {
    let input: unknown
    if (request.method === 'POST') {
      try { input = await request.clone().json() } catch (_error) { /* SDK negotiation also sends empty probe requests. */ }
    }
    const response = await handler.fetch(request, context)
    if (ssePadding === 0 || input === null || typeof input !== 'object' || Reflect.get(input, 'method') !== 'tools/call'
      || !response.headers.get('content-type')?.includes('application/json')) return response
    const data = await response.text(), headers = new Headers(response.headers), encoder = new TextEncoder()
    headers.set('content-type', 'text/event-stream'); headers.delete('content-length')
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (let bytes = 0; bytes < ssePadding; bytes += 68) controller.enqueue(encoder.encode(': ' + 'x'.repeat(64) + '\n\n'))
      controller.enqueue(encoder.encode('data: ' + data + '\n\n')); controller.close()
    } }), { status: response.status, headers })
  } })
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    authorization.push(request.headers.authorization)
    const held = heldRequest
    heldRequest = undefined
    if (held !== undefined) { held.entered.resolve(); await held.released.promise }
    if (options !== undefined && request.headers.authorization !== options.requiredAuthorization) {
      response.writeHead(401).end('Authentication required')
      return
    }
    if (!available) { response.writeHead(503).end('Temporary synthetic outage'); return }
    // The adapter excludes explicit undefined on Node's optional HTTP fields.
    await handle(request as NodeIncomingMessageLike, response)
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
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
    listRequests,
    setAvailable(value) { available = value },
    setToolDelay(milliseconds) { toolDelayMs = milliseconds },
    setToolText(text) { toolText = text },
    setInstructions(text) { instructions = text },
    setToolDescription(text) { description = text },
    setSsePadding(bytes) { ssePadding = bytes },
    setListPageCount(pages) { listPages = pages },
    holdNextRequest() {
      const entered: PromiseWithResolvers<void> = Promise.withResolvers()
      const released: PromiseWithResolvers<void> = Promise.withResolvers()
      heldRequest = { entered, released }
      return { entered: entered.promise, release: () => { released.resolve() } }
    },
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
