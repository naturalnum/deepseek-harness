/** Isolated Linux test of ABI8 through the built worker; no application/profile is launched. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, opendirSync, writeFileSync, symlinkSync, linkSync, unlinkSync, readdirSync, renameSync, statSync, rmSync } from 'node:fs'
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
  assert.equal(helper.directoryListingVersion, 1)
  assert.equal(helper.skillProjectionVersion, 1)
  assert.equal(typeof helper.inspectSkillStore, 'function')
  for (const [path, abi] of [[abi6Path, 6], [abi7Path, 7]]) {
    if (!path) continue
    const old = require(path)
    assert.equal(old.abiVersion, abi)
    assert.equal(old.openPathMetadata, undefined)
    assert.equal(old.listDirectory, undefined)
    assert.equal(old.directoryListingVersion, undefined)
    assert.equal(old.directoryPagingVersion, undefined)
    assert.equal(old.openDirectoryEnumeration, undefined)
    assert.equal(old.pullDirectoryEnumeration, undefined)
    assert.equal(old.closeDirectoryEnumeration, undefined)
    assert.equal(typeof old.writeText, abi === 7 ? 'function' : 'undefined')
  }
  const project = mkdtempSync(join(parent, 'content-')), outside = mkdtempSync(join(parent, 'outside-'))
  const info = statSync(project, { bigint: true })
  const root = { rootPath: project, rootDevice: String(info.dev), rootInode: String(info.ino) }
  const workers = new Set()
  let operationCount = 0
  const spawn = async (content = {}, maxPathBytes = 4096, directoryPaging) => {
    const value = new Worker(workerPath, { workerData: { helperPath, maxReadBytes: 64, maxPathBytes,
      maxResolveRetries: 2, readChunkBytes: 7,
      ...directoryPaging === undefined ? {} : { directoryPaging },
      content: { maxEntries: 16, maxNameBytes: 255, maxReplyBytes: 16384, operationTimeoutMs: 1000, ...content } } })
    workers.add(value)
    const [ready] = await once(value, 'message', { signal: AbortSignal.timeout(5000) })
    assert.equal(ready.kind, 'ready'); assert.equal(ready.abiVersion, 8)
    assert.equal(ready.directoryListingVersion, 1)
    assert.equal(ready.directoryPagingVersion, directoryPaging === undefined ? undefined : 1)
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
    assert.equal((await request(maximumNames, 'list', 'dir', { maxEntries: 2, maxBytes: 4096 })).listing.entries.length, 2)
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
    assert.equal(listed.listing.truncated, false)
    assert.deepEqual(listed.listing.entries.map(entry => [entry.name, entry.type, entry.size]), [['a', 'file', 1], ['你.txt', 'file', 5]])
    const partial = await request(worker, 'list', 'dir', { maxEntries: 1, maxBytes: 4096 })
    assert.equal(partial.listing.entries.length, 1); assert.equal(partial.listing.truncated, true)
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
      assert.equal((await request(worker, 'list', 'dir', { maxEntries: 2, maxBytes: 4096 })).listing.entries.length, 2)
      assert.equal((await request(worker, 'range', 'large', { offset: 127, length: 4, maxBytes: 4 })).bytes.byteLength, 1)
    }
    await smallNames.terminate(); workers.delete(smallNames)
    assert.equal(readdirSync('/proc/self/fd').length, initialFds)
    const bounded = await spawn({ maxEntries: 64, maxReplyBytes: 65536 })
    for (const count of [0, 63, 64, 65, 129]) {
      const name = `boundary-${count}`, directory = join(project, name)
      mkdirSync(directory)
      for (let index = 0; index < count; index++) writeFileSync(join(directory, `file-${String(index).padStart(3, '0')}`), 'x')
      const reply = await request(bounded, 'list', name, { maxEntries: 64, maxBytes: 65536 })
      assert.equal(reply.kind, 'list-reply')
      assert.equal(reply.listing.entries.length, Math.min(64, count))
      assert.equal(reply.listing.truncated, count > 64)
      const names = reply.listing.entries.map(entry => entry.name)
      assert.equal(new Set(names).size, names.length)
      assert.deepEqual(names, [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
      assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 65536)
    }
    // The Host-loaded helper has its own original environment state, separate from worker instances.
    assert.equal(helper.directoryPagingVersion, 1)
    const beginEnumeration = (relative, maxEntries = 64, maxBytes = 65536) => {
      helper.openAnchor(root.rootPath, root.rootDevice, root.rootInode, '0')
      return helper.openDirectoryEnumeration(root.rootPath, relative, maxEntries, maxBytes, 255, 1000,
        new Int32Array(new SharedArrayBuffer(4)))
    }
    const pullEnumeration = () => helper.pullDirectoryEnumeration(1000, new Int32Array(new SharedArrayBuffer(4)))
    for (const count of [0, 63, 64, 65, 128, 129]) {
      const relative = `pages-${count}`, path = join(project, relative)
      mkdirSync(path)
      const expected = Array.from({ length: count }, (_, index) => `file-${String(index).padStart(3, '0')}`)
      for (const name of expected) writeFileSync(join(path, name), 'x')
      const before = readdirSync('/proc/self/fd').length, version = beginEnumeration(relative), names = []
      let pageCount = 0
      try {
        assert.throws(() => helper.closeAnchor(), { code: 'EINVAL' })
        assert.throws(() => helper.openRead('large'), { code: 'EINVAL' })
        while (true) {
          const page = pullEnumeration(); pageCount++
          assert.equal(page.version, version)
          assert.ok(page.entries.length <= 64)
          assert.equal(page.closed, page.eof)
          assert.ok(page.eof || page.entries.length > 0)
          names.push(...page.entries.map(entry => Buffer.from(entry.nameBytes).toString('utf8')))
          if (page.eof) break
        }
        assert.equal(pageCount, Math.max(1, Math.ceil(count / 64)))
        assert.equal(new Set(names).size, count)
        assert.deepEqual([...names].sort(), expected)
        assert.equal(readdirSync('/proc/self/fd').length, before)
      } finally { helper.closeDirectoryEnumeration() }
    }
    // Byte exhaustion must retain a candidate too, not only the 65th name.
    mkdirSync(join(project, 'pages-bytes'))
    const byteNames = ['a', 'b', 'c', 'd']
    for (const name of byteNames) writeFileSync(join(project, 'pages-bytes', name), 'x')
    beginEnumeration('pages-bytes', 64, 512 + 512 + 6)
    const byteSeen = []
    try {
      while (true) {
        const page = pullEnumeration()
        assert.equal(page.entries.length, 1)
        byteSeen.push(Buffer.from(page.entries[0].nameBytes).toString('utf8'))
        if (page.eof) break
      }
      assert.deepEqual(byteSeen.sort(), byteNames)
    } finally { helper.closeDirectoryEnumeration() }
    const closedBefore = readdirSync('/proc/self/fd').length
    beginEnumeration('pages-129')
    assert.equal(pullEnumeration().eof, false)
    helper.closeDirectoryEnumeration()
    assert.equal(readdirSync('/proc/self/fd').length, closedBefore)
    const pageProbePath = join(project, 'pages-65'), pageReader = opendirSync(pageProbePath), pageRawNames = []
    try { for (let row; (row = pageReader.readSync()) !== null;) pageRawNames.push(row.name) } finally { pageReader.closeSync() }
    const pageProbeLink = join(outside, 'pagination-probe-link')
    linkSync(join(pageProbePath, pageRawNames[64]), pageProbeLink)
    beginEnumeration('pages-65')
    try {
      assert.equal(pullEnumeration().entries.length, 64)
      assert.throws(() => pullEnumeration(), { code: 'EPERM' })
    } finally { helper.closeDirectoryEnumeration(); unlinkSync(pageProbeLink) }
    assert.equal(readdirSync('/proc/self/fd').length, closedBefore)
    beginEnumeration('pages-bytes', 64, 512)
    assert.throws(() => pullEnumeration(), { code: 'EFBIG' })
    helper.closeDirectoryEnumeration()
    assert.equal(readdirSync('/proc/self/fd').length, closedBefore)
    // A real metadata version change retires the old directory instead of merging pages.
    beginEnumeration('pages-129')
    assert.equal(pullEnumeration().eof, false)
    writeFileSync(join(project, 'pages-129', 'added-after-page'), 'x')
    assert.throws(() => pullEnumeration(), { code: 'ESTALE' })
    helper.closeDirectoryEnumeration()
    assert.equal(readdirSync('/proc/self/fd').length, closedBefore)
    beginEnumeration('pages-65')
    assert.equal(pullEnumeration().eof, false)
    renameSync(join(project, 'pages-65'), join(project, 'pages-65-replaced'))
    mkdirSync(join(project, 'pages-65'))
    assert.throws(() => pullEnumeration(), { code: 'ESTALE' })
    helper.closeDirectoryEnumeration()
    assert.equal(readdirSync('/proc/self/fd').length, closedBefore)
    beginEnumeration('pages-65')
    const pageCancelled = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(pageCancelled, 0, 1)
    assert.throws(() => helper.pullDirectoryEnumeration(1000, pageCancelled), { code: 'ECANCELED' })
    helper.closeDirectoryEnumeration()
    assert.equal(readdirSync('/proc/self/fd').length, closedBefore)
    const pageWorker = await spawn({ maxEntries: 64, maxReplyBytes: 65536 }, 4096,
      { idleTimeoutMs: 1000, totalTimeoutMs: 10000, maxPages: 64 })
    const directoryControl = async (worker, message) => {
      operationCount++
      const response = once(worker, 'message', { signal: AbortSignal.timeout(5000) })
      worker.postMessage(message)
      const [reply] = await response
      assert.equal(reply.id, message.id)
      return reply
    }
    const pageReady = await request(pageWorker, 'directory-open', 'pages-129', { maxEntries: 64, maxBytes: 65536 })
    assert.equal(pageReady.kind, 'directory-ready')
    const workerPageNames = []
    for (let sequence = 0; sequence < 3; sequence++) {
      const reply = await directoryControl(pageWorker, { kind: 'directory-pull', id: pageReady.id, sequence })
      assert.equal(reply.kind, 'directory-page'); assert.equal(reply.sequence, sequence)
      assert.equal(reply.page.version, pageReady.version)
      assert.equal(reply.page.eof, sequence === 2); assert.equal(reply.page.closed, sequence === 2)
      workerPageNames.push(...reply.page.entries.map(entry => entry.name))
    }
    // pages-129 gained this item above; the held enumeration must include that actual current tree.
    assert.equal(workerPageNames.length, 130)
    assert.equal(new Set(workerPageNames).size, 130)
    assert.equal((await request(pageWorker, 'lstat', 'large')).kind, 'lstat-reply')
    const closing = await request(pageWorker, 'directory-open', 'pages-128', { maxEntries: 64, maxBytes: 65536 })
    assert.equal((await directoryControl(pageWorker, { kind: 'directory-close', id: closing.id })).kind, 'directory-closed')
    assert.equal((await request(pageWorker, 'lstat', 'large')).kind, 'lstat-reply')
    const idleWorker = await spawn({ maxEntries: 64, maxReplyBytes: 65536 }, 4096,
      { idleTimeoutMs: 100, totalTimeoutMs: 10000, maxPages: 64 })
    const idleReady = await request(idleWorker, 'directory-open', 'pages-128', { maxEntries: 64, maxBytes: 65536 })
    assert.equal(idleReady.kind, 'directory-ready')
    const [idleClosed] = await once(idleWorker, 'message', { signal: AbortSignal.timeout(5000) })
    failure(idleClosed, 'FS_ABORTED'); assert.equal(idleClosed.syscallCode, 'ETIMEDOUT')
    assert.equal((await request(idleWorker, 'lstat', 'large')).kind, 'lstat-reply')
    await idleWorker.terminate(); workers.delete(idleWorker)
    const totalWorker = await spawn({ maxEntries: 64, maxReplyBytes: 65536 }, 4096,
      { idleTimeoutMs: 1000, totalTimeoutMs: 100, maxPages: 64 })
    const totalReady = await request(totalWorker, 'directory-open', 'pages-128', { maxEntries: 64, maxBytes: 65536 })
    assert.equal(totalReady.kind, 'directory-ready')
    const [totalClosed] = await once(totalWorker, 'message', { signal: AbortSignal.timeout(5000) })
    failure(totalClosed, 'FS_ABORTED'); assert.equal(totalClosed.syscallCode, 'ETIMEDOUT')
    assert.equal((await request(totalWorker, 'lstat', 'large')).kind, 'lstat-reply')
    await totalWorker.terminate(); workers.delete(totalWorker)
    const budgetWorker = await spawn({ maxEntries: 64, maxReplyBytes: 65536 }, 4096,
      { idleTimeoutMs: 1000, totalTimeoutMs: 10000, maxPages: 1 })
    const budgetReady = await request(budgetWorker, 'directory-open', 'pages-129', { maxEntries: 64, maxBytes: 65536 })
    const permitted = await directoryControl(budgetWorker, { kind: 'directory-pull', id: budgetReady.id, sequence: 0 })
    assert.equal(permitted.kind, 'directory-page'); assert.equal(permitted.page.entries.length, 64)
    assert.equal(permitted.page.eof, false)
    failure(await directoryControl(budgetWorker, { kind: 'directory-pull', id: budgetReady.id, sequence: 1 }), 'FS_TOO_LARGE')
    assert.equal((await request(budgetWorker, 'lstat', 'large')).kind, 'lstat-reply')
    await budgetWorker.terminate(); workers.delete(budgetWorker)
    await pageWorker.terminate(); workers.delete(pageWorker)
    // Learn the actual raw enumeration order, then change only the probe child's link count.
    // A 65th metadata open would observe nlink=2 and fail; probing only its existence succeeds.
    const probePath = join(project, 'boundary-65'), reader = opendirSync(probePath), rawNames = []
    try { for (let row; (row = reader.readSync()) !== null;) rawNames.push(row.name) } finally { reader.closeSync() }
    assert.equal(rawNames.length, 65)
    const probe = rawNames[64], extraLink = join(outside, 'probe-link')
    linkSync(join(probePath, probe), extraLink)
    assert.equal(statSync(join(probePath, probe)).nlink, 2)
    const probed = await request(bounded, 'list', 'boundary-65', { maxEntries: 64, maxBytes: 65536 })
    assert.equal(probed.listing.truncated, true); assert.equal(probed.listing.entries.length, 64)
    assert.ok(probed.listing.entries.every(entry => entry.name !== probe))
    unlinkSync(extraLink)
    // A hard error on a returned child must discard the partial result.
    linkSync(join(probePath, rawNames[63]), extraLink)
    failure(await request(bounded, 'list', 'boundary-65', { maxEntries: 64, maxBytes: 65536 }), 'FS_PERMISSION_DENIED')
    unlinkSync(extraLink)
    const directoryInfo = statSync(probePath, { bigint: true })
    const directoryRoot = { rootPath: probePath, rootDevice: String(directoryInfo.dev), rootInode: String(directoryInfo.ino) }
    const beforeReplacement = await request(bounded, 'list', '.', { root: directoryRoot, maxEntries: 64, maxBytes: 65536 })
    assert.equal(beforeReplacement.listing.truncated, true)
    renameSync(probePath, probePath + '-retired'); mkdirSync(probePath)
    failure(await request(bounded, 'list', '.', { root: directoryRoot, maxEntries: 64, maxBytes: 65536 }), 'FS_PERMISSION_DENIED')
    rmSync(probePath, { recursive: true }); renameSync(probePath + '-retired', probePath)
    // Conservative native admission includes framing, escaped UTF-8 names and metadata.
    mkdirSync(join(project, 'escaped'))
    const escapedName = '你"\n.txt', nativeCharge = 128 + 512 + 6 * Buffer.byteLength(escapedName)
    writeFileSync(join(project, 'escaped', escapedName), 'x')
    for (const delta of [-1, 0, 1]) {
      const reply = await request(bounded, 'list', 'escaped', { maxEntries: 64, maxBytes: nativeCharge + delta })
      if (delta < 0) failure(reply, 'FS_TOO_LARGE')
      else {
        assert.deepEqual(reply.listing.entries.map(entry => entry.name), [escapedName])
        assert.equal(reply.listing.truncated, false)
        assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= nativeCharge + delta)
      }
    }
    mkdirSync(join(project, 'byte-bound'))
    writeFileSync(join(project, 'byte-bound', 'a'), 'x'); writeFileSync(join(project, 'byte-bound', 'b'), 'x')
    const byteBound = await request(bounded, 'list', 'byte-bound', { maxEntries: 64, maxBytes: 128 + 512 + 6 })
    assert.equal(byteBound.listing.entries.length, 1); assert.equal(byteBound.listing.truncated, true)
    failure(await request(bounded, 'list', 'boundary-65',
      { maxEntries: 64, maxBytes: 65536, root: { ...root, rootInode: '0' } }), 'FS_PERMISSION_DENIED')
    await bounded.terminate(); workers.delete(bounded)
    assert.equal(readdirSync('/proc/self/fd').length, initialFds)
    mkdirSync(join(project, 'many'))
    for (let i = 0; i < 2000; i++) writeFileSync(join(project, 'many', String(i)), '')
    const timed = await spawn({ maxEntries: 3000, maxReplyBytes: 4 * 1024 * 1024, operationTimeoutMs: 1 })
    const timedReply = await request(timed, 'list', 'many', { maxEntries: 3000, maxBytes: 4 * 1024 * 1024 })
    failure(timedReply, 'FS_ABORTED'); assert.equal(timedReply.syscallCode, 'ETIMEDOUT')
    console.log(JSON.stringify({ status: 'passed', abi: 8, directoryListingVersion: 1, directoryPagingVersion: 1, nativePageCounts: [0, 63, 64, 65, 128, 129], nativePageChecks: ['exact-page-count-and-name-set', 'byte-lookahead', 'probe-metadata-deferred', 'single-item-byte-refusal', 'active-anchor-reuse-refusal', 'explicit-close-fds', 'directory-version-change', 'named-directory-replacement', 'cancel-closes-fds', 'built-worker-page-sequence-and-EOF', 'built-worker-close-confirmation', 'no-credit-idle-closes-and-worker-reusable'], operationCount, rejectedLimitInputs: 3, exactNameCeilingPositive: true, repeatedOperations: 90, checks: ['nofollow-final-and-dangling', 'anchor-containment', 'entry/name/reply-caps', '0-63-64-65-129-completeness', '65th-probe-no-metadata-open', 'escaped-UTF8-native-admission-boundary', 'byte-bounded-partial', 'UTF8-name-rejection', 'bounded-positional-range-large-file', 'EOF-and-zero', 'hardlink-rejection', 'cancellation', 'monotonic-timeout', 'closed-descriptors', 'ABI6-7-exports-preserved'] }))
  } finally {
    await Promise.all([...workers].map(worker => worker.terminate()))
    rmSync(project, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
  }
}
