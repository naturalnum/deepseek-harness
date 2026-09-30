/** Model egress: validate a current task grant and inject a platform-owned credential. */
import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { bearer, readJson } from '../http.ts'
import { PlatformError, settings } from '../contracts.ts'
import { transaction } from './database.ts'
import type { TaskStore } from './tasks.ts'
import { requireModelGrant } from './account-settings.ts'
import { assertModelToolChanges, assertModelToolDeclarations, McpToolAdmissionError, modelMessageTool } from '../mcp-model-tools.ts'
import { mcpOperationTools } from '../mcp-operation-contracts.ts'

const messageRequest = z.object({
  model: z.string().min(1).max(100), max_tokens: z.number().int().positive(), stream: z.literal(true),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.union([z.string(), z.array(z.json())]) }).strict()).min(1),
  system: z.union([z.string(), z.array(z.json())]).optional(),
  thinking: z.json().optional(), output_config: z.json().optional(),
  temperature: z.number().optional(), stop_sequences: z.array(z.string()).optional(),
  tools: z.array(modelMessageTool).optional(),
}).strict()

/** Operator-owned provider endpoint, credential and per-request transport limits. */
export interface ModelProxyConfig {
  readonly url: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
}

/**
 * Forward admitted Messages declarations and validated additions with bounded output and cancellation.
 * @param tasks Current operation grants and immutable admitted MCP selections.
 * @param config Operator-owned provider transport and credential.
 * @param request Host request carrying its current fenced operation grant.
 * @param response SSE response to the Host, cancelled when it disconnects.
 * @returns Completion after the upstream stream ends or a redacted failure is raised.
 */
export async function proxyModel(
  tasks: TaskStore, config: ModelProxyConfig, request: IncomingMessage, response: ServerResponse,
): Promise<void> {
  const body = messageRequest.parse(await readJson(request, config.maxRequestBytes))
  const beta = await transaction(tasks.pool, async client => {
    const authorized = await tasks.authorized(client, bearer(request))
    const selected = settings.parse(authorized.settings)
    if (body.model !== selected.model || body.max_tokens > selected.maxTokens) throw new PlatformError(403, 'model_not_authorized')
    await requireModelGrant(client, authorized.user_id, selected.model, selected.maxTokens)
    const record = await client.query<{ remote_mcp_selection: unknown }>(
      'SELECT remote_mcp_selection FROM pe_operations WHERE id=$1', [authorized.operation_id])
    const admitted = mcpOperationTools.parse(record.rows[0]!.remote_mcp_selection).map(tool => tool.model)
    try {
      assertModelToolDeclarations(body.tools ?? [], admitted)
      return assertModelToolChanges(body.model, body.tools ?? [], body.messages, body.system)
    }
    catch (error) {
      if (error instanceof McpToolAdmissionError) throw new PlatformError(403, error.code)
      throw error
    }
  })
  const disconnected = new AbortController()
  const abort = () => { disconnected.abort() }
  response.once('close', abort)
  const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(config.timeoutMs)])
  try {
    const upstream = await fetch(config.url, {
      method: 'POST', redirect: 'error', signal,
      headers: {
        ...attributionHeaders(), 'content-type': 'application/json', accept: 'text/event-stream',
        'anthropic-version': '2023-06-01', 'x-api-key': config.apiKey,
        ...beta === undefined ? {} : { 'anthropic-beta': beta },
      },
      body: JSON.stringify(body),
    })
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel()
      throw new PlatformError(502, `model_http_${upstream.status}`)
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    let bytes = 0
    for await (const chunk of upstream.body) {
      bytes += chunk.byteLength
      if (bytes > config.maxResponseBytes) throw new PlatformError(502, 'model_output_limit')
      if (!response.write(chunk)) await once(response, 'drain', { signal })
    }
    response.end()
  } finally {
    response.off('close', abort)
    disconnected.abort()
  }
}
