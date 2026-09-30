/** Verify the real stateless Office guide prefix and a later direct write in one Session. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
const user = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).find(item => item.username === 'alice')
const sandbox = JSON.parse(await readFile(join(privateDir, 'sandbox.json'), 'utf8'))
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
async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: await response.json() }
  }, { name, request })
}
async function settle(operationId, label) {
  const operation = await eventually(async () => (await db.query(
    'SELECT id,session_id,state,error_code FROM pe_operations WHERE id=$1', [operationId])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), `${label} operation`)
  assert.equal(operation.state, 'completed', `${label}: ${operation.error_code}`)
  const execution = await eventually(async () => (await db.query(
    'SELECT id,state,error_code,result,pod_uid,runner_instance_id FROM pe_cloud_executions WHERE operation_id=$1',
    [operationId])).rows[0], value => value && ['succeeded', 'failed', 'cancelled'].includes(value.state), `${label} execution`)
  assert.equal(execution.state, 'succeeded', `${label}: ${execution.error_code} ${execution.result?.stderr?.slice(0, 500)}`)
  assert.equal(execution.result.exitCode, 0)
  const continuation = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE source_execution_id=$1', [execution.id])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), `${label} continuation`)
  assert.equal(continuation.state, 'completed', `${label}: ${continuation.error_code}`)
  return { operation, execution, continuation }
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
  await dialog.getByRole('textbox', { name: 'Workspace name' }).fill('qa-s8-office-guide')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 20_000 })
  await composer.fill('Call office exactly once with command "load_skill word". After its queued receipt, wait for the trusted result; do not create a file yet.')
  const since = new Date()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const first = await eventually(async () => (await db.query(`SELECT o.id,o.session_id,s.workspace_id
    FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id JOIN pe_users u ON u.id=s.user_id
    WHERE u.username='alice' AND o.created_at >= $1 AND o.source='user' ORDER BY o.created_at DESC LIMIT 1`,
  [since])).rows[0], Boolean, 'guide user operation')
  const guide = await settle(first.id, 'load_skill word')
  const stdout = guide.execution.result.stdout
  assert(stdout.startsWith('[PowerEvolve Office runtime constraint]\n'))
  assert(stdout.includes('Resident mode is disabled for Office tool calls.'))
  assert(stdout.includes('skip its open/edit/save lifecycle.'))
  assert(stdout.includes('# OfficeCLI DOCX Skill'))
  assert(stdout.length > 42_000)
  console.log(`load_skill word: prefix + full guide ${stdout.length} chars, trusted continuation completed`)
  const fileName = 's8-guide-word.docx'
  const create = await rpc(page, 'prompt', { sessionId: first.session_id, requestId: randomUUID(),
    text: `Call office exactly once with command "create /workspace/${fileName} --locale en-US". `
      + 'Use the stateless direct command from the guide prefix; do not call open or another tool.' })
  assert.equal(create.status, 200)
  const written = await settle(create.body.operationId, 'direct create')
  const file = join(sandbox.workspaceRoot, first.workspace_id, fileName)
  const bytes = await readFile(file)
  assert(bytes.subarray(0, 2).equals(Buffer.from('PK')))
  const evidence = { checkedAt: new Date().toISOString(), workspaceId: first.workspace_id,
    sessionId: first.session_id, guideOperationId: first.id, guideExecutionId: guide.execution.id,
    guideContinuationId: guide.continuation.id, guidePodUid: guide.execution.pod_uid,
    guideChars: stdout.length, prefix: stdout.slice(0, 400), directOperationId: written.operation.id,
    directExecutionId: written.execution.id, directContinuationId: written.continuation.id,
    directPodUid: written.execution.pod_uid, file: fileName, fileSize: bytes.length }
  await writeFile(join(outputDir, 'office-guide-prefix-alice.json'), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`Direct create after guide: ${fileName} ${bytes.length} bytes; same Session, real Runner, continuation completed`)
  await context.close()
} finally {
  await browser.close()
  await db.end()
}
