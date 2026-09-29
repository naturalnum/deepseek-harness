import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import test from 'node:test'
import ssh2 from 'ssh2'
import type { CallInput } from '../src/protocol.ts'
import { Ssh2Transport, SshFailure } from '../src/transport.ts'

const digest = '0'.repeat(64)

test('real ssh2 fixture: discover, authenticate with pinned key, execute and bound output', async t => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1', format: 'pem',
  }).toString()
  const userKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1', format: 'pem',
  }).toString()
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    // Discovery intentionally closes before authentication; the fixture's
    // server-side socket may report EPIPE while ssh2 flushes its handshake.
    client.on('error', () => {})
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'alice' && context.password === 'test-password') {
        context.accept()
      } else if (context.method === 'publickey' && context.username === 'alice') {
        context.accept()
      } else context.reject()
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('exec', (take, _reject, info) => {
        const channel = take()
        if (info.command === 'echo ok') {
          channel.write('ok\n')
          channel.stderr.write('fixture\n')
          channel.exit(0)
          channel.end()
        } else {
          channel.write('x'.repeat(64))
          channel.exit(0)
          channel.end()
        }
      })
    }))
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const destination = { host: '127.0.0.1', port: address.port, username: 'alice' }
  const common = { callId: randomUUID(), instanceId: randomUUID(), digest,
    timeoutMs: 5000, maxOutputBytes: 4096 }
  const transport = new Ssh2Transport()
  const inspect: CallInput = { ...common, kind: 'ssh.inspect', destination }
  const canceled = new AbortController()
  canceled.abort()
  await assert.rejects(transport.call(inspect, canceled.signal),
    (error: unknown) => error instanceof SshFailure && error.code === 'ssh_cancelled')
  const observed = await transport.call(inspect, new AbortController().signal)
  assert.equal(observed.kind, 'ssh.inspect')
  if (observed.kind !== 'ssh.inspect') throw new Error('Unexpected result')
  assert.match(observed.hostKeySha256, /^SHA256:[A-Za-z0-9+/]{43}$/u)
  const pinned = { ...destination, hostKeySha256: observed.hostKeySha256 }
  const credential = { kind: 'password' as const, password: 'test-password' }
  const authenticate: CallInput = { ...common, kind: 'ssh.authenticate', destination: pinned, credential }
  assert.equal((await transport.call(authenticate, new AbortController().signal)).kind, 'ssh.authenticate')
  assert.equal((await transport.call({ ...authenticate,
    credential: { kind: 'private_key', privateKey: userKey } },
  new AbortController().signal)).kind, 'ssh.authenticate')
  await assert.rejects(transport.call({ ...authenticate, destination: {
    ...pinned, hostKeySha256: `SHA256:${'A'.repeat(43)}` } }, new AbortController().signal),
  (error: unknown) => error instanceof SshFailure && error.code === 'ssh_host_key_mismatch')
  await assert.rejects(transport.call({ ...authenticate, credential: { kind: 'password', password: 'wrong' } },
    new AbortController().signal),
  (error: unknown) => error instanceof SshFailure && error.code === 'ssh_authentication_failed')
  const execute: CallInput = { ...common, kind: 'ssh.execute', destination: pinned, credential, command: 'echo ok' }
  const result = await transport.call(execute, new AbortController().signal)
  assert.deepEqual(result, { kind: 'ssh.execute', exitCode: 0, signal: null, stdout: 'ok\n', stderr: 'fixture\n' })
  await assert.rejects(transport.call({ ...execute, command: 'long output', maxOutputBytes: 16 },
    new AbortController().signal),
  (error: unknown) => error instanceof SshFailure && error.code === 'ssh_output_limit')
})
