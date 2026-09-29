import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PersonalSshHttpClient, validSshCreate, type SshCreateInput } from '../src/client/ssh-api.ts'

const connectionId = 'f76e4521-45b0-4829-91dd-9a205c7ef68c'
const requestId = '458b17f6-ed08-47c6-8eaa-81ce259d4ad0'
const fingerprint = 'SHA256:1234567890123456789012345678901234567890123'
const password = '密钥🔑'
const input: SshCreateInput = { requestId, displayName: 'My server', host: 'server.example.com',
  port: 22, username: 'alice', hostKeySha256: fingerprint, password, enabled: true }
const item = { connectionId, displayName: 'My server', host: 'server.example.com', port: 22,
  username: 'alice', hostKeySha256: fingerprint, enabled: true, revision: 1, credentialRevision: 1 }
const ticket = { state: 'pending', ticket: 'a'.repeat(40),
  uploadUrl: 'http://127.0.0.1:19211/ssh/upload', expiresAt: '2026-09-29T11:00:00.000Z' }

test('SSH password bytes bypass Host RPC and upload only to the pinned Platform path', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let uploadedBytes: Uint8Array | undefined
  const client = new PersonalSshHttpClient(async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/sshCreateTicket')) return Response.json(ticket)
    if (String(url) === '/config') return Response.json({ approvalUrl: 'http://127.0.0.1:19211/approval' })
    if (String(url).endsWith('/ssh/upload')) {
      uploadedBytes = new Uint8Array(init?.body as Uint8Array)
      return Response.json({ item })
    }
    throw new Error('Unexpected call')
  })
  assert.deepEqual(await client.createPassword(input), item)
  const host = calls[0]!
  const body = JSON.parse(String(host.init?.body)) as { request: Record<string, unknown> }
  assert.deepEqual(host.url, '/api/powerEvolve/sshCreateTicket')
  assert.deepEqual(body.request, { requestId, displayName: 'My server', host: 'server.example.com',
    port: 22, username: 'alice', hostKeySha256: fingerprint, credentialKind: 'password', enabled: true,
    sizeBytes: Buffer.byteLength(password) })
  assert.equal(JSON.stringify(body).includes(password), false)
  const upload = calls[2]!
  assert.equal(upload.url, 'http://127.0.0.1:19211/ssh/upload')
  assert.equal(upload.init?.credentials, 'omit')
  assert.equal(upload.init?.redirect, 'error')
  assert.equal(upload.init?.referrerPolicy, 'no-referrer')
  assert.equal((upload.init?.headers as Record<string, string>).authorization, `Bearer ${ticket.ticket}`)
  assert.equal((upload.init?.headers as Record<string, string>)['content-type'], 'application/octet-stream')
  assert.deepEqual(uploadedBytes, new TextEncoder().encode(password))
})

test('SSH upload rejects a redirected destination before credential bytes leave the browser', async () => {
  for (const destination of ['https://evil.example/ssh/upload',
    'http://127.0.0.1:19211/ssh/upload?trace=1', 'http://127.0.0.1:19211/skills/upload']) {
    let uploads = 0
    const client = new PersonalSshHttpClient(async (url) => {
      if (String(url).endsWith('/sshCreateTicket')) return Response.json({ ...ticket, uploadUrl: destination })
      if (String(url) === '/config') return Response.json({ approvalUrl: 'http://127.0.0.1:19211/approval' })
      uploads += 1
      throw new Error('Credential uploaded')
    })
    await assert.rejects(client.createPassword(input), /Invalid SSH upload destination/u)
    assert.equal(uploads, 0)
  }
})

test('a ready retry needs no second upload and field validation rejects unsafe drafts', async () => {
  const calls: string[] = []
  const client = new PersonalSshHttpClient(async url => {
    calls.push(String(url))
    return Response.json({ state: 'ready', item })
  })
  assert.deepEqual(await client.createPassword(input), item)
  assert.deepEqual(calls, ['/api/powerEvolve/sshCreateTicket'])
  assert.equal(validSshCreate({ ...input, hostKeySha256: '' }), false)
  assert.equal(validSshCreate({ ...input, password: '' }), false)
  assert.equal(validSshCreate({ ...input, password: '你'.repeat(2731) }), false)
  assert.equal(validSshCreate({ ...input, host: 'user@server.example.com' }), false)
})

test('SSH credential check, status and cancel use only opaque identities and validate matching call IDs', async () => {
  const calls: Array<{ url: string; request: unknown }> = []
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const client = new PersonalSshHttpClient(async (url, init) => {
    const request = (JSON.parse(String(init?.body)) as { request: unknown }).request
    calls.push({ url: String(url), request })
    return Response.json({ callId, state: calls.length === 1 ? 'accepted' : 'running' })
  })
  assert.equal((await client.check({ requestId, connectionId, connectionRevision: 2 })).state, 'accepted')
  assert.equal((await client.callStatus(callId)).state, 'running')
  assert.equal((await client.callCancel(callId)).state, 'running')
  assert.deepEqual(calls, [
    { url: '/api/powerEvolve/sshCheck', request: { requestId, connectionId, connectionRevision: 2 } },
    { url: '/api/powerEvolve/sshCallStatus', request: { callId } },
    { url: '/api/powerEvolve/sshCallCancel', request: { callId } },
  ])
  const wrong = new PersonalSshHttpClient(async () => Response.json({ callId: connectionId, state: 'succeeded' }))
  await assert.rejects(wrong.callStatus(callId), /SSH call response mismatch/u)
  await assert.rejects(wrong.callCancel(callId), /SSH call response mismatch/u)
  const invalid = new PersonalSshHttpClient(async () => Response.json({ callId, state: 'pretend-success' }))
  await assert.rejects(invalid.check({ requestId, connectionId, connectionRevision: 1 }), /Invalid SSH check response/u)
  const oversized = new PersonalSshHttpClient(async () => Response.json({ callId, state: 'succeeded',
    result: '你'.repeat(2731) }))
  await assert.rejects(oversized.callStatus(callId), /Invalid SSH check result/u)
})
