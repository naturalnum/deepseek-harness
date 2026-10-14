/** Bounded auxiliary native Search egress preserves the provider's original Messages schema and logged input. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { bearer, readJson, sendJson } from '../http.ts'
import { PlatformError } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireModelGrant } from './account-settings.ts'
import type { TaskStore } from './tasks.ts'
import type { ModelProxyConfig } from './model.ts'

const bodySchema = z.object({ model: z.string().min(1).max(100), max_tokens: z.number().int().positive(),
  messages: z.tuple([z.object({ role: z.literal('user'), content: z.tuple([z.object({ type: z.literal('text'), text: z.string() }).strict()]) }).strict()]),
  tools: z.tuple([z.object({ type: z.literal('web_search_20250305'), name: z.literal('web_search'), max_uses: z.number().int().positive() }).strict()]),
}).strict()

/** Forward one native auxiliary request only after its exact original input is durable.
 * @param tasks Current operation, account and native consumption authority.
 * @param config Platform-owned provider address, key and byte/deadline bounds.
 * @param request Original native provider request with a current operation bearer.
 * @param response Native JSON result carrier; disconnect aborts external work.
 * @returns Completion after the bounded original provider result has been consumed and sent.
 */
export async function proxyNativeWebSearch(tasks: TaskStore, config: ModelProxyConfig & { maxUses: number },
  request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = bodySchema.parse(await readJson(request, config.maxRequestBytes))
  if (body.tools[0].max_uses > config.maxUses) throw new PlatformError(400, 'native_search_use_limit')
  await transaction(tasks.pool, async client => {
    const owner = await tasks.executionAuthorized(client, bearer(request))
    await requireModelGrant(client, owner.user_id, body.model, body.max_tokens)
    const records = await client.query<{ event: unknown }>(
      `SELECT event FROM pe_events WHERE session_id=$1 AND event->>'type'='web/deepseek-search-llm-request'
        AND seq>(SELECT COALESCE(max(seq),-1) FROM pe_events WHERE session_id=$1 AND event->>'type'='step/start') ORDER BY seq DESC LIMIT 1`, [owner.id])
    const logged = z.object({ data: z.object({ apiVersion: z.string(), body: bodySchema }) }).parse(records.rows[0]?.event)
    if (!isDeepStrictEqual(logged.data.body, body) || logged.data.apiVersion !== request.headers['anthropic-version']) {
      throw new PlatformError(403, 'native_search_not_authorized')
    }
  })
  const disconnected = new AbortController(), abort = () => { disconnected.abort() }
  response.once('close', abort)
  try {
    const upstream = await fetch(config.url, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(config.timeoutMs)]),
      headers: { 'content-type': 'application/json', accept: 'application/json',
        'anthropic-version': String(request.headers['anthropic-version'] ?? ''), 'x-api-key': config.apiKey },
      body: JSON.stringify(body) })
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel()
      throw new PlatformError(502, `model_http_${upstream.status}`)
    }
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of upstream.body) {
      bytes += chunk.byteLength
      if (bytes > config.maxResponseBytes) throw new PlatformError(502, 'model_output_limit')
      chunks.push(chunk)
    }
    sendJson(response, z.json().parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
  } finally { response.off('close', abort) }
}
