/** Real owned OS children and loopback HTTP; the child is a protocol fixture, not DSH/Worker/Docker/PG. */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { DeviceProcess, DeviceProcessError, type DeviceProcessOptions } from '../src/device-process.ts'

const childFixture = fileURLToPath(new URL('./fixtures/device-lifecycle-child.ts', import.meta.url))
async function fixture(t: TestContext, scenario = 'normal', overrides: Partial<DeviceProcessOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pe-desktop-device-process-'))
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { reject(new Error('missing test port')); return }
      server.close(error => { if (error !== undefined) reject(error); else resolve(address.port) })
    })
  })
  const record = join(root, 'record.jsonl'), failures: DeviceProcessError[] = []
  const processOwner = new DeviceProcess({ nodeExecutable: process.execPath, cliEntrypoint: childFixture,
    homeDir: root, profile: 'test-device', workingDir: root, loopbackOrigin: `http://127.0.0.1:${port}`,
    env: { FIXTURE_SCENARIO: scenario, FIXTURE_RECORD: record, FIXTURE_PORT: String(port),
      PROVIDER_KEY: 'synthetic', PE_DEVICE_TOKEN: 'synthetic', DATABASE_URL: 'synthetic', PE_DEVICE_NONCE: 'synthetic',
      NODE_OPTIONS: '--invalid-option', NODE_PATH: '/synthetic', DSH_HOME: '/synthetic' },
    startupTimeoutMs: 2000, requestTimeoutMs: 700, quiesceTimeoutMs: 1000, exitTimeoutMs: 700,
    maxOutputBytes: 10000, maxMessageBytes: 10000, maxHealthBytes: 4096, ...overrides }, error => { failures.push(error) })
  t.after(async () => {
    try { await processOwner.stop() }
    catch (_uncleanFixture) { /* Rejected cleanup still awaits owned child close. */ }
    await rm(root, { recursive: true, force: true })
  })
  async function records(): Promise<Record<string, unknown>[]> {
    return (await readFile(record, 'utf8')).trim().split('\n').map(value => JSON.parse(value) as Record<string, unknown>)
  }
  return { owner: processOwner, failures, records }
}
function gone(pid: number): void { assert.throws(() => { process.kill(pid, 0) }, { code: 'ESRCH' }) }
function code(expected: string) { return (error: unknown): boolean => error instanceof DeviceProcessError && error.code === expected && error.message === expected }

test('starts the official CLI argv with a scrubbed explicit environment, inspects and drains once', async t => {
  const { owner, records, failures } = await fixture(t)
  assert(owner.exitConfirmed)
  const first = owner.start(), concurrent = owner.start()
  assert.equal(owner.exitConfirmed, false)
  assert.equal(concurrent, first)
  const ready = await first
  assert.equal((await owner.start()).pid, ready.pid)
  assert.equal((await owner.inspect()).phase, 'ready')
  const stop = owner.stop()
  assert.equal(owner.exitConfirmed, false)
  assert.equal(owner.stop(), stop)
  await stop
  await owner.stop()
  gone(ready.pid)
  assert(owner.exitConfirmed)
  assert(owner.lastStopClean)
  assert.deepEqual(owner.lastDrain, { entries: [], cleanupPending: 0 })
  assert.equal(owner.lastSnapshot?.phase, 'quiescent')
  const rows = await records()
  assert.deepEqual(rows[0]?.args, ['--profile', 'test-device'])
  assert.equal(rows[0]?.scrubbed, true)
  assert.equal(rows[0]?.homeSet, true)
  assert.deepEqual(rows.slice(1).map(row => row.action), ['inspect', 'quiesce', 'inspect', 'terminate'])
  assert.equal(new Set(rows.slice(1).map(row => row.requestId)).size, 4)
  assert.equal(failures.length, 0)
  const successor = await owner.start()
  assert.equal(owner.exitConfirmed, false)
  assert.notEqual(successor.launchId, ready.launchId)
  assert.notEqual(successor.instanceId, ready.instanceId)
  await owner.stop()
  gone(successor.pid)
  assert(owner.exitConfirmed)
})

for (const [scenario, expected] of [
  ['wrong_pid', 'device_ready_identity'], ['wrong_launch', 'device_ready_identity'], ['wrong_url', 'device_ready_identity'],
  ['health_stale', 'device_health_identity'], ['health_redirect', 'device_health_failed'], ['health_huge', 'device_health_limit'],
  ['health_hang', 'device_health_failed'], ['message_limit', 'device_message_limit'], ['output_limit', 'device_output_limit'],
] as const) {
  test(`rejects ${scenario}, awaits its exact child and does not expose private diagnostics`, async t => {
    const { owner, records } = await fixture(t, scenario)
    await assert.rejects(owner.start(), code(expected))
    const row = (await records())[0]
    assert.equal(typeof row?.pid, 'number')
    if (typeof row?.pid === 'number') gone(row.pid)
    assert(owner.exitConfirmed)
    assert.equal(owner.lastStopClean, false)
    assert.equal(owner.lastDrain, undefined)
  })
}

test('accepts duplicate ready/response messages without duplicate shutdown or orphan', async t => {
  const { owner, records } = await fixture(t, 'duplicate')
  const ready = await owner.start()
  await owner.stop()
  gone(ready.pid)
  assert.equal((await records()).filter(row => row.action === 'terminate').length, 1)
  assert(owner.lastStopClean)
})

test('does not turn a later, expired inspect response into current facts or replay a timed-out request', async t => {
  const { owner, records } = await fixture(t, 'late_inspect', { requestTimeoutMs: 100 })
  await owner.start()
  await assert.rejects(owner.inspect(), code('device_request_timeout'))
  const beforeSecondRequest = owner.lastSnapshot
  assert.equal(beforeSecondRequest, undefined)
  assert.equal((await owner.inspect()).phase, 'ready')
  await delay(350)
  assert.equal(owner.lastSnapshot?.phase, 'ready')
  assert.equal((await records()).filter(row => row.action === 'inspect').length, 2)
  await owner.stop()
})

test('rejects a response from another instance and closes the owned child', async t => {
  const { owner, failures } = await fixture(t, 'wrong_response_instance')
  const ready = await owner.start()
  await assert.rejects(owner.inspect(), code('device_response_identity'))
  await assert.rejects(owner.stop())
  gone(ready.pid)
  assert.equal(failures.length, 1)
  assert.equal(owner.lastStopClean, false)
})

test('shutdown cancels an earlier inspect without accepting its later observation', async t => {
  const { owner } = await fixture(t, 'late_inspect')
  const ready = await owner.start()
  const inspect = owner.inspect()
  const rejected = assert.rejects(inspect, code('device_start_cancelled'))
  await owner.stop()
  await rejected
  gone(ready.pid)
  assert.equal(owner.lastSnapshot?.phase, 'quiescent')
  assert(owner.lastStopClean)
})

test('waits for a quiesce longer than five seconds using its explicit budget', { timeout: 10000 }, async t => {
  const { owner } = await fixture(t, 'slow_quiesce', { quiesceTimeoutMs: 6500 })
  const ready = await owner.start(), started = Date.now()
  const stop = owner.stop()
  await delay(100)
  assert.equal(owner.exitConfirmed, false)
  await stop
  assert(Date.now() - started >= 5000)
  gone(ready.pid)
  assert(owner.lastStopClean)
})

for (const scenario of ['residual', 'cleanup_pending']) {
  test(`terminates quiescent ${scenario} but retains facts and rejects a safe update claim`, async t => {
    const { owner, records } = await fixture(t, scenario)
    const ready = await owner.start()
    await assert.rejects(owner.stop(), code('device_stop_unclean'))
    gone(ready.pid)
    assert(owner.exitConfirmed)
    assert.equal(owner.lastStopClean, false)
    assert.equal((await records()).filter(row => row.action === 'terminate').length, 1)
    assert(owner.lastDrain !== undefined)
    if (scenario === 'residual') assert.equal(owner.lastDrain.entries[0]?.state, 'unconfirmed')
    else assert.equal(owner.lastDrain.cleanupPending, 1)
  })
}

for (const scenario of ['exit_no_report', 'terminate_no_ack', 'no_quiesce']) {
  test(`exit or force-stop in ${scenario} cannot replace the drain/terminate acknowledgement`, async t => {
    const { owner, records } = await fixture(t, scenario, { quiesceTimeoutMs: 100 })
    const ready = await owner.start()
    await assert.rejects(owner.stop())
    await assert.rejects(owner.stop())
    gone(ready.pid)
    assert(owner.exitConfirmed)
    assert.equal(owner.lastStopClean, false)
    assert.equal((await records()).filter(row => row.action === 'quiesce').length, 1)
  })
}

test('startup cancellation binds only its quiesce response instance for terminate and never becomes ready', async t => {
  const { owner, records } = await fixture(t, 'startup_delay', { quiesceTimeoutMs: 100 })
  const start = owner.start()
  const rejected = assert.rejects(start, code('device_start_cancelled'))
  let rows: Record<string, unknown>[] = []
  for (let i = 0; i < 100 && rows.length === 0; i++) {
    try { rows = await records() }
    catch (_notCreatedYet) { await delay(10) }
  }
  assert.equal(typeof rows[0]?.pid, 'number')
  await owner.stop()
  await rejected
  if (typeof rows[0]?.pid === 'number') gone(rows[0].pid)
  assert.equal(owner.lastStopClean, true)
  assert.deepEqual(owner.lastDrain, { entries: [], cleanupPending: 0 })
  const messages = (await records()).slice(1)
  assert.deepEqual(messages.map(row => row.action), ['quiesce', 'inspect', 'terminate'])
  assert.equal(messages[0]?.instanceId, null)
  assert.equal(typeof messages[1]?.instanceId, 'string')
  assert.equal(messages[2]?.instanceId, messages[1]?.instanceId)
})

for (const scenario of ['cancel_no_report', 'cancel_wrong_request', 'cancel_wrong_phase']) {
  test(`startup cancellation ${scenario} cannot fabricate a drain or readiness`, async t => {
    const { owner, records } = await fixture(t, scenario, { quiesceTimeoutMs: 100 })
    const start = owner.start(), rejected = assert.rejects(start, code('device_start_cancelled'))
    let rows: Record<string, unknown>[] = []
    for (let i = 0; i < 100 && rows.length === 0; i++) {
      try { rows = await records() }
      catch (_notCreatedYet) { await delay(10) }
    }
    assert.equal(typeof rows[0]?.pid, 'number')
    await assert.rejects(owner.stop())
    await rejected
    if (typeof rows[0]?.pid === 'number') gone(rows[0].pid)
    assert.equal(owner.lastStopClean, false)
    assert.equal(owner.lastDrain, undefined)
    assert.equal((await records()).filter(row => row.action === 'terminate').length, 0)
  })
}

test('unexpected signal exit publishes one fixed failure and retains unclean shutdown', async t => {
  const { owner, failures } = await fixture(t)
  const ready = await owner.start()
  process.kill(ready.pid, 'SIGTERM')
  for (let i = 0; i < 100 && failures.length === 0; i++) await delay(10)
  await assert.rejects(owner.stop(), code('device_stop_unclean'))
  gone(ready.pid)
  assert.equal(failures.length, 1)
  assert(['device_ipc_closed', 'device_child_exited'].includes(failures[0]!.code))
  assert.equal(owner.lastStopClean, false)
})

test('startup timeout force-kills only its signal-resistant owned child and awaits close', async t => {
  const { owner, records } = await fixture(t, 'ignore_signals', { startupTimeoutMs: 200, exitTimeoutMs: 100 })
  await assert.rejects(owner.start(), code('device_start_timeout'))
  const row = (await records())[0]
  if (typeof row?.pid === 'number') gone(row.pid)
  assert.equal(owner.lastStopClean, false)
})
