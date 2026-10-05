/** Built Host/Platform admission tests; PG authorization/queries are explicit substitutes, with no executor. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { installExecutionTools } from '../lib/host/executions.js'
import { DeviceService } from '../lib/platform/devices.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function fixture() {
  const target = { kind: 'desktop', deviceId: randomUUID(), directoryId: randomUUID() }
  const grant = { id: randomUUID(), user_id: randomUUID(), operation_id: randomUUID(), execution_target: target }
  const instanceId = randomUUID(), queries = [], authorizations = []
  let prior = null
  const client = new EventEmitter()
  client.release = () => {}
  client.query = async (sql, values = []) => {
    queries.push({ sql, values })
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 }
    if (sql.includes('WHERE operation_id=$1 AND call_id=$2')) {
      assert.deepEqual(values, [grant.operation_id, 'synthetic-call'])
      return { rows: prior ? [prior] : [], rowCount: prior ? 1 : 0 }
    }
    if (sql.includes('SELECT o.skill_selection')) return { rows: [{ skill_selection: [] }], rowCount: 1 }
    if (sql.includes('SELECT d.instance_id')) return { rows: [{ instance_id: instanceId }], rowCount: 1 }
    if (sql.includes('UNION ALL SELECT id FROM pe_cloud_executions') || sql.includes('LIMIT 1')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('INSERT INTO pe_desktop_executions')) {
      prior = { id: values[0], user_id: values[1], session_id: values[2], operation_id: values[3],
        device_id: values[4], directory_id: values[5], call_id: values[6], command: values[7], cwd: values[8],
        request_digest: values[9], dispatch_request: JSON.parse(values[10]), device_instance_id: values[11],
        state: 'queued', result: null, error_code: null }
      return { rows: [prior], rowCount: 1 }
    }
    throw new Error('Unexpected synthetic query: ' + sql)
  }
  const tasks = { pool: { async connect() { return client } },
    async authorized(receivedClient, token) {
      assert.equal(receivedClient, client)
      assert.equal(token, 'synthetic-grant')
      authorizations.push(token)
      return grant
    } }
  return { target, grant, instanceId, queries, authorizations, tasks, devices: new DeviceService(tasks, 1234, {}),
    row: () => prior, saveLegacy(cwd) {
      const dispatch_request = { command: 'printf synthetic', cwd, timeoutMs: 1234,
        deviceId: target.deviceId, directoryId: target.directoryId }
      prior = { id: randomUUID(), state: 'queued', command: dispatch_request.command, cwd,
        device_id: target.deviceId, directory_id: target.directoryId, device_instance_id: instanceId,
        dispatch_request, request_digest: hash(dispatch_request), result: null, error_code: null }
      return structuredClone(prior)
    } }
}

test('new invalid desktop cwd is refused before material lookup, queued persistence or dispatch', async () => {
  const paths = ['/workspace', '/workspace/reports', '//workspace', '../outside', 'reports/../outside',
    './reports', 'reports/.', 'reports//draft', 'reports/', 'reports\\draft', 'reports\0draft',
    'reports\ndraft', 'reports\u007fdraft', 'e\u0301', '\ud800', 'a'.repeat(101),
    Array.from({ length: 17 }, () => 'directory').join('/')]
  for (const cwd of paths) {
    const f = fixture()
    await assert.rejects(f.devices.propose('synthetic-grant', 'synthetic-call', 'printf synthetic', cwd),
      { status: 400, code: 'invalid_cwd' }, JSON.stringify(cwd))
    assert.equal(f.row(), null)
    assert.equal(f.authorizations.length, 1)
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(f.queries.filter(query => !['BEGIN', 'ROLLBACK'].includes(query.sql)).length, 1,
      'only the original receipt lookup may run before refusal')
  }
})

test('root and canonical directory names are accepted without path or digest rewriting', async () => {
  for (const cwd of ['', '.', 'reports', 'reports/draft', '中文目录/结果', 'space dir', '😀',
    'a'.repeat(100), Array.from({ length: 16 }, () => 'directory').join('/')]) {
    const f = fixture()
    const receipt = await f.devices.propose('synthetic-grant', 'synthetic-call', 'printf synthetic', cwd)
    assert.equal(receipt.state, 'queued')
    assert.equal(receipt.cwd, cwd)
    const stored = f.row()
    assert.deepEqual(stored.dispatch_request, { command: 'printf synthetic', cwd, timeoutMs: 1234,
      deviceId: f.target.deviceId, directoryId: f.target.directoryId })
    assert.equal(stored.request_digest, hash(stored.dispatch_request))
    const before = structuredClone(stored)
    assert.deepEqual(await f.devices.propose('synthetic-grant', 'synthetic-call', 'printf synthetic', cwd), receipt)
    assert.deepEqual(f.row(), before)
    assert.equal(f.queries.filter(query => query.sql.includes('INSERT INTO pe_desktop_executions')).length, 1)
  }
})

test('historical invalid cwd returns its frozen receipt before new admission rules, with no mutation', async () => {
  for (const cwd of ['/workspace', '../outside', 'reports\0draft', '', '.']) {
    const f = fixture(), original = f.saveLegacy(cwd), rebuilt = new DeviceService(f.tasks, 9876, {})
    const receipt = await rebuilt.propose('synthetic-grant', 'synthetic-call', 'printf synthetic', cwd)
    assert.deepEqual(receipt, { executionId: original.id, state: 'queued', command: original.command, cwd,
      target: f.target, result: null, errorCode: null })
    assert.deepEqual(f.row(), original)
    assert.equal(f.queries.at(-1).sql, 'COMMIT')
    assert.equal(f.queries.length, 3, 'receipt lookup must precede any new admission checks or writes')
    await assert.rejects(rebuilt.propose('synthetic-grant', 'synthetic-call', 'printf changed', cwd),
      { code: 'request_id_conflict' })
    assert.deepEqual(f.row(), original)
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
  }
})

test('native Host tool explains relative cwd, preserves the default and forwards old receipt retries unchanged', async t => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  let ctx
  await root.inject(['tools', 'systemPrompt'], ready => { ctx = ready })
  const f = fixture(), calls = []
  const runtime = { async call(path, token, input) {
    assert.equal(path, '/runtime/desktop-executions/propose')
    calls.push(input)
    return f.devices.propose(token, input.callId, input.command, input.cwd)
  } }
  const id = SessionId(randomUUID()), agent = { id, session: Session.create(id), ctx: undefined }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  installExecutionTools(agent, { target: f.target, token: 'synthetic-grant', executionEnabled: false }, runtime)
  const request = args => ctx.tools.execute({ agent, signal: new AbortController().signal, name: 'desktop_exec',
    arguments: args, callId: ToolCallId('synthetic-call') })
  const rejected = await request({ command: 'printf synthetic', cwd: '/workspace' })
  assert.equal(rejected.isError, true)
  assert.match(JSON.stringify(rejected.content), /invalid_cwd/u)
  assert.equal(f.row(), null)
  const accepted = await request({ command: 'printf synthetic' })
  assert.equal(accepted.isError, false)
  assert.equal(JSON.parse(accepted.content[0].text).cwd, '')
  assert.equal(calls.at(-1).cwd, '')
  const original = f.saveLegacy('/workspace')
  const legacy = await request({ command: 'printf synthetic', cwd: '/workspace' })
  assert.equal(legacy.isError, false)
  assert.equal(JSON.parse(legacy.content[0].text).cwd, '/workspace')
  assert.deepEqual(f.row(), original)
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  const tool = assembly.tools.find(value => value.name === 'desktop_exec')
  assert.match(tool.description, /cwd is relative to that project root/u)
  assert.match(tool.description, /use "\." for \/workspace/u)
  assert.match(tool.parameters.properties.cwd.description, /Project-root-relative directory/u)
  assert.deepEqual(calls.map(value => value.cwd), ['/workspace', '', '/workspace'])
  await scope.dispose()
})
