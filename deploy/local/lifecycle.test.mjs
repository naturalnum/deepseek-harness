import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLaunchCommand, createLifecycle } from './lifecycle.mjs'

const EXEC = 'a'.repeat(64)
const HOLDER_EXEC = 'b'.repeat(64)
const namespaceId = 'mnt:[200]'
const snapshot = {
  appPid: 20, appStartTicks: '123', appExecId: EXEC, appUid: 2000,
  namespacePid: 21, namespaceId, namespaceKeeperPid: 21, namespaceKeeperStartTicks: '124',
  namespaceProcesses: [{ pid: 20, uid: 2000, comm: 'MainThread' }, { pid: 21, uid: 0, comm: 'sleep' }],
  canStopSafely: true, canStart: false, shutdownTimeoutMs: 40,
  nodePath: '/dsh-tools/node24', appCheckPath: '/opt/dsh-features/check.mjs',
  seccompPath: '/opt/dsh-feature-assets/app-seccomp.bpf', appCwd: '/opt/dsh-installed-products',
  profileHome: '/run/dsh-feature-root', logPath: '/opt/dsh-features/prelaunch/current.log',
  issues: [],
}
const holder = { pid: 21, startTicks: '124', namespaceId, execId: HOLDER_EXEC, owned: true }
const stopped = { ...snapshot, appPid: null, appExecId: null, canStart: true, canStopSafely: false }

test('launch redirects logs before entering the readonly namespace and passes all values positionally', () => {
  const unusual = { ...snapshot, profileHome: '/run/name with spaces/$literal' }
  const command = buildLaunchCommand(unusual, holder, '/opt/dsh-features/prelaunch/new.log')
  assert.deepEqual(command.slice(0, 2), ['/bin/sh', '-c'])
  assert.ok(command[2].indexOf('exec 1>') < command[2].indexOf('exec nsenter'))
  assert.match(command[2], /--reuid 2000 --regid 2000 --clear-groups/)
  assert.match(command[2], /--no-new-privs --bounding-set=-all/)
  assert.equal(command[2].includes(unusual.profileHome), false)
  assert.equal(command.at(-3), unusual.profileHome)
  assert.equal(command.at(-2), '40')
  assert.equal(command.at(-1), '21')
})

test('identity movement or an unretained namespace prevents any stop signal', async () => {
  let signals = 0
  const changed = createLifecycle({ inspect: async () => ({ ...snapshot, appStartTicks: 'changed' }), execute: async () => { signals++ } })
  await assert.rejects(changed.stopApplication(snapshot), /身份已经变化/)
  const unretained = createLifecycle({ inspect: async () => ({ ...snapshot, canStopSafely: false }), execute: async () => { signals++ } })
  await assert.rejects(unretained.stopApplication(snapshot), /尚未确认/)
  assert.equal(signals, 0)
})

test('normal stop sends one SIGTERM and waits for that exact exec to exit successfully', async () => {
  const commands = [], inspected = []
  const states = [{ running: true }, { running: true }, { running: false, exitCode: 0 }]
  const lifecycle = createLifecycle({
    inspect: async () => snapshot,
    execute: async args => { commands.push(args) },
    execution: async id => { inspected.push(id); return { execId: id, ...states.shift() } },
    wait: async () => {},
  })
  assert.deepEqual(await lifecycle.stopApplication(snapshot), { execId: EXEC, exitCode: 0, normalExit: true })
  assert.equal(commands.length, 1)
  assert.equal(JSON.parse(commands[0].at(-1)).signal, true)
  assert.equal(JSON.parse(commands[0].at(-1)).startTicks, '123')
  assert.deepEqual(inspected, [EXEC, EXEC, EXEC])
})

test('a nonzero original exec exit is a stop failure and does not trigger another signal', async () => {
  let signals = 0, count = 0
  const lifecycle = createLifecycle({
    inspect: async () => snapshot, execute: async () => { signals++ },
    execution: async id => ({ execId: id, running: count++ === 0, exitCode: 7 }),
  })
  await assert.rejects(lifecycle.stopApplication(snapshot), error => {
    assert.equal(error.exitCode, 7)
    assert.equal(error.message, '应用已退出，退出码7，产品文件未改动；运行复位脚本后用start恢复。')
    return true
  })
  assert.equal(signals, 1)
})

test('stop accepts exit zero after the existing shutdown budget within its thirty second observation allowance', async () => {
  let clock = 0
  const commands = []
  const lifecycle = createLifecycle({
    inspect: async () => snapshot, execute: async command => { commands.push(command) },
    execution: async id => ({ execId: id, running: clock < 80, exitCode: clock < 80 ? null : 0 }),
    now: () => clock, wait: async () => { clock += 40 },
  })
  assert.deepEqual(await lifecycle.stopApplication(snapshot), { execId: EXEC, exitCode: 0, normalExit: true })
  assert.equal(clock, 80)
  assert.equal(commands.length, 1)
  assert.equal(JSON.parse(commands[0].at(-1)).signal, true)
})

test('expiry after the existing shutdown budget plus thirty seconds never triggers SIGKILL or a second termination', async () => {
  let clock = 0, signals = 0
  const lifecycle = createLifecycle({
    inspect: async () => snapshot, execute: async () => { signals++ },
    execution: async id => ({ execId: id, running: true, exitCode: null }),
    now: () => clock, wait: async () => { clock += 40 },
  })
  await assert.rejects(lifecycle.stopApplication(snapshot), /不强杀、不重复发信号/)
  assert.equal(clock, snapshot.shutdownTimeoutMs + 30000)
  assert.equal(signals, 1)
})

test('a missing keeper is retained through one owned detached sleep in the existing namespace', async () => {
  const unretained = { ...snapshot, namespacePid: 20, namespaceKeeperPid: null,
    namespaceProcesses: snapshot.namespaceProcesses.slice(0, 1), canStopSafely: false }
  const observations = [unretained, unretained, snapshot], requests = [], commands = []
  let waited = 0
  const lifecycle = createLifecycle({
    inspect: async () => observations.shift(), execute: async args => { commands.push(args) },
    engine: async (method, route, payload) => { requests.push({ method, route, payload }); return route.endsWith('/exec') ? { Id: HOLDER_EXEC } : null },
    execution: async id => ({ execId: id, hostPid: 200, running: true, exitCode: null }),
    wait: async () => { waited++ },
  })
  const retained = await lifecycle.ensureNamespaceHolder(unretained)
  assert.equal(retained.pid, holder.pid)
  assert.equal(retained.execId, HOLDER_EXEC)
  assert.equal(retained.owned, true)
  assert.equal(waited, 1)
  assert.equal(JSON.parse(commands[0].at(-1)).signal, false)
  assert.deepEqual(requests[0].payload.Cmd.slice(0, 3), ['nsenter', '-t', '20'])
  assert.deepEqual(requests[0].payload.Cmd.slice(-2), ['/bin/sleep', 'infinity'])
  assert.equal(requests[1].payload.Detach, true)
})

test('an existing keeper is reused without taking ownership or starting another process', async () => {
  const lifecycle = createLifecycle({ inspect: async () => snapshot, engine: async () => { throw new Error('must not create') } })
  const result = await lifecycle.ensureNamespaceHolder(snapshot)
  assert.equal(result.pid, holder.pid)
  assert.equal(result.owned, false)
})

test('start refuses a running app and otherwise returns the newly created exec and log location', async () => {
  const requests = []
  const engine = async (method, route, payload) => { requests.push({ method, route, payload }); return route.endsWith('/exec') ? { Id: EXEC } : null }
  await assert.rejects(createLifecycle({ inspect: async () => snapshot, engine }).startApplication(snapshot, holder), /仍在运行/)
  assert.equal(requests.length, 0)
  const result = await createLifecycle({ inspect: async () => stopped, engine }).startApplication(snapshot, holder)
  assert.equal(result.execId, EXEC)
  assert.match(result.logPath, /^\/opt\/dsh-features\/prelaunch\/pe-cloud-[a-f0-9-]+\.log$/)
  assert.equal(requests[0].payload.Cmd[4], result.logPath)
  assert.equal(requests[0].payload.AttachStdout, false)
})

test('an unconfirmed launch retains its exact exec and private log path for recovery', async () => {
  const lifecycle = createLifecycle({
    inspect: async () => stopped,
    engine: async (_method, route) => {
      if (route.endsWith('/exec')) return { Id: EXEC }
      throw new Error('unknown start response')
    },
  })
  await assert.rejects(lifecycle.startApplication(snapshot, holder), error => {
    assert.equal(error.execId, EXEC)
    assert.match(error.logPath, /^\/opt\/dsh-features\/prelaunch\/pe-cloud-[a-f0-9-]+\.log$/)
    return true
  })
})
