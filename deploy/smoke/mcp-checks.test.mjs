/** Outage and recovery observations across browser and service ownership. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { createBrowserMcpChecks, createMcpSettingsNavigation, mcpChecks, McpSmokeFailure, removeMcpSmokeConnection } from './mcp-checks.mjs'
import { withStepDeadline } from './steps.mjs'

const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')

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
    async add(name, url) { events.push(['add', name, url]); return 1 },
    async registrationCount(name, signal) {
      signal.throwIfAborted(); assert.equal(name, 'owned')
      events.push(['registered-before', count]); return count
    },
    async waitRegistered(name, accepts, signal) {
      signal.throwIfAborted()
      events.push(['registered', count])
      assert.ok(accepts(count), 'registered state must satisfy the requested observation')
      return count
    },
    async invoke(tool, marker) {
      assert.equal(tool, 'mcp__owned__ping'); assert.equal(marker, fixture.marker)
      events.push('called'); fixture.calls.push('ping')
    },
    async testOnce(name) { assert.equal(name, 'owned'); events.push('tested'); count = 1; return 1 },
    async signOut() { events.push('signed out') },
    async signIn() { events.push('signed in') },
    async newConversation() { events.push('new conversation') },
    async command() { events.push('command') },
  }
  return { fixture, actions, events, signal: new AbortController().signal,
    exhaustConnection: () => {
      assert.equal(fixture.state, 'stopped'); events.push('registration-exhausted'); count = 0
    },
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

test('an exhausted zero-tool connection is recovered by testing the original connection exactly once', async () => {
  const s = scenario(), checks = s.checks()
  await checks.offline(s.signal)
  s.exhaustConnection()
  const before = s.events.length
  const observed = await checks.recover(s.signal)
  assert.deepEqual(observed, { branch: 'revoked', registeredBefore: 0, probeToolCount: 1, registeredAfter: 1, actualCallDelta: 1 })
  assert.deepEqual(s.events.slice(before), [
    ['registered-before', 0], 'restarted', 'tested', ['registered', 1], 'new conversation', 'called',
  ])
  assert.equal(s.fixture.calls.length, 2)
  await assert.rejects(checks.recover(s.signal), McpSmokeFailure)
  await assert.rejects(checks.offline(s.signal), McpSmokeFailure)
  assert.equal(s.events.filter(value => value === 'tested').length, 1)
})

test('a connection retaining its definitions recovers without waiting for a fabricated zero', async () => {
  const s = scenario(), checks = s.checks()
  const offline = await checks.offline(s.signal)
  assert.deepEqual(offline, { probeToolCount: 1, registeredToolCount: 1, actualCallDelta: 1 })
  const before = s.events.length
  const observed = await checks.recover(s.signal)
  assert.deepEqual(observed, { branch: 'retained', registeredBefore: 1, probeToolCount: 1, registeredAfter: 1, actualCallDelta: 1 })
  assert.deepEqual(s.events.slice(before), [
    ['registered-before', 1], 'restarted', 'tested', ['registered', 1], 'new conversation', 'called',
  ])
  assert.equal(s.fixture.calls.length, 2)
  assert.equal(s.events.filter(event => event === 'tested').length, 1)
  await assert.rejects(checks.recover(s.signal), McpSmokeFailure)
})

test('probe discovery, account registration and actual calls keep their separate counts', async () => {
  const s = scenario(), checks = s.checks()
  s.actions.add = async () => 3
  const offline = await checks.offline(s.signal)
  assert.deepEqual(offline, { probeToolCount: 3, registeredToolCount: 1, actualCallDelta: 1 })
  s.actions.testOnce = async () => 2
  const recovered = await checks.recover(s.signal)
  assert.deepEqual(recovered, { branch: 'retained', registeredBefore: 1, probeToolCount: 2, registeredAfter: 1, actualCallDelta: 1 })
})

test('a successful probe with zero registered tools cannot pass recovery or invoke a model', async () => {
  const s = scenario(), checks = s.checks()
  await checks.offline(s.signal)
  s.exhaustConnection()
  s.actions.testOnce = async () => { s.events.push('probe succeeded but registry unchanged'); return 1 }
  await assert.rejects(checks.recover(s.signal), /registered state/)
  assert.equal(s.fixture.calls.length, 1)
  assert.equal(s.events.filter(value => value === 'new conversation').length, 1)
})

test('retained registrations do not substitute for a probe discovering the fixture tool', async () => {
  const s = scenario(), checks = s.checks()
  await checks.offline(s.signal)
  s.actions.testOnce = async () => 0
  await assert.rejects(checks.recover(s.signal), McpSmokeFailure)
  assert.equal(s.fixture.calls.length, 1)
})

test('a probe and positive registration count cannot substitute for one real recovered invocation', async () => {
  const s = scenario(), checks = s.checks()
  await checks.offline(s.signal)
  s.actions.invoke = async () => { /* A response alone made no fixture call. */ }
  await assert.rejects(checks.recover(s.signal), McpSmokeFailure)
  assert.equal(s.fixture.calls.length, 1)
})

test('cancellation after the stopped-state observation prevents service restart', async () => {
  const s = scenario(), checks = s.checks(), abort = new AbortController()
  await checks.offline(s.signal)
  s.exhaustConnection()
  s.actions.registrationCount = async () => { abort.abort(); return 0 }
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

async function settingsPage(t, { en = false, visible = false, disabledName = false } = {}) {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const words = en
    ? { account: 'Account: fixture', settings: 'Settings', close: 'Close', title: 'MCP connections', name: 'Server name', url: 'MCP endpoint URL' }
    : { account: '账号：fixture', settings: '设置', close: '关闭', title: 'MCP 连接', name: '服务名称', url: 'MCP 服务地址' }
  await page.setContent(`<body data-opens="0" data-closes="0" data-account-clicks="0">
    <button aria-label="${words.account}" onclick="document.body.dataset.accountClicks++;
      document.getElementById('account-menu').hidden=false">Account</button>
    <div role="menu" id="account-menu" hidden><button role="menuitem" onclick="
      document.body.dataset.opens++; document.getElementById('settings').hidden=false;
      document.getElementById('account-menu').hidden=true">${words.settings}</button></div>
    <div role="dialog" data-shortcut-modal="settings" id="settings" ${visible ? '' : 'hidden'}>
      <button onclick="document.body.dataset.closes++; document.getElementById('settings').hidden=true">${words.close}</button>
      <button onclick="document.getElementById('connections').hidden=false">${words.title}</button>
      <section aria-label="${words.title}" id="connections" hidden><form>
        <label>${words.name}<input ${disabledName ? 'disabled' : ''}></label>
        <label>${words.url}<input></label>
      </form></section>
    </div></body>`)
  return page
}

for (const en of [false, true]) {
  test(`settings opens through the ${en ? 'English' : 'Chinese'} cloud account menu without reentering an open panel`, { timeout: 30000 }, async t => {
    const page = await settingsPage(t, { en })
    const navigation = createMcpSettingsNavigation(() => page, () => 5000)
    assert.equal(await page.getByRole('button', { name: /^(Settings|设置)$/ }).count(), 0)
    const modal = await navigation.open()
    assert.equal(await modal.isVisible(), true)
    await navigation.open()
    assert.equal(await page.locator('body').getAttribute('data-account-clicks'), '1')
    assert.equal(await page.locator('body').getAttribute('data-opens'), '1')
    await navigation.close()
    assert.equal(await modal.isVisible(), false)
    assert.equal(await page.locator('body').getAttribute('data-closes'), '1')
  })
}

test('a settings panel that was already open is neither reentered nor closed', { timeout: 30000 }, async t => {
  const page = await settingsPage(t, { visible: true })
  const navigation = createMcpSettingsNavigation(() => page, () => 5000)
  const modal = await navigation.open()
  await navigation.close()
  assert.equal(await modal.isVisible(), true)
  assert.equal(await page.locator('body').getAttribute('data-account-clicks'), '0')
  assert.equal(await page.locator('body').getAttribute('data-closes'), '0')
})

test('cleanup closes the opened settings panel even when connection save was never attempted', { timeout: 30000 }, async t => {
  const page = await settingsPage(t, { disabledName: true })
  page.setDefaultTimeout(100)
  const unexpected = async () => { throw new Error('No login, command or model call belongs to this failure') }
  const checks = await createBrowserMcpChecks({ getPage: () => page, remaining: () => 5000, host: '127.0.0.1',
    signOut: unexpected, signIn: unexpected, newConversation: unexpected, send: unexpected, command: unexpected })
  t.after(() => checks.close())
  await assert.rejects(checks.offline(new AbortController().signal), McpSmokeFailure)
  assert.equal(await page.locator('[data-shortcut-modal="settings"]').isVisible(), true)
  assert.equal(await checks.cleanupConnection(false), 'not-added')
  assert.equal(await page.locator('[data-shortcut-modal="settings"]').isVisible(), false)
  assert.equal(await page.locator('body').getAttribute('data-closes'), '1')
  page.setDefaultTimeout(5000)
  await page.getByRole('button', { name: /^账号：/ }).click()
  assert.equal(await page.getByRole('menuitem', { name: '设置', exact: true }).isVisible(), true)
})

test('cleanup leaves a replacement settings panel untouched', { timeout: 30000 }, async t => {
  const page = await settingsPage(t)
  const navigation = createMcpSettingsNavigation(() => page, () => 5000)
  await navigation.open()
  await page.locator('#settings').evaluate(element => element.replaceWith(element.cloneNode(true)))
  await navigation.close()
  assert.equal(await page.locator('[data-shortcut-modal="settings"]').isVisible(), true)
  assert.equal(await page.locator('body').getAttribute('data-closes'), '0')
})

test('a page replacement cannot transfer ownership to another open settings panel', { timeout: 30000 }, async t => {
  const first = await settingsPage(t), second = await settingsPage(t, { visible: true })
  let current = first
  const navigation = createMcpSettingsNavigation(() => current, () => 5000)
  await navigation.open()
  current = second
  await assert.rejects(navigation.close(), McpSmokeFailure)
  await assert.rejects(navigation.open(), McpSmokeFailure)
  for (const page of [first, second]) {
    assert.equal(await page.locator('[data-shortcut-modal="settings"]').isVisible(), true)
    assert.equal(await page.locator('body').getAttribute('data-closes'), '0')
  }
})

test('cancellation during close stays failed after the owned page is lost', { timeout: 30000 }, async t => {
  const page = await settingsPage(t)
  const navigation = createMcpSettingsNavigation(() => page, () => 5000)
  await navigation.open()
  await page.getByRole('button', { name: '关闭', exact: true }).evaluate(button => { button.disabled = true })
  await assert.rejects(withStepDeadline(() => navigation.close(), { timeoutMs: 40, cancel: () => page.close() }))
  assert.equal(page.isClosed(), true)
  await assert.rejects(navigation.close(), McpSmokeFailure)
})

test('an unconfirmed close is not clicked again', { timeout: 30000 }, async t => {
  const page = await settingsPage(t)
  let remaining = 5000
  const navigation = createMcpSettingsNavigation(() => page, () => remaining)
  await navigation.open()
  remaining = 100
  const close = page.getByRole('button', { name: '关闭', exact: true })
  await close.evaluate(button => { button.disabled = true })
  await assert.rejects(navigation.close(), { name: 'TimeoutError' })
  await close.evaluate(button => { button.disabled = false })
  await assert.rejects(navigation.close(), McpSmokeFailure)
  await assert.rejects(navigation.open(), McpSmokeFailure)
  assert.equal(await page.locator('body').getAttribute('data-opens'), '1')
  assert.equal(await page.locator('body').getAttribute('data-closes'), '0')
})
