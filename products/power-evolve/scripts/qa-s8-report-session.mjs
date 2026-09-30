/** Start a real report Skill Session and capture its authorized suite mount. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (!privateDir || !outputDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort))
  throw new Error('Set PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const user = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).find(item => item.username === 'bob')
const db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
await db.connect()
const browser = await chromium.launch({ headless: true })
async function eventually(probe, accept, label, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs
  let last
  while (Date.now() < until) {
    last = await probe()
    if (accept(last)) return last
    await delay(1000)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`)
}
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${platformPort}/login`)
  await page.getByRole('textbox', { name: '账号' }).fill(user.username)
  await page.getByRole('textbox', { name: '密码' }).fill(user.password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(`http://127.0.0.1:${hostPort}/native/**`, { timeout: 30_000 })
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await page.getByText('Add workspace…', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New cloud Workspace' })
  await dialog.getByRole('textbox', { name: 'Workspace name' }).fill('qa-s8-report-qa3')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 20_000 })
  await composer.fill('/report-workflow-orchestrator\nSummarize the first required project intake stage and quote the authorized report-suite runtime directory shown with this skill. Do not run code yet.')
  const since = new Date()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const operation = await eventually(async () => (await db.query(`SELECT o.id,o.session_id,o.state,o.error_code,s.workspace_id
    FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id JOIN pe_users u ON u.id=s.user_id
    WHERE u.username='bob' AND o.created_at >= $1 AND o.source='user' ORDER BY o.created_at DESC LIMIT 1`,
  [since])).rows[0], value => value && ['completed', 'failed'].includes(value.state), 'report slash operation')
  assert.equal(operation.state, 'completed', operation.error_code)
  const events = (await db.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
    [operation.session_id])).rows.map(row => row.event)
  const invoked = events.filter(event => event.type === 'user/message'
    && event.data?.source?.kind === 'skill-invocation')
  assert(invoked.some(event => event.data.source.name === 'report-workflow-orchestrator'))
  const text = JSON.stringify(events)
  const paths = [...text.matchAll(/\/opt\/power-evolve\/skills\/report-suites\/[a-f0-9]{64}\/report-workflow-orchestrator/gu)]
    .map(match => match[0])
  assert(paths.length > 0, 'Report skill runtime path absent from actual native events')
  const suitePath = paths[0].slice(0, -'/report-workflow-orchestrator'.length)
  const evidence = { checkedAt: new Date().toISOString(), username: user.username,
    sessionId: operation.session_id, workspaceId: operation.workspace_id, operationId: operation.id,
    invocationCount: invoked.length, suitePath, eventTypes: events.map(event => event.type) }
  await writeFile(join(outputDir, 'report-session-bob.json'), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`Bob report slash completed; authorized suite ${suitePath}; events ${events.length}`)
  await context.close()
} finally {
  await browser.close()
  await db.end()
}
