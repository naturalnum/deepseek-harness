/** Source Device plugin composition with native Cordis, HTTP and flock; no model, PostgreSQL or Docker. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-cmdline'
import * as Device from '../src/device/index.ts'
import { DesktopWorker } from '../src/device/worker.ts'
import { DeviceProcessLock } from '../src/device/process-lock.ts'
import { deviceLifecycleReady, deviceLifecycleResponse } from '@power-evolve/contracts/device-lifecycle'

const supported = ['darwin', 'linux'].includes(process.platform)
async function until(check: () => boolean): Promise<void> {
  for (let count = 0; count < 300; count++) { if (check()) return; await delay(10) }
  throw new Error('source Device fixture deadline')
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function fixture(t: TestContext, parent: 'none' | 'owned' | 'missing-channel' = 'owned') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-parent-device-'))
  const privateDir = join(root, 'private'), readyFile = join(root, 'ready.json'), ctx = new Context()
  const originalLaunch = process.env.PE_DEVICE_LAUNCH_ID
  const originalSend = Object.getOwnPropertyDescriptor(process, 'send')
  const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected')
  const launchId = randomUUID(), packets: unknown[] = [], exits: number[] = [], listeners = new Set<() => void>()
  if (parent === 'none') delete process.env.PE_DEVICE_LAUNCH_ID
  else process.env.PE_DEVICE_LAUNCH_ID = launchId
  Object.defineProperty(process, 'connected', { configurable: true, value: true })
  Object.defineProperty(process, 'send', { configurable: true, value: parent === 'missing-channel' ? undefined
    : (value: unknown, done: (error: Error | null) => void) => { packets.push(value); done(null) } })
  t.after(async () => {
    try { await ctx.fiber.dispose(); assert.equal(listeners.size, 0) }
    finally {
      if (originalLaunch === undefined) delete process.env.PE_DEVICE_LAUNCH_ID
      else process.env.PE_DEVICE_LAUNCH_ID = originalLaunch
      for (const [key, descriptor] of [['send', originalSend], ['connected', originalConnected]] as const) {
        if (descriptor) Object.defineProperty(process, key, descriptor)
        else Reflect.deleteProperty(process, key)
      }
      await rm(root, { recursive: true, force: true })
    }
  })
  ctx.provide('appReady', { onReady(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } })
  ctx.provide('appExit', code => { exits.push(code) })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const url = `http://127.0.0.1:${ctx.webServer.port}`
  const config: Device.Config = { platformUrl: 'http://127.0.0.1:1', privateDir, coordinationRoot: join(root, 'writers'),
    pythonExecutable: '/usr/bin/python3', fileOperationTimeoutMs: 1000, image: 'fixture:no-execute', pollMs: 100,
    contactGraceMs: 1000, commandPollMs: 10, platformRequestTimeoutMs: 100, dockerCommandTimeoutMs: 1000,
    dockerStopTimeoutMs: 1000, dockerStopGraceSeconds: 0, directoryPickerTimeoutMs: 1000, readyFile }
  function request(action: 'quiesce' | 'inspect' | 'terminate', instanceId: string | null = null) {
    process.emit('message', { kind: 'power-evolve-device-lifecycle', version: 1, launchId, type: 'request',
      requestId: randomUUID(), action, instanceId }, undefined)
  }
  return { root, ctx, config, url, readyFile, packets, exits, request,
    commit: () => { for (const listener of [...listeners]) listener() } }
}

test('source Device enables parent IPC only with explicit launch and publishes ready after appReady', { skip: !supported }, async t => {
  const f = await fixture(t)
  await Device.apply(f.ctx, f.config)
  assert.equal(f.packets.length, 0)
  assert.equal((await (await fetch(f.url + '/health')).json()).ready, false)
  await assert.rejects(readFile(f.readyFile), { code: 'ENOENT' })
  f.commit()
  await until(() => f.packets.length === 1)
  const ready = deviceLifecycleReady.parse(f.packets[0])
  assert.equal(ready.pid, process.pid); assert.equal(ready.url, f.url)
  const health = await (await fetch(f.url + '/health')).json()
  assert.equal(health.ready, true); assert.equal(health.instanceId, ready.instanceId)
  const local = await (await fetch(f.url + '/config')).json()
  f.request('quiesce', ready.instanceId)
  for (const operation of ['choose', 'pair', 'authorize', 'import', 'export']) {
    const response = await fetch(f.url + '/api/' + operation, { method: 'POST', headers: {
      origin: f.url, 'content-type': 'application/json', 'x-pe-device-nonce': local.nonce }, body: '{}' })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'device_draining' })
  }
  await until(() => f.packets.length === 2)
  const drained = deviceLifecycleResponse.parse(f.packets[1])
  assert.equal(drained.status, 'ok')
  if (drained.status === 'ok') {
    assert.equal(drained.snapshot.phase, 'quiescent')
    assert.deepEqual(drained.snapshot.drain, { entries: [], cleanupPending: 0 })
  }
  assert(!JSON.stringify(f.packets).includes(f.root))
  assert(!JSON.stringify(f.packets).includes(local.nonce))
  f.request('terminate', ready.instanceId)
  await until(() => f.exits.length === 1)
  assert.deepEqual(f.exits, [0])
})

test('source independent Device retains ready file and does not install parent lifecycle', { skip: !supported }, async t => {
  const f = await fixture(t, 'none')
  await Device.apply(f.ctx, f.config); f.commit()
  const ready = JSON.parse(await readFile(f.readyFile, 'utf8'))
  assert.equal(ready.pid, process.pid)
  assert.equal((await (await fetch(f.url + '/health')).json()).ready, true)
  assert.equal(f.packets.length, 0)
})

test('source admission is checked again when an HTTP body finishes after quiescence', { skip: !supported }, async t => {
  const f = await fixture(t)
  await Device.apply(f.ctx, f.config); f.commit()
  const local = await (await fetch(f.url + '/config')).json()
  const ready = deviceLifecycleReady.parse(f.packets[0])
  let finish!: () => void
  const incoming = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = httpRequest(f.url + '/api/pair', { method: 'POST', headers: {
      origin: f.url, 'content-type': 'application/json', 'x-pe-device-nonce': local.nonce } }, response => {
      let body = ''
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk })
      response.once('end', () => resolve({ status: response.statusCode, body }))
    })
    request.once('error', reject); request.write('{')
    finish = () => request.end('}')
    t.after(() => request.destroy())
  })
  // The handler is waiting for the rest of this body while admission is still open.
  await delay(20)
  f.request('quiesce', ready.instanceId)
  await until(() => f.packets.length === 2)
  finish()
  const response = await incoming
  assert.equal(response.status, 409)
  assert.deepEqual(JSON.parse(response.body), { error: 'device_draining' })
})

test('explicit parent launch without a real IPC channel is refused before initialization', { skip: !supported }, async t => {
  const f = await fixture(t, 'missing-channel')
  await assert.rejects(Device.apply(f.ctx, f.config), /device_parent_channel_required/u)
  await assert.rejects(readFile(f.readyFile), { code: 'ENOENT' })
})

test('source startup quiesce during actual flock acquisition never starts polling or emits ready', { skip: !supported }, async t => {
  const f = await fixture(t), entered = gate(), held = gate(), acquire = DeviceProcessLock.acquire
  t.mock.method(DeviceProcessLock, 'acquire', async (path: string) => { entered.release(); await held.promise; return acquire(path) })
  const started = t.mock.method(DesktopWorker.prototype, 'start')
  t.after(() => held.release())
  await mkdir(f.config.privateDir, { mode: 0o700 })
  const applying = Device.apply(f.ctx, f.config)
  await entered.promise
  f.request('quiesce')
  held.release(); await applying; f.commit()
  await until(() => f.packets.length === 1)
  assert.equal(started.mock.callCount(), 0)
  const response = deviceLifecycleResponse.parse(f.packets[0])
  assert.equal(response.status, 'ok')
  if (response.status === 'ok') assert.equal(response.snapshot.phase, 'quiescent')
  f.request('terminate', response.instanceId)
  await until(() => f.exits.length === 1)
})
