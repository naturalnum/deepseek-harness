/** One real native Office tool command, with durable execution and file evidence. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [username, action] = process.argv.slice(2)
const commands = {
  'word-create': 'create /workspace/s8-word.docx --locale en-US',
  'word-add': 'add /workspace/s8-word.docx /body --type paragraph --prop style=Heading1 --prop text="S8 Word"',
  'word-save': 'save /workspace/s8-word.docx',
  'word-validate': 'validate /workspace/s8-word.docx',
  'word-render': 'view /workspace/s8-word.docx pdf --out /workspace/s8-word-preview.pdf',
  'word-screenshot': 'view /workspace/s8-word.docx screenshot --out /workspace/s8-word-preview.png --page 1',
  'excel-create': 'create /workspace/s8-excel.xlsx --locale en-US',
  'excel-set': 'set /workspace/s8-excel.xlsx /Sheet1/A1 --prop value=21',
  'excel-formula': 'set /workspace/s8-excel.xlsx /Sheet1/B1 --prop formula="A1*2"',
  'excel-save': 'save /workspace/s8-excel.xlsx',
  'excel-validate': 'validate /workspace/s8-excel.xlsx',
  'excel-render': 'view /workspace/s8-excel.xlsx pdf --out /workspace/s8-excel-preview.pdf',
  'excel-screenshot': 'view /workspace/s8-excel.xlsx screenshot --out /workspace/s8-excel-preview.png --range Sheet1!A1:B2',
  'pptx-create': 'create /workspace/s8-deck.pptx --locale en-US',
  'pptx-add': 'add /workspace/s8-deck.pptx / --type slide --prop title="S8 PPT" --prop text="Real office tool"',
  'pptx-save': 'save /workspace/s8-deck.pptx',
  'pptx-validate': 'validate /workspace/s8-deck.pptx',
  'pptx-render': 'view /workspace/s8-deck.pptx pdf --out /workspace/s8-deck-preview.pdf',
  'pptx-screenshot': 'view /workspace/s8-deck.pptx screenshot --out /workspace/s8-deck-preview.png --page 1',
}
const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (!['alice', 'bob'].includes(username) || !commands[action] || !privateDir || !outputDir
  || !Number.isInteger(hostPort) || !Number.isInteger(platformPort)) {
  throw new Error('Set alice|bob, known action, PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
}
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const user = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).find(item => item.username === username)
assert(user)
const sandbox = JSON.parse(await readFile(join(privateDir, 'sandbox.json'), 'utf8'))
const db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
await db.connect()
const browser = await chromium.launch({ headless: true })
async function rpc(page, name, request) {
  return page.evaluate(async ({ name, request }) => {
    const response = await fetch(`/api/powerEvolve/${name}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: await response.json() }
  }, { name, request })
}
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
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${platformPort}/login`)
  await page.getByRole('textbox', { name: '账号' }).fill(user.username)
  await page.getByRole('textbox', { name: '密码' }).fill(user.password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(`http://127.0.0.1:${hostPort}/native/**`, { timeout: 30_000 })
  const isCreate = action.endsWith('-create')
  let prior
  let acceptedId
  if (isCreate) {
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    const workspaceName = process.env.PE_S8_WORKSPACE_NAME ?? `qa-s8-${username}`
    assert.match(workspaceName, /^[a-z0-9-]{1,48}$/u)
    await page.getByText(workspaceName, { exact: true }).first().waitFor({ timeout: 3000 }).catch(() => {})
    if (await page.getByText(workspaceName, { exact: true }).count() > 0) {
      await page.getByText(workspaceName, { exact: true }).last().click()
    } else {
      await page.getByText('Add workspace…', { exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'New cloud Workspace' })
      await dialog.getByRole('textbox', { name: 'Workspace name' }).fill(workspaceName)
      await dialog.getByRole('button', { name: 'Create' }).click()
    }
    await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
  } else {
    const extension = action.split('-', 1)[0]
    prior = JSON.parse(await readFile(join(outputDir, `office-${username}-${extension}-create.json`), 'utf8'))
  }
  const promptText = `Call the office tool exactly once with command: ${commands[action]}. `
    + 'Do not call other tools or alter the command. After a queued receipt, wait for the trusted result.'
  const since = new Date()
  if (isCreate) {
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.waitFor({ timeout: 20_000 })
    await composer.fill(promptText)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  } else {
    const response = await rpc(page, 'prompt', { sessionId: prior.sessionId, requestId: randomUUID(), text: promptText })
    assert.equal(response.status, 200)
    acceptedId = response.body.operationId
  }
  const operation = await eventually(async () => {
    const result = await db.query(`SELECT o.id,o.session_id,o.state,o.error_code,s.workspace_id
      FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id JOIN pe_users u ON u.id=s.user_id
      WHERE u.username=$1 AND o.created_at >= $2 AND ($3::uuid IS NULL OR o.id=$3)
      ORDER BY o.created_at DESC LIMIT 1`, [username, since, acceptedId ?? null])
    return result.rows[0]
  }, value => value && ['completed', 'failed', 'cancelled'].includes(value.state), `${action} user operation`)
  assert.equal(operation.state, 'completed', `${action}: ${operation.error_code}`)
  if (prior) assert.equal(operation.workspace_id, prior.workspaceId)
  const execution = await eventually(async () => {
    const result = await db.query(`SELECT id,state,error_code,result,pod_uid,runner_instance_id,command
      FROM pe_cloud_executions WHERE operation_id=$1 ORDER BY created_at LIMIT 1`, [operation.id])
    return result.rows[0]
  }, value => value && ['succeeded', 'failed', 'cancelled'].includes(value.state), `${action} execution`)
  assert.equal(execution.state, 'succeeded', `${action}: ${execution.error_code} ${execution.result?.stderr?.slice(0, 500)}`)
  assert.equal(execution.result.exitCode, 0, `${action}: ${execution.result.stderr?.slice(0, 500)}`)
  const continuation = await eventually(async () => {
    const result = await db.query('SELECT id,state,error_code FROM pe_operations WHERE source_execution_id=$1', [execution.id])
    return result.rows[0]
  }, value => value && ['completed', 'failed'].includes(value.state), `${action} continuation`, 40_000)
  assert.equal(continuation.state, 'completed', `${action} continuation: ${continuation.error_code}`)
  const extension = action.split('-', 1)[0]
  const file = extension === 'word' ? 's8-word.docx' : extension === 'excel' ? 's8-excel.xlsx' : 's8-deck.pptx'
  const filePath = join(sandbox.workspaceRoot, operation.workspace_id, file)
  const fileSize = (await stat(filePath)).size
  assert(fileSize > 500, `${action}: missing or empty file`)
  let renderedFile
  let renderedSize
  if (action.endsWith('-render') || action.endsWith('-screenshot')) {
    renderedFile = `s8-${extension === 'pptx' ? 'deck' : extension}-preview.${action.endsWith('-render') ? 'pdf' : 'png'}`
    renderedSize = (await stat(join(sandbox.workspaceRoot, operation.workspace_id, renderedFile))).size
    assert(renderedSize > 500, `${action}: missing or empty PDF render`)
  }
  const evidence = { checkedAt: new Date().toISOString(), username, action, officeCommand: commands[action],
    operationId: operation.id, sessionId: operation.session_id, workspaceId: operation.workspace_id,
    executionId: execution.id, podUid: execution.pod_uid, runnerInstanceId: execution.runner_instance_id,
    exitCode: execution.result.exitCode, stdout: execution.result.stdout.slice(0, 2000),
    stderr: execution.result.stderr.slice(0, 2000), continuationId: continuation.id,
    file, fileSize, renderedFile, renderedSize }
  await writeFile(join(outputDir, `office-${username}-${action}.json`), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`${username} ${action}: office succeeded in Pod ${execution.pod_uid}; continuation completed; ${file} ${fileSize} bytes`)
  await context.close()
} finally {
  await browser.close()
  await db.end()
}
