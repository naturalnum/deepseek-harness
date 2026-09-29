import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { CallValidationError, destinationKey, parseAllowlist, parseCallInput, requestDigest,
  validCallDigest, type UnsignedCallInput } from '../src/protocol.ts'

const token = 'r'.repeat(48)
const unsigned = (): UnsignedCallInput => ({
  callId: randomUUID(), instanceId: randomUUID(), kind: 'ssh.inspect',
  destination: { host: '127.0.0.1', port: 2222, username: 'alice' },
  timeoutMs: 1000, maxOutputBytes: 4096,
})

test('request digest is canonical, secret-keyed and validates exact body', () => {
  const body = unsigned()
  const digest = requestDigest(body, token)
  const reordered = { maxOutputBytes: body.maxOutputBytes, destination: {
    username: body.destination.username, port: body.destination.port, host: body.destination.host,
  }, timeoutMs: body.timeoutMs, kind: body.kind, instanceId: body.instanceId, callId: body.callId }
  assert.equal(requestDigest(reordered, token), digest)
  assert.equal(validCallDigest({ ...body, digest }, token), true)
  assert.equal(validCallDigest({ ...body, digest }, 's'.repeat(48)), false)
  assert.equal(validCallDigest({ ...body, destination: { ...body.destination, port: 2223 }, digest }, token), false)
})

test('wire parser rejects credentials on inspect and missing pinned key on authenticate', () => {
  const body = unsigned()
  const digest = requestDigest(body, token)
  assert.equal(parseCallInput({ ...body, digest }).kind, 'ssh.inspect')
  assert.throws(() => parseCallInput({ ...body, digest, credential: { kind: 'password', password: 'x' } }),
    CallValidationError)
  assert.throws(() => parseCallInput({ ...body, digest, kind: 'ssh.authenticate',
    credential: { kind: 'password', password: 'x' } }), CallValidationError)
  assert.throws(() => parseCallInput({ ...body, digest, maxOutputBytes: 131073 }), CallValidationError)
})

test('exact host:port allowlist denies wildcards and malformed entries', () => {
  assert.equal(destinationKey('EXAMPLE.COM', 22), 'example.com:22')
  assert.deepEqual([...parseAllowlist('example.com:22,[::1]:2222')], ['example.com:22', '[::1]:2222'])
  assert.equal(parseAllowlist('').size, 0)
  assert.throws(() => parseAllowlist('*.example.com:22'), CallValidationError)
  assert.throws(() => parseAllowlist('example.com'), CallValidationError)
})
