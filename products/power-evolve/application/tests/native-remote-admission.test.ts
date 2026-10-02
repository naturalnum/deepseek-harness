/** Real native HTTP and WebSocket admission with only Platform verification controlled. */
import assert from 'node:assert/strict'
import { request, type IncomingHttpHeaders } from 'node:http'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { PlatformError } from '../src/contracts.ts'
import { BrowserAgentAuth, type AgentVerifier } from '../src/host/browser-auth.ts'
import { installNativeRemote } from '../src/host/native-remote.ts'

const platformOrigin = 'https://platform.example.test'
const cookie = `pe_agent=${'a'.repeat(43)}`
const identity = { userId: '54f0f232-a068-4223-96e8-d0cff78d0f1c', username: 'alice',
  settings: { model: 'one', maxTokens: 512, revision: 1 } }

async function fixture(t: TestContext, verify: AgentVerifier['call']) {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const auth = new BrowserAgentAuth(origin, platformOrigin, { call: verify })
  const native = ctx.plugin({ inject: ['webServer'],
    apply: (ctx: Context) => installNativeRemote(ctx, auth, origin, 50, 4096, 4) })
  await native
  const read = (upgrade: boolean, headers: IncomingHttpHeaders = {}) => new Promise<{
    status: number; headers: IncomingHttpHeaders; body: string
  }>((resolve, reject) => {
    const call = request(new URL(upgrade ? '/native/api/remote.mux' : '/native/api/session/list', origin), {
      method: upgrade ? 'GET' : 'POST', agent: false,
      headers: { origin, cookie, ...(upgrade ? { connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': 'MDEyMzQ1Njc4OWFiY2RlZg==' }
        : { 'content-type': 'application/json' }), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }))
    })
    call.on('error', reject)
    call.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode!, headers: response.headers, body: '' })
    })
    call.end(upgrade ? undefined : JSON.stringify({ type: 'client-request', rpcId: 'fixture-list',
      method: 'session/list', payload: { args: { _request: {} } } }))
  })
  return { origin, read, native }
}

for (const [label, error, status] of [
  ['expired credential', new PlatformError(401, 'unauthorized'), 401],
  ['platform refusal', new PlatformError(403, 'forbidden'), 403],
  ['platform unavailable', new PlatformError(503, 'service_unavailable'), 503],
  ['connection reset', new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), 503],
  ['verification timeout', new DOMException('verification timed out', 'TimeoutError'), 503],
  ['invalid platform JSON', new SyntaxError('invalid platform response'), 503],
] as const) {
  test(`native admission rejects ${label} with HTTP ${String(status)} without clearing cookies`, async t => {
    let checks = 0
    const { read } = await fixture(t, async path => { assert.equal(path, '/identity/me'); checks++; throw error })
    for (const upgrade of [false, true]) {
      const response = await read(upgrade)
      assert.equal(response.status, status)
      assert.equal(response.headers['set-cookie'], undefined)
      assert.equal(response.body, upgrade ? status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'service unavailable'
        : JSON.stringify({ error: error instanceof PlatformError ? error.code : 'service_unavailable' }))
    }
    assert.equal(checks, 2)
  })
}

test('invalid Platform identity refuses the upgrade with 503', async t => {
  const { read } = await fixture(t, async () => ({ userId: identity.userId }))
  const response = await read(true)
  assert.equal(response.status, 503)
  assert.equal(response.headers['set-cookie'], undefined)
})

test('native admission retains cookie, Origin and Host checks', async t => {
  let checks = 0
  const { read } = await fixture(t, async () => { checks++; return identity })
  for (const upgrade of [false, true]) {
    assert.equal((await read(upgrade, { cookie: '' })).status, 401)
    assert.equal((await read(upgrade, { origin: platformOrigin })).status, 403)
    assert.equal((await read(upgrade, { host: 'other.example.test' })).status, 403)
  }
  assert.equal(checks, 2)
})

test('the same browser credential opens a native socket after Platform verification recovers', async t => {
  let unavailable = true
  const { read, native } = await fixture(t, async () => {
    if (unavailable) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    return identity
  })
  assert.equal((await read(true)).status, 503)
  unavailable = false
  assert.equal((await read(true)).status, 101)
  await native.dispose()
  assert.equal((await read(false)).status, 404)
})
