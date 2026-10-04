/** Real POSIX descriptors, Python and native flock; only lifecycle barriers use synthetic Python wrappers. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { LocalDeviceFiles } from '../src/device/local-files.ts'

const run = promisify(execFile)
const options = { timeout: 15000, skip: !['darwin', 'linux'].includes(process.platform) }
const MAX_BYTES = 2 * 1024 * 1024
const source = new URL('../src/device/local-files.ts', import.meta.url)
const native = import.meta.resolve('@deepseek-ai/node-addon-system/flock')
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

async function until(condition: () => Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 5000
  while (!await condition()) {
    if (Date.now() >= end) throw new Error('Fixture wait expired: ' + label)
    await delay(10)
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pe-device-files-')))
  let files: LocalDeviceFiles | undefined
  const handles: Awaited<ReturnType<typeof open>>[] = []
  t.after(async () => {
    await files?.close()
    await Promise.all(handles.map(handle => handle.close()))
    await rm(base, { recursive: true, force: true })
  })
  const root = join(base, 'authorized'), outside = join(base, 'outside')
  await mkdir(root, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 })
  await mkdir(join(root, 'deep')); await mkdir(join(root, 'deep', 'inner'))
  const { stdout } = await run('python3', ['-I', '-B', '-c', 'import sys;print(sys.executable)'])
  const python = stdout.trim()
  files = new LocalDeviceFiles({ pythonExecutable: python, timeoutMs: 5000 })
  const lockPath = join(base, 'shared.lock')
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  handles.push(lock); await tryLockExclusive(lock.fd)
  const identity = await files.inspect(root)
  const rival = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW)
  handles.push(rival)
  return { base, root, outside, files, lock, rival, lockPath, identity, python }
}

async function gatedPython(base: string, python: string): Promise<{ path: string; ready: string; release: string }> {
  const path = join(base, 'gated-python'), ready = join(base, 'helper-ready'), release = join(base, 'helper-release')
  await writeFile(path, `#!${python}\nimport importlib.util, os, sys, time\nsys.dont_write_bytecode=True\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('qa_local_files',sys.argv[-1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\noriginal=m.safe.file_bytes\ndef gated(fd,name):\n    Path(${JSON.stringify(ready)}).write_text(str(os.getpid()))\n    while not Path(${JSON.stringify(release)}).exists():\n        time.sleep(0.01)\n    return original(fd,name)\nm.safe.file_bytes=gated\nm.main()\n`, { mode: 0o700 })
  return { path, ready, release }
}

async function readyPid(path: string): Promise<number> {
  await until(async () => {
    try { return /^[1-9][0-9]*$/.test(await readFile(path, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }, 'helper reached actual file read')
  return Number(await readFile(path, 'utf8'))
}

async function cloudRequest(python: string, request: object): Promise<unknown> {
  const child = spawn(python, ['-I', '-B', fileURLToPath(new URL('../src/platform/safe-posix.py', import.meta.url))],
    { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', spawnFailed = false, timedOut = false
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', () => { spawnFailed = true })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 5000)
  child.stdin.on('error', () => { /* Exit owns the fixture outcome. */ })
  const done = new Promise<void>((resolve, reject) => child.once('close', (code, signal) => {
    clearTimeout(timer)
    try { assert.equal(spawnFailed, false); assert.equal(timedOut, false); assert.equal(code, 0); assert.equal(signal, null); assert.equal(stderr, ''); resolve() }
    catch (error) { reject(error) }
  }))
  child.stdin.end(JSON.stringify(request)); await done
  return JSON.parse(stdout)
}

test('the shared Cloud helper imports without stdin effects and retains its real CLI read/put refusal behavior', options, async t => {
  const { base, python, outside } = await fixture(t)
  const script = fileURLToPath(new URL('../src/platform/safe-posix.py', import.meta.url))
  const imported = await run(python, ['-I', '-B', '-c',
    "import importlib.util,sys;s=importlib.util.spec_from_file_location('cloud_safe',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print('imported')", script])
  assert.equal(imported.stdout, 'imported\n'); assert.equal(imported.stderr, '')
  const root = join(base, 'cloud'); await mkdir(root)
  const common = { root, workspaceId: 'workspace', parts: ['deep', 'file'] }
  assert.deepEqual(await cloudRequest(python, { ...common, op: 'ensure_workspace' }), { ok: true, value: {} })
  const data = Buffer.from('cloud retained')
  assert.deepEqual(await cloudRequest(python, { ...common, op: 'put', data: data.toString('base64'), digest: digest(data),
    baseRevision: null, priorSameDigest: false }), { ok: true, value: { written: true } })
  assert.deepEqual(await cloudRequest(python, { ...common, op: 'read' }), { ok: true, value: { data: data.toString('base64') } })
  await symlink(outside, join(root, 'workspace', 'link'))
  assert.deepEqual(await cloudRequest(python, { ...common, op: 'read', parts: ['link', 'file'] }), { ok: false, code: 'invalid_path' })
})

test('inspect returns the root BigInt identity while validating an existing relative directory', options, async t => {
  const { files, root, identity } = await fixture(t)
  const expected = await lstat(root, { bigint: true })
  assert.deepEqual(identity, { dev: expected.dev.toString(), ino: expected.ino.toString() })
  assert.deepEqual(await files.inspect(root, 'deep/inner'), identity)
  await assert.rejects(files.inspect(root, 'missing'), { code: 'file_not_found' })
  await writeFile(join(root, 'file'), 'regular')
  await assert.rejects(files.inspect(root, 'file'), { code: 'invalid_path' })
  const alias = join(root, '..', 'root-alias')
  await symlink(root, alias)
  await assert.rejects(files.inspect(alias), { code: 'invalid_path' })
})

test('read and create preserve exact binary bytes, owner-only mode and create-only publication', options, async t => {
  const { files, root, identity, lock, rival } = await fixture(t)
  const bytes = Buffer.from([0, 1, 255, 128, 10])
  await files.create(root, identity, 'deep/inner/binary', bytes.toString('base64'), lock.fd)
  assert.deepEqual(await files.read(root, identity, 'deep/inner/binary', lock.fd),
    { base64: bytes.toString('base64'), sha256: digest(bytes), size: bytes.length })
  assert.deepEqual(await readFile(join(root, 'deep', 'inner', 'binary')), bytes)
  assert.equal((await lstat(join(root, 'deep', 'inner', 'binary'))).mode & 0o777, 0o600)
  await assert.rejects(files.create(root, identity, 'deep/inner/binary', Buffer.from('replacement').toString('base64'), lock.fd),
    { code: 'file_exists' })
  assert.deepEqual(await readFile(join(root, 'deep', 'inner', 'binary')), bytes)
  await writeFile(join(root, 'deep', 'inner', '.pe-existing.tmp'), 'owned elsewhere')
  assert.deepEqual((await readdir(join(root, 'deep', 'inner'))).sort(), ['.pe-existing.tmp', 'binary'])
  await assert.rejects(tryLockExclusive(rival.fd), error => ['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? ''))
})

test('authorized root replacement and deep symbolic links never authorize new or outside bytes', options, async t => {
  const { files, root, outside, identity, lock, base } = await fixture(t)
  await writeFile(join(outside, 'secret'), 'outside')
  await symlink(outside, join(root, 'deep', 'link'))
  for (const action of [() => files.inspect(root, 'deep/link'),
    () => files.read(root, identity, 'deep/link/secret', lock.fd),
    () => files.create(root, identity, 'deep/link/new', 'YQ==', lock.fd)]) {
    await assert.rejects(action(), { code: 'invalid_path' })
  }
  await symlink(join(outside, 'secret'), join(root, 'deep', 'leaf'))
  await assert.rejects(files.read(root, identity, 'deep/leaf', lock.fd), { code: 'invalid_path' })
  await assert.rejects(files.create(root, identity, 'deep/leaf', 'YQ==', lock.fd), { code: 'file_exists' })
  assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'outside')
  await rename(root, join(base, 'old-authorized')); await mkdir(root)
  await writeFile(join(root, 'secret'), 'new root')
  for (const action of [() => files.read(root, identity, 'secret', lock.fd),
    () => files.create(root, identity, 'new', 'YQ==', lock.fd)]) {
    await assert.rejects(action(), { code: 'directory_identity_changed' })
  }
  assert.deepEqual(await readdir(root), ['secret'])
})

test('path escapes, nonregular files and invalid data refuse without publishing a destination', options, async t => {
  const { files, root, identity, lock, python } = await fixture(t)
  for (const relative of ['../escape', '/absolute', 'deep/../../escape', 'deep//file', 'deep/./file', 'nul\0byte', 'back\\slash', '']) {
    await assert.rejects(files.read(root, identity, relative, lock.fd), { code: 'invalid_path' })
    await assert.rejects(files.create(root, identity, relative, 'YQ==', lock.fd), { code: 'invalid_path' })
  }
  await run(python, ['-I', '-B', '-c', 'import os,sys;os.mkfifo(sys.argv[1])', join(root, 'pipe')])
  for (const relative of ['pipe', 'deep']) await assert.rejects(files.read(root, identity, relative, lock.fd), { code: 'invalid_path' })
  for (const base64 of ['!not-base64!', 'YQ', 'YQ==\n', 'YR==']) {
    await assert.rejects(files.create(root, identity, 'invalid', base64, lock.fd), { code: 'invalid_file_data' })
  }
  await assert.rejects(files.read(root, identity, 'missing', lock.fd), { code: 'file_not_found' })
  await assert.rejects(files.create(root, identity, 'missing/file', 'YQ==', lock.fd), { code: 'file_not_found' })
  assert.deepEqual((await readdir(root)).sort(), ['deep', 'pipe'])
})

test('2 MiB transfers succeed at the limit, larger reads and creates reject', options, async t => {
  const { files, root, identity, lock } = await fixture(t)
  const bytes = Buffer.alloc(MAX_BYTES, 0xa7)
  await files.create(root, identity, 'limit', bytes.toString('base64'), lock.fd)
  assert.deepEqual(await files.read(root, identity, 'limit', lock.fd), { base64: bytes.toString('base64'), sha256: digest(bytes), size: MAX_BYTES })
  await writeFile(join(root, 'too-large'), Buffer.alloc(MAX_BYTES + 1))
  await assert.rejects(files.read(root, identity, 'too-large', lock.fd), { code: 'file_too_large' })
  await assert.rejects(files.create(root, identity, 'new-too-large', Buffer.alloc(MAX_BYTES + 1).toString('base64'), lock.fd), { code: 'file_too_large' })
  assert.deepEqual((await readdir(root)).sort(), ['deep', 'limit', 'too-large'])
})

test('missing, nonregular or contended inherited descriptors reject writes', options, async t => {
  const { files, root, identity, base, rival } = await fixture(t)
  await assert.rejects(files.create(root, identity, 'invalid-fd', 'YQ==', -1), { code: 'local_files_lock_required' })
  const directory = await open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await assert.rejects(files.create(root, identity, 'directory-fd', 'YQ==', directory.fd), { code: 'local_files_lock_required' })
    await assert.rejects(files.create(root, identity, 'contended-fd', 'YQ==', rival.fd), { code: 'local_files_lock_required' })
  } finally { await directory.close() }
  const invalid = await open(join(base, 'closed.lock'), 'wx', 0o600), fd = invalid.fd
  await invalid.close()
  await assert.rejects(files.create(root, identity, 'closed-fd', 'YQ==', fd))
  assert.deepEqual(await readdir(root), ['deep'])
})

test('oversized stdin rejects before spawn and oversized stdout kills the owned helper to completion', options, async t => {
  const { files, base, root, identity, lock, python } = await fixture(t)
  await assert.rejects(files.create(root, identity, 'large-input', 'a'.repeat(4 * 1024 * 1024), lock.fd), { code: 'invalid_file_data' })
  const path = join(base, 'noisy-python'), ready = join(base, 'noisy-ready')
  await writeFile(path, `#!${python}\nimport os,time\nfrom pathlib import Path\nPath(${JSON.stringify(ready)}).write_text(str(os.getpid()))\nwhile True:\n    os.write(1,b'x'*65536)\n`, { mode: 0o700 })
  const noisy = new LocalDeviceFiles({ pythonExecutable: path, timeoutMs: 5000 })
  t.after(() => noisy.close())
  const pending = assert.rejects(noisy.inspect(root), { code: 'local_files_unavailable' })
  const pid = await readyPid(ready)
  await pending; assert.equal(alive(pid), false)
  assert.deepEqual(await readdir(root), ['deep'])
})

test('timeout and close kill owned actual helpers and wait for exit without unlocking the caller', options, async t => {
  const { base, root, identity, lock, rival, python } = await fixture(t)
  await writeFile(join(root, 'file'), 'unchanged')
  const wrapper = await gatedPython(base, python)
  // macOS wrapper launch/import was observed above 500 ms; the read barrier must precede its deadline.
  const timed = new LocalDeviceFiles({ pythonExecutable: wrapper.path, timeoutMs: 2000 })
  t.after(() => timed.close())
  const pending = assert.rejects(timed.read(root, identity, 'file', lock.fd), { code: 'local_files_timeout' })
  const pid = await readyPid(wrapper.ready)
  await pending; assert.equal(alive(pid), false)
  await rm(wrapper.ready)
  const closing = new LocalDeviceFiles({ pythonExecutable: wrapper.path, timeoutMs: 5000 })
  t.after(() => closing.close())
  const canceled = assert.rejects(closing.read(root, identity, 'file', lock.fd), { code: 'local_files_closed' })
  const closedPid = await readyPid(wrapper.ready)
  const done = closing.close(); assert.equal(closing.close(), done)
  await done; await canceled; assert.equal(alive(closedPid), false)
  await assert.rejects(closing.inspect(root), { code: 'local_files_closed' })
  await assert.rejects(tryLockExclusive(rival.fd), error => ['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? ''))
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'unchanged')
})

test('a dead Node caller leaves the actual helper holding the shared flock until helper exit', options, async t => {
  const { base, root, identity, lock, rival, lockPath, python } = await fixture(t)
  await lock.close()
  await writeFile(join(root, 'file'), 'read after owner death')
  const before = await lstat(lockPath, { bigint: true })
  const wrapper = await gatedPython(base, python), parent = join(base, 'parent.mjs')
  await writeFile(parent, `import {open} from 'node:fs/promises';\nimport {tryLockExclusive} from ${JSON.stringify(native)};\nimport {LocalDeviceFiles} from ${JSON.stringify(source.href)};\nconst lock=await open(${JSON.stringify(lockPath)},'r+');\nawait tryLockExclusive(lock.fd);\nconst files=new LocalDeviceFiles({pythonExecutable:${JSON.stringify(wrapper.path)},timeoutMs:10000});\nawait files.read(${JSON.stringify(root)},${JSON.stringify(identity)},'file',lock.fd);\nawait files.close();await lock.close();\n`)
  const child = spawn(process.execPath, [parent], { cwd: '/', env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'ignore'] })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
  })
  let helperPid: number | undefined
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    if (helperPid && alive(helperPid)) { process.kill(helperPid, 'SIGKILL'); await until(async () => !alive(helperPid!), 'orphan helper exit') }
  })
  helperPid = await readyPid(wrapper.ready)
  child.kill('SIGKILL'); assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' })
  assert(alive(helperPid))
  await assert.rejects(tryLockExclusive(rival.fd), error => ['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? ''))
  await writeFile(wrapper.release, '')
  await until(async () => !alive(helperPid!), 'actual helper completion')
  await tryLockExclusive(rival.fd)
  const after = await lstat(lockPath, { bigint: true })
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino)
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'read after owner death')
})

test('packaged .src assets resolve beside emitted JS and the helper drains stderr with a scrubbed environment', options, async t => {
  const { files, base, root, identity, lock, python } = await fixture(t)
  const packageRoot = join(base, 'package'), lib = join(packageRoot, 'lib', 'device'), assets = join(packageRoot, '.src')
  await mkdir(lib, { recursive: true }); await mkdir(join(assets, 'device'), { recursive: true }); await mkdir(join(assets, 'platform'))
  await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}')
  await writeFile(join(lib, 'local-files.js'), stripTypeScriptTypes(await readFile(source, 'utf8')))
  await copyFile(new URL('../src/device/local-files.py', import.meta.url), join(assets, 'device', 'local-files.py'))
  await copyFile(new URL('../src/platform/safe-posix.py', import.meta.url), join(assets, 'platform', 'safe-posix.py'))
  const module: typeof import('../src/device/local-files.ts') = await import(pathToFileURL(join(lib, 'local-files.js')).href)
  const packaged = new module.LocalDeviceFiles({ pythonExecutable: python, timeoutMs: 5000 })
  t.after(() => packaged.close())
  assert.deepEqual(await packaged.inspect(root), identity)
  await packaged.create(root, identity, 'packaged', 'AAH/', lock.fd)
  assert.equal((await files.read(root, identity, 'packaged', lock.fd)).base64, 'AAH/')
  const wrapper = join(base, 'env-python')
  await writeFile(wrapper, `#!${python}\nimport os,sys\nassert set(os.environ) <= {'PATH','LANG','LC_ALL','LC_CTYPE'}\nos.write(2,b'x'*262144)\nos.execv(sys.executable,[sys.executable,*sys.argv[1:]])\n`, { mode: 0o700 })
  const scrubbed = new LocalDeviceFiles({ pythonExecutable: wrapper, timeoutMs: 5000 })
  t.after(() => scrubbed.close())
  assert.deepEqual(await scrubbed.inspect(root), identity)
})
