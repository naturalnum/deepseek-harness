import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { CandidateError, inspectCandidate, inspectExec, matchApplicationExec, selectProcessState } from './inspect.mjs'

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

test('an explicitly handed-over carrier uses the original process, product and namespace checks through its bound operations', async () => {
  const execution = { execId: 'd'.repeat(64), hostPid: 200, running: true, exitCode: null }
  const observed = { rows: [{ ...app, gid: 2000, cwd: '/opt/dsh-installed-products', stdoutPath: '/opt/dsh-features/app.log', shutdownTimeoutMs: 120000 }, holder],
    containerNamespaceId: containerNamespace, productRoot: '/opt/dsh-installed-products', productDevice: '/dev/loop14',
    productReadOnly: true, productBlockReadOnly: true, productFilesystem: 'ext4', nodePath: '/dsh-tools/node24',
    appCheckPath: '/opt/dsh-features/arm-native-01/feature-namespace-steps.v3.mjs', seccompPath: '/opt/dsh-feature-assets/app-seccomp.bpf', profileHome: '/run/dsh-feature-root' }
  const calls = [], operations = { container: 'handed-over-runtime', appCheckPath: observed.appCheckPath, execute: async argv => {
    calls.push(argv)
    if (argv[0] === '/bin/ls') return '20 21 99'
    if (argv.join(' ') === '/bin/readlink /proc/1/ns/mnt') return containerNamespace
    if (argv[0] === '/dsh-tools/node24') {
      new Script(argv[2])
      if (argv[4] === 'namespace') return namespaceId
      if (argv[3] === '20') return '/dsh-tools/node24\0/opt/dsh-installed-products/apps/cli/lib/bin.js\0--profile\0cloud\0'
      if (argv[3] === '21') return '/bin/sleep\0infinity\0'
      if (argv[3] === '99') return '' // The short-lived directory observer has actually gone.
    }
    assert.equal(argv[0], '/proc/20/exe'); assert.equal(argv[1], '-e')
    assert.equal(argv[4], operations.appCheckPath)
    new Script(argv[2]) // Parse the actual remote program without executing any target operation.
    return JSON.stringify(observed)
  }, top: async () => [{ pid: 200, comm: 'MainThread' }], execIds: async () => [execution.execId], execution: async () => execution }
  const ready = await inspectCandidate(operations)
  assert.equal(ready.container, 'handed-over-runtime'); assert.equal(ready.canStopSafely, true)
  assert.equal(ready.appExecId, execution.execId); assert.equal(calls.length, 7)
  observed.productBlockReadOnly = false
  const refused = await inspectCandidate(operations)
  assert.equal(refused.canStopSafely, false)
  assert.equal(refused.issues.some(issue => issue.includes('块设备')), true)
  observed.productBlockReadOnly = true
  observed.appCheckPath = '/opt/dsh-features/feature-namespace-steps.v3.mjs'
  const mismatched = await inspectCandidate(operations)
  assert.equal(mismatched.canStopSafely, false)
  assert.equal(mismatched.issues.some(issue => issue.includes('检查脚本路径')), true)
})

test('an invalid original app-check path refuses before any target operation', async () => {
  for (const appCheckPath of ['/tmp/check.mjs', '/opt/dsh-features/../check.mjs', '/opt/dsh-features/check.mjs\0']) {
    let called = false
    await assert.rejects(inspectCandidate({ appCheckPath, execute: async () => { called = true; throw Error('must not execute') } }))
    assert.equal(called, false)
  }
})

test('a caller approval boolean cannot replace captured product mount evidence', async () => {
  for (const productMount of [true, { allow: true }, { kind: 'allow-bind', verified: true }, { kind: 'bind', verifier: { sha256: '0'.repeat(64) } }]) {
    let called = false
    await assert.rejects(inspectCandidate({ productMount, execute: async () => { called = true; throw Error('must not execute') } }))
    assert.equal(called, false)
  }
})
