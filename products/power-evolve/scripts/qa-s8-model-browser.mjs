/** Run real DeepSeek prompts from native browser contexts and inspect durable results. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const mode = process.argv[2]
const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (mode !== 'smoke' || !privateDir || !outputDir
  || !Number.isInteger(hostPort) || !Number.isInteger(platformPort)) {
  throw new Error('Set smoke, PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
}
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).slice(0, 2)
assert.deepEqual(users.map(user => user.username), ['alice', 'bob'])
const db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: await response.json() }
  }, { name, request })
}
async function eventually(probe, accept, label, timeoutMs = 240_000) {
  const until = Date.now() + timeoutMs
  let last
  while (Date.now() < until) {
    last = await probe()
    if (accept(last)) return last
    await delay(1000)
  }
  throw new Error(`${label} timed out; last ${JSON.stringify(last)}`)
}
async function sandboxCount() {
  return Number((await db.query('SELECT count(*)::integer AS count FROM pe_sandbox_instances')).rows[0].count)
}
async function login(user) {
  const context = await browser.newContext()
  contexts.push(context)
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${platformPort}/login`)
  await page.getByRole('textbox', { name: '账号' }).fill(user.username)
  await page.getByRole('textbox', { name: '密码' }).fill(user.password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(`http://127.0.0.1:${hostPort}/native/**`, { timeout: 30_000 })
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  const workspaceName = `qa-s8-${user.username}`
  await page.getByText(workspaceName, { exact: true }).first().waitFor({ timeout: 3000 }).catch(() => {})
  if (await page.getByText(workspaceName, { exact: true }).count() > 0) {
    await page.getByText(workspaceName, { exact: true }).last().click()
  } else {
    await page.getByText('Add workspace…', { exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New cloud Workspace' })
    await dialog.getByRole('textbox', { name: 'Workspace name' }).fill(workspaceName)
    await dialog.getByRole('button', { name: 'Create' }).click()
  }
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20_000 })
  return { user, page, workspaceName }
}
async function prompt(session, text, label) {
  const { user, page } = session
  await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 20_000 })
  await composer.fill(text)
  const since = new Date()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const operation = await eventually(async () => {
    const result = await db.query(`SELECT o.id,o.session_id,o.state,o.error_code
      FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id JOIN pe_users u ON u.id=s.user_id
      WHERE u.username=$1 AND o.created_at >= $2 ORDER BY o.created_at DESC LIMIT 1`,
    [user.username, since])
    return result.rows[0]
  }, value => value && ['completed', 'failed', 'cancelled'].includes(value.state), `${label} operation`)
  assert.equal(operation.state, 'completed', `${label}: ${operation.error_code}`)
  const result = await rpc(page, 'page', { sessionId: operation.session_id, after: -1, limit: 200 })
  assert.equal(result.status, 200)
  const events = result.body.events
  assert(events.some(event => event.type === 'assistant/message'), `${label}: no assistant message`)
  const toolNames = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
  const skillInvocation = events.some(event => event.type === 'user/message'
    && event.data?.source?.kind === 'skill-invocation'
    && event.data.source.name === 'word-documents')
  if (label.endsWith('hi')) assert.deepEqual(toolNames, [], `${label}: unexpected tool call`)
  if (label === 'alice word skill') assert(skillInvocation, 'Native slash command did not inject word-documents')
  if (label === 'alice skill_resource') assert(toolNames.includes('skill_resource'), 'Model did not call skill_resource')
  console.log(`${label}: completed; events=${events.length}, tools=${toolNames.join(',') || 'none'}`)
  return { username: user.username, label, operationId: operation.id, sessionId: operation.session_id,
    eventTypes: events.map(event => event.type), toolNames, skillInvocation }
}

try {
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const before = await sandboxCount()
  const sessions = []
  for (const user of users) sessions.push(await login(user))
  const outcomes = []
  for (const session of sessions) outcomes.push(await prompt(session, 'hi', `${session.user.username} hi`))
  outcomes.push(await prompt(sessions[0], '/word-documents\n请只用一句话说明这个技能的主要用途。不要创建文件。', 'alice word skill'))
  outcomes.push(await prompt(sessions[0],
    'Please call skill_resource with name word-documents and no path, then briefly report the listed resource paths. Do not create files or run code.',
    'alice skill_resource'))
  const after = await sandboxCount()
  assert.equal(after, before, 'Text-only model and skill discovery unexpectedly created a Sandbox')
  const evidence = { checkedAt: new Date().toISOString(), model: 'configured real DeepSeek',
    sandboxRowsBefore: before, sandboxRowsAfter: after, outcomes }
  await writeFile(join(outputDir, 'real-model-smoke.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log('Real DeepSeek, dual-user native prompts and zero Sandbox rows verified')
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
  await db.end()
}
