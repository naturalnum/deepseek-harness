import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { captureRecoveryRoot, confirmRecoveryCarrierLifecycle, rebuildRecoveryRoot, writeRecoveryRoot } from './recovery-root.mjs'
import { RECOVERY_ROOT_FILES } from './recovery-config.mjs'

test('carrier admission permits an inode number reused after original lifecycles end, while an app restart or live original holder refuses', () => {
  const carrier = { pid: 1, startTicks: '10', namespaceId: 'mnt:[100]' }
  const application = { pid: 20, startTicks: '11', namespaceId: 'mnt:[200]' }
  const keeper = { pid: 21, startTicks: '12', namespaceId: 'mnt:[200]' }
  const previous = { carrier, application, namespaceReferences: [application, keeper] }
  const current = { carrier: { ...carrier, startTicks: '20' }, references: [null, { ...keeper, startTicks: '22' }] }
  assert.equal(confirmRecoveryCarrierLifecycle(previous, current).namespaceNumberReused, true)
  assert.equal(confirmRecoveryCarrierLifecycle(previous, current).originalReferenceLifecyclesEnded, 2)
  assert.throws(() => confirmRecoveryCarrierLifecycle(previous, { ...current, carrier }))
  assert.throws(() => confirmRecoveryCarrierLifecycle(previous, { ...current, references: [null, keeper] }))
  assert.throws(() => confirmRecoveryCarrierLifecycle(previous, { ...current, references: [null, { ...keeper, namespaceId: 'mnt:[300]' }] }))
  assert.throws(() => confirmRecoveryCarrierLifecycle({ ...previous, namespaceReferences: [] }, current))
})

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'recovery-root-'))
  t.after(() => fs.rm(directory, { recursive: true }))
  await fs.chmod(directory, 0o700)
  await fs.mkdir(join(directory, 'profiles/cloud'), { recursive: true })
  const files = RECOVERY_ROOT_FILES.map((name, index) => ({ name, path: join(directory, name),
    bytes: index === 5 ? Buffer.alloc(0) : Buffer.from('\uFEFFsynthetic-only-' + index + '\r\n') }))
  for (const row of files) await fs.writeFile(row.path, row.bytes, { flag: 'wx', mode: 0o600 })
  return { directory, files }
}

test('six-file capture observes actual permissions and retains original bytes including an empty mutable profile', async t => {
  const f = await fixture(t), before = await Promise.all(f.files.map(row => fs.lstat(row.path)))
  const captured = await captureRecoveryRoot(f.directory)
  assert.deepEqual(Object.values(captured.files), f.files.map(row => row.bytes))
  assert.deepEqual(captured.originalPaths, f.files.map(row => row.path))
  assert.deepEqual(Object.keys(captured.fileMetadata), RECOVERY_ROOT_FILES)
  assert.deepEqual(captured.moduleLink, { kind: 'absent' })
  const after = await Promise.all(f.files.map(row => fs.lstat(row.path)))
  for (let index = 0; index < f.files.length; index++) {
    assert.deepEqual(captured.fileMetadata[f.files[index].name], { uid: before[index].uid, gid: before[index].gid,
      mode: (before[index].mode & 0o7777).toString(8).padStart(4, '0') })
    for (const key of ['ino', 'dev', 'mtimeMs', 'ctimeMs', 'size']) assert.equal(after[index][key], before[index][key])
  }
})

test('the observed module link and its ownership survive a side backup, while a different target refuses before any file write', async t => {
  const f = await fixture(t), relative = 'profiles/cloud/node_modules', target = '/opt/dsh-installed-products/node_modules'
  await fs.symlink(target, join(f.directory, relative))
  const before = await fs.lstat(join(f.directory, relative)), captured = await captureRecoveryRoot(f.directory)
  assert.deepEqual(captured.moduleLink, { kind: 'link', target, uid: before.uid, gid: before.gid })
  const prepared = { files: f.files.map((row, index) => ({ relativePath: row.name,
    bytes: Object.values(captured.files)[index], ...captured.fileMetadata[row.name] })) }
  const backup = join(f.directory, 'backup')
  await fs.mkdir(join(backup, 'profiles/cloud'), { recursive: true })
  await writeRecoveryRoot(captured, prepared, backup)
  assert.equal(await fs.readlink(join(backup, relative)), target)
  const restored = await captureRecoveryRoot(backup)
  assert.deepEqual(restored.moduleLink, captured.moduleLink)
  assert.deepEqual(restored.files, captured.files)
  assert.equal((await writeRecoveryRoot(captured, prepared, backup)).every(row => row.action === 'skip'), true)

  const conflict = join(f.directory, 'conflict')
  await fs.mkdir(join(conflict, 'profiles/cloud'), { recursive: true })
  await fs.symlink('/foreign/node_modules', join(conflict, relative))
  await assert.rejects(writeRecoveryRoot(captured, prepared, conflict), /来源或读取期间/)
  assert.deepEqual(await fs.readdir(conflict), ['profiles'])
  assert.equal(await fs.readlink(join(conflict, relative)), '/foreign/node_modules')
  await fs.unlink(join(f.directory, relative))
  await fs.mkdir(join(f.directory, relative))
  await assert.rejects(captureRecoveryRoot(f.directory), /来源或读取期间/)
})

test('a private source symlink or missing credential file refuses without normalizing any source', async t => {
  const f = await fixture(t), credential = f.files[3]
  await fs.rename(credential.path, credential.path + '.original')
  await fs.symlink(credential.path + '.original', credential.path)
  await assert.rejects(captureRecoveryRoot(f.directory), /来源或读取期间/)
  await fs.unlink(credential.path)
  await assert.rejects(captureRecoveryRoot(f.directory), /来源或读取期间/)
  assert.deepEqual(await fs.readFile(credential.path + '.original'), credential.bytes)
})

test('a filesystem that silently ignores requested ownership cannot report a saved Root copy', async t => {
  const f = await fixture(t), captured = await captureRecoveryRoot(f.directory)
  const prepared = { files: f.files.map((row, index) => ({ relativePath: row.name,
    bytes: Object.values(captured.files)[index], ...captured.fileMetadata[row.name],
    ...(index === 0 ? { uid: captured.fileMetadata[row.name].uid + 1 } : {}) })) }
  const target = join(f.directory, 'silent-owner')
  await fs.mkdir(join(target, 'profiles/cloud'), { recursive: true })
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args)
    return { stat: () => handle.stat(), readFile: () => handle.readFile(), writeFile: bytes => handle.writeFile(bytes),
      chown: async () => {}, chmod: mode => handle.chmod(mode), sync: () => handle.sync(), close: () => handle.close() }
  } }
  await assert.rejects(writeRecoveryRoot(captured, prepared, target, io), /来源或读取期间/)
  assert.deepEqual(await fs.readFile(f.files[0].path), f.files[0].bytes)
  assert.equal((await fs.lstat(join(target, f.files[0].name))).uid, captured.fileMetadata[f.files[0].name].uid)
})

test('a file changed during capture refuses and every acquired descriptor actually closes', async t => {
  const f = await fixture(t), opened = new Set(), closed = new Set()
  const io = { lstat: fs.lstat, open: async (path, flags) => {
    const handle = await fs.open(path, flags)
    opened.add(path)
    return { stat: () => handle.stat(), readFile: async () => {
      const bytes = await handle.readFile()
      await fs.appendFile(path, 'changed-during-capture')
      return bytes
    }, close: async () => { await handle.close(); closed.add(path) } }
  } }
  await assert.rejects(captureRecoveryRoot(f.directory, io), /来源或读取期间/)
  assert.equal(opened.size, 1)
  assert.deepEqual(closed, opened)
  assert.equal((await fs.readFile(f.files[0].path, 'utf8')).endsWith('changed-during-capture'), true)
})

test('actual six-file capture feeds the mapper and exclusive side writer without changing original files', async t => {
  const f = await fixture(t), hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const planHash = 'a'.repeat(64)
  const deployment = Buffer.from(JSON.stringify({ storage: { plan: { sha256: planHash } },
    lifecycle: { lifecycleBaseUrl: 'http://192.0.2.7:18100/v1' } }) + '\r\n')
  const root = Buffer.from(JSON.stringify([{ insert: [
    { id: 'files-root', config: { staticStorage: { planSha256: planHash } } },
    { id: 'execution-root', config: { rootDeployment: { sha256: hash(deployment) } } },
    { id: 'webserver', config: { host: '192.0.2.6', port: 18920 } },
    { id: 'runtime-root', config: { internalAddress: 'http://192.0.2.6:18920', database: { host: '192.0.2.5', port: 5432 } } },
    { id: 'access-root', config: { publicOrigin: 'http://127.0.0.1:40000', database: { host: '192.0.2.5', port: 5432 } } },
  ] }]) + '\r\n')
  await fs.writeFile(f.files[0].path, root); await fs.writeFile(f.files[1].path, deployment)
  const captured = await captureRecoveryRoot(f.directory), newPlan = Buffer.from('{"syntheticNewMeasurement":true}\n')
  const targetDirectory = join(f.directory, 'side')
  await fs.mkdir(join(targetDirectory, 'profiles/cloud'), { recursive: true })
  const current = { storagePlanBytes: newPlan, targetDirectory, addresses: { listenHost: '192.0.2.16', listenPort: 18921,
    internalAddress: 'http://192.0.2.16:18921', databaseHost: '192.0.2.15', databasePort: 5544,
    publicOrigin: 'http://127.0.0.1:41000', lifecycleBaseUrl: 'http://192.0.2.17:18100/v1' } }
  const result = await rebuildRecoveryRoot(captured, current)
  assert.equal(result.written.length, 6)
  for (let index = 0; index < f.files.length; index++) {
    assert.deepEqual(await fs.readFile(f.files[index].path), Object.values(captured.files)[index])
    assert.deepEqual(await fs.readFile(join(targetDirectory, f.files[index].name)), result.prepared.files[index].bytes)
  }
  assert.deepEqual(result.prepared.files[3].bytes, captured.files.credentialsBytes)
  assert.deepEqual(result.prepared.files[5].bytes, Buffer.alloc(0))
  assert.deepEqual(result.prepared.files[4].bytes, newPlan)
  assert.equal((await rebuildRecoveryRoot(captured, current)).written.every(row => row.action === 'skip'), true)
})
