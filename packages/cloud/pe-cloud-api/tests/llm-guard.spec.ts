import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { installActualLlmGuard } from '../src/llm-guard.ts'

class CountingAdapter extends LlmAdapter {
  calls = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function consume(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* Drive the real native dispatch. */ }
}

describe('actual native LLM guard', () => {
  it('guards ordinary and prepared streams, rechecks dispatch-time allowlist and preserves frozen input', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CountingAdapter()
    ctx.llm.registerAdapter(['fixture'], adapter)
    const lifetime = new AbortController()
    const binding = {
      accountId: 'account-a', epoch: '1', recipeVersion: 'd08-m0', lifetime: lifetime.signal,
    } as AccountBinding
    let allowed = true
    let checks = 0
    const dispose = installActualLlmGuard(ctx, binding, (actual) => {
      expect(actual).toBe(binding)
      checks++
    }, (provider, model) => allowed && provider === 'fixture' && model === 'approved')
    const options: GenerateOptions = { provider: 'fixture', model: 'approved', messages: [] }
    Object.freeze(options.messages)
    Object.freeze(options)
    await consume(ctx.llm.stream(options))
    expect(adapter.calls).toBe(1)
    const prepared = await ctx.llm.prepareCall({ provider: 'fixture', model: 'approved' })
    allowed = false
    await expect(consume(prepared.stream(options))).rejects.toMatchObject({ code: 'cloud/model-not-allowed' })
    expect(adapter.calls).toBe(1)
    expect(checks).toBe(2)
    allowed = true
    lifetime.abort()
    await expect(consume(ctx.llm.stream(options))).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    expect(adapter.calls).toBe(1)
    dispose()
    await consume(ctx.llm.stream(options))
    expect(adapter.calls).toBe(2)
    await ctx.fiber.dispose()
  })

  it('preserves runtime admission failures and never calls the adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CountingAdapter()
    ctx.llm.registerAdapter(['fixture'], adapter)
    const failure = new Error('runtime closed admission')
    const binding = { accountId: 'a', epoch: '2', recipeVersion: 'd08-m0', lifetime: new AbortController().signal } as AccountBinding
    installActualLlmGuard(ctx, binding, () => { throw failure }, () => true)
    await expect(consume(ctx.llm.stream({ provider: 'fixture', model: 'approved', messages: [] }))).rejects.toBe(failure)
    expect(adapter.calls).toBe(0)
    await ctx.fiber.dispose()
  })
})
