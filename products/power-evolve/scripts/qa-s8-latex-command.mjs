/** Compile one packaged LaTeX sample through the native cloud execution path. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const action = process.argv[2]
const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (!privateDir || !outputDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort))
  throw new Error('Set PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
const session = JSON.parse(await readFile(join(outputDir, 'specialist-latex-bob.json'), 'utf8'))
const skill = session.runtimePath
assert.match(skill, /^\/opt\/power-evolve\/skills\/sha256\/[a-f0-9]{64}\/skill$/u)
const commands = {
  copy: `cp -R ${skill}/assets/template /workspace/latex-s8-qa`,
  writable: 'chmod -R u+w /workspace/latex-s8-qa',
  sanitize: "sed -i 's/待填写/QA样例/g' /workspace/latex-s8-qa/example-report.tex",
  'remove-placeholder': "sed -i '/reportfigureplaceholder/d' /workspace/latex-s8-qa/example-report.tex",
  compile: `python3 ${skill}/scripts/build_latex_report.py /workspace/latex-s8-qa/example-report.tex --output-pdf /workspace/latex-s8-qa/compiled.pdf`,
  recompile: `python3 ${skill}/scripts/build_latex_report.py /workspace/latex-s8-qa/example-report.tex --output-pdf /workspace/latex-s8-qa/compiled.pdf`,
  validate: `python3 ${skill}/scripts/validate_latex_report.py /workspace/latex-s8-qa/compiled.pdf --log /workspace/latex-s8-qa/example-report.log`,
  'validate-clean': `python3 ${skill}/scripts/validate_latex_report.py /workspace/latex-s8-qa/compiled.pdf --log /workspace/latex-s8-qa/example-report.log`,
  render: `python3 ${skill}/scripts/render_pdf.py /workspace/latex-s8-qa/compiled.pdf --output-dir /workspace/latex-s8-qa/render`,
}
const command = commands[action]
if (!command) throw new Error(`Unknown action: ${action}`)
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const user = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).find(item => item.username === 'bob')
const sandbox = JSON.parse(await readFile(join(privateDir, 'sandbox.json'), 'utf8'))
const workspace = join(sandbox.workspaceRoot, session.workspaceId)
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
  const submitted = await page.evaluate(async ({ sessionId, requestId, text }) => {
    const response = await fetch('/api/powerEvolve/prompt', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: { sessionId, requestId, text } }) })
    return { status: response.status, body: await response.json() }
  }, { sessionId: session.sessionId, requestId: randomUUID(),
    text: `Call cloud_exec exactly once with this Bash command: ${command}. Do not call other tools. After its receipt, wait for the trusted result.` })
  assert.equal(submitted.status, 200)
  const operation = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE id=$1', [submitted.body.operationId])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), `${action} operation`)
  assert.equal(operation.state, 'completed', operation.error_code)
  const execution = await eventually(async () => (await db.query(`SELECT id,state,error_code,result,pod_uid,command
    FROM pe_cloud_executions WHERE operation_id=$1 ORDER BY created_at LIMIT 1`, [operation.id])).rows[0],
  value => value && ['succeeded', 'failed', 'cancelled'].includes(value.state), `${action} execution`)
  assert(execution.command.includes('/workspace/latex-s8-qa'), `${action}: different target`)
  assert.equal(execution.state, 'succeeded', `${action}: ${execution.error_code} ${execution.result?.stderr?.slice(0, 500)}`)
  assert.equal(execution.result.exitCode, 0, `${action}: ${execution.result.stderr?.slice(0, 500)}`)
  const continuation = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE source_execution_id=$1', [execution.id])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), `${action} continuation`)
  assert.equal(continuation.state, 'completed', `${action}: ${continuation.error_code}`)
  if (action === 'copy') assert((await stat(join(workspace, 'latex-s8-qa', 'example-report.tex'))).size > 1000)
  if (action === 'compile' || action === 'recompile')
    assert((await stat(join(workspace, 'latex-s8-qa', 'compiled.pdf'))).size > 10000)
  if (action === 'render') assert((await readdir(join(workspace, 'latex-s8-qa', 'render'))).some(file => file.endsWith('.png')))
  const evidence = { checkedAt: new Date().toISOString(), username: user.username, action,
    sessionId: session.sessionId, workspaceId: session.workspaceId, operationId: operation.id,
    executionId: execution.id, continuationId: continuation.id, podUid: execution.pod_uid,
    command: execution.command, exitCode: execution.result.exitCode,
    stdout: execution.result.stdout.slice(0, 1600), stderr: execution.result.stderr.slice(0, 800) }
  await writeFile(join(outputDir, `latex-${action}-bob.json`), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`Bob LaTeX ${action}: Pod ${execution.pod_uid}, exit 0, continuation complete`)
  await context.close()
} finally {
  await browser.close()
  await db.end()
}
