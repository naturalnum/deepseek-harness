// @ts-check
/** Opt-in built-artifact Linux consumer; fixture roots and bindings carry no account-readiness evidence. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.env.DSH_INSTRUCTIONS_FILES_INTEROP !== '1') {
  console.log(JSON.stringify({ status: 'skipped', reason: 'Set DSH_INSTRUCTIONS_FILES_INTEROP=1 for the built-artifact Linux test.' }))
} else {
  await main()
}

async function main() {
  assert.equal(process.platform, 'linux', 'This opt-in test requires real Linux FD workers.')
  assert.equal(process.arch, 'arm64', 'The reviewed ABI3 helper is Linux ARM64.')
  const [helperPath, manifestPath] = process.argv.slice(2)
  assert.ok(helperPath && isAbsolute(helperPath), 'Pass the absolute ABI3 helper path.')
  assert.ok(manifestPath && isAbsolute(manifestPath), 'Pass the absolute helper manifest path.')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.helperAbi, 3)
  assert.equal(manifest.platform, 'linux/arm64')
  const helperHash = createHash('sha256').update(readFileSync(helperPath)).digest('hex')
  assert.equal(helperHash, manifest.artifactSha256, 'Use the reviewed helper bytes without rebuilding them.')

  // Resolve the sibling package's declared public export. Do not import its private source or lib/types files.
  // This standalone artifact test does not require installing another workspace dependency into this package.
  const filesRequire = createRequire(new URL('../../pe-cloud-files/package.json', import.meta.url))
  const localRequire = createRequire(import.meta.url)
  const runtimeRequire = createRequire(localRequire.resolve('@deepseek-ai/dsh-pe-cloud-runtime/package.json'))
  const filesRootPath = filesRequire.resolve('@deepseek-ai/dsh-pe-cloud-files/root')
  /** @type {typeof import('@deepseek-ai/dsh-pe-cloud-files/root')} */
  const FilesRoot = await import(pathToFileURL(filesRootPath).href)
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: RuntimeRoot } = await import('@deepseek-ai/dsh-pe-cloud-runtime/root')
  const { WorkspaceId } = await import('@deepseek-ai/dsh-workspace')
  const { FsError } = await import('@deepseek-ai/dsh-fs')
  /** @type {typeof import('@deepseek-ai/dsh-brand')} */
  const { brandString } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-brand')).href)
  // Same-package private emitted implementation; this is not a public SDK export.
  const { prepareInstructionSnapshot } = await import('../lib/types/snapshot.js')

  const temporary = mkdtempSync(join(tmpdir(), 'dsh-instructions-files-'))
  const rootA = join(temporary, 'A')
  const rootB = join(temporary, 'B')
  const textA = '123456你🙂Z\r\nA_ONLY'
  const textB = '123456她🚀Z\r\nB_ONLY'
  const childA = 'A child fallback'
  const childB = 'B child preferred'
  const control = new AbortController()
  const ctx = new Context()
  /** @type {import('@deepseek-ai/cordis').Context['peFilesPool'] | undefined} */
  let pool
  /** @type {Awaited<ReturnType<typeof ctx.plugin>> | undefined} */
  let filesFiber
  /** @type {Record<string, unknown>} */
  const cleanup = {}
  /** @type {Record<string, unknown> | undefined} */
  let result
  try {
    for (const root of [rootA, rootB]) mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(rootA, 'AGENTS.md'), textA)
    writeFileSync(join(rootA, 'CLAUDE.md'), 'A root fallback must stay excluded')
    writeFileSync(join(rootA, 'nested', 'CLAUDE.md'), childA)
    writeFileSync(join(rootB, 'CLAUDE.md'), textB)
    writeFileSync(join(rootB, 'nested', 'AGENTS.md'), childB)
    writeFileSync(join(rootB, 'nested', 'CLAUDE.md'), 'B child fallback must stay excluded')
    mkdirSync(join(rootA, 'invalid'))
    writeFileSync(join(rootA, 'invalid', 'AGENTS.md'), Buffer.from([0xff]))
    writeFileSync(join(rootA, 'invalid', 'CLAUDE.md'), 'invalid AGENTS must not fall back')
    mkdirSync(join(rootA, 'denied'))
    writeFileSync(join(temporary, 'outside'), 'outside fixture root')
    symlinkSync('../../outside', join(rootA, 'denied', 'AGENTS.md'))
    writeFileSync(join(rootA, 'denied', 'CLAUDE.md'), 'denied AGENTS must not fall back')

    await ctx.plugin(RuntimeRoot, { maxMountedAccounts: 2, maxConcurrentMounts: 1, maxConcurrentDrains: 1 })
    const filesConfig = {
      maxLanes: 2, maxRunning: 2, maxRunningPerLane: 1, maxQueued: 8, maxQueuedPerLane: 4,
      maxResidentBytes: 2_097_152, maxResidentBytesPerLane: 1_048_576, waitTimeoutMs: 3000,
      workerCount: 2, minimumHealthyWorkers: 2, workerReservationBytes: 4096, replyOverheadBytes: 512,
      readyTimeoutMs: 3000, drainTimeoutMs: 3000,
      helperPath, maxReadBytes: 2048, maxPathBytes: 4096, maxResolveRetries: 2, readChunkBytes: 7,
    }
    filesFiber = await ctx.plugin(FilesRoot, filesConfig)
    pool = ctx.get('peFilesPool')
    assert.ok(pool, 'The real public files/root must provide its actual pool.')
    const runtime = ctx.get('peAccountRuntime')
    assert.ok(runtime)
    assert.throws(() => runtime.assertRequiredParticipants(), /execution/)
    assert.equal(ctx.get('fs'), undefined)
    assert.deepEqual(pool.inspect(), {
      state: 'running', workers: 2, healthy: 2, busy: 0, exited: 0, rootReservedBytes: 8192,
    })

    /** @returns {import('@deepseek-ai/dsh-pe-cloud-runtime/types').AccountBinding} */
    function fixtureBinding(/** @type {string} */ id) {
      /** @type {typeof import('@deepseek-ai/dsh-brand').brandString<import('@deepseek-ai/dsh-pe-cloud-runtime/types').AccountId>} */
      const fixtureAccountId = brandString
      /** @type {typeof import('@deepseek-ai/dsh-brand').brandString<import('@deepseek-ai/dsh-pe-cloud-runtime/types').OwnerEpoch>} */
      const fixtureEpoch = brandString
      return Object.freeze({
        accountId: fixtureAccountId(id), epoch: fixtureEpoch('1'),
        recipeVersion: 'instructions-files-interop-fixture', lifetime: control.signal,
      })
    }
    function fixtureRoot(/** @type {string} */ rootPath) {
      const metadata = statSync(rootPath, { bigint: true })
      return { rootPath, rootDevice: String(metadata.dev), rootInode: String(metadata.ino) }
    }
    const bindingA = fixtureBinding('fixture-A')
    const bindingB = fixtureBinding('fixture-B')
    const checks = { A: 0, B: 0 }
    /** @type {Error | undefined} */
    let admissionFailure
    const portA = pool.bind(bindingA, fixtureRoot(rootA), () => {
      checks.A++
      control.signal.throwIfAborted()
      if (admissionFailure !== undefined) throw admissionFailure
    })
    const portB = pool.bind(bindingB, fixtureRoot(rootB), () => {
      checks.B++
      control.signal.throwIfAborted()
    })
    /** @type {import('../lib/types/internal-types.js').InstructionDirectory[]} */
    const directoriesA = [
      { kind: 'project', relativeName: 'nested', target: await portA.reader.resolve('nested') },
      { kind: 'project', relativeName: '.', target: await portA.reader.resolve('.') },
    ]
    /** @type {import('../lib/types/internal-types.js').InstructionDirectory[]} */
    const directoriesB = [
      { kind: 'project', relativeName: 'nested', target: await portB.reader.resolve('nested') },
      { kind: 'project', relativeName: '.', target: await portB.reader.resolve('.') },
    ]
    const identityA = { accountId: bindingA.accountId, workspaceId: WorkspaceId('fixture-workspace-A'), epoch: bindingA.epoch }
    const identityB = { accountId: bindingB.accountId, workspaceId: WorkspaceId('fixture-workspace-B'), epoch: bindingB.epoch }
    const caps = { maxFiles: 8, maxFileBytes: 1024, maxTotalBytes: 4096, maxSnapshotBytes: 16384, maxResidentBytes: 1_000_000 }
    const [snapshotA, snapshotB] = await Promise.all([
      prepareInstructionSnapshot(portA.reader, directoriesA, identityA, caps, control.signal),
      prepareInstructionSnapshot(portB.reader, directoriesB, identityB, caps, control.signal),
    ])
    assert.deepEqual(snapshotA.source.snapshot.sources.map(source => [source.relativeName, source.text]), [
      ['AGENTS.md', textA], ['nested/CLAUDE.md', childA],
    ])
    assert.deepEqual(snapshotB.source.snapshot.sources.map(source => [source.relativeName, source.text]), [
      ['CLAUDE.md', textB], ['nested/AGENTS.md', childB],
    ])
    for (const message of [snapshotA, snapshotB]) {
      const snapshot = message.source.snapshot
      assert.equal(message.source.kind, 'pe-account-instructions')
      assert.equal(message.source.form, 'instructions')
      assert.equal(snapshot.totalBytes, Buffer.byteLength(snapshot.text, 'utf8'))
      assert.deepEqual(message.content, [{ type: 'text', text: snapshot.text }])
      assert.ok(Object.isFrozen(message) && Object.isFrozen(snapshot) && Object.isFrozen(snapshot.sources))
      for (const source of snapshot.sources) {
        assert.equal(source.hash, createHash('sha256').update(source.text, 'utf8').digest('hex'))
      }
    }
    assert.equal(snapshotA.source.snapshot.accountId, bindingA.accountId)
    assert.equal(snapshotB.source.snapshot.accountId, bindingB.accountId)
    assert.ok(!snapshotA.source.snapshot.text.includes('B_ONLY'))
    assert.ok(!snapshotB.source.snapshot.text.includes('A_ONLY'))
    assert.ok(!snapshotA.source.snapshot.text.includes('must stay excluded'))
    assert.ok(!snapshotB.source.snapshot.text.includes('must stay excluded'))
    const chunks = []
    for await (const chunk of await portA.reader.streamText(await portA.reader.resolve('AGENTS.md'))) chunks.push(chunk)
    assert.ok(chunks.length > 1)
    assert.equal(chunks[0], '123456')
    assert.equal(chunks.join(''), textA)

    const exactBytes = Buffer.byteLength(JSON.stringify(snapshotA), 'utf8')
    const exact = await prepareInstructionSnapshot(portA.reader, directoriesA, identityA,
      { ...caps, maxSnapshotBytes: exactBytes }, control.signal)
    assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), exactBytes)
    await assert.rejects(prepareInstructionSnapshot(portA.reader, directoriesA, identityA,
      { ...caps, maxSnapshotBytes: exactBytes - 1 }, control.signal),
    error => error instanceof FsError && error.code === 'FS_TOO_LARGE')

    const invalidTarget = await portA.reader.resolve('invalid')
    await assert.rejects(prepareInstructionSnapshot(portA.reader,
      [{ kind: 'project', relativeName: '.', target: invalidTarget }], identityA, caps, control.signal),
    error => error instanceof FsError && error.code === 'FS_NOT_TEXT'
      && error.message === 'File is not valid UTF-8 text.' && error.cause instanceof TypeError)
    const deniedTarget = await portA.reader.resolve('denied')
    await assert.rejects(prepareInstructionSnapshot(portA.reader,
      [{ kind: 'project', relativeName: '.', target: deniedTarget }], identityA, caps, control.signal),
    error => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED')
    const originalFailure = new Error('Fixture owner admission ended')
    admissionFailure = originalFailure
    try {
      await assert.rejects(prepareInstructionSnapshot(portA.reader, directoriesA, identityA, caps, control.signal),
        error => error === originalFailure)
    } finally { admissionFailure = undefined }
    assert.ok(checks.A > 0 && checks.B > 0)
    const receipts = await Promise.all([
      pool.stopEpoch(bindingA, Date.now() + 3000), pool.stopEpoch(bindingB, Date.now() + 3000),
    ])
    assert.ok(receipts.every(receipt => receipt.status === 'confirmed' && receipt.pendingOperationIds.length === 0))
    assert.equal(pool.inspect().workers, 2)
    assert.equal(pool.inspect().healthy, 2)
    result = {
      status: 'passed', platform: process.platform, arch: process.arch, node: process.version, kernel: release(),
      filesRootExport: filesRootPath, snapshotImplementation: new URL('../lib/types/snapshot.js', import.meta.url).href,
      helperAbi: 3, helperSha256: helperHash, workerCount: 2, readChunkBytes: 7,
      snapshotABytes: exactBytes, sourceChecks: checks,
      passed: ['distinct-A-B-roots', 'AGENTS-priority', 'confirmed-absence-CLAUDE-fallback', 'root-to-cwd-order',
        'cross-chunk-fatal-UTF8-decoder', 'actual-text-hash-and-frozen-snapshot', 'exact-envelope-budget',
        'one-byte-over-budget-rejection', 'native-text-and-path-errors-without-fallback', 'original-owner-error-identity',
        'actual-epoch-drain-keeps-shared-workers'],
      notValidated: ['account-ready', 'formal-session-entry', 'trusted-project-discovery', 'execution', 'quota',
        'whole-snapshot-files-global-reservation', 'shipped-profile-acceptance', 'ext4-NFS'],
    }
  } finally {
    try {
      if (pool !== undefined) {
        await pool.stop(Date.now() + 3000)
        await pool.whenClosed()
        const observation = pool.inspect()
        assert.equal(observation.state, 'closed')
        assert.equal(observation.exited, 2)
        assert.equal(observation.rootReservedBytes, 0)
        cleanup.pool = observation
      }
      if (filesFiber !== undefined) {
        await filesFiber.dispose()
        assert.equal(ctx.get('peFilesPool'), undefined)
        cleanup.filesRootServiceRemoved = true
      }
    } finally {
      try { await ctx.fiber.dispose() } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    cleanup.contextDisposed = true
    cleanup.temporaryRootsRemoved = true
  }
  assert.ok(result)
  console.log(JSON.stringify({ ...result, cleanup }, null, 2))
}
