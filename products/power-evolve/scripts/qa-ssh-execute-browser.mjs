/** Native two-user SSH proposal, trusted approval, Runner and Session acceptance. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const privateDir = process.env.PE_PRIVATE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
const kubeContext = process.env.PE_KUBE_CONTEXT
if (!privateDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort) || !kubeContext) {
  throw new Error('Set PE_PRIVATE_DIR, PE_HOST_PORT, PE_PLATFORM_PORT and PE_KUBE_CONTEXT')
}
if (process.env.PE_SSH_QA_VERIFY_ONLY === '1' && process.env.PE_SSH_QA_VERIFY_PRIOR !== '1') {
  throw new Error('PE_SSH_QA_VERIFY_ONLY requires PE_SSH_QA_VERIFY_PRIOR=1')
}
const hostOrigin = `http://127.0.0.1:${hostPort}`
const platformOrigin = `http://127.0.0.1:${platformPort}`
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).slice(0, 2)
const ssh = JSON.parse(await readFile(join(privateDir, 'ssh.json'), 'utf8'))
assert.deepEqual(users.map(user => user.username), ['alice', 'bob'])
const db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
const sessions = []

async function eventually(probe, accept, label, timeoutMs = 150_000) {
  const until = Date.now() + timeoutMs
  let last
  while (Date.now() < until) {
    last = await probe()
    if (accept(last)) return last
    await delay(500)
  }
  throw new Error(`${label} timed out; last state: ${JSON.stringify(last)}`)
}
async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: response.ok ? await response.json() : null }
  }, { name, request })
}
async function approvalRpc(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${sessionStorage.getItem('pe-approval-token')}` }, body: JSON.stringify(body) })
    return { status: response.status, body: response.ok ? await response.json() : null }
  }, { path, body })
}
function runnerResources() {
  const result = spawnSync('kubectl', ['--context', kubeContext, '-n', ssh.namespace,
    'get', 'pods,secrets,services,networkpolicies', '-o', 'json'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Could not list isolated Runner resources')
  return JSON.parse(result.stdout).items.filter(item => /^pe-(cr|mcp)-/u.test(item.metadata.name))
}
async function actionEvidence(actionId) {
  const result = await db.query(`SELECT u.username,a.id,a.state,a.command_sealed,a.result_sealed,
    o.session_id,o.state AS original_state,r.id AS continuation_id,
    r.session_id AS continuation_session_id,r.state AS continuation_state,
    c.kind AS call_kind,c.state AS call_state,c.pod_uid,c.runner_instance_id,
    c.dispatch_digest,c.cleanup_complete,c.result AS call_result
    FROM pe_ssh_execute_actions a JOIN pe_users u ON u.id=a.user_id
    JOIN pe_operations o ON o.id=a.operation_id
    LEFT JOIN pe_operations r ON r.source_ssh_execute_action_id=a.id
    LEFT JOIN pe_ssh_calls c ON c.id=a.id WHERE a.id=$1`, [actionId])
  return result.rows[0]
}
async function propose(session, prior, label) {
  const { user, page, connection } = session
  const existing = await rpc(page, 'sshExecuteList', {})
  assert.equal(existing.status, 200)
  if (!existing.body.items.some(item => item.state === 'pending' && !prior.has(item.actionId))) {
    await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.waitFor({ timeout: 20_000 })
    await composer.fill(`Use ssh_execute_propose exactly once with my pinned SSH connection ${connection.connectionId} (${connection.displayName}). Propose the exact command qa:ping. This is a request for trusted human review. After the pending receipt, stop this turn and wait for the platform result. Do not call another tool.`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const action = await eventually(async () => {
    const response = await rpc(page, 'sshExecuteList', {})
    assert.equal(response.status, 200)
    return response.body.items.find(item => !prior.has(item.actionId))
  }, Boolean, `${user.username} ${label} real-model proposal`)
  prior.add(action.actionId)
  assert.equal(action.state, 'pending')
  const evidence = await actionEvidence(action.actionId)
  assert.equal(evidence.username, user.username)
  assert.equal(evidence.state, 'pending')
  assert.equal(evidence.call_kind, null, 'Runner call must wait for independent approval')
  assert.ok(!evidence.command_sealed.includes(Buffer.from('qa:ping')))
  assert.equal(runnerResources().length, 0)
  console.log(`${user.username} ${label}: native model proposed exact command; no Runner before approval`)
  return action
}
async function decide(session, action, approve) {
  const { user, page, approvalPage } = session
  const other = sessions.find(value => value.user.username !== user.username)
  assert.equal((await rpc(other.page, 'sshExecuteStatus', { actionId: action.actionId })).status, 404)
  assert.equal((await approvalRpc(other.approvalPage, '/approvals/ssh-execute/decide', {
    actionId: action.actionId, fingerprint: action.fingerprint, approve })).status, 404)
  const otherList = await approvalRpc(other.approvalPage, '/approvals/ssh-execute/list', {})
  assert.equal(otherList.status, 200)
  assert.ok(!otherList.body.items.some(item => item.actionId === action.actionId))
  await approvalPage.locator('#refresh').click()
  const card = approvalPage.locator('#ssh-actions .approval-card')
    .filter({ has: approvalPage.locator('code').filter({ hasText: action.fingerprint }) })
  await card.waitFor({ timeout: 20_000 })
  assert.equal(await card.locator('pre').innerText(), 'qa:ping')
  assert.match(await card.innerText(), new RegExp(`${session.connection.displayName}.*qa@${session.connection.host}:${session.connection.port}`, 'u'))
  await card.getByRole('button', { name: approve ? '批准本次命令' : '拒绝' }).click()
  await eventually(async () => (await rpc(page, 'sshExecuteStatus', { actionId: action.actionId })).body,
    value => value && (approve ? ['succeeded', 'failed', 'uncertain'].includes(value.state) : value.state === 'rejected'),
    `${user.username} ${approve ? 'approved' : 'rejected'} outcome`)
  const status = (await rpc(page, 'sshExecuteStatus', { actionId: action.actionId })).body
  assert.equal(status.state, approve ? 'succeeded' : 'rejected', JSON.stringify(status))
  if (approve) {
    assert.equal(status.result?.kind, 'ssh.execute')
    assert.equal(status.result?.exitCode, 0)
    assert.equal(status.result?.stdout, 'qa:ssh-ok\n')
  }
  const evidence = await eventually(() => actionEvidence(action.actionId),
    row => row?.continuation_state === 'completed' && (!approve || row.cleanup_complete),
    `${user.username} same-Session continuation and cleanup`)
  assert.equal(evidence.username, user.username)
  assert.equal(evidence.original_state, 'completed')
  assert.equal(evidence.continuation_session_id, evidence.session_id)
  if (approve) {
    assert.equal(evidence.call_kind, 'ssh.execute')
    assert.equal(evidence.call_state, 'succeeded')
    assert.ok(evidence.pod_uid && evidence.runner_instance_id && evidence.dispatch_digest)
    assert.equal(evidence.call_result, null, 'SSH output must stay encrypted on Platform')
    assert.ok(evidence.result_sealed && !evidence.result_sealed.includes(Buffer.from('qa:ssh-ok')))
    await eventually(async () => (await page.locator('body').innerText()).includes('qa:ssh-ok'), Boolean,
      `${user.username} native transcript`, 30_000)
  } else {
    assert.equal(evidence.call_kind, null, 'Rejection must not create a Runner call')
  }
  await page.reload()
  if (approve) await eventually(async () => (await page.locator('body').innerText()).includes('qa:ssh-ok'),
    Boolean, `${user.username} refreshed transcript`, 30_000)
  await eventually(() => runnerResources(), items => items.length === 0, 'Runner cleanup', 30_000)
  console.log(`${user.username}: ${approve ? 'approved execution' : 'rejection'} continued Session ${evidence.session_id}; Runner resources zero`)
  return { username: user.username, actionId: action.actionId, sessionId: evidence.session_id,
    state: status.state, podUid: evidence.pod_uid }
}

try {
  assert.equal(runnerResources().length, 0)
  for (const user of users) {
    const context = await browser.newContext()
    const approvalContext = await browser.newContext()
    contexts.push(context, approvalContext)
    const page = await context.newPage()
    await page.goto(`${platformOrigin}/login`)
    await page.getByRole('textbox', { name: '账号' }).fill(user.username)
    await page.getByRole('textbox', { name: '密码' }).fill(user.password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`${hostOrigin}/native/**`, { timeout: 20_000 })
    if (process.env.PE_SSH_QA_VERIFY_ONLY !== '1') {
      await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
      await page.getByText('Add workspace…', { exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'New cloud Workspace' })
      await dialog.getByRole('textbox', { name: 'Workspace name' }).fill(`qa-ssh-execute-${user.username}`)
      await dialog.getByRole('button', { name: 'Create' }).click()
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20_000 })
    }
    const listed = await rpc(page, 'sshList', {})
    assert.equal(listed.status, 200)
    const connection = listed.body.items.find(item => item.displayName === `qa-${user.username}`)
    assert.ok(connection?.enabled)
    const approvalPage = await approvalContext.newPage()
    await approvalPage.goto(`${platformOrigin}/approval`)
    await approvalPage.locator('#username').fill(user.username)
    await approvalPage.locator('#password').fill(user.password)
    await approvalPage.locator('#login-button').click()
    await approvalPage.locator('#approval-console:not([hidden])').waitFor({ timeout: 20_000 })
    sessions.push({ user, page, approvalPage, connection })
    console.log(`${user.username}: native cloud Workspace and separate trusted approval session ready`)
  }
  if (process.env.PE_SSH_QA_VERIFY_PRIOR === '1') {
    const verifyName = process.env.PE_SSH_QA_VERIFY_NAME ?? 'qa-ssh-execute-results.json'
    if (!/^qa-ssh-execute-results(?:-[a-z0-9]+)?\.json$/u.test(verifyName)) {
      throw new Error('Invalid isolated SSH QA verification filename')
    }
    const priorOutcomes = JSON.parse(await readFile(join(privateDir, verifyName), 'utf8'))
    for (const outcome of priorOutcomes) {
      const session = sessions.find(value => value.user.username === outcome.username)
      assert.ok(session)
      const hostStatus = await rpc(session.page, 'sshExecuteStatus', { actionId: outcome.actionId })
      assert.equal(hostStatus.status, 200)
      assert.equal(hostStatus.body.state, outcome.state)
      const approvalList = await approvalRpc(session.approvalPage, '/approvals/ssh-execute/list', {})
      assert.equal(approvalList.status, 200)
      assert.ok(approvalList.body.items.some(item => item.actionId === outcome.actionId
        && item.command === 'qa:ping' && item.state === outcome.state))
      const evidence = await actionEvidence(outcome.actionId)
      assert.equal(evidence.session_id, outcome.sessionId)
      assert.equal(evidence.continuation_session_id, outcome.sessionId)
      assert.equal(evidence.continuation_state, 'completed')
      if (outcome.state === 'succeeded') {
        assert.equal(hostStatus.body.result?.stdout, 'qa:ssh-ok\n')
        assert.equal(evidence.call_kind, 'ssh.execute')
        assert.equal(evidence.cleanup_complete, true)
      } else assert.equal(evidence.call_kind, null)
    }
    assert.equal(runnerResources().length, 0)
    console.log('Previous SSH approvals, rejection, exact command and same-Session results survived trial restart')
  }
  if (process.env.PE_SSH_QA_VERIFY_ONLY !== '1') {
    const prior = new Map(await Promise.all(sessions.map(async session => {
      const listed = await rpc(session.page, 'sshExecuteList', {})
      assert.equal(listed.status, 200)
      return [session.user.username, new Set(listed.body.items
        .filter(item => item.state !== 'pending').map(item => item.actionId))]
    })))
    const outcomes = []
    for (const session of sessions) {
      const action = await propose(session, prior.get(session.user.username), 'approve path')
      outcomes.push(await decide(session, action, true))
    }
    assert.notEqual(outcomes[0].sessionId, outcomes[1].sessionId)
    assert.notEqual(outcomes[0].podUid, outcomes[1].podUid)
    const rejection = await propose(sessions[1], prior.get('bob'), 'reject path')
    outcomes.push(await decide(sessions[1], rejection, false))
    const resultsName = process.env.PE_SSH_QA_RESULTS_NAME ?? 'qa-ssh-execute-results.json'
    if (!/^qa-ssh-execute-results(?:-[a-z0-9]+)?\.json$/u.test(resultsName)) {
      throw new Error('Invalid isolated SSH QA results filename')
    }
    await writeFile(join(privateDir, resultsName), `${JSON.stringify(outcomes, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 })
    console.log('Two real-model approvals and one rejection passed in native Web; cross-user Host and approval isolation passed')
  }
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
  await db.end()
}
