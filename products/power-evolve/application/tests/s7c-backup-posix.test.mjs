/** Restore POSIX bytes and traversal modes without following links outside owned mounts. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupSourceRoots, copyPosixTree, prepareRestoredExecutionMounts,
  prepareRestoredSkillMounts, resolveTrialStorage, trialDataPath } from '../../scripts/backup-posix.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pe-backup-posix-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const directory of ['workspaces', 'homes', 'skill-packages']) {
    await mkdir(join(root, directory), { mode: 0o700 })
  }
  return root
}
const mode = async path => (await lstat(path)).mode & 0o7777

test('prepared storage retains a custom no-Sandbox Skill root across filtered startup environments', async t => {
  const root = await fixture(t), privateDir = join(root, 'private'), custom = join(root, 'custom skills')
  await mkdir(privateDir)
  const defaults = await resolveTrialStorage(privateDir, null, {})
  assert.equal(trialDataPath(defaults, 'skill-packages'), join(privateDir, 'skill-library', 'skill-packages'))
  await assert.rejects(resolveTrialStorage(privateDir, null, {}, true), /Prepare.*layout/)
  const layout = await resolveTrialStorage(privateDir, null, { PE_SKILL_LIBRARY_ROOT: custom })
  await writeFile(join(privateDir, 'storage-layout.json'), JSON.stringify(layout))
  assert.deepEqual(await resolveTrialStorage(privateDir, null, {}, true), layout)
  assert.equal(trialDataPath(layout, 'skill-packages'), join(custom, 'skill-packages'))
  await assert.rejects(resolveTrialStorage(privateDir, null,
    { PE_SKILL_LIBRARY_ROOT: join(root, 'other') }, true), /recorded layout/)
  await assert.rejects(resolveTrialStorage(join(root, 'new'), null,
    { PE_SKILL_LIBRARY_ROOT: 'relative' }), /absolute/)
  await writeFile(join(privateDir, 'storage-layout.json'), JSON.stringify({ ...layout, format: 99 }))
  await assert.rejects(resolveTrialStorage(privateDir, null, {}), /Unknown.*layout/)
})

test('Sandbox storage and legacy backup data map to the same shared mount', async t => {
  const root = await fixture(t), privateDir = join(root, 'private'), shared = join(root, 'sandbox')
  const sandbox = { localRoot: shared, workspaceRoot: join(shared, 'workspaces') }
  const layout = await resolveTrialStorage(privateDir, sandbox, {})
  assert.equal(trialDataPath(layout, 'skill-packages'), join(shared, 'skill-packages'))
  assert.equal(trialDataPath(layout, 'homes'), join(shared, 'homes'))
  await assert.rejects(resolveTrialStorage(privateDir, sandbox,
    { PE_SKILL_LIBRARY_ROOT: join(root, 'elsewhere') }), /Sandbox.*differ/)
  assert.deepEqual(backupSourceRoots({ format: 1, sourceSharedRoot: shared }), [shared])
  assert.deepEqual(backupSourceRoots({ format: 2, sourceSharedRoot: shared, storage: layout }),
    [shared, sandbox.workspaceRoot, join(privateDir, 'artifacts'), shared])
  const office = join(root, 'office-cache')
  assert.deepEqual(backupSourceRoots({ format: 3, sourceSharedRoot: shared, storage: layout,
    officeCache: { sourceCacheRoot: office } }), [shared, sandbox.workspaceRoot, join(privateDir, 'artifacts'), shared, office])
  assert.deepEqual(backupSourceRoots({ format: 3, sourceSharedRoot: shared, storage: layout, officeCache: null }),
    [shared, sandbox.workspaceRoot, join(privateDir, 'artifacts'), shared])
  for (const manifest of [
    { format: 3, sourceSharedRoot: shared },
    { format: 1, sourceSharedRoot: shared, storage: layout },
    { format: 2, sourceSharedRoot: shared, storage: { ...layout, format: 2 } },
    { format: 2, sourceSharedRoot: shared, storage: { ...layout, extra: true } },
    { format: 2, sourceSharedRoot: join(root, 'other'), storage: layout },
    ...['relative', '/', `${root}/cache/..`].map(sourceCacheRoot =>
      ({ format: 3, sourceSharedRoot: shared, storage: layout, officeCache: { sourceCacheRoot } })),
  ]) assert.throws(() => backupSourceRoots(manifest), /backup storage|trial storage|Office backup source root/)
})

test('backup and restore preserve relative symlink text, file modes and bytes', async t => {
  const root = await fixture(t)
  const source = join(root, 'source'), archive = join(root, 'archive'), restored = join(root, 'restored')
  await mkdir(source, { mode: 0o700 })
  await writeFile(join(source, 'run.sh'), '#!/bin/sh\nprintf ready\n', { mode: 0o750 })
  await chmod(join(source, 'run.sh'), 0o750)
  await symlink('run.sh', join(source, 'relative'))
  await symlink('../outside', join(source, 'external'))
  await copyPosixTree(source, archive)
  await copyPosixTree(archive, restored)
  assert.equal(await readlink(join(restored, 'relative')), 'run.sh')
  assert.equal(await readlink(join(restored, 'external')), '../outside')
  assert.deepEqual(await readFile(join(restored, 'run.sh')), await readFile(join(source, 'run.sh')))
  assert.equal(await mode(join(restored, 'run.sh')), 0o750)
  await assert.rejects(copyPosixTree(source, restored))
})

test('legacy Skill root repair changes no package bytes, private parents or unrelated owners', async t => {
  const root = await fixture(t), user = randomUUID(), other = randomUUID()
  const packages = join(root, 'skill-packages'), owned = join(packages, user)
  await mkdir(join(owned, 'sha256'), { recursive: true, mode: 0o700 })
  await chmod(owned, 0o700)
  await mkdir(join(packages, other), { mode: 0o700 })
  const body = join(owned, 'sha256', 'SKILL.md')
  await writeFile(body, 'immutable instructions', { mode: 0o444 })
  const original = await lstat(body)
  assert.equal(await prepareRestoredSkillMounts(packages, [user, randomUUID()]), 1)
  assert.equal(await prepareRestoredSkillMounts(packages, [user]), 0)
  assert.equal(await mode(owned), 0o755)
  assert.equal(await mode(packages), 0o700)
  assert.equal(await mode(join(packages, other)), 0o700)
  assert.equal(await mode(body), 0o444)
  assert.equal((await lstat(body)).uid, original.uid)
  assert.equal(await readFile(body, 'utf8'), 'immutable instructions')
})

test('execution ownership preparation retains Git modes and does not touch symlink targets', async t => {
  const root = await fixture(t), user = randomUUID(), workspace = randomUUID()
  const owned = join(root, 'workspaces', workspace), home = join(root, 'homes', user)
  await mkdir(join(owned, '.git'), { recursive: true, mode: 0o700 })
  await mkdir(home, { mode: 0o700 })
  const gitHead = join(owned, '.git', 'HEAD'), outside = join(root, 'outside')
  await writeFile(gitHead, 'ref: refs/heads/main\n', { mode: 0o644 })
  await writeFile(outside, 'untouched', { mode: 0o600 })
  await symlink(outside, join(owned, 'external'))
  await symlink('../missing', join(home, 'dangling'))
  const before = await lstat(outside, { bigint: true })
  const owner = { uid: process.getuid(), gid: process.getgid() }
  assert.equal(await prepareRestoredExecutionMounts(root,
    { userIds: [user], storageRootKeys: [workspace] }, owner), 6)
  assert.equal(await mode(join(owned, '.git')), 0o700)
  assert.equal(await mode(gitHead), 0o644)
  assert.equal(await readFile(gitHead, 'utf8'), 'ref: refs/heads/main\n')
  assert.equal(await readlink(join(owned, 'external')), outside)
  assert.equal(await readlink(join(home, 'dangling')), '../missing')
  const after = await lstat(outside, { bigint: true })
  assert.deepEqual([after.uid, after.gid, after.mode, after.ctimeNs],
    [before.uid, before.gid, before.mode, before.ctimeNs])
})

test('mount roots must be real directories addressed by restored UUID owners', async t => {
  const root = await fixture(t), user = randomUUID()
  const packages = join(root, 'skill-packages')
  await symlink(tmpdir(), join(packages, user))
  await assert.rejects(prepareRestoredSkillMounts(packages, [user]), /real directory/)
  await assert.rejects(prepareRestoredSkillMounts(packages, ['../outside']), /UUID/)
  await symlink(tmpdir(), join(root, 'workspaces', user))
  await assert.rejects(prepareRestoredExecutionMounts(root,
    { storageRootKeys: [user], userIds: [] }, { uid: process.getuid(), gid: process.getgid() }), /real directory/)
})

test('storage recovery prepares the recorded physical root and leaves missing roots absent', async t => {
  const root = await fixture(t), storageRootKey = randomUUID(), workspaceId = randomUUID(), missingRoot = randomUUID()
  const repository = join(root, 'workspaces', storageRootKey, 'existing', 'repo')
  await mkdir(join(repository, '.git'), { recursive: true, mode: 0o700 })
  await writeFile(join(repository, '.git', 'HEAD'), 'ref: refs/heads/existing\n')
  const prepared = await prepareRestoredExecutionMounts(root,
    { storageRootKeys: [storageRootKey, missingRoot], userIds: [] }, { uid: process.getuid(), gid: process.getgid() })
  assert.equal(prepared, 5)
  assert.equal(await readFile(join(repository, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/existing\n')
  await assert.rejects(lstat(join(root, 'workspaces', workspaceId)), { code: 'ENOENT' })
  await assert.rejects(lstat(join(root, 'workspaces', missingRoot)), { code: 'ENOENT' })
})
