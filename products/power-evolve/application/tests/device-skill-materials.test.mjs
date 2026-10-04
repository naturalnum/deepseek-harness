/** Real isolated PG and immutable POSIX packages; Device container receipts are synthetic, with no Docker or model calls. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { DeviceService } from '../lib/platform/devices.js'
import { SkillService } from '../lib/platform/skills.js'
import { readRuntimeSkill, readRuntimeSkillResource } from '../lib/platform/runtime-skills.js'
import { deviceProtocolFixture, registrationFor } from './device-execution-protocol-fixture.mjs'
import { disableFixtureAccount, taskCredential } from './task-credential-fixture.mjs'

const options = { timeout: 60000 }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const binary = Buffer.from([0, 255, 13, 10, 128, 1, 254])
async function cleanup(root) {
  const writable = async path => {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await chmod(path, 0o700)
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name))
  }
  await writable(root); await rm(root, { recursive: true, force: true })
}
async function fixture(t) {
  const f = await deviceProtocolFixture(t), root = await mkdtemp(join(await realpath(tmpdir()), 'pe-device-materials-'))
  t.after(() => cleanup(root))
  const skills = new SkillService(f.pool, join(root, 'workspace'), join(root, 'private'))
  await skills.init()
  const devices = new DeviceService(f.tasks, 1234, {}, skills)
  const upload = async (user, version, name = 'local-material') => {
    const source = await mkdtemp(join(root, 'source-')), folder = join(source, name)
    await mkdir(join(folder, 'scripts'), { recursive: true })
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Private deterministic package\n---\nRead scripts/data.bin; accepted-version=${version}.\n`)
    await writeFile(join(folder, 'skill-package.json'), JSON.stringify({ schemaVersion: 1, version }))
    await writeFile(join(folder, 'scripts', 'data.bin'), binary)
    const path = join(source, 'package.zip')
    execFileSync('/usr/bin/zip', ['-q', '-r', '-X', path, name], { cwd: source, timeout: 10000, maxBuffer: 65536, env: {} })
    const archive = await readFile(path), ticket = await skills.issueUploadTicket(user, randomUUID(), archive.length, hash(archive), 'http://127.0.0.1:1')
    const installed = await skills.upload(ticket.ticket, Readable.from([archive]))
    return { ...installed.item, archive }
  }
  const accepted = async (user, device, service = devices) => {
    const operation = await f.operation(user, device)
    const execution = await service.propose(operation.grant.token, 'material-call', 'printf deterministic', '.')
    const claim = await service.claim(device.token, device.instanceId, execution.executionId, randomUUID())
    const input = { instanceId: device.instanceId, executionId: claim.executionId, processId: claim.processId,
      dispatchId: claim.dispatchId, digest: claim.digest, skillId: claim.materials?.[0]?.skillId ?? randomUUID() }
    return { ...operation, execution, claim, input }
  }
  return { ...f, root, skills, devices, upload, accepted }
}

test('Desktop acceptance freezes private package/text versions and returns original binary bytes after an upgrade', options, async t => {
  const f = await fixture(t), d = await f.enroll(f.alice), first = await f.upload(f.alice, '1.0.0')
  const text = await f.skills.install(f.alice, randomUUID(), 'text-material', 'Text only', 'Accepted text instructions')
  const op = await f.operation(f.alice, d), selected = await f.tasks.selectedSkills(op.grant.token)
  assert.deepEqual(selected.target, { kind: 'desktop', deviceId: d.deviceId, directoryId: d.directoryId })
  assert.equal(selected.selection.length, 2)
  const packageSelection = selected.selection.find(item => item.kind === 'package')
  assert.equal(packageSelection.version, '1.0.0')
  f.skills.runtimeResourceBase = async () => { throw new Error('desktop_must_not_build_cloud_suite') }
  const runtime = await readRuntimeSkill(f.tasks, f.skills, op.grant.token, first.skillId)
  assert.equal(runtime.runtimePath, `/opt/power-evolve/skills/sha256/${hash(first.archive)}/skill`)
  assert.equal(runtime.suiteAvailable, false)
  assert.equal((await readRuntimeSkill(f.tasks, f.skills, op.grant.token, text.skillId)).runtimePath, null)
  assert.equal((await readRuntimeSkillResource(f.tasks, f.skills, op.grant.token, first.skillId, 'skill-package.json')).text.includes('1.0.0'), true)
  const second = await f.upload(f.alice, '2.0.0')
  await f.skills.toggle(f.alice, first.skillId, false)
  const execution = await f.devices.propose(op.grant.token, 'material-call', 'printf deterministic', '.')
  const stored = await f.row(execution.executionId), binding = stored.dispatch_request.materials[0]
  assert.equal(binding.version, '1.0.0'); assert.equal(binding.packageDigest, hash(first.archive))
  assert.notEqual(binding.packageDigest, hash(second.archive))
  const rebuilt = new DeviceService(f.tasks, 9999, {})
  assert.deepEqual(await rebuilt.propose(op.grant.token, 'material-call', 'printf deterministic', '.'), execution)
  assert.deepEqual(await f.row(execution.executionId), stored)
  assert.deepEqual((await f.devices.jobs(d.token, d.instanceId)).jobs[0].materials, [binding])
  const claim = await f.devices.claim(d.token, d.instanceId, execution.executionId, randomUUID())
  assert.deepEqual(claim.materials, [binding]); assert.equal(claim.timeoutMs, 1234)
  const input = { instanceId: d.instanceId, executionId: claim.executionId, processId: claim.processId,
    dispatchId: claim.dispatchId, digest: claim.digest, skillId: first.skillId }
  const material = await f.devices.material(d.token, input)
  const original = (await f.pool.query('SELECT manifest FROM pe_skill_package_versions WHERE user_id=$1 AND archive_digest=$2', [f.alice.userId, binding.packageDigest])).rows[0]
  assert.equal(material.manifest, original.manifest); assert.equal(hash(material.manifest), binding.manifestDigest)
  const manifest = JSON.parse(material.manifest)
  assert.equal(manifest.artifactSha256, hash(first.archive))
  for (const file of material.files) {
    const bytes = Buffer.from(file.data, 'base64'), expected = manifest.files.find(item => item.path === file.path)
    assert.equal(bytes.length, expected.size); assert.equal(hash(bytes), expected.sha256)
  }
  assert.deepEqual(Buffer.from(material.files.find(file => file.path === 'skill/scripts/data.bin').data, 'base64'), binary)
  assert.match(Buffer.from(material.files.find(file => file.path === 'skill/SKILL.md').data, 'base64').toString(), /accepted-version=1\.0\.0/u)
  await f.skills.toggle(f.alice, first.skillId, true)
  const newerDir = await f.devices.directory(d.token, 'Second version'), newer = await f.accepted(f.alice, { ...d, ...newerDir })
  assert.equal(newer.claim.materials[0].version, '2.0.0')
})

test('legacy and text-only dispatches preserve their JSON/digest; packages explicitly require a material service', options, async t => {
  const f = await fixture(t), d = await f.enroll(f.alice)
  await f.skills.install(f.alice, randomUUID(), 'text-only', 'Text', 'Instructions')
  const op = await f.accepted(f.alice, d, f.devices), row = await f.row(op.claim.executionId)
  assert.deepEqual(row.dispatch_request, { command: 'printf deterministic', cwd: '.', timeoutMs: 1234, deviceId: d.deviceId, directoryId: d.directoryId })
  assert.equal(row.request_digest, hash(JSON.stringify(row.dispatch_request)))
  assert.equal(Object.hasOwn(op.claim, 'materials'), false)
  await assert.rejects(f.devices.material(d.token, op.input), { code: 'device_materials_unavailable' })
  const legacy = new DeviceService(f.tasks, 9876, {})
  assert.deepEqual(await legacy.propose(op.grant.token, 'material-call', 'printf deterministic', '.'), { ...op.execution, state: 'running' })
  assert.deepEqual(await legacy.claim(d.token, d.instanceId, op.claim.executionId, op.claim.processId), op.claim)
  assert.equal(Object.hasOwn((await legacy.jobs(d.token, d.instanceId)).jobs[0], 'materials'), false)
  await f.upload(f.alice, '1.0.0')
  const directory = await legacy.directory(d.token, 'New package'), pending = await f.operation(f.alice, { ...d, ...directory })
  await assert.rejects(legacy.propose(pending.grant.token, 'new-package', 'printf deterministic', '.'), { code: 'device_material_service_unavailable' })
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM pe_desktop_executions')).rows[0].n, 1)
  const token = await taskCredential(f.pool, f.alice), cloud = await f.tasks.create(f.alice, randomUUID(), token)
  const accepted = await f.tasks.accept(f.alice, cloud.sessionId, randomUUID(), 'Synthetic Cloud metadata check', token)
  const grant = await f.tasks.claim(randomUUID()); assert.equal(grant.operationId, accepted.operationId)
  const selection = await f.tasks.selectedSkills(grant.token)
  assert.deepEqual(selection.target, { kind: 'cloud' }); assert.equal(selection.selection.length, 2)
})

test('materials reject foreign owners, altered bindings, process generations and foreign original Operations', options, async t => {
  const f = await fixture(t), d = await f.enroll(f.alice), foreign = await f.enroll(f.bob)
  await f.upload(f.alice, '1.0.0'); const bob = await f.upload(f.bob, '1.0.0')
  const op = await f.accepted(f.alice, d), before = await f.row(op.claim.executionId)
  await assert.rejects(f.devices.material(foreign.token, op.input), { code: 'execution_not_found' })
  await assert.rejects(f.devices.material(d.token, { ...op.input, skillId: bob.skillId }), { code: 'device_material_not_found' })
  for (const field of ['instanceId', 'processId', 'dispatchId']) await assert.rejects(f.devices.material(d.token, { ...op.input, [field]: randomUUID() }),
    { code: field === 'instanceId' ? 'device_instance_changed' : 'device_process_changed' })
  await assert.rejects(f.devices.material(d.token, { ...op.input, digest: '0'.repeat(64) }), { code: 'device_material_binding_changed' })
  const changed = structuredClone(before.dispatch_request); changed.materials[0].version = '9.0.0'
  const alteredDigest = hash(JSON.stringify(changed))
  await f.pool.query('UPDATE pe_desktop_executions SET dispatch_request=$2,request_digest=$3 WHERE id=$1', [before.id, JSON.stringify(changed), alteredDigest])
  await assert.rejects(f.devices.material(d.token, { ...op.input, digest: alteredDigest }), { code: 'device_material_binding_changed' })
  await f.pool.query('UPDATE pe_desktop_executions SET dispatch_request=$2,request_digest=$3 WHERE id=$1', [before.id, JSON.stringify(before.dispatch_request), before.request_digest])
  const foreignOp = await f.operation(f.bob, foreign)
  await f.pool.query('UPDATE pe_desktop_executions SET operation_id=$2 WHERE id=$1', [before.id, foreignOp.grant.operationId])
  await assert.rejects(f.devices.material(d.token, op.input), { code: 'device_operation_unavailable' })
  assert.equal(await f.continuations(before.id), 0)
})

test('material authorization is checked again after bytes are read, including revocation, cancellation, closure and registration', options, async t => {
  for (const mode of ['skill', 'device', 'directory', 'account', 'cancel', 'sealed', 'registered']) await t.test(mode, async t => {
    const f = await fixture(t), d = await f.enroll(f.alice), installed = await f.upload(f.alice, '1.0.0'), op = await f.accepted(f.alice, d)
    const read = f.skills.readDeviceMaterial.bind(f.skills)
    f.skills.readDeviceMaterial = async (...args) => {
      const result = await read(...args)
      if (mode === 'skill') await f.skills.revoke(f.alice, installed.skillId)
      if (mode === 'device') await f.devices.revoke(f.alice, d.deviceId)
      if (mode === 'directory') await f.devices.revokeDirectory(f.alice, d.directoryId)
      if (mode === 'account') await disableFixtureAccount(f.pool, f.alice)
      if (mode === 'cancel') await f.devices.cancel(f.alice, op.claim.executionId)
      if (mode === 'sealed') await f.devices.closeUnstartedClaim(d.token, { instanceId: d.instanceId, executionId: op.claim.executionId,
        processId: op.claim.processId, digest: op.claim.digest, directoryId: op.claim.directoryId, requestId: randomUUID() })
      if (mode === 'registered') assert.equal((await f.devices.register(d.token, registrationFor(d, op.claim))).canStart, true)
      return result
    }
    const errors = { skill: 'skill_revoked', device: 'device_unauthorized', directory: 'device_material_unavailable', account: 'account_disabled',
      cancel: 'device_material_unavailable', sealed: 'device_claim_closed', registered: 'device_material_unavailable' }
    await assert.rejects(f.devices.material(d.token, op.input), { code: errors[mode] })
  })
})

test('published tree corruption and manifest expansion limits fail instead of returning replacement or partial bytes', options, async t => {
  const f = await fixture(t), d = await f.enroll(f.alice), installed = await f.upload(f.alice, '1.0.0'), op = await f.accepted(f.alice, d)
  const root = join(f.root, 'private', 'skill-packages', f.alice.userId, 'sha256', installed.packageDigest)
  const path = join(root, 'skill', 'scripts', 'data.bin')
  await chmod(path, 0o600); await writeFile(path, Buffer.alloc(binary.length, 17))
  await assert.rejects(f.devices.material(d.token, op.input), { code: 'skill_package_unavailable' })
  assert.equal(await f.continuations(op.claim.executionId), 0)
  const original = (await f.pool.query('SELECT * FROM pe_skill_package_versions WHERE user_id=$1 AND archive_digest=$2', [f.alice.userId, installed.packageDigest])).rows[0]
  const selected = (await f.tasks.selectedSkills(op.grant.token)).selection.find(item => item.kind === 'package')
  for (const mode of ['files', 'bytes']) {
    const manifest = JSON.parse(original.manifest)
    if (mode === 'files') for (let i = manifest.files.length; i <= 256; i++) manifest.files.push({ path: `skill/extra-${i}`, size: 0, sha256: hash('') })
    else manifest.files.push({ path: 'skill/oversized', size: 8 * 1024 * 1024, sha256: hash('') })
    const content = JSON.stringify(manifest), digest = hash(content)
    await f.pool.query('UPDATE pe_skill_package_versions SET manifest=$2,manifest_digest=$3 WHERE id=$1', [original.id, content, digest])
    await assert.rejects(f.skills.deviceBindings(f.alice.userId, [{ ...selected, manifestDigest: digest }]), { code: 'skill_package_unavailable' })
  }
})
