/** Real in-process Host carrier and Typert dispatch; Platform responses are explicit substitutes. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { DESKTOP_BROWSER_SCOPE_HOST_PATH, DESKTOP_BROWSER_SCOPE_PLATFORM_PATH } from '@power-evolve/contracts/desktop-browser-scope'
import { apply, Config } from '../lib/host/index.js'
import { PlatformError } from '../lib/contracts.js'

async function fixture(t) {
  const ctx = new Context(), directory = await mkdtemp(join(tmpdir(), 'pe-browser-scope-host-'))
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGateway)
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const token = randomBytes(32).toString('base64url')
  const value = { userId: randomUUID(), sessionId: randomUUID(), workspaceId: randomUUID() }
  const calls = []
  let result = value
  ctx.provide('powerEvolveRuntime', {
    claim: async () => null,
    call: async (path, captured, input) => {
      assert.equal(captured, token)
      if (path === '/identity/me') return { userId: value.userId, username: 'fixture',
        settings: { model: 'fixture', maxTokens: 64, revision: 1 } }
      assert.equal(path, DESKTOP_BROWSER_SCOPE_PLATFORM_PATH)
      calls.push(input)
      if (result instanceof Error) throw result
      return result
    },
  })
  await ctx.plugin({ inject: ['webServer', 'typert', 'typertGateway', 'powerEvolveRuntime'],
    apply: ctx => apply(ctx, Config({ origin, platformOrigin: 'https://platform.example.test',
    deviceOrigin: 'http://127.0.0.1:29999', concurrency: 1, pollMs: 100, renewMs: 100,
    operationTimeoutMs: 1000, maxRequestBytes: 4096, maxStreams: 1, readyFile: join(directory, 'ready.json') })) })
  const call = async (input = { request: { sessionId: value.sessionId } }, headers = {}) => {
    const response = await fetch(new URL(DESKTOP_BROWSER_SCOPE_HOST_PATH, origin), {
      method: 'POST', headers: { origin, cookie: `pe_agent=${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(input), signal: AbortSignal.timeout(3000),
    })
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') }
  }
  return { call, calls, value, setResult: value => { result = value } }
}

test('Host scope uses the captured cookie credential and exact selected Session through Typert', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.call(), { status: 200, body: f.value, cookie: null })
  assert.deepEqual(f.calls, [{ sessionId: f.value.sessionId }])
  for (const input of [{ request: { sessionId: f.value.sessionId, userId: f.value.userId } },
    { request: { sessionId: f.value.sessionId }, workspaceId: f.value.workspaceId }, { request: {} }]) {
    assert.equal((await f.call(input)).status, 400)
  }
  assert.equal(f.calls.length, 1)
  assert.equal((await f.call(undefined, { origin: 'https://foreign.example.test' })).status, 403)
  assert.equal((await f.call(undefined, { cookie: '' })).status, 401)
  assert.equal(f.calls.length, 1)
})

test('Host rejects extra scope fields and mismatched Sessions, preserving Platform refusals', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  for (const result of [{ ...f.value, path: '/workspace' }, { ...f.value, token: 'private' },
    { ...f.value, sessionId: randomUUID() }, { sessionId: f.value.sessionId }]) {
    f.setResult(result)
    assert.deepEqual(await f.call(), { status: 502, body: { error: 'desktop_browser_scope_unavailable' }, cookie: null })
  }
  for (const status of [401, 403, 404, 503]) {
    f.setResult(new PlatformError(status, 'fixture_refusal'))
    assert.deepEqual(await f.call(), { status, body: { error: 'fixture_refusal' }, cookie: null })
  }
})
