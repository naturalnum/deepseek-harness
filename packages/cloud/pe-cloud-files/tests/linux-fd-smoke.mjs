/** Bounded Linux pool smoke; isolated source conversion is not a package build or quota certification. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'linux', 'A real Linux worker is required')
const [repoRoot, packageRoot] = process.argv.slice(2)
const require = createRequire(path.join(repoRoot, 'package.json'))
const ts = require('typescript')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-worker4-pool-'))
const pools = []
const extraWorkers = []
try {
  fs.writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}\n')
  for (const file of [
    'error', 'types', 'work-queue', 'work-owner', 'worker-protocol', 'file-worker', 'worker-client', 'worker-pool',
    'read-only', 'directory', 'directory-error', 'directory-budget', 'directory-responsibility',
  ]) {
    const output = ts.transpileModule(fs.readFileSync(path.join(packageRoot, 'src', `${file}.ts`), 'utf8'), {
      fileName: `${file}.ts`,
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true },
    })
    fs.writeFileSync(path.join(temporary, `${file}.js`), output.outputText.replaceAll('@deepseek-ai/dsh-fs', './native-fs-types.js'))
  }
  // Use the actual native vocabulary sources in the isolated source test, without a product build.
  for (const [name, source] of [
    ['native-fs-types', 'packages/fs/fs/src/types.ts'],
    ['native-harness-error', 'packages/llm/llm/src/error.ts'],
  ]) {
    const output = ts.transpileModule(fs.readFileSync(path.join(repoRoot, source), 'utf8'), {
      fileName: `${name}.ts`, compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    })
    fs.writeFileSync(path.join(temporary, `${name}.js`), output.outputText.replaceAll('@deepseek-ai/dsh-llm', './native-harness-error.js'))
  }
  const helperPath = path.join(temporary, 'fd.node')
  const compile = spawnSync('cc', [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-DNAPI_VERSION=8',
    '-I', '/usr/local/include/node', '-shared', '-o', helperPath, path.join(packageRoot, 'native/fd.c'),
  ], { encoding: 'utf8' })
  assert.equal(compile.status, 0, compile.stderr)
  const root = path.join(temporary, 'project-a')
  const rootB = path.join(temporary, 'project-b')
  fs.mkdirSync(root)
  fs.mkdirSync(rootB)
  fs.writeFileSync(path.join(root, 'hello'), 'hello')
  fs.writeFileSync(path.join(rootB, 'hello'), 'fromB')
  fs.writeFileSync(path.join(root, 'empty'), '')
  fs.writeFileSync(path.join(root, 'large'), Buffer.alloc(128))
  fs.writeFileSync(path.join(temporary, 'outside'), 'secret')
  fs.symlinkSync('../outside', path.join(root, 'escape'))
  fs.symlinkSync('hello', path.join(root, 'inside-link'))
  fs.linkSync(path.join(temporary, 'outside'), path.join(root, 'hard-link'))
  assert.equal(spawnSync('mkfifo', [path.join(root, 'fifo')]).status, 0)
  const identity = fs.statSync(root, { bigint: true })
  const identityB = fs.statSync(rootB, { bigint: true })
  const rootInput = { rootPath: root, rootDevice: String(identity.dev), rootInode: String(identity.ino) }
  const rootInputB = { rootPath: rootB, rootDevice: String(identityB.dev), rootInode: String(identityB.ino) }
  const { LinuxFilesPool } = await import(pathToFileURL(path.join(temporary, 'worker-pool.js')).href)
  const config = {
    maxLanes: 3, maxRunning: 2, maxRunningPerLane: 1, maxQueued: 2, maxQueuedPerLane: 1,
    maxResidentBytes: 16384, maxResidentBytesPerLane: 8192, waitTimeoutMs: 3000,
    workerCount: 2, minimumHealthyWorkers: 1, workerReservationBytes: 128, replyOverheadBytes: 128,
    readyTimeoutMs: 3000, drainTimeoutMs: 50,
    helperPath, maxReadBytes: 256, maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 7,
  }
  let created = 0
  const pool = new LinuxFilesPool(config, input => {
    created++
    return new Worker(pathToFileURL(path.join(temporary, 'file-worker.js')), { workerData: input, execArgv: [] })
  })
  pools.push(pool)
  await pool.start()
  assert.equal(created, 2)
  assert.equal(pool.inspect().healthy, 2)
  const binding = account => Object.freeze({ accountId: account, epoch: '1', recipeVersion: 'test-only', lifetime: new AbortController().signal })
  const a = binding('A')
  const b = binding('B')
  const portA = pool.bind(a, rootInput, () => {})
  const portB = pool.bind(b, rootInputB, () => {})
  const empty = await portA.readBytes('empty', 0)
  assert.equal(empty.value.byteLength, 0)
  assert.equal(empty.value.buffer.byteLength, 1)
  empty.release()
  for (let i = 0; i < 8; i++) {
    const results = await Promise.all([portA.readBytes('hello', 5), portB.readBytes('hello', 5)])
    assert.equal(new TextDecoder().decode(results[0].value), 'hello')
    assert.equal(new TextDecoder().decode(results[1].value), 'fromB')
    for (const result of results) { assert.equal(result.value.buffer.byteLength, 6); result.release() }
  }
  const link = await portA.readBytes('inside-link', 5)
  assert.equal(new TextDecoder().decode(link.value), 'hello')
  link.release()
  await assert.rejects(portA.readBytes('large', 10), error => error.code === 'FS_TOO_LARGE')
  for (const name of ['escape', 'hard-link', 'fifo', '../outside']) {
    await assert.rejects(portA.readBytes(name, 100), error => error.code === 'FS_PERMISSION_DENIED')
  }
  await assert.rejects(portA.readBytes('missing', 100), error => error.code === 'FS_NOT_FOUND')
  const { FsError } = await import(pathToFileURL(path.join(temporary, 'native-fs-types.js')).href)
  const collect = async (chunks) => {
    let text = ''
    for await (const chunk of chunks) text += chunk
    return text
  }
  const reader = portA.reader
  const directory = await reader.resolve('.')
  assert.equal((await reader.stat(directory)).type, 'directory')
  const hello = await reader.resolve('hello', { cwd: reader.processPath(directory) })
  const alias = await reader.resolve('inside-link')
  assert.equal(hello.targetKey, alias.targetKey)
  const before = await reader.stat(hello)
  assert.equal(before.type, 'file')
  assert.equal(before.size, 5)
  fs.writeFileSync(path.join(root, 'hello'), 'hello-new')
  assert.notEqual((await reader.stat(hello)).version, before.version)
  assert.equal(await reader.stat(await reader.resolve('missing')), undefined)
  assert.equal(await reader.stat(await reader.resolve('hello/not-a-child')), undefined)
  await assert.rejects(reader.stat({ ...hello }), error => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED')
  await assert.rejects(portB.reader.stat(hello), error => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED')
  for (const name of ['escape', 'hard-link', 'fifo', '../outside']) {
    await assert.rejects(reader.resolve(name), error => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED')
  }
  await assert.rejects(reader.resolve('/outside'), error => error.code === 'FS_PERMISSION_DENIED')
  const text = '123456你🙂Z\r\n'
  fs.writeFileSync(path.join(root, 'utf8'), text)
  assert.equal(await collect(await reader.streamText(await reader.resolve('utf8'))), text)
  assert.equal(await collect(await reader.streamText(await reader.resolve('empty'))), '')
  for (const [name, data] of [['nul', Buffer.from([65, 0, 66])], ['invalid', Buffer.from([0xff])], ['incomplete', Buffer.from([0xe4, 0xbd])]]) {
    fs.writeFileSync(path.join(root, name), data)
    await assert.rejects(collect(await reader.streamText(await reader.resolve(name))), error => error instanceof FsError && error.code === 'FS_NOT_TEXT')
  }
  fs.writeFileSync(path.join(root, 'too-large-text'), 'x'.repeat(config.maxReadBytes + 1))
  await assert.rejects(collect(await reader.streamText(await reader.resolve('too-large-text'))), error => error.code === 'FS_TOO_LARGE')
  const original = '1234567890你🙂tail'
  const heldPath = path.join(root, 'held-stream')
  fs.writeFileSync(heldPath, original)
  const iterator = (await reader.streamText(await reader.resolve('held-stream')))[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.value, '1234567')
  const fdLinks = () => fs.readdirSync('/proc/self/fd').flatMap(fd => {
    try { return [fs.readlinkSync(`/proc/self/fd/${fd}`)] } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  })
  assert.equal(fdLinks().filter(name => name === heldPath).length, 1)
  assert.equal(fdLinks().filter(name => name === root).length, 1)
  fs.renameSync(heldPath, `${heldPath}.moved`)
  fs.writeFileSync(heldPath, 'REPLACEMENT')
  let rest = ''
  while (true) {
    const next = await iterator.next()
    if (next.done) break
    rest += next.value
  }
  assert.equal(first.value + rest, original)
  assert.equal(fdLinks().filter(name => name === `${heldPath}.moved`).length, 0)
  fs.writeFileSync(path.join(root, 'growing'), '1234567')
  const growing = (await reader.streamText(await reader.resolve('growing')))[Symbol.asyncIterator]()
  assert.equal((await growing.next()).value, '1234567')
  fs.appendFileSync(path.join(root, 'growing'), 'x'.repeat(300))
  await assert.rejects((async () => {
    while (!(await growing.next()).done) {}
  })(), error => error.code === 'FS_TOO_LARGE')
  const early = (await reader.streamText(await reader.resolve('utf8')))[Symbol.asyncIterator]()
  await early.next()
  await early.return()
  const pausedAbort = new AbortController()
  const paused = (await reader.streamText(await reader.resolve('utf8'), pausedAbort.signal))[Symbol.asyncIterator]()
  await paused.next()
  pausedAbort.abort()
  const closeDeadline = Date.now() + 3000
  while (fdLinks().some(name => name === root)) {
    assert.ok(Date.now() < closeDeadline, 'cancelled stream must actually close its native anchor')
    await new Promise(resolve => setImmediate(resolve))
  }
  const heldDecoder = await pool.stopEpoch(a, Date.now() + 20)
  assert.equal(heldDecoder.status, 'unknown')
  assert.equal(heldDecoder.pendingOperationIds.length, 1)
  assert.equal(pool.inspect().busy, 1)
  await paused.return()
  assert.equal((await pool.stopEpoch(a, Date.now() + 3000)).status, 'confirmed')
  assert.equal(pool.inspect().healthy, 2)
  await assert.rejects(portA.readBytes('hello', 5), error => error.code === 'cloud/stale-generation')
  const next = await portB.readBytes('hello', 5)
  assert.equal(new TextDecoder().decode(next.value), 'fromB')
  next.release()
  const c = binding('C')
  const denied = pool.bind(c, { ...rootInput, rootInode: String(identity.ino + 1n) }, () => {})
  await assert.rejects(denied.readBytes('hello', 5), error => error.code === 'FS_PERMISSION_DENIED' && error.syscallCode === 'ESTALE')
  assert.equal((await pool.stopEpoch(c, Date.now() + 3000)).status, 'confirmed')
  assert.equal(created, 2)
  const pendingRoot = await pool.stop(Date.now())
  assert.equal(pendingRoot.status, 'unknown')
  assert.equal(pendingRoot.pendingWorkerIds.length, 2)
  assert.equal(pool.inspect().rootReservedBytes, 256)
  await pool.whenClosed()
  assert.equal((await pool.stop(Date.now())).status, 'confirmed')
  assert.equal(pool.inspect().rootReservedBytes, 0)
  const anchors = fs.readdirSync('/proc/self/fd').filter((fd) => {
    try { return [root, rootB].includes(fs.readlinkSync(`/proc/self/fd/${fd}`)) } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  })
  assert.equal(anchors.length, 0)

  const gate = new SharedArrayBuffer(8)
  const state = new Int32Array(gate)
  const faultPool = new LinuxFilesPool({ ...config, workerCount: 1, maxRunning: 1 }, () =>
    new Worker(pathToFileURL(path.join(packageRoot, 'tests/fixtures/transport-worker.mjs')), { workerData: { mode: 'blocked', gate } }))
  pools.push(faultPool)
  await faultPool.start()
  const slow = binding('slow-A')
  const waiting = faultPool.bind(slow, rootInput, () => {}).readBytes('hello', 5)
  const rejected = assert.rejects(waiting, error => error.code === 'cloud/stale-generation')
  if (Atomics.load(state, 0) === 0) await Atomics.waitAsync(state, 0, 0, 3000).value
  assert.equal(Atomics.load(state, 0), 1)
  const unknown = await faultPool.stopEpoch(slow, Date.now() + 20)
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.pendingOperationIds.length, 1)
  await rejected
  assert.equal(faultPool.inspect().busy, 1)
  Atomics.store(state, 1, 1)
  Atomics.notify(state, 1)
  assert.equal((await faultPool.stopEpoch(slow, Date.now() + 3000)).status, 'confirmed')
  assert.equal(faultPool.inspect().healthy, 1)
  assert.equal((await faultPool.stop(Date.now() + 3000)).status, 'confirmed')

  let failedCreated = 0
  const failedPool = new LinuxFilesPool({ ...config, workerCount: 1, maxRunning: 1 }, () => {
    failedCreated++
    return new Worker(pathToFileURL(path.join(packageRoot, 'tests/fixtures/transport-worker.mjs')), { workerData: { mode: 'crash' } })
  })
  pools.push(failedPool)
  await failedPool.start()
  const crash = binding('crash-A')
  const crashPort = failedPool.bind(crash, rootInput, () => {})
  await assert.rejects(crashPort.readBytes('hello', 5), error => error.code === 'FS_IO_ERROR')
  assert.equal(failedPool.inspect().healthy, 0)
  assert.equal(failedPool.inspect().exited, 1)
  await assert.rejects(crashPort.readBytes('hello', 5))
  assert.equal(failedCreated, 1)
  assert.equal((await failedPool.stop(Date.now() + 3000)).status, 'confirmed')
  const raw = new Worker(pathToFileURL(path.join(temporary, 'file-worker.js')), { workerData: config, execArgv: [] })
  extraWorkers.push(raw)
  const receive = () => once(raw, 'message', { signal: AbortSignal.timeout(3000) }).then(([message]) => message)
  assert.equal((await receive()).kind, 'ready')
  const cancelled = new SharedArrayBuffer(4)
  Atomics.store(new Int32Array(cancelled), 0, 1)
  const cancelledId = '11111111-1111-1111-1111-111111111111'
  const abortReply = receive()
  raw.postMessage({ kind: 'stream', id: cancelledId, root: rootInput, relativePath: 'hello', maxBytes: 256, cancel: cancelled })
  raw.postMessage({ kind: 'stream-cancel', id: cancelledId })
  assert.equal((await abortReply).code, 'FS_ABORTED')
  const nextMetadata = receive()
  raw.postMessage({
    kind: 'stat', id: '22222222-2222-2222-2222-222222222222', root: rootInput,
    relativePath: 'hello', maxBytes: 0, cancel: new SharedArrayBuffer(4),
  })
  assert.equal((await nextMetadata).kind, 'stat-reply')
  await raw.terminate()
  const filesystem = spawnSync('stat', ['-f', '-c', '%T', root], { encoding: 'utf8' })
  console.log(JSON.stringify({
    platform: process.platform, node: process.version, kernel: os.release(), filesystem: filesystem.stdout.trim(),
    workerCount: 2, actualWorkersCreatedAcrossRepeatedABReads: created, helperAbiVersion: 4,
    passed: ['prebuilt-shared-pool', 'repeated-AB-root-isolation', 'bounded-transfer', 'link-FIFO-refusal', 'account-drain-preserves-pool', 'actual-root-exit-before-release', 'anchor-FD-cleanup', 'root-identity-mismatch', 'real-thread-drain-deadline-unknown', 'real-worker-crash-no-replacement', 'native-stat-version-directory-missing', 'issued-target-and-root-confinement', 'single-FD-stream-across-rename', 'cross-chunk-UTF8-binary-rejection', 'growth-cap-plus-one', 'stream-consumer-early-return', 'paused-decoder-lease-after-FD-close', 'cancel-before-stream-ready-preserves-worker'],
    notValidated: ['ext4', 'NFS', 'native-blocked-NFS-syscall', 'directory-replacement-races', 'all-native-FS-methods', 'hard-byte-inode-quota', 'published-artifact'],
  }))
} finally {
  await Promise.all(extraWorkers.map(worker => worker.terminate()))
  await Promise.all(pools.map(pool => pool.stop(Date.now() + 3000)))
  await Promise.all(pools.map(pool => pool.whenClosed()))
  fs.rmSync(temporary, { recursive: true, force: true })
}
