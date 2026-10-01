/** Run one pinned report-suite command through DeepSeek, cloud_exec and k3s. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withEvidenceWorkspace } from './qa-s8-workspace-binding.mjs'

const action = process.argv[2]
const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (!privateDir || !outputDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort))
  throw new Error('Set PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
const session = JSON.parse(await readFile(join(outputDir, 'report-session-bob.json'), 'utf8'))
const suite = session.suitePath
assert.match(suite, /^\/opt\/power-evolve\/skills\/report-suites\/[a-f0-9]{64}$/u)
const orchestrator = `${suite}/report-workflow-orchestrator`
const generator = `${suite}/power-grid-technical-report-writer`
const formatter = `${suite}/tech-report-writer`
const commands = {
  'workflow-init': `python3 ${orchestrator}/scripts/workflow_cli.py init /workspace/report-state.json --project-id s8-qa --title S8QA --goal real-runner-smoke`,
  'workflow-next': `python3 ${orchestrator}/scripts/workflow_cli.py next /workspace/report-state.json`,
  'intake-submit': `python3 ${orchestrator}/scripts/workflow_cli.py submit-intake /workspace/report-state.json /workspace/report-intake.json`,
  'intake-submit-retry': `python3 ${orchestrator}/scripts/workflow_cli.py submit-intake /workspace/report-state.json /workspace/report-intake.json`,
  'workflow-next-after-intake': `python3 ${orchestrator}/scripts/workflow_cli.py next /workspace/report-state.json`,
  'outline-gate': `python3 ${orchestrator}/scripts/run_quality_gate.py --outline ${generator}/examples/outline-specific-topic-example.json`,
  'rule-consistency': `python3 ${orchestrator}/scripts/validate_rule_consistency.py`,
  'formatter-env': `python3 ${formatter}/scripts/check_environment.py`,
  'fixture-source': `REPORT_COMPAT_OUTPUT=/workspace/report-compat python3 ${formatter}/tests/test_compatibility.py ReportCompatibility.test_arbitrary_and_blank_cover_sources`,
  'fixture-copy': 'cp /workspace/report-compat/0/*.json /workspace/report-output/',
  'report-create': `TECH_REPORT_OUTPUT_DIR=/workspace/report-output python3 ${formatter}/scripts/main.py create-report`,
  'report-validate': `python3 ${formatter}/scripts/main.py validate-report /workspace/report-output/技能兼容性报告_科技报告.docx`,
  'report-render': `python3 ${formatter}/scripts/render_for_visual_qa.py /workspace/report-output/技能兼容性报告_科技报告.docx /workspace/report-render --json-out /workspace/report-render/result.json`,
}
const command = commands[action]
if (!command) throw new Error(`Unknown action: ${action}`)
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const user = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).find(item => item.username === 'bob')
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
  let preparedBinding
  if (action === 'intake-submit') {
    const answers = { task_book: { available: false, scope: '无任务书', topic_name_or_number: '' },
      content_generation_mode: 'model_autonomous',
      report_constraints: { has_requirements: false, target_words: null, template: null, chapter_count: null },
      experimental_data: { available: false, description: '', files_or_locations: [] } }
    preparedBinding = (await withEvidenceWorkspace(db, sandbox.workspaceRoot,
      { username: user.username, sessionId: session.sessionId, workspaceId: session.workspaceId }, workspace =>
        writeFile(join(workspace, 'report-intake.json'), `${JSON.stringify(answers, null, 2)}\n`, { flag: 'wx', mode: 0o644 }))).binding
  }
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
  }, { sessionId: session.sessionId, requestId: randomUUID(),
    text: `Call cloud_exec exactly once with this Bash command, byte for byte: ${command}. Do not call another tool. After the queued receipt, wait for the trusted result.` })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const operation = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE id=$1', [response.body.operationId])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), `${action} operation`)
  assert.equal(operation.state, 'completed', `${action}: ${operation.error_code}`)
  const executions = (await db.query(`SELECT id,state,error_code,result,pod_uid,runner_instance_id,command
    FROM pe_cloud_executions WHERE operation_id=$1 ORDER BY created_at`, [operation.id])).rows
  assert.equal(executions.length, 1, `${action}: expected one cloud execution`)
  const execution = await eventually(async () => (await db.query(`SELECT id,state,error_code,result,pod_uid,runner_instance_id,command
    FROM pe_cloud_executions WHERE id=$1`, [executions[0].id])).rows[0],
  value => value && ['succeeded', 'failed', 'cancelled'].includes(value.state), `${action} execution`)
  if (action === 'fixture-copy') {
    assert([command, `${command}.`].includes(execution.command), `${action}: model changed the copy target`)
  } else {
    assert.equal(createHash('sha256').update(execution.command).digest('hex'),
      createHash('sha256').update(command).digest('hex'), `${action}: model changed the supplied command`)
  }
  assert.equal(execution.state, 'succeeded', `${action}: ${execution.error_code} ${execution.result?.stderr?.slice(0, 500)}`)
  assert.equal(execution.result.exitCode, 0, `${action}: ${execution.result.stderr?.slice(0, 500)}`)
  const continuation = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE source_execution_id=$1', [execution.id])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), `${action} continuation`)
  assert.equal(continuation.state, 'completed', `${action}: ${continuation.error_code}`)
  const { binding } = await withEvidenceWorkspace(db, sandbox.workspaceRoot,
    { username: user.username, sessionId: session.sessionId, workspaceId: session.workspaceId,
      expectedBinding: preparedBinding, executionId: execution.id }, async workspace => {
      if (action === 'workflow-init') assert((await stat(join(workspace, 'report-state.json'))).size > 100)
      if (action === 'fixture-source') assert((await stat(join(workspace, 'report-compat', '0', 'cover_info.json'))).size > 100)
      if (action === 'fixture-copy') assert.equal((await readdir(join(workspace, 'report-output'))).filter(x => x.endsWith('.json')).length, 4)
      if (action === 'report-create') assert((await stat(join(workspace, 'report-output', '技能兼容性报告_科技报告.docx'))).size > 5000)
      if (action === 'report-render') {
        const rendered = JSON.parse(await readFile(join(workspace, 'report-render', 'result.json'), 'utf8'))
        assert.equal(rendered.success, true, JSON.stringify(rendered).slice(0, 500))
        assert(rendered.page_count >= 3)
      }
    })
  if (action === 'workflow-next') assert.match(execution.result.stdout, /project_intake/u)
  if (action === 'intake-submit' || action === 'intake-submit-retry')
    assert.match(execution.result.stdout, /confirmed/u)
  if (action === 'workflow-next-after-intake') assert.match(execution.result.stdout, /build_project_profile/u)
  const evidence = { checkedAt: new Date().toISOString(), username: user.username, action,
    sessionId: session.sessionId, workspaceId: session.workspaceId, operationId: operation.id,
    executionId: execution.id, continuationId: continuation.id, podUid: execution.pod_uid,
    runnerInstanceId: execution.runner_instance_id, binding, command, exitCode: execution.result.exitCode,
    stdout: execution.result.stdout.slice(0, 2000), stderr: execution.result.stderr.slice(0, 1000) }
  await writeFile(join(outputDir, `report-${action}-bob.json`), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`Bob ${action}: Pod ${execution.pod_uid}, exit 0, trusted continuation complete`)
  await context.close()
} finally {
  await browser.close()
  await db.end()
}
