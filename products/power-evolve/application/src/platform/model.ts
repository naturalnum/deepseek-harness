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

const messageRequest = z.object({
  model: z.string().min(1).max(100), max_tokens: z.number().int().positive(), stream: z.literal(true),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.union([z.string(), z.array(z.json())]) }).strict()).min(1),
  system: z.union([z.string(), z.array(z.json())]).optional(),
  thinking: z.json().optional(), output_config: z.json().optional(),
  temperature: z.number().optional(), stop_sequences: z.array(z.string()).optional(),
  tools: z.array(z.object({
    name: z.enum(['trial_notes_list', 'trial_notes_append', 'cloud_exec', 'desktop_exec',
      'mcp__personal__whoami']),
    description: z.string().max(1000), input_schema: z.record(z.string(), z.json()),
    defer_loading: z.literal(true).optional(),
  }).strict()).max(4).optional(),
}).strict()

export interface ModelProxyConfig {
  readonly url: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
}

/** Forward allowlisted Messages requests, with bounded output and disconnect cancellation. */
export async function proxyModel(
  tasks: TaskStore, config: ModelProxyConfig, request: IncomingMessage, response: ServerResponse,
): Promise<void> {
  const body = messageRequest.parse(await readJson(request, config.maxRequestBytes))
  await transaction(tasks.pool, async client => {
    const authorized = await tasks.authorized(client, bearer(request))
    const selected = settings.parse(authorized.settings)
    if (body.model !== selected.model || body.max_tokens > selected.maxTokens) throw new PlatformError(403, 'model_not_authorized')
    await requireModelGrant(client, authorized.user_id, selected.model, selected.maxTokens)
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
