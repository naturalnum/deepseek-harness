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
  /** Set the real SDK initialize response instructions. */
  setInstructions: (instructions: string) => void
  /** Set the real SDK tool-list description. */
  setToolDescription: (description: string) => void
  /** Prefix actual SSE responses with a comment of this length. */
  setSsePadding: (bytes: number) => void
  /** Select how many distinct tool pages the SDK lists. */
  setListPageCount: (pages: number) => void
  /** Cursors received by the SDK tool-list handler. */
  listRequests: string[]
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
  let instructions = '', toolDescription = 'Replies pong.', ssePadding = 0, listPageCount = 1
  const listRequests: string[] = []
  const heldRequests = new Set<() => void>()
  let nextRequest: { entered: () => void; resumed: Promise<void>; release: () => void } | undefined
  const createServerForRequest: Parameters<typeof createMcpHandler>[0] = ({ requestInfo }) => {
    const mcp = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions },
    )
    mcp.registerTool('ping', { description: toolDescription, inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
      calls.push('ping')
      if (toolDelay > 0) await new Promise<void>((resolve) => { setTimeout(resolve, toolDelay) })
      if (options.rejectToolCalls) {
        return { isError: true, content: [{ type: 'text', text: `MCP fixture rejected ${requestInfo?.headers.get('authorization')}` }] }
      }
      return { content: [{ type: 'text', text: toolText }] }
    })
    mcp.server.setRequestHandler('tools/list', async (request) => {
      const cursor = request.params?.cursor ?? '0', page = Number(cursor)
      if (!Number.isSafeInteger(page) || page < 0 || page >= listPageCount) throw new Error('Invalid fixture tool cursor')
      listRequests.push(cursor)
      return {
        tools: [{ name: listPageCount === 1 ? 'ping' : `ping-${String(page)}`, description: toolDescription,
          inputSchema: { type: 'object', properties: {} } }],
        ...page + 1 < listPageCount ? { nextCursor: String(page + 1) } : {},
      }
    })
    return mcp
  }
  const handler = createMcpHandler(createServerForRequest)
  const sseHandler = createMcpHandler(createServerForRequest, { responseMode: 'sse' })
  const handle = toNodeHandler({ async fetch(request, options) {
    const response = await (ssePadding > 0 ? sseHandler : handler).fetch(request, options)
    if (ssePadding === 0 || response.body === null || !response.headers.get('content-type')?.includes('text/event-stream')) return response
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(': ' + 'x'.repeat(ssePadding) + '\n\n'))
    } }))
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  } })
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
    setInstructions: (value) => { instructions = value },
    setToolDescription: (value) => { toolDescription = value },
    setSsePadding: (value) => { ssePadding = value },
    setListPageCount: (value) => { listPageCount = value },
    listRequests,
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
      await Promise.all([handler.close(), sseHandler.close()])
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
