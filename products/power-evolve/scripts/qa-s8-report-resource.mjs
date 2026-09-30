/** Read one packaged report registry through the native skill_resource tool, without Sandbox. */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
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
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${platformPort}/login`)
  await page.getByRole('textbox', { name: '账号' }).fill(user.username)
  await page.getByRole('textbox', { name: '密码' }).fill(user.password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(`http://127.0.0.1:${hostPort}/native/**`, { timeout: 30_000 })
  const before = Number((await db.query('SELECT count(*)::integer AS n FROM pe_sandbox_instances')).rows[0].n)
  const created = await rpc(page, 'create', { requestId: randomUUID() })
  assert.equal(created.status, 200)
  const submitted = await rpc(page, 'prompt', { sessionId: created.body.sessionId, requestId: randomUUID(),
    text: 'Call skill_resource exactly once with name report-workflow-orchestrator and path skill-registry.json. Summarize the child skill names. Do not run code or start a Sandbox.' })
  assert.equal(submitted.status, 200)
  const operation = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE id=$1', [submitted.body.operationId])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), 'report resource operation')
  assert.equal(operation.state, 'completed', operation.error_code)
  const events = (await db.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
    [created.body.sessionId])).rows.map(row => row.event)
  const call = events.find(event => event.type === 'tool/call' && event.data?.name === 'skill_resource')
  assert(call)
  assert.deepEqual(JSON.parse(call.data.arguments),
    { name: 'report-workflow-orchestrator', path: 'skill-registry.json' })
  const result = events.find(event => event.type === 'tool/result' && event.data?.message?.source?.callId === call.data.callId)
  assert(result)
  const resource = JSON.parse(result.data.message.content.find(item => item.type === 'text').text)
  assert.equal(resource.kind, 'text')
  assert.equal(resource.path, 'skill-registry.json')
  assert.equal(createHash('sha256').update(resource.text).digest('hex'), resource.sha256)
  const registry = JSON.parse(resource.text)
  assert.equal(registry.orchestrator.skill_name, 'report-workflow-orchestrator')
  assert.deepEqual(Object.keys(registry.children).sort(), ['formatter', 'generator', 'reviewer'])
  const after = Number((await db.query('SELECT count(*)::integer AS n FROM pe_sandbox_instances')).rows[0].n)
  assert.equal(after, before)
  const evidence = { checkedAt: new Date().toISOString(), username: user.username,
    sessionId: created.body.sessionId, operationId: operation.id, resourcePath: resource.path,
    resourceBytes: Buffer.byteLength(resource.text), resourceSha256: resource.sha256,
    childSkillNames: Object.values(registry.children).map(item => item.skill_name), sandboxRowsBefore: before,
    sandboxRowsAfter: after }
  await writeFile(join(outputDir, 'report-resource-bob.json'), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`Bob report skill_resource ${resource.path}: ${evidence.resourceBytes} bytes, SHA verified, no Sandbox`)
  await context.close()
} finally {
  await browser.close()
  await db.end()
}
