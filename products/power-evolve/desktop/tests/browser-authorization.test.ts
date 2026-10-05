/** Account/document races and failed cleanup with controlled resource operations, without Electron or PG. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-desktop/assembly'
import { desktopBrowserScopeRequest, desktopBrowserScopeView, type DesktopBrowserScopeView } from '@power-evolve/contracts/desktop-browser-scope'
import { CloudBrowserAuthorization, type CloudBrowserAuthorizationOptions } from '../src/browser-authorization.ts'

const userA = randomUUID(), userB = randomUUID(), workspaceA = randomUUID(), workspaceB = randomUUID()
const sessionA = randomUUID(), sessionB = randomUUID(), sessionA2 = randomUUID()
const request = (sessionId = sessionA) => desktopBrowserScopeRequest.parse({ sessionId })
const scope = (sessionId = sessionA, userId = userA, workspaceId = workspaceA) => desktopBrowserScopeView.parse({ sessionId, userId, workspaceId })
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('membership identifiers canonicalize UUID casing and reject caller-selected owner fields', () => {
  assert.deepEqual(desktopBrowserScopeView.parse({ sessionId: sessionA.toUpperCase(), userId: userA.toUpperCase(), workspaceId: workspaceA.toUpperCase() }), scope())
  assert.throws(() => desktopBrowserScopeRequest.parse({ sessionId: sessionA, userId: userB }))
})

function fixture(overrides: Partial<CloudBrowserAuthorizationOptions> = {}) {
  const acquired: string[] = [], retired: string[] = [], released: string[] = [], requested: string[] = []
  let next = 0
  const options: CloudBrowserAuthorizationOptions = {
    config: { scopeRequestTimeoutMs: 1000, scopeRecheckIntervalMs: 1000 },
    resources: {
      acquire(key) { acquired.push(key); return { lease: `fixture-${++next}` as DesktopBrowserLeaseId, partition: key } },
      async release(lease) { released.push(lease) },
      async retireWorkspace(key) { retired.push(key) },
    },
    assertDocument: () => {}, onCleanupFailure: () => {},
    requestScope: async value => { requested.push(value.sessionId); return scope(value.sessionId) },
    ...overrides,
  }
  return { controller: new CloudBrowserAuthorization(options), options, acquired, retired, released, requested }
}

test('same account Workspace shares storage while different owned Workspace IDs do not', async t => {
  const f = fixture({ requestScope: async value => scope(value.sessionId, userA, value.sessionId === sessionB ? workspaceB : workspaceA) })
  t.after(() => f.controller.dispose())
  const first = await f.controller.acquire(request()), second = await f.controller.acquire(request(sessionA2))
  const other = await f.controller.acquire(request(sessionB))
  assert.equal(first.partition, second.partition)
  assert.notEqual(first.partition, other.partition)
  assert.notEqual(first.lease, second.lease)
  await f.controller.release(first.lease)
  await f.controller.release(first.lease)
  await f.controller.release('foreign-lease')
  assert.deepEqual(f.released, [first.lease])
})

test('invalidation immediately retires guest storage and new admission waits for actual cleanup', async t => {
  const cleanup = Promise.withResolvers<void>(), f = fixture()
  f.options.resources.retireWorkspace = key => { f.retired.push(key); return cleanup.promise }
  t.after(() => f.controller.dispose())
  await f.controller.acquire(request())
  const oldKey = f.acquired[0], invalidated = f.controller.invalidate()
  assert.deepEqual(f.retired, [oldKey], 'resource retirement begins before invalidate returns')
  const pending = f.controller.acquire(request())
  await delay(10)
  assert.equal(f.requested.length, 1)
  cleanup.resolve(); await invalidated
  const next = await pending
  assert.notEqual(next.partition, oldKey)
})

test('A to B to A changes reject late A responses and never create old reservations', async t => {
  const old = Promise.withResolvers<DesktopBrowserScopeView>()
  let count = 0
  const f = fixture({ requestScope: async value => ++count === 1 ? old.promise : scope(value.sessionId) })
  t.after(() => f.controller.dispose())
  const first = assert.rejects(f.controller.acquire(request()), /interrupted/u)
  await delay(1)
  await f.controller.invalidate(); await f.controller.invalidate()
  const current = await f.controller.acquire(request())
  old.resolve(scope())
  await first; await delay(1)
  assert.equal(f.acquired.length, 1)
  assert.equal(f.acquired[0], current.partition)
})

test('a changed account observed without a cookie event retires previous user storage', async t => {
  let user = userA
  const f = fixture({ requestScope: async value => scope(value.sessionId, user) })
  t.after(() => f.controller.dispose())
  const first = await f.controller.acquire(request())
  user = userB
  await assert.rejects(f.controller.acquire(request(sessionB)), /account changed/u)
  assert.deepEqual(f.retired, [first.partition])
  const next = await f.controller.acquire(request(sessionB))
  assert.notEqual(first.partition, next.partition)
})

test('failed storage cleanup keeps admission closed; retry must finish before fresh authorization', async t => {
  let blocked = true
  const f = fixture()
  f.options.resources.retireWorkspace = async key => { f.retired.push(key); if (blocked) throw new Error('clear failed') }
  t.after(() => f.controller.dispose())
  await f.controller.acquire(request())
  await assert.rejects(f.controller.invalidate(), /cleanup incomplete/u)
  await assert.rejects(f.controller.acquire(request()), /cleanup incomplete/u)
  assert.equal(f.requested.length, 1)
  blocked = false
  await f.controller.acquire(request())
  assert.equal(f.requested.length, 2)
  assert.equal(f.retired.length, 3)
})

test('authorization denial or service failure retires active guests and requires a new observation', async t => {
  let available = true
  const f = fixture({ requestScope: async value => {
    if (!available) throw new Error('denied or unavailable')
    return scope(value.sessionId)
  } })
  t.after(() => f.controller.dispose())
  const first = await f.controller.acquire(request())
  available = false
  await assert.rejects(f.controller.acquire(request(sessionA2)), /unavailable/u)
  assert.deepEqual(f.retired, [first.partition])
  available = true
  assert.notEqual((await f.controller.acquire(request())).partition, first.partition)
})

test('active guest rechecks detect unchanged-cookie membership revocation and stop polling after cleanup', async t => {
  let observations = 0
  const retired = Promise.withResolvers<void>()
  const f = fixture({ config: { scopeRequestTimeoutMs: 1000, scopeRecheckIntervalMs: 5 }, requestScope: async value => {
    if (++observations > 1) throw new Error('membership revoked')
    return scope(value.sessionId)
  } })
  f.options.resources.retireWorkspace = async key => { f.retired.push(key); retired.resolve() }
  t.after(() => f.controller.dispose())
  await f.controller.acquire(request())
  await Promise.race([retired.promise, delay(1000).then(() => { throw new Error('recheck did not retire') })])
  await delay(25)
  assert.equal(observations, 2)
  assert.equal(f.retired.length, 1)
})

test('pending membership observations have a bounded deadline and cannot survive disposal', async () => {
  const f = fixture({ config: { scopeRequestTimeoutMs: 5, scopeRecheckIntervalMs: 1000 },
    requestScope: () => new Promise(() => {}) })
  const keepAlive = setTimeout(() => {}, 1000)
  try { await assert.rejects(f.controller.acquire(request()), /interrupted/u) }
  finally { clearTimeout(keepAlive) }
  await f.controller.dispose()
  await assert.rejects(f.controller.acquire(request()), /stale/u)
  assert.deepEqual(f.acquired, [])
})

test('changed document after response and mismatched Session never produce a reservation', async t => {
  let allowed = true
  const f = fixture({ assertDocument: () => { if (!allowed) throw new Error('foreign document') },
    requestScope: async () => { allowed = false; return scope() } })
  t.after(() => f.controller.dispose())
  await assert.rejects(f.controller.acquire(request()), /foreign document/u)
  assert.deepEqual(f.acquired, [])
  const mismatched = fixture({ requestScope: async () => scope(sessionB) })
  t.after(() => mismatched.controller.dispose())
  await assert.rejects(mismatched.controller.acquire(request()), /mismatched/u)
  assert.deepEqual(mismatched.acquired, [])
})
