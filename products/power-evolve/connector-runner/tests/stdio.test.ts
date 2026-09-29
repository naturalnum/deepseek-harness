import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { EgressGate } from '../src/egress.ts'
import { requestDigest, parseCallInput } from '../src/protocol.ts'
import { createConnectorRunner } from '../src/server.ts'
import { StdioMcpTransport } from '../src/stdio.ts'

const token = 'm'.repeat(48)
const fixture = fileURLToPath(new URL('./stdio-fixture.mjs', import.meta.url))

test('one isolated MCP process returns only its assigned account and is reaped', async () => {
  const transport = new StdioMcpTransport(fixture)
  const accountId = randomUUID()
  const result = await transport.call({ kind: 'mcp.stdio.whoami', callId: randomUUID(),
    instanceId: randomUUID(), digest: '0'.repeat(64), accountId, timeoutMs: 5000,
    maxOutputBytes: 8192 }, new AbortController().signal)
  assert.deepEqual(result, { kind: 'mcp.stdio.whoami', text: `user:${accountId}` })
})

test('Runner fences process calls on egress readiness, instance and stable digest', async t => {
  const instanceId = randomUUID()
  const gate = new EgressGate({ host: '192.0.2.3', port: 2999 }, async () => 'denied', false, 60_000)
  const runner = createConnectorRunner({ token, allowlist: new Set(), egress: gate,
    transport: { async call() { throw new Error('SSH must not be called') } },
    stdioTransport: new StdioMcpTransport(fixture), instanceId })
  runner.server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => runner.server.once('listening', resolve))
  t.after(() => runner.close())
  const address = runner.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${url}${path}`, { ...init,
      headers: { 'x-power-evolve-runner-token': token, ...init.headers } })
    return { status: response.status, value: await response.json() as Record<string, unknown> }
  }
  const post = (value: unknown) => api('/calls', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  const unsigned = { kind: 'mcp.stdio.whoami' as const, callId: randomUUID(), instanceId,
    accountId: randomUUID(), timeoutMs: 5000, maxOutputBytes: 8192 }
  const signed = { ...unsigned, digest: requestDigest(unsigned, token) }
  assert.equal((await post(signed)).status, 503)
  await gate.check(); await gate.check(); await gate.check()
  assert.equal((await post(signed)).status, 202)
  assert.equal((await post(signed)).status, 200)
  let state: Record<string, unknown> = {}
  for (let attempt = 0; attempt < 50; attempt++) {
    state = (await api(`/calls/${unsigned.callId}`)).value
    if (state.state !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(state.state, 'succeeded')
  assert.deepEqual(state.result, { kind: 'mcp.stdio.whoami', text: `user:${unsigned.accountId}` })
  const conflict = { ...unsigned, accountId: randomUUID() }
  assert.equal((await post({ ...conflict, digest: requestDigest(conflict, token) })).status, 409)
  assert.equal((await post({ ...unsigned, instanceId: randomUUID(), digest: signed.digest })).status, 409)
  assert.equal((await post({ ...signed, accountId: 'wrong' })).status, 400)
  assert.equal((await post({ ...signed, command: '/bin/sh' })).status, 400)
  assert.equal(parseCallInput(signed).kind, 'mcp.stdio.whoami')
})
