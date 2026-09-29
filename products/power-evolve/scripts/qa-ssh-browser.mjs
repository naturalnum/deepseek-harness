/** Exercise personal SSH authentication in two isolated native Web browser contexts. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const applicationRequire = createRequire(new URL('../application/package.json', import.meta.url))
const { Pool } = applicationRequire('pg')
const privateDir = process.env.PE_PRIVATE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
const kubeContext = process.env.PE_KUBE_CONTEXT
if (!privateDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort) || !kubeContext) {
  throw new Error('Set PE_PRIVATE_DIR, PE_HOST_PORT, PE_PLATFORM_PORT, and PE_KUBE_CONTEXT for the isolated trial')
}
const hostOrigin = `http://127.0.0.1:${hostPort}`
const platformOrigin = `http://127.0.0.1:${platformPort}`
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8'))
const ssh = JSON.parse(await readFile(join(privateDir, 'ssh.json'), 'utf8'))
assert.deepEqual(users.slice(0, 2).map(user => user.username), ['alice', 'bob'])
assert.match(ssh.namespace, /^pe-connector-qa-[a-f0-9]{8}$/u)
const password = (await readFile(join(privateDir, 'password'), 'utf8')).trim()
const publicKey = join(privateDir, 'host-key.pub')
const fingerprintOutput = spawnSync('ssh-keygen', ['-lf', publicKey, '-E', 'sha256'], { encoding: 'utf8' })
if (fingerprintOutput.status !== 0) throw new Error('SSH fixture fingerprint unavailable')
const fingerprint = /\b(SHA256:[A-Za-z0-9+/]{43})\b/u.exec(fingerprintOutput.stdout)?.[1]
const destination = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/u.exec(ssh.destinationAllowlist)
if (!fingerprint || !destination) throw new Error('SSH fixture metadata invalid')

const browser = await chromium.launch({ headless: true })
const contexts = []
const sessions = []
let uploadCount = 0
let credentialReachedHost = false
let createdCount = 0
async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: response.ok ? await response.json() : null }
  }, { name, request })
}
async function newCall(page, previous) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await rpc(page, 'sshCallList', {})
    assert.equal(response.status, 200)
    const fresh = response.body.items.find(item => !previous.has(item.callId))
    if (fresh) return fresh.callId
    await delay(500)
  }
  throw new Error('Native SSH page did not admit a new call')
}
async function terminalCall(page, callId) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const response = await rpc(page, 'sshCallStatus', { callId })
    assert.equal(response.status, 200)
    if (['succeeded', 'failed', 'uncertain', 'cancelled'].includes(response.body.state)) return response.body
    await delay(2000)
  }
  throw new Error('SSH check did not reach a terminal state')
}
const connectionRow = (page, name) => page.locator('.pext-ssh-row')
  .filter({ has: page.getByText(name, { exact: true }) })
try {
  for (const user of users.slice(0, 2)) {
    const context = await browser.newContext()
    contexts.push(context)
    const page = await context.newPage()
    page.on('request', request => {
      const body = request.postData()
      if (request.url() === `${platformOrigin}/ssh/upload`) uploadCount++
      if (body?.includes(password) && request.url().startsWith(hostOrigin)) credentialReachedHost = true
    })
    await page.goto(`${platformOrigin}/login`)
    await page.getByRole('textbox', { name: '账号' }).fill(user.username)
    await page.getByRole('textbox', { name: '密码' }).fill(user.password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`${hostOrigin}/native/**`, { timeout: 20_000 })
    console.log(`${user.username}: signed in to native Web`)
    await page.getByText('Plugins', { exact: true }).first().click()
    await page.getByRole('tab', { name: /All plugins/u }).click()
    await page.locator('[data-plugin-id="ssh"] button').first().click()
    if (await page.getByText(`qa-${user.username}`, { exact: true }).count() === 0) {
      await page.getByRole('button', { name: 'Add server' }).click()
      await page.getByRole('textbox', { name: 'Display name' }).fill(`qa-${user.username}`)
      await page.getByRole('textbox', { name: 'Host', exact: true }).fill(destination[1])
      await page.getByRole('spinbutton', { name: 'Port' }).fill(destination[2])
      await page.getByRole('textbox', { name: 'Username' }).fill('qa')
      await page.getByRole('textbox', { name: 'Host-key SHA-256 fingerprint' }).fill(fingerprint)
      await page.getByRole('textbox', { name: 'Password' }).fill(password)
      await page.getByRole('checkbox', { name: 'Enable after creation' }).check()
      await page.getByRole('button', { name: 'Save server' }).click()
      await page.getByText(`qa-${user.username}`, { exact: true }).waitFor({ timeout: 20_000 })
      createdCount++
    }
    assert.equal(await page.getByText(`qa-${user.username === 'alice' ? 'bob' : 'alice'}`, { exact: true }).count(), 0)
    console.log(`${user.username}: private SSH connection visible in native page`)
    sessions.push({ user, page })
  }
  assert.equal(uploadCount, createdCount)
  assert.equal(credentialReachedHost, false)
  console.log(`${uploadCount} SSH credential uploads reached Platform directly; no credential reached Host`)
  const connections = await Promise.all(sessions.map(async ({ user, page }) => {
    const response = await rpc(page, 'sshList', {})
    assert.equal(response.status, 200)
    const own = response.body.items.find(item => item.displayName === `qa-${user.username}`)
    assert.ok(own)
    return own
  }))
  const succeededIds = []
  for (let index = 0; index < sessions.length; index++) {
    const { user, page } = sessions[index]
    const denied = await rpc(page, 'sshCheck', { requestId: randomUUID(),
      connectionId: connections[1 - index].connectionId,
      connectionRevision: connections[1 - index].revision })
    assert.equal(denied.status, 404)
    const previous = new Set((await rpc(page, 'sshCallList', {})).body.items.map(item => item.callId))
    await connectionRow(page, `qa-${user.username}`)
      .getByRole('button', { name: 'Check SSH credentials' }).click()
    const callId = await newCall(page, previous)
    const status = await terminalCall(page, callId)
    assert.equal(status.state, 'succeeded')
    assert.equal(status.result?.kind, 'ssh.authenticate')
    succeededIds.push(callId)
    await connectionRow(page, `qa-${user.username}`)
      .getByText('SSH authentication succeeded').first().waitFor({ timeout: 20_000 })
    console.log(`${user.username}: SSH authentication succeeded; other user's connection denied`)
  }
  const calls = await Promise.all(sessions.map(async ({ page }) => {
    const response = await rpc(page, 'sshCallList', {})
    assert.equal(response.status, 200)
    assert.ok(response.body.items.some(item => item.state === 'succeeded'
      && item.result?.kind === 'ssh.authenticate'))
    return response.body.items.map(item => item.callId)
  }))
  assert.equal(calls[0].some(id => calls[1].includes(id)), false)
  for (const [index, { user, page }] of sessions.entries()) {
    await page.reload()
    await page.getByText('Plugins', { exact: true }).first().click()
    await page.locator('[data-plugin-id="ssh"] button').first().click()
    await page.locator('.pext-ssh-recent-list article').filter({ hasText: succeededIds[index].slice(0, 8) })
      .getByText('SSH authentication succeeded').waitFor({ timeout: 20_000 })
    console.log(`${user.username}: owner-scoped check state restored after refresh`)
  }
  const alice = sessions[0].page
  const wrongName = 'qa-alice-wrong-key'
  const wrongFingerprint = `SHA256:${'A'.repeat(43)}` === fingerprint
    ? `SHA256:${'B'.repeat(43)}` : `SHA256:${'A'.repeat(43)}`
  if (await alice.getByText(wrongName, { exact: true }).count() === 0) {
    await alice.getByRole('button', { name: 'Add server' }).click()
    await alice.getByRole('textbox', { name: 'Display name' }).fill(wrongName)
    await alice.getByRole('textbox', { name: 'Host', exact: true }).fill(destination[1])
    await alice.getByRole('spinbutton', { name: 'Port' }).fill(destination[2])
    await alice.getByRole('textbox', { name: 'Username' }).fill('qa')
    await alice.getByRole('textbox', { name: 'Host-key SHA-256 fingerprint' }).fill(wrongFingerprint)
    await alice.getByRole('textbox', { name: 'Password' }).fill(password)
    await alice.getByRole('checkbox', { name: 'Enable after creation' }).check()
    await alice.getByRole('button', { name: 'Save server' }).click()
    await alice.getByText(wrongName, { exact: true }).waitFor({ timeout: 20_000 })
    createdCount++
  }
  const priorWrong = new Set((await rpc(alice, 'sshCallList', {})).body.items.map(item => item.callId))
  await connectionRow(alice, wrongName)
    .getByRole('button', { name: 'Check SSH credentials' }).click()
  const wrongId = await newCall(alice, priorWrong)
  const wrong = await terminalCall(alice, wrongId)
  assert.equal(wrong.state, 'failed')
  assert.equal(wrong.errorCode, 'connector_runner_canary_failed')
  await connectionRow(alice, wrongName)
    .getByText('SSH authentication failed').first().waitFor({ timeout: 120_000 })
  const rejected = await rpc(alice, 'sshCreateTicket', { requestId: randomUUID(),
    displayName: 'qa-denied-destination', host: '127.0.0.1', port: 2222, username: 'qa',
    hostKeySha256: fingerprint, credentialKind: 'password', sizeBytes: Buffer.byteLength(password), enabled: true })
  assert.equal(rejected.status, 403)
  assert.equal(uploadCount, createdCount)
  assert.equal(credentialReachedHost, false)
  console.log('Wrong fingerprint failed; non-allowlisted destination rejected before upload')
  const pool = new Pool({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
  try {
    const rows = await pool.query(`SELECT c.id,u.username,c.state,c.error_code,c.result->>'kind' AS result_kind,
      c.dispatch_digest IS NOT NULL AS dispatched,c.cleanup_complete FROM pe_ssh_calls c
      JOIN pe_users u ON u.id=c.user_id WHERE c.id=ANY($1::uuid[])`, [[...succeededIds, wrongId]])
    const byId = new Map(rows.rows.map(row => [row.id, row]))
    for (const [index, id] of succeededIds.entries()) {
      const row = byId.get(id)
      assert.equal(row?.username, sessions[index].user.username)
      assert.equal(row.state, 'succeeded')
      assert.equal(row.result_kind, 'ssh.authenticate')
      assert.equal(row.dispatched, true)
      assert.equal(row.cleanup_complete, true)
    }
    assert.equal(byId.get(wrongId)?.state, 'failed')
    assert.equal(byId.get(wrongId)?.error_code, 'connector_runner_canary_failed')
    assert.equal(byId.get(wrongId)?.dispatched, false)
    const deniedRows = await pool.query(`SELECT count(*)::integer AS count FROM pe_ssh_connections
      WHERE display_name='qa-denied-destination'`)
    assert.equal(deniedRows.rows[0].count, 0)
  } finally { await pool.end() }
  const inventory = spawnSync('kubectl', ['--context', kubeContext, '-n', ssh.namespace,
    'get', 'pods,secrets,networkpolicies', '-o', 'json'], { encoding: 'utf8' })
  if (inventory.status !== 0) throw new Error('Runner resource inventory failed')
  const resources = JSON.parse(inventory.stdout).items
  assert.equal(resources.filter(item => item.metadata.name.startsWith('pe-cr-')).length, 0)
  const target = resources.find(item => item.kind === 'Pod'
    && item.metadata.labels?.['app.kubernetes.io/name'] === 'power-evolve-qa-ssh')
  assert.ok(target?.status.containerStatuses?.[0]?.ready)
  assert.equal(target.status.containerStatuses[0].restartCount, 0)
  console.log('PG call ownership, dispatch, cleanup, and Runner resource inventory verified')
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
}
