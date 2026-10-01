/** Real descriptor-relative POSIX scans under the local non-root UID; production UID1000/k3s needs separate acceptance. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { fileDownloadPath } from '@power-evolve/contracts/file-download'
import { runnerFileChanges } from '@power-evolve/contracts/execution-files'
import { canonicalFilePath, FileScanner, scanLimits, validFileChanges } from '../../sandbox/file-scan.mjs'

const helper = fileURLToPath(new URL('../../sandbox/file-scan.py', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const nonRoot = { skip: process.getuid?.() === 0 ? 'Native POSIX fixture requires a non-root local UID' : false }
const execute = promisify(execFile)
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-file-scan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const scanner = new FileScanner(root, { ...scanLimits({}), ...overrides }, (file, args, options) => {
    assert.equal(options.uid, 1000); assert.equal(options.gid, 1000); assert.equal(options.cwd, '/')
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'PATH', 'USER'])
    calls.push(options)
    // Only process credentials are substituted; the production Python scanner and filesystem operations are real.
    return spawn(file, args, { ...options, uid: process.getuid(), gid: process.getgid() })
  })
  return { root, scanner, calls }
}

test('scanner canonical paths and fileChanges agree with the shipped wire validators', () => {
  const samples = ['报告/😀.txt', "a ('x')*.txt", 'é.txt', '', '/workspace/a', 'a//b', '../a', 'a/../b', 'a\\b', 'C:a',
    'a\0b', 'a\x7fb', '\ud800', 'e\u0301.txt', 'a'.repeat(100), 'a'.repeat(101), Array(16).fill('a').join('/'), Array(17).fill('a').join('/')]
  for (const path of samples) assert.equal(canonicalFilePath(path), fileDownloadPath.safeParse(path).success)
  const file = { path: '报告/file.txt', sizeBytes: 0, sha256: digest('') }
  for (const value of [{ status: 'complete', files: [file], reasons: [] },
    { status: 'partial', files: [file], reasons: ['read_failed'] }, { status: 'unavailable', files: [], reasons: ['scan_unavailable'] },
    { status: 'complete', files: [], reasons: ['read_failed'] }, { status: 'partial', files: [], reasons: [] },
    { status: 'unavailable', files: [file], reasons: ['scan_unavailable'] }, { status: 'complete', files: [file, file], reasons: [] },
    { status: 'partial', files: [], reasons: ['read_failed', 'read_failed'] },
    { status: 'complete', files: [{ ...file, sizeBytes: 2097153 }], reasons: [] },
    { status: 'partial', files: [], reasons: ['execution_unavailable'] }]) {
    assert.equal(validFileChanges(value), runnerFileChanges.safeParse(value).success)
  }
  assert.throws(() => scanLimits({ PE_RUNNER_SCAN_MAX_FILES: '101' }))
  assert.throws(() => scanLimits({ PE_RUNNER_SCAN_TIMEOUT_MS: '0' }))
  assert.throws(() => scanLimits({ PE_RUNNER_SCAN_MAX_HASH_BYTES: '209715201' }))
  assert.throws(() => scanLimits({ PE_RUNNER_SCAN_MAX_SNAPSHOT_BYTES: '1023' }))
  assert.throws(() => scanLimits({ PE_RUNNER_SCAN_MAX_ENTRIES: '1.5' }))
})

test('new and same-size changed bytes are reported; unchanged, touched and deleted paths are absent', nonRoot, async t => {
  const { root, scanner } = await fixture(t)
  await writeFile(join(root, 'changed.txt'), 'AAAA')
  await writeFile(join(root, 'unchanged.txt'), 'same')
  await writeFile(join(root, 'deleted.txt'), 'removed')
  const before = await scanner.snapshot()
  assert.equal(before.status, 'complete')
  await writeFile(join(root, 'changed.txt'), 'BBBB')
  await utimes(join(root, 'unchanged.txt'), new Date(), new Date())
  await rm(join(root, 'deleted.txt'))
  await mkdir(join(root, '报告'))
  await writeFile(join(root, '报告', '😀.txt'), 'Chinese report')
  await writeFile(join(root, 'empty.bin'), '')
  const changed = runnerFileChanges.parse(await scanner.changes(before))
  assert.equal(changed.status, 'complete')
  assert.deepEqual(changed.files.map(file => file.path), ['changed.txt', 'empty.bin', '报告/😀.txt'])
  assert.deepEqual(changed.files[0], { path: 'changed.txt', sizeBytes: 4, sha256: digest('BBBB') })
  assert.equal(changed.files[1].sha256, digest(''))
})

test('symlinks, hard links, FIFO, excluded directories and oversized files cannot become candidates', nonRoot, async t => {
  const { root, scanner } = await fixture(t)
  const outside = await mkdtemp(join(await realpath(tmpdir()), 'pe-scan-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'secret.txt'), 'outside bytes')
  const before = await scanner.snapshot()
  await symlink(outside, join(root, 'link-dir'))
  await symlink(join(outside, 'secret.txt'), join(root, 'link-file'))
  await link(join(outside, 'secret.txt'), join(root, 'hard-link'))
  await execute('/usr/bin/python3', ['-I', '-B', '-c', 'import os,sys;os.mkfifo(sys.argv[1])', join(root, 'pipe')])
  await mkdir(join(root, '.git')); await writeFile(join(root, '.git', 'config'), 'excluded')
  await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'package.json'), '{}')
  await writeFile(join(root, 'large.bin'), Buffer.alloc(2097153))
  await writeFile(join(root, 'real.bin'), Buffer.from([0, 255, 128]))
  const changed = runnerFileChanges.parse(await scanner.changes(before))
  assert.equal(changed.status, 'partial')
  assert.deepEqual(changed.reasons, ['excluded_paths'])
  assert.deepEqual(changed.files.map(file => file.path), ['real.bin'])
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside bytes')
})

test('an uncovered baseline directory never turns unknown existing or new paths into created candidates', nonRoot, async t => {
  const { root, scanner } = await fixture(t, { maxEntries: 1 })
  await writeFile(join(root, 'first.txt'), 'old')
  await writeFile(join(root, 'second.txt'), 'old')
  const before = await scanner.snapshot()
  assert.equal(before.status, 'partial')
  assert.equal(before.records.find(record => record.path === '').complete, false)
  const covered = before.records.find(record => record.kind === 'file')
  assert.ok(covered)
  await writeFile(join(root, covered.path), 'new')
  await writeFile(join(root, 'new.txt'), 'new path')
  scanner.limits = scanLimits({})
  const changed = await scanner.changes(before)
  assert.equal(changed.status, 'partial')
  assert.deepEqual(changed.files.map(file => file.path), [covered.path])
  assert.ok(changed.reasons.includes('budget_exceeded'))
})

test('unreadable baseline subtrees stay unknown while independently proven file changes survive', nonRoot, async t => {
  const { root, scanner } = await fixture(t)
  await mkdir(join(root, 'blocked'))
  await writeFile(join(root, 'blocked', 'existing.txt'), 'old')
  await writeFile(join(root, 'known.txt'), 'old')
  await chmod(join(root, 'blocked'), 0)
  let before
  try { before = await scanner.snapshot() } finally { await chmod(join(root, 'blocked'), 0o700) }
  assert.ok(before.reasons.includes('read_failed'))
  await writeFile(join(root, 'blocked', 'created.txt'), 'unknown baseline')
  await writeFile(join(root, 'known.txt'), 'new')
  const changed = await scanner.changes(before)
  assert.deepEqual(changed.files.map(file => file.path), ['known.txt'])
  assert.equal(changed.status, 'partial')
})

test('hash, snapshot-output and candidate budgets remain bounded and never invent an unknown baseline digest', nonRoot, async t => {
  const { root, scanner } = await fixture(t, { maxHashBytes: 1 })
  await writeFile(join(root, 'unknown.txt'), 'AA')
  const before = await scanner.snapshot()
  assert.equal(before.records.find(record => record.path === 'unknown.txt').sha256, null)
  await writeFile(join(root, 'unknown.txt'), 'BB')
  scanner.limits = scanLimits({})
  assert.deepEqual((await scanner.changes(before)).files, [])
  await writeFile(join(root, 'unknown.txt'), 'BBB')
  assert.deepEqual((await scanner.changes(before)).files.map(file => file.path), ['unknown.txt'])
  const empty = { version: 1, status: 'complete', records: [{ path: '', kind: 'directory', complete: true }], reasons: [] }
  await writeFile(join(root, 'another.txt'), 'file')
  scanner.limits = { ...scanLimits({}), maxFiles: 1 }
  const limited = await scanner.changes(empty)
  assert.equal(limited.files.length, 1)
  assert.ok(limited.reasons.includes('budget_exceeded'))
  for (let i = 0; i < 12; i++) await writeFile(join(root, `${i}-${'a'.repeat(90)}`), '')
  scanner.limits = { ...scanLimits({}), maxSnapshotBytes: 1024 }
  const bounded = await scanner.snapshot()
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 1024)
  assert.ok(bounded.reasons.includes('budget_exceeded'))
})

test('a real descriptor read followed by a same-size replacement is marked changed_during_scan', nonRoot, async t => {
  const { root } = await fixture(t)
  await writeFile(join(root, 'changing.bin'), Buffer.alloc(65536, 65))
  const script = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('scan',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.os.read;changed=False
def read(fd,n):
 global changed
 result=original(fd,n)
 if result and not changed:
  changed=True
  with open(os.path.join(sys.argv[2],'changing.bin'),'wb') as target:target.write(b'B'*65536)
 return result
m.os.read=read
print(json.dumps(m.Snapshot(json.loads(sys.argv[3])).run(sys.argv[2])))`
  const result = await execute('/usr/bin/python3', ['-I', '-B', '-c', script, helper, root, JSON.stringify(scanLimits({}))])
  const snapshot = JSON.parse(result.stdout)
  assert.equal(snapshot.status, 'partial')
  assert.ok(snapshot.reasons.includes('changed_during_scan'))
  assert.equal(snapshot.records.find(record => record.path === 'changing.bin').kind, 'unknown')
})

test('helper cancellation and its hard deadline await real child termination before returning unavailable', nonRoot, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-scan-await-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let child
  const scanner = new FileScanner(root, { ...scanLimits({}), timeoutMs: 1 }, (_file, _args, options) => {
    child = spawn('/usr/bin/python3', ['-I', '-B', '-c', 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],
      { ...options, uid: process.getuid(), gid: process.getgid() })
    return child
  })
  const abort = new AbortController()
  const snapshot = scanner.snapshot(abort.signal)
  await new Promise(resolve => child.once('spawn', resolve))
  abort.abort()
  assert.equal((await snapshot).status, 'unavailable')
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  const timed = await scanner.snapshot()
  assert.equal(timed.status, 'unavailable')
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('namespace cleanup refuses a local Runner and never enumerates the local execution UID', nonRoot, async t => {
  const { scanner } = await fixture(t)
  assert.equal(await scanner.cleanup(), false)
})

test('namespace cleanup targets escaped same-user writers, excludes itself/root/zombies and fails closed on unreadable proc', nonRoot, async () => {
  const script = `import importlib.util,resource,sys,types
spec=importlib.util.spec_from_file_location('scan',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
resource.setrlimit=lambda *args:None
clock=[0.0];m.time.monotonic=lambda:clock[0];m.time.sleep=lambda seconds:clock.__setitem__(0,clock[0]+seconds)
m.os.getpid=lambda:999
states={1:b'S',999:b'S',101:b'S',102:b'S',103:b'Z'};killed=[]
class Entries:
 def __enter__(self):return iter(types.SimpleNamespace(name=str(pid)) for pid in states)
 def __exit__(self,*args):pass
m.os.scandir=lambda path:Entries()
def read(pid,name):
 if name=='status':return b'Uid: 0 0 0 0' if pid in (1,102) else b'Uid: 1000 1000 1000 1000'
 return str(pid).encode()+b' (escaped) '+states[pid]+b' 1 777 777'
m.read_proc=read
def kill(pid,sig):killed.append(pid);states[pid]=b'Z'
m.os.kill=kill
assert m.kill_namespace_users() is True and killed==[101]
m.read_proc=lambda *args:(_ for _ in ()).throw(PermissionError())
assert m.kill_namespace_users() is False
print('bounded namespace cleanup policy passed; all process data and signals substituted')`
  const result = await execute('/usr/bin/python3', ['-I', '-B', '-c', script, helper])
  assert.match(result.stdout, /namespace cleanup policy passed/u)
})
