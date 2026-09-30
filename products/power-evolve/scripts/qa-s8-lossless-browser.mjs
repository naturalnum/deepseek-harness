/** Verify real k3s NUL output survives V21 storage, continuation and native reads. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const mode = process.argv[2]
if (!['small', 'full'].includes(mode)) throw new Error('Use small or full')
const privateDir = process.env.PE_PRIVATE_DIR
const outputDir = process.env.PE_S8_EVIDENCE_DIR
const hostPort = Number(process.env.PE_HOST_PORT)
const platformPort = Number(process.env.PE_PLATFORM_PORT)
if (!privateDir || !outputDir || !Number.isInteger(hostPort) || !Number.isInteger(platformPort))
  throw new Error('Set PE_PRIVATE_DIR, PE_S8_EVIDENCE_DIR, PE_HOST_PORT and PE_PLATFORM_PORT')
const small = `A\u0000中文😀\\u0000Z`
const marker = `中😀\\u0000`
const full = Buffer.concat([Buffer.alloc(65_536 - Buffer.byteLength(marker)), Buffer.from(marker)]).toString('utf8')
assert.equal(Buffer.byteLength(full), 65_536)
const expected = mode === 'small' ? small : full
const command = mode === 'small'
  ? `python3 -c 'import sys; s="A"+chr(0)+"中文😀"+chr(92)+"u0000"+"Z"; sys.stdout.write(s); sys.stderr.write(s)'`
  : `python3 -c 'import sys; t=("中😀"+chr(92)+"u0000").encode(); b=bytes(65536-len(t))+t; sys.stdout.buffer.write(b); sys.stderr.buffer.write(b)'`
const hash = value => createHash('sha256').update(value).digest('hex')
const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8')).slice(0, 2)
assert.deepEqual(users.map(user => user.username), ['alice', 'bob'])
const { chromium } = createRequire(new URL('../../../apps/web/package.json', import.meta.url))('playwright')
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
await db.connect()
const browser = await chromium.launch({ headless: true })
const contexts = []
async function eventually(probe, accept, label, timeoutMs = 240_000) {
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
try {
  assert.equal((await db.query('SELECT version FROM pe_schema')).rows[0].version, 21)
  const sessions = []
  for (const user of users) {
    const context = await browser.newContext()
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${platformPort}/login`)
    await page.getByRole('textbox', { name: '账号' }).fill(user.username)
    await page.getByRole('textbox', { name: '密码' }).fill(user.password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.waitForURL(`http://127.0.0.1:${hostPort}/native/**`, { timeout: 30_000 })
    sessions.push({ user, context, page })
  }
  const [alice, bob] = sessions
  const created = await rpc(alice.page, 'create', { requestId: randomUUID() })
  assert.equal(created.status, 200)
  const submitted = await rpc(alice.page, 'prompt', { sessionId: created.body.sessionId,
    requestId: randomUUID(), text: `Call cloud_exec exactly once with this Bash command: ${command}. Do not call any other tool. After the queued receipt, wait for the trusted result.` })
  assert.equal(submitted.status, 200)
  const operation = await eventually(async () => (await db.query(
    'SELECT id,state,error_code FROM pe_operations WHERE id=$1', [submitted.body.operationId])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), `${mode} user operation`)
  assert.equal(operation.state, 'completed', operation.error_code)
  const result = await eventually(async () => (await db.query(`SELECT id,state,error_code,result,command,pod_uid,
      pg_typeof(result)::text AS result_type FROM pe_cloud_executions WHERE operation_id=$1`,
  [operation.id])).rows[0], value => value && ['succeeded', 'failed'].includes(value.state), `${mode} execution`)
  assert.equal(result.command, command, `${mode}: model changed the command`)
  assert.equal(result.state, 'succeeded', `${mode}: ${result.error_code}`)
  assert.equal(result.result.exitCode, 0)
  assert.equal(result.result_type, 'json')
  assert.equal(result.result.stdoutTruncated, false)
  assert.equal(result.result.stderrTruncated, false)
  assert.equal(Buffer.byteLength(result.result.stdout), Buffer.byteLength(expected))
  assert.equal(Buffer.byteLength(result.result.stderr), Buffer.byteLength(expected))
  assert.equal(hash(result.result.stdout), hash(expected), 'stdout lost bytes')
  assert.equal(hash(result.result.stderr), hash(expected), 'stderr lost bytes')
  assert(result.result.stdout.includes('\u0000'))
  assert(result.result.stdout.includes('中') && result.result.stdout.includes('😀'))
  assert(result.result.stdout.includes('\\u0000'))
  const continuation = await eventually(async () => (await db.query(`SELECT id,state,error_code,input
    FROM pe_operations WHERE source_execution_id=$1`, [result.id])).rows[0],
  value => value && ['completed', 'failed'].includes(value.state), `${mode} continuation`)
  assert.equal(continuation.state, 'completed', continuation.error_code)
  const rows = (await db.query(`SELECT seq,event,pg_typeof(event)::text AS event_type FROM pe_events
    WHERE session_id=$1 ORDER BY seq`, [created.body.sessionId])).rows
  const trusted = rows.find(row => row.event.type === 'user/message'
    && row.event.data?.source?.kind === 'power-evolve-execution'
    && row.event.data.source.executionId === result.id)
  assert(trusted)
  assert.equal(trusted.event_type, 'json')
  const trustedText = trusted.event.data.content.find(item => item.type === 'text')?.text
  assert(continuation.input.includes(JSON.stringify(expected)), 'Operation input lost full escaped output')
  if (mode === 'small') {
    assert.equal(hash(trustedText), hash(continuation.input), 'small native event differs from trusted input')
  } else {
    assert(trustedText.startsWith('Internal result truncated.'), 'large native event lacks bounded marker')
    assert(trustedText.includes('[... omitted ...]'), 'large native event lacks omission marker')
    assert(trustedText.length < continuation.input.length, 'large native event was not bounded')
    assert(Buffer.byteLength(JSON.stringify(trustedText)) <= 262_144, 'native event exceeds grant budget')
    assert(trustedText.includes(continuation.input.slice(0, 100)), 'bounded head differs from full input')
    assert(trustedText.endsWith(continuation.input.slice(-100)), 'bounded tail differs from full input')
    assert(trustedText.includes(JSON.stringify(marker).slice(1, -1)), 'bounded tail lost Unicode or literal escape')
  }
  assert(rows.some(row => row.seq > trusted.seq && row.event.type === 'assistant/message'))
  const executionCount = Number((await db.query(
    'SELECT count(*)::integer AS n FROM pe_cloud_executions WHERE session_id=$1', [created.body.sessionId])).rows[0].n)
  assert.equal(executionCount, 1)
  await alice.page.reload()
  const native = await rpc(alice.page, 'page', { sessionId: created.body.sessionId,
    after: trusted.seq - 1, limit: 1 })
  assert.equal(native.status, 200)
  const nativeTrusted = native.body.events.find(event => event.seq === trusted.seq)
  assert(nativeTrusted, 'native refresh did not return trusted event')
  const nativeText = nativeTrusted.data.content.find(item => item.type === 'text')?.text
  assert.equal(hash(nativeText), hash(trustedText), 'native refresh changed persisted event')
  const denied = await rpc(bob.page, 'page', { sessionId: created.body.sessionId, after: -1, limit: 1 })
  assert.equal(denied.status, 404)
  const evidence = { checkedAt: new Date().toISOString(), mode, schema: 21,
    sessionId: created.body.sessionId, operationId: operation.id, executionId: result.id,
    continuationId: continuation.id, podUid: result.pod_uid, command,
    stdoutBytes: Buffer.byteLength(result.result.stdout), stderrBytes: Buffer.byteLength(result.result.stderr),
    stdoutSha256: hash(result.result.stdout), stderrSha256: hash(result.result.stderr),
    literalEscapePresent: true, nulPresent: true, unicodePresent: true,
    executionCount, trustedEventSeq: trusted.seq, trustedInputChars: continuation.input.length,
    trustedInputSha256: hash(continuation.input), boundedEventChars: trustedText.length,
    boundedEventSha256: hash(trustedText), nativeRefreshDigest: hash(nativeText),
    crossUserStatus: denied.status,
    stdoutTruncated: result.result.stdoutTruncated, stderrTruncated: result.result.stderrTruncated }
  await writeFile(join(outputDir, `lossless-${mode}-alice.json`), `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 })
  console.log(`${mode}: real Pod ${result.pod_uid}; ${evidence.stdoutBytes}+${evidence.stderrBytes} bytes exact, one execution, continuation/refresh/cross-user checks passed`)
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
  await db.end()
}
