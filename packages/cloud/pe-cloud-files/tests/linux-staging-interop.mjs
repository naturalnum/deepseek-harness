/** Opt-in FD-only staging ABI1 evidence. Explicit helper, wrapper, ABI8 and disposable parent arguments required. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const require = createRequire(import.meta.url)
if (isMainThread) {
  assert.equal(process.platform, 'linux')
  assert.equal(process.argv.length, 6, 'staging.node wrapper.mjs abi8.node approved-disposable-parent required')
  const [asset, wrapper, abi8, parent] = process.argv.slice(2).map(value => resolve(value))
  const { loadStagingNative } = await import(pathToFileURL(wrapper).href)
  assert.throws(() => loadStagingNative(asset), /original worker/u)
  const root = mkdtempSync(join(parent, 'staging-abi1-'))
  const start = mode => new Worker(new URL(import.meta.url), { workerData: { asset, wrapper, abi8, root, mode } })
  const run = worker => new Promise((res, rej) => {
    let result
    worker.on('message', message => { result = message })
    worker.on('error', rej)
    worker.on('exit', code => code === 0 ? res(result) : rej(new Error('Test worker exited ' + code)))
  })
  try {
    const evidence = await run(start('suite'))
    const fds = readdirSync('/proc/self/fd').length
    const terminating = start('terminate')
    const ready = await new Promise((res, rej) => { terminating.once('message', res); terminating.once('error', rej) })
    assert.equal(ready.kind, 'active-own-temp')
    await terminating.terminate() // Wait actual exit and native env cleanup; no clean operation receipt is inferred.
    assert.deepEqual(readdirSync(ready.project), [])
    assert.equal(readdirSync('/proc/self/fd').length, fds)
    console.log(JSON.stringify({ status: 'passed', stagingAbi: 1, ...evidence,
      environmentExitCleanupObserved: true, terminationProducesCleanReceipt: false,
      nativeSourceProviderVerified: false, applicationOrAccountIntegration: false }))
  } finally { rmSync(root, { recursive: true, force: true }) }
} else {
  const { loadStagingNative, StagingFailure } = await import(pathToFileURL(workerData.wrapper).href)
  const companion = loadStagingNative(workerData.asset)
  const root = workerData.root
  let index = 0, groups = 0
  function project(label) {
    const path = join(root, `${++index}-${label}`)
    mkdirSync(path)
    return path
  }
  function input(path, data, name = 'binary.bin', overrides = {}) {
    const fd = openSync(path, 'r')
    let mount
    try { mount = /^mnt_id:\s+(\d+)$/mu.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))[1] } finally { closeSync(fd) }
    const st = statSync(path, { bigint: true })
    return { rootPath: path, device: String(st.dev), inode: String(st.ino), mountId: mount,
      digest: sha(data), name, expectedBytes: data.length, maxBytes: 8 * 1024 * 1024,
      maxChunkBytes: 64 * 1024, maxPathBytes: 4096, timeoutMs: 30000,
      cancel: new Int32Array(new SharedArrayBuffer(4)), ...overrides }
  }
  const leaf = options => join(options.rootPath, '.pe', 'attachments', options.digest, options.name)
  const ready = async () => {}
  function put(tx, bytes) {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const chunk = bytes.subarray(offset, offset + 64 * 1024)
      const ack = tx.write(chunk)
      assert.equal(ack.kind, 'written')
    }
  }
  function reread(tx) {
    const chunks = []
    for (;;) {
      const result = tx.readExisting()
      assert.ok(result.bytes.length <= 64 * 1024)
      if (result.eof) { assert.equal(result.bytes.length, 0); break }
      chunks.push(Buffer.from(result.bytes)) // Test-only byte capture; production discards each borrowed view after hashing.
    }
    return Buffer.concat(chunks)
  }
  async function rejected(promise, reason) {
    await assert.rejects(promise, error => error instanceof StagingFailure && error.reason === reason && error.facts.closed && error.facts.clean)
  }
  if (workerData.mode === 'terminate') {
    const path = project('environment-exit')
    const tx = companion.begin(input(path, Buffer.from('incomplete')), ready)
    tx.write(Buffer.from('in'))
    assert.ok(readdirSync(join(path, '.pe', 'attachments', sha(Buffer.from('incomplete')))).some(name => name.startsWith('.stage-')))
    parentPort.postMessage({ kind: 'active-own-temp', project: path })
    setInterval(() => {}, 1000)
  } else {
    const initial = readdirSync('/proc/self/fd').length
    const binary = Buffer.alloc(64 * 1024 * 2 + 257)
    for (let i = 0; i < binary.length; i++) binary[i] = i * 197 & 255
    // Real fixture source EOF plus actual close are observed inside this same worker.
    for (const bytes of [Buffer.alloc(0), binary]) {
      const path = project(bytes.length ? 'binary' : 'zero')
      const source = join(root, `source-${index}`); writeFileSync(source, bytes)
      let eof = false, closed = false
      const tx = companion.begin(input(path, bytes), async () => { assert.equal(eof, true); assert.equal(closed, true) })
      const stream = createReadStream(source, { highWaterMark: 64 * 1024 })
      const didClose = new Promise((res, rej) => { stream.once('close', () => { closed = true; res() }); stream.once('error', rej) })
      for await (const chunk of stream) tx.write(chunk)
      eof = true; await didClose
      const result = await tx.finalize()
      assert.equal(result.kind, 'published'); assert.equal(result.closed, true); assert.equal(result.clean, true)
      const target = leaf(input(path, bytes))
      assert.deepEqual(readFileSync(target), bytes)
      assert.equal(statSync(target).nlink, 1)
      assert.notEqual(statSync(target).ino, statSync(source).ino)
      assert.ok(!readdirSync(join(target, '..')).some(name => name.startsWith('.stage-')))
      const existing = companion.begin(input(path, bytes), async () => { throw new Error('existing has no source') })
      assert.deepEqual(reread(existing), bytes)
      assert.equal((await existing.finalize()).kind, 'reused')
      groups++
    }
    const bytes = Buffer.from('existing-copy')
    const path = project('reuse'); const options = input(path, bytes)
    let tx = companion.begin(options, ready); put(tx, bytes); await tx.finalize()
    const original = statSync(leaf(options)).ino
    tx = companion.begin(options, async () => { throw new Error('existing must not open source') })
    assert.equal(tx.state.kind, 'existing'); assert.deepEqual(reread(tx), bytes)
    const reused = await tx.finalize()
    assert.equal(reused.kind, 'reused'); assert.equal(reused.closed, true); assert.equal(statSync(leaf(options)).ino, original); groups++
    const existingGrowthEvidence = []
    for (const tailBytes of [1, 2 * 64 * 1024]) {
      const prefix = Buffer.alloc(64 * 1024 + 7, 166)
      const tail = Buffer.alloc(tailBytes, 89)
      const growth = input(project('existing-growth-' + tailBytes), prefix)
      tx = companion.begin(growth, ready); put(tx, prefix); await tx.finalize()
      tx = companion.begin(growth, ready)
      assert.equal(tx.readExisting().bytes.byteLength, 64 * 1024)
      appendFileSync(leaf(growth), tail) // Real file growth between reads, still below the server maxBytes stat cap.
      let failureFacts
      assert.throws(() => tx.readExisting(), error => {
        failureFacts = error.facts
        return error instanceof StagingFailure && error.facts.code === 'EFBIG'
          && error.facts.readBytes === growth.expectedBytes + 1 && error.facts.closed && error.facts.clean
      })
      assert.deepEqual(readFileSync(leaf(growth)), Buffer.concat([prefix, tail]))
      existingGrowthEvidence.push({ expectedBytes: growth.expectedBytes, appendedBytes: tailBytes,
        observedReadBytes: failureFacts.readBytes, code: failureFacts.code, closed: failureFacts.closed,
        originalPreserved: true, preservedSize: statSync(leaf(growth)).size })
    }
    groups++
    // Every success and settled failure closes all descriptors, including repeated transactions.
    for (let count = 0; count < 30; count++) {
      tx = companion.begin(options, ready); reread(tx); assert.equal((await tx.finalize()).kind, 'reused')
    }
    assert.equal(readdirSync('/proc/self/fd').length, initial); groups++
    // Native sequence/credit checks apply even when the typed wrapper is bypassed.
    const native = require(workerData.asset)
    const direct = input(project('native-sequence'), bytes)
    const begun = native.begin(direct)
    assert.throws(() => native.write(begun.handle, 1, bytes), { code: 'EINVAL' })
    assert.throws(() => native.finalize({ verified: true }), { code: 'EINVAL' })
    const directAbort = native.abort(begun.handle)
    assert.equal(directAbort.closed, true); assert.equal(directAbort.clean, true); assert.deepEqual(readdirSync(direct.rootPath), []); groups++
    const unshared = input(project('nonshared-cancel'), bytes, 'x', { cancel: new Int32Array(1) })
    assert.throws(() => native.begin(unshared), { code: 'EINVAL' }); assert.deepEqual(readdirSync(unshared.rootPath), []); groups++
    for (const [label, delivered, reason] of [
      ['short-source', binary.subarray(0, binary.length - 1), 'INCOMPLETE_BYTES_OR_EOF'],
      ['wrong-hash', Buffer.alloc(binary.length, 42), 'CONTENT_HASH_MISMATCH'],
    ]) {
      const p = project(label); const op = input(p, binary); tx = companion.begin(op, ready); put(tx, delivered)
      await rejected(tx.finalize(), reason); assert.equal(existsSync(leaf(op)), false); assert.deepEqual(readdirSync(p), []); groups++
    }
    for (const label of ['missing-eof', 'source-close-error', 'trailing-source-error']) {
      const p = project(label); const op = input(p, bytes)
      tx = companion.begin(op, async () => { throw new Error(label) }); put(tx, bytes)
      await rejected(tx.finalize(), 'SOURCE_OR_NATIVE_FINALIZE_FAILED')
      assert.equal(existsSync(leaf(op)), false); assert.deepEqual(readdirSync(p), []); groups++
    }
    const delayed = input(project('abort-during-source-settlement'), bytes)
    let sourceClosed
    tx = companion.begin(delayed, () => new Promise(res => { sourceClosed = res })); put(tx, bytes)
    const settling = tx.finalize(); assert.equal(typeof sourceClosed, 'function')
    assert.equal(tx.abort().closed, true); sourceClosed()
    await rejected(settling, 'ABORTED_WHILE_SOURCE_SETTLING')
    assert.equal(existsSync(leaf(delayed)), false); groups++
    const foreignFailure = input(project('source-StagingFailure'), bytes)
    tx = companion.begin(foreignFailure, async () => { throw new StagingFailure('foreign-source', {}) }); put(tx, bytes)
    await rejected(tx.finalize(), 'SOURCE_OR_NATIVE_FINALIZE_FAILED')
    assert.deepEqual(readdirSync(foreignFailure.rootPath), []); groups++
    const extra = input(project('extra-byte'), bytes); tx = companion.begin(extra, ready); put(tx, bytes)
    assert.throws(() => tx.write(Buffer.from('x')), error => error.reason === 'SOURCE_SIZE_EXCEEDED' && error.facts.closed && error.facts.clean)
    assert.equal(existsSync(leaf(extra)), false); groups++
    // Corrupt existing copies fail closed and are neither overwritten nor removed.
    const corrupt = Buffer.alloc(bytes.length, 88); writeFileSync(leaf(options), corrupt)
    tx = companion.begin(options, ready); reread(tx); await rejected(tx.finalize(), 'CONTENT_HASH_MISMATCH')
    assert.deepEqual(readFileSync(leaf(options)), corrupt); groups++
    writeFileSync(leaf(options), bytes.subarray(1))
    assert.throws(() => companion.begin(options, ready), error => error instanceof StagingFailure && error.facts.closed && error.facts.clean)
    assert.deepEqual(readFileSync(leaf(options)), bytes.subarray(1)); groups++
    // Publication race must return a new existing-read phase, never successful existence.
    for (const bad of [false, true]) {
      const op = input(project('EEXIST-' + bad), bytes); tx = companion.begin(op, ready); put(tx, bytes)
      writeFileSync(leaf(op), bad ? corrupt : bytes)
      const raced = await tx.finalize(); assert.equal(raced.kind, 'existing'); assert.equal(raced.closed, false)
      assert.deepEqual(reread(tx), bad ? corrupt : bytes)
      if (bad) await rejected(tx.finalize(), 'CONTENT_HASH_MISMATCH')
      else assert.equal((await tx.finalize()).kind, 'reused')
      assert.deepEqual(readFileSync(leaf(op)), bad ? corrupt : bytes); groups++
    }
    // Unsupported/uncanonical names and digests reject before creating .pe.
    for (const name of ['.', '..', '../escape', 'a/b', 'a\\b', 'con.txt', 'COM1', 'a\0b', ' leading', 'end.', '\u00a0leading']) {
      const p = project('name'); assert.throws(() => companion.begin(input(p, bytes, name), ready)); assert.deepEqual(readdirSync(p), [])
    }
    const badDigest = project('digest'); assert.throws(() => companion.begin(input(badDigest, bytes, 'x', { digest: 'A'.repeat(64) }), ready)); assert.deepEqual(readdirSync(badDigest), []); groups++
    for (const which of ['root', '.pe', 'attachments', 'digest', 'target', 'hardlink']) {
      const p = project('links-' + which); const op = input(p, bytes); const outside = project('outside-' + which)
      if (which === 'root') { const alias = join(root, 'root-link'); symlinkSync(p, alias); op.rootPath = alias }
      else if (which === '.pe') symlinkSync(outside, join(p, '.pe'))
      else {
        mkdirSync(join(p, '.pe'))
        if (which === 'attachments') symlinkSync(outside, join(p, '.pe', 'attachments'))
        else {
          mkdirSync(join(p, '.pe', 'attachments'))
          if (which === 'digest') symlinkSync(outside, join(p, '.pe', 'attachments', op.digest))
          else {
            mkdirSync(join(p, '.pe', 'attachments', op.digest))
            const source = join(outside, 'private'); writeFileSync(source, bytes)
            if (which === 'target') symlinkSync(source, leaf(op))
            else linkSync(source, leaf(op))
          }
        }
      }
      assert.throws(() => companion.begin(op, ready), error => error instanceof StagingFailure && error.facts.closed)
      assert.deepEqual(readdirSync(outside), which === 'target' || which === 'hardlink' ? ['private'] : []); groups++
    }
    for (const key of ['inode', 'mountId']) {
      const p = project('wrong-' + key); const op = input(p, bytes); op[key] = String(BigInt(op[key]) + 1n)
      assert.throws(() => companion.begin(op, ready), error => error instanceof StagingFailure && error.facts.closed)
      assert.deepEqual(readdirSync(p), []); groups++
    }
    const aborted = input(project('abort'), binary); tx = companion.begin(aborted, ready); tx.write(binary.subarray(0, 500))
    assert.throws(() => companion.begin(aborted, ready), { code: 'EBUSY' })
    const abort = tx.abort(); assert.equal(abort.kind, 'aborted'); assert.equal(abort.closed, true); assert.equal(abort.clean, true)
    assert.deepEqual(readdirSync(aborted.rootPath), []); groups++
    const shared = input(project('foreign-object-preserved'), binary); tx = companion.begin(shared, ready)
    const foreign = join(shared.rootPath, '.pe', 'attachments', shared.digest, 'foreign-object')
    writeFileSync(foreign, 'leave-intact')
    const sharedAbort = tx.abort()
    assert.equal(sharedAbort.closed, true); assert.equal(sharedAbort.clean, true)
    assert.equal(sharedAbort.retainedCreatedDirectories, 3); assert.equal(readFileSync(foreign, 'utf8'), 'leave-intact'); groups++
    const cancelled = input(project('cancelled'), bytes); tx = companion.begin(cancelled, ready)
    Atomics.store(cancelled.cancel, 0, 1)
    assert.throws(() => tx.write(bytes), error => error instanceof StagingFailure && error.facts.code === 'ECANCELED' && error.facts.closed && error.facts.clean)
    assert.deepEqual(readdirSync(cancelled.rootPath), []); groups++
    // Loading/using ABI1 beside ABI8 must preserve ABI8's independent env instance_data.
    const fd8 = require(workerData.abi8); assert.equal(fd8.abiVersion, 8)
    const coexist = input(project('ABI8-coexistence'), bytes)
    fd8.openAnchor(coexist.rootPath, coexist.device, coexist.inode, coexist.mountId)
    tx = companion.begin(coexist, ready); put(tx, bytes); assert.equal((await tx.finalize()).kind, 'published')
    fd8.openRead(`.pe/attachments/${coexist.digest}/${coexist.name}`); fd8.closeRead(); fd8.closeAnchor(); groups++
    assert.equal(readdirSync('/proc/self/fd').length, initial)
    // Observe this Node build's control-allocation peak separately from the one reusable 64KiB read scratch.
    const memoryChunk = Buffer.alloc(64 * 1024, 137)
    const memoryHash = createHash('sha256')
    for (let i = 0; i < 128; i++) memoryHash.update(memoryChunk)
    const memoryOptions = input(project('memory-8MiB'), Buffer.alloc(0), 'memory.bin',
      { expectedBytes: 8 * 1024 * 1024, digest: memoryHash.digest('hex') })
    const gcAvailable = typeof globalThis.gc === 'function'
    if (gcAvailable) globalThis.gc()
    const baseline = process.memoryUsage()
    tx = companion.begin(memoryOptions, ready)
    const afterBegin = process.memoryUsage()
    for (let i = 0; i < 128; i++) tx.write(memoryChunk)
    const afterWrites = process.memoryUsage()
    assert.equal((await tx.finalize()).kind, 'published')
    const afterPublish = process.memoryUsage()
    tx = companion.begin(memoryOptions, ready)
    while (!tx.readExisting().eof) { /* hash in place; no retained byte views or fixture copies */ }
    const afterReads = process.memoryUsage()
    assert.equal((await tx.finalize()).kind, 'reused')
    const afterReuse = process.memoryUsage()
    const retainedForGc = tx
    if (gcAvailable) globalThis.gc() // One end-of-test observation; no collection loop or tuning toward a target.
    const afterFinalGc = process.memoryUsage()
    assert.equal(retainedForGc.state.kind, 'reused')
    const memoryObservation = { gcAvailable, fileBytes: memoryOptions.expectedBytes, chunkBytes: memoryChunk.length,
      nativeControlBytes: native.nativeControlBytes, pathLimit: memoryOptions.maxPathBytes,
      samples: { baseline, afterBegin, afterWrites, afterPublish, afterReads, afterReuse, afterFinalGc },
      retainedHeapDeltaAfterFinalGc: afterFinalGc.heapUsed - baseline.heapUsed,
      retainedForGc: { completedTransactions: 1, existingScratchBuffers: 1, scratchBytes: memoryOptions.maxChunkBytes,
        chunkOrReceiptHistoryArrays: 0 },
      observedHeapPeakDelta: Math.max(afterBegin.heapUsed, afterWrites.heapUsed, afterPublish.heapUsed,
        afterReads.heapUsed, afterReuse.heapUsed) - baseline.heapUsed,
      observedExternalPeakDelta: Math.max(afterBegin.external, afterWrites.external, afterPublish.external,
        afterReads.external, afterReuse.external) - baseline.external,
      formalVmAllocationUpperBoundEstablished: false }
    groups++
    // Identity loss cannot be reported as clean; environment is then poisoned, never reused.
    const swapped = input(project('directory-swap'), bytes); tx = companion.begin(swapped, ready); put(tx, bytes)
    renameSync(join(swapped.rootPath, '.pe', 'attachments', swapped.digest), join(swapped.rootPath, '.pe', 'attachments', 'moved'))
    const unknown = tx.abort(); assert.equal(unknown.kind, 'unknown'); assert.equal(unknown.clean, false); assert.equal(unknown.closed, true)
    assert.throws(() => companion.begin(swapped, ready), { code: 'EBUSY' }); groups++
    assert.equal(readdirSync('/proc/self/fd').length, initial)
    parentPort.postMessage({ semanticCaseGroups: groups, repeatedReuseChecks: 30, descriptorCountReturnedToBaseline: true,
      existingGrowthEvidence, memoryObservation,
      checks: ['zero-byte', 'cross-chunk-arbitrary-binary', 'worker-size-and-hash', 'real-fixture-source-EOF-and-close',
        'incomplete-or-source-error-no-publish', 'full-existing-EOF-rehash', 'corrupt-copy-preserved', 'EEXIST-revalidation',
        'canonical-name-and-digest', 'root-and-parent-links', 'hardlinks', 'root-and-mount-identity', 'single-active-transaction',
        'own-temp-cleanup', 'cancellation', 'ABI8-coexistence', 'directory-swap-unknown-poisons-environment'] })
  }
}
