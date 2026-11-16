/** Capture the live six-file Root input and rebuild beside it after actual namespace measurement. */
import * as filesystem from 'node:fs/promises'
import { constants } from 'node:fs'
import { posix } from 'node:path'
import { CandidateError } from './inspect.mjs'
import { mapRecoveryConfiguration } from './recovery-config-map.mjs'
import { RECOVERY_ROOT_FILES, rebuildRecoveryFiles, writeRecoveryFilesBesideSources } from './recovery-config.mjs'

const fields = ['rootBytes', 'deploymentBytes', 'packageBytes', 'credentialsBytes', 'storagePlanBytes', 'mutableProfileBytes']
const MODULE_LINK = 'profiles/cloud/node_modules'
const fail = () => { throw new CandidateError('根配置来源或读取期间的文件身份未确认；原文件未改写。') }

async function moduleLink(path, io) {
  let before
  try { before = await io.lstat(path) } catch (error) { if (error.code === 'ENOENT') return { kind: 'absent' }; throw error }
  if (!before.isSymbolicLink() || before.nlink !== 1) fail()
  const target = await io.readlink(path), after = await io.lstat(path)
  if (typeof target !== 'string' || !target || target.includes('\0') || !after.isSymbolicLink()
    || ['dev', 'ino', 'uid', 'gid', 'nlink', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) fail()
  return { kind: 'link', target, uid: before.uid, gid: before.gid }
}

async function checkModuleLink(expected, targetDirectory, io) {
  if (!expected || !['absent', 'link'].includes(expected.kind) || expected.kind === 'link'
    && (typeof expected.target !== 'string' || !expected.target || expected.target.includes('\0')
      || !Number.isSafeInteger(expected.uid) || expected.uid < 0 || !Number.isSafeInteger(expected.gid) || expected.gid < 0)) fail()
  const present = await moduleLink(posix.join(targetDirectory, MODULE_LINK), io)
  if (present.kind !== 'absent' && JSON.stringify(present) !== JSON.stringify(expected)) fail()
  return present.kind
}

/**
 * Write six prepared files and preserve the original observed module-resolution link in a new side directory.
 * @param {object} captured - Actual captureRecoveryRoot result, including explicit link or observed absence.
 * @param {object} prepared - Six validated prepared file buffers; no original source is overwritten.
 * @param {string} targetDirectory - Existing new Root directory with profiles/cloud already prepared.
 * @param {object} io - Existing filesystem implementation; default is real fs/promises.
 * @returns {Promise<object[]>} Nonsecret file write metadata. Unknown/different existing links refuse before writes.
 */
export async function writeRecoveryRoot(captured, prepared, targetDirectory, io = filesystem) {
  const linkState = await checkModuleLink(captured.moduleLink, targetDirectory, io)
  const written = await writeRecoveryFilesBesideSources(prepared, { targetDirectory, originalPaths: captured.originalPaths }, io)
  if (linkState === 'absent' && captured.moduleLink.kind === 'link') {
    const target = posix.join(targetDirectory, MODULE_LINK)
    await io.symlink(captured.moduleLink.target, target)
    await io.lchown(target, captured.moduleLink.uid, captured.moduleLink.gid)
  }
  return written
}

/**
 * Read all six original files and their actual metadata while the caller holds this instance's operation lock.
 * @param {string} profileHome - Explicit live Root home, observed through its confirmed namespace identity.
 * @param {object} io - Existing filesystem I/O; default is real fs/promises. No fallback or historical metadata.
 * @returns {Promise<object>} Secret-bearing source buffers, metadata and original paths. Retain these privately
 * before normal shutdown; never log or spread them into public results. Empty mutable profiles remain valid.
 */
export async function captureRecoveryRoot(profileHome, io = filesystem) {
  try {
    if (typeof profileHome !== 'string' || !profileHome.startsWith('/') || profileHome === '/'
      || posix.normalize(profileHome) !== profileHome || profileHome.includes('\0')) fail()
    const files = {}, fileMetadata = {}, originalPaths = []
    for (let index = 0; index < RECOVERY_ROOT_FILES.length; index++) {
      const relativePath = RECOVERY_ROOT_FILES[index], path = posix.join(profileHome, relativePath)
      const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size)
          || before.size < 0 || before.size > 1048576 || before.size === 0 && index !== 5) fail()
        const bytes = await handle.readFile(), after = await handle.stat(), named = await io.lstat(path)
        if (!Buffer.isBuffer(bytes) || bytes.length !== before.size || !named.isFile() || named.isSymbolicLink()
          || ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key] || before[key] !== named[key])) fail()
        files[fields[index]] = Buffer.from(bytes)
        fileMetadata[relativePath] = { uid: before.uid, gid: before.gid, mode: (before.mode & 0o7777).toString(8).padStart(4, '0') }
      } finally { await handle.close() }
      originalPaths.push(path)
    }
    return { files, fileMetadata, originalPaths, moduleLink: await moduleLink(posix.join(profileHome, MODULE_LINK), io) }
  } catch (_error) { fail() }
}

/**
 * Compose the actual measured plan and fresh endpoints with the captured originals, then publish beside them.
 * @param {object} captured - Secret-bearing captureRecoveryRoot result retained before shutdown; credentials
 * remain under the original credentials-local parser and private source ownership.
 * @param {object} current - New actual storagePlanBytes, observed addresses and caller-owned targetDirectory.
 * @param {object} io - Existing filesystem writer; defaults to real fs/promises. Parent directories already exist.
 * @returns {Promise<object>} Secret-bearing prepared files for the original Root seal protocol and nonsecret
 * write metadata. This does not start/seal a namespace or declare application readiness.
 */
export async function rebuildRecoveryRoot(captured, { storagePlanBytes, addresses, targetDirectory }, io = filesystem) {
  try {
    const { files, fileMetadata, originalPaths } = captured
    const patches = mapRecoveryConfiguration({ rootBytes: files.rootBytes, deploymentBytes: files.deploymentBytes, addresses })
    const prepared = rebuildRecoveryFiles({ ...files, storagePlanBytes, patches, fileMetadata })
    const written = await writeRecoveryRoot({ moduleLink: captured.moduleLink, originalPaths }, prepared, targetDirectory, io)
    return { prepared, written }
  } catch (_error) { throw new CandidateError('根配置恢复未完成；保留原件和旁路新文件，不启动应用或重试。') }
}
