/** Render an existing S8 Office file with LibreOffice inside its real cloud Sandbox. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [username, kind] = process.argv.slice(2)
const source = { word: 's8-word.docx', excel: 's8-excel.xlsx', pptx: 's8-deck.pptx' }[kind]
if (!['alice', 'bob'].includes(username) || !source) throw new Error('Use alice|bob and word|excel|pptx')
const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (!privateDir || !outputDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort))
  throw new Error('Set PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const user = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).find(item => item.username === username)
const sandbox = JSON.parse(await readFile(join(privateDir, 'sandbox.json'), 'utf8'))
const prior = JSON.parse(await readFile(join(outputDir, `office-${username}-${kind}-create.json`), 'utf8'))
const output = source.replace(/\.[^.]+$/u, '.pdf')
const command = `libreoffice -env:UserInstallation=file:///tmp/lo-s8-${kind} --headless --convert-to pdf --outdir /workspace /workspace/${source}`
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
  const response = await page.evaluate(async ({ sessionId, requestId, text }) => {
    const result = await fetch('/api/powerEvolve/prompt', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: { sessionId, requestId, text } }) })
    return { status: result.status, body: await result.json() }
  }, { sessionId: prior.sessionId, requestId: randomUUID(),
    text: `Call cloud_exec exactly once with this Bash command: ${command}. Do not call another tool. After the queued receipt, wait for the trusted result.` })
  assert.equal(response.status, 200)
  const operation = await eventually(async () => {
    const result = await db.query('SELECT id,session_id,state,error_code FROM pe_operations WHERE id=$1',
      [response.body.operationId])
    return result.rows[0]
  }, value => value && ['completed', 'failed'].includes(value.state), `${kind} render operation`)
  assert.equal(operation.state, 'completed', operation.error_code)
  const events = (await db.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
    [operation.session_id])).rows.map(row => row.event)
  assert(events.some(event => event.type === 'tool/call' && event.data?.name === 'cloud_exec'
    && event.data?.arguments?.includes('libreoffice')))
  const execution = await eventually(async () => {
    const result = await db.query(`SELECT id,state,error_code,result,pod_uid,runner_instance_id
      FROM pe_cloud_executions WHERE operation_id=$1`, [operation.id])
    return result.rows[0]
  }, value => value && ['succeeded', 'failed', 'cancelled'].includes(value.state), `${kind} render execution`)
  assert.equal(execution.state, 'succeeded', `${execution.error_code}: ${execution.result?.stderr?.slice(0, 500)}`)
  assert.equal(execution.result.exitCode, 0)
  const continuation = await eventually(async () => {
    const result = await db.query('SELECT id,state,error_code FROM pe_operations WHERE source_execution_id=$1', [execution.id])
    return result.rows[0]
  }, value => value && ['completed', 'failed'].includes(value.state), `${kind} render continuation`)
  assert.equal(continuation.state, 'completed', continuation.error_code)
  const pdf = join(sandbox.workspaceRoot, prior.workspaceId, output)
  let bytes
  try { bytes = await readFile(pdf) }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${kind} LibreOffice exited 0 without ${output}; stderr: ${execution.result.stderr.slice(0, 500)}`)
    throw error
  }
  assert(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
  const evidence = { checkedAt: new Date().toISOString(), username, kind, source, output,
    workspaceId: prior.workspaceId, sessionId: prior.sessionId, operationId: operation.id,
    executionId: execution.id, continuationId: continuation.id, podUid: execution.pod_uid,
    runnerInstanceId: execution.runner_instance_id, exitCode: execution.result.exitCode,
    stdout: execution.result.stdout.slice(0, 1000), stderr: execution.result.stderr.slice(0, 1000),
    fileSize: bytes.length }
  await writeFile(join(outputDir, `cloud-render-${username}-${kind}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(`${username} ${kind}: LibreOffice in Pod ${execution.pod_uid}; ${output} ${bytes.length} bytes; continuation complete`)
  await context.close()
} finally {
  await browser.close()
  await db.end()
}
