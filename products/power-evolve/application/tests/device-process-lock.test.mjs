/** Real native flock and OS child processes; no service, Docker, database, or timing-based PID lock. */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DEVICE_PROCESS_LOCK_FILENAME, DeviceProcessLock } from '../src/device/process-lock.ts'

const supported = ['darwin', 'linux'].includes(process.platform)
const options = { skip: !supported && 'Device flock supports macOS/Linux only', timeout: 20_000 }
const fixture = fileURLToPath(new URL('./fixtures/device-process-lock.fixture.ts', import.meta.url))
const disposers = new WeakMap()

function own(t, dispose) { disposers.get(t).push(dispose) }

async function directory(t) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'pe-device-lock-'))
  const cleanup = []
  disposers.set(t, cleanup)
  t.after(async () => {
    const failures = []
    for (const dispose of cleanup.reverse()) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'owned resources did not close')
    await rm(base, { recursive: true, force: true })
  })
  return base
}

function bounded(promise) {
  let timer
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture handshake deadline')), 10_000) })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

function child(t, root) {
  // OS fixture uses plain Node, an empty environment, and its own kernel descriptors.
  const process = fork(fixture, [root], { execArgv: [], env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''
  process.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(0, 4096) })
  process.stdout.resume()
  const closed = new Promise((resolve, reject) => {
    process.once('error', reject)
    process.once('close', (code, signal) => resolve({ code, signal, stderr }))
  })
  void closed.catch(() => {}) // Teardown awaits and reports this same failure.
  const ready = new Promise((resolve, reject) => {
    process.once('message', resolve)
    process.once('error', reject)
    process.once('close', () => reject(new Error('fixture closed before handshake')))
  })
  own(t, async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
    await bounded(closed)
  })
  return { process, ready: bounded(ready), closed: () => bounded(closed) }
}

test('owner-only stable lock preserves bytes and release is concurrent/idempotent', options, async t => {
  const root = join(await directory(t), 'private')
  const first = await DeviceProcessLock.acquire(root)
  own(t, () => first.release())
  const path = join(root, DEVICE_PROCESS_LOCK_FILENAME)
  const inode = await lstat(path, { bigint: true })
  assert.equal((await lstat(root)).mode & 0o777, 0o700)
  assert.equal(Number(inode.mode & 0o777n), 0o600)
  await writeFile(path, 'retained lock bytes', { mode: 0o600 })
  await first.assertOwned()
  const release = first.release()
  assert.equal(first.release(), release)
  await release
  await assert.rejects(first.assertOwned(), { code: 'device_process_lock_released' })
  const second = await DeviceProcessLock.acquire(root)
  own(t, () => second.release())
  assert.equal((await lstat(path, { bigint: true })).ino, inode.ino)
  assert.equal(await readFile(path, 'utf8'), 'retained lock bytes')
})

test('another descriptor and another process cannot acquire a live holder', options, async t => {
  const root = join(await directory(t), 'private')
  const owner = child(t, root)
  assert.deepEqual(await owner.ready, { event: 'held' })
  await assert.rejects(DeviceProcessLock.acquire(root), { code: 'device_process_already_owned' })
  const rival = child(t, root)
  assert.deepEqual(await rival.ready, { event: 'refused', code: 'device_process_already_owned' })
  assert.deepEqual(await rival.closed(), { code: 1, signal: null, stderr: '' })
  owner.process.send('release')
  assert.deepEqual(await owner.closed(), { code: 0, signal: null, stderr: '' })
  const successor = await DeviceProcessLock.acquire(root)
  own(t, () => successor.release())
  await assert.rejects(DeviceProcessLock.acquire(root), { code: 'device_process_already_owned' })
})

test('SIGKILL releases the native kernel lock without removing the stable inode', options, async t => {
  const root = join(await directory(t), 'private')
  const owner = child(t, root)
  assert.deepEqual(await owner.ready, { event: 'held' })
  const before = await lstat(join(root, DEVICE_PROCESS_LOCK_FILENAME), { bigint: true })
  owner.process.kill('SIGKILL')
  assert.deepEqual(await owner.closed(), { code: null, signal: 'SIGKILL', stderr: '' })
  const successor = await DeviceProcessLock.acquire(root)
  own(t, () => successor.release())
  const after = await lstat(join(root, DEVICE_PROCESS_LOCK_FILENAME), { bigint: true })
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
})

test('root symlinks, ancestor symlinks, lock symlinks, and hard links reject without touching targets', options, async t => {
  const base = await directory(t), root = join(base, 'private'), alias = join(base, 'alias')
  await mkdir(root, { mode: 0o700 })
  await symlink(root, alias)
  await assert.rejects(DeviceProcessLock.acquire(alias), { code: 'device_process_lock_path_changed' })
  await assert.rejects(DeviceProcessLock.acquire(join(alias, 'child')), { code: 'device_process_lock_path_changed' })
  const target = join(base, 'target'), path = join(root, DEVICE_PROCESS_LOCK_FILENAME)
  await writeFile(target, 'untouched', { mode: 0o644 })
  await symlink(target, path)
  await assert.rejects(DeviceProcessLock.acquire(root), { code: 'device_process_lock_path_changed' })
  await rm(path)
  await link(target, path)
  await assert.rejects(DeviceProcessLock.acquire(root), { code: 'device_process_lock_path_changed' })
  assert.equal(await readFile(target, 'utf8'), 'untouched')
  assert.equal((await lstat(target)).mode & 0o777, 0o644)
  await rm(path)
  const held = await DeviceProcessLock.acquire(root)
  own(t, () => held.release())
})

test('held lock rejects lock/root replacement and broadened permissions', options, async t => {
  const base = await directory(t), root = join(base, 'private')
  const held = await DeviceProcessLock.acquire(root)
  own(t, () => held.release())
  const path = join(root, DEVICE_PROCESS_LOCK_FILENAME)
  await chmod(path, 0o644)
  await assert.rejects(held.assertOwned(), { code: 'device_process_lock_path_changed' })
  await chmod(path, 0o600)
  await held.assertOwned()
  await rename(path, join(root, 'old-lock'))
  await writeFile(path, '', { mode: 0o600 })
  await assert.rejects(held.assertOwned(), { code: 'device_process_lock_path_changed' })
  await held.release()
  const next = await DeviceProcessLock.acquire(root)
  own(t, () => next.release())
  await rename(root, join(base, 'old-root'))
  await mkdir(root, { mode: 0o700 })
  await writeFile(join(root, DEVICE_PROCESS_LOCK_FILENAME), '', { mode: 0o600 })
  await assert.rejects(next.assertOwned(), { code: 'device_process_lock_path_changed' })
})
