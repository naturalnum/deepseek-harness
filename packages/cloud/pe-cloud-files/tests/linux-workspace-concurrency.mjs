/** Opt-in native concurrent collision and directory/link evidence; no production account or quota claim. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, statSync, readdirSync, symlinkSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
const require = createRequire(import.meta.url)
function input(rootPath, name, extra = {}) {
  const fd = openSync(rootPath, 'r'), st = statSync(rootPath, { bigint: true })
  const mountId = /mnt_id:\s+(\d+)/.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))[1]; closeSync(fd)
  return { rootPath, device: String(st.dev), inode: String(st.ino), mountId, name,
    digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', expectedBytes: 0,
    maxBytes: 2 ** 33, maxChunkBytes: 65536, maxPathBytes: 4096, timeoutMs: 30000,
    cancel: new Int32Array(new SharedArrayBuffer(4)), workspaceDirectory: '.', ...extra }
}
if (!isMainThread) {
  const native = require(workerData.asset), started = native.begin(input(workerData.root, '报告.xlsx'))
  parentPort.postMessage({ kind: 'ready' }); Atomics.wait(new Int32Array(workerData.gate), 0, 0)
  parentPort.postMessage(native.finalize(started.handle))
} else {
  assert.equal(process.platform, 'linux'); assert.equal(process.argv.length, 4)
  const asset = resolve(process.argv[2]), root = mkdtempSync(join(resolve(process.argv[3]), 'workspace-concurrency-'))
  const native = require(asset), gate = new SharedArrayBuffer(4), workers = []
  try {
    const tasks = [], ready = []
    for (let index = 0; index < 8; index++) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { root, asset, gate } }); workers.push(worker)
      ready.push(new Promise((accept, reject) => { worker.once('message', accept); worker.once('error', reject) }))
      tasks.push(new Promise((accept, reject) => {
        worker.on('message', message => { if (message.kind === 'published') accept(message) }); worker.once('error', reject)
      }))
    }
    await Promise.all(ready); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0)
    const facts = await Promise.all(tasks)
    assert(facts.every(f => f.clean && f.closed && !f.temporaryPresent))
    const expected = Array.from({ length: 8 }, (_, index) => `报告${index ? `_${index}` : ''}.xlsx`).sort()
    assert.deepEqual(readdirSync(root).sort(), expected)
    for (let index = 0; index < 2; index++) {
      const begin = native.begin(input(root, '未命名文件夹', { directoryOnly: true }))
      assert.equal(native.finalize(begin.handle).publishedName, `未命名文件夹${index ? '_1' : ''}`)
    }
    mkdirSync(join(root, 'nested'))
    const begin = native.begin(input(root, 'child.txt', { workspaceDirectory: 'nested' }))
    assert.equal(native.finalize(begin.handle).publishedName, 'child.txt')
    assert.deepEqual(readdirSync(join(root, 'nested')), ['child.txt'])
    symlinkSync('/tmp', join(root, 'outside'))
    const refused = native.begin(input(root, 'escape', { workspaceDirectory: 'outside' }))
    assert.equal(refused.kind, 'failed'); assert.equal(refused.publication, 'none'); assert.equal(refused.clean, true)
    assert.throws(() => native.begin(input(root, 'escape', { workspaceDirectory: '../outside' })))
    console.log(JSON.stringify({ status: 'passed', concurrentUploads: 8, names: expected,
      directoryCollision: true, nestedDirectory: true, symlinkAndTraversalRefused: true,
      temporaryFiles: readdirSync(root).filter(name => name.startsWith('.stage-')).length }))
  } finally { for (const worker of workers) await worker.terminate(); rmSync(root, { recursive: true, force: true }) }
}
