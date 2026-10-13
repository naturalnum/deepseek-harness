import { responseRecord } from './fetch-fixture.ts'
import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { ACCOUNT_ROUTES, ACCOUNT_ERROR_CODES, accountValue } from '@power-evolve/contracts/account'
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
const receipt = (kind: 'reset-password' | 'create' | 'change-password' | 'update' | 'delete' = 'reset-password') =>
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
  const { client, calls } = fixture((request) => {
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
  const first: unknown = await writes[0]?.json()
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
  const aborted = fixture((request) => {
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test.each([
  [ACCOUNT_ERROR_CODES.revisionConflict, 409, 'revisionConflict'],
  [ACCOUNT_ERROR_CODES.requestConflict, 409, 'revisionConflict'],
  [ACCOUNT_ERROR_CODES.lastAdministrator, 409, 'lastAdmin'],
  [ACCOUNT_ERROR_CODES.notEmpty, 409, 'accountNotEmpty'],
  [ACCOUNT_ERROR_CODES.executionActive, 409, 'accountNotEmpty'],
  [ACCOUNT_ERROR_CODES.currentPasswordInvalid, 400, 'passwordRejected'],
  [ACCOUNT_ERROR_CODES.passwordInvalid, 400, 'passwordRejected'],
  [ACCOUNT_ERROR_CODES.modelNotAuthorized, 403, 'invalidAccount'],
  [ACCOUNT_ERROR_CODES.usernameConflict, 409, 'invalidAccount'],
  [ACCOUNT_ERROR_CODES.limit, 429, 'invalidAccount'],
  ['', 400, 'invalidAccount'], ['', 404, 'invalidAccount'], ['', 409, 'invalidAccount'], ['', 429, 'invalidAccount'],
  ['', 401, 'permissionLost'], ['', 403, 'permissionLost'],
] as const)('maps public refusal %s/%i without server detail', async (code, status, problem) => {
  const { client } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.list
    ? Response.json({ code, private: 'secret' }, { status }) : undefined)
  await client.login('alice', 'legacy', signal())
  await assert.rejects(client.list(undefined, signal()), error => error instanceof AccountActionError && error.problem === problem && !String(error).includes('secret'))
})

test.each([null, 'unexpected', { code: 5 }])('keeps an unrecognized failure unconfirmed: %j', async (body) => {
  const { client } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.list
    ? Response.json(body, { status: 502 }) : undefined)
  await client.login('alice', 'legacy', signal())
  await assert.rejects(client.list(undefined, signal()), /unconfirmed/u)
})

test.each([401, 403])('forgets the bearer when %i has an unreadable body', async (status) => {
  const { client, calls } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.list
    ? new Response('not-json', { status }) : undefined)
  await client.login('alice', 'legacy', signal())
  await assert.rejects(client.list(undefined, signal()), error => error instanceof AccountActionError && error.problem === 'permissionLost')
  const count = calls.length
  await assert.rejects(client.changePassword({ requestId, currentPassword: 'old', newPassword: 'new-password-long' }, signal()))
  assert.equal(calls.length, count)
})

test('valid USER identity has no administrator catalog and server rejects its management request', async () => {
  const { client, calls } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.list
    ? Response.json({ code: 'account_forbidden' }, { status: 403 }) : undefined, { ...user, role: 'USER' })
  const state = await client.login('alice', 'legacy', signal())
  assert.equal(state.account.role, 'user'); assert.equal(state.canManage, false)
  assert(!calls.some(request => new URL(request.url).pathname === ACCOUNT_ROUTES.models))
  await assert.rejects(client.list(undefined, signal()), error => error instanceof AccountActionError && error.problem === 'permissionLost')
})

test('update, removal, pagination, absent receipt and logout use the original account identity', async () => {
  const { client, calls } = fixture((request) => {
    const route = new URL(request.url).pathname
    if (route === ACCOUNT_ROUTES.list) return Response.json({ items: [user], nextCursor: null })
    if (route === ACCOUNT_ROUTES.receipt) return Response.json({ receipt: null })
    if (route === ACCOUNT_ROUTES.update) return Response.json({ receipt: receipt('update'), replay: false })
    if (route === ACCOUNT_ROUTES.remove) return Response.json({ receipt: receipt('delete'), replay: false })
    if (route === ACCOUNT_ROUTES.logout) return Response.json({ ok: true })
    return undefined
  })
  const state = await client.login('alice', 'legacy', signal())
  await client.list(user.userId, signal())
  assert.deepEqual(await calls.at(-1)?.json(), { cursor: user.userId, limit: 30 })
  for (const role of ['admin', 'user'] as const) {
    const intent: AccountMutationIntent = { kind: 'update', requestId, account: state.account, displayName: 'Updated', role, enabled: false }
    assert.equal((await client.mutate(intent, signal())).account?.userId, user.userId)
    assert.equal((await responseRecord(calls.at(-1))).role, role === 'admin' ? 'ADMIN' : 'USER')
    assert.equal(await client.lookup(intent, signal()), null)
  }
  await client.mutate({ kind: 'remove', requestId, account: state.account }, signal())
  await client.logout(signal())
  await assert.rejects(client.state(signal()), AccountActionError)
})

test.each([
  { requestId: '3e714ec8-d5dc-46e4-b68b-cdfc11674001' },
  { account: { ...user, userId: '3e714ec8-d5dc-46e4-b68b-cdfc11674001' } },
])('rejects a structurally valid receipt for another gesture or target: %j', async (patch) => {
  const { client } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.resetPassword
    ? Response.json({ receipt: { ...receipt(), ...patch }, replay: true, temporaryPassword: null }) : undefined)
  await assert.rejects(client.mutate(await resetIntent(client), signal()), /receipt mismatch/u)
})

test.each(['file:///tmp/', 'https://u:p@platform.test/', 'https://platform.test/account', 'https://platform.test/?q=1'])('refuses invalid Platform origin %s', (origin) => {
  assert.throws(() => new TrustedAccountHttpClient(origin), /Invalid account origin/u)
})

test.each([new Response(null), new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream failure')) } }))])('rejects missing or interrupted JSON bodies', async (response) => {
  const { client } = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.list ? response : undefined)
  await client.login('alice', 'legacy', signal())
  await assert.rejects(client.list(undefined, signal()))
})

test.each([null, {}, { hostUrl: 7 }, { hostUrl: 'file:///tmp/' }, { hostUrl: 'https://u:p@host.test/' }])('rejects invalid product navigation %j before exposing a session', async (config) => {
  const { client } = fixture(request => new URL(request.url).pathname === '/config' ? Response.json(config) : undefined)
  await assert.rejects(client.login('alice', 'legacy', signal()), /Invalid product/u)
})

test('refuses unavailable navigation and an unexpected personal identity', async () => {
  const offline = fixture(request => new URL(request.url).pathname === '/config' ? new Response(null, { status: 503 }) : undefined)
  await assert.rejects(offline.client.login('alice', 'legacy', signal()), /unavailable/u)
  const changed = fixture(request => new URL(request.url).pathname === ACCOUNT_ROUTES.me
    ? Response.json({ user: { ...user, userId: '3e714ec8-d5dc-46e4-b68b-cdfc11674001' }, restricted: false }) : undefined)
  await assert.rejects(changed.client.login('alice', 'legacy', signal()), /identity mismatch/u)
})

test('the default transport resolves fetch at call time', async () => {
  const fetch = vi.fn(async () => new Response('denied', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  await assert.rejects(new TrustedAccountHttpClient('https://platform.test').login('alice', 'password', signal()), AccountActionError)
  assert.equal(fetch.mock.calls.length, 1)
})

test('administrator creation and each receipt kind preserve the original gesture', async () => {
  let kind: 'create' | 'update' | 'delete' = 'create'
  const { client, calls } = fixture((request) => {
    const route = new URL(request.url).pathname
    if (route === ACCOUNT_ROUTES.create) return Response.json({ receipt: receipt('create'), replay: true, temporaryPassword: null })
    if (route === ACCOUNT_ROUTES.receipt) return Response.json({ receipt: receipt(kind) })
    return undefined
  })
  const state = await client.login('alice', 'legacy', signal())
  const creation: AccountMutationIntent = { kind: 'create', requestId, draft: { username: 'new-admin', displayName: 'New admin',
    role: 'admin', model: 'one', maxTokens: 512, modelGrants: [{ id: 'one', maxTokens: 512 }] } }
  await client.mutate(creation, signal())
  assert.equal((await responseRecord(calls.at(-1))).role, 'ADMIN')
  assert.equal((await client.lookup(creation, signal()))?.account?.userId, user.userId)
  kind = 'update'
  await client.lookup({ kind: 'update', requestId, account: state.account, displayName: 'Updated', role: 'user', enabled: true }, signal())
  kind = 'delete'
  await client.lookup({ kind: 'remove', requestId, account: state.account }, signal())
})
