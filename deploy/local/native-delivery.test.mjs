/** Fixed controller behavior and persistence faults, without accessing the candidate environment. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import stateModule from './native-delivery-state.cjs'
import { runNativeDelivery, saveNativeProjection, withNativeOperationLock, requireNativeReleaseComplete } from './native-delivery.mjs'
import { requireOrdinaryUpdateState, requireOrdinaryRollbackState, startSavedApplication, nativeArguments } from './update.mjs'
import { createNativeAuthority, nativeAuthorityCommand } from './native-authority.mjs'
import profileModule from './native-profile.cjs'
import { nativeUpdate } from './native-update.mjs'

const { NativeRecordStore, NativeDeliveryOwner, requireNativeContinuation, legacyBarrier, publishFdAsset } = stateModule
const pins = { kind: 'fd-profile', operation: '00000000-0000-4000-8000-000000000001',
  descriptorSha256: '1'.repeat(64), originalTupleSha256: '2'.repeat(64),
  targetTupleSha256: '3'.repeat(64), compatibleTupleSha256: '4'.repeat(64) }
const names = ['publish', 'stop', 'backup', 'install', 'unbind', 'bind', 'seal', 'start', 'verify']
const unconfirmed = error => error.code === 'NATIVE_DELIVERY_UNCONFIRMED'

// Simulates Root metadata only; these tests do not establish any real target Root/asset identity.
function memoryRoot() {
  const files = new Map(), handles = new Map(), calls = []
  let next = 10, fault
  const directory = { uid: 0, gid: 0, mode: 0o700, dev: 1, ino: 2,
    isDirectory: () => true }
  const trigger = name => {
    calls.push(name)
    if (fault?.name === name && --fault.count === 0) { fault = undefined; throw new Error('injected-' + name) }
  }
  const io = {
    constants: fs.constants,
    fstatSync(fd) {
      trigger('stat')
      if (fd === 9) return { ...directory }
      const file = handles.get(fd).file
      return { uid: file.uid, gid: file.gid, mode: file.mode, dev: 1, ino: file.ino,
        nlink: 1, size: file.bytes.length, isFile: () => true }
    },
    readdirSync: () => [...files.keys()],
    openSync(path, flags, mode) {
      trigger('open')
      let file = files.get(path)
      if (flags === 'wx') {
        if (file) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
        file = { bytes: Buffer.alloc(0), uid: 0, gid: 0, mode, ino: next }
        files.set(path, file)
      } else if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      const fd = next++
      handles.set(fd, { file, write: flags === 'wx' })
      return fd
    },
    writeFileSync(fd, bytes) { trigger('write'); handles.get(fd).file.bytes = Buffer.from(bytes) },
    readFileSync(fd) { trigger('read'); return Buffer.from(handles.get(fd).file.bytes) },
    fchownSync(fd, uid, gid) { handles.get(fd).file.uid = uid; handles.get(fd).file.gid = gid },
    fchmodSync(fd, mode) { handles.get(fd).file.mode = mode },
    fsyncSync(fd) { trigger(fd === 9 ? 'directory-sync' : 'file-sync') },
    closeSync(fd) { const write = handles.get(fd).write; handles.delete(fd); trigger(write ? 'write-close' : 'read-close') },
    renameSync(from, to) { trigger('rename'); files.set(to, files.get(from)); files.delete(from) },
  }
  return { io, directory, calls, files,
    fail(name, count = 1) { fault = { name, count } },
    store() { return new NativeRecordStore(9, io) } }
}

async function guarded(root, input = pins) {
  const store = root.store()
  const owner = await NativeDeliveryOwner.reserve(input, store)
  const projected = []
  await owner.guard(async value => { projected.push(structuredClone(value)); return value })
  return { owner, store, projected }
}

test('one Root record precedes every publication, bind mutation and first launch', async () => {
  const root = memoryRoot(), { owner, store, projected } = await guarded(root)
  for (const name of names) {
    await owner.run(name, async () => {
      const record = store.read()
      assert.match(record.phase, /-intent$/)
      assert.deepEqual(projected.at(-1), legacyBarrier(record))
      if (name === 'start') assert.equal(record.firstLaunchMayHaveRun, true)
    })
  }
  assert.equal(owner.record.phase, 'verified')
  assert.equal(owner.record.firstLaunchMayHaveRun, true)
  assert.equal(owner.record.profileMayHaveChanged, true)
  assert.equal(owner.canRecoverOriginal(pins.originalTupleSha256), false)
  assert.equal(projected.at(-1).phase, 'native-owned')
})

test('write, sync, close, rename and readback faults prevent the next external action', async () => {
  for (const [name, count] of [['write', 1], ['file-sync', 1], ['write-close', 1], ['rename', 1],
    ['directory-sync', 1], ['read', 2], ['read-close', 2]]) {
    const root = memoryRoot(), { owner } = await guarded(root)
    root.fail(name, count)
    let effects = 0
    await assert.rejects(owner.run('publish', async () => { effects++ }), unconfirmed)
    assert.equal(effects, 0, name)
    assert.equal(owner.unknown, true, name)
    await assert.rejects(owner.run('publish', async () => { effects++ }), unconfirmed)
    assert.equal(effects, 0)
  }
})

test('a bind that changed state and then failed never seals, starts, retries or recovers', async () => {
  const root = memoryRoot(), { owner, store } = await guarded(root)
  for (const name of names.slice(0, 5)) await owner.run(name, async () => {})
  const cause = new Error('bind result lost')
  let binds = 0, starts = 0
  await assert.rejects(owner.run('bind', async () => { binds++; throw cause }), error => error.cause === cause)
  assert.equal(store.read().phase, 'profile-bind-intent')
  assert.equal(store.read().profileMayHaveChanged, true)
  await assert.rejects(owner.run('bind', async () => { binds++ }), unconfirmed)
  await assert.rejects(owner.run('start', async () => { starts++ }), unconfirmed)
  assert.equal(binds, 1)
  assert.equal(starts, 0)
  assert.equal(owner.canRecoverOriginal(pins.originalTupleSha256), false)
  assert.throws(() => requireNativeContinuation(store.read(), pins.targetTupleSha256, pins.targetTupleSha256), unconfirmed)
})

test('a first launch without an exec receipt remains possibly submitted and cannot run again', async () => {
  const root = memoryRoot(), { owner, store } = await guarded(root)
  for (const name of names.slice(0, 7)) await owner.run(name, async () => {})
  let launches = 0
  await assert.rejects(owner.run('start', async () => {
    launches++
    assert.equal(store.read().firstLaunchMayHaveRun, true)
    throw new Error('no exec receipt')
  }), unconfirmed)
  assert.equal(store.read().phase, 'start-intent')
  await assert.rejects(owner.run('start', async () => { launches++ }), unconfirmed)
  assert.equal(launches, 1)
  assert.equal(owner.canRecoverOriginal(pins.originalTupleSha256), false)
})

test('a lost completion record after a successful external action does not repeat the action', async () => {
  const root = memoryRoot(), { owner, store } = await guarded(root)
  let publications = 0
  await assert.rejects(owner.run('publish', async () => {
    publications++
    root.fail('file-sync')
  }), unconfirmed)
  assert.equal(publications, 1)
  assert.equal(store.read().phase, 'publish-intent')
  await assert.rejects(owner.run('publish', async () => { publications++ }), unconfirmed)
  await assert.rejects(owner.run('stop', async () => {}), unconfirmed)
  assert.equal(publications, 1)
})

test('a rejected durable host projection prevents Root-owned external effects', async () => {
  const root = memoryRoot()
  const owner = await NativeDeliveryOwner.reserve(pins, root.store())
  await assert.rejects(owner.guard(async () => { throw new Error('host sync unknown') }), unconfirmed)
  let effects = 0
  await assert.rejects(owner.run('publish', async () => { effects++ }), unconfirmed)
  assert.equal(root.store().read().phase, 'reserved')
  assert.equal(effects, 0)
})

test('all ordinary entry gates reject native projections even after native verification', async () => {
  const root = memoryRoot(), { owner } = await guarded(root)
  for (const name of names) await owner.run(name, async () => {})
  const projection = legacyBarrier(owner.record)
  for (const state of [projection, { ...projection, format: 'pe-cloud-local-update/v1' },
    { format: 'unrecognized', phase: 'verified', recoveredOriginal: true }]) {
    assert.throws(() => requireOrdinaryUpdateState(state), unconfirmed)
    assert.throws(() => requireOrdinaryRollbackState(state), unconfirmed)
    let touched = false
    await assert.rejects(startSavedApplication(state, {
      inspect: async () => { touched = true },
      launch: async () => { touched = true }, save: async () => { touched = true },
    }), unconfirmed)
    assert.equal(touched, false)
  }
  assert.doesNotThrow(() => requireOrdinaryUpdateState(undefined))
  assert.doesNotThrow(() => requireOrdinaryUpdateState({ format: 'pe-cloud-local-update/v1' }))
  // The previously shipped update rejects this exact projection through its own stop/phase predicate.
  assert.equal(projection.stopAttempted && !projection.recoveredOriginal
    && !['verified', 'rolled-back'].includes(projection.phase), true)
  assert.notEqual(projection.format, 'pe-cloud-local-update/v1')
})

test('the normal command keeps original arguments and accepts one explicit first native descriptor', () => {
  const ordinary = ['/bundle', '--account', 'ordinaryUserB']
  assert.deepEqual(nativeArguments('update', ordinary), { args: ordinary })
  assert.deepEqual(nativeArguments('update', ['/bundle', '--native-input', '/private/input.json', '--account', 'ordinaryUserB']),
    { inputFile: '/private/input.json', args: ordinary })
  for (const [mode, args] of [['start', ['--native-input', '/private/input.json']],
    ['rollback', ['--native-input', '/private/input.json']], ['update', ['/bundle', '--native-input']],
    ['update', ['/bundle', '--native-input', '/one', '--native-input', '/two']]]) {
    assert.throws(() => nativeArguments(mode, args))
  }
})

test('native start never becomes an automatic first-launch retry', async () => {
  await assert.rejects(nativeUpdate({ mode: 'start', args: [], latest: { format: stateModule.PROJECTION } }),
    error => unconfirmed(error) && error.phase === 'native-start-requires-owner')
})

test('unknown first descriptor fields are refused before opening a bundle or touching the candidate',
  { skip: typeof process.getuid !== 'function' }, async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pe-native-input-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const inputFile = join(directory, 'input.json')
  fs.writeFileSync(inputFile, JSON.stringify({ format: 'pe-cloud-local-native-asset/v1', arbitraryRootFile: '/no' }), { mode: 0o600 })
  await assert.rejects(nativeUpdate({ mode: 'update', bundle: '/must-not-open', args: [], inputFile,
    latest: { format: 'pe-cloud-local-update/v1', phase: 'verified', manifest: {} } }),
  error => unconfirmed(error) && error.phase === 'native-input-fields')
})

test('Root record ownership, fixed fields and parent identity remain required', async () => {
  for (const change of [{ uid: 2000 }, { mode: 0o777 }]) {
    const root = memoryRoot()
    Object.assign(root.directory, change)
    assert.throws(() => root.store(), unconfirmed)
  }
  const root = memoryRoot(), { owner } = await guarded(root)
  root.directory.ino = 99
  let effects = 0
  await assert.rejects(owner.run('publish', async () => { effects++ }), unconfirmed)
  assert.equal(effects, 0)
})

test('a later call without profile options must retain the actual approved normal/compatible group', async () => {
  const root = memoryRoot(), { owner: initial } = await guarded(root)
  for (const name of names) await initial.run(name, async () => {})
  const previous = initial.record
  const next = { ...pins, kind: 'matching-js', operation: '00000000-0000-4000-8000-000000000002',
    originalTupleSha256: pins.targetTupleSha256,
    targetTupleSha256: pins.compatibleTupleSha256, compatibleTupleSha256: pins.targetTupleSha256 }
  let observed = previous.targetTupleSha256
  const called = [], another = memoryRoot()
  const effects = Object.fromEntries(['checkPair', 'stop', 'backup', 'install', 'start', 'verify'].map(name =>
    [name, async () => { called.push(name); if (name === 'install') observed = next.targetTupleSha256 }]))
  effects.observeTuple = async () => observed
  const record = await runNativeDelivery({ directory: 'not-used-by-injected-host-fixture', pins: next,
    authority: another.store(), previousAuthority: { read: () => previous }, effects,
    writeProjection: async value => value, holdOperation: action => action() })
  assert.equal(record.kind, 'matching-js')
  assert.equal(record.phase, 'verified')
  assert.equal(record.profileMayHaveChanged, false)
  assert.deepEqual(called, ['checkPair', 'stop', 'backup', 'install', 'start', 'verify'])
  observed = '9'.repeat(64)
  await assert.rejects(runNativeDelivery({ pins: next, previousAuthority: { read: () => previous }, effects,
    authority: memoryRoot().store(), holdOperation: action => action() }), unconfirmed)
})

test('the single FD publisher does not overwrite, follow a supplied filename or enlarge the asset limit', () => {
  const root = memoryRoot(), bytes = Buffer.from('fixture-module-bytes')
  const spec = { sha256: createHash('sha256').update(bytes).digest('hex'), sourceSha256: 'a'.repeat(64),
    bytes: bytes.length, maxAssetBytes: bytes.length, maxPathBytes: 256, parentDevice: '1', parentInode: '2' }
  const result = publishFdAsset(9, spec, bytes, root.io)
  assert.equal(result.name, `fd-skill-store-v1-${spec.sha256}.node`)
  assert.equal(result.identity.mode, 0o444)
  assert.equal([...root.files.keys()].length, 2)
  assert.throws(() => publishFdAsset(9, spec, bytes, root.io), /exists/)
  assert.throws(() => publishFdAsset(9, { ...spec, maxAssetBytes: bytes.length - 1 }, bytes, memoryRoot().io), unconfirmed)
  assert.throws(() => publishFdAsset(9, { ...spec, sha256: '0'.repeat(64) }, bytes, memoryRoot().io), unconfirmed)
  assert.throws(() => publishFdAsset(9, { ...spec, maxPathBytes: 1 }, bytes, memoryRoot().io), unconfirmed)
})

test('an installed JS/FD/profile mismatch refuses the first launch even after profile seal', async () => {
  const root = memoryRoot(), called = []
  const effects = Object.fromEntries(names.map(name => [name, async () => { called.push(name) }]))
  effects.observeTuple = async () => called.length < 7 ? pins.originalTupleSha256 : '9'.repeat(64)
  await assert.rejects(runNativeDelivery({ pins, authority: root.store(), effects,
    writeProjection: async value => value, holdOperation: action => action() }), unconfirmed)
  assert.deepEqual(called, names.slice(0, 7))
  assert.equal(root.store().read().phase, 'start-intent')
  assert.equal(root.store().read().firstLaunchMayHaveRun, true)
  assert.equal(called.includes('start'), false)
})

test('the namespace bridge pins current directory and keeper facts and sends only its required fields', async () => {
  const current = { namespaceId: 'mnt:[123]', nodePath: '/dsh-tools/node24',
    seccompPath: '/opt/dsh-feature-assets/app-seccomp.bpf',
    shutdownTimeoutMs: 120000,
    holder: { pid: 42, startTicks: '12345', namespaceId: 'mnt:[123]' }, unrelated: 'not-transferred' }
  const approved = { journal: { path: '/opt/dsh-features/pe-cloud-delivery/' + pins.operation + '/native-record', device: '1', inode: '2' },
    assetParent: { path: '/opt/dsh-feature-assets', device: '1', inode: '3' },
    asset: { sha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), bytes: 10, maxAssetBytes: 10, maxPathBytes: 256,
      parentDevice: '1', parentInode: '3' }, unrelated: 'not-transferred' }
  assert.throws(() => nativeAuthorityCommand({ ...current, holder: { ...current.holder, namespaceId: 'mnt:[456]' } },
    approved, 'not-executed'), unconfirmed)
  assert.throws(() => nativeAuthorityCommand(current,
    { ...approved, journal: { ...approved.journal, path: '/opt/dsh-features/../credentials' } }, 'not-executed'), unconfirmed)
  let received
  const authority = await createNativeAuthority(current, approved, async (command, options) => {
    assert.equal(command[0], '/proc/42/root/dsh-tools/node24')
    assert.equal(command[1], '-e')
    assert.ok(Buffer.byteLength(command[2]) < 131071, 'the fixed Root program must fit one Linux argv string')
    assert.doesNotThrow(() => new Script(command[2]))
    const nested = command[2].match(/context\.nodePath,'-e',("(?:\\.|[^"\\])*")\]/)
    assert.ok(nested, 'the existing namespace entry must contain one fixed Node program')
    assert.doesNotThrow(() => new Script(JSON.parse(nested[1])))
    received = JSON.parse(options.input)
    return JSON.stringify({ fixture: true })
  })
  assert.throws(() => authority.reserve(pins), unconfirmed)
  assert.deepEqual(await authority.reserve({ ...pins, kind: 'matching-js' }), { fixture: true })
  assert.equal(received.method, 'reserve')
  assert.equal(received.context.unrelated, undefined)
  assert.equal(received.approved.unrelated, undefined)
  assert.deepEqual(received.context.holder, current.holder)
})

test('single-profile actions require their own persisted intent before reading or executing anything', () => {
  let touched = false
  const runtime = { io: new Proxy({}, { get() { touched = true; throw new Error('must not read') } }),
    execute: () => { touched = true } }
  const spec = { operation: pins.operation, descriptorSha256: pins.descriptorSha256 }
  for (const method of ['unbind', 'bind', 'seal']) {
    assert.throws(() => profileModule.selectProfile(method, spec, { ...spec, phase: 'installed' }, runtime),
      error => error.code === 'NATIVE_PROFILE_UNCONFIRMED')
  }
  assert.equal(touched, false)
})

test('the approved tuple changes with its JS manifest, FD bytes and actual profile selection', () => {
  const group = { manifest: { files: [{ path: 'apps/cli/lib/bin.js', sha256: 'a'.repeat(64), size: 1, mode: 0o444 }] },
    asset: { path: '/opt/dsh-feature-assets/fd-skill.node', sha256: 'b'.repeat(64), bytes: 1 },
    profile: { source: '/opt/dsh-features/candidate.yml', sha256: 'c'.repeat(64) } }
  const expected = profileModule.tupleSha256(group)
  assert.notEqual(profileModule.tupleSha256({ ...group, manifest: { ...group.manifest, files: [] } }), expected)
  assert.notEqual(profileModule.tupleSha256({ ...group, asset: { ...group.asset, sha256: 'd'.repeat(64) } }), expected)
  assert.notEqual(profileModule.tupleSha256({ ...group, profile: { ...group.profile, source: '/opt/dsh-features/other.yml' } }), expected)
})

function profileInput(text) {
  const bytes = Buffer.from(text), source = '/opt/dsh-features/original-profile.yml'
  const target = '/run/dsh-feature-root/profiles/cloud/cordis.patch.yml'
  const metadata = { dev: 1, ino: 2, uid: 0, gid: 0, mode: 0o444, nlink: 1, size: bytes.length,
    mtimeMs: 1, ctimeMs: 1, isFile: () => true, isSymbolicLink: () => false }
  const io = { constants: fs.constants,
    lstatSync: name => [source, target].includes(name) ? metadata
      : { uid: 0, mode: 0o555, isSymbolicLink: () => false, isDirectory: () => true },
    openSync: () => 9, fstatSync: () => metadata, closeSync: () => {},
    readFileSync: name => typeof name === 'number' ? bytes
      : `1 0 1:1 ${source} ${target} ro,nosuid,nodev,noexec - overlay overlay rw\n` }
  return { io, spec: { operation: pins.operation, maxProfileBytes: 1048576,
    originalHelperPath: '/opt/dsh-feature-assets/fd-abi8.node',
    nextHelperPath: '/opt/dsh-feature-assets/fd-skill-store-v1-' + 'a'.repeat(64) + '.node',
    original: { source, sha256: createHash('sha256').update(bytes).digest('hex'),
      identity: { device: '1', inode: '2', uid: 0, gid: 0, mode: 0o444, nlink: 1 } } } }
}

test('profile preview accepts the public JSON insert schema and retains exact surrounding bytes', () => {
  for (const indent of [undefined, 2, '\t']) for (const ending of ['', '\n', '\r\n']) {
    const patch = [{ insert: [{ id: 'files-root', config: { helperPath: '/opt/dsh-feature-assets/fd-abi8.node',
      retained: ['unchanged', { nested: true }] } }] }]
    const text = JSON.stringify(patch, null, indent) + ending
    const { io, spec } = profileInput(text)
    const preview = profileModule.previewProfile(spec, io)
    const expected = Buffer.from(text.replace(spec.originalHelperPath, spec.nextHelperPath))
    assert.equal(preview.sha256, createHash('sha256').update(expected).digest('hex'))
    assert.equal(preview.bytes, expected.length)
    assert.deepEqual(Object.keys(preview).sort(), ['bytes', 'sha256', 'source'])
  }
})

test('only files-root config helperPath changes when other plugins contain the same paths and JSON escapes', () => {
  const old = '/opt/dsh-feature-assets/fd-abi8.node'
  const next = '/opt/dsh-feature-assets/fd-skill-store-v1-' + 'a'.repeat(64) + '.node'
  const template = JSON.stringify([{ insert: [
    { id: 'other-plugin', config: { helperPath: old, retained: next, text: '前缀🧭' } },
    { id: 'files-root', helperPath: old, config: { helperPath: 'TARGET', nested: { helperPath: old } } },
  ] }], null, 2) + '\n'
  const escaped = JSON.stringify(old).replaceAll('/', '\\u002f')
  const text = template.replace('"TARGET"', escaped), expected = template.replace('"TARGET"', JSON.stringify(next))
  const { io, spec } = profileInput(text)
  const preview = profileModule.previewProfile(spec, io)
  assert.equal(preview.sha256, createHash('sha256').update(expected).digest('hex'))
  assert.equal(preview.bytes, Buffer.byteLength(expected))
})

test('duplicate files-root rows or decoded JSON fields and unsupported selections reject unchanged', () => {
  const helper = '"helperPath":"/opt/dsh-feature-assets/fd-abi8.node"'
  const row = '{"id":"files-root","config":{' + helper + '}}'
  for (const text of [
    '[{"insert":[' + row + ',' + row + ']}]',
    '[{"insert":[' + row + ']},{"insert":[' + row + ']}]',
    '[{"insert":[{"id":"files-root","config":{' + helper + ',' + helper + '}}]}]',
    '[{"insert":[{"id":"files-root","i\\u0064":"files-root","config":{' + helper + '}}]}]',
    '[{"insert":[{"id":"files-root","config":{' + helper + '},"config":{' + helper + '}}]}]',
    '[{"insert":[{"id":"other","config":{' + helper + '}},{"id":"files-root","config":{}}]}]',
    '[{"insert":[{"id":"files-root","config":{"helperPath":{"expression":"no"}}}]}]',
    'helperPath: !!js "/opt/dsh-feature-assets/fd-abi8.node"\n',
  ]) {
    const { io, spec } = profileInput(text)
    assert.throws(() => profileModule.previewProfile(spec, io), error => error.code === 'NATIVE_PROFILE_UNCONFIRMED')
  }
})

test('the original UID2000 writer check still prevents profile mutations', () => {
  const root = '/run/dsh-feature-root', path = value => root + value
  const spec = { operation: pins.operation, descriptorSha256: pins.descriptorSha256,
    target: path('/profiles/cloud/cordis.patch.yml'), maxProfileBytes: 1048576,
    original: { source: '/opt/dsh-features/profile-old.yml', sha256: 'a'.repeat(64) },
    candidate: { source: '/opt/dsh-features/profile-next.yml', sha256: 'b'.repeat(64) },
    protectedInputs: ['/storage-plan.json', '/rootDeployment.json', '/credentials.json', '/profiles/cloud/package.json']
      .map(value => ({ path: path(value), sha256: 'c'.repeat(64) })),
  }
  spec.protectedInputs.push({ path: '/opt/dsh-features/account-base.yml', sha256: 'c'.repeat(64) })
  let commands = 0
  assert.throws(() => profileModule.selectProfile('unbind', spec, { ...pins, phase: 'profile-unbind-intent' }, {
    io: { readdirSync: () => ['123'], readFileSync: () => 'Uid:\t2000\t2000\t2000\t2000\n' },
    execute: () => { commands++ },
  }), error => error.code === 'NATIVE_PROFILE_UNCONFIRMED' && error.phase === 'profile-writer-running')
  assert.equal(commands, 0)
})

test('host projection is read back and an unconfirmed operation keeps the actual ordinary operation lock',
  { skip: typeof process.getuid !== 'function' }, async t => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pe-native-control-'))
    fs.chmodSync(directory, 0o700)
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const { owner } = await guarded(memoryRoot())
    const projection = legacyBarrier(owner.record)
    assert.deepEqual(saveNativeProjection(directory, projection), projection)
    assert.deepEqual(JSON.parse(fs.readFileSync(join(directory, 'latest.json'))), projection)
    let attempts = 0
    await assert.rejects(withNativeOperationLock(directory, pins.operation, async () => {
      attempts++
      throw new Error('selected state unconfirmed')
    }), unconfirmed)
    assert.equal(fs.existsSync(join(directory, 'operation.lock')), true)
    await assert.rejects(withNativeOperationLock(directory, pins.operation, async () => { attempts++ }), unconfirmed)
    assert.equal(attempts, 1)
    assert.deepEqual(JSON.parse(fs.readFileSync(join(directory, 'latest.json'))), projection)
  })

test('unlink followed by directory sync or close failure leaves a real blocker for default entry and continuation',
  { skip: typeof process.getuid !== 'function' }, async t => {
    for (const fault of ['directory-sync', 'directory-close']) {
      const directory = fs.mkdtempSync(join(tmpdir(), 'pe-native-release-'))
      fs.chmodSync(directory, 0o700)
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      const dirs = new Set()
      let unlinked = false, injected = false, actions = 0
      const io = { ...fs,
        openSync(...args) {
          const fd = fs.openSync(...args)
          if (fs.fstatSync(fd).isDirectory()) dirs.add(fd)
          return fd
        },
        unlinkSync(name) {
          fs.unlinkSync(name)
          if (name === join(directory, 'operation.lock')) unlinked = true
        },
        fsyncSync(fd) {
          if (fault === 'directory-sync' && unlinked && dirs.has(fd) && !injected) {
            injected = true
            throw new Error('directory sync failed after unlink')
          }
          return fs.fsyncSync(fd)
        },
        closeSync(fd) {
          const wasDirectory = dirs.delete(fd)
          fs.closeSync(fd)
          if (fault === 'directory-close' && unlinked && wasDirectory && !injected) {
            injected = true
            throw new Error('directory closed but acknowledgement failed after unlink')
          }
        },
      }
      const { owner } = await guarded(memoryRoot())
      for (const name of names) await owner.run(name, async () => {})
      const projection = legacyBarrier(owner.record)
      await assert.rejects(withNativeOperationLock(directory, pins.operation, async () => {
        actions++
        saveNativeProjection(directory, projection)
      }, io), error => unconfirmed(error) && error.phase === 'release-unconfirmed')
      assert.equal(injected, true, fault)
      assert.equal(fs.existsSync(join(directory, 'operation.lock')), false, fault)
      assert.equal(fs.existsSync(join(directory, 'native-release.pending')), true, fault)
      assert.equal(JSON.parse(fs.readFileSync(join(directory, 'latest.json'))).nativePhase, 'verified')
      assert.throws(() => requireNativeReleaseComplete(directory, undefined, pins.operation), unconfirmed)
      await assert.rejects(withNativeOperationLock(directory, pins.operation, async () => { actions++ }), unconfirmed)
      assert.equal(actions, 1, fault)
      assert.equal(fs.existsSync(join(directory, 'operation.lock')), false, fault)
    }
  })

test('confirmed lock cleanup publishes completion last and permits the next normal operation',
  { skip: typeof process.getuid !== 'function' }, async t => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pe-native-release-ok-'))
    fs.chmodSync(directory, 0o700)
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    assert.equal(await withNativeOperationLock(directory, pins.operation, async () => 'verified'), 'verified')
    assert.equal(fs.existsSync(join(directory, 'operation.lock')), false)
    assert.equal(fs.existsSync(join(directory, 'native-release.pending')), false)
    assert.equal(JSON.parse(fs.readFileSync(join(directory, 'native-release-' + pins.operation + '.json'))).operation, pins.operation)
    assert.doesNotThrow(() => requireNativeReleaseComplete(directory))
    assert.doesNotThrow(() => requireNativeReleaseComplete(directory, undefined, pins.operation))
    const next = '00000000-0000-4000-8000-000000000002'
    assert.equal(await withNativeOperationLock(directory, next, async () => 'next'), 'next')
  })
