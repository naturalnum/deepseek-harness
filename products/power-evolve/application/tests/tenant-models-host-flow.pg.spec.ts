/** Real Platform CLI and Host HTTP preserve native model forms and direct, owner-scoped key intake. */
import { randomUUID } from 'node:crypto'
import { request as httpRequest, createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { modelCredentialReceipt, modelCredentialTicket } from '@power-evolve/contracts/model-settings'
import { expect, test } from 'vitest'
import { z } from 'zod'
import RuntimeScope from '../src/host/scope.ts'
import * as Host from '../src/host/index.ts'
import { installNativeRemote } from '../src/host/native-remote.ts'
import { BrowserAgentAuth } from '../src/host/browser-auth.ts'
import { inferThroughNativeHost } from './tenant-model-inference.ts'
import { sourcePlatformHttpFixture, sourceHttpTestTimeout } from './source-platform-http-fixture.ts'

const publicOrigin = 'http://127.0.0.1:9'
const rpcReply = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.unknown().optional() }).loose()
const nativeReply = z.object({ type: z.literal('server-response'), result: rpcReply }).loose()
const namespaceView = z.object({ ns: z.string(), revision: z.number(), value: z.record(z.string(), z.unknown()) }).loose()
const credentialStates = z.record(z.string(), z.object({ configured: z.boolean(), writable: z.boolean() }).loose())

async function host(platformUrl: string, root: string, product: boolean) {
  const ctx = new Context(), tokenFile = join(root, randomUUID())
  await writeFile(tokenFile, randomUUID(), { mode: 0o600 })
  try {
    await ctx.plugin(RuntimeScope, { platformUrl, workerId: randomUUID(), workerTokenFile: tokenFile,
      timeoutMs: 5000, maxResponseBytes: 4_194_304 }).await()
    for (const plugin of [AgentRegistry, SessionStore, TypertRegistry, TypertGateway]) await ctx.plugin(plugin).await()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
    if (product) await Host.apply(ctx, Host.Config({ origin: publicOrigin, platformOrigin: platformUrl,
      concurrency: 1, pollMs: 50, renewMs: 1000, operationTimeoutMs: 10_000,
      maxRequestBytes: 1_048_576, maxStreams: 2, nativeRuntimeRouting: true,
      legacyImageCacheRoot: join(root, 'image-cache'), readyFile: join(root, 'host-ready') }))
    else installNativeRemote(ctx, new BrowserAgentAuth(publicOrigin, platformUrl, ctx.powerEvolveRuntime), publicOrigin,
      50, 1_048_576, 2, [], { maxGenerationMs: 10_000, maxGenerationItems: 100, maxGenerationBytes: 1_048_576 }, 5000)
    return { ctx, url: `http://127.0.0.1:${ctx.webServer.port}` }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}

function json(url: string, token: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', signal: AbortSignal.timeout(5000), headers: {
      authorization: `Bearer ${token}`, origin: publicOrigin, host: '127.0.0.1:9', 'content-type': 'application/json',
    } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => {
        try {
          const received: unknown = JSON.parse(Buffer.concat(chunks).toString())
          if (response.statusCode !== 200) throw new Error('Owned Host HTTP request refused: ' +
            JSON.stringify({ status: response.statusCode, route: new URL(url).pathname, response: received }))
          resolve(received)
        } catch (error) { reject(error instanceof Error ? error : new Error('Owned Host response decoding failed', { cause: error })) }
      })
    })
    request.on('error', reject)
    request.end(JSON.stringify(body))
  })
}

function native(url: string, token: string, method: string, args: object = {}) {
  return json(`${url}/native/api/${method}`, token, { type: 'client-request', rpcId: randomUUID(), method, payload: { args } })
    .then(value => nativeReply.parse(value).result)
}
function product(url: string, token: string, method: string, request: object) {
  return json(`${url}/api/powerEvolve/${method}`, token, { request })
}

function value(result: z.infer<typeof rpcReply>): unknown { expect(result.ok).toBe(true); return result.value }

function modelSection(provider: string, model: string, baseURL: string) {
  return { providers: { [provider]: { api: 'openai-completions', baseURL, apiKeyEnv: 'OWNED_SHARED_REF',
    models: [{ id: model, name: model, contextWindow: 16_000, maxTokens: 2000 }] } } }
}

test('real native forms and Host metadata isolate two accounts while direct key bytes reach only Platform', async (lifecycle) => {
  const root = await mkdtemp(join(tmpdir(), 'pe-tenant-models-host-'))
  lifecycle.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const peerCalls: { authorization: string | undefined; body: unknown }[] = [], peerFailures: unknown[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) { if (!Buffer.isBuffer(chunk)) throw new Error('Owned model peer expects bytes'); chunks.push(chunk) }
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      peerCalls.push({ authorization: request.headers.authorization, body })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hello' }, index: 0, finish_reason: null }] }) + '\n\n')
      response.write('data: ' + JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\n')
      response.end('data: [DONE]\n\n')
    })().catch((error: unknown) => { peerFailures.push(error); response.destroy() })
  })
  lifecycle.onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() }); server.closeAllConnections()
    })
    if (peerFailures.length) throw new AggregateError(peerFailures, 'Owned native model peer failed')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned model peer address unavailable')
  const peerOrigin = `http://127.0.0.1:${address.port}`
  const receipt = await sourcePlatformHttpFixture(async (f) => {
    const productHost = await host(f.url, root, true), nativeHost = await host(f.url, root, false)
    try {
      const seen: unknown[] = []
      const call = productHost.ctx.powerEvolveRuntime.call.bind(productHost.ctx.powerEvolveRuntime)
      productHost.ctx.powerEvolveRuntime.call = (path, token, input, signal) => {
        seen.push({ path, input }); return call(path, token, input, signal)
      }
      const alice = f.actors.alice.agent, bob = f.actors.bob.agent
      const describe = z.object({ writable: z.boolean(), namespaces: z.array(namespaceView) }).loose()
      const initial = describe.parse(value(await native(nativeHost.url, alice, 'settings/describe')))
      expect(initial.writable).toBe(true)
      expect(initial.namespaces.filter(row => ['llm-pi-ai', 'llm-deepseek'].includes(row.ns))).toHaveLength(2)
      for (const [token, provider, model] of [[alice, 'alice-route', 'alice-model'], [bob, 'bob-route', 'bob-model']] as const) {
        const revision = initial.namespaces.find(row => row.ns === 'llm-pi-ai')?.revision
        expect(revision).toBe(1)
        const written = namespaceView.parse(value(await native(nativeHost.url, token, 'settings/replace',
          { ns: 'llm-pi-ai', section: modelSection(provider, model, peerOrigin), expectedRevision: revision })))
        expect(written.revision).toBe(2)
        expect(written.value).toMatchObject(modelSection(provider, model, peerOrigin))
      }
      const stale = await native(nativeHost.url, alice, 'settings/replace', { ns: 'llm-pi-ai', section: {}, expectedRevision: 1 })
      expect(stale).toMatchObject({ ok: false, error: { code: 'settings/conflict' } })
      const directory = z.array(z.object({ provider: z.string() }).loose()).parse(
        value(await native(nativeHost.url, alice, 'llm/listConfigurableProviders')))
      const refs = [...new Set([...directory.map(row => `${row.provider.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`),
        'DEEPSEEK_API_KEY', 'OWNED_SHARED_REF'])]
      const states = credentialStates.parse(value(await native(nativeHost.url, alice, 'credentials/describe', { refs })))
      expect(Object.keys(states)).toHaveLength(refs.length)
      expect(states.OWNED_SHARED_REF).toEqual({ configured: false, writable: true })
      const keys = ['owned-alice-secret', 'owned-bob-secret']
      let aliceRequest = ''
      for (const [index, token] of [alice, bob].entries()) {
        const key = keys[index]; if (key === undefined) throw new Error('Owned key fixture missing')
        const requestId = randomUUID(); if (index === 0) aliceRequest = requestId
        const ticket = modelCredentialTicket.parse(await product(productHost.url, token, 'modelCredentialTicket',
          { requestId, ref: 'OWNED_SHARED_REF', sizeBytes: Buffer.byteLength(key) }))
        expect(new URL(ticket.uploadUrl).origin).toBe(f.url)
        const uploaded = await f.binaryHttp('/model-credentials/upload', Buffer.from(key),
          { token: ticket.ticket, origin: publicOrigin, contentType: 'application/octet-stream' })
        expect(uploaded.status).toBe(201)
        expect(modelCredentialReceipt.parse(JSON.parse(uploaded.bytes.toString()))).toEqual({ saved: true })
        expect(modelCredentialReceipt.parse(await product(productHost.url, token, 'modelCredentialReceipt', { requestId })))
          .toEqual({ saved: true })
        expect((await f.binaryHttp('/model-credentials/upload', Buffer.from(key),
          { token: ticket.ticket, origin: publicOrigin, contentType: 'application/octet-stream' })).status).toBe(401)
      }
      const foreign = await product(productHost.url, bob, 'modelCredentialReceipt', { requestId: aliceRequest })
      expect(modelCredentialReceipt.parse(foreign)).toEqual({ saved: false })
      expect(JSON.stringify(seen)).not.toContain(keys[0]); expect(JSON.stringify(seen)).not.toContain(keys[1])
      const encrypted = await f.pool.query<{ sealed: Buffer }>('SELECT sealed FROM pe_tenant_model_credentials')
      expect(encrypted.rows).toHaveLength(2)
      for (const row of encrypted.rows) for (const key of keys) expect(row.sealed.includes(Buffer.from(key))).toBe(false)
      const catalog = z.object({ groups: z.array(z.object({ id: z.string(),
        models: z.array(z.object({ id: z.string() }).loose()) }).loose()) }).loose()
      const a = catalog.parse(value(await native(nativeHost.url, alice, 'session/modelCatalog')))
      const b = catalog.parse(value(await native(nativeHost.url, bob, 'session/modelCatalog')))
      expect(a.groups.find(group => group.id === 'alice-route')?.models).toMatchObject([{ id: 'alice-model' }])
      expect(a.groups.some(group => group.id === 'bob-route')).toBe(false)
      expect(b.groups.find(group => group.id === 'bob-route')?.models).toMatchObject([{ id: 'bob-model' }])
      expect(b.groups.some(group => group.id === 'alice-route')).toBe(false)
      const create = async (token: string) => {
        const created = await f.http('/sessions/create', { requestId: randomUUID() }, { token })
        expect(created.status).toBe(200)
        return z.object({ sessionId: z.uuid() }).strict().parse(created.value).sessionId
      }
      const older = await create(alice), selected = await create(alice)
      value(await native(nativeHost.url, alice, 'session/selectModel',
        { request: { sessionId: selected, provider: 'alice-route', model: 'alice-model' } }))
      const newer = await create(alice)
      const after = z.object({ default: z.object({ provider: z.string(), model: z.string() }).loose() }).loose()
      expect(after.parse(value(await native(nativeHost.url, alice, 'session/modelCatalog'))).default)
        .toMatchObject({ provider: 'alice-route', model: 'alice-model' })
      expect(after.parse(value(await native(nativeHost.url, bob, 'session/modelCatalog'))).default)
        .toMatchObject({ provider: 'power-evolve', model: 'trial-model' })
      const defaults = await f.pool.query<{ namespace: string; value: unknown }>(
        'SELECT namespace,value FROM pe_native_preferences WHERE user_id=$1 AND namespace=ANY($2::text[])',
        [f.actors.alice.user.userId, [older, selected, newer].map(id => `session-model:${id}`)])
      expect(defaults.rows).toHaveLength(3)
      expect(defaults.rows.find(row => row.namespace === `session-model:${older}`)?.value)
        .toMatchObject({ provider: 'power-evolve', model: 'trial-model' })
      for (const id of [selected, newer]) expect(defaults.rows.find(row => row.namespace === `session-model:${id}`)?.value)
        .toMatchObject({ provider: 'alice-route', model: 'alice-model' })
      for (const [actor, provider, model, key] of [[f.actors.alice, 'alice-route', 'alice-model', keys[0]],
        [f.actors.bob, 'bob-route', 'bob-model', keys[1]]] as const) {
        const id = await create(actor.agent)
        value(await native(nativeHost.url, actor.agent, 'session/selectModel', { request: { sessionId: id, provider, model } }))
        await inferThroughNativeHost(f, root, actor, { sessionId: id, provider, model })
        expect(peerCalls.at(-1)?.authorization).toBe(`Bearer ${key}`)
        expect(z.object({ model: z.string() }).loose().parse(peerCalls.at(-1)?.body).model).toBe(model)
      }
      expect(peerCalls).toHaveLength(2)
      value(await native(nativeHost.url, alice, 'credentials/unset', { ref: 'OWNED_SHARED_REF' }))
      expect(credentialStates.parse(value(await native(nativeHost.url, alice, 'credentials/describe', { refs: ['OWNED_SHARED_REF'] }))).OWNED_SHARED_REF)
        .toMatchObject({ configured: false, writable: true })
      expect(credentialStates.parse(value(await native(nativeHost.url, bob, 'credentials/describe', { refs: ['OWNED_SHARED_REF'] }))).OWNED_SHARED_REF)
        .toMatchObject({ configured: true, writable: true })
      expect(await native(nativeHost.url, alice, 'credentials/set', { ref: 'OWNED_SHARED_REF', value: 'refused-placeholder' }))
        .toMatchObject({ ok: false, error: { code: 'gateway/forbidden' } })
    } finally { await nativeHost.ctx.fiber.dispose(); await productHost.ctx.fiber.dispose() }
  }, lifecycle, { modelPeerOrigin: peerOrigin })
  expect(receipt.stop).toMatchObject({ code: 0, signal: null, ownedPgConnections: 0 })
  expect(receipt.temporaryRootRemoved).toBe(true)
  expect(receipt.ownedDatabaseRemoved).toBe(true)
  expect(receipt.source.applyCount).toBeGreaterThan(0)
  console.info('Native model CLI receipt: ' + JSON.stringify(receipt))
}, sourceHttpTestTimeout)
