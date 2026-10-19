/** Explicit Linux test of the separately built ABI7 helper through the published file-worker entry. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'

if (process.env.DSH_FILES_TEXT_INTEROP !== '1') {
  console.log(JSON.stringify({ status: 'skipped', reason: 'Set DSH_FILES_TEXT_INTEROP=1 for the built-artifact Linux test.' }))
} else {
  assert.equal(process.platform, 'linux')
  const [helperPath, workerPath, parentPath, rootMountId] = process.argv.slice(2)
  assert.ok(helperPath && isAbsolute(helperPath) && helperPath.endsWith('.node'), 'Pass the separate absolute ABI7 asset.')
  assert.ok(workerPath && isAbsolute(workerPath) && workerPath.endsWith('.js'), 'Pass the published file-worker.js entry.')
  assert.ok(parentPath && isAbsolute(parentPath), 'Pass a Root-approved existing test parent.')
  const parent = realpathSync(parentPath), project = mkdtempSync(join(parent, 'abi7-text-'))
  const outside = mkdtempSync(join(parent, 'abi7-outside-'))
  const info = statSync(project, { bigint: true })
  const root = { rootPath: project, rootDevice: String(info.dev), rootInode: String(info.ino),
    ...rootMountId === undefined ? {} : { rootMountId } }
  const worker = new Worker(workerPath, { workerData: { helperPath, maxReadBytes: 64, maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 7 } })
  const request = async (kind, relativePath, fields = {}, cancel = new SharedArrayBuffer(4)) => {
    const id = randomUUID()
    const reply = once(worker, 'message', { signal: AbortSignal.timeout(5000) })
    worker.postMessage({ kind, id, root, relativePath, maxBytes: kind === 'stat' ? 0 : 64, cancel, ...fields })
    const [value] = await reply
    assert.equal(value.id, id)
    return value
  }
  const write = (relativePath, content, expected, cancel) => request('text-write', relativePath,
    { content, ...expected === undefined ? {} : { expected } }, cancel)
  const failure = (value, code) => { assert.equal(value.kind, 'text-write-failure'); assert.equal(value.outcome, 'not-published'); assert.equal(value.code, code) }
  try {
    const [ready] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) })
    assert.equal(ready.kind, 'ready'); assert.equal(ready.abiVersion, 7)
    const initialFds = readdirSync('/proc/self/fd').length
    const created = await write('AGENTS.md', 'A\r\n你\rB', { kind: 'createIfAbsent' })
    assert.equal(created.kind, 'text-write-reply')
    assert.deepEqual({ ...created.result, version: undefined }, { operation: 'create', before: null, after: 'A\n你\nB', version: undefined })
    const read = await request('read', 'AGENTS.md')
    assert.equal(read.ok, true); assert.equal(new TextDecoder().decode(read.bytes), 'A\r\n你\rB')
    const observed = await request('stat', 'AGENTS.md')
    assert.equal(observed.metadata.version, created.result.version)
    const updated = await write('AGENTS.md', 'next', { kind: 'replaceIfVersion', version: created.result.version })
    assert.equal(updated.kind, 'text-write-reply')
    assert.equal(updated.result.before, 'A\n你\nB'); assert.equal(updated.result.after, 'next')
    assert.notEqual(updated.result.version, created.result.version)
    failure(await write('AGENTS.md', 'blind', { kind: 'createIfAbsent' }), 'FS_NOT_OBSERVED')
    failure(await write('AGENTS.md', 'stale', { kind: 'replaceIfVersion', version: created.result.version }), 'FS_STALE_VERSION')
    failure(await write('absent', 'stale', { kind: 'replaceIfVersion', version: created.result.version }), 'FS_STALE_VERSION')
    assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'next')
    const empty = await write('empty', '')
    assert.equal(empty.kind, 'text-write-reply'); assert.equal(empty.result.after, '')
    assert.equal((await request('read', 'empty')).bytes.byteLength, 0)
    writeFileSync(join(project, 'AGENTS.md'), new Uint8Array([0xff]))
    assert.equal((await write('AGENTS.md', 'valid')).result.before, null)
    assert.equal((await write('cap', 'x'.repeat(64))).kind, 'text-write-reply')
    assert.equal((await write('cap', 'short')).result.before, null)
    mkdirSync(join(project, 'directory'))
    failure(await write('directory', 'x'), 'FS_NOT_REGULAR_FILE')
    failure(await write('missing-parent/file', 'x'), 'FS_NOT_FOUND')
    linkSync(join(project, 'AGENTS.md'), join(project, 'hard-link'))
    failure(await write('AGENTS.md', 'hard-link overwrite'), 'FS_PERMISSION_DENIED')
    unlinkSync(join(project, 'hard-link'))
    writeFileSync(join(outside, 'keep'), 'outside')
    symlinkSync(outside, join(project, 'escape'))
    failure(await write('escape/keep', 'escaped'), 'FS_PERMISSION_DENIED')
    symlinkSync(join(outside, 'keep'), join(project, 'final-link'))
    failure(await write('final-link', 'escaped'), 'FS_PERMISSION_DENIED')
    assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'outside')
    const cancelled = new SharedArrayBuffer(4)
    Atomics.store(new Int32Array(cancelled), 0, 1)
    failure(await write('cancelled', 'x', undefined, cancelled), 'FS_ABORTED')
    assert.ok(!readdirSync(project).some(name => name.startsWith('.dsh-text-')))
    assert.equal(readdirSync('/proc/self/fd').length, initialFds, 'Each acknowledged transaction must close its descriptors.')
    console.log(JSON.stringify({ status: 'passed', abiVersion: 7, publishedWorker: workerPath,
      cases: ['create', 'replace', 'version', 'raw-read', 'create-conflict', 'stale', 'absent-stale', 'empty', 'binary-before',
        'cap', 'directory', 'missing-parent', 'hard-link', 'parent-link', 'final-link', 'pre-cancel', 'temporary-cleanup', 'fd-closure'] }))
  } finally {
    await worker.terminate()
    rmSync(project, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
  }
}
