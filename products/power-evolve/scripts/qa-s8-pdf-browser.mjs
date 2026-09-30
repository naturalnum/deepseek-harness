/** Verify native /pdf invocation and one real cloud Sandbox PDF creation. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, stat, writeFile } from 'node:fs/promises'
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
  await dialog.getByRole('textbox', { name: 'Workspace name' }).fill('qa-s8-pdf-alice')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 20_000 })
  await composer.fill(`/pdf\nCall cloud_exec exactly once with this Bash command: `
    + `python3 -c 'from reportlab.pdfgen import canvas; c=canvas.Canvas("s8-pdf.pdf"); c.drawString(72,720,"S8 PDF"); c.save()'`
    + `. Do not call another tool. After the accepted receipt, wait for the trusted result.`)
  const since = new Date()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const operation = await eventually(async () => {
    const result = await db.query(`SELECT o.id,o.session_id,o.state,o.error_code,s.workspace_id
      FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id JOIN pe_users u ON u.id=s.user_id
      WHERE u.username='alice' AND o.created_at >= $1 ORDER BY o.created_at DESC LIMIT 1`, [since])
    return result.rows[0]
  }, value => value && ['completed', 'failed'].includes(value.state), 'PDF user operation')
  assert.equal(operation.state, 'completed', operation.error_code)
  const events = (await db.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
    [operation.session_id])).rows.map(row => row.event)
  assert(events.some(event => event.type === 'user/message' && event.data?.source?.kind === 'skill-invocation'
    && event.data.source.name === 'pdf'), 'Native /pdf invocation was not loaded')
  assert(events.some(event => event.type === 'tool/call' && event.data?.name === 'cloud_exec'))
  const execution = await eventually(async () => {
    const result = await db.query(`SELECT id,state,error_code,result,pod_uid,runner_instance_id
      FROM pe_cloud_executions WHERE operation_id=$1`, [operation.id])
    return result.rows[0]
  }, value => value && ['succeeded', 'failed', 'cancelled'].includes(value.state), 'PDF cloud execution')
  assert.equal(execution.state, 'succeeded', `${execution.error_code}: ${execution.result?.stderr?.slice(0, 500)}`)
  assert.equal(execution.result.exitCode, 0)
  const continuation = await eventually(async () => {
    const result = await db.query('SELECT id,state,error_code FROM pe_operations WHERE source_execution_id=$1', [execution.id])
    return result.rows[0]
  }, value => value && ['completed', 'failed'].includes(value.state), 'PDF continuation')
  assert.equal(continuation.state, 'completed', continuation.error_code)
  const file = join(sandbox.workspaceRoot, operation.workspace_id, 's8-pdf.pdf')
  const bytes = await readFile(file)
  assert(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
  const fileSize = (await stat(file)).size
  assert(fileSize > 500)
  const evidence = { checkedAt: new Date().toISOString(), operationId: operation.id,
    sessionId: operation.session_id, workspaceId: operation.workspace_id, executionId: execution.id,
    continuationId: continuation.id, podUid: execution.pod_uid, runnerInstanceId: execution.runner_instance_id,
    exitCode: execution.result.exitCode, file: 's8-pdf.pdf', fileSize }
  await writeFile(join(outputDir, 'cloud-pdf-alice.json'), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`Alice /pdf → cloud_exec succeeded in Pod ${execution.pod_uid}; continuation completed; ${fileSize} PDF bytes`)
  await context.close()
} finally {
  await browser.close()
  await db.end()
}
