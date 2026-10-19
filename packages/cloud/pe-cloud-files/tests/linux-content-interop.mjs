/** Isolated Linux test of ABI8 through the built worker; no application/profile is launched. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, linkSync, unlinkSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { Worker } from 'node:worker_threads'

if (process.env.DSH_FILES_CONTENT_INTEROP !== '1') {
  console.log(JSON.stringify({ status: 'skipped', reason: 'Set DSH_FILES_CONTENT_INTEROP=1 for isolated built-worker Linux verification.' }))
} else {
  assert.equal(process.platform, 'linux')
  const [helperPath, workerPath, parent, abi6Path, abi7Path] = process.argv.slice(2)
  assert.ok([helperPath, workerPath, parent].every(value => value && isAbsolute(value)))
  const require = createRequire(import.meta.url), helper = require(helperPath)
  assert.equal(helper.abiVersion, 8)
  for (const [path, abi] of [[abi6Path, 6], [abi7Path, 7]]) {
    if (!path) continue
    const old = require(path)
    assert.equal(old.abiVersion, abi)
    assert.equal(old.openPathMetadata, undefined)
    assert.equal(old.listDirectory, undefined)
    assert.equal(typeof old.writeText, abi === 7 ? 'function' : 'undefined')
  }
  const project = mkdtempSync(join(parent, 'content-')), outside = mkdtempSync(join(parent, 'outside-'))
  const info = statSync(project, { bigint: true })
  const root = { rootPath: project, rootDevice: String(info.dev), rootInode: String(info.ino) }
  const workers = new Set()
  let operationCount = 0
  const spawn = async (content = {}, maxPathBytes = 4096) => {
    const value = new Worker(workerPath, { workerData: { helperPath, maxReadBytes: 64, maxPathBytes,
      maxResolveRetries: 2, readChunkBytes: 7,
      content: { maxEntries: 16, maxNameBytes: 255, maxReplyBytes: 16384, operationTimeoutMs: 1000, ...content } } })
    workers.add(value)
    const [ready] = await once(value, 'message', { signal: AbortSignal.timeout(5000) })
    assert.equal(ready.kind, 'ready'); assert.equal(ready.abiVersion, 8)
    return value
  }
  const request = async (worker, kind, relativePath, fields = {}, cancel = new SharedArrayBuffer(4)) => {
    operationCount++
    const id = randomUUID(), response = once(worker, 'message', { signal: AbortSignal.timeout(5000) })
    worker.postMessage({ kind, id, root, relativePath, cancel, ...fields })
    const [value] = await response
    assert.equal(value.id, id)
    return value
  }
  const failure = (value, code) => { assert.equal(value.kind, 'reply'); assert.equal(value.ok, false); assert.equal(value.code, code) }
  try {
    mkdirSync(join(project, 'dir'))
    writeFileSync(join(project, 'dir', 'a'), 'a')
    writeFileSync(join(project, 'dir', '你.txt'), 'hello')
    writeFileSync(join(project, 'large'), Uint8Array.from({ length: 128 }, (_, index) => index))
    writeFileSync(join(outside, 'secret'), 'outside')
    symlinkSync(join(outside, 'secret'), join(project, 'final-link'))
    symlinkSync('missing', join(project, 'dangling'))
    symlinkSync(outside, join(project, 'escape'))
    symlinkSync('dir', join(project, 'dir-link'))
    const unconfigured = new Worker(workerPath, { workerData: { helperPath, maxReadBytes: 64, maxPathBytes: 4096,
      maxResolveRetries: 2, readChunkBytes: 7 } })
    workers.add(unconfigured)
    const [unavailable] = await once(unconfigured, 'message', { signal: AbortSignal.timeout(5000) })
    assert.equal(unavailable.kind, 'startup-failed'); assert.equal(unavailable.code, 'FS_PERMISSION_DENIED')
    await unconfigured.terminate(); workers.delete(unconfigured)
    for (const [maxPathBytes, maxNameBytes, code] of [
      [16385, 16385, 'FS_IO_ERROR'], [32768, 16385, 'FS_IO_ERROR'], [16384, 16385, 'FS_PERMISSION_DENIED'],
    ]) {
      const invalid = new Worker(workerPath, { workerData: { helperPath, maxReadBytes: 64, maxPathBytes,
        maxResolveRetries: 2, readChunkBytes: 7,
        content: { maxEntries: 16, maxNameBytes, maxReplyBytes: 16384, operationTimeoutMs: 1000 } } })
      workers.add(invalid)
      const [rejected] = await once(invalid, 'message', { signal: AbortSignal.timeout(5000) })
      assert.equal(rejected.kind, 'startup-failed'); assert.equal(rejected.code, code)
      await invalid.terminate(); workers.delete(invalid)
    }
    const maximumNames = await spawn({ maxNameBytes: 16384 }, 16384)
    assert.equal((await request(maximumNames, 'list', 'dir', { maxEntries: 2, maxBytes: 4096 })).entries.length, 2)
    await maximumNames.terminate(); workers.delete(maximumNames)
    const worker = await spawn(), initialFds = readdirSync('/proc/self/fd').length
    const textWrite = await request(worker, 'text-write', 'abi8-text', { content: 'kept', maxBytes: 64, expected: { kind: 'createIfAbsent' } })
    assert.equal(textWrite.kind, 'text-write-reply')
    assert.equal(new TextDecoder().decode((await request(worker, 'read', 'abi8-text', { maxBytes: 64 })).bytes), 'kept')
    assert.equal((await request(worker, 'lstat', 'final-link')).metadata.type, 'symlink')
    assert.equal((await request(worker, 'lstat', 'dangling')).metadata.type, 'symlink')
    assert.equal((await request(worker, 'lstat', 'dir-link/')).metadata.type, 'symlink')
    assert.equal((await request(worker, 'lstat', 'missing')).metadata, undefined)
    assert.equal((await request(worker, 'lstat', '.')).metadata.type, 'directory')
    failure(await request(worker, 'lstat', '.', { root: { ...root, rootInode: '0' } }), 'FS_PERMISSION_DENIED')
    failure(await request(worker, 'lstat', '.', { root: { ...root, rootMountId: '1' } }), 'FS_PERMISSION_DENIED')
    failure(await request(worker, 'lstat', 'escape/secret'), 'FS_PERMISSION_DENIED')
    failure(await request(worker, 'stat', 'final-link', { maxBytes: 0 }), 'FS_PERMISSION_DENIED')
    failure(await request(worker, 'list', 'large', { maxEntries: 2, maxBytes: 4096 }), 'FS_NOT_DIRECTORY')
    const listed = await request(worker, 'list', 'dir', { maxEntries: 2, maxBytes: 4096 })
    assert.deepEqual(listed.entries.map(entry => [entry.name, entry.type, entry.size]), [['a', 'file', 1], ['你.txt', 'file', 5]])
    failure(await request(worker, 'list', 'dir', { maxEntries: 1, maxBytes: 4096 }), 'FS_TOO_LARGE')
    failure(await request(worker, 'list', 'dir', { maxEntries: 2, maxBytes: 32 }), 'FS_TOO_LARGE')
    const tinyReply = await spawn({ maxReplyBytes: 128 })
    failure(await request(tinyReply, 'range', 'large', { offset: 0, length: 1, maxBytes: 1 }), 'FS_TOO_LARGE')
    await tinyReply.terminate(); workers.delete(tinyReply)
    const smallNames = await spawn({ maxNameBytes: 3 })
    failure(await request(smallNames, 'list', 'dir', { maxEntries: 2, maxBytes: 4096 }), 'FS_TOO_LARGE')
    const range = await request(worker, 'range', 'large', { offset: 61, length: 10, maxBytes: 16 })
    assert.equal(range.kind, 'range-reply'); assert.deepEqual([...range.bytes], [61, 62, 63, 64, 65, 66, 67, 68, 69, 70])
    assert.equal(range.bytes.buffer.byteLength, 10)
    assert.equal((await request(worker, 'range', 'large', { offset: 200, length: 4, maxBytes: 4 })).bytes.byteLength, 0)
    assert.equal((await request(worker, 'range', 'large', { offset: 0, length: 0, maxBytes: 0 })).bytes.byteLength, 0)
    failure(await request(worker, 'read', 'large', { maxBytes: 64 }), 'FS_TOO_LARGE')
    const cancelled = new SharedArrayBuffer(4); Atomics.store(new Int32Array(cancelled), 0, 1)
    failure(await request(worker, 'list', 'dir', { maxEntries: 2, maxBytes: 4096 }, cancelled), 'FS_ABORTED')
    failure(await request(worker, 'range', 'large', { offset: 0, length: 2, maxBytes: 2 }, cancelled), 'FS_ABORTED')
    linkSync(join(project, 'dir', 'a'), join(project, 'hard'))
    failure(await request(worker, 'lstat', 'hard'), 'FS_PERMISSION_DENIED')
    failure(await request(worker, 'list', 'dir', { maxEntries: 2, maxBytes: 4096 }), 'FS_PERMISSION_DENIED')
    unlinkSync(join(project, 'hard'))
    mkdirSync(join(project, 'bad-name'))
    writeFileSync(Buffer.concat([Buffer.from(join(project, 'bad-name') + '/'), Buffer.from([255])]), 'x')
    failure(await request(worker, 'list', 'bad-name', { maxEntries: 2, maxBytes: 4096 }), 'FS_IO_ERROR')
    for (let count = 0; count < 30; count++) {
      assert.equal((await request(worker, 'lstat', 'dir/a')).metadata.size, 1)
      assert.equal((await request(worker, 'list', 'dir', { maxEntries: 2, maxBytes: 4096 })).entries.length, 2)
      assert.equal((await request(worker, 'range', 'large', { offset: 127, length: 4, maxBytes: 4 })).bytes.byteLength, 1)
    }
    await smallNames.terminate(); workers.delete(smallNames)
    assert.equal(readdirSync('/proc/self/fd').length, initialFds)
    mkdirSync(join(project, 'many'))
    for (let i = 0; i < 2000; i++) writeFileSync(join(project, 'many', String(i)), '')
    const timed = await spawn({ maxEntries: 3000, maxReplyBytes: 4 * 1024 * 1024, operationTimeoutMs: 1 })
    const timedReply = await request(timed, 'list', 'many', { maxEntries: 3000, maxBytes: 4 * 1024 * 1024 })
    failure(timedReply, 'FS_ABORTED'); assert.equal(timedReply.syscallCode, 'ETIMEDOUT')
    console.log(JSON.stringify({ status: 'passed', abi: 8, operationCount, semanticCaseGroups: 23, rejectedLimitInputs: 3, exactNameCeilingPositive: true, repeatedOperations: 90, checks: ['nofollow-final-and-dangling', 'anchor-containment', 'entry/name/reply-caps', 'UTF8-name-rejection', 'bounded-positional-range-large-file', 'EOF-and-zero', 'hardlink-rejection', 'cancellation', 'monotonic-timeout', 'closed-descriptors', 'ABI6-7-exports-preserved'] }))
  } finally {
    await Promise.all([...workers].map(worker => worker.terminate()))
    rmSync(project, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
  }
}
