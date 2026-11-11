import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CandidateError, inspectExec, matchApplicationExec, selectProcessState } from './inspect.mjs'

const containerNamespace = 'mnt:[100]'
const namespaceId = 'mnt:[200]'
const app = { pid: 20, uid: 2000, comm: 'MainThread', namespaceId, startTicks: '123', isApp: true, isHolder: false }
const holder = { pid: 21, uid: 0, comm: 'sleep', namespaceId, startTicks: '124', isApp: false, isHolder: true }
const containerSleep = { ...holder, pid: 7, namespaceId: containerNamespace }

test('does not mistake the container sleep for a retained application namespace', () => {
  const result = selectProcessState([app, containerSleep], containerNamespace)
  assert.equal(result.app.pid, 20)
  assert.equal(result.holder, null)
  assert.equal(result.namespacePid, 20)
  assert.match(result.issues[0], /停止应用前必须先保留/)
})

test('selects an independent holder in the same namespace and retains it without an app', () => {
  assert.equal(selectProcessState([app, holder, containerSleep], containerNamespace).namespacePid, 21)
  const stopped = selectProcessState([holder, containerSleep], containerNamespace)
  assert.equal(stopped.app, null)
  assert.equal(stopped.namespaceId, namespaceId)
  assert.deepEqual(stopped.issues, [])
})

test('refuses multiple applications or multiple possible retained namespaces', () => {
  assert.throws(() => selectProcessState([app, { ...app, pid: 22 }], containerNamespace), /多个应用实例/)
  assert.throws(() => selectProcessState([holder, { ...holder, pid: 22, namespaceId: 'mnt:[300]' }], containerNamespace), /多个保留的挂载命名空间/)
  assert.throws(() => selectProcessState([containerSleep], containerNamespace), /未发现应用/)
})

test('reports multiple holders in one namespace rather than guessing a keeper', () => {
  const result = selectProcessState([app, holder, { ...holder, pid: 22 }], containerNamespace)
  assert.equal(result.holder, null)
  assert.match(result.issues[0], /多个保留进程/)
})

test('binds an exec only through a unique independently observed host process', () => {
  const execution = { execId: 'test-exec', hostPid: 200, running: true, exitCode: null }
  assert.equal(matchApplicationExec(app, [{ pid: 200, comm: 'MainThread' }], [execution]), execution)
  assert.equal(matchApplicationExec(app, [{ pid: 201, comm: 'MainThread' }], [execution]), null)
  assert.equal(matchApplicationExec(app, [{ pid: 200, comm: 'MainThread' }, { pid: 201, comm: 'MainThread' }], [execution]), null)
  assert.equal(matchApplicationExec(app, [{ pid: 200, comm: 'MainThread' }], [{ ...execution, running: false }]), null)
})

test('an expired Docker exec record is explicitly missing without inventing an exit code', async () => {
  const execId = 'a'.repeat(64)
  const result = await inspectExec(execId, { request: async (method, route) => {
    assert.equal(method, 'GET')
    assert.equal(route, '/exec/' + execId + '/json')
    throw new CandidateError('本机 Docker 请求失败。', 404)
  } })
  assert.deepEqual(result, { execId, running: false, exitCode: null, hostPid: 0, missing: true })
})

test('normal Docker exec observations retain the existing result fields', async () => {
  const execId = 'b'.repeat(64)
  assert.deepEqual(await inspectExec(execId, { request: async () => ({ ID: execId, Running: true, ExitCode: null, Pid: 42 }) }),
    { execId, running: true, exitCode: null, hostPid: 42 })
})

test('Docker failures other than 404 remain failures', async () => {
  const failure = new CandidateError('本机 Docker 请求失败。', 500)
  await assert.rejects(inspectExec('c'.repeat(64), { request: async () => { throw failure } }), error => error === failure)
})
