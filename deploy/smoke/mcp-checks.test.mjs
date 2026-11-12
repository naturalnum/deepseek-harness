/** Outage and recovery observations across browser and service ownership. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mcpChecks, McpSmokeFailure, removeMcpSmokeConnection } from './mcp-checks.mjs'

function scenario() {
  const events = []
  const fixture = {
    state: 'running', url: 'http://127.0.0.1:12345/mcp', marker: 'owned-marker', calls: [],
    async stop() { events.push('stopped'); fixture.state = 'stopped' },
    async restart() { events.push('restarted'); fixture.state = 'running' },
    async close() { await fixture.stop() },
  }
  let count = 1
  const actions = {
    async add(name, url) { events.push(['add', name, url]) },
    async waitRegistered(name, accepts, signal) {
      signal.throwIfAborted()
      events.push(['registered', count])
      assert.ok(accepts(count), 'registered state must satisfy the requested observation')
    },
    async invoke(tool, marker) {
      assert.equal(tool, 'mcp__owned__ping'); assert.equal(marker, fixture.marker)
      events.push('called'); fixture.calls.push('ping')
    },
    async testOnce(name) { assert.equal(name, 'owned'); events.push('tested'); count = 1 },
    async signOut() { events.push('signed out'); count = 0 },
    async signIn() { events.push('signed in') },
    async newConversation() { events.push('new conversation') },
    async command() { events.push('command') },
  }
  return { fixture, actions, events, signal: new AbortController().signal,
    checks: () => mcpChecks(fixture, actions, 'owned') }
}

test('logout waits for confirmed service shutdown, not a stop request', async () => {
  const s = scenario(), entered = Promise.withResolvers(), released = Promise.withResolvers()
  s.fixture.stop = async () => {
    s.fixture.state = 'stopping'; entered.resolve(); await released.promise
    s.fixture.state = 'stopped'; s.events.push('stopped')
  }
  const checks = s.checks()
  const result = checks.offline(s.signal)
  try {
    await entered.promise
    assert.ok(!s.events.includes('signed out'))
  } finally { released.resolve() }
  await result
  assert.ok(s.events.indexOf('stopped') < s.events.indexOf('signed out'))
  assert.equal(s.events.at(-1), 'command')
})

test('tool text without one actual server call cannot establish the outage precondition', async () => {
  const s = scenario()
  s.actions.invoke = async () => { /* A fabricated model response made no service call. */ }
  const checks = s.checks()
  await assert.rejects(checks.offline(s.signal), McpSmokeFailure)
  assert.equal(s.fixture.state, 'running')
  assert.ok(!s.events.includes('signed out'))
  await assert.rejects(checks.recover(s.signal), McpSmokeFailure)
})

test('recovery observes zero while stopped and tests the original connection exactly once', async () => {
  const s = scenario(), checks = s.checks()
  await checks.offline(s.signal)
  const before = s.events.length
  await checks.recover(s.signal)
  assert.deepEqual(s.events.slice(before), [
    ['registered', 0], 'restarted', 'tested', ['registered', 1], 'new conversation', 'called',
  ])
  assert.equal(s.fixture.calls.length, 2)
  await assert.rejects(checks.recover(s.signal), McpSmokeFailure)
  await assert.rejects(checks.offline(s.signal), McpSmokeFailure)
  assert.equal(s.events.filter(value => value === 'tested').length, 1)
})

test('a successful probe with zero registered tools cannot pass recovery or invoke a model', async () => {
  const s = scenario(), checks = s.checks()
  await checks.offline(s.signal)
  s.actions.testOnce = async () => { s.events.push('probe succeeded but registry unchanged') }
  await assert.rejects(checks.recover(s.signal), /registered state/)
  assert.equal(s.fixture.calls.length, 1)
  assert.equal(s.events.filter(value => value === 'new conversation').length, 1)
})

test('cancellation after the stopped-state observation prevents service restart', async () => {
  const s = scenario(), checks = s.checks(), abort = new AbortController()
  await checks.offline(s.signal)
  s.actions.waitRegistered = async (_name, accepts) => { assert.ok(accepts(0)); abort.abort() }
  await assert.rejects(checks.recover(abort.signal), { name: 'AbortError' })
  assert.equal(s.fixture.state, 'stopped')
  assert.ok(!s.events.includes('restarted'))
})

test('a fresh workflow cannot recover another run or connection', async () => {
  const s = scenario()
  await s.checks().offline(s.signal)
  await assert.rejects(s.checks().recover(s.signal), McpSmokeFailure)
  assert.ok(!s.events.includes('restarted'))
})

test('cleanup before any attempted save does not read or change account connections', async () => {
  const unexpected = async () => { throw new Error('Account access was not expected') }
  assert.equal(await removeMcpSmokeConnection({ saveAttempted: false, authenticated: false,
    name: 'owned', url: 'http://127.0.0.1:12345/mcp', find: unexpected, remove: unexpected }), 'not-added')
})

test('cleanup does not create a new login or access account state when login is unconfirmed', async () => {
  let reads = 0, removes = 0
  await assert.rejects(removeMcpSmokeConnection({ saveAttempted: true, authenticated: false,
    name: 'owned', url: 'owned-url', find: async () => { reads++; return [] }, remove: async () => { removes++ } }), McpSmokeFailure)
  assert.equal(reads, 0); assert.equal(removes, 0)
})

test('cleanup refuses changed names, changed endpoints and ambiguous rows without removing anything', async () => {
  for (const candidates of [
    [{ name: 'another-run', url: 'owned-url' }], [{ name: 'owned', url: 'another-endpoint' }],
    [{ name: 'owned', url: 'owned-url' }, { name: 'owned', url: 'owned-url' }],
  ]) {
    let removes = 0
    await assert.rejects(removeMcpSmokeConnection({ saveAttempted: true, authenticated: true,
      name: 'owned', url: 'owned-url', find: async () => candidates, remove: async () => { removes++ } }), McpSmokeFailure)
    assert.equal(removes, 0)
  }
})

test('cleanup distinguishes confirmed absence from removing the one exact owned connection', async () => {
  let removes = 0
  const input = { saveAttempted: true, authenticated: true, name: 'owned', url: 'owned-url', remove: async () => { removes++ } }
  assert.equal(await removeMcpSmokeConnection({ ...input, find: async () => [] }), 'absent')
  assert.equal(removes, 0)
  assert.equal(await removeMcpSmokeConnection({ ...input, find: async () => [{ name: 'owned', url: 'owned-url' }] }), 'removed')
  assert.equal(removes, 1)
})

test('an unconfirmed removal fails without retrying or reporting cleanup success', async () => {
  let removes = 0
  const failure = new Error('Removal outcome unknown')
  await assert.rejects(removeMcpSmokeConnection({ saveAttempted: true, authenticated: true, name: 'owned', url: 'owned-url',
    find: async () => [{ name: 'owned', url: 'owned-url' }], remove: async () => { removes++; throw failure } }), error => error === failure)
  assert.equal(removes, 1)
})
