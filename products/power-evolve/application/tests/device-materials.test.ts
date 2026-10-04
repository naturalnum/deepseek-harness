/** Real files and native flock; material transport and syscall failure injection are local fixtures. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rename, rm, symlink, unlink,
  writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { deviceMaterialBinding, ownedContainerOwner, type DeviceMaterialBinding,
  type DeviceSkillMaterial, DEVICE_MATERIAL_MAX_BYTES } from '@power-evolve/contracts/device-execution'
import { DeviceMaterials } from '../src/device/materials.ts'
import { DeviceProcessLock } from '../src/device/process-lock.ts'

const options = { timeout: 15000, skip: !['darwin', 'linux'].includes(process.platform) }
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const enrollment = () => ownedContainerOwner.shape.enrollmentId.parse(randomUUID())
const signal = () => new AbortController().signal

function bundle(version = '1.0.0', binary = Buffer.from([0, 255, 128, 10])): DeviceSkillMaterial {
  const instructions = Buffer.from(`---\nname: synthetic-device-skill\ndescription: QA package ${version}\n---\nUse its frozen binary fixture.\n`)
  const files = [{ path: 'skill/SKILL.md', data: instructions.toString('base64') },
    { path: 'skill/resources/binary.dat', data: binary.toString('base64') }]
  const packageDigest = hash(`synthetic archive identity ${version}:${hash(binary)}`)
  const manifest = JSON.stringify({ schemaVersion: 1, artifactSha256: packageDigest,
    files: files.map(file => { const bytes = Buffer.from(file.data, 'base64')
      return { path: file.path, size: bytes.length, sha256: hash(bytes) } }) })
  return { binding: deviceMaterialBinding.parse({ skillId: randomUUID(), version, packageDigest,
    manifestDigest: hash(manifest), instructionDigest: hash(instructions) }), manifest, files }
}

function changedManifest(material: DeviceSkillMaterial, manifest: object): DeviceSkillMaterial {
  const text = JSON.stringify(manifest)
  return { ...material, manifest: text,
    binding: deviceMaterialBinding.parse({ ...material.binding, manifestDigest: hash(text) }) }
}

async function cleanup(path: string): Promise<void> {
  const stat = await lstat(path)
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await chmod(path, 0o700)
    for (const name of await readdir(path)) await cleanup(join(path, name))
  }
}

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pe-device-materials-')))
  const root = join(base, 'private')
  let lock = await DeviceProcessLock.acquire(root)
  let helper = new DeviceMaterials(root, () => lock.assertOwned())
  t.after(async () => { await lock.release(); await cleanup(base); await rm(base, { recursive: true }) })
  return { base, root, get lock() { return lock }, get helper() { return helper },
    async restart() { await lock.release(); lock = await DeviceProcessLock.acquire(root)
      helper = new DeviceMaterials(root, () => lock.assertOwned()); return helper } }
}

const cache = (root: string, instance: string, material: DeviceSkillMaterial) =>
  join(root, 'materials', instance, 'sha256', material.binding.packageDigest)

test('binary material publishes exact selected read-only files and an owner-only persistent Home', options, async t => {
  const f = await fixture(t), instance = enrollment(), material = bundle()
  let calls = 0
  const load = async (binding: DeviceMaterialBinding) => { calls++; assert.deepEqual(binding, material.binding); return material }
  const first = await f.helper.prepare(instance, [material.binding], load, signal())
  assert.equal(first.home, join(f.root, 'execution-homes', instance))
  assert.deepEqual(first.mounts, [{ source: cache(f.root, instance, material),
    target: `/opt/power-evolve/skills/sha256/${material.binding.packageDigest}` }])
  const source = first.mounts[0]!.source
  assert.deepEqual(await readdir(source), ['manifest.json', 'skill'])
  assert.equal(await readFile(join(source, 'manifest.json'), 'utf8'), material.manifest)
  assert.deepEqual(await readFile(join(source, 'skill/resources/binary.dat')), Buffer.from([0, 255, 128, 10]))
  assert.equal((await lstat(first.home)).mode & 0o7777, 0o700)
  assert.equal((await lstat(source)).mode & 0o7777, 0o555)
  assert.equal((await lstat(join(source, 'skill/resources/binary.dat'))).mode & 0o7777, 0o444)
  assert.equal((await lstat(first.home)).uid, process.getuid!())
  const inode = (await lstat(source, { bigint: true })).ino
  await writeFile(join(first.home, 'persistent.txt'), 'local Home')
  const again = await f.helper.prepare(instance, [material.binding], load, signal())
  assert.deepEqual(again, first); assert.equal(calls, 2)
  assert.equal((await lstat(source, { bigint: true })).ino, inode)
  assert.equal(await readFile(join(first.home, 'persistent.txt'), 'utf8'), 'local Home')
  await assert.rejects(f.helper.prepare(instance, [material.binding], async () => {
    throw new Error('synthetic untrusted transport details')
  }, signal()), { code: 'device_material_unavailable', message: 'device_material_unavailable' })
  assert.equal((await lstat(source, { bigint: true })).ino, inode)
})

test('two enrollments and versions retain separate Homes and original cache bytes after restart', options, async t => {
  const f = await fixture(t), a = enrollment(), b = enrollment(), v1 = bundle(), v2 = bundle('2.0.0')
  const first = await f.helper.prepare(a, [v1.binding], async () => v1, signal())
  await writeFile(join(first.home, 'kept'), 'A')
  const v1Bytes = await readFile(join(first.mounts[0]!.source, 'manifest.json'))
  const second = await f.helper.prepare(a, [v2.binding], async () => v2, signal())
  assert.equal(second.home, first.home)
  assert.notEqual(second.mounts[0]!.source, first.mounts[0]!.source)
  const loaded: string[] = []
  const combined = await f.helper.prepare(a, [v1.binding, v2.binding], async binding => {
    loaded.push(binding.packageDigest); return binding.packageDigest === v1.binding.packageDigest ? v1 : v2
  }, signal())
  assert.deepEqual(loaded, [v1.binding.packageDigest, v2.binding.packageDigest])
  assert.deepEqual(combined.mounts, [...first.mounts, ...second.mounts])
  const other = await f.helper.prepare(b, [v1.binding], async () => v1, signal())
  assert.notEqual(other.home, first.home); assert.notEqual(other.mounts[0]!.source, first.mounts[0]!.source)
  assert.deepEqual(await readdir(other.home), [])
  await f.restart()
  let calls = 0
  const recovered = await f.helper.prepare(a, [v1.binding], async () => { calls++; return v1 }, signal())
  assert.equal(calls, 1); assert.deepEqual(recovered, first)
  assert.deepEqual(await readFile(join(first.mounts[0]!.source, 'manifest.json')), v1Bytes)
  assert.equal(await readFile(join(first.home, 'kept'), 'utf8'), 'A')
})

test('Home inode records reject path replacement across restart and never adopt prior nonempty directories', options, async t => {
  const f = await fixture(t), instance = enrollment()
  const first = await f.helper.prepare(instance, [], async () => { throw new Error('no load') }, signal())
  await rename(first.home, first.home + '-old'); await mkdir(first.home, { mode: 0o700 })
  await f.restart()
  await assert.rejects(f.helper.prepare(instance, [], async () => { throw new Error('no load') }, signal()),
    { code: 'device_material_home_invalid' })
  const unrecorded = enrollment(), path = join(f.root, 'execution-homes', unrecorded)
  await mkdir(path, { mode: 0o700 }); await writeFile(join(path, 'old'), 'not authorized by identity')
  await assert.rejects(f.helper.prepare(unrecorded, [], async () => { throw new Error('no load') }, signal()),
    { code: 'device_material_home_invalid' })
})

test('cancellation before admission and during actual staging writes publishes no package', options, async t => {
  const f = await fixture(t), instance = enrollment(), material = bundle(), stopped = new AbortController()
  stopped.abort()
  await assert.rejects(f.helper.prepare(instance, [material.binding], async () => material, stopped.signal),
    { code: 'device_material_cancelled' })
  assert.deepEqual((await readdir(f.root)).sort(), ['device-process.lock'])
  await f.helper.prepare(instance, [], async () => { throw new Error('no load') }, signal())
  const probe = await open(join(f.base, 'probe'), 'wx', 0o600)
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  const write = prototype.writeFile, abort = new AbortController()
  t.mock.method(prototype, 'writeFile', async function(this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
    await write.apply(this, args); abort.abort()
  })
  try {
    await assert.rejects(f.helper.prepare(instance, [material.binding], async () => material, abort.signal),
      { code: 'device_material_cancelled' })
    assert.deepEqual(await readdir(join(f.root, 'materials', instance, 'sha256')), [])
  } finally { t.mock.restoreAll(); await probe.close() }
})

test('current authorization and kernel ownership are rechecked after load', options, async t => {
  const f = await fixture(t), instance = enrollment(), material = bundle(), controller = new AbortController()
  await assert.rejects(f.helper.prepare(instance, [material.binding], async () => {
    controller.abort(); return material
  }, controller.signal), { code: 'device_material_cancelled' })
  await assert.rejects(f.helper.prepare(instance, [material.binding], async () => {
    await f.lock.release(); return material
  }, signal()), { code: 'device_material_not_owned' })
  assert.deepEqual(await readdir(join(f.root, 'materials', instance, 'sha256')), [])
})

test('forged binding, manifest, path, exact file set, canonical bytes and budgets reject before publication', options, async t => {
  const f = await fixture(t), instance = enrollment(), good = bundle()
  const raw = JSON.parse(good.manifest) as { schemaVersion: number; artifactSha256: string;
    files: { path: string; size: number; sha256: string }[] }
  const wrongArchive = changedManifest(good, { ...raw, artifactSha256: '0'.repeat(64) })
  const wrongInstruction = { ...good, binding: deviceMaterialBinding.parse({ ...good.binding, instructionDigest: '0'.repeat(64) }) }
  const wrongBytes = { ...good, files: good.files.map(file => file.path.endsWith('.dat') ? { ...file, data: 'YR==' } : file) }
  const oneByte = bundle('canonical', Buffer.from('a'))
  const noncanonical = { ...oneByte,
    files: oneByte.files.map(file => file.path.endsWith('.dat') ? { ...file, data: 'YR==' } : file) }
  const badPath = { ...good, files: [{ ...good.files[0]!, path: 'skill/../escape' }, good.files[1]!] }
  const oversized = changedManifest(good, { ...raw, files: raw.files.map(file => file.path.endsWith('.dat')
    ? { ...file, size: DEVICE_MATERIAL_MAX_BYTES + 1 } : file) })
  const collision = changedManifest(good, { ...raw, files: [...raw.files,
    { path: 'skill/resources', size: 0, sha256: hash('') }] })
  collision.files = [...collision.files, { path: 'skill/resources', data: '' }]
  const tooMany = changedManifest(good, { ...raw, files: [raw.files[0]!,
    ...Array.from({ length: 256 }, (_, index) => ({ path: `skill/f${index}`, size: 0, sha256: hash('') }))] })
  tooMany.files = [good.files[0]!, ...Array.from({ length: 256 }, (_, index) => ({ path: `skill/f${index}`, data: '' }))]
  for (const bad of [wrongArchive, wrongInstruction, wrongBytes, noncanonical, badPath, oversized, collision, tooMany,
    { ...good, manifest: good.manifest + '\n' }, { ...good, files: good.files.slice(0, 1) },
    { ...good, files: [...good.files, { path: 'skill/extra', data: '' }] },
    { ...good, files: [good.files[0]!, good.files[0]!] },
    { ...good, files: good.files.map(file => ({ ...file, data: file.data + '\n' })) }]) {
    await assert.rejects(f.helper.prepare(instance, [bad.binding], async () => bad, signal()),
      { code: 'device_material_invalid', message: 'device_material_invalid' })
  }
  await assert.rejects(f.helper.prepare(instance, [good.binding], async () => bundle('2.0.0'), signal()),
    { code: 'device_material_invalid' })
  assert.deepEqual(await readdir(join(f.root, 'materials', instance, 'sha256')), [])
})

test('symlinked parents, Home and cache files refuse without following outside data', options, async t => {
  const f = await fixture(t), instance = enrollment(), material = bundle()
  const outside = join(f.base, 'outside'); await mkdir(outside, { mode: 0o700 })
  await writeFile(join(outside, 'preserved'), 'outside')
  await symlink(outside, join(f.root, 'execution-homes'))
  await assert.rejects(f.helper.prepare(instance, [material.binding], async () => material, signal()))
  await unlink(join(f.root, 'execution-homes'))
  const prepared = await f.helper.prepare(instance, [material.binding], async () => material, signal())
  const parent = join(prepared.mounts[0]!.source, 'skill/resources'), file = join(parent, 'binary.dat')
  await chmod(parent, 0o700); await unlink(file); await symlink(join(outside, 'preserved'), file); await chmod(parent, 0o555)
  await assert.rejects(f.helper.prepare(instance, [material.binding], async () => material, signal()),
    { code: 'device_material_cache_invalid' })
  assert.equal(await readFile(join(outside, 'preserved'), 'utf8'), 'outside')
  await rename(prepared.home, prepared.home + '-old'); await symlink(outside, prepared.home)
  await assert.rejects(f.helper.prepare(instance, [], async () => { throw new Error('no load') }, signal()))
  assert.equal(await readFile(join(outside, 'preserved'), 'utf8'), 'outside')
})

test('a parent replaced during authorization cannot publish through its new symlink', options, async t => {
  const f = await fixture(t), instance = enrollment(), material = bundle(), outside = join(f.base, 'outside')
  await mkdir(outside, { mode: 0o700 })
  await assert.rejects(f.helper.prepare(instance, [material.binding], async () => {
    const parent = join(f.root, 'materials', instance, 'sha256')
    await rename(parent, parent + '-old'); await symlink(outside, parent)
    return material
  }, signal()), { code: 'device_material_path_changed' })
  assert.deepEqual(await readdir(outside), [])
})

test('cache reuse rejects in-place changes, inode replacements and broader Home or package permissions', options, async t => {
  for (const mutation of ['bytes', 'inode', 'file-mode', 'dir-mode', 'home-mode', 'extra'] as const) {
    const f = await fixture(t), instance = enrollment(), material = bundle()
    const prepared = await f.helper.prepare(instance, [material.binding], async () => material, signal())
    const source = prepared.mounts[0]!.source, parent = join(source, 'skill/resources'), file = join(parent, 'binary.dat')
    if (mutation === 'bytes') {
      await chmod(file, 0o600); await writeFile(file, Buffer.from([1, 255, 128, 10])); await chmod(file, 0o444)
    } else if (mutation === 'inode') {
      await chmod(parent, 0o700); await copyFile(file, join(parent, 'replacement'))
      await chmod(join(parent, 'replacement'), 0o444); await rename(join(parent, 'replacement'), file); await chmod(parent, 0o555)
    } else if (mutation === 'file-mode') await chmod(file, 0o644)
    else if (mutation === 'dir-mode') await chmod(parent, 0o755)
    else if (mutation === 'home-mode') await chmod(prepared.home, 0o755)
    else {
      await chmod(source, 0o700); await writeFile(join(source, 'extra'), 'foreign'); await chmod(source, 0o555)
    }
    await assert.rejects(f.helper.prepare(instance, [material.binding], async () => material, signal()))
  }
})

test('cache file ownership checks reject a changed uid before accepting its bytes', options, async t => {
  const f = await fixture(t), instance = enrollment(), material = bundle()
  await f.helper.prepare(instance, [material.binding], async () => material, signal())
  const probe = await open(join(f.base, 'probe'), 'wx', 0o600), prototype = Object.getPrototypeOf(probe) as FileHandle
  const stat = prototype.stat
  // A regular OS user cannot chown to another user; inject only that kernel metadata outcome.
  t.mock.method(prototype, 'stat', async function(this: FileHandle) {
    const actual = await stat.call(this, { bigint: true }) as BigIntStats
    if (actual.isFile() && (actual.mode & 0o777n) === 0o444n) {
      const changed = Object.create(actual) as BigIntStats
      Object.defineProperty(changed, 'uid', { value: actual.uid + 1n })
      return changed
    }
    return actual
  })
  try { await assert.rejects(f.helper.prepare(instance, [material.binding], async () => material, signal()),
    { code: 'device_material_cache_invalid' }) }
  finally { t.mock.restoreAll(); await probe.close() }
})

test('bytes changed during cache fsync cannot pass the prior digest observation', options, async t => {
  const f = await fixture(t), instance = enrollment(), material = bundle()
  const prepared = await f.helper.prepare(instance, [material.binding], async () => material, signal())
  const path = join(prepared.mounts[0]!.source, 'skill/resources/binary.dat'), inode = (await lstat(path)).ino
  const probe = await open(join(f.base, 'probe'), 'wx', 0o600), prototype = Object.getPrototypeOf(probe) as FileHandle
  const sync = prototype.sync
  let changed = false
  t.mock.method(prototype, 'sync', async function(this: FileHandle) {
    const stat = await this.stat()
    if (stat.isFile() && stat.ino === inode && !changed) {
      changed = true
      await chmod(path, 0o600); await writeFile(path, Buffer.from([1, 255, 128, 10])); await chmod(path, 0o444)
    }
    await sync.call(this)
  })
  try {
    await assert.rejects(f.helper.prepare(instance, [material.binding], async () => material, signal()),
      { code: 'device_material_cache_invalid' })
    assert.equal(changed, true)
  } finally { t.mock.restoreAll(); await probe.close() }
})

test('visible package after failed parent fsync is reauthorized, fully synced and reused without changing bytes', options, async t => {
  const f = await fixture(t), instance = enrollment(), material = bundle(), target = cache(f.root, instance, material)
  await f.helper.prepare(instance, [], async () => { throw new Error('no load') }, signal())
  const probe = await open(join(f.base, 'probe'), 'wx', 0o600), prototype = Object.getPrototypeOf(probe) as FileHandle
  const sync = prototype.sync
  let failed = false, calls = 0, fileSyncs = 0
  t.mock.method(prototype, 'sync', async function(this: FileHandle) {
    const stat = await this.stat()
    const visible = await lstat(target).then(() => true, () => false)
    if (stat.isDirectory() && visible && !failed) { failed = true; throw new Error('synthetic sync failure') }
    if (failed && stat.isFile()) fileSyncs++
    await sync.call(this)
  })
  const load = async () => { calls++; return material }
  try {
    await assert.rejects(f.helper.prepare(instance, [material.binding], load, signal()), { code: 'device_material_io' })
    assert.equal(failed, true)
    const inode = (await lstat(target, { bigint: true })).ino, before = await readFile(join(target, 'manifest.json'))
    const restored = await f.helper.prepare(instance, [material.binding], load, signal())
    assert.equal(calls, 2); assert(fileSyncs >= 3)
    assert.equal(restored.mounts[0]!.source, target); assert.equal((await lstat(target, { bigint: true })).ino, inode)
    assert.deepEqual(await readFile(join(target, 'manifest.json')), before)
  } finally { t.mock.restoreAll(); await probe.close() }
})

test('visible Home identity after failed directory sync is synced on retry without replacing Home', options, async t => {
  const f = await fixture(t), instance = enrollment(), identity = join(f.root, 'execution-homes', `.${instance}.identity.json`)
  const probe = await open(join(f.base, 'probe'), 'wx', 0o600), prototype = Object.getPrototypeOf(probe) as FileHandle
  const sync = prototype.sync
  let failed = false, identitySyncs = 0
  t.mock.method(prototype, 'sync', async function(this: FileHandle) {
    const stat = await this.stat(), visible = await lstat(identity).then(() => true, () => false)
    if (stat.isDirectory() && visible && !failed) { failed = true; throw new Error('synthetic sync failure') }
    if (stat.isFile() && visible) identitySyncs++
    await sync.call(this)
  })
  try {
    await assert.rejects(f.helper.prepare(instance, [], async () => { throw new Error('no load') }, signal()),
      { code: 'device_material_io' })
    const inode = (await lstat(join(f.root, 'execution-homes', instance), { bigint: true })).ino
    const result = await f.helper.prepare(instance, [], async () => { throw new Error('no load') }, signal())
    assert.equal(failed, true); assert(identitySyncs > 0)
    assert.equal((await lstat(result.home, { bigint: true })).ino, inode)
  } finally { t.mock.restoreAll(); await probe.close() }
})
