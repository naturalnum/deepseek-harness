import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACCOUNT_ROUTES, accountValue } from '@power-evolve/contracts/account'
import { TrustedAccountHttpClient } from '../src/trusted/http-client.ts'
import { AccountActionError, type AccountMutationIntent } from '../src/trusted/view.ts'

const user = accountValue.parse({ userId: '54f0f232-a068-4223-96e8-d0cff78d0f1c', username: 'alice',
  displayName: 'Alice', role: 'ADMIN', enabled: true, revision: 7, passwordChangeRequired: false,
  deletedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
const requestId = '62639e7b-e394-4a74-9365-49e5d65cf9c7'
const token = 'a'.repeat(40)
const signal = () => new AbortController().signal
const models = { models: [{ id: 'one', label: 'One', maxTokens: 512 }, { id: 'two', label: 'Two', maxTokens: 4096 }],
  initialSettings: { model: 'two', maxTokens: 1024 }, limits: { maxUsers: 100, maxPageItems: 100,
    maxModelsPerUser: 16, passwordMinBytes: 12, passwordMaxBytes: 256 } }
const receipt = (kind: 'reset-password' | 'create' | 'change-password' = 'reset-password') =>
  ({ requestId, kind, account: user, completedAt: '2026-10-01T00:00:00Z' })

function fixture(handle: (request: Request) => Response | undefined | Promise<Response | undefined>,
  personal = user, restricted = false) {
  const calls: Request[] = []
  const client = new TrustedAccountHttpClient('https://platform.test', async (input, init) => {
    const request = new Request(input, init)
    calls.push(request.clone())
    const supplied = await handle(request)
    if (supplied) return supplied
    switch (new URL(request.url).pathname) {
      case ACCOUNT_ROUTES.login: return Response.json({ token, user: personal, restricted, expiresAt: '2026-10-02T00:00:00Z' })
      case ACCOUNT_ROUTES.me: return Response.json({ user: personal, restricted })
      case ACCOUNT_ROUTES.models: return Response.json(models)
      case '/config': return Response.json({ hostUrl: 'https://host.test/' })
      default: throw new Error('Unexpected fixture route')
    }
  })
  return { client, calls }
}
async function resetIntent(client: TrustedAccountHttpClient): Promise<AccountMutationIntent> {
  const session = await client.login('alice', 'legacy', signal())
  return { kind: 'reset', requestId, account: session.account }
}

test('trusted login and account mutations send raw DTOs only to the Platform with an in-memory account bearer', async () => {
  const { client, calls } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.resetPassword
    ? Response.json({ receipt: receipt(), replay: false, temporaryPassword: 'temporary-password' }) : undefined)
  const intent = await resetIntent(client)
  const result = await client.mutate(intent, signal())
  assert.equal(result.temporaryPassword, 'temporary-password')
  assert(calls.every(request => new URL(request.url).origin === 'https://platform.test' && request.credentials === 'omit' && request.redirect === 'error'))
  assert.deepEqual(await calls[0]?.json(), { username: 'alice', password: 'legacy' })
  assert.equal(calls[0]?.headers.get('authorization'), null)
  assert(calls.slice(1).filter(request => request.method === 'POST').every(request => request.headers.get('authorization') === `Bearer ${token}`))
  assert.deepEqual(await calls.at(-1)?.json(), { requestId, userId: user.userId, expectedRevision: 7 })
  client.forget()
  const count = calls.length
  await assert.rejects(client.list(undefined, signal()), error => error instanceof AccountActionError && error.problem === 'permissionLost')
  assert.equal(calls.length, count)
})

test('forced-change state omits the administrator catalog while unrestricted state uses deployment defaults', async () => {
  const restricted = fixture(() => undefined, { ...user, passwordChangeRequired: true }, true)
  const state = await restricted.client.login('alice', 'temporary', signal())
  assert.equal(state.canManage, false)
  assert.deepEqual(state.models, [])
  assert(!restricted.calls.some(request => new URL(request.url).pathname === ACCOUNT_ROUTES.models))
  const active = fixture(() => undefined)
  assert.deepEqual((await active.client.login('alice', 'legacy', signal())).initialSettings, { model: 'two', maxTokens: 1024 })
})

test('creation preserves the captured model grants and stable request on an ambiguous transport retry', async () => {
  let attempts = 0
  const { client, calls } = fixture(request => {
    if (new URL(request.url).pathname !== ACCOUNT_ROUTES.create) return undefined
    if (++attempts === 1) throw new Error('response lost')
    return Response.json({ receipt: receipt('create'), replay: true, temporaryPassword: null })
  })
  await client.login('alice', 'legacy', signal())
  const intent: AccountMutationIntent = { kind: 'create', requestId, draft: { username: 'new-user', displayName: 'New user', role: 'user',
    model: 'two', maxTokens: 1024, modelGrants: [{ id: 'two', maxTokens: 2048 }] } }
  await assert.rejects(client.mutate(intent, signal()), /response lost/u)
  assert.equal((await client.mutate(intent, signal())).temporaryPassword, undefined)
  const writes = calls.filter(request => new URL(request.url).pathname === ACCOUNT_ROUTES.create)
  const first = await writes[0]?.json()
  assert.deepEqual(first, await writes[1]?.json())
  assert.deepEqual(first, { requestId, username: 'new-user', displayName: 'New user', role: 'USER',
    settings: { model: 'two', maxTokens: 1024 }, models: [{ id: 'two', maxTokens: 2048 }] })
})

test('a temporary secret on replay and a receipt for another gesture are rejected as unconfirmed', async () => {
  const replay = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.resetPassword
    ? Response.json({ receipt: receipt(), replay: true, temporaryPassword: 'temporary-password' }) : undefined)
  await assert.rejects(replay.client.mutate(await resetIntent(replay.client), signal()))
  const wrong = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.receipt
    ? Response.json({ receipt: receipt('create') }) : undefined)
  await assert.rejects(wrong.client.lookup(await resetIntent(wrong.client), signal()), /receipt mismatch/u)
})

test('receipt lookup exposes metadata and matches the original target without retrieving a password', async () => {
  const { client, calls } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.receipt
    ? Response.json({ receipt: receipt() }) : undefined)
  const result = await client.lookup(await resetIntent(client), signal())
  assert.equal(result?.account?.userId, user.userId)
  assert.equal(result?.temporaryPassword, undefined)
  assert.deepEqual(await calls.at(-1)?.json(), { requestId })
})

test('shared validation refuses invalid password and oversized grants before any HTTP mutation', async () => {
  const { client, calls } = fixture(() => undefined)
  await client.login('alice', 'legacy', signal())
  const count = calls.length
  await assert.rejects(client.changePassword({ requestId, currentPassword: 'legacy', newPassword: 'short' }, signal()),
    error => error instanceof AccountActionError && error.problem === 'passwordRejected')
  const intent: AccountMutationIntent = { kind: 'create', requestId, draft: { username: 'new-user', displayName: 'New user', role: 'user',
    model: 'one', maxTokens: 512, modelGrants: Array.from({ length: 17 }, (_, index) => ({ id: index ? `model-${index}` : 'one', maxTokens: 512 })) } }
  await assert.rejects(client.mutate(intent, signal()), error => error instanceof AccountActionError && error.problem === 'invalidAccount')
  assert.equal(calls.length, count)
})

test('confirmed password change discards the old bearer and sends no password through the Host', async () => {
  const { client, calls } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.changePassword
    ? Response.json({ receipt: receipt('change-password'), replay: false }) : undefined)
  await client.login('alice', 'legacy', signal())
  await client.changePassword({ requestId, currentPassword: 'legacy', newPassword: 'replacement-password' }, signal())
  assert.deepEqual(await calls.at(-1)?.json(), { requestId, currentPassword: 'legacy', newPassword: 'replacement-password' })
  await assert.rejects(client.state(signal()), error => error instanceof AccountActionError && error.problem === 'permissionLost')
})

test('permission loss clears the bearer and error text never carries private server detail', async () => {
  const { client, calls } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.list
    ? Response.json({ code: 'account_forbidden', privateDetail: 'do not expose' }, { status: 403 }) : undefined)
  await client.login('alice', 'legacy', signal())
  const failure = await client.list(undefined, signal()).catch((error: unknown) => error)
  assert(failure instanceof AccountActionError && failure.problem === 'permissionLost')
  assert(!String(failure).includes('do not expose'))
  const count = calls.length
  await assert.rejects(client.state(signal()))
  assert.equal(calls.length, count)
})

test('an aborted login or failed personal-state read retains no credential', async () => {
  const controller = new AbortController()
  const aborted = fixture(request => {
    if (new URL(request.url).pathname === ACCOUNT_ROUTES.login) controller.abort()
    return undefined
  })
  await assert.rejects(aborted.client.login('alice', 'legacy', controller.signal))
  const abortedCalls = aborted.calls.length
  await assert.rejects(aborted.client.state(signal()))
  assert.equal(aborted.calls.length, abortedCalls)
  const malformed = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.me ? Response.json({ token: 'private' }) : undefined)
  await assert.rejects(malformed.client.login('alice', 'legacy', signal()))
  const count = malformed.calls.length
  await assert.rejects(malformed.client.state(signal()))
  assert.equal(malformed.calls.length, count)
})

test('bounded response parsing refuses oversized JSON before account rendering', async () => {
  const { client } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.list
    ? Response.json({ padding: 'x'.repeat(512 * 1024) }) : undefined)
  await client.login('alice', 'legacy', signal())
  await assert.rejects(client.list(undefined, signal()), /exceeds limit/u)
})
