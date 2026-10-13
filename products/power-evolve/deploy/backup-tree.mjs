/** POSIX backup inventories preserve bytes, modes and symlink text without following links. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, chown, lchown, link, lstat, mkdir, open, readdir, readlink, realpath, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Resolve existing ancestors of an absolute source or prospective target.
 * @param path Physical path to compare.
 * @returns Canonical path including any absent suffix.
 */
export async function physicalPath(path) {
  let current = resolve(path)
  const suffix = []
  for (;;) {
    try { return join(await realpath(current), ...suffix.toReversed()) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      suffix.push(relative(parent, current)); current = parent
    }
  }
}

/** Reject nested, equal and symlink-aliased paths before any write.
 * @param paths Paths that must be pairwise independent.
 * @returns Completion after all paths are verified to be physically independent.
 */
export async function separatePaths(paths) {
  const actual = await Promise.all(paths.map(physicalPath))
  for (let i = 0; i < actual.length; i++) for (let j = i + 1; j < actual.length; j++) {
    if (actual[i] === actual[j] || actual[i].startsWith(actual[j] + '/') || actual[j].startsWith(actual[i] + '/')) {
      throw new Error('Backup roots overlap physically')
    }
  }
}

/** Require a new path and a private real parent, refusing a restore through aliases.
 * @param path Destination that must not exist.
 * @returns Completion once the absent destination and private real parent are verified.
 */
export async function newPrivatePath(path) {
  try { await lstat(path); throw new Error('Backup or restore destination already exists') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const parent = await lstat(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw new Error('Destination parent must be private and physical')
}

function safeRelative(path) {
  if (path === '') return
  if (typeof path !== 'string' || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..')
    || /[\p{Cc}\\]/u.test(path)) throw new Error('Invalid backup inventory path')
}
async function regularFile(path, consume) {
  const before = await lstat(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('Backup file identity changed')
    const hash = createHash('sha256')
    for await (const bytes of file.createReadStream({ autoClose: false })) { hash.update(bytes); await consume?.(bytes) }
    const after = await file.stat()
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error('Backup file changed while reading')
    return { size: opened.size, sha256: hash.digest('hex') }
  } finally { await file.close() }
}

/** Inventory an entire real directory including empty directories and symlinks.
 * @param root POSIX root, never a symlink.
 * @param privateOnly Require every source entry to be private and prohibit symlinks.
 * @returns Sorted metadata and content digests, without file contents.
 */
export async function inventoryTree(root, privateOnly = false) {
  const entries = [], inodes = new Map()
  const visit = async (path) => {
    const target = join(root, path), info = await lstat(target)
    if (!path && !info.isDirectory()) throw new Error('Backup root must be a real directory')
    if (privateOnly && (info.mode & 0o077 || info.isSymbolicLink())) throw new Error('Private backup material must be private and physical')
    const entry = { path, mode: info.mode & 0o777, uid: info.uid, gid: info.gid }
    if (info.isDirectory()) {
      entries.push({ ...entry, kind: 'directory' })
      for (const name of (await readdir(target)).toSorted()) { safeRelative(name); await visit(path ? path + '/' + name : name) }
    } else if (info.isFile()) {
      const key = `${info.dev}:${info.ino}`, first = inodes.get(key)
      if (first) entries.push({ ...entry, kind: 'hardlink', target: first.path, size: first.size, sha256: first.sha256 })
      else {
        const file = { ...entry, kind: 'file', ...await regularFile(target) }
        entries.push(file); inodes.set(key, file)
      }
    }
    else if (info.isSymbolicLink() && path) entries.push({ ...entry, kind: 'symlink', link: await readlink(target) })
    else throw new Error('Backup contains a nonregular entry or symlink root')
  }
  await visit('')
  return entries
}

/** Copy a verified inventory into a new root, preserving POSIX owners and permissions.
 * @param source Source directory whose inventory was captured after writers stopped.
 * @param target Absent destination under an owned private parent.
 * @param entries Inventory from inventoryTree; content changes refuse publication.
 * @returns Completion after the copied entries and directories are synced.
 */
export async function copyTree(source, target, entries) {
  if (!Array.isArray(entries) || entries[0]?.path !== '' || entries[0]?.kind !== 'directory') throw new Error('Invalid backup root inventory')
  const seen = new Map()
  for (const entry of entries) {
    safeRelative(entry.path)
    if (seen.has(entry.path) || entry.path && seen.get(dirname(entry.path) === '.' ? '' : dirname(entry.path))?.kind !== 'directory') throw new Error('Invalid backup inventory order')
    const path = join(target, entry.path)
    if (entry.kind === 'directory') await mkdir(path, { mode: 0o700 })
    else if (entry.kind === 'symlink') { await symlink(entry.link, path); await lchown(path, entry.uid, entry.gid) }
    else if (entry.kind === 'hardlink') {
      safeRelative(entry.target)
      const first = seen.get(entry.target)
      if (first?.kind !== 'file' || ['mode', 'uid', 'gid', 'size', 'sha256'].some(key => first[key] !== entry[key])) throw new Error('Invalid backup hardlink identity')
      await link(join(target, entry.target), path)
    }
    else if (entry.kind === 'file') {
      const file = await open(path, 'wx', 0o600)
      try {
        const digest = await regularFile(join(source, entry.path), bytes => file.writeFile(bytes))
        if (digest.sha256 !== entry.sha256 || digest.size !== entry.size) throw new Error('Backup file digest changed')
        await file.chown(entry.uid, entry.gid); await file.chmod(entry.mode); await file.sync()
      }
      finally { await file.close() }
    } else throw new Error('Invalid backup inventory kind')
    seen.set(entry.path, entry)
  }
  for (const entry of entries.toReversed().filter(item => item.kind === 'directory')) {
    const path = join(target, entry.path)
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await chown(path, entry.uid, entry.gid); await chmod(path, entry.mode); await directory.sync() }
    finally { await directory.close() }
  }
}
