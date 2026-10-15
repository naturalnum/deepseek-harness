/** Actual native LLM registry consumes runtime-owned metadata, policies and synchronous pricing. */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { deepSeekImageRequestPricing, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { expect, onTestFinished, test } from 'vitest'
import RuntimeScope from '../src/host/scope.ts'
import PlatformPersistence from '../src/host/persistence.ts'
import * as Model from '../src/host/model.ts'

const normal: ResolvedRetryPolicy = { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], initialDelayMs: 300, maxDelayMs: 1200, jitterRatio: 0 }
const always: ResolvedRetryPolicy = { mode: 'always', initialDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.2 }

async function fixture() {
  const ctx = new Context(), root = await mkdtemp(join(tmpdir(), 'pe-native-model-metadata-'))
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const runtimeId = randomUUID(), userId = randomUUID(), token = randomUUID()
  const metadata = { registered: [{ id: 'deepseek-official', name: 'DeepSeek' }], directory: [], retryPolicies: { 'deepseek-official': normal } }
  let mismatch = false, resolveCalls = 0, generation = 1, preparationCalls = 0, providerGate: (() => Promise<unknown>) | undefined
  const failures: unknown[] = []
  const receive = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []; for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Owned peer expected byte chunks')
      chunks.push(chunk)
    }
    expect(req.headers.authorization).toBe(`Bearer ${token}`)
    const input = z.object({ provider: z.string().optional(), model: z.string().optional() })
      .parse(JSON.parse(Buffer.concat(chunks).toString()))
    let output: unknown
    switch (req.url) {
      case '/runtime/user/identity': output = { userId, runtimeId, generation: 1, settings: { model: 'owned', provider: 'deepseek-official', maxTokens: 1000, revision: 1 } }; break
      case '/runtime/models/providers': output = providerGate ? await providerGate() : structuredClone(metadata); break
      case '/runtime/models/resolve': resolveCalls++; output = { provider: input.provider, id: mismatch ? 'wrong-model' : input.model,
        name: 'Owned model', inputModalities: ['text', 'image'], context: { contextWindow: 100_000 }, defaultMaxTokens: 2000,
        reasoning: { defaultEffort: 'custom', efforts: [{ id: 'custom', name: 'Custom' }] }, toolUpdate: 'in-history' }; break
      case '/runtime/models/prepare': preparationCalls++; output = { preparationId: randomUUID(),
        model: { provider: input.provider, id: mismatch ? 'wrong-model' : input.model, name: `Generation ${generation}`,
          context: { contextWindow: generation * 100_000 }, defaultMaxTokens: generation * 2000 }, imagePricing: { kind: 'none' } }; break
      case '/runtime/models/image-pricing': output = { kind: 'deepseek', model: { id: input.model, inputModalities: ['text', 'image'], imagePixelBudget: 'low' } }; break
      default: res.writeHead(404).end(); return
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(output))
  }
  const server = createServer((req, res) => {
    void receive(req, res).catch((error: unknown) => { failures.push(error); res.destroy() })
  })
  onTestFinished(() => { if (failures.length) throw new AggregateError(failures, 'Owned metadata peer failed') })
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() }); server.closeAllConnections()
  }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Owned metadata peer unavailable')
  const tokenFile = join(root, 'runtime-token'); await writeFile(tokenFile, token, { mode: 0o600 })
  await ctx.plugin(RuntimeScope, { platformUrl: `http://127.0.0.1:${address.port}`, runtimeUserId: userId,
    workerId: runtimeId, runtimeTokenFile: tokenFile, workerTokenFile: '', timeoutMs: 5000,
    maxResponseBytes: 1_048_576 }).await()
  for (const plugin of [LlmRuntime, SessionStore, AgentRegistry, SessionProjectionRegistry, PlatformPersistence]) {
    await ctx.plugin(plugin).await()
  }
  await ctx.plugin(Model, { streamIdleTimeoutMs: 5000 }).await()
  return { ctx, metadata, wrongModel() { mismatch = true }, resolveCalls: () => resolveCalls,
    generation(value: number) { generation = value }, preparations: () => preparationCalls,
    gate(value: () => Promise<unknown>) { providerGate = value } }
}

test('registers native route names and exact retry policies without a refresh notification loop', async () => {
  const f = await fixture(); let changes = 0
  f.ctx.on('llm/adapters-updated', () => { changes++ })
  expect(f.ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
  expect(f.ctx.llm.providerRetryPolicy('deepseek-official')).toEqual(normal)
  await f.ctx.nativeModelRoutes.refresh(); expect(changes).toBe(0)
  f.metadata.retryPolicies['deepseek-official'] = always
  await f.ctx.nativeModelRoutes.refresh()
  expect(f.ctx.llm.providerRetryPolicy('deepseek-official')).toEqual(always)
  expect(changes).toBe(1)
})

test('preserves exact native model capabilities and builds pricing with the maintained adapter helper', async () => {
  const f = await fixture(), info = await f.ctx.llm.resolveModelInfo('deepseek-official', 'owned')
  expect(info).toMatchObject({ provider: 'deepseek-official', id: 'owned', context: { contextWindow: 100_000 },
    defaultMaxTokens: 2000, reasoning: { defaultEffort: 'custom' }, toolUpdate: 'in-history' })
  const image: ImageBlock = { type: 'image', attachment: { attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png',
    bytes: 2000, width: 2000, height: 1000 } }
  const prices = f.ctx.llm.imageRequestPricing('deepseek-official', 'owned')?.priceImages([image, { ...image, offloaded: true }])
  expect(prices).toEqual(deepSeekImageRequestPricing(resolveAdapterOptions({ models: [{ id: 'owned', inputModalities: ['text', 'image'], imagePixelBudget: 'low' }] }), 'owned')
    .priceImages([image, { ...image, offloaded: true }]))
  expect(prices?.[0]?.visualTokens).toBeGreaterThan(0)
  expect(prices?.[1]?.visualTokens).toBe(0)
  f.wrongModel()
  await expect(f.ctx.llm.resolveModelInfo('deepseek-official', 'owned')).rejects.toThrow('identity differs')
  expect(f.resolveCalls()).toBe(2)
})

test('missing native retry metadata refuses before replacing the existing routes', async () => {
  const f = await fixture()
  f.gate(async () => ({ ...f.metadata, retryPolicies: {} }))
  await expect(f.ctx.nativeModelRoutes.refresh()).rejects.toThrow('native retry policy')
  expect(f.ctx.llm.listProviders()).toEqual(f.metadata.registered)
  expect(f.ctx.llm.providerRetryPolicy('deepseek-official')).toEqual(normal)
})

test('an older concurrent route refresh cannot replace a newer provider directory', async () => {
  const f = await fixture(), first = Promise.withResolvers<unknown>(), entered = Promise.withResolvers<undefined>()
  let calls = 0
  f.gate(async () => {
    if (++calls === 1) { entered.resolve(undefined); return first.promise }
    return { ...f.metadata, registered: [{ id: 'new-provider', name: 'Newest' }], retryPolicies: { 'new-provider': normal } }
  })
  const old = f.ctx.nativeModelRoutes.refresh(); await entered.promise
  await f.ctx.nativeModelRoutes.refresh()
  first.resolve(f.metadata); await old
  expect(f.ctx.llm.listProviders()).toEqual([{ id: 'new-provider', name: 'Newest' }])
})


test('native preparation captures metadata once and never resolves a newer generation for the same prepared call', async () => {
  const f = await fixture()
  const first = await f.ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'owned' })
  expect(first.context).toEqual({ contextWindow: 100_000 })
  expect(first.config.maxTokens).toBe(2000)
  f.generation(2)
  const next = await f.ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'owned' })
  expect(next.context).toEqual({ contextWindow: 200_000 })
  expect(next.config.maxTokens).toBe(4000)
  expect(first.context).toEqual({ contextWindow: 100_000 })
  expect(f.ctx.llm.imageRequestPricing('deepseek-official', 'owned')).toBeUndefined()
  expect(f.resolveCalls()).toBe(0)
  expect(f.preparations()).toBe(2)
  f.wrongModel()
  await expect(f.ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'owned' })).rejects.toThrow('preparation identity differs')
})

test('disposing the route provider cancels and joins an accepted metadata refresh', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<unknown>()
  f.gate(() => { entered.resolve(undefined); return gate.promise })
  const refresh = f.ctx.nativeModelRoutes.refresh()
  const refused = expect(refresh).rejects.toThrow()
  try { await entered.promise; await f.ctx.fiber.dispose(); await refused }
  finally { gate.resolve(f.metadata) }
})
