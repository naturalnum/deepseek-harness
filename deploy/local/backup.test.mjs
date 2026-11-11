import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { create } from 'tar'
import { indexAccountArchive, pruneAccountDirectories, readAccountArchiveIndex } from './backup.mjs'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pe-account-restore-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function file(root, path, text = 'fixture') {
  const destination = join(root, path)
  fs.mkdirSync(dirname(destination), { recursive: true })
  fs.writeFileSync(destination, text)
  return destination
}

const member = (path, type = 'File', linkpath) => ({ path: path.slice(1), type, linkpath })

test('removes new entries while retaining selected account roots, backed-up directory inodes and other account data', t => {
  const root = fixture(t), account = join(root, 'selected')
  const retained = file(account, 'projects/workspace/existing.txt', 'old data')
  const other = file(root, 'other-account/projects/untouched.txt', 'other account')
  const unmanaged = file(root, 'operator/untouched.txt', 'operator data')
  const directories = [account, join(account, 'projects'), join(account, 'projects/workspace')]
  const inodes = directories.map(path => fs.statSync(path).ino)
  const index = indexAccountArchive([member(account, 'Directory'), member(retained)], [account])
  file(account, 'projects/workspace/added.txt')
  file(account, 'private/new-version/added.json')

  assert.deepEqual(pruneAccountDirectories(index), { removedFiles: 2, removedDirectories: 2 })
  assert.deepEqual(directories.map(path => fs.statSync(path).ino), inodes)
  assert.equal(fs.readFileSync(retained, 'utf8'), 'old data')
  assert.equal(fs.existsSync(join(account, 'projects/workspace/added.txt')), false)
  assert.equal(fs.existsSync(join(account, 'private')), false)
  assert.equal(fs.readFileSync(other, 'utf8'), 'other account')
  assert.equal(fs.readFileSync(unmanaged, 'utf8'), 'operator data')
})

test('never follows account symlinks and removes a new or type-conflicting link without touching its external target', t => {
  const root = fixture(t), account = join(root, 'selected'), outside = join(root, 'outside')
  const external = file(outside, 'important.txt', 'external data')
  fs.mkdirSync(account)
  fs.symlinkSync(outside, join(account, 'new-link'))
  fs.symlinkSync(outside, join(account, 'retained-link'))
  fs.symlinkSync(external, join(account, 'old-file.txt'))
  const index = indexAccountArchive([member(account, 'Directory'), member(join(account, 'old-file.txt')),
    member(join(account, 'retained-link'), 'SymbolicLink', outside)], [account])

  assert.deepEqual(pruneAccountDirectories(index), { removedFiles: 2, removedDirectories: 0 })
  assert.equal(fs.existsSync(join(account, 'new-link')), false)
  assert.equal(fs.existsSync(join(account, 'old-file.txt')), false)
  assert.equal(fs.lstatSync(join(account, 'retained-link')).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(external, 'utf8'), 'external data')
})

test('rejects archive traversal, unselected accounts, linked ancestors and outside hardlinks before cleanup', t => {
  const account = join(fixture(t), 'selected')
  const base = [member(account, 'Directory')]
  for (const bad of [
    { path: '../outside.txt', type: 'File' },
    { path: `${account}/absolute.txt`, type: 'File' },
    member(`${account}-other/file.txt`),
    member(join(account, 'linked'), 'Link', 'outside/file.txt'),
  ]) assert.throws(() => indexAccountArchive([...base, bad], [account]), /越界|未选定/)
  assert.throws(() => indexAccountArchive([...base, member(join(account, 'linked'), 'SymbolicLink', '/outside'),
    member(join(account, 'linked/file.txt'))], [account]), /不能穿过/)
  assert.throws(() => indexAccountArchive([member(join(account, 'only-file.txt'))], [account]), /缺少完整/)
  assert.throws(() => indexAccountArchive([], ['/']), /根目录/)
})

test('preserves backed-up mount directories and refuses an unbacked new mount before deleting any files', t => {
  const account = join(fixture(t), 'selected')
  const existing = file(account, 'mounted/existing.txt')
  const added = file(account, 'new.txt')
  fs.mkdirSync(join(account, 'new-mount'))
  const index = indexAccountArchive([member(account, 'Directory'), member(existing)], [account])
  assert.throws(() => pruneAccountDirectories(index, [join(account, 'mounted'), join(account, 'new-mount')]), /备份未覆盖的挂载/)
  assert.equal(fs.existsSync(added), true)
  assert.equal(fs.statSync(join(account, 'new-mount')).isDirectory(), true)
  fs.rmdirSync(join(account, 'new-mount'))
  const mountedInode = fs.statSync(join(account, 'mounted')).ino
  pruneAccountDirectories(index, [join(account, 'mounted')])
  assert.equal(fs.statSync(join(account, 'mounted')).ino, mountedInode)
})

test('reads a real tar backup index and rejects a symlinked selected root without modifying data', async t => {
  const root = fixture(t), account = join(root, 'selected')
  const existing = file(account, 'projects/existing.txt')
  const archive = join(root, 'accounts.tar.gz')
  await create({ cwd: '/', file: archive, gzip: true }, [account.slice(1)])
  const index = await readAccountArchiveIndex(archive, [account])
  assert.ok(index.entries.some(entry => entry.path === existing && entry.type === 'File'))
  const link = join(root, 'linked-root')
  fs.symlinkSync(account, link)
  const linkedIndex = indexAccountArchive([member(link, 'Directory')], [link])
  assert.throws(() => pruneAccountDirectories(linkedIndex), /根目录或其父目录/)
  assert.equal(fs.readFileSync(existing, 'utf8'), 'fixture')
})
