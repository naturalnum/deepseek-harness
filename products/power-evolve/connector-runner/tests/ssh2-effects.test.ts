import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import ssh2, { type Connection } from 'ssh2'
import { EgressGate } from '../src/egress.ts'
import { parseCallInput, requestDigest, type SshCallInput } from '../src/protocol.ts'
import { createConnectorRunner } from '../src/server.ts'
import { Ssh2Transport, SshFailure } from '../src/transport.ts'

const password = 'p'.repeat(4096)
const passphrase = 'k'.repeat(1024)

async function fixture(t: TestContext, onExec: (command: string) => void = () => {}) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1', format: 'pem',
  }).toString()
  const root = await mkdtemp(join(tmpdir(), 'pe-ssh-effects-'))
  const clients = new Set<Connection>()
  const closed = new Set<Promise<void>>()
  const markers = new Map<string, string>()
  const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
    clients.add(client)
    closed.add(new Promise<void>(resolve => client.once('close', () => { clients.delete(client); resolve() })))
    // Client teardown after discovery/failure can interrupt a handshake flush.
    client.on('error', () => {})
    client.on('authentication', (context) => {
      if (context.username === 'alice' && (context.method === 'publickey'
        || context.method === 'password' && context.password === password)) context.accept()
      else context.reject()
    })
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (take, reject, info) => {
        if (info.command === 'reject-exec') { reject(); return }
        const channel = take()
        const path = join(root, `${markers.size}.txt`)
        writeFileSync(path, info.command, { flag: 'wx', mode: 0o600 })
        markers.set(info.command, path)
        onExec(info.command)
        if (info.command === 'disconnect') { client.end(); return }
        if (info.command === 'timeout' || info.command === 'cancel') return
        if (info.command === 'no-exit') { channel.end(); channel.close(); return }
        if (info.command === 'output') channel.write('x'.repeat(64))
        else channel.write('ok\n')
        if (info.command === 'signal') channel.exit('TERM', false, 'fixture')
        else channel.exit(0)
        channel.end()
      })
    }))
  })
  t.after(async () => {
    const stopped = new Promise<void>(resolve => server.close(() => { resolve() }))
    for (const client of clients) client.end()
    await Promise.all([...closed, stopped])
    assert.equal(clients.size, 0)
    await rm(root, { recursive: true })
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const transport = new Ssh2Transport()
  const destination = { host: '127.0.0.1', port: address.port, username: 'alice' }
  const common = { callId: randomUUID(), instanceId: randomUUID(), digest: '0'.repeat(64),
    timeoutMs: 5000, maxOutputBytes: 4096 }
  const inspected = await transport.call({ ...common, destination, kind: 'ssh.inspect' },
    new AbortController().signal)
  assert.equal(inspected.kind, 'ssh.inspect')
  if (inspected.kind !== 'ssh.inspect') throw new Error('Unexpected inspection result')
  const execute = (command: string): Extract<SshCallInput, { kind: 'ssh.execute' }> => ({ ...common, kind: 'ssh.execute',
    destination: { ...destination, hostKeySha256: inspected.hostKeySha256 },
    credential: { kind: 'password', password }, command })
  return { transport, execute, markers }
}

void test('real SSH effects survive disconnect, timeout, cancellation, output limit and missing exit',
  { timeout: 20_000 }, async (t) => {
    const controller = new AbortController()
    const { transport, execute, markers } = await fixture(t, (command) => {
      if (command === 'cancel') controller.abort()
    })
    for (const [command, code] of [
      ['disconnect', /^(?:ssh_network_error|ssh_exit_missing)$/u],
      ['timeout', /^ssh_timeout$/u], ['cancel', /^ssh_cancelled$/u],
      ['output', /^ssh_output_limit$/u], ['no-exit', /^ssh_exit_missing$/u],
    ] as const) {
      const input = { ...execute(command), timeoutMs: command === 'timeout' ? 1500 : 5000,
        maxOutputBytes: command === 'output' ? 16 : 4096 }
      await assert.rejects(transport.call(input, command === 'cancel'
        ? controller.signal : new AbortController().signal),
      (error: unknown) => error instanceof SshFailure && code.test(error.code)
        &&  error.effectMayHaveOccurred)
      const marker = markers.get(command)
      assert.ok(marker, `Remote exec wrote a marker for ${command}`)
      assert.equal(await readFile(marker, 'utf8'), command)
    }
    await assert.rejects(transport.call(execute('reject-exec'), new AbortController().signal),
      (error: unknown) => error instanceof SshFailure &&  error.effectMayHaveOccurred)
    assert.equal(markers.has('reject-exec'), false)
    const signaled = await transport.call(execute('signal'), new AbortController().signal)
    assert.deepEqual(signaled, { kind: 'ssh.execute', exitCode: null, signal: 'SIGTERM', stdout: 'ok\n', stderr: '' })
  })

void test('real SSH authentication and fingerprint failures happen before exec', { timeout: 10_000 }, async (t) => {
  const { transport, execute, markers } = await fixture(t)
  const input = execute('must-not-run')
  for (const [request, code] of [
    [{ ...input, credential: { kind: 'password' as const, password: 'wrong' } }, 'ssh_authentication_failed'],
    [{ ...input, destination: { ...input.destination, hostKeySha256: `SHA256:${'A'.repeat(43)}` } },
      'ssh_host_key_mismatch'],
  ] as const) {
    await assert.rejects(transport.call(request, new AbortController().signal),
      (error: unknown) => error instanceof SshFailure && error.code === code
        && ! error.effectMayHaveOccurred)
  }
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(transport.call(input, aborted.signal),
    (error: unknown) => error instanceof SshFailure && error.code === 'ssh_cancelled'
      && ! error.effectMayHaveOccurred)
  assert.equal(markers.size, 0)
})

void test('HTTP Runner executes maximum command with maximum encrypted key and passphrase through real SSH',
  { timeout: 10_000 }, async (t) => {
    const { transport, execute, markers } = await fixture(t)
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase,
    }).toString()
    assert.ok(Buffer.byteLength(pem) < 7168)
    const command = 'x'.repeat(16_384)
    const input = { ...execute(command), credential: { kind: 'private_key' as const,
      privateKey: pem + '\n'.repeat(7168 - Buffer.byteLength(pem)), passphrase } }
    const { digest: _digest, ...unsigned } = input
    const token = 't'.repeat(48)
    const signed = { ...unsigned, digest: requestDigest(unsigned, token) }
    assert.equal(parseCallInput(signed).kind, 'ssh.execute')
    const gate = new EgressGate({ host: '192.0.2.3', port: 2999 }, async () => 'denied', false, 60_000)
    const runner = createConnectorRunner({ token, instanceId: input.instanceId, egress: gate, transport,
      allowlist: new Set([`${input.destination.host}:${input.destination.port}`]) })
    t.after(() => runner.close())
    runner.server.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => runner.server.once('listening', resolve))
    const address = runner.server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/calls`
    const headers = { 'x-power-evolve-runner-token': token, 'content-type': 'application/json' }
    await gate.check(); await gate.check(); await gate.check()
    const body = JSON.stringify(signed)
    assert.ok(Buffer.byteLength(body) > 16_384)
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 202)
    let status: Record<string, unknown> = {}
    const deadline = Date.now() + 5000
    do {
      const response = await fetch(`${url}/${input.callId}`, { headers })
      status = await response.json() as Record<string, unknown>
      if (status.state !== 'running') break
    } while (Date.now() < deadline)
    assert.equal(status.state, 'succeeded')
    assert.deepEqual(status.result, { kind: 'ssh.execute', exitCode: 0, signal: null, stdout: 'ok\n', stderr: '' })
    assert.equal('effectMayHaveOccurred' in status, false)
    const marker = markers.get(command)
    assert.ok(marker)
    assert.equal(await readFile(marker, 'utf8'), command)
  })
