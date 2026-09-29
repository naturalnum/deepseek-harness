/** Verify two native Web users' fixed process MCP connections and real model calls. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const privateDir = process.env.PE_PRIVATE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
const kubeContext = process.env.PE_KUBE_CONTEXT
if (!privateDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort) || !kubeContext) {
  throw new Error('Set PE_PRIVATE_DIR, PE_HOST_PORT, PE_PLATFORM_PORT and PE_KUBE_CONTEXT')
}
const hostOrigin = `http://127.0.0.1:${hostPort}`
const platformOrigin = `http://127.0.0.1:${platformPort}`
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8'))
const ssh = JSON.parse(await readFile(join(privateDir, 'ssh.json'), 'utf8'))
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
assert.deepEqual(users.slice(0, 2).map(user => user.username), ['alice', 'bob'])
assert.match(ssh.namespace, /^pe-connector-qa-[a-f0-9]{8}$/u)

async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: response.ok ? await response.json() : null }
  }, { name, request })
}

function runnerPodNames() {
  const result = spawnSync('kubectl', ['--context', kubeContext, '-n', ssh.namespace,
    'get', 'pods', '-l', 'app.kubernetes.io/name=power-evolve-connector-runner', '-o', 'name'],
  { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Could not list isolated Runner Pods')
  return result.stdout.trim().split('\n').filter(Boolean)
}

function runnerResources() {
  const result = spawnSync('kubectl', ['--context', kubeContext, '-n', ssh.namespace,
    'get', 'pods,secrets,services,networkpolicies', '-o', 'json'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Could not list isolated Runner resources')
  return JSON.parse(result.stdout).items.filter(item => item.metadata.name.startsWith('pe-mcp-'))
}

async function eventually(probe, accept, label, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs
  let last
  while (Date.now() < until) {
    last = await probe()
    if (accept(last)) return last
    await delay(500)
  }
  throw new Error(`${label} timed out; last state: ${JSON.stringify(last)}`)
}

async function callEvidence(db, callId) {
  const result = await db.query(`SELECT u.username,c.id,c.state,c.result,c.pod_uid,c.runner_instance_id,
    c.dispatch_digest,c.cleanup_complete,c.operation_id,o.session_id,o.state AS original_state,
    r.id AS continuation_id,r.session_id AS continuation_session_id,r.state AS continuation_state
    FROM pe_stdio_mcp_calls c JOIN pe_users u ON u.id=c.user_id
    JOIN pe_operations o ON o.id=c.operation_id
    LEFT JOIN pe_operations r ON r.source_stdio_mcp_call_id=c.id WHERE c.id=$1`, [callId])
  return result.rows[0]
}

async function runConversation({ user, page }, db, priorIds) {
  await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 20_000 })
  await composer.fill('Please call mcp__stdio__whoami exactly once for my account. After its result arrives in this same conversation, report the exact returned value.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const call = await eventually(async () => {
    const response = await rpc(page, 'stdioMcpCalls', {})
    assert.equal(response.status, 200)
    return response.body.items.find(item => !priorIds.has(item.callId))
  }, Boolean, `${user.username} real-model tool call`)
  priorIds.add(call.callId)
  const other = sessions.find(session => session.user.username !== user.username)
  const denied = await rpc(other.page, 'stdioMcpStatus', { callId: call.callId })
  assert.equal(denied.status, 404)
  const finished = await eventually(async () => {
    const response = await rpc(page, 'stdioMcpStatus', { callId: call.callId })
    assert.equal(response.status, 200)
    return response.body
  }, value => ['succeeded', 'failed', 'uncertain'].includes(value.state), `${user.username} process result`)
  assert.equal(finished.state, 'succeeded', `${user.username}: ${JSON.stringify(finished)}`)
  const expectedId = (await db.query('SELECT id FROM pe_users WHERE username=$1', [user.username])).rows[0].id
  assert.equal(finished.result, `user:${expectedId}`)
  const evidence = await eventually(() => callEvidence(db, call.callId),
    row => row?.continuation_state === 'completed' && row.cleanup_complete,
    `${user.username} same-Session continuation and cleanup`)
  assert.equal(evidence.username, user.username)
  assert.equal(evidence.state, 'succeeded')
  assert.equal(evidence.result, finished.result)
  assert.ok(evidence.pod_uid && evidence.runner_instance_id && evidence.dispatch_digest)
  assert.equal(evidence.continuation_session_id, evidence.session_id)
  assert.equal(evidence.original_state, 'completed')
  await eventually(async () => (await page.locator('body').innerText()).includes(finished.result),
    Boolean, `${user.username} native transcript result`, 30_000)
  await page.reload()
  await eventually(async () => (await page.locator('body').innerText()).includes(finished.result),
    Boolean, `${user.username} refreshed native transcript`, 30_000)
  console.log(`${user.username}: isolated Runner ${evidence.pod_uid}, ${finished.result}, same Session ${evidence.session_id}, refreshed transcript`)
  return { callId: call.callId, sessionId: evidence.session_id, result: finished.result }
}

const db = new Client({ connectionString: databaseUrl })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
const sessions = []
try {
  assert.equal(runnerPodNames().length, 0)
  assert.equal(runnerResources().length, 0)
  for (const user of users.slice(0, 2)) {
    const context = await browser.newContext()
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(`${platformOrigin}/login`)
    await page.getByRole('textbox', { name: '账号' }).fill(user.username)
    await page.getByRole('textbox', { name: '密码' }).fill(user.password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`${hostOrigin}/native/**`, { timeout: 20_000 })
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    const workspaceName = `qa-stdio-${user.username}`
    if (await page.getByText(workspaceName, { exact: true }).count() > 0) {
      await page.getByText(workspaceName, { exact: true }).last().click()
    } else {
      await page.getByText('Add workspace…', { exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'New cloud Workspace' })
      await dialog.getByRole('textbox', { name: 'Workspace name' }).fill(workspaceName)
      await dialog.getByRole('button', { name: 'Create' }).click()
    }
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20_000 })
    await page.getByText('Plugins', { exact: true }).first().click()
    await page.getByRole('tab', { name: /All plugins/u }).click()
    await page.locator('[data-plugin-id="stdio"] button').first().click()
    const name = `qa-stdio-${user.username}`
    const beforeInstall = await rpc(page, 'stdioMcpList', {})
    assert.equal(beforeInstall.status, 200)
    if (beforeInstall.body.items.length === 0) {
      await page.getByRole('textbox', { name: 'Connection name' }).fill(name)
      await page.getByRole('button', { name: 'Install connection' }).click()
      await page.getByRole('switch', { name: `${name} Enable plugin` }).waitFor({ timeout: 20_000 })
    }
    const toggle = page.getByRole('switch', { name: `${name} Enable plugin` })
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    await toggle.click()
    await page.waitForFunction(name => document.querySelector(`[aria-label="${name} Enable plugin"]`)?.getAttribute('aria-checked') === 'false', name)
    await toggle.click()
    await page.waitForFunction(name => document.querySelector(`[aria-label="${name} Enable plugin"]`)?.getAttribute('aria-checked') === 'true', name)
    const listed = await rpc(page, 'stdioMcpList', {})
    assert.equal(listed.status, 200)
    assert.equal(listed.body.items.length, 1)
    assert.equal(listed.body.items[0].name, name)
    assert.equal(listed.body.items[0].enabled, true)
    const calls = await rpc(page, 'stdioMcpCalls', {})
    assert.equal(calls.status, 200)
    sessions.push({ user, page, connection: listed.body.items[0], priorIds: new Set(calls.body.items.map(call => call.callId)) })
    console.log(`${user.username}: installed, disabled and re-enabled fixed Process MCP in native Plugins`)
  }
  assert.notEqual(sessions[0].connection.connectionId, sessions[1].connection.connectionId)
  for (const [index, { page }] of sessions.entries()) {
    const other = sessions[1 - index].connection
    const cross = await rpc(page, 'stdioMcpToggle', { connectionId: other.connectionId,
      requestId: randomUUID(), baseRevision: other.revision, enabled: false })
    assert.equal(cross.status, 404)
  }
  assert.equal(runnerPodNames().length, 0)
  console.log('Connection metadata and cross-user toggle isolation verified; no Runner Pod before a tool call')
  const outcomes = []
  for (const session of sessions) outcomes.push(await runConversation(session, db, session.priorIds))
  assert.notEqual(outcomes[0].sessionId, outcomes[1].sessionId)
  await eventually(() => runnerResources(), items => items.length === 0, 'Runner resource cleanup', 30_000)
  console.log('Both users: separate sessions and Pods; no Runner resources after durable cleanup')
  if (process.env.PE_STDIO_RESTART === '1') {
    if (!process.env.PE_TRIAL_NAME || !process.env.PE_DATABASE_PORT
      || !process.env.PE_TARGET_PORT || !process.env.PE_COMPOSE_EXTERNAL_NETWORK
      || process.env.PE_PRIVATE_DIR !== privateDir || process.env.PE_SSH_ENABLED !== '1') {
      throw new Error('Restart requires the complete isolated trial environment')
    }
    const restart = spawnSync(process.execPath,
      [fileURLToPath(new URL('./trial.mjs', import.meta.url)), 'restart'],
      { env: process.env, stdio: 'inherit', timeout: 120_000 })
    if (restart.status !== 0) throw new Error('Isolated trial restart failed')
    for (const [index, { page, connection }] of sessions.entries()) {
      const outcome = outcomes[index]
      await page.reload()
      await eventually(async () => (await page.locator('body').innerText()).includes(outcome.result),
        Boolean, `${users[index].username} post-restart transcript`, 30_000)
      const calls = await rpc(page, 'stdioMcpCalls', {})
      assert.equal(calls.status, 200)
      assert.deepEqual(calls.body.items.filter(call => call.callId === outcome.callId),
        [{ callId: outcome.callId, state: 'succeeded', result: outcome.result }])
      const listed = await rpc(page, 'stdioMcpList', {})
      assert.equal(listed.status, 200)
      assert.equal(listed.body.items[0].connectionId, connection.connectionId)
      assert.equal(listed.body.items[0].revision, connection.revision)
      assert.equal(listed.body.items[0].enabled, true)
      const evidence = await callEvidence(db, outcome.callId)
      assert.equal(evidence.session_id, outcome.sessionId)
      assert.equal(evidence.continuation_session_id, outcome.sessionId)
      assert.equal(evidence.continuation_state, 'completed')
    }
    assert.equal(runnerResources().length, 0)
    console.log('Both users: same conversation, connection revision and call result survived isolated trial restart')
  }
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
  await db.end()
}
