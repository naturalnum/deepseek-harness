/** Optional public-network probe; never supplies a key or contacts a Cloud Target. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Web from '@deepseek-ai/dsh-web'
import * as Http from '@deepseek-ai/dsh-web-fetch-http'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'

it.skipIf(process.env.WORKER1_LIVE_PUBLIC_PROBE !== '1')('runs native web_fetch against public example.com', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
  await ctx.plugin(Web, { fetchProvider: 'http' }); await ctx.plugin(Http)
  await ctx.plugin(ToolWeb, { search: false })
  const result = await ctx.tools.execute({ callId: ToolCallId('public-probe'), name: 'web_fetch',
    arguments: { url: 'https://example.com/' }, signal: AbortSignal.timeout(15000) })
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result.content)).toContain('Example Domain')
}, 20000)
