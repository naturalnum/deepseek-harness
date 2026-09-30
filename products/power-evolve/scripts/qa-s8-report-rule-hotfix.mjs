/** Explicitly upgrade 1.1.33 and replay the suite gate in a newly accepted Session. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
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
const catalogDigest = createHash('sha256').update(await readFile(
  new URL('../application/assets/builtin-skills/generated/catalog.json', import.meta.url))).digest('hex')
assert.equal(catalogDigest, '2a8ffa998a876b298822e5281e3ea736d9344d21ae2ef8f5e05750ca80f706e6')
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).slice(0, 2)
assert.deepEqual(users.map(user => user.username), ['alice', 'bob'])
const db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
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
async function selection(operationId) {
  return (await db.query('SELECT skill_selection FROM pe_operations WHERE id=$1', [operationId])).rows[0]?.skill_selection
}
try {
  assert.equal((await db.query('SELECT version FROM pe_schema')).rows[0].version, 21)
  const evidence = { checkedAt: new Date().toISOString(), catalogDigest, schema: 21, upgrades: [] }
  let bobPage
  for (const user of users) {
    const context = await browser.newContext()
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${platformPort}/login`)
    await page.getByRole('textbox', { name: '账号' }).fill(user.username)
    await page.getByRole('textbox', { name: '密码' }).fill(user.password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`http://127.0.0.1:${hostPort}/native/**`, { timeout: 30_000 })
    const before = await rpc(page, 'skillsList', {})
    assert.equal(before.status, 200)
    const tech = before.body.items.find(item => item.name === 'tech-report-writer')
    assert.equal(tech.version, '1.1.32')
    const catalog = await rpc(page, 'skillsCatalog', {})
    assert.equal(catalog.status, 200)
    const release = catalog.body.items.find(item => item.id === 'builtin.tech-report-writer')
    assert.equal(release.version, '1.1.33')
    const requestId = randomUUID()
    const installed = await rpc(page, 'skillsInstallBuiltin', {
      requestId, catalogId: 'builtin.tech-report-writer', version: '1.1.33' })
    assert.equal(installed.status, 200, JSON.stringify(installed.body))
    assert.equal(installed.body.skillId, tech.skillId)
    assert.equal(installed.body.version, '1.1.33')
    assert.equal(installed.body.packageDigest, release.archiveDigest)
    const rows = (await db.query(`SELECT r.version,v.skill_id FROM pe_builtin_skill_install_requests r
      JOIN pe_users u ON u.id=r.user_id JOIN pe_skill_package_versions v ON v.id=r.package_version_id
      WHERE u.username=$1 AND r.catalog_id='builtin.tech-report-writer'`, [user.username])).rows
    assert(rows.some(row => row.version === '1.1.32' && row.skill_id === tech.skillId))
    assert(rows.some(row => row.version === '1.1.33' && row.skill_id === tech.skillId))
    evidence.upgrades.push({ username: user.username, skillId: tech.skillId,
      oldVersion: '1.1.32', newVersion: '1.1.33', requestId,
      oldDigest: tech.packageDigest, newDigest: release.archiveDigest })
    if (user.username === 'bob') bobPage = page
    console.log(`${user.username}: tech-report-writer 1.1.33 installed through native API; old receipt retained`)
  }
  const oldSession = JSON.parse(await readFile(join(outputDir, 'report-session-bob.json'), 'utf8'))
  const oldSelection = await selection(oldSession.operationId)
  assert(oldSelection.some(item => item.name === 'tech-report-writer' && item.version === '1.1.32'))
  const created = await rpc(bobPage, 'create', { requestId: randomUUID() })
  assert.equal(created.status, 200)
  const invoked = await rpc(bobPage, 'prompt', { sessionId: created.body.sessionId,
    requestId: randomUUID(), text: '/report-workflow-orchestrator\nState the first required intake step and the authorized report-suite runtime path. Do not run code yet.' })
  assert.equal(invoked.status, 200)
  const first = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE id=$1', [invoked.body.operationId])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), 'new suite invocation')
  assert.equal(first.state, 'completed', first.error_code)
  const newSelection = await selection(first.id)
  assert(newSelection.some(item => item.name === 'tech-report-writer' && item.version === '1.1.33'))
  const events = (await db.query('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq',
    [created.body.sessionId])).rows.map(row => row.event)
  assert(events.some(event => event.type === 'user/message' && event.data?.source?.kind === 'skill-invocation'
    && event.data.source.name === 'report-workflow-orchestrator'))
  const paths = [...JSON.stringify(events).matchAll(/\/opt\/power-evolve\/skills\/report-suites\/[a-f0-9]{64}\/report-workflow-orchestrator/gu)]
    .map(match => match[0])
  assert(paths.length > 0)
  const suite = paths[0].slice(0, -'/report-workflow-orchestrator'.length)
  assert.notEqual(suite, oldSession.suitePath)
  const command = `python3 ${suite}/report-workflow-orchestrator/scripts/validate_rule_consistency.py`
  const submitted = await rpc(bobPage, 'prompt', { sessionId: created.body.sessionId,
    requestId: randomUUID(), text: `Call cloud_exec exactly once with this Bash command: ${command}. Do not call another tool. After the queued receipt, wait for its trusted result.` })
  assert.equal(submitted.status, 200)
  const operation = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE id=$1', [submitted.body.operationId])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), 'new rule gate operation')
  assert.equal(operation.state, 'completed', operation.error_code)
  const execution = await eventually(async () => (await db.query(`SELECT id,state,error_code,result,pod_uid,command
    FROM pe_cloud_executions WHERE operation_id=$1`, [operation.id])).rows[0],
  value => value && ['succeeded', 'failed'].includes(value.state), 'new rule gate execution')
  assert.equal(execution.command, command)
  assert.equal(execution.state, 'succeeded', execution.result?.stdout ?? execution.error_code)
  assert.equal(execution.result.exitCode, 0)
  assert.match(execution.result.stdout, /rule consistency validation passed: 0 errors/u)
  const continuation = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE source_execution_id=$1', [execution.id])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), 'new rule gate continuation')
  assert.equal(continuation.state, 'completed', continuation.error_code)
  evidence.oldSession = { operationId: oldSession.operationId, suitePath: oldSession.suitePath,
    techVersion: '1.1.32' }
  evidence.newSession = { sessionId: created.body.sessionId, invocationOperationId: first.id,
    ruleOperationId: operation.id, ruleExecutionId: execution.id, continuationId: continuation.id,
    suitePath: suite, techVersion: '1.1.33', podUid: execution.pod_uid,
    stdout: execution.result.stdout.trim() }
  await writeFile(join(outputDir, 'report-rule-hotfix-bob.json'), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`Bob new suite ${suite}: rule gate exit 0, 0 errors, trusted continuation complete`)
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
  await db.end()
}
