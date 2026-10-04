/** Private IPC ordering with keyless transports; these cases are not Electron or Docker end-to-end acceptance. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { deviceDrainReport, deviceLifecycleReady, deviceLifecycleResponse, type DeviceDrainReport, type DeviceLifecycleSnapshot,
  type DeviceLifecycleReady, type DeviceLifecycleResponse } from '@power-evolve/contracts/device-lifecycle'
import { DeviceParentLifecycle, type DeviceParentChannel, type DeviceLifecycleWorker } from '../src/device/lifecycle.ts'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function until(check: () => boolean): Promise<void> {
  for (let count = 0; count < 300; count++) { if (check()) return; await delay(10) }
  throw new Error('lifecycle fixture deadline')
}
class Channel implements DeviceParentChannel {
  connected = true
  pid = process.pid
  readonly messages: (DeviceLifecycleReady | DeviceLifecycleResponse)[] = []
  message: ((value: unknown) => void) | undefined
  disconnected: (() => void) | undefined
  send(value: DeviceLifecycleReady | DeviceLifecycleResponse, done: (error: Error | null) => void): void {
    assert(this.connected)
    this.messages.push(value.type === 'ready' ? deviceLifecycleReady.parse(value) : deviceLifecycleResponse.parse(value))
    done(null)
  }
  onMessage(listener: (value: unknown) => void): () => void {
    this.message = listener; return () => { this.message = undefined }
  }
  onDisconnect(listener: () => void): () => void {
    this.disconnected = listener; return () => { this.disconnected = undefined }
  }
}
class Worker implements DeviceLifecycleWorker {
  open = true
  pending = 1
  calls = 0
  held = gate()
  failure: Error | undefined
  report: DeviceDrainReport = deviceDrainReport.parse({ entries: [{ executionId: randomUUID(), state: 'unconfirmed' }], cleanupPending: 1 })
  inspectLifecycle(): Pick<DeviceLifecycleSnapshot, 'admissionOpen' | 'pendingActions' | 'journalEntries'> {
    return { admissionOpen: this.open, pendingActions: this.pending, journalEntries: this.report.entries.length }
  }
  async quiesce(): Promise<DeviceDrainReport> {
    this.calls++; this.open = false
    await this.held.promise
    this.pending = 0
    if (this.failure) throw this.failure
    return this.report
  }
}
function fixture(t: TestContext, connected = true) {
  const channel = new Channel(), worker = new Worker(), launchId = randomUUID(), instanceId = randomUUID()
  channel.connected = connected
  const exits: number[] = [], failures: string[] = [], picker = gate()
  let pickerCalls = 0
  const lifecycle = new DeviceParentLifecycle({ launchId, instanceId, url: 'http://127.0.0.1:20891', channel, worker,
    closePicker: () => { pickerCalls++; return picker.promise }, exit: code => { exits.push(code) }, failure: code => { failures.push(code) } })
  t.after(async () => {
    worker.held.release(); picker.release()
    try { await lifecycle.dispose() } catch (_expectedFixtureFailure) {
      // Failure cases assert the error before cleanup joins the same failed completion.
    }
  })
  function request(action: 'inspect' | 'quiesce' | 'terminate', changes: object = {}) {
    const value = { kind: 'power-evolve-device-lifecycle', version: 1, type: 'request', launchId,
      instanceId, action, requestId: randomUUID(), ...changes }
    channel.message!(value)
    return value
  }
  return { channel, worker, launchId, instanceId, exits, failures, picker, lifecycle, request,
    pickerCalls: () => pickerCalls,
    responses: () => channel.messages.filter((value): value is DeviceLifecycleResponse => value.type === 'response') }
}

test('ready is explicit and cancelled startup never publishes it', async t => {
  const f = fixture(t)
  assert.equal(f.channel.messages.length, 0)
  f.request('quiesce', { instanceId: null })
  assert.equal(f.lifecycle.admissionOpen, false)
  assert.equal(f.worker.open, false)
  f.lifecycle.ready()
  assert.equal(f.channel.messages.length, 0)
  f.worker.held.release(); f.picker.release()
  await until(() => f.responses().length === 1)
  assert.equal(f.lifecycle.snapshot().phase, 'quiescent')
  assert.equal(f.exits.length, 0)
})

test('wrong launch, wrong instance and malformed terminate refuse without closing admission', async t => {
  const f = fixture(t)
  f.lifecycle.ready()
  f.request('quiesce', { launchId: randomUUID() })
  f.request('quiesce', { instanceId: randomUUID() })
  f.request('terminate', { instanceId: null })
  f.request('terminate')
  await until(() => f.responses().length === 4)
  assert.deepEqual(f.responses().map(value => value.status === 'error' ? value.code : 'unexpected'),
    ['invalid_request', 'wrong_instance', 'invalid_request', 'not_quiescent'])
  assert.equal(f.worker.calls, 0)
  assert.equal(f.lifecycle.admissionOpen, true)
  assert.equal(f.exits.length, 0)
})

test('duplicate quiesce joins picker and Worker exit, then exact terminate exits once', async t => {
  const f = fixture(t)
  f.lifecycle.ready()
  f.request('quiesce'); f.request('quiesce')
  assert.equal(f.worker.calls, 1); assert.equal(f.pickerCalls(), 1)
  f.worker.held.release()
  await delay(20)
  assert.equal(f.responses().length, 0)
  f.picker.release()
  await until(() => f.responses().length === 2)
  assert.deepEqual(f.responses()[0], { ...f.responses()[1], requestId: f.responses()[0]!.requestId })
  assert.equal(f.lifecycle.snapshot().drain?.entries[0]?.state, 'unconfirmed')
  f.request('terminate', { instanceId: randomUUID() })
  f.request('terminate'); f.request('terminate')
  await until(() => f.responses().length === 5)
  assert.deepEqual(f.exits, [0])
})

test('parent disconnect drains beyond five seconds before requesting CLI exit', { timeout: 10000 }, async t => {
  const f = fixture(t)
  f.lifecycle.ready()
  f.channel.connected = false; f.channel.disconnected!()
  assert.equal(f.worker.open, false)
  await delay(5200)
  assert.deepEqual(f.exits, [])
  f.worker.held.release(); f.picker.release()
  await until(() => f.exits.length === 1)
  assert.deepEqual(f.exits, [0]); assert.equal(f.worker.calls, 1)
})

test('an already disconnected channel cancels before startup and reports drain failure with fixed text', async t => {
  const f = fixture(t, false)
  assert.equal(f.lifecycle.admissionOpen, false)
  f.worker.failure = new Error('/private/fixture-root with credential-like text')
  f.lifecycle.ready(); f.worker.held.release(); f.picker.release()
  await until(() => f.exits.length === 1)
  assert.deepEqual(f.exits, [1])
  assert.deepEqual(f.failures, ['device_parent_quiesce_failed'])
  assert.equal(f.channel.messages.length, 0)
  assert.equal(f.lifecycle.snapshot().drain, null)
})

test('failed durable collection awaits picker exit and produces no stop facts', async t => {
  const f = fixture(t)
  f.worker.failure = new Error('fixture sync failed at /private/fixture-root')
  f.request('quiesce'); f.worker.held.release()
  await delay(20)
  assert.equal(f.responses().length, 0)
  f.picker.release()
  await until(() => f.responses().length === 1)
  const response = f.responses()[0]!
  assert.equal(response.status, 'error')
  if (response.status === 'error') assert.equal(response.code, 'quiesce_failed')
  assert.equal(f.lifecycle.snapshot().phase, 'error')
  assert.equal(f.lifecycle.snapshot().drain, null)
  assert(!JSON.stringify(response).includes('/private/'))
})
