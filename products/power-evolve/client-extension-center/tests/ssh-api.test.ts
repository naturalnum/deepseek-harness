import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PersonalSshHttpClient, SshHttpError, validSshCreate, validSshUpdate,
  type PersonalSshConnection, type SshCreateInput, type SshUpdateInput } from '../src/client/ssh-api.ts'
import { sshCredentialTicketRequest, sshCredentialUpload, sshManagementRequests,
  sshConnectionValue } from '../../application/src/ssh-management-contracts.ts'

const connectionId = 'f76e4521-45b0-4829-91dd-9a205c7ef68c'
const requestId = '458b17f6-ed08-47c6-8eaa-81ce259d4ad0'
const fingerprint = 'SHA256:1234567890123456789012345678901234567890123'
const password = '密钥🔑'
const input: SshCreateInput = { requestId, configuration: { displayName: 'My server', host: 'server.example.com',
  port: 22, username: 'alice', hostKeySha256: fingerprint, workingDirectory: null,
  authentication: { kind: 'password', password: 'replace' }, enabled: true }, credentials: { formatVersion: 2, password } }
const item: PersonalSshConnection = { connectionId, displayName: 'My server', host: 'server.example.com', port: 22,
  username: 'alice', hostKeySha256: fingerprint, enabled: true, revision: 1, credentialRevision: 1,
  workingDirectory: null, authentication: 'password', secretConfigured: true, passphraseConfigured: false,
  deletedAt: null, createdAt: '2026-09-30T01:00:00.000Z', updatedAt: '2026-09-30T01:00:00.000Z' }
const ticket = { state: 'pending', requestId, ticket: 'a'.repeat(40),
  uploadUrl: 'http://127.0.0.1:19211/ssh/upload', expiresAt: '2026-10-01T11:00:00.000Z' }
const uploadUrl = ticket.uploadUrl
const config = { approvalUrl: 'http://127.0.0.1:19211/approval' }
const requestBody = (init?: RequestInit): Record<string, unknown> =>
  (JSON.parse(String(init?.body)) as { request: Record<string, unknown> }).request

// All fetch handlers are explicit transport substitutes; no Platform or Runner is started.
test('format two credentials bypass Host RPC; byte count includes JSON and buffers are cleared', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let uploadedBytes: Uint8Array | undefined
  let sentBuffer: Uint8Array | undefined
  const client = new PersonalSshHttpClient(async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/sshConnectionsTicket')) return Response.json(ticket)
    if (String(url) === '/config') return Response.json(config)
    if (String(url) === uploadUrl) {
      sentBuffer = init?.body as Uint8Array
      uploadedBytes = new Uint8Array(sentBuffer)
      return Response.json({ item })
    }
    throw new Error('Unexpected call')
  })
  assert.deepEqual(await client.create(input), item)
  const host = calls[0]!
  const body = requestBody(host.init)
  assert.equal(host.url, '/api/powerEvolve/sshConnectionsTicket')
  assert.deepEqual(body, { purpose: 'create', requestId, configuration: input.configuration,
    sizeBytes: Buffer.byteLength(JSON.stringify(input.credentials)) })
  assert.equal(sshCredentialTicketRequest.safeParse(body).success, true)
  assert.equal(JSON.stringify(body).includes(password), false)
  const upload = calls[2]!
  assert.equal(upload.url, uploadUrl)
  assert.equal(upload.init?.credentials, 'omit')
  assert.equal(upload.init?.redirect, 'error')
  assert.equal(upload.init?.referrerPolicy, 'no-referrer')
  assert.equal((upload.init?.headers as Record<string, string>).authorization, `Bearer ${ticket.ticket}`)
  assert.equal((upload.init?.headers as Record<string, string>)['content-type'], 'application/octet-stream')
  assert.deepEqual(uploadedBytes, new TextEncoder().encode(JSON.stringify(input.credentials)))
  assert.equal(sshCredentialUpload.safeParse(JSON.parse(new TextDecoder().decode(uploadedBytes))).success, true)
  assert.ok(sentBuffer?.every(byte => byte === 0))
  assert.equal(sshConnectionValue.safeParse(item).success, true)
})

test('SSH upload rejects a changed destination before any secret leaves the browser', async () => {
  for (const destination of ['https://evil.example/ssh/upload',
    'http://127.0.0.1:19211/ssh/upload?trace=1', 'http://127.0.0.1:19211/skills/upload',
    'http://127.0.0.1:19211/ssh/upload#fragment', 'http://user:pass@127.0.0.1:19211/ssh/upload']) {
    let uploads = 0
    const client = new PersonalSshHttpClient(async url => {
      if (String(url).endsWith('/sshConnectionsTicket')) return Response.json({ ...ticket, uploadUrl: destination })
      if (String(url) === '/config') return Response.json(config)
      uploads += 1
      throw new Error('Credential uploaded')
    })
    await assert.rejects(client.create(input), /Invalid SSH upload destination/u)
    assert.equal(uploads, 0)
  }
})

test('tickets cannot skip byte verification and must name the original request', async () => {
  for (const value of [{ state: 'ready', item }, { ...ticket, requestId: connectionId }, { ...ticket, expiresAt: 'tomorrow' }]) {
    const calls: string[] = []
    const client = new PersonalSshHttpClient(async url => { calls.push(String(url)); return Response.json(value) })
    await assert.rejects(client.create(input), /Invalid SSH upload ticket/u)
    assert.deepEqual(calls, ['/api/powerEvolve/sshConnectionsTicket'])
  }
})

test('secret budgets, valid UTF-8, creation and exact replacement fields are checked before dispatch', async () => {
  assert.equal(validSshCreate(input), true)
  assert.equal(validSshCreate({ ...input, credentials: { formatVersion: 2, password: '\uFEFFsecret' } }), true)
  for (const secret of ['', 'p'.repeat(4097), '你'.repeat(1366), '\0', '\ud800']) {
    assert.equal(validSshCreate({ ...input, credentials: { formatVersion: 2, password: secret } }), false)
  }
  assert.equal(validSshCreate({ ...input, credentials: { formatVersion: 2, password: 'p'.repeat(4096) } }), true)
  assert.equal(validSshCreate({ ...input, configuration: { ...input.configuration, hostKeySha256: '' } }), false)
  assert.equal(validSshCreate({ ...input, configuration: { ...input.configuration, host: 'user@server.example.com' } }), false)
  assert.equal(validSshCreate({ ...input, credentials: { ...input.credentials, passphrase: 'must-not-leak' } }), false)
  assert.equal(validSshCreate({ ...input, configuration: { ...input.configuration,
    authentication: { kind: 'password', password: 'retain' } } }), false)
  const key: SshCreateInput = { ...input, configuration: { ...input.configuration,
    authentication: { kind: 'private_key', privateKey: 'replace', passphrase: 'clear' } },
    credentials: { formatVersion: 2, privateKey: 'k'.repeat(7168) } }
  assert.equal(validSshCreate(key), true)
  assert.equal(validSshCreate({ ...key, credentials: { ...key.credentials, privateKey: 'k'.repeat(7169) } }), false)
  assert.equal(validSshCreate({ ...key, configuration: { ...key.configuration,
    authentication: { kind: 'private_key', privateKey: 'replace', passphrase: 'retain' } } }), false)
  assert.equal(validSshCreate({ ...key, configuration: { ...key.configuration,
    authentication: { kind: 'private_key', privateKey: 'replace', passphrase: 'replace' } },
    credentials: { ...key.credentials, passphrase: 'p'.repeat(1025) } }), false)
  const request = async (): Promise<Response> => { throw new Error('Should not dispatch') }
  await assert.rejects(new PersonalSshHttpClient(request).create({ ...input,
    credentials: { formatVersion: 2, password: '\ud800' } }), /Invalid SSH connection/u)
})

test('metadata and explicit passphrase clearing update directly without uploading any secret', async () => {
  const update: SshUpdateInput = { requestId, connectionId, baseRevision: 1,
    configuration: { ...input.configuration, displayName: 'Edited', workingDirectory: '~/project',
      authentication: { kind: 'private_key', privateKey: 'retain', passphrase: 'clear' } } }
  const updated = { ...item, displayName: 'Edited', workingDirectory: '~/project', authentication: 'private_key', revision: 2 }
  const calls: Array<{ url: string; request: Record<string, unknown> }> = []
  const client = new PersonalSshHttpClient(async (url, init) => {
    calls.push({ url: String(url), request: requestBody(init) }); return Response.json(updated)
  })
  assert.deepEqual(await client.update(update), updated)
  assert.deepEqual(calls, [{ url: '/api/powerEvolve/sshConnectionsUpdate', request: update }])
  assert.equal(sshManagementRequests.sshConnectionsUpdate.safeParse(calls[0]!.request).success, true)
  assert.equal(validSshUpdate({ ...update, credentials: { formatVersion: 2, passphrase: 'unexpected' } }), false)
  assert.equal(validSshUpdate({ ...update, configuration: { ...update.configuration,
    authentication: { kind: 'private_key', privateKey: 'retain', passphrase: 'replace' } } }), false)
})

test('a passphrase-only replacement requests a ticket and uploads exactly that replacement field', async () => {
  const update: SshUpdateInput = { requestId, connectionId, baseRevision: 1,
    configuration: { ...input.configuration, authentication: { kind: 'private_key', privateKey: 'retain', passphrase: 'replace' } },
    credentials: { formatVersion: 2, passphrase: '密语' } }
  const updated = { ...item, authentication: 'private_key', passphraseConfigured: true, revision: 2, credentialRevision: 2 }
  const calls: string[] = []
  let reservation: Record<string, unknown> | undefined
  let envelope: unknown
  const client = new PersonalSshHttpClient(async (url, init) => {
    calls.push(String(url))
    if (String(url).endsWith('/sshConnectionsTicket')) { reservation = requestBody(init); return Response.json(ticket) }
    if (String(url) === '/config') return Response.json(config)
    envelope = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)); return Response.json({ item: updated })
  })
  assert.deepEqual(await client.update(update), updated)
  assert.deepEqual(calls, ['/api/powerEvolve/sshConnectionsTicket', '/config', uploadUrl])
  assert.deepEqual(envelope, { formatVersion: 2, passphrase: '密语' })
  assert.deepEqual(reservation, { purpose: 'update', requestId, configuration: update.configuration,
    connectionId, baseRevision: 1, sizeBytes: Buffer.byteLength(JSON.stringify(update.credentials)) })
  assert.equal(sshCredentialTicketRequest.safeParse(reservation).success, true)
})

test('lost upload replies and lost successful bodies query only the original request receipt', async () => {
  for (const lostBody of [false, true]) {
    const calls: Array<{ url: string; request?: Record<string, unknown> }> = []
    const client = new PersonalSshHttpClient(async (url, init) => {
      const path = String(url)
      calls.push({ url: path, ...(path.startsWith('/api/') ? { request: requestBody(init) } : {}) })
      if (path.endsWith('/sshConnectionsTicket')) return Response.json(ticket)
      if (path === '/config') return Response.json(config)
      if (path === uploadUrl) { if (lostBody) return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError('Upload reply stream interrupted')) },
        })); throw new TypeError('Lost upload reply') }
      if (path.endsWith('/sshConnectionsReceipt')) return Response.json({ item })
      throw new Error('Unexpected call')
    })
    assert.deepEqual(await client.create(input), item)
    assert.deepEqual(calls.at(-1), { url: '/api/powerEvolve/sshConnectionsReceipt', request: { requestId } })
  }
})

test('an empty receipt remains uncertain; observed HTTP failures and ticket loss do not query receipts', async () => {
  for (const mode of ['empty-receipt', 'http-error', 'ticket-loss', 'invalid-body'] as const) {
    let receipts = 0
    const client = new PersonalSshHttpClient(async url => {
      const path = String(url)
      if (path.endsWith('/sshConnectionsTicket')) {
        if (mode === 'ticket-loss') throw new TypeError('Lost ticket reply')
        return Response.json(ticket)
      }
      if (path === '/config') return Response.json(config)
      if (path === uploadUrl) {
        if (mode === 'http-error') return new Response(null, { status: 409 })
        if (mode === 'invalid-body') return new Response('not-json')
        throw new TypeError('Lost upload reply')
      }
      if (path.endsWith('/sshConnectionsReceipt')) { receipts += 1; return Response.json({ item: null }) }
      throw new Error('Unexpected call')
    })
    await assert.rejects(client.create(input), mode === 'empty-receipt' ? /outcome uncertain/u
      : mode === 'http-error' ? SshHttpError : mode === 'invalid-body' ? /Invalid SSH upload response/u : /Lost ticket reply/u)
    assert.equal(receipts, mode === 'empty-receipt' ? 1 : 0)
  }
})

test('completed-ticket retries still send the bytes and expose a changed-secret rejection', async () => {
  const copies: Uint8Array[] = []
  let tickets = 0
  const client = new PersonalSshHttpClient(async (url, init) => {
    if (String(url).endsWith('/sshConnectionsTicket')) { tickets += 1; return Response.json(ticket) }
    if (String(url) === '/config') return Response.json(config)
    if (String(url) === uploadUrl) {
      copies.push(new Uint8Array(init?.body as Uint8Array))
      return copies.length === 1 ? Response.json({ item }) : new Response(null, { status: 409 })
    }
    throw new Error('Unexpected receipt shortcut')
  })
  await client.create(input)
  await assert.rejects(client.create({ ...input, credentials: { formatVersion: 2, password: 'changed' } }), SshHttpError)
  assert.equal(tickets, 2)
  assert.equal(copies.length, 2)
  assert.notDeepEqual(copies[0], copies[1])
})

test('list, toggle and tombstone deletion use the fixed RPC and validate revision and identities', async () => {
  const toggle = { requestId, connectionId, baseRevision: 1, enabled: false }
  const remove = { requestId, connectionId, baseRevision: 2 }
  const tombstone = { ...item, enabled: false, revision: 3, deletedAt: '2026-09-30T02:00:00.000Z' }
  const calls: Array<{ url: string; request: Record<string, unknown> }> = []
  const client = new PersonalSshHttpClient(async (url, init) => {
    const path = String(url); calls.push({ url: path, request: requestBody(init) })
    return Response.json(path.endsWith('/sshConnectionsList') ? { available: true, items: [item] }
      : path.endsWith('/sshConnectionsToggle') ? { ...item, enabled: false, revision: 2 } : tombstone)
  })
  assert.deepEqual(await client.list(), { available: true, items: [item] })
  await client.toggle(toggle)
  assert.deepEqual(await client.remove(remove), tombstone)
  assert.deepEqual(calls, [
    { url: '/api/powerEvolve/sshConnectionsList', request: {} },
    { url: '/api/powerEvolve/sshConnectionsToggle', request: toggle },
    { url: '/api/powerEvolve/sshConnectionsDelete', request: remove },
  ])
  assert.equal(sshManagementRequests.sshConnectionsToggle.safeParse(calls[1]!.request).success, true)
  assert.equal(sshManagementRequests.sshConnectionsDelete.safeParse(calls[2]!.request).success, true)
  const stale = new PersonalSshHttpClient(async () => Response.json({ ...item, enabled: false }))
  await assert.rejects(stale.toggle(toggle), /response mismatch/u)
  await assert.rejects(new PersonalSshHttpClient(async () => Response.json(item)).remove({ ...remove, baseRevision: 1 }), /response mismatch/u)
})

test('public metadata rejects secret fields, duplicate IDs, tombstone lists and mismatched write receipts', async () => {
  for (const items of [[{ ...item, password: 'must-not-appear' }], [item, item], [{ ...item, deletedAt: item.createdAt }]]) {
    const client = new PersonalSshHttpClient(async () => Response.json({ available: true, items }))
    await assert.rejects(client.list(), /Invalid SSH/u)
  }
  for (const result of [{ ...item, host: 'other.example.com' }, { ...item, privateKey: 'secret' }]) {
    const client = new PersonalSshHttpClient(async url => String(url).endsWith('/sshConnectionsTicket') ? Response.json(ticket)
      : String(url) === '/config' ? Response.json(config) : Response.json({ item: result }))
    await assert.rejects(client.create(input), /SSH (write|connection)/u)
  }
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

test('recent SSH checks use one owner-scoped Host RPC and reject malformed lists', async () => {
  const callId = '217d9a46-3b52-455b-bba6-7d9389c990bb'
  const calls: Array<{ url: string; request: unknown }> = []
  const client = new PersonalSshHttpClient(async (url, init) => {
    calls.push({ url: String(url), request: (JSON.parse(String(init?.body)) as { request: unknown }).request })
    return Response.json({ items: [{ callId, state: 'running' }] })
  })
  assert.deepEqual(await client.callList(), [{ callId, state: 'running' }])
  assert.deepEqual(calls, [{ url: '/api/powerEvolve/sshCallList', request: {} }])
  const duplicates = new PersonalSshHttpClient(async () => Response.json({ items: [
    { callId, state: 'running' }, { callId, state: 'running' },
  ] }))
  await assert.rejects(duplicates.callList(), /Invalid SSH call list response/u)
  const oversized = new PersonalSshHttpClient(async () => Response.json({ items: Array.from({ length: 101 },
    () => ({ callId, state: 'running' })) }))
  await assert.rejects(oversized.callList(), /Invalid SSH call list response/u)
})

test('literal directories retain leading and trailing spaces through tickets, direct updates and responses', async () => {
  for (const workingDirectory of [' ~/project ', ' relative directory ', '/absolute path ', '  ', '\uFEFFrelative']) {
    const create: SshCreateInput = { ...input, configuration: { ...input.configuration, workingDirectory } }
    const created = { ...item, workingDirectory }
    const requests: Array<Record<string, unknown>> = []
    const client = new PersonalSshHttpClient(async (url, init) => {
      if (String(url).endsWith('/sshConnectionsTicket')) { requests.push(requestBody(init)); return Response.json(ticket) }
      if (String(url) === '/config') return Response.json(config)
      return Response.json({ item: created })
    })
    assert.deepEqual(await client.create(create), created)
    assert.deepEqual(requests[0]!.configuration, create.configuration)
    const update: SshUpdateInput = { requestId, connectionId, baseRevision: 1,
      configuration: { ...create.configuration, authentication: { kind: 'password', password: 'retain' } } }
    const updated = { ...created, revision: 2 }
    const updateClient = new PersonalSshHttpClient(async (url, init) => {
      assert.equal(String(url), '/api/powerEvolve/sshConnectionsUpdate')
      assert.deepEqual(requestBody(init), update)
      return Response.json(updated)
    })
    assert.deepEqual(await updateClient.update(update), updated)
  }
  assert.equal(validSshCreate({ ...input, configuration: { ...input.configuration, workingDirectory: null } }), true)
  assert.equal(validSshCreate({ ...input, configuration: { ...input.configuration, workingDirectory: '😀'.repeat(512) } }), true)
  let dispatched = 0
  const client = new PersonalSshHttpClient(async () => { dispatched += 1; throw new Error('Unexpected dispatch') })
  for (const workingDirectory of ['', 'x'.repeat(1025), '😀'.repeat(513), '\0', '\n', '\t', '\u007f', '\u0085', '\u009f', '\ud800', '\udc00']) {
    const configuration = { ...input.configuration, workingDirectory }
    assert.equal(validSshCreate({ ...input, configuration }), false)
    await assert.rejects(client.create({ ...input, configuration }), /Invalid SSH connection/u)
    await assert.rejects(client.update({ requestId, connectionId, baseRevision: 1,
      configuration: { ...configuration, authentication: { kind: 'password', password: 'retain' } } }), /Invalid SSH update/u)
  }
  assert.equal(dispatched, 0)
})

test('trimmed usernames require lossless UTF-8 and at most 256 bytes before any mutation', async () => {
  const username = `${'你'.repeat(85)}a`
  const paddedUsername = ` ${username} `
  const configuration = { ...input.configuration, username: paddedUsername }
  assert.equal(Buffer.byteLength(username), 256)
  assert.equal(validSshCreate({ ...input, configuration }), true)
  const created = { ...item, username }
  let reserved: Record<string, unknown> | undefined
  const client = new PersonalSshHttpClient(async (url, init) => {
    if (String(url).endsWith('/sshConnectionsTicket')) { reserved = requestBody(init); return Response.json(ticket) }
    if (String(url) === '/config') return Response.json(config)
    return Response.json({ item: created })
  })
  assert.deepEqual(await client.create({ ...input, configuration }), created)
  assert.deepEqual(reserved?.configuration, { ...configuration, username })
  for (const invalid of ['你'.repeat(86), '\ud800', '\udc00', 'a b', ' ', 'x'.repeat(101)]) {
    const configuration = { ...input.configuration, username: invalid }
    assert.equal(validSshCreate({ ...input, configuration }), false)
    assert.equal(validSshUpdate({ requestId, connectionId, baseRevision: 1,
      configuration: { ...configuration, authentication: { kind: 'password', password: 'retain' } } }), false)
  }
})

test('management base revisions use positive PostgreSQL int32 values and reject overflow before dispatch', async () => {
  const configuration = { ...input.configuration, authentication: { kind: 'password' as const, password: 'retain' as const } }
  assert.equal(validSshUpdate({ requestId, connectionId, baseRevision: 2_147_483_647, configuration }), true)
  let dispatched = 0
  const client = new PersonalSshHttpClient(async () => { dispatched += 1; throw new Error('Unexpected dispatch') })
  for (const baseRevision of [0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    await assert.rejects(client.update({ requestId, connectionId, baseRevision, configuration }), /Invalid SSH update/u)
    await assert.rejects(client.toggle({ requestId, connectionId, baseRevision, enabled: false }), /Invalid SSH toggle/u)
    await assert.rejects(client.remove({ requestId, connectionId, baseRevision }), /Invalid SSH deletion/u)
  }
  assert.equal(dispatched, 0)
  const boundary = new PersonalSshHttpClient(async () => Response.json({ ...item, revision: 2_147_483_647, enabled: false }))
  assert.equal((await boundary.toggle({ requestId, connectionId, baseRevision: 2_147_483_646, enabled: false })).revision, 2_147_483_647)
})
