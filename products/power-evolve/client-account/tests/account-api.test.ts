import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AccountHttpClient, AccountHttpError } from '../src/client/account-api.ts'

const userId = '54f0f232-a068-4223-96e8-d0cff78d0f1c'
const requestId = '62639e7b-e394-4a74-9365-49e5d65cf9c7'
const settings = { model: 'approved-model', maxTokens: 1024, revision: 2 }

test('personal reads and settings update use only same-origin product RPCs', async () => {
  const calls: Request[] = []
  const client = new AccountHttpClient(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init)
    calls.push(request)
    if (request.url.endsWith('/me')) return Response.json({ userId, username: 'alice', settings, ignored: 'server-extra' })
    if (request.url.endsWith('/modelsList')) return Response.json({ models: [{ id: 'approved-model', label: 'Approved', maxTokens: 16384 }] })
    return Response.json({ ...settings, revision: 3 })
  })
  assert.deepEqual(await client.me(), { userId, username: 'alice', settings })
  assert.deepEqual(await client.modelsList(), [{ id: 'approved-model', label: 'Approved', maxTokens: 16384 }])
  assert.deepEqual(await client.settingsUpdate({ requestId, expectedRevision: 2, model: 'approved-model', maxTokens: 1024 }),
    { ...settings, revision: 3 })
  assert.deepEqual(calls.map(call => new URL(call.url).pathname),
    ['/api/powerEvolve/me', '/api/powerEvolve/modelsList', '/api/powerEvolve/settingsUpdate'])
  assert(calls.every(call => call.credentials === 'same-origin' && call.method === 'POST'))
  assert.deepEqual(await calls[2]?.json(), { request: { requestId, expectedRevision: 2, model: 'approved-model', maxTokens: 1024 } })
})

test('rejects malformed catalog and settings before rendering or writing', async () => {
  const client = new AccountHttpClient(async () => Response.json({ models: [
    { id: 'duplicate', label: 'One', maxTokens: 512 }, { id: 'duplicate', label: 'Two', maxTokens: 512 },
  ] }))
  await assert.rejects(client.modelsList(), /Invalid model list/u)
  let calls = 0
  const invalid = new AccountHttpClient(async () => { calls++; return Response.json(settings) })
  await assert.rejects(invalid.settingsUpdate({ requestId: 'not-a-uuid', expectedRevision: 2, model: 'x', maxTokens: 8 }))
  await assert.rejects(invalid.settingsUpdate({ requestId, expectedRevision: 0, model: 'x', maxTokens: 8 }))
  assert.equal(calls, 0)
})

test('preserves status for conflict handling and never includes server detail in an error', async () => {
  const client = new AccountHttpClient(async () => Response.json({ error: 'conflict', privateDetail: 'do not expose' }, { status: 409 }))
  const error = await client.settingsUpdate({ requestId, expectedRevision: 2, model: 'approved-model', maxTokens: 512 })
    .catch((value: unknown) => value)
  assert(error instanceof AccountHttpError)
  assert.equal(error.status, 409)
  assert(!String(error).includes('privateDetail'))
})

test('sign-out uses product RPC and redirects only to the Host-advertised login URL', async () => {
  const paths: string[] = []
  const client = new AccountHttpClient(async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init)
    paths.push(new URL(request.url).pathname)
    return request.url.endsWith('/config')
      ? Response.json({ loginUrl: 'https://login.example.test/login' })
      : Response.json({ ok: true })
  })
  assert.equal(await client.loginUrl(), 'https://login.example.test/login')
  await client.logout()
  assert.deepEqual(paths, ['/config', '/api/powerEvolve/logout'])
  const bad = new AccountHttpClient(async () => Response.json({ loginUrl: 'javascript:alert(1)' }))
  await assert.rejects(bad.loginUrl(), /Invalid login destination/u)
})

test('native capabilities carry only display navigation and must match the configured Platform origin', async () => {
  const capability = { userId, username: 'alice', displayName: 'Alice', role: 'ADMIN', canManage: true,
    accountUrl: 'https://platform.test/account' }
  const calls: Request[] = []
  const client = new AccountHttpClient(async (input, init) => {
    const request = new Request(new URL(String(input), 'https://host.test'), init)
    calls.push(request)
    return Response.json(request.url.endsWith('/config') ? { loginUrl: 'https://platform.test/login' } : capability)
  })
  assert.deepEqual(await client.navigation(new AbortController().signal),
    { displayName: 'Alice', canManage: true, accountUrl: 'https://platform.test/account' })
  assert.deepEqual(await calls.find(request => request.method === 'POST')?.json(), { request: {} })
  assert(calls.every(request => !request.headers.has('authorization') && new URL(request.url).origin === 'https://host.test'))
  const foreign = new AccountHttpClient(async input => Response.json(String(input).endsWith('/config')
    ? { loginUrl: 'https://platform.test/login' } : { ...capability, accountUrl: 'https://foreign.test/account' }))
  await assert.rejects(foreign.navigation(new AbortController().signal), /Unexpected account origin/u)
})
