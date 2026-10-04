import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import { AccountHttpClient, AccountHttpError, type CurrentAccount } from '../src/client/account-api.ts'
import { AccountSession, type AccountSessionOptions } from '../src/client/session-expiry.ts'

const account: CurrentAccount = { userId: '54f0f232-a068-4223-96e8-d0cff78d0f1c', username: 'alice',
  settings: { model: 'one', maxTokens: 512, revision: 1 } }
const bob: CurrentAccount = { ...account, userId: 'c432cd3b-435c-42d5-ad50-e45c43fc7414', username: 'bob' }
const login = 'https://platform.test/login'
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(client: AccountSessionOptions['client'], navigate = (_url: string) => {},
  initial: ConnectionState | undefined = 'connected', resetDocument = () => {}) {
  const listeners = new Set<() => void>()
  let state: ConnectionState | undefined = initial
  let stops = 0
  let resets = 0
  const connection: AccountSessionOptions['connection'] = {
    state: { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    stop: () => { stops++; state = undefined; for (const listener of [...listeners]) listener() },
  }
  const session = new AccountSession({ client, connection, navigate, resetDocument: () => { resets++; resetDocument() } })
  const change = (next: ConnectionState) => { state = next; for (const listener of [...listeners]) listener() }
  return { session, change, stops: () => stops, resets: () => resets, listeners: () => listeners.size }
}

test('a successful account change stops before one document reset without waiting for login configuration', async () => {
  const url = deferred<string>()
  let current = account
  let reads = 0
  const destinations: string[] = []
  const f = fixture({ loginUrl: async () => url.promise, me: async () => { reads++; return current } },
    value => destinations.push(value), 'connected', () => { assert.equal(f.stops(), 1) })
  const dispose = f.session.start()
  try {
    await settle(); current = bob; f.session.check(); await settle()
    assert.equal(f.stops(), 1)
    assert.equal(f.resets(), 1)
    assert.equal(f.session.view.getSnapshot(), undefined)
    f.session.check(); f.session.confirmExpired(); await f.session.returnToLogin()
    f.change('connecting'); await settle()
    assert.equal(f.stops(), 2)
    assert.equal(reads, 2)
    assert.equal(f.resets(), 1)
    url.resolve(login); await settle()
    assert.deepEqual(destinations, [])
  } finally { dispose(); url.resolve(login) }
})

test('a successful account change resets even when the login-address request failed', async () => {
  let current = account
  const f = fixture({ loginUrl: async () => { throw new Error('config unavailable') }, me: async () => current })
  const dispose = f.session.start()
  try {
    await settle(); current = bob; f.session.check(); await settle()
    assert.equal(f.stops(), 1)
    assert.equal(f.resets(), 1)
    assert.equal(f.session.view.getSnapshot(), undefined)
  } finally { dispose() }
})

test('settings and display-name changes for the same account retain the current document', async () => {
  let current = account
  const f = fixture({ loginUrl: async () => login, me: async () => current })
  const dispose = f.session.start()
  try {
    await settle()
    current = { ...account, username: 'alice-renamed', settings: { model: 'two', maxTokens: 1024, revision: 2 } }
    f.session.check(); await settle()
    assert.equal(f.stops(), 0)
    assert.equal(f.resets(), 0)
    assert.equal(f.session.view.getSnapshot(), undefined)
  } finally { dispose() }
})

test('a changed identity settling after disposal cannot stop or reset a document', async () => {
  const read = deferred<CurrentAccount>()
  let first = true
  const f = fixture({ loginUrl: async () => login, me: async () => {
    if (first) { first = false; return account }
    return read.promise
  } })
  const dispose = f.session.start()
  await settle(); f.session.check(); dispose(); read.resolve(bob); await settle()
  assert.equal(f.stops(), 0)
  assert.equal(f.resets(), 0)
  assert.equal(f.listeners(), 0)
})

test('a successful changed identity cannot replace the confirmed-expiry path after its read was cancelled', async () => {
  const read = deferred<CurrentAccount>()
  let first = true
  const destinations: string[] = []
  const f = fixture({ loginUrl: async () => login, me: async () => {
    if (first) { first = false; return account }
    return read.promise
  } }, value => destinations.push(value))
  const dispose = f.session.start()
  try {
    await settle(); f.session.check(); f.session.confirmExpired(); read.resolve(bob); await settle()
    assert.equal(f.stops(), 1)
    assert.equal(f.resets(), 0)
    assert.deepEqual(destinations, [login])
  } finally { dispose(); read.resolve(bob) }
})

test('confirmed identity 401 stops before one configured navigation despite repeated refusals', async () => {
  const order: string[] = []
  let valid = true
  let reads = 0
  const f = fixture({ loginUrl: async () => login, me: async () => {
    reads++; if (!valid) throw new AccountHttpError(401); return account
  } }, url => { assert.equal(f.stops(), 1); order.push(url) })
  const dispose = f.session.start()
  try {
    await settle(); valid = false; f.change('connecting'); await settle()
    f.session.confirmExpired(); f.session.check(); await settle()
    assert.equal(f.stops(), 1)
    assert.deepEqual(order, [login])
    assert.equal(reads, 2)
  } finally { dispose() }
})

test('a Connection loop activated after confirmed expiry is stopped without another redirect or identity read', async () => {
  let reads = 0
  const destinations: string[] = []
  const f = fixture({ loginUrl: async () => login, me: async () => { reads++; throw new AccountHttpError(401) } },
    url => destinations.push(url), undefined)
  const dispose = f.session.start()
  try {
    await settle()
    assert.equal(f.stops(), 1)
    f.change('connecting'); await settle()
    assert.equal(f.stops(), 2)
    assert.equal(reads, 1)
    assert.deepEqual(destinations, [login])
  } finally { dispose() }
})

test('network, server and resource refusals preserve recovery until an independent me confirms 401', async () => {
  let failure: Error | undefined = new Error('network unavailable')
  const destinations: string[] = []
  const f = fixture({ loginUrl: async () => login, me: async () => { if (failure) throw failure; return account } }, url => destinations.push(url))
  const dispose = f.session.start()
  try {
    await settle()
    for (const status of [503, 403]) {
      failure = new AccountHttpError(status); f.change('connecting'); await settle()
    }
    failure = undefined; f.change('connected'); await settle()
    assert.equal(f.stops(), 0)
    assert.equal(f.session.view.getSnapshot(), undefined)
    assert.deepEqual(destinations, [])
    failure = new AccountHttpError(401); f.change('connecting'); await settle()
    assert.equal(f.stops(), 1)
  } finally { dispose() }
})

test('a failed login-address read still stops retries and supports an explicit navigation retry', async () => {
  let available = false
  const destinations: string[] = []
  const f = fixture({ loginUrl: async () => { if (!available) throw new Error('config unavailable'); return login },
    me: async () => { throw new AccountHttpError(401) } }, url => destinations.push(url))
  const dispose = f.session.start()
  try {
    await settle()
    assert.equal(f.stops(), 1)
    assert.deepEqual(f.session.view.getSnapshot(), { findingLogin: false, loginUnavailable: true })
    available = true; await f.session.returnToLogin()
    assert.deepEqual(destinations, [login])
    assert.equal(f.stops(), 1)
  } finally { dispose() }
})

test('identity reads are serialized and a late 401 after disposal cannot stop or navigate', async () => {
  const read = deferred<CurrentAccount>()
  let reads = 0
  const destinations: string[] = []
  const f = fixture({ loginUrl: async () => login, me: async () => { reads++; return read.promise } }, url => destinations.push(url))
  const dispose = f.session.start()
  f.change('connecting'); f.change('connected')
  assert.equal(reads, 1)
  dispose(); read.reject(new AccountHttpError(401)); await settle()
  assert.equal(f.listeners(), 0)
  assert.equal(f.stops(), 0)
  assert.deepEqual(destinations, [])
})

test('a late configured URL after disposal cannot navigate an expired page', async () => {
  const url = deferred<string>()
  const destinations: string[] = []
  const f = fixture({ loginUrl: async () => url.promise, me: async () => { throw new AccountHttpError(401) } }, value => destinations.push(value))
  const dispose = f.session.start()
  await settle(); assert.equal(f.stops(), 1)
  dispose(); url.resolve(login); await settle()
  assert.deepEqual(destinations, [])
})

test('only the owned me endpoint reports identity expiry; abort and resource 401 do not report it', async () => {
  let reports = 0
  const controller = new AbortController()
  const client = new AccountHttpClient(async () => new Response('', { status: 401 }), () => { reports++ })
  await assert.rejects(client.modelsList())
  assert.equal(reports, 0)
  await assert.rejects(client.me())
  assert.equal(reports, 1)
  controller.abort(); await assert.rejects(client.me(controller.signal))
  assert.equal(reports, 1)
})

test('invalid configured navigation cannot replace the page after identity expiry', async () => {
  const destinations: string[] = []
  const client = new AccountHttpClient(async input => String(input).endsWith('/config')
    ? Response.json({ loginUrl: 'javascript:alert(1)' }) : new Response('', { status: 401 }))
  const f = fixture(client, value => destinations.push(value))
  const dispose = f.session.start()
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.stops(), 1)
    assert.deepEqual(destinations, [])
    assert.deepEqual(f.session.view.getSnapshot(), { findingLogin: false, loginUnavailable: true })
  } finally { dispose() }
})
