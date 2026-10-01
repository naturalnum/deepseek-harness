/** Web stream cleanup and a real helper process cancellation handshake. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SafePosix } from '../lib/platform/safe-posix.js'
import { createDownloadStream } from '../lib/platform/download-zip-stream.js'

const deferred = () => Promise.withResolvers()

test('cancel waits for a pending producer and calls cleanup once', { timeout: 10000 }, async () => {
  const entered = deferred(), release = deferred()
  let cleanups = 0, finished = 0
  const body = createDownloadStream(async function* () {
    try { entered.resolve(); await release.promise; yield new Uint8Array([1]) }
    finally { cleanups += 1 }
  }, new AbortController().signal, async () => { finished += 1 })
  const reader = body.getReader()
  await entered.promise
  let canceled = false
  const cancel = reader.cancel().then(() => { canceled = true })
  await Promise.resolve()
  assert.equal(canceled, false)
  release.resolve()
  await cancel
  assert.equal(cleanups, 1)
  assert.equal(finished, 1)
})

test('a deadline interrupts a producer paused under backpressure and runs its cleanup', async () => {
  const controller = new AbortController(), closed = deferred()
  let cleanups = 0
  const body = createDownloadStream(async function* () {
    try { while (true) yield new Uint8Array(64 * 1024) }
    finally { cleanups += 1 }
  }, controller.signal, async () => { closed.resolve() })
  const reader = body.getReader()
  await reader.read()
  controller.abort(new Error('deadline'))
  await assert.rejects(reader.read(), { message: 'deadline' })
  await closed.promise
  assert.equal(cleanups, 1)
})

test('SafePosix cancellation resolves only after the real helper process exits',
  { timeout: 15000, skip: process.platform === 'win32' ? 'POSIX helper and process signals' : false }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'pe-download-helper-'))
    const helper = join(root, 'controlled-helper.py')
    const ready = join(root, 'ready')
    const controller = new AbortController()
    let pending, pid
    t.after(async () => {
      controller.abort()
      await pending?.catch(() => {})
      await rm(root, { recursive: true, force: true })
    })
    // The child publishes its PID before blocking. Its scrubbed environment needs no inherited state.
    await writeFile(helper, `#!/usr/bin/env python3\nimport json, os, signal, sys\nrequest=json.load(sys.stdin)\nif request['op']=='probe':\n print(json.dumps({'ok':True,'value':{'ready':True,'python':'fixture'}}))\nelse:\n with open(${JSON.stringify(ready + '.tmp')},'w') as f: f.write(str(os.getpid()))\n os.replace(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)})\n signal.pause()\n`)
    await chmod(helper, 0o700)
    const safe = new SafePosix(root, undefined, { executable: helper, timeoutMs: 10000 })
    await safe.init()
    const handshake = deferred()
    const watcher = watch(root, (_event, filename) => {
      if (filename === 'ready') handshake.resolve()
    })
    t.after(() => watcher.close())
    pending = safe.read('fixture', ['blocked'], controller.signal)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    await handshake.promise
    controller.abort()
    await rejected
    pid = Number(await readFile(ready, 'utf8'))
    assert(Number.isSafeInteger(pid) && pid > 0)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  })
