/** Opt-in real PG, Docker and public Worker integration; HTTP faults are injected, no Agent or Electron is launched. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { DesktopWorker } from '../lib/device/worker.js'
import { OwnedDeviceContainer } from '../lib/device/owned-container.js'
import { DeviceService } from '../lib/platform/devices.js'
import { IdentityService } from '../lib/platform/identity.js'
import { routeExecutionResolutionApproval } from '../lib/platform/execution-resolution-routes.js'
import { deviceClaimRequest, deviceContainerRegistration, deviceFinishRequest } from '@power-evolve/contracts/device-execution'
import { deviceProtocolFixture } from './device-execution-protocol-fixture.mjs'
import { taskCredential } from './task-credential-fixture.mjs'

const image = process.env.PE_DEVICE_TEST_IMAGE
const options = { timeout: 60000, skip: !image || !['darwin', 'linux'].includes(process.platform) }
async function until(condition, label) {
  const deadline = Date.now() + 20000
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Device integration deadline: ${label}`)
    await delay(50)
  }
}

async function fixture(t, loseRegistrationAck = false, commandTimeoutMs = 1234, loseClaimAck = false, loseResolutionAck = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-device-real-'))
  const project = join(root, 'project'), privateRoot = join(root, 'private')
  await mkdir(project, { mode: 0o777 }); await chmod(project, 0o777)
  const containers = new OwnedDeviceContainer({ commandTimeoutMs: 15000, stopTimeoutMs: 10000, stopGraceSeconds: 1 })
  const receipts = new Map(), workers = []
  let server, origin, lost = false, lostClosure = false, lastFinish
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.close()))
    server?.closeAllConnections()
    if (server) await new Promise(resolve => server.close(resolve))
    for (const receipt of receipts.values()) {
      const state = await containers.inspect(receipt)
      if (state?.Running) await containers.stop(receipt)
      if (await containers.inspect(receipt)) await containers.remove(receipt)
    }
    await rm(root, { recursive: true, force: true })
  })
  const platform = await deviceProtocolFixture(t)
  platform.devices = new DeviceService(platform.tasks, commandTimeoutMs, {})
  const identities = new IdentityService(platform.pool, 3600000)
  async function route(req, res) {
    let text = ''
    for await (const bytes of req) { text += bytes; if (text.length > 524288) throw new Error('request_too_large') }
    const input = JSON.parse(text), token = req.headers.authorization?.replace(/^Bearer /u, '') ?? ''
    let reply
    if (req.url.startsWith('/approvals/executions/')) {
      const user = await identities.authenticate(token, 'approval')
      reply = await routeExecutionResolutionApproval(null, req.url, user, input, token,
        req.headers.origin, origin, platform.devices)
      if (req.url === '/approvals/executions/resolve' && loseResolutionAck && !lostClosure) {
        lostClosure = true; res.destroy(); return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply)); return
    }
    switch (req.url) {
      case '/devices/enroll': reply = await platform.devices.enroll(input.code, input.name, input.instanceId); break
      case '/devices/agent/directory': reply = await platform.devices.directory(token, input.label); break
      case '/devices/agent/jobs': reply = await platform.devices.jobs(token, input.instanceId); break
      case '/devices/agent/claim': {
        const value = deviceClaimRequest.parse(input)
        reply = await platform.devices.claim(token, value.instanceId, value.executionId, value.processId)
        if (loseClaimAck && !lost) { lost = true; res.destroy(); return }
        break
      }
      case '/devices/agent/register': {
        const value = deviceContainerRegistration.parse(input)
        receipts.set(value.receipt.containerId, value.receipt)
        reply = await platform.devices.register(token, value)
        if (loseRegistrationAck && !lost) { lost = true; res.destroy(); return }
        break
      }
      case '/devices/agent/finish': {
        lastFinish = deviceFinishRequest.parse(input)
        reply = await platform.devices.finish(token, lastFinish); break
      }
      default: res.writeHead(404).end('{}'); return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
  }
  server = createServer((req, res) => { void route(req, res).catch(error => {
    if (!res.destroyed) res.writeHead(error.status ?? 500, { 'content-type': 'application/json' }).end(JSON.stringify({ code: error.code ?? 'fixture_failure' }))
  }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  const worker = new DesktopWorker(origin, privateRoot, image,
    { pollMs: 100, contactGraceMs: 5000, commandPollMs: 50, platformRequestTimeoutMs: 3000 }, containers)
  workers.push(worker); await worker.init()
  const pair = await platform.devices.pair(platform.alice, await taskCredential(platform.pool, platform.alice))
  await worker.pair(pair.code, 'Real Docker test Device')
  const grant = await worker.authorize(project)
  const state = JSON.parse(await readFile(join(privateRoot, 'device.json'), 'utf8'))
  const device = { deviceId: state.deviceId, directoryId: grant.directoryId, instanceId: state.instanceId, token: state.token }
  const op = await platform.operation(platform.alice, device)
  const approval = async (path, input, token, selectedOrigin = origin) => {
    const response = await fetch(origin + path, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`, origin: selectedOrigin,
    }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) })
    return { status: response.status, body: await response.json() }
  }
  return { ...platform, worker, device, project, privateRoot, containers, op,
    approval, lastFinish: () => lastFinish, lost: () => lost, lostClosure: () => lostClosure }
}

test('real Device Git executes once and persists exact Docker stop identity before cleanup', options, async t => {
  const f = await fixture(t)
  const command = "git init -q && git -c user.name=DeviceQA -c user.email=device-qa@example.invalid commit --allow-empty -qm init && printf 'ONCE\\n' >> marker.txt && git rev-parse --is-inside-work-tree"
  const accepted = await f.devices.propose(f.op.grant.token, 'real-git-call', command, '.')
  f.worker.start()
  await until(async () => (await f.row(accepted.executionId)).stop_observation !== null, 'durable stop')
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0, 'journal cleanup')
  const row = await f.row(accepted.executionId)
  assert.equal(row.state, 'succeeded'); assert.equal(row.result.exitCode, 0)
  assert.match(row.result.stdout, /true/u); assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'ONCE\n')
  assert.equal(row.container_receipt.containerId.length, 64)
  assert.equal(row.container_receipt.owner.creationId, row.dispatch_id)
  assert.equal(row.stop_observation.receipt.containerId, row.container_receipt.containerId)
  assert.equal(row.stop_observation.Running, false); assert.equal(await f.continuations(accepted.executionId), 1)
  assert.equal(await f.containers.inspect(row.container_receipt), null)
  assert.equal((await f.devices.finish(f.device.token, f.lastFinish())).stopConfirmed, true)
  assert.equal(await f.continuations(accepted.executionId), 1)
  const bob = await f.enroll(f.bob)
  await assert.rejects(f.devices.finish(bob.token, f.lastFinish()), { code: 'execution_not_found' })
})

test('lost real registration ACK never starts the command and persists unknown separately from stopped', options, async t => {
  const f = await fixture(t, true, 1234, false, true)
  const accepted = await f.devices.propose(f.op.grant.token, 'real-lost-ack', "printf 'MUST-NOT-RUN\\n' >> marker.txt", '.')
  f.worker.start()
  await until(async () => (await f.row(accepted.executionId)).stop_observation !== null, 'cold stop report')
  const row = await f.row(accepted.executionId)
  assert.equal(f.lost(), true); assert.equal(row.state, 'uncertain')
  assert.equal(row.stop_observation.Status, 'created'); assert.equal(row.stop_observation.Running, false)
  assert.equal(row.result.state, 'uncertain'); assert.equal(await f.continuations(accepted.executionId), 0)
  await assert.rejects(readFile(join(f.project, 'marker.txt')), { code: 'ENOENT' })
  assert.equal((await f.devices.jobs(f.device.token, f.device.instanceId)).jobs.length, 0)
  await assert.rejects(f.devices.propose(f.op.grant.token, randomUUID(), 'echo later', '.'), { code: 'execution_busy' })
  const credential = await taskCredential(f.pool, f.alice, 'approval')
  const inspected = await f.approval('/approvals/executions/inspect',
    { executionId: row.id, target: 'desktop' }, credential)
  assert.equal(inspected.status, 200); assert.equal(inspected.body.canStop, true)
  assert.equal(inspected.body.runnerObservation, 'stopped_unknown')
  const request = { requestId: randomUUID(), executionId: row.id, target: 'desktop',
    fingerprint: inspected.body.fingerprint, note: 'Real created container stopped; retain unknown effects.' }
  assert.equal((await f.approval('/approvals/executions/resolve', request,
    await taskCredential(f.pool, f.alice))).status, 401)
  assert.equal((await f.approval('/approvals/executions/resolve', request,
    await taskCredential(f.pool, f.bob, 'approval'))).status, 404)
  assert.equal((await f.approval('/approvals/executions/resolve', request, credential, 'http://127.0.0.1:1')).status, 403)
  await assert.rejects(f.approval('/approvals/executions/resolve', request, credential), { name: 'TypeError' })
  assert.equal(f.lostClosure(), true)
  const status = await f.approval('/approvals/executions/status', { requestId: request.requestId, target: 'desktop' }, credential)
  assert.equal(status.status, 200); assert.equal(status.body.receipt.state, 'completed')
  assert.equal(status.body.receipt.finalState, 'closed_unknown'); assert.equal(status.body.receipt.stopConfirmed, true)
  const retried = await f.approval('/approvals/executions/resolve', request, credential)
  assert.deepEqual(retried.body, status.body.receipt)
  const closed = await f.row(row.id)
  assert.equal(closed.state, 'closed_unknown'); assert.deepEqual(closed.result, row.result)
  assert.deepEqual(closed.stop_observation, row.stop_observation); assert.equal(closed.stop_record_digest, row.stop_record_digest)
  assert.equal(await f.continuations(row.id), 1)
  assert.equal((await f.devices.finish(f.device.token, f.lastFinish())).state, 'closed_unknown')
  const next = await f.devices.propose(f.op.grant.token, 'after-closure', "printf 'AFTER\\n' > after.txt", '.')
  await until(async () => (await f.row(next.executionId)).state === 'succeeded', 'new command after unknown closure')
  assert.equal(await readFile(join(f.project, 'after.txt'), 'utf8'), 'AFTER\n')
  await assert.rejects(readFile(join(f.project, 'marker.txt')), { code: 'ENOENT' })
  assert.equal(await f.continuations(row.id), 1)
})

test('revoking a running real Device blocks new authority but retains its exact stop report', options, async t => {
  const f = await fixture(t, false, 15000)
  const accepted = await f.devices.propose(f.op.grant.token, 'real-revocation',
    "printf 'START\\n' >> marker.txt; sleep 12; printf 'END\\n' >> marker.txt", '.')
  f.worker.start()
  await until(async () => {
    try { return (await readFile(join(f.project, 'marker.txt'), 'utf8')) === 'START\n' }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false }
  }, 'running command marker')
  await f.devices.revoke(f.alice, f.device.deviceId)
  await assert.rejects(f.devices.jobs(f.device.token, f.device.instanceId), { code: 'device_unauthorized' })
  await assert.rejects(f.devices.directory(f.device.token, 'must not authorize'), { code: 'device_unauthorized' })
  await until(async () => (await f.row(accepted.executionId)).stop_observation !== null, 'revoked stop report')
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0, 'revoked journal cleanup')
  const row = await f.row(accepted.executionId)
  assert.equal(row.state, 'uncertain'); assert.equal(row.result.state, 'uncertain')
  assert.equal(row.stop_observation.Running, false); assert.equal(await f.continuations(accepted.executionId), 0)
  assert.equal(row.stop_observation.receipt.containerId, row.container_receipt.containerId)
  assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'START\n')
  assert.equal(await f.containers.inspect(row.container_receipt), null)
  assert.equal((await f.devices.finish(f.device.token, f.lastFinish())).stopConfirmed, true)
  const credential = await taskCredential(f.pool, f.alice, 'approval')
  const inspected = await f.approval('/approvals/executions/inspect', { executionId: row.id, target: 'desktop' }, credential)
  assert.equal(inspected.body.canStop, true)
  const closed = await f.approval('/approvals/executions/resolve', { requestId: randomUUID(), executionId: row.id,
    target: 'desktop', fingerprint: inspected.body.fingerprint, note: 'Real revoked Device stop.' }, credential)
  assert.equal(closed.status, 200); assert.equal(closed.body.finalState, 'closed_unknown')
  assert.equal((await f.devices.finish(f.device.token, f.lastFinish())).state, 'closed_unknown')
  assert.equal(await f.continuations(row.id), 1)
  assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'START\n')
})

test('lost real claim ACK retries the original process and executes the command once', options, async t => {
  const f = await fixture(t, false, 1234, true)
  const accepted = await f.devices.propose(f.op.grant.token, 'real-lost-claim', "printf 'ONCE\\n' >> marker.txt", '.')
  f.worker.start()
  await until(async () => (await f.row(accepted.executionId)).stop_observation !== null, 'original claim recovery')
  await until(async () => JSON.parse(await readFile(join(f.privateRoot, 'journal.json'), 'utf8')).length === 0, 'claim journal cleanup')
  const row = await f.row(accepted.executionId)
  assert.equal(f.lost(), true); assert.equal(row.state, 'succeeded')
  assert.equal(row.container_receipt.owner.creationId, row.dispatch_id)
  assert.equal(await readFile(join(f.project, 'marker.txt'), 'utf8'), 'ONCE\n')
  assert.equal(await f.continuations(accepted.executionId), 1)
})
