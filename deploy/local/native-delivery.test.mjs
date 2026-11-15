/** Fixed controller behavior and persistence faults, without accessing the candidate environment. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import stateModule from './native-delivery-state.cjs'
import { runNativeDelivery, runNativePublishContinuation, saveNativeProjection, withNativeOperationLock,
  withRetainedNativePublishLock, requireNativeReleaseComplete } from './native-delivery.mjs'
import { requireOrdinaryUpdateState, requireOrdinaryRollbackState, startSavedApplication, nativeArguments } from './update.mjs'
import { createNativeAuthority, nativeAuthorityCommand } from './native-authority.mjs'
import profileModule from './native-profile.cjs'
import { nativeUpdate, continueNativePublish, confirmNativePredecessor, deriveNativeSuccessorPair } from './native-update.mjs'
import { writeBundle } from '../bundle.mjs'

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
  assert.deepEqual(await authority.reserve({ ...pins, kind: 'successor-js' }), { fixture: true })
  assert.equal(received.value.kind, 'successor-js')
  assert.equal(received.method, 'reserve')
  assert.equal(received.context.unrelated, undefined)
  assert.equal(received.approved.unrelated, undefined)
  assert.deepEqual(received.context.holder, current.holder)
})

test('the actual Node spawn boundary drops inherited directory capabilities at FD9 and FD10 without a shell',
  { skip: process.platform !== 'linux' }, t => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pe-native-load-fd-'))
    const journal = join(directory, 'journal'), asset = join(directory, 'asset')
    fs.mkdirSync(journal); fs.mkdirSync(asset)
    const fds = [journal, asset].map(name => fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY))
    t.after(() => { for (const fd of fds) fs.closeSync(fd); fs.rmSync(directory, { recursive: true, force: true }) })
    const outer = String.raw`
const assert=require('node:assert/strict'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const profile=require(process.argv[1]),{createHash}=require('node:crypto');
const inherited=[9,10].map(fd=>{const s=fs.fstatSync(fd);assert.equal(s.isDirectory(),true);return {dev:String(s.dev),ino:String(s.ino)}});
const bytes=Buffer.from('public-fixture-bytes'),sha=createHash('sha256').update(bytes).digest('hex');
const stat={dev:1,ino:2,uid:0,gid:0,mode:0o444,nlink:1,size:bytes.length,mtimeMs:1,ctimeMs:1,
 isFile:()=>true,isSymbolicLink:()=>false};
const io={constants:fs.constants,lstatSync:name=>name.endsWith('.node')?stat:
 {uid:0,mode:0o555,isSymbolicLink:()=>false,isDirectory:()=>true},openSync:()=>99,fstatSync:()=>stat,closeSync:()=>{},
 readFileSync:name=>typeof name==='number'?bytes:'1 0 1:1 / / ro - overlay overlay rw\n'};
let calls=0;
const value=profile.loadPublishedAsset({name:'fd-skill-store-v1-'+sha+'.node',sha256:sha,
 identity:{device:'1',inode:'2',bytes:bytes.length}},
 {nodePath:'/dsh-tools/node24',seccompPath:'/opt/dsh-feature-assets/app-seccomp.bpf',shutdownTimeoutMs:120000},
 {io,execute:(command,args,options)=>{
  calls++;assert.equal(command,'/usr/bin/env');assert.equal(args.includes('/bin/sh'),false);
  assert.deepEqual(options.stdio,['ignore','pipe','pipe','ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore']);
  const at=args.indexOf('setpriv');assert.ok(at>0);
  assert.deepEqual(args.slice(at,at+11),['setpriv','--no-new-privs','--bounding-set=-all','--inh-caps=-all',
   '--ambient-caps=-all','--reuid','2000','--regid','2000','--clear-groups','--seccomp-filter']);
  // Exercise the real stdio boundary; target ARM loading and privilege checks remain outside this amd64 fixture.
  const audit="const fs=require('node:fs'),assert=require('node:assert/strict'),blocked=JSON.parse(process.argv[1]);for(const name of fs.readdirSync('/proc/self/fd')){try{const s=fs.fstatSync(Number(name));assert.equal(blocked.some(x=>x.dev===String(s.dev)&&x.ino===String(s.ino)),false)}catch(error){if(!['EBADF','ENOENT'].includes(error.code))throw error}}console.log(JSON.stringify({capabilitiesInherited:false}));";
  const child=spawnSync(command,[...args.slice(0,at),process.execPath,'-e',audit,JSON.stringify(inherited)],options);
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{capabilitiesInherited:false});
  return JSON.stringify({loaded:true,uid:2000,gid:2000,abiVersion:8,inspectSkillStore:true,
   capabilities:'all-zero',noNewPrivileges:true,seccomp:2});
 }});
assert.equal(value.loaded,true);assert.equal(calls,1);console.log('fixed-stdio-boundary-confirmed');`
    const result = spawnSync(process.execPath, ['-e', outer,
      fileURLToPath(new URL('./native-profile.cjs', import.meta.url))], {
      encoding: 'utf8', env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', ...fds],
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /fixed-stdio-boundary-confirmed/)
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


// Real private temporary files with simulated Root ownership and fixed product observations; no target namespace is used.
async function publishContinuationFixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pe-publish-continuation-'))
  fs.chmodSync(directory, 0o700)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stage = '/opt/dsh-features/pe-cloud-delivery/' + pins.operation
  const journal = stage + '/native-record', assetParent = '/opt/dsh-feature-assets'
  const source = '/opt/dsh-features/original-profile.yml'
  const target = '/run/dsh-feature-root/profiles/cloud/cordis.patch.yml'
  const missing = name => Object.assign(new Error('fixture missing'), { code: 'ENOENT', path: name })
  const local = name => join(directory, name.slice(1))
  const put = (name, bytes, mode = 0o444) => {
    fs.mkdirSync(join(local(name), '..'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(local(name), bytes, { mode, flag: 'wx' })
  }
  fs.mkdirSync(local(journal), { recursive: true, mode: 0o700 })
  fs.mkdirSync(local(assetParent), { recursive: true, mode: 0o755 })
  fs.mkdirSync(local(stage + '/rollback/new'), { recursive: true, mode: 0o700 })
  const handles = new Map(), events = [], counts = new Map()
  let next = 100, fault, faultAt = 1, loads = 0, spawnResult, advanceReadbackFault = false
  const normalize = name => {
    const match = name.match(/^\/proc\/self\/fd\/(\d+)(.*)$/)
    if (!match) return name
    const parent = Number(match[1]) === 9 ? journal : Number(match[1]) === 10 ? assetParent : handles.get(Number(match[1])).name
    return join(parent, match[2] || '.')
  }
  const rootStat = (stat, name) => Object.assign(stat, { uid: name.endsWith('/credentials.json') ? 2000 : 0,
    gid: name.endsWith('/credentials.json') ? 2000 : 0 })
  const trigger = event => {
    events.push(event); counts.set(event, (counts.get(event) ?? 0) + 1)
    if (fault === event && --faultAt === 0) { fault = undefined; throw new Error('injected-' + event) }
  }
  let mountinfo = ''
  const io = {
    constants: fs.constants,
    lstatSync(name) { return rootStat(fs.lstatSync(local(normalize(name))), normalize(name)) },
    statSync(name) { return rootStat(fs.statSync(local(normalize(name))), normalize(name)) },
    fstatSync(fd) {
      if (fd === 9 || fd === 10) return rootStat(fs.statSync(local(fd === 9 ? journal : assetParent)), fd === 9 ? journal : assetParent)
      const handle = handles.get(fd); return rootStat(fs.fstatSync(handle.fd), handle.name)
    },
    openSync(name, flags, mode) {
      name = normalize(name); trigger('open:' + name.split('/').at(-1))
      const fd = fs.openSync(local(name), flags, mode), virtual = next++
      handles.set(virtual, { fd, name }); return virtual
    },
    readFileSync(value, encoding) {
      if (value === '/proc/self/mountinfo') return mountinfo
      if (value === '/proc/111/stat') return '111 (fixture) S ' + Array(18).fill('0').join(' ') + ' 12345'
      if (value === '/proc/111/status') return 'Uid:\t2000\t2000\t2000\t2000\nGid:\t2000\t2000\t2000\t2000\n'
      if (value === '/proc/111/cmdline') return '/dsh-tools/node24\0/opt/dsh-installed-products/apps/cli/lib/bin.js\0'
      if (typeof value === 'number') {
        const handle = handles.get(value); trigger('read:' + handle.name.split('/').at(-1))
        return fs.readFileSync(handle.fd, encoding)
      }
      return fs.readFileSync(local(normalize(value)), encoding)
    },
    readlinkSync(name) {
      if (name === '/proc/self/fd/9') return journal
      if (name === '/proc/111/ns/mnt') return 'mnt:[123]'
      if (name === '/proc/111/exe') return '/dsh-tools/node24'
      throw missing(name)
    },
    readdirSync: name => name === '/proc' ? [] : fs.readdirSync(local(normalize(name))),
    writeFileSync(fd, bytes) { const handle = handles.get(fd); trigger('write:' + handle.name.split('/').at(-1)); fs.writeFileSync(handle.fd, bytes) },
    fchownSync() { /* Only ownership metadata is simulated; tests never chown the host. */ },
    fchmodSync(fd, mode) { fs.fchmodSync(handles.get(fd).fd, mode) },
    fsyncSync(fd) {
      const name = fd === 9 ? 'journal' : handles.get(fd).name.split('/').at(-1)
      trigger('sync:' + name)
      if (fd !== 9) fs.fsyncSync(handles.get(fd).fd)
    },
    closeSync(fd) { const handle = handles.get(fd); fs.closeSync(handle.fd); handles.delete(fd); trigger('close:' + handle.name.split('/').at(-1)) },
    renameSync(from, to) {
      trigger('rename:record'); fs.renameSync(local(normalize(from)), local(normalize(to)))
      if (advanceReadbackFault && from.endsWith('/native-fd-3.pending')) { fault = 'read:native-fd.json'; faultAt = 1 }
    },
  }
  const id = name => {
    const stat = io.lstatSync(name)
    return { device: String(stat.dev), inode: String(stat.ino), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, nlink: stat.nlink }
  }
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const oldHelper = assetParent + '/fd-abi8.node', oldBytes = Buffer.from('old helper')
  const bytes = Buffer.from('new immutable fixture module'), assetSha = sha(bytes)
  const name = 'fd-skill-store-v1-' + assetSha + '.node'
  put(oldHelper, oldBytes); put(assetParent + '/' + name, bytes)
  const profileBytes = Buffer.from(JSON.stringify([{ insert: [{ id: 'files-root', config: { helperPath: oldHelper } }] }]) + '\n')
  put(source, profileBytes)
  fs.mkdirSync(join(local(target), '..'), { recursive: true, mode: 0o700 })
  fs.linkSync(local(source), local(target))
  // bind mounts share an inode without increasing nlink. The fixture projects that metadata only.
  const originalLstat = io.lstatSync, originalFstat = io.fstatSync
  io.lstatSync = name => Object.assign(originalLstat(name), { nlink: 1 })
  io.fstatSync = fd => Object.assign(originalFstat(fd), { nlink: 1 })
  const original = { source, sha256: sha(profileBytes), identity: id(source) }
  const protectedInputs = ['/run/dsh-feature-root/storage-plan.json', '/run/dsh-feature-root/rootDeployment.json',
    '/run/dsh-feature-root/credentials.json', '/run/dsh-feature-root/profiles/cloud/package.json', '/opt/dsh-features/account-base.yml']
    .map(path => { const content = Buffer.from('fixed public fixture'); put(path, content, path.endsWith('/credentials.json') ? 0o600 : 0o444)
      return { path, sha256: sha(content), identity: id(path) } })
  mountinfo = [[source, target], ...protectedInputs.filter(row => !row.path.endsWith('account-base.yml')).map(row => [row.path, row.path])]
    .map(([from, to], index) => `${index + 1} 0 1:1 ${from} ${to} ro,nosuid,nodev,noexec - fixture fixture rw`).join('\n') + '\n'
  const spec = { operation: pins.operation, target, original, maxProfileBytes: 1048576, protectedInputs,
    originalHelperPath: oldHelper, nextHelperPath: assetParent + '/' + name }
  spec.candidate = profileModule.previewProfile(spec, io)
  const parentStat = io.fstatSync(10), moduleStat = io.lstatSync(assetParent + '/' + name)
  const asset = { sha256: assetSha, sourceSha256: 'a'.repeat(64), bytes: bytes.length, maxAssetBytes: bytes.length,
    maxPathBytes: 256, parentDevice: String(parentStat.dev), parentInode: String(parentStat.ino) }
  const moduleIdentity = { device: String(moduleStat.dev), inode: String(moduleStat.ino), bytes: bytes.length, mode: 0o444 }
  put(assetParent + '/' + name + '.source.json', JSON.stringify({ format: 'pe-cloud-skill-fd-asset/v1', name,
    sha256: assetSha, bytes: bytes.length, sourceSha256: asset.sourceSha256,
    parent: { device: asset.parentDevice, inode: asset.parentInode }, identity: moduleIdentity }) + '\n', 0o600)
  const oldFiles = [{ path: 'apps/cli/lib/bin.js', size: 3, mode: 0o444, sha256: sha('old') }]
  const nextFiles = [{ path: 'apps/cli/lib/bin.js', size: 3, mode: 0o444, sha256: sha('new') }]
  const manifest = files => ({ files, managedRoots: ['apps/cli/lib'] })
  const groups = [
    { role: 'original', productRoot: '/opt/dsh-installed-products', manifest: manifest(oldFiles),
      asset: { path: oldHelper, sha256: sha(oldBytes), bytes: oldBytes.length, mode: 0o444, maxAssetBytes: 100, maxPathBytes: 256 }, profile: original },
    ...['normal', 'compatible'].map(role => ({ role, productRoot: '/opt/dsh-installed-products', manifest: manifest(nextFiles),
      asset: { path: spec.nextHelperPath, sha256: assetSha, bytes: bytes.length, mode: 0o444, maxAssetBytes: 100, maxPathBytes: 256 }, profile: spec.candidate })),
  ]
  const product = { collectManagedFiles: root => root === '/opt/dsh-installed-products' ? structuredClone(oldFiles) : structuredClone(nextFiles),
    planUpdate: () => ({ changed: ['apps/cli/lib/bin.js'], added: [], removed: [] }) }
  put(stage + '/rollback/rollback.json', JSON.stringify({ format: 'pe-cloud-product-rollback/v1', oldFiles, nextFiles,
    plan: product.planUpdate() }) + '\n', 0o600)
  put(stage + '/rollback/old.tar.gz', 'fixture backup', 0o600)
  const actualPins = { ...pins, originalTupleSha256: profileModule.tupleSha256(groups[0]),
    targetTupleSha256: profileModule.tupleSha256(groups[1]), compatibleTupleSha256: profileModule.tupleSha256(groups[2]) }
  const store = new NativeRecordStore(9, io)
  const owner = await NativeDeliveryOwner.reserve(actualPins, store)
  await owner.guard(async value => value)
  await assert.rejects(owner.run('publish', async () => { throw new Error('original output unknown') }), unconfirmed)
  const expected = store.read()
  const input = { expected, groups, approved: { journal: { path: journal, ...store.identity }, asset,
    assetParent: { path: assetParent, device: asset.parentDevice, inode: asset.parentInode }, profile: spec },
  binding: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), inputSha256: 'c'.repeat(64), programSha256: 'd'.repeat(64),
    line: 'original-line', originalApp: { pid: 111, startTicks: '12345', execId: 'e'.repeat(64) },
    originalProduct: { device: '/dev/fixture', filesystem: 'ext4' } } }
  const current = { namespaceId: 'mnt:[123]', nodePath: '/dsh-tools/node24', seccompPath: '/opt/dsh-feature-assets/app-seccomp.bpf', shutdownTimeoutMs: 120000 }
  const success = { loaded: true, uid: 2000, gid: 2000, abiVersion: 8, inspectSkillStore: true,
    capabilities: 'all-zero', noNewPrivileges: true, seccomp: 2 }
  const run = () => profileModule.continueNativePublish(input, current, store, product, stateModule, { io,
    execute: command => command === 'blockdev' ? '1\n' : JSON.stringify({ filesystems: [{ target: '/opt/dsh-installed-products',
      source: '/dev/fixture', fstype: 'ext4', options: 'ro' }] }),
    spawn: (command, args, options) => {
      loads++; assert.equal(command, '/usr/bin/env'); assert.equal(args.includes('/bin/sh'), false)
      assert.equal(options.stdio[9], 'ignore'); assert.equal(options.stdio[10], 'ignore')
      return spawnResult ?? { status: 0, signal: null, stdout: Buffer.from(JSON.stringify(success)), stderr: Buffer.alloc(0) }
    } })
  return { directory, io, store, input, pins: actualPins, run, local, journal, events, counts,
    loads: () => loads, setSpawn: value => { spawnResult = value },
    fail: (name, at = 1) => { fault = name; faultAt = at },
    failAdvanceReadback: () => { advanceReadbackFault = true },
    receipt: () => JSON.parse(fs.readFileSync(local(journal + '/native-publish-continuation.receipt.json'))),
    candidateExists: () => fs.existsSync(local(spec.candidate.source)),
  }
}

test('the exact original phase2 continues once without reserving, preparing or publishing another asset', async t => {
  const fixture = await publishContinuationFixture(t)
  const source = fixture.input.approved.asset.sha256
  const moduleFile = '/opt/dsh-feature-assets/fd-skill-store-v1-' + source + '.node'
  const before = fs.statSync(fixture.local(moduleFile)), bytes = fs.readFileSync(fixture.local(moduleFile))
  const result = fixture.run()
  assert.equal(result.record.operation, fixture.pins.operation)
  assert.deepEqual(result.record.history, ['reserved', 'guarded', 'publish-intent', 'published'])
  assert.equal(result.record.sequence, 3)
  assert.equal(result.record.firstLaunchMayHaveRun, false)
  assert.equal(fixture.loads(), 1)
  assert.equal(fixture.receipt().previousLoad, 'unknown')
  assert.equal(fixture.receipt().confirmed, true)
  assert.deepEqual(fs.readFileSync(fixture.local(moduleFile)), bytes)
  assert.equal(fs.statSync(fixture.local(moduleFile)).ino, before.ino)
  assert.equal(fixture.events.includes('write:' + moduleFile.split('/').at(-1)), false)
  assert.equal(fixture.events.includes('write:' + moduleFile.split('/').at(-1) + '.source.json'), false)
  assert.throws(fixture.run)
  assert.equal(fixture.loads(), 1)
})

test('every original-record mismatch and an existing candidate refuse before the new load', async t => {
  for (const change of [record => { record.sequence = 3 }, record => { record.history.push('published') },
    record => { record.kind = 'matching-js' }, record => { record.firstLaunchMayHaveRun = true },
    record => { record.descriptorSha256 = 'f'.repeat(64) }, record => { record.directoryIdentity.inode = '999' }]) {
    const fixture = await publishContinuationFixture(t)
    change(fixture.input.expected)
    assert.throws(fixture.run); assert.equal(fixture.loads(), 0); assert.equal(fixture.candidateExists(), false)
  }
  const fixture = await publishContinuationFixture(t)
  fs.writeFileSync(fixture.local(fixture.input.approved.profile.candidate.source), 'already exists')
  assert.throws(fixture.run); assert.equal(fixture.loads(), 0)
})

test('every durable attempt acknowledgement is required and a residual attempt permanently blocks another load', async t => {
  const name = 'native-publish-continuation.intent.json'
  for (const event of ['write:' + name, 'sync:' + name, 'close:' + name, 'sync:journal', 'read:' + name]) {
    const fixture = await publishContinuationFixture(t)
    fixture.fail(event)
    assert.throws(fixture.run, undefined, event); assert.equal(fixture.loads(), 0, event)
    assert.throws(fixture.run); assert.equal(fixture.loads(), 0)
    assert.equal(fixture.store.read().phase, 'publish-intent')
  }
  const fixture = await publishContinuationFixture(t)
  fixture.fail('close:' + name, 2) // Separate read-close acknowledgement after a successful write-close.
  assert.throws(fixture.run); assert.throws(fixture.run); assert.equal(fixture.loads(), 0)
})

test('load exit, signal, missing output, truncation and bad JSON preserve new raw evidence and never advance', async t => {
  for (const result of [
    { status: 7, signal: null, stdout: Buffer.from('partial'), stderr: Buffer.from('actual stderr') },
    { status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.from('signalled') },
    { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
    { status: 0, signal: null, stdout: null, stderr: null },
    { status: null, signal: 'SIGTERM', error: { code: 'ENOBUFS' }, stdout: Buffer.from('cut'), stderr: Buffer.alloc(0) },
    { status: 0, signal: null, stdout: Buffer.from('invalid json'), stderr: Buffer.alloc(0) },
  ]) {
    const fixture = await publishContinuationFixture(t); fixture.setSpawn(result)
    assert.throws(fixture.run); assert.equal(fixture.loads(), 1)
    const receipt = fixture.receipt()
    assert.equal(receipt.confirmed, false); assert.equal(receipt.previousLoad, 'unknown')
    assert.equal(receipt.rawLoad.status, result.status); assert.equal(receipt.rawLoad.signal, result.signal)
    assert.equal(receipt.rawLoad.stderrBase64, result.stderr?.toString('base64') ?? null)
    assert.equal(fixture.store.read().phase, 'publish-intent'); assert.equal(fixture.candidateExists(), false)
    assert.throws(fixture.run); assert.equal(fixture.loads(), 1)
  }
})

test('candidate, receipt and Root advance unknowns do not repeat the successful new load or erase the intent', async t => {
  for (const phase of ['candidate-sync', 'receipt-close', 'advance-close', 'advance-readback']) {
    const fixture = await publishContinuationFixture(t)
    if (phase === 'candidate-sync') fixture.fail('sync:' + fixture.input.approved.profile.candidate.source.split('/').at(-1))
    if (phase === 'receipt-close') fixture.fail('close:native-publish-continuation.receipt.json')
    if (phase === 'advance-close') fixture.fail('close:native-fd-3.pending')
    if (phase === 'advance-readback') fixture.failAdvanceReadback()
    assert.throws(fixture.run, undefined, phase)
    assert.equal(fixture.loads(), 1, phase)
    assert.throws(fixture.run); assert.equal(fixture.loads(), 1)
    assert.equal(fs.existsSync(fixture.local(fixture.journal + '/native-publish-continuation.intent.json')), true)
  }
})

test('a private-state, projection or bridge acknowledgement loss after published never stops or opens phase3 for retry', async t => {
  for (const phase of ['private-input', 'latest', 'bridge-close']) {
    const fixture = await publishContinuationFixture(t), calls = []
    const authority = { read: () => fixture.store.read(), advance: (...args) => fixture.store.advance(...args),
      continuePublish: () => { const value = fixture.run(); if (phase === 'bridge-close') throw new Error('bridge close unknown'); return value } }
    const effects = Object.fromEntries(names.map(name => [name, async () => { calls.push(name) }]))
    effects.observeTuple = async () => fixture.pins.originalTupleSha256
    const request = { pins: fixture.pins, authority, effects, binding: { groups: fixture.input.groups, controller: fixture.input.binding },
      holdOperation: action => action(), persistPublication: async () => { if (phase === 'private-input') throw new Error('private write unknown') },
      writeProjection: async value => { if (phase === 'latest') throw new Error('latest close unknown'); return value } }
    await assert.rejects(runNativePublishContinuation(request))
    assert.deepEqual(calls, []); assert.equal(fixture.store.read().phase, 'published')
    await assert.rejects(runNativePublishContinuation(request), unconfirmed)
    assert.equal(fixture.loads(), 1)
  }
})

test('the continuation uses the original fixed downstream sequence and preserves first-launch responsibility', async t => {
  const fixture = await publishContinuationFixture(t), calls = [], projections = []
  let installed = false, persisted = false
  const authority = { read: () => fixture.store.read(), advance: (...args) => fixture.store.advance(...args), continuePublish: fixture.run }
  const effects = Object.fromEntries(names.map(name => [name, async () => {
    assert.equal(persisted, true); calls.push(name)
    if (name === 'install') installed = true
    if (name === 'start') assert.equal(fixture.store.read().firstLaunchMayHaveRun, true)
  }]))
  effects.observeTuple = async () => installed ? fixture.pins.targetTupleSha256 : fixture.pins.originalTupleSha256
  const result = await runNativePublishContinuation({ pins: fixture.pins, authority, effects,
    binding: { groups: fixture.input.groups, controller: fixture.input.binding }, holdOperation: action => action(),
    persistPublication: async () => { persisted = true }, writeProjection: async value => { projections.push(value); return value } })
  assert.equal(result.phase, 'verified'); assert.deepEqual(calls, names.slice(1)); assert.equal(fixture.loads(), 1)
  assert.equal(projections[0].nativePhase, 'published'); assert.equal(projections.at(-1).nativePhase, 'verified')
})

test('the retained ordinary lock keeps its bytes and inode on unknown and uses the existing release only after verified',
  { skip: typeof process.getuid !== 'function' }, async t => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pe-retained-native-lock-')); fs.chmodSync(directory, 0o700)
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const name = join(directory, 'operation.lock'), bytes = Buffer.from(JSON.stringify({ format: stateModule.PROJECTION, operation: pins.operation }) + '\n')
    fs.writeFileSync(name, bytes, { flag: 'wx', mode: 0o600 }); const inode = fs.statSync(name).ino
    await assert.rejects(withRetainedNativePublishLock(directory, pins.operation, async () => { throw new Error('unknown') }), unconfirmed)
    assert.equal(fs.statSync(name).ino, inode); assert.deepEqual(fs.readFileSync(name), bytes)
    fs.chmodSync(name, 0o644)
    let calls = 0
    await assert.rejects(withRetainedNativePublishLock(directory, pins.operation, async () => { calls++ }), unconfirmed)
    assert.equal(calls, 0); fs.chmodSync(name, 0o600)
    const result = { phase: 'verified', operation: pins.operation }
    assert.deepEqual(await withRetainedNativePublishLock(directory, pins.operation, async () => result), result)
    assert.equal(fs.existsSync(name), false)
    assert.doesNotThrow(() => requireNativeReleaseComplete(directory, undefined, pins.operation))
  })

test('the explicit continuation refuses another operation or a non-phase2 projection before candidate access', async () => {
  for (const latest of [undefined, { format: stateModule.PROJECTION, operation: pins.operation, nativePhase: 'published' },
    { format: stateModule.PROJECTION, operation: '00000000-0000-4000-8000-000000000002', nativePhase: 'publish-intent' }]) {
    await assert.rejects(continueNativePublish({ operation: pins.operation, line: 'original-line', latest }), unconfirmed)
  }
})


test('changed asset source, permissions, prepared bytes or original application refuse with no new load', async t => {
  for (const change of ['asset-bytes', 'asset-source', 'asset-mode', 'prepared-plan', 'app-start', 'old-caller']) {
    const fixture = await publishContinuationFixture(t), approved = fixture.input.approved
    const asset = '/opt/dsh-feature-assets/fd-skill-store-v1-' + approved.asset.sha256 + '.node'
    if (change === 'asset-bytes') fs.writeFileSync(fixture.local(asset), 'changed')
    if (change === 'asset-source') fs.appendFileSync(fixture.local(asset + '.source.json'), 'corrupt')
    if (change === 'asset-mode') fs.chmodSync(fixture.local(asset), 0o640)
    if (change === 'prepared-plan') fs.writeFileSync(fixture.local(fixture.journal + '/../rollback/rollback.json'), '{}')
    if (change === 'app-start') fixture.input.binding.originalApp.startTicks = '54321'
    if (change === 'old-caller') {
      fixture.io.readdirSync = name => name === '/proc' ? ['222'] : ['9']
      fixture.io.statSync = () => fixture.io.fstatSync(9)
    }
    assert.throws(fixture.run, undefined, change); assert.equal(fixture.loads(), 0, change)
    assert.equal(fixture.store.read().phase, 'publish-intent')
  }
})

test('a real exclusive journal file permits only one of two simultaneous intent creators',
  { skip: process.platform !== 'linux' }, async t => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pe-native-intent-race-')); fs.chmodSync(directory, 0o700)
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const io = { ...fs, fstatSync: fd => Object.assign(fs.fstatSync(fd), { uid: 0, gid: 0 }) }
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    const store = new NativeRecordStore(fd, io), owner = await NativeDeliveryOwner.reserve(pins, store)
    await owner.guard(async value => value)
    await assert.rejects(owner.run('publish', async () => { throw new Error('previous output unknown') }), unconfirmed)
    const expected = store.read(); fs.closeSync(fd)
    const program = String.raw`const fs=require('node:fs'),{NativeRecordStore}=require(process.argv[1]);
const directory=process.argv[2],expected=JSON.parse(process.argv[3]);
const io={...fs,fstatSync:fd=>Object.assign(fs.fstatSync(fd),{uid:0,gid:0})};
const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);let accepted=false;
try{new NativeRecordStore(fd,io).publishContinuationFile('intent',expected,{operation:expected.operation});
fs.appendFileSync(directory+'/new-load-marker','one\n');accepted=true}catch(error){if(error.code!=='EEXIST')throw error}
fs.closeSync(fd);console.log(JSON.stringify({accepted}));`
    const launch = () => new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, ['-e', program, fileURLToPath(new URL('./native-delivery-state.cjs', import.meta.url)),
        directory, JSON.stringify(expected)], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } })
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        try { assert.equal(code, 0, stderr); assert.equal(signal, null); resolveRun(JSON.parse(stdout)) }
        catch (error) { reject(error) }
      })
    })
    const results = await Promise.all([launch(), launch()])
    assert.equal(results.filter(value => value.accepted).length, 1)
    assert.equal(fs.readFileSync(join(directory, 'new-load-marker'), 'utf8'), 'one\n')
  })


test('every downstream continuation unknown retains its actual intent and never performs a dependent action', async t => {
  for (const failed of names.slice(1)) {
    const fixture = await publishContinuationFixture(t), calls = []
    let installed = false
    const authority = { read: () => fixture.store.read(), advance: (...args) => fixture.store.advance(...args), continuePublish: fixture.run }
    const effects = Object.fromEntries(names.map(name => [name, async () => {
      calls.push(name); if (name === 'install') installed = true
      if (name === failed) throw new Error('actual outcome unknown')
    }]))
    effects.observeTuple = async () => installed ? fixture.pins.targetTupleSha256 : fixture.pins.originalTupleSha256
    const request = { pins: fixture.pins, authority, effects,
      binding: { groups: fixture.input.groups, controller: fixture.input.binding }, holdOperation: action => action(),
      persistPublication: async () => {}, writeProjection: async value => value }
    await assert.rejects(runNativePublishContinuation(request), unconfirmed)
    assert.deepEqual(calls, names.slice(1, names.indexOf(failed) + 1))
    assert.match(fixture.store.read().phase, /-intent$/)
    if (['start', 'verify'].includes(failed)) assert.equal(fixture.store.read().firstLaunchMayHaveRun, true)
    await assert.rejects(runNativePublishContinuation(request), unconfirmed); assert.equal(fixture.loads(), 1)
  }
})


const jsNames = ['checkPair', 'stop', 'backup', 'install', 'start', 'verify']

async function successorPredecessorFixture() {
  const metadata = { sourceCommit: 'a'.repeat(40), nodeVersion: '24.19.0', pnpmLockHash: 'a'.repeat(64),
    externalDependencyHash: 'b'.repeat(64), researchLockHash: 'c'.repeat(64), dependencyHash: 'd'.repeat(64) }
  const manifest = label => ({ format: 'pe-cloud-update/v1', ...metadata, fixture: label, files: [], managedRoots: [] })
  const identity = { device: '1', inode: '22', uid: 0, gid: 0, mode: 0o444, nlink: 1 }
  const asset = { sha256: 'e'.repeat(64), sourceSha256: 'f'.repeat(64), bytes: 143192,
    maxAssetBytes: 200000, maxPathBytes: 512, parentDevice: '1', parentInode: '3' }
  const profile = { source: '/opt/dsh-features/pe-cloud-delivery/' + pins.operation + '/native-profile.yml',
    sha256: 'a'.repeat(64), bytes: 200, identity }
  const targetAsset = { path: '/opt/dsh-feature-assets/fd-skill-store-v1-' + asset.sha256 + '.node',
    sha256: asset.sha256, bytes: asset.bytes, mode: 0o444, maxAssetBytes: asset.maxAssetBytes, maxPathBytes: asset.maxPathBytes }
  const groups = ['original', 'normal', 'compatible'].map(role => ({ role, productRoot: '/opt/dsh-installed-products',
    manifest: manifest(role), asset: structuredClone(targetAsset), profile: structuredClone(profile) }))
  const context = { namespaceId: 'mnt:[123]', nodePath: '/dsh-tools/node24',
    seccompPath: '/opt/dsh-feature-assets/app-seccomp.bpf', holder: { pid: 42, startTicks: '12345', namespaceId: 'mnt:[123]' } }
  const journal = { path: '/opt/dsh-features/pe-cloud-delivery/' + pins.operation + '/native-record', device: '1', inode: '2' }
  const plan = { format: 'pe-cloud-local-native-asset/v1', assetFile: '/public/asset.node', asset,
    assetParent: { path: '/opt/dsh-feature-assets', device: '1', inode: '3' },
    profile: { target: '/run/dsh-feature-root/profiles/cloud/cordis.patch.yml', maxProfileBytes: 1048576,
      original: { source: '/opt/dsh-features/profile-original.yml', sha256: '9'.repeat(64), identity },
      originalHelperPath: '/opt/dsh-feature-assets/old.node' },
    originalAsset: { path: '/opt/dsh-feature-assets/old.node', sha256: '8'.repeat(64), bytes: 100,
      mode: 0o555, maxAssetBytes: asset.maxAssetBytes, maxPathBytes: asset.maxPathBytes }, compatibleBundle: '/old/compatible' }
  const descriptorSha256 = createHash('sha256').update(JSON.stringify({ groups: groups.map(profileModule.tupleSha256),
    assetSource: asset.sourceSha256, namespaceId: context.namespaceId, holder: context.holder })).digest('hex')
  const first = { ...pins, descriptorSha256, originalTupleSha256: profileModule.tupleSha256(groups[0]),
    targetTupleSha256: profileModule.tupleSha256(groups[1]), compatibleTupleSha256: profileModule.tupleSha256(groups[2]) }
  const root = memoryRoot(), { owner } = await guarded(root, first)
  for (const name of names) await owner.run(name, async () => {})
  const record = owner.record
  const input = { format: 'pe-cloud-local-native-input/v1', operation: pins.operation, plan, groups, descriptorSha256,
    context, approved: { journal, assetParent: plan.assetParent, asset,
      profile: { ...plan.profile, candidate: { source: profile.source, sha256: profile.sha256, identity } } },
    state: { operation: pins.operation, nativeJournal: journal } }
  const current = { ...context, canStopSafely: true, productReadOnly: true, productBlockReadOnly: true }
  const authority = { read: () => root.store().read(), observeTuple: async () => record.targetTupleSha256 }
  return { input, current, root, record, latest: legacyBarrier(record), authority, metadata,
    previous: { record, installed: groups[1] },
    controller: { commit: '3'.repeat(40), tree: '4'.repeat(40), programSha256: '5'.repeat(64) } }
}

async function successorBundleFixture(t, fixture) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pe-successor-bundles-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bundles = []
  for (const label of ['normal', 'compatible']) {
    const source = join(directory, label + '-source'), bundle = join(directory, label + '-bundle')
    fs.mkdirSync(join(source, 'apps/web/dist'), { recursive: true })
    fs.writeFileSync(join(source, 'apps/web/dist/index.html'), 'new actual archive ' + label, { mode: 0o644 })
    await writeBundle(source, ['apps/web/dist/index.html'], { ...fixture.metadata,
      sourceCommit: (label === 'normal' ? '1' : '2').repeat(40) }, bundle)
    bundles.push(bundle)
  }
  const successor = { format: 'pe-cloud-local-native-successor/v1', predecessor: {
    operation: fixture.record.operation, descriptorSha256: fixture.record.descriptorSha256,
    targetTupleSha256: fixture.record.targetTupleSha256 }, compatibleBundle: bundles[1] }
  const derive = () => deriveNativeSuccessorPair({ previousInput: fixture.input, previous: fixture.previous,
    successor, normalBundle: bundles[0], controller: fixture.controller })
  return { bundles, successor, derive }
}

function successorPins(derived) {
  return { kind: 'successor-js', operation: '00000000-0000-4000-8000-000000000002',
    descriptorSha256: derived.descriptorSha256, originalTupleSha256: derived.pairBinding.groups[0],
    targetTupleSha256: derived.pairBinding.groups[1], compatibleTupleSha256: derived.pairBinding.groups[2] }
}

test('the explicit successor input is mutually exclusive and never reopens first delivery or start', async () => {
  assert.deepEqual(nativeArguments('update', ['/bundle', '--native-successor', '/private/next.json', '--account', 'ordinaryUserB']),
    { successorFile: '/private/next.json', args: ['/bundle', '--account', 'ordinaryUserB'] })
  for (const [mode, args] of [['update', ['/bundle', '--native-input', '/one', '--native-successor', '/two']],
    ['update', ['/bundle', '--native-successor', '/one', '--native-successor', '/two']],
    ['update', ['/bundle', '--native-successor']], ['rollback', ['--native-successor', '/one']],
    ['start', ['--native-successor', '/one']], ['continue-native-publish', ['op', '--native-successor', '/one']]]) {
    assert.throws(() => nativeArguments(mode, args))
  }
  for (const request of [{ mode: 'rollback', latest: { format: stateModule.PROJECTION } },
    { mode: 'update', latest: { format: 'pe-cloud-local-update/v1' } },
    { mode: 'update', latest: { format: stateModule.PROJECTION }, inputFile: '/must-not-open' }]) {
    await assert.rejects(nativeUpdate({ bundle: '/must-not-open', args: [], successorFile: '/must-not-open', ...request }),
      error => unconfirmed(error) && error.phase === 'successor-entry')
  }
  await assert.rejects(nativeUpdate({ mode: 'update', bundle: '/must-not-open', args: [], inputFile: '/must-not-open',
    latest: { format: stateModule.PROJECTION } }), error => unconfirmed(error) && error.phase === 'native-group-already-owned')
})

test('fresh predecessor confirmation requires exact Root, projection, saved descriptor, namespace and installed FD/profile', async t => {
  const fixture = await successorPredecessorFixture()
  const confirm = overrides => confirmNativePredecessor({ ...fixture, ...overrides })
  assert.deepEqual(await confirm(), fixture.previous)
  for (const [name, change] of [
    ['projection phase', value => { value.latest.nativePhase = 'started' }],
    ['projection directory', value => { value.latest.nativeAuthority.directoryIdentity.inode = '999' }],
    ['namespace holder', value => { value.current.holder.startTicks = '999' }],
    ['writable product', value => { value.current.productReadOnly = false }],
    ['private descriptor', value => { value.input.descriptorSha256 = '9'.repeat(64) }],
    ['pair manifest', value => { value.input.groups[2].manifest.fixture = 'unapproved' }],
    ['FD metadata', value => { value.input.approved.asset.bytes++ }],
    ['sealed profile identity', value => { value.input.approved.profile.candidate.identity.inode = '999' }],
  ]) await t.test(name, async () => {
    const value = { latest: structuredClone(fixture.latest), input: structuredClone(fixture.input),
      current: structuredClone(fixture.current), authority: fixture.authority }
    change(value)
    await assert.rejects(confirmNativePredecessor(value), unconfirmed)
    assert.deepEqual(fixture.root.store().read(), fixture.record)
  })
  await assert.rejects(confirm({ authority: { ...fixture.authority, observeTuple: async () => '9'.repeat(64) } }), unconfirmed)
  const pendingRoot = memoryRoot(), pending = await guarded(pendingRoot)
  await assert.rejects(confirm({ latest: legacyBarrier(pending.owner.record),
    authority: { read: () => pending.owner.record, observeTuple: async () => pending.owner.record.targetTupleSha256 } }), unconfirmed)
})

test('two real archives alone derive the successor pair and its complete predecessor binding', async t => {
  const fixture = await successorPredecessorFixture(), bundles = await successorBundleFixture(t, fixture)
  const before = structuredClone(fixture.input), derived = await bundles.derive()
  assert.equal(derived.groups.length, 3)
  assert.deepEqual(derived.pairBinding.predecessor, fixture.record)
  assert.deepEqual(derived.pairBinding.release, { format: 'pe-cloud-native-release/v1', operation: fixture.record.operation })
  assert.deepEqual(derived.groups.map(group => group.manifest.sourceCommit),
    [fixture.input.groups[1].manifest.sourceCommit, '1'.repeat(40), '2'.repeat(40)])
  assert.equal(derived.groups[1].manifest.files.length, 1)
  for (const group of derived.groups) {
    assert.deepEqual(group.asset, fixture.previous.installed.asset)
    assert.deepEqual(group.profile, fixture.previous.installed.profile)
  }
  assert.equal(derived.descriptorSha256, stateModule.nativeSuccessorDescriptor(derived.pairBinding))
  assert.notEqual(derived.descriptorSha256, fixture.record.descriptorSha256)
  assert.deepEqual(fixture.input, before)
  for (const change of [input => { input.allowedGroups = [] }, input => { input.predecessor.operation = pins.operation.replace(/1$/, '9') },
    input => { input.predecessor.descriptorSha256 = '9'.repeat(64) }, input => { input.predecessor.targetTupleSha256 = '9'.repeat(64) }]) {
    const successor = structuredClone(bundles.successor); change(successor)
    await assert.rejects(deriveNativeSuccessorPair({ previousInput: fixture.input, previous: fixture.previous,
      successor, normalBundle: '/must-not-open', controller: fixture.controller }), unconfirmed)
  }
  for (const key of ['externalDependencyHash', 'researchLockHash']) {
    const filename = join(bundles.bundles[1], 'manifest.json'), original = fs.readFileSync(filename)
    const manifest = JSON.parse(original); manifest[key] = '9'.repeat(64)
    fs.writeFileSync(filename, JSON.stringify(manifest))
    await assert.rejects(bundles.derive(), error => unconfirmed(error) && error.phase === 'native-reader-dependencies')
    fs.writeFileSync(filename, original)
  }
  const duplicateManifest = join(bundles.bundles[1], 'manifest.json')
  const duplicateArchive = join(bundles.bundles[1], 'products.tar.gz')
  const savedManifest = fs.readFileSync(duplicateManifest), savedArchive = fs.readFileSync(duplicateArchive)
  const sameProducts = JSON.parse(fs.readFileSync(join(bundles.bundles[0], 'manifest.json')))
  sameProducts.sourceCommit = '2'.repeat(40)
  fs.writeFileSync(duplicateManifest, JSON.stringify(sameProducts))
  fs.copyFileSync(join(bundles.bundles[0], 'products.tar.gz'), duplicateArchive)
  await assert.rejects(bundles.derive(), error => unconfirmed(error) && error.phase === 'ambiguous-successor-readers')
  fs.writeFileSync(duplicateManifest, savedManifest); fs.writeFileSync(duplicateArchive, savedArchive)
  const filename = join(bundles.bundles[1], 'manifest.json'), original = fs.readFileSync(filename)
  const broken = JSON.parse(original); broken.files[0].sha256 = '0'.repeat(64)
  fs.writeFileSync(filename, JSON.stringify(broken))
  await assert.rejects(bundles.derive(), /归档文件与清单不一致/)
  fs.writeFileSync(filename, original)
  fs.writeFileSync(join(bundles.bundles[0], 'products.tar.gz'), 'not an archive')
  await assert.rejects(bundles.derive())
})

test('the successor gets a new Root responsibility and permits only its exact compatible pair thereafter', async t => {
  const fixture = await successorPredecessorFixture(), bundles = await successorBundleFixture(t, fixture)
  const derived = await bundles.derive(), next = successorPins(derived), called = [], projections = []
  const oldBytes = Buffer.from([...fixture.root.files.values()][0].bytes)
  let observed = next.originalTupleSha256, confirmations = 0
  const effects = Object.fromEntries(jsNames.map(name => [name, async () => {
    called.push(name); if (name === 'install') observed = next.targetTupleSha256
  }]))
  effects.observeTuple = async () => observed
  let record = await runNativeDelivery({ pins: next, successor: derived.pairBinding, authority: memoryRoot().store(), effects,
    confirmPredecessor: async () => { confirmations++; return (await confirmNativePredecessor(fixture)).record },
    writeProjection: async value => { projections.push(value); return value }, holdOperation: action => action() })
  assert.equal(confirmations, 1)
  assert.equal(record.kind, 'successor-js'); assert.equal(record.phase, 'verified')
  assert.equal(record.profileMayHaveChanged, false)
  assert.equal(record.firstLaunchMayHaveRun, true)
  assert.deepEqual(called, jsNames)
  assert.equal(projections[0].nativePhase, 'reserved')
  assert.equal(projections.at(-1).nativePhase, 'verified')
  assert.throws(() => requireOrdinaryUpdateState(projections.at(-1)), unconfirmed)
  assert.deepEqual(fixture.root.store().read(), fixture.record)
  assert.deepEqual([...fixture.root.files.values()][0].bytes, oldBytes)
  const newInput = { ...structuredClone(fixture.input), operation: record.operation, groups: derived.groups,
    descriptorSha256: derived.descriptorSha256, pairBinding: derived.pairBinding }
  newInput.state.operation = record.operation
  newInput.approved.journal.path = '/opt/dsh-features/pe-cloud-delivery/' + record.operation + '/native-record'
  newInput.state.nativeJournal = newInput.approved.journal
  assert.deepEqual((await confirmNativePredecessor({ latest: legacyBarrier(record), input: newInput,
    current: fixture.current, authority: { read: () => record, observeTuple: async () => observed } })).record, record)
  for (const [operation, target, compatible] of [
    ['00000000-0000-4000-8000-000000000003', next.compatibleTupleSha256, next.targetTupleSha256],
    ['00000000-0000-4000-8000-000000000004', next.targetTupleSha256, next.compatibleTupleSha256],
  ]) {
    const previous = record, selected = { ...next, kind: 'matching-js', operation,
      originalTupleSha256: record.targetTupleSha256, targetTupleSha256: target, compatibleTupleSha256: compatible }
    effects.install = async () => { observed = target }
    record = await runNativeDelivery({ pins: selected, authority: memoryRoot().store(), previousAuthority: { read: () => previous },
      effects, writeProjection: async value => value, holdOperation: action => action() })
    assert.equal(record.targetTupleSha256, target); assert.equal(record.phase, 'verified')
    assert.equal(record.descriptorSha256, next.descriptorSha256)
  }
  assert.throws(() => requireNativeContinuation(record, observed, fixture.record.targetTupleSha256), unconfirmed)
})

test('a different pair cannot use legacy matching and a changed predecessor cannot reserve successor ownership', async t => {
  const fixture = await successorPredecessorFixture(), bundles = await successorBundleFixture(t, fixture)
  const derived = await bundles.derive(), next = successorPins(derived)
  for (const variant of ['legacy', 'actual tuple', 'predecessor', 'descriptor', 'FD', 'profile', 'missing fresh check']) {
    let reserves = 0, actions = 0
    const root = memoryRoot(), store = root.store(), successor = structuredClone(derived.pairBinding)
    const request = { pins: { ...next }, successor,
      authority: { reserve: (...args) => { reserves++; return store.reserve(...args) } },
      previousAuthority: fixture.authority, confirmPredecessor: async () => fixture.record,
      effects: { ...Object.fromEntries(jsNames.map(name => [name, async () => { actions++ }])),
        observeTuple: async () => next.originalTupleSha256 },
      writeProjection: async value => value, holdOperation: action => action() }
    if (variant === 'legacy') request.pins.kind = 'matching-js'
    if (variant === 'actual tuple') request.effects.observeTuple = async () => '9'.repeat(64)
    if (variant === 'predecessor') successor.predecessor.directoryIdentity.inode = '999'
    if (variant === 'descriptor') request.pins.descriptorSha256 = '9'.repeat(64)
    if (variant === 'FD') successor.asset.sha256 = '9'.repeat(64)
    if (variant === 'profile') successor.profile.identity.inode = '999'
    if (variant === 'missing fresh check') delete request.confirmPredecessor
    await assert.rejects(runNativeDelivery(request), unconfirmed, variant)
    assert.equal(reserves, 0, variant); assert.equal(actions, 0, variant)
    assert.deepEqual(fixture.root.store().read(), fixture.record)
  }
})

test('every successor JS unknown retains the real host lock, blocking projection and exact Root intent',
  { skip: typeof process.getuid !== 'function' }, async t => {
  const fixture = await successorPredecessorFixture(), bundles = await successorBundleFixture(t, fixture)
  const derived = await bundles.derive(), next = successorPins(derived)
  const expected = ['check-pair-intent', 'stop-intent', 'backup-intent', 'install-intent', 'start-intent', 'verify-intent']
  for (const [index, fault] of jsNames.entries()) await t.test(fault, async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pe-successor-unknown-')); fs.chmodSync(directory, 0o700)
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const root = memoryRoot(), called = []
    let observed = next.originalTupleSha256
    const effects = { observeTuple: async () => observed }
    for (const name of jsNames) effects[name] = async () => {
      called.push(name)
      if (name === 'install') observed = next.targetTupleSha256
      if (name === fault) throw new Error('effect outcome lost')
    }
    await assert.rejects(runNativeDelivery({ directory, pins: next, successor: derived.pairBinding,
      authority: root.store(), effects, confirmPredecessor: async () => fixture.record }), unconfirmed)
    assert.deepEqual(called, jsNames.slice(0, index + 1))
    assert.equal(root.store().read().phase, expected[index])
    assert.equal(root.store().read().firstLaunchMayHaveRun, index >= 4)
    assert.equal(JSON.parse(fs.readFileSync(join(directory, 'latest.json'))).nativePhase, expected[index])
    assert.equal(fs.existsSync(join(directory, 'operation.lock')), true)
    assert.equal(fs.existsSync(join(directory, 'native-release-' + next.operation + '.json')), false)
    await assert.rejects(withNativeOperationLock(directory, next.operation, async () => { called.push('retry') }), unconfirmed)
    assert.equal(called.includes('retry'), false)
  })
})

test('the successor protocol uses a real Linux journal FD and contains a close acknowledgement loss before guarded confirmation',
  { skip: process.platform !== 'linux' }, async t => {
  const fixture = await successorPredecessorFixture(), bundles = await successorBundleFixture(t, fixture)
  const next = successorPins(await bundles.derive())
  const directory = fs.mkdtempSync(join(tmpdir(), 'pe-successor-fd-')), journal = join(directory, 'journal')
  fs.chmodSync(directory, 0o700); fs.mkdirSync(journal, { mode: 0o700 })
  const fd = fs.openSync(journal, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  t.after(() => { fs.closeSync(fd); fs.rmSync(directory, { recursive: true, force: true }) })
  // Ownership is simulated for non-root test runners; opens, file/directory syncs, rename and close are actual Linux I/O.
  let inject = false, writes = 0
  const writing = new Set()
  const io = { ...fs, fstatSync(handle) { return Object.assign(fs.fstatSync(handle), { uid: 0, gid: 0 }) },
    openSync(...args) { const handle = fs.openSync(...args); if (args[1] === 'wx') writing.add(handle); return handle },
    closeSync(handle) {
      const wasWriting = writing.delete(handle)
      fs.closeSync(handle)
      if (inject && wasWriting) { inject = false; throw new Error('closed, acknowledgement lost') }
    } }
  const store = new NativeRecordStore(fd, io)
  const owner = await NativeDeliveryOwner.reserve(next, store)
  assert.equal(store.read().kind, 'successor-js')
  await assert.rejects(withNativeOperationLock(directory, next.operation, async () => {
    inject = true
    await owner.guard(async value => { writes++; return saveNativeProjection(directory, value) })
  }), unconfirmed)
  assert.equal(owner.unknown, true)
  assert.equal(writes, 1)
  assert.equal(JSON.parse(fs.readFileSync(join(journal, 'native-fd.json'))).phase, 'reserved')
  assert.equal(fs.existsSync(join(journal, 'native-fd-1.pending')), true)
  assert.equal(fs.existsSync(join(directory, 'operation.lock')), true)
  let actions = 0
  await assert.rejects(owner.run('checkPair', async () => { actions++ }), unconfirmed)
  assert.equal(actions, 0)
})

test('a verified successor publishes the normal release receipt and preserves the completed predecessor files',
  { skip: typeof process.getuid !== 'function' }, async t => {
  const fixture = await successorPredecessorFixture(), bundles = await successorBundleFixture(t, fixture)
  const derived = await bundles.derive(), next = successorPins(derived)
  const directory = fs.mkdtempSync(join(tmpdir(), 'pe-successor-release-')); fs.chmodSync(directory, 0o700)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  await withNativeOperationLock(directory, fixture.record.operation, async () => fixture.record)
  const receipt = join(directory, 'native-release-' + fixture.record.operation + '.json')
  const originalReceipt = fs.readFileSync(receipt)
  saveNativeProjection(directory, fixture.latest)
  let observed = next.originalTupleSha256
  const effects = { ...Object.fromEntries(jsNames.map(name => [name, async () => {}])), observeTuple: async () => observed }
  effects.install = async () => { observed = next.targetTupleSha256 }
  const record = await runNativeDelivery({ directory, pins: next, successor: derived.pairBinding,
    authority: memoryRoot().store(), effects, confirmPredecessor: async () => {
      requireNativeReleaseComplete(directory, undefined, fixture.record.operation)
      return fixture.record
    } })
  assert.equal(record.phase, 'verified')
  assert.deepEqual(fs.readFileSync(receipt), originalReceipt)
  assert.deepEqual(JSON.parse(fs.readFileSync(join(directory, 'latest.json'))), legacyBarrier(record))
  assert.equal(fs.existsSync(join(directory, 'operation.lock')), false)
  assert.equal(fs.existsSync(join(directory, 'native-release.pending')), false)
  assert.doesNotThrow(() => requireNativeReleaseComplete(directory, undefined, record.operation))
  assert.deepEqual(fixture.root.store().read(), fixture.record)
})
