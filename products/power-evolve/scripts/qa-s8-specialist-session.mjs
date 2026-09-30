/** Invoke the native LaTeX or reviewer Skill in a real DeepSeek Session. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const mode = process.argv[2]
const name = { latex: 'latex-report-writer', reviewer: 'report-reviewer' }[mode]
if (!name) throw new Error('Use latex or reviewer')
const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (!privateDir || !outputDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort))
  throw new Error('Set PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
const prompt = mode === 'latex'
  ? `/${name}\nDescribe the required compile engine and quote this selected Skill's authorized Sandbox runtime directory. Do not run code yet.`
  : `/${name}\nReview this incomplete report outline as the orchestration reviewer. Return only the structured JSON response from the Skill interface. Input: {"orchestration":{"enabled":true,"request_id":"s8-review-qa","caller_skill":"report-workflow-orchestrator"},"action":"review_outline","payload":{"artifact":{"artifact_id":"s8-outline","version":1,"content":{"chapters":[{"title":"项目概述"}]}}}}. The project task book, report scope, research targets and evidence are not supplied. Do not invent them. Do not run tools.`
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
async function rpc(page, method, request) {
  return page.evaluate(async ({ method, request }) => {
    const response = await fetch(`/api/powerEvolve/${method}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) })
    return { status: response.status, body: await response.json() }
  }, { method, request })
}
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${platformPort}/login`)
  await page.getByRole('textbox', { name: '账号' }).fill(user.username)
  await page.getByRole('textbox', { name: '密码' }).fill(user.password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(`http://127.0.0.1:${hostPort}/native/**`, { timeout: 30_000 })
  const created = await rpc(page, 'create', { requestId: randomUUID() })
  assert.equal(created.status, 200)
  const submitted = await rpc(page, 'prompt', { sessionId: created.body.sessionId,
    requestId: randomUUID(), text: prompt })
  assert.equal(submitted.status, 200)
  const operation = await eventually(async () => (await db.query(`SELECT o.id,o.session_id,o.state,o.error_code,s.workspace_id
    FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id WHERE o.id=$1`,
  [submitted.body.operationId])).rows[0], value => value && ['completed', 'failed'].includes(value.state), `${mode} operation`)
  assert.equal(operation.state, 'completed', operation.error_code)
  const events = (await db.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
    [operation.session_id])).rows.map(row => row.event)
  assert(events.some(event => event.type === 'user/message' && event.data?.source?.kind === 'skill-invocation'
    && event.data.source.name === name), `${mode}: native Skill was not invoked`)
  const assistants = events.filter(event => event.type === 'assistant/message')
  assert(assistants.length > 0)
  const answer = assistants.map(event => event.data?.message?.content?.filter(item => item.type === 'text')
    .map(item => item.text).join('\n') ?? '').join('\n')
  const paths = [...JSON.stringify(events).matchAll(/\/opt\/power-evolve\/skills\/sha256\/[a-f0-9]{64}\/skill/gu)]
    .map(match => match[0])
  if (mode === 'latex') {
    assert(paths.length > 0, 'LaTeX runtime path absent from native events')
    assert.match(answer, /XeLaTeX/u)
  } else {
    assert.match(answer, /review_outline/u)
    assert.match(answer, /blocked|major_revision/u)
  }
  const evidence = { checkedAt: new Date().toISOString(), username: user.username, mode, skillName: name,
    sessionId: operation.session_id, workspaceId: operation.workspace_id, operationId: operation.id,
    runtimePath: paths[0] ?? null, answer: answer.slice(0, 5000), eventTypes: events.map(event => event.type) }
  await writeFile(join(outputDir, `specialist-${mode}-bob.json`), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`Bob /${name}: native invocation, real model response, ${events.length} events`)
  await context.close()
} finally {
  await browser.close()
  await db.end()
}
