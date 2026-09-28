import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceOptions, ExecutionTargetClient, targetKey } from '../src/client/execution-target-client.ts'

const aliceDevice = 'cfe50a67-79e4-4b52-af76-4e91cfc00cbf'
const aliceDirectory = '2586148d-518f-4f2c-846e-70963faf8dde'
const bobDevice = '481f20d5-dfe0-4f92-86d5-a0bdd0e437d9'

test('selection is per Session and frozen as one prompt hint', async () => {
  let request: Request | undefined
  const client = new ExecutionTargetClient(async (input, init) => {
    request = new Request(new URL(String(input), 'http://localhost'), init)
    return Response.json({ items: [{ deviceId: aliceDevice, directoryId: aliceDirectory,
      name: 'Alice Mac', label: 'project', directoryRevokedAt: null }] })
  })
  const options = await client.list()
  assert.equal(request?.url, 'http://localhost/api/powerEvolve/devicesList')
  assert.equal(request?.credentials, 'same-origin')
  assert.deepEqual(await request?.json(), { request: {} })
  client.select('session-a', options[0]!.target, options)
  const submitted = client.hint('session-a')
  client.select('session-a', { kind: 'cloud' }, options)
  assert.deepEqual(JSON.parse(submitted), { kind: 'desktop', deviceId: aliceDevice, directoryId: aliceDirectory })
  assert.deepEqual(JSON.parse(client.hint('session-a')), { kind: 'cloud' })
  assert.deepEqual(JSON.parse(client.hint('session-b')), { kind: 'cloud' })
  assert.throws(() => client.select('session-b', { kind: 'desktop', deviceId: bobDevice,
    directoryId: aliceDirectory }, options), /unavailable/)
})

test('revoked or malformed directories are not selectable after refresh', () => {
  const options = deviceOptions({ items: [
    { deviceId: aliceDevice, directoryId: aliceDirectory, name: 'Mac', label: 'project', directoryRevokedAt: null },
    { deviceId: bobDevice, directoryId: '9a32a30a-891a-40a3-8bd2-73b1b2c74aeb',
      name: 'Other', label: 'revoked', directoryRevokedAt: '2026-01-01T00:00:00.000Z' },
    { deviceId: 'bad', directoryId: aliceDirectory, name: 'Bad', label: 'bad', directoryRevokedAt: null },
  ] })
  assert.equal(options.length, 1)
  assert.equal(targetKey(options[0]!.target), `${aliceDevice}:${aliceDirectory}`)
  const client = new ExecutionTargetClient()
  client.select('a', options[0]!.target, options)
  assert.deepEqual(client.reconcile('a', []), { kind: 'cloud' })
  assert.throws(() => deviceOptions({ items: null }), /Invalid device list/)
})

test('pairing requests a short-lived code through the authenticated Host', async () => {
  let request: Request | undefined
  const client = new ExecutionTargetClient(async (input, init) => {
    request = new Request(new URL(String(input), 'http://localhost'), init)
    return Response.json({ code: 'test-code-with-at-least-24-characters', expiresAt: '2026-09-28T12:00:00Z' })
  })
  const pairing = await client.pair()
  assert.equal(request?.url, 'http://localhost/api/powerEvolve/devicesPair')
  assert.equal(request?.credentials, 'same-origin')
  assert.deepEqual(await request?.json(), { request: {} })
  assert.equal(pairing.expiresAt, '2026-09-28T12:00:00Z')
})
