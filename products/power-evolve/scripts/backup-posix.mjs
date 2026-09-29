/** Restore execution ownership and legacy Skill mount modes before starting trial writers. */
import { constants } from 'node:fs'
import { cp, lchown, lstat, mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

function requireUuid(value) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error('Restored resource owner must be a UUID')
  }
}

async function realRoot(root) {
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Restore root must be a real directory')
}

/**
 * Copy a stopped POSIX tree to a fresh destination without rewriting symbolic-link targets.
 * @param {string} source - Real source directory; a missing tree becomes an empty private directory.
 * @param {string} target - Destination that must not already contain copied entries.
 * @returns {Promise<void>} Resolves after copying bytes, modes, timestamps and link text, but not numeric owners.
 */
export async function copyPosixTree(source, target) {
  let stat
  try { stat = await lstat(source) }
  catch (error) { if (error.code === 'ENOENT') { await mkdir(target, { mode: 0o700 }); return }; throw error }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('POSIX backup source must be a real directory')
  await cp(source, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
    errorOnExist: true, force: false })
}

/**
 * Assign copied Workspace/Home entries to the cloud executor without following symlinks.
 * The caller has stopped writers and checked the fresh target; other users cannot mutate this tree.
 * @param {string} root - Restored shared POSIX root.
 * @param {{workspaceIds: readonly string[], userIds: readonly string[]}} resources - Owners from restored PG rows.
 * @param {{uid: number, gid: number}} owner - Execution identity used by the target Sandbox runner.
 * @returns {Promise<number>} Number of entries prepared; bytes and permission modes are preserved.
 */
export async function prepareRestoredExecutionMounts(root, resources, owner) {
  if (!Number.isSafeInteger(owner.uid) || owner.uid < 0 || !Number.isSafeInteger(owner.gid) || owner.gid < 0) {
    throw new Error('Restore executor identity must contain numeric POSIX IDs')
  }
  await realRoot(root)
  let entries = 0
  async function prepare(path, mountRoot = false) {
    let stat
    try { stat = await lstat(path) }
    catch (error) { if (mountRoot && error.code === 'ENOENT') return; throw error }
    if (mountRoot && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error('Restored execution mount must be a real directory')
    }
    if (stat.isSymbolicLink()) {
      await lchown(path, owner.uid, owner.gid)
    } else {
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('Unsupported restored POSIX entry')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (stat.isDirectory() ? constants.O_DIRECTORY : 0))
      try {
        if (stat.isDirectory()) for (const name of await readdir(path)) await prepare(join(path, name))
        await handle.chown(owner.uid, owner.gid)
        await handle.chmod(stat.mode & 0o7777)
      } finally { await handle.close() }
    }
    entries++
  }
  for (const [directory, ids] of [['workspaces', resources.workspaceIds], ['homes', resources.userIds]]) {
    const parent = join(root, directory)
    await realRoot(parent)
    for (const id of ids) { requireUuid(id); await prepare(join(parent, id), true) }
  }
  return entries
}

/**
 * Permit the Runner to traverse known users' legacy 0700 mount roots.
 * The caller owns the stopped, freshly restored tree. Package contents and their modes stay unchanged.
 * @param {string} root - Restored skill-packages directory under the private shared root.
 * @param {readonly string[]} userIds - UUID owners queried from the restored PostgreSQL database.
 * @returns {Promise<number>} Number of legacy directory modes repaired.
 */
export async function prepareRestoredSkillMounts(root, userIds) {
  await realRoot(root)
  let repaired = 0
  for (const userId of userIds) {
    requireUuid(userId)
    let handle
    try {
      handle = await open(join(root, userId), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw new Error('Restored Skill mount must be a real directory', { cause: error })
    }
    try {
      const stat = await handle.stat()
      if (!stat.isDirectory()) throw new Error('Restored Skill mount must be a real directory')
      if ((stat.mode & 0o7777) === 0o700) {
        await handle.chmod(0o755)
        await handle.sync()
        repaired++
      } else if ((stat.mode & 0o005) !== 0o005) {
        throw new Error('Restored Skill mount is not readable and traversable by the Runner')
      }
    } finally { await handle.close() }
  }
  return repaired
}
