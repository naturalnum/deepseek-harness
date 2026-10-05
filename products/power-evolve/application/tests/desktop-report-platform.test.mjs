/** Real isolated PG and immutable package bytes; no Docker, App, or model is started. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { DeviceService } from '../lib/platform/devices.js'
import { SkillService } from '../lib/platform/skills.js'
import { BuiltinSkillCatalog } from '../lib/platform/builtin-skills.js'
import { readRuntimeSkill } from '../lib/platform/runtime-skills.js'
import { validateDeviceReportSuite } from '../lib/device-report-suite.js'
import { deviceProtocolFixture } from './device-execution-protocol-fixture.mjs'

const options = { timeout: 60000 }
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex')
const report = [
  ['builtin.report-workflow-orchestrator', '1.1.30', 'report-workflow-orchestrator'],
  ['builtin.power-grid-technical-report-writer', '1.1.41', 'power-grid-technical-report-writer'],
  ['builtin.report-reviewer', '1.1.1', 'report-reviewer'],
  ['builtin.tech-report-writer', '1.1.41', 'tech-report-writer'],
]

async function cleanup(path) {
  const writable = async directory => {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name))
    }
  }
  await writable(path)
  await rm(path, { recursive: true, force: true })
}

async function fixture(t) {
  const f = await deviceProtocolFixture(t)
  // All work is serial; one connection also exposes accidental nested acquisitions.
  f.pool.options.max = 1
  const root = await mkdtemp(join(tmpdir(), 'pe-desktop-report-'))
  t.after(() => cleanup(root))
  const skills = new SkillService(f.pool, join(root, 'workspaces'), join(root, 'private'))
  await skills.init()
  const devices = new DeviceService(f.tasks, 1234, {}, skills)
  const install = async (user, count = 4, uploaded = false) => {
    for (const [id, version] of report.slice(0, count)) {
      if (!uploaded) await skills.installBuiltin(user, randomUUID(), id, version)
      else {
        const { archive } = await new BuiltinSkillCatalog().get(id, version)
        const ticket = await skills.issueUploadTicket(user, randomUUID(), archive.length, hash(archive), 'http://127.0.0.1:1')
        await skills.upload(ticket.ticket, Readable.from([archive]))
      }
    }
  }
  return { ...f, root, skills, devices, install }
}

test('Desktop runtime and dispatch share the exact receipt-backed report layout without Cloud publication', options, async t => {
  const f = await fixture(t)
  await f.install(f.alice)
  const word = await f.skills.installBuiltin(f.alice, randomUUID(), 'builtin.word', '1.0.2')
  const text = await f.skills.install(f.alice, randomUUID(), 'report-notes', 'Notes', 'Ordinary notes')
  const device = await f.enroll(f.alice), operation = await f.operation(f.alice, device)
  const { selection } = await f.tasks.selectedSkills(operation.grant.token)
  const resolved = await f.skills.deviceExecutionMaterials(f.alice.userId, selection)
  assert.equal(resolved.materials.length, 5)
  assert.deepEqual(resolved.reportSuite.members.map(item => item.role), report.map(item => item[2]))
  assert.deepEqual(validateDeviceReportSuite(resolved.reportSuite, resolved.materials), resolved.reportSuite)
  assert.deepEqual(await f.skills.deviceExecutionMaterials(f.alice.userId, selection.toReversed()),
    { materials: resolved.materials.toReversed(), reportSuite: resolved.reportSuite })
  const currentCatalog = t.mock.method(BuiltinSkillCatalog.prototype, 'list', async () => {
    throw new Error('Current distribution catalog unavailable')
  })
  t.mock.method(f.skills, 'runtimeResourceBase', async () => { throw new Error('Desktop must not publish Cloud suites') })
  for (const member of resolved.reportSuite.members) {
    const read = await readRuntimeSkill(f.tasks, f.skills, operation.grant.token, member.skillId)
    assert.equal(read.suiteAvailable, true)
    assert.equal(read.runtimePath, `/opt/power-evolve/skills/report-suites/${resolved.reportSuite.digest}/${member.role}`)
  }
  currentCatalog.mock.restore()
  assert.deepEqual(await f.skills.deviceRuntimeResourceBase(f.alice.userId, selection, word.skillId),
    { runtimePath: `/opt/power-evolve/skills/sha256/${word.packageDigest}/skill`, suiteAvailable: false })
  assert.equal((await readRuntimeSkill(f.tasks, f.skills, operation.grant.token, text.skillId)).runtimePath, null)
  await assert.rejects(lstat(join(f.root, 'private', 'skill-packages', f.alice.userId, 'report-suites')), { code: 'ENOENT' })
  const execution = await f.devices.propose(operation.grant.token, 'report-call', 'printf report', '.')
  const original = await f.row(execution.executionId)
  assert.deepEqual(original.dispatch_request.reportSuite, resolved.reportSuite)
  assert.equal(original.request_digest, hash(original.dispatch_request))
  assert.deepEqual(await f.devices.propose(operation.grant.token, 'report-call', 'printf report', '.'), execution)
  await assert.rejects(f.devices.propose(operation.grant.token, 'report-call', 'printf changed', '.'), { code: 'request_id_conflict' })
  const jobs = await f.devices.jobs(device.token, device.instanceId)
  assert.deepEqual(jobs.jobs[0].reportSuite, resolved.reportSuite)
  const processId = randomUUID()
  const claim = await f.devices.claim(device.token, device.instanceId, execution.executionId, processId)
  assert.deepEqual(claim.reportSuite, resolved.reportSuite)
  assert.deepEqual(await f.devices.claim(device.token, device.instanceId, execution.executionId, processId), claim)
  for (const member of claim.reportSuite.members) {
    const material = await f.devices.material(device.token, { instanceId: device.instanceId, executionId: claim.executionId,
      processId, dispatchId: claim.dispatchId, digest: claim.digest, skillId: member.skillId })
    assert.deepEqual(material.binding, claim.materials.find(item => item.skillId === member.skillId))
  }
  await f.install(f.bob)
  const bobDevice = await f.enroll(f.bob), bob = await f.operation(f.bob, bobDevice)
  const bobSelection = (await f.tasks.selectedSkills(bob.grant.token)).selection
  const bobLayout = await f.skills.deviceExecutionMaterials(f.bob.userId, bobSelection)
  assert.notEqual(bobLayout.reportSuite.digest, resolved.reportSuite.digest)
  await assert.rejects(f.skills.deviceExecutionMaterials(f.bob.userId, selection), { code: 'skill_not_found' })
  await assert.rejects(f.devices.material(bobDevice.token, { instanceId: bobDevice.instanceId, executionId: claim.executionId,
    processId, dispatchId: claim.dispatchId, digest: claim.digest, skillId: claim.reportSuite.members[0].skillId }), { code: 'execution_not_found' })
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM pe_cloud_executions')).rows[0].n, 0)
  assert.equal((await f.row(execution.executionId)).container_receipt, null)
})

test('incomplete and same-named uploaded selections keep ordinary paths and original no-suite dispatches', options, async t => {
  const f = await fixture(t)
  await f.install(f.alice, 3)
  const device = await f.enroll(f.alice), operation = await f.operation(f.alice, device)
  const selection = (await f.tasks.selectedSkills(operation.grant.token)).selection
  const resolved = await f.skills.deviceExecutionMaterials(f.alice.userId, selection)
  assert.equal(Object.hasOwn(resolved, 'reportSuite'), false)
  assert.equal((await readRuntimeSkill(f.tasks, f.skills, operation.grant.token, selection[0].skillId)).suiteAvailable, false)
  const execution = await f.devices.propose(operation.grant.token, 'legacy-materials', 'printf ordinary', '.')
  const stored = await f.row(execution.executionId)
  const original = { command: 'printf ordinary', cwd: '.', timeoutMs: 1234, deviceId: device.deviceId,
    directoryId: device.directoryId, materials: resolved.materials }
  assert.equal(JSON.stringify(stored.dispatch_request), JSON.stringify(original))
  assert.equal(stored.request_digest, hash(original))
  await f.skills.installBuiltin(f.alice, randomUUID(), report[3][0], report[3][1])
  assert.deepEqual(await f.devices.propose(operation.grant.token, 'legacy-materials', 'printf ordinary', '.'), execution)
  assert.equal(Object.hasOwn((await f.devices.jobs(device.token, device.instanceId)).jobs[0], 'reportSuite'), false)
  assert.equal(Object.hasOwn(await f.devices.claim(device.token, device.instanceId, execution.executionId, randomUUID()), 'reportSuite'), false)
  await f.install(f.bob, 4, true)
  const bobDevice = await f.enroll(f.bob), bob = await f.operation(f.bob, bobDevice)
  const uploaded = (await f.tasks.selectedSkills(bob.grant.token)).selection
  assert.equal(uploaded.length, 4)
  assert.equal(Object.hasOwn(await f.skills.deviceExecutionMaterials(f.bob.userId, uploaded), 'reportSuite'), false)
  const read = await readRuntimeSkill(f.tasks, f.skills, bob.grant.token, uploaded[0].skillId)
  assert.equal(read.runtimePath, `/opt/power-evolve/skills/sha256/${uploaded[0].packageDigest}/skill`)
  assert.equal(read.suiteAvailable, false)
})

test('no-material dispatch JSON and digest remain unchanged through retries, jobs and claims', options, async t => {
  const f = await fixture(t), device = await f.enroll(f.alice), operation = await f.operation(f.alice, device)
  const execution = await f.devices.propose(operation.grant.token, 'legacy-empty', 'printf empty', '.')
  const row = await f.row(execution.executionId)
  const original = { command: 'printf empty', cwd: '.', timeoutMs: 1234, deviceId: device.deviceId, directoryId: device.directoryId }
  assert.equal(JSON.stringify(row.dispatch_request), JSON.stringify(original))
  assert.equal(row.request_digest, hash(original))
  assert.deepEqual(await f.devices.propose(operation.grant.token, 'legacy-empty', 'printf empty', '.'), execution)
  for (const record of [(await f.devices.jobs(device.token, device.instanceId)).jobs[0],
    await f.devices.claim(device.token, device.instanceId, execution.executionId, randomUUID())]) {
    assert.equal(Object.hasOwn(record, 'reportSuite'), false)
    assert.equal(Object.hasOwn(record, 'materials'), false)
  }
})

test('corrupted report descriptions reject even when the enclosing request digest was recomputed', options, async t => {
  const f = await fixture(t)
  await f.install(f.alice)
  const device = await f.enroll(f.alice), operation = await f.operation(f.alice, device)
  const execution = await f.devices.propose(operation.grant.token, 'tamper', 'printf report', '.')
  const row = await f.row(execution.executionId)
  for (const mutate of [
    request => { request.reportSuite.digest = 'e'.repeat(64) },
    request => { request.materials[0].instructionDigest = 'e'.repeat(64) },
    request => { request.reportSuite.members[0].skillId = randomUUID() },
    request => { request.reportSuite.members.reverse() },
  ]) {
    const request = structuredClone(row.dispatch_request)
    mutate(request)
    await f.pool.query('UPDATE pe_desktop_executions SET dispatch_request=$2,request_digest=$3 WHERE id=$1',
      [row.id, request, hash(request)])
    await assert.rejects(f.devices.jobs(device.token, device.instanceId), { code: 'device_dispatch_unavailable' })
    await assert.rejects(f.devices.claim(device.token, device.instanceId, row.id, randomUUID()), { code: 'device_dispatch_unavailable' })
    await assert.rejects(f.devices.propose(operation.grant.token, 'tamper', 'printf report', '.'), { code: 'device_dispatch_unavailable' })
  }
})

test('revoked siblings, damaged bytes and lease loss refuse Desktop report hints and material reads', options, async t => {
  const f = await fixture(t)
  await f.install(f.alice)
  const device = await f.enroll(f.alice), operation = await f.operation(f.alice, device)
  const selection = (await f.tasks.selectedSkills(operation.grant.token)).selection
  const resolved = await f.skills.deviceExecutionMaterials(f.alice.userId, selection)
  const requested = resolved.reportSuite.members[0].skillId
  const realRead = f.skills.deviceRuntimeResourceBase.bind(f.skills)
  const fence = t.mock.method(f.skills, 'deviceRuntimeResourceBase', async (...args) => {
    const value = await realRead(...args)
    await f.pool.query("UPDATE pe_sessions SET lease_until=now()-interval '1 second' WHERE id=$1", [operation.sessionId])
    return value
  })
  await assert.rejects(readRuntimeSkill(f.tasks, f.skills, operation.grant.token, requested), { code: 'lease_lost' })
  fence.mock.restore()
  await f.pool.query("UPDATE pe_sessions SET lease_until=now()+interval '30 seconds' WHERE id=$1", [operation.sessionId])
  const execution = await f.devices.propose(operation.grant.token, 'revoked', 'printf report', '.')
  const claim = await f.devices.claim(device.token, device.instanceId, execution.executionId, randomUUID())
  const sibling = selection.find(item => item.skillId === resolved.reportSuite.members[1].skillId)
  const bytes = join(f.root, 'private', 'skill-packages', f.alice.userId, 'sha256', sibling.packageDigest, 'skill', 'SKILL.md')
  await chmod(bytes, 0o644)
  await writeFile(bytes, 'damaged sibling')
  await assert.rejects(readRuntimeSkill(f.tasks, f.skills, operation.grant.token, requested), { code: 'skill_package_unavailable' })
  await f.skills.revoke(f.alice, sibling.skillId)
  await assert.rejects(readRuntimeSkill(f.tasks, f.skills, operation.grant.token, requested), { code: 'skill_revoked' })
  await assert.rejects(f.devices.material(device.token, { instanceId: device.instanceId, executionId: claim.executionId,
    processId: claim.processId, dispatchId: claim.dispatchId, digest: claim.digest, skillId: sibling.skillId }), { code: 'skill_revoked' })
})
