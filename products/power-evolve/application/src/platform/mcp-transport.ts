/** Generic remote MCP over SDK 2.0 and operator-controlled HTTP sockets; persistence stays with callers. */
import { Client, StreamableHTTPClientTransport, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/client'
import { McpNetworkOperation, McpTransportError, McpDispatchRejected, validateMcpBudgets, validateMcpHeaders,
  type McpNetworkPolicy, type McpTransportBudgets } from './mcp-network.ts'

export { McpTransportError, McpDispatchRejected, type McpTransportErrorCode, type McpNetworkPolicy,
  type McpInternalException, type McpTransportBudgets } from './mcp-network.ts'

/** Private endpoint and credentials are consumed only in Platform memory. */
export interface McpTransportTarget {
  endpoint: string
  headers: Readonly<Record<string, string>>
}

/** Every request has its own client, signal, validated limits, and privileged network policy. */
export interface McpTransportOptions {
  signal: AbortSignal
  budgets: McpTransportBudgets
  networkPolicy: McpNetworkPolicy
}

/** The outer layer verifies the current full directory against the accepted immutable selection. */
export interface McpDispatchPreflight {
  toolName: string
  catalog: ListToolsResult
}

/** Commit one-use intent here. Only McpDispatchRejected certifies no intent; other throws are uncertain. */
export interface McpCallOptions extends McpTransportOptions {
  onBeforeDispatch: (preflight: McpDispatchPreflight, signal: AbortSignal) => Promise<void>
}

/** Frozen original tool name and JSON arguments; annotations never grant permission. */
export interface McpToolCall {
  name: string
  arguments?: Record<string, unknown>
}

async function directory(client: Client, operation: McpNetworkOperation): Promise<ListToolsResult> {
  if (!client.getServerCapabilities()?.tools) return { tools: [] }
  let catalog: ListToolsResult | undefined
  let cursor: string | undefined
  const cursors = new Set<string>(), names = new Set<string>()
  for (let pageNumber = 0; pageNumber < operation.budgets.maxPages; pageNumber++) {
    operation.check()
    // Public request preserves raw tools; listTools() can silently filter modern header declarations.
    const page = await client.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
      { signal: operation.signal, timeout: operation.budgets.timeoutMs })
    for (const tool of page.tools) {
      if (names.has(tool.name)) throw new McpTransportError('invalid_catalog', false)
      names.add(tool.name)
    }
    if (catalog === undefined) catalog = { ...page, tools: [...page.tools] }
    else catalog.tools.push(...page.tools)
    delete catalog.nextCursor
    if (catalog.tools.length > operation.budgets.maxTools
      || Buffer.byteLength(JSON.stringify(catalog)) > operation.budgets.maxCatalogBytes) {
      throw new McpTransportError('catalog_limit', false)
    }
    cursor = page.nextCursor
    if (cursor === undefined) return catalog
    if (cursors.has(cursor)) throw new McpTransportError('invalid_catalog', false)
    cursors.add(cursor)
  }
  throw new McpTransportError('catalog_limit', false)
}

async function usingClient<T>(target: McpTransportTarget, options: McpTransportOptions,
  beforeCall: (operation: McpNetworkOperation) => Promise<void>,
  execute: (client: Client, operation: McpNetworkOperation) => Promise<T>): Promise<T> {
  const budgets = validateMcpBudgets(options.budgets)
  const headers = validateMcpHeaders(target.headers, budgets)
  const endpoint = target.endpoint
  const operation = new McpNetworkOperation(budgets, options.signal)
  const client = new Client({ name: 'power-evolve-platform', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  let transport: StreamableHTTPClientTransport | undefined
  try {
    return await operation.bounded((async () => {
      const controlled = await operation.fetchFor(endpoint, options.networkPolicy, () => beforeCall(operation))
      operation.check()
      transport = new StreamableHTTPClientTransport(controlled.url, {
        fetch: controlled.fetch, requestInit: { headers, redirect: 'error' },
        onInsufficientScope: 'throw', maxStepUpRetries: 0,
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1,
          maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 },
      })
      await client.connect(transport, { signal: operation.signal, timeout: budgets.timeoutMs })
      client.onerror = error => operation.fail(error instanceof McpTransportError ? error.code : 'protocol_error')
      return execute(client, operation)
    })())
  } catch (error) { throw operation.error(error) }
  finally {
    // Termination is best effort within the remaining operation budget; it cannot replace a known result.
    if (transport?.sessionId && !operation.signal.aborted) {
      try { await operation.bounded(transport.terminateSession()) } catch (error) {
        // Remote session deletion failed; local close below still owns and closes every socket.
      }
    }
    try { await client.close() }
    finally { await operation.dispose() }
  }
}

/** Discover all raw pages using a fresh SDK client; an empty directory is valid.
 * @param target Platform-only endpoint and authentication headers.
 * @param options Cancellation, complete operation limits, and operator network policy.
 * @returns Original MCP tools and first-page metadata, with pagination fully consumed.
 */
export async function discoverMcp(target: McpTransportTarget, options: McpTransportOptions): Promise<ListToolsResult> {
  return usingClient(target, options, async () => { throw new McpTransportError('dispatch_replay_denied', false) },
    directory)
}

/** Call one named tool once after current discovery and a durable outer-layer permission gate.
 * @param target Private Platform endpoint and headers.
 * @param call Original MCP tool name and frozen JSON arguments.
 * @param options onBeforeDispatch commits permission immediately before the sole tools/call POST.
 * @returns The SDK's original CallToolResult, including isError and all content blocks.
 */
export async function callMcp(target: McpTransportTarget, call: McpToolCall,
  options: McpCallOptions): Promise<CallToolResult> {
  const encoded = JSON.stringify(call)
  if (Buffer.byteLength(encoded) > options.budgets.maxRequestBytes) throw new McpTransportError('request_limit', false)
  const frozen: McpToolCall = JSON.parse(encoded)
  let catalog: ListToolsResult | undefined
  return usingClient(target, options, async operation => {
    if (!catalog) throw new McpTransportError('invalid_catalog', false)
    // If cancellation wins while PG is committing, the caller must conservatively treat the intent as issued.
    operation.dispatched = true
    try { await options.onBeforeDispatch({ toolName: frozen.name, catalog }, operation.signal) }
    catch (error) {
      if (error instanceof McpDispatchRejected) {
        operation.dispatched = false
        throw new McpTransportError('dispatch_rejected', false)
      }
      throw new McpTransportError('callback_uncertain', true)
    }
  }, async (client, operation) => {
    catalog = await directory(client, operation)
    if (!catalog.tools.some(tool => tool.name === frozen.name)) throw new McpTransportError('tool_not_found', false)
    // Client.callTool() has header-mismatch retries. request() uses the SDK codec without those retries.
    return client.request({ method: 'tools/call', params: { ...frozen } },
      { signal: operation.signal, timeout: operation.budgets.timeoutMs })
  })
}
