import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import ExposureService from '../src/root.ts'
import { installActualLlmGuard } from '../src/llm-guard.ts'

class FixtureAdapter extends LlmAdapter {
  calls = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('Loader-mounted exposure and native LLM', () => {
  it('keeps A denial and disposal independent from B with the same provider/model names', async () => {
    const create = () => boot('api-m0-test', fileURLToPath(new URL('./fixtures/root.cordis.yml', import.meta.url)), [], (ctx) => {
      ctx.loader.builtins['api-exposure-m0'] = ExposureService
      ctx.loader.builtins['api-llm-m0'] = LlmRuntime
    })
    const a = await create()
    const b = await create()
    try {
      const adapterA = new FixtureAdapter()
      const adapterB = new FixtureAdapter()
      a.llm.registerAdapter(['same-provider'], adapterA)
      b.llm.registerAdapter(['same-provider'], adapterB)
      const binding = (id: string): AccountBinding => ({
        accountId: brandString<AccountId>(id), epoch: brandString<OwnerEpoch>('1'),
        recipeVersion: 'd08-m0', lifetime: new AbortController().signal,
      })
      installActualLlmGuard(a, binding('a'), () => {}, () => false)
      installActualLlmGuard(b, binding('b'), () => {}, () => true)
      const read = async (stream: AsyncIterable<StreamChunk>) => {
        const chunks: StreamChunk[] = []
        for await (const chunk of stream) chunks.push(chunk)
        return chunks
      }
      const options: GenerateOptions = { provider: 'same-provider', model: 'same-model', messages: [] }
      await expect(read(a.llm.stream(options))).rejects.toMatchObject({ code: 'cloud/model-not-allowed' })
      expect(adapterA.calls).toBe(0)
      expect(await read(b.llm.stream(options))).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
      expect(adapterB.calls).toBe(1)
      const policyA = a.peExposure.policy
      const emptyInventory = { recipeVersion: 'd08-m0', rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [] }
      policyA.audit(emptyInventory)
      b.peExposure.policy.audit(emptyInventory)
      await a.fiber.dispose()
      expect(() => policyA.requireRpc('session/prompt')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
      expect(() => b.peExposure.policy.requireRpc('session/prompt')).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
      await read(b.llm.stream(options))
      expect(adapterB.calls).toBe(2)
    } finally {
      await a.fiber.dispose()
      await b.fiber.dispose()
    }
  })
})
