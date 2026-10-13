import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import test, { type TestContext } from 'node:test'
import { EgressGate } from '../src/egress.ts'
import { MAX_CALL_BODY_BYTES, requestDigest, type UnsignedCallInput } from '../src/protocol.ts'
import { createConnectorRunner } from '../src/server.ts'
import { StdioFailure, StdioMcpTransport } from '../src/stdio.ts'
import { SshFailure, type SshTransport } from '../src/transport.ts'

const token = 't'.repeat(48)

async function fixture(t: TestContext, transport: SshTransport, stdioTransport?: StdioMcpTransport) {
  const instanceId = randomUUID()
  const gate = new EgressGate({ host: '192.0.2.3', port: 2999 }, async () => 'denied', false, 60_000)
  const runner = createConnectorRunner({ token, instanceId, egress: gate, transport,
    ...(stdioTransport ? { stdioTransport } : {}), allowlist: new Set(['127.0.0.1:2222']), maxStored: 32 })
  t.after(() => runner.close())
  runner.server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => runner.server.once('listening', resolve))
  const address = runner.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  await gate.check(); await gate.check(); await gate.check()
  const api = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('x-power-evolve-runner-token', token)
    const response = await fetch(`${url}${path}`, { ...init, headers })
    return { status: response.status, value: await response.json() as Record<string, unknown> }
  }
  const signed = (input: UnsignedCallInput) => ({ ...input, digest: requestDigest(input, token) })
  const postRaw = (body: string) => api('/calls', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body })
  const execute = (command: string) => ({ callId: randomUUID(), instanceId, kind: 'ssh.execute' as const,
    destination: { host: '127.0.0.1', port: 2222, username: 'alice', hostKeySha256: `SHA256:${'A'.repeat(43)}` },
    credential: { kind: 'password' as const, password: 'test' }, command,
    timeoutMs: 1000, maxOutputBytes: 4096 })
  return { url, api, signed, postRaw, execute }
}

void test('SSH failure effect flag survives GET and duplicate POST, including synchronous unknown errors', async (t) => {
  let calls = 0
  const transport: SshTransport = { call(input) {
    calls++
    if (input.kind !== 'ssh.execute') return Promise.reject(new Error('unclassified pre-exec failure'))
    if (input.command === 'sync-unknown') throw new Error('unclassified synchronous failure')
    if (input.command === 'known-before') return Promise.reject(new SshFailure('ssh_authentication_failed', false))
    if (input.command === 'known-after') return Promise.reject(new SshFailure('ssh_timeout', true))
    return Promise.reject(new Error('unclassified execute failure'))
  } }
  const { api, signed, postRaw, execute } = await fixture(t, transport)
  const authBase = execute('unused')
  const { command: _command, ...authenticate } = authBase
  const { credential: _credential, ...inspect } = authenticate
  const { hostKeySha256: _key, ...destination } = inspect.destination
  for (const [input, effect, code] of [
    [execute('known-before'), false, 'ssh_authentication_failed'],
    [execute('known-after'), true, 'ssh_timeout'],
    [execute('unknown'), true, 'ssh_network_error'],
    [execute('sync-unknown'), true, 'ssh_network_error'],
    [{ ...authenticate, kind: 'ssh.authenticate' as const }, false, 'ssh_network_error'],
    [{ ...inspect, callId: randomUUID(), kind: 'ssh.inspect' as const, destination }, false, 'ssh_network_error'],
  ] as const) {
    const body = JSON.stringify(signed(input))
    assert.equal((await postRaw(body)).status, 202)
    const status = await api(`/calls/${input.callId}`)
    assert.equal(status.status, 200)
    assert.equal(status.value.state, 'failed')
    assert.equal(status.value.errorCode, code)
    assert.equal(status.value.effectMayHaveOccurred, effect)
    assert.equal('result' in status.value, false)
    const repeated = await postRaw(body)
    assert.equal(repeated.status, 200)
    assert.deepEqual(repeated.value, status.value)
  }
  assert.equal(calls, 6)
})

void test('STDIO failure response retains its existing shape', async (t) => {
  class FailedStdio extends StdioMcpTransport {
    override async call(): Promise<never> { throw new StdioFailure('mcp_process_failed') }
  }
  const { api, signed, postRaw, execute } = await fixture(t,
    { async call() { throw new Error('SSH must not run') } }, new FailedStdio())
  const input = { kind: 'mcp.stdio.whoami' as const, callId: randomUUID(),
    instanceId: execute('unused').instanceId, accountId: randomUUID(), timeoutMs: 1000, maxOutputBytes: 8192 }
  const body = JSON.stringify(signed(input))
  assert.equal((await postRaw(body)).status, 202)
  const status = await api(`/calls/${input.callId}`)
  assert.equal(status.value.state, 'failed')
  assert.equal(status.value.errorCode, 'mcp_process_failed')
  assert.equal('effectMayHaveOccurred' in status.value, false)
  assert.deepEqual((await postRaw(body)).value, status.value)
})

void test('HTTP accepts maximum escaped SSH fields and enforces the entire body cap and original field caps', async (t) => {
  let calls = 0
  const { url, api, signed, postRaw, execute } = await fixture(t, { async call() {
    calls++
    return { kind: 'ssh.execute', exitCode: 0, signal: null, stdout: '', stderr: '' }
  } })
  const maximum = { ...execute('\x01'.repeat(16_384)), destination: {
    ...execute('unused').destination, username: '"'.repeat(256),
  }, credential: { kind: 'private_key' as const, privateKey: '\x01'.repeat(7168), passphrase: '\x01'.repeat(1024) } }
  const encoded = JSON.stringify(signed(maximum))
  assert.ok(Buffer.byteLength(encoded) > 128 * 1024)
  assert.ok(Buffer.byteLength(encoded) < MAX_CALL_BODY_BYTES)
  assert.equal(MAX_CALL_BODY_BYTES, 262_144)
  assert.equal((await postRaw(encoded)).status, 202)
  assert.equal((await api(`/calls/${maximum.callId}`)).value.state, 'succeeded')
  const passwordMaximum = { ...execute('x'.repeat(16_384)), credential: {
    kind: 'password' as const, password: '\x01'.repeat(4096),
  } }
  assert.equal((await postRaw(JSON.stringify(signed(passwordMaximum)))).status, 202)
  const atCap = signed(execute('at-cap'))
  const atCapJson = JSON.stringify(atCap)
  assert.equal((await postRaw(atCapJson + ' '.repeat(MAX_CALL_BODY_BYTES - Buffer.byteLength(atCapJson)))).status, 202)
  for (const input of [
    { ...maximum, callId: randomUUID(), command: 'x'.repeat(16_385) },
    { ...maximum, callId: randomUUID(), credential: { ...maximum.credential, privateKey: 'x'.repeat(7169) } },
    { ...maximum, callId: randomUUID(), credential: { ...maximum.credential, passphrase: 'x'.repeat(1025) } },
    { ...passwordMaximum, callId: randomUUID(), credential: { kind: 'password' as const, password: 'x'.repeat(4097) } },
  ]) {
    const rejected = await postRaw(JSON.stringify(signed(input)))
    assert.equal(rejected.status, 400)
    assert.equal(rejected.value.error, 'invalid_call')
    assert.equal((await api(`/calls/${input.callId}`)).status, 404)
  }
  for (const chunked of [false, true]) {
    const oversized = signed(execute('oversized'))
    const json = JSON.stringify(oversized)
    const body: string = json + ' '.repeat(MAX_CALL_BODY_BYTES + 1 - Buffer.byteLength(json))
    const rejected: { status: number; value: unknown } = chunked
      ? await new Promise<{ status: number; value: unknown }>((resolve, reject) => {
        const outgoing = request(`${url}/calls`, { method: 'POST', headers: {
          'x-power-evolve-runner-token': token, 'content-type': 'application/json', 'transfer-encoding': 'chunked',
        } }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (data: Buffer) => chunks.push(data))
          response.once('error', reject)
          response.once('end', () => {
            outgoing.destroy()
            resolve({ status: response.statusCode ?? 0,
              value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
          })
        })
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error('HTTP rejection timed out')))
        outgoing.once('error', reject)
        // Leave the body open: the cap must reject before waiting for a terminating chunk.
        outgoing.write(body)
      }) : await postRaw(body)
    assert.equal(rejected.status, 413)
    assert.deepEqual(rejected.value, { error: 'request_too_large', instanceId: oversized.instanceId })
    assert.equal((await api(`/calls/${oversized.callId}`)).status, 404)
  }
  assert.equal(calls, 3)
})
