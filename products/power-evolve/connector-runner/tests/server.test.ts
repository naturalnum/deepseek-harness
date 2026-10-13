import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { EgressGate, type ProbeResult } from '../src/egress.ts'
import { requestDigest, type UnsignedCallInput } from '../src/protocol.ts'
import { createConnectorRunner } from '../src/server.ts'
import type { SshTransport } from '../src/transport.ts'

const token = 't'.repeat(48)
const instanceId = randomUUID()
const base = (): Extract<UnsignedCallInput, { kind: 'ssh.inspect' }> => ({ callId: randomUUID(), instanceId, kind: 'ssh.inspect',
  destination: { host: '127.0.0.1', port: 2222, username: 'alice' },
  timeoutMs: 1000, maxOutputBytes: 4096 })

void test('runner blocks requests until egress denies, then deduplicates and withdraws readiness', async (t) => {
  let outcome: ProbeResult = 'denied'
  const gate = new EgressGate({ host: '192.0.2.3', port: 2999 }, async () => outcome, false, 60_000)
  const transport: SshTransport = { async call() {
    return { kind: 'ssh.inspect', hostKeySha256: `SHA256:${'A'.repeat(43)}`, serverBanner: null }
  } }
  const runner = createConnectorRunner({ token, allowlist: new Set(['127.0.0.1:2222']), egress: gate,
    transport, instanceId })
  runner.server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => runner.server.once('listening', resolve))
  t.after(() => runner.close())
  const address = runner.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const api = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('x-power-evolve-runner-token', token)
    const response = await fetch(`${url}${path}`, { ...init, headers })
    return { status: response.status, value: await response.json() as Record<string, unknown> }
  }
  assert.equal((await fetch(`${url}/health`)).status, 401)
  assert.equal((await api('/health')).value.ready, false)
  await gate.check(); await gate.check(); await gate.check()
  assert.equal((await api('/health')).value.ready, true)

  const body = base()
  const signed = { ...body, digest: requestDigest(body, token) }
  const post = (value: unknown) => api('/calls', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value) })
  assert.equal((await post(signed)).status, 202)
  assert.equal((await post(signed)).status, 200)
  const query = await api(`/calls/${body.callId}`)
  assert.equal(query.status, 200)
  assert.equal(query.value.state, 'succeeded')
  assert.equal(JSON.stringify(query.value).includes('password'), false)
  assert.equal((await post({ ...signed, digest: '0'.repeat(64) })).status, 400)
  const changed = { ...body, destination: { ...body.destination, username: 'bob' } }
  assert.equal((await post({ ...changed, digest: requestDigest(changed, token) })).status, 409)
  const denied = { ...base(), destination: { host: '127.0.0.1', port: 2223, username: 'alice' } }
  assert.equal((await post({ ...denied, digest: requestDigest(denied, token) })).status, 403)
  const second = base()
  assert.equal((await post({ ...second, digest: requestDigest(second, token) })).status, 429)
  outcome = 'connected'
  await gate.check()
  assert.equal((await api('/health')).status, 503)
  assert.equal((await post({ ...base(), digest: '0'.repeat(64) })).status, 503)
  assert.equal((await api(`/calls/${body.callId}`)).status, 200)
})

void test('refusal is inconclusive unless a separately verified fixed probe allows it', async () => {
  const probe = async (): Promise<ProbeResult> => 'refused'
  const strict = new EgressGate({ host: '192.0.2.3', port: 2999 }, probe)
  await strict.check(); await strict.check(); await strict.check()
  assert.equal(strict.ready, false)
  const verified = new EgressGate({ host: '192.0.2.3', port: 2999 }, probe, true)
  await verified.check(); await verified.check(); await verified.check()
  assert.equal(verified.ready, true)
  await Promise.all([strict.close(), verified.close()])
})
