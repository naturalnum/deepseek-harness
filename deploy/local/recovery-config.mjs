/** Rebuild private recovery files from explicitly reviewed byte slots; no default filesystem access. */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { CandidateError } from './inspect.mjs'

/** Six relative file paths rebuilt together for the cloud root profile. */
export const RECOVERY_ROOT_FILES = [
  'profiles/cloud/cordis.patch.yml', 'rootDeployment.json', 'profiles/cloud/package.json',
  'credentials.json', 'storage-plan.json', 'profiles/cloud/cordis.yml',
]
const FILES = RECOVERY_ROOT_FILES
const SLOTS = [
  'root.storagePlanHash', 'root.deploymentHash', 'root.listenAddress', 'root.internalAddress',
  'root.databaseAddress.primary', 'root.databaseAddress.secondary', 'root.publicOrigin',
  'deployment.storagePlanHash', 'deployment.backendAddress',
]
const INPUT_ERROR = '恢复配置输入不符合评审说明，未生成任何文件。'
const READ_ERROR = '私密恢复输入读取失败，未写入任何文件。'
const WRITE_ERROR = '恢复配置新文件写入未完成，原件未覆盖；请保留现场。'
const OUTPUT_ERROR = '恢复配置输出位置或文件元数据无效，未写入任何文件。'
const SAFE_ERRORS = new Set([INPUT_ERROR, READ_ERROR, WRITE_ERROR, OUTPUT_ERROR])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = (message = INPUT_ERROR) => { throw new CandidateError(message) }

function keysExactly(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}

function bytes(value) {
  if (!Buffer.isBuffer(value) || value.length === 0) fail()
  return value
}

function mutableProfile(value) {
  if (!Buffer.isBuffer(value)) fail()
  return value
}

function decodeJson(value) {
  try { return JSON.parse(bytes(value).toString('utf8').replace(/^\uFEFF/, '')) }
  catch (_error) { fail() }
}

function validateMetadata(fileMetadata) {
  if (!keysExactly(fileMetadata, FILES)) fail()
  for (const name of FILES) {
    const row = fileMetadata[name]
    if (!keysExactly(row, ['uid', 'gid', 'mode']) || !Number.isSafeInteger(row.uid) || row.uid < 0
      || !Number.isSafeInteger(row.gid) || row.gid < 0 || typeof row.mode !== 'string' || !/^[0-7]{4}$/.test(row.mode)) fail()
  }
}

function validateRanges(source, slots) {
  const ordered = slots.toSorted((a, b) => a.offset - b.offset)
  let end = 0
  for (const slot of ordered) {
    if (!Number.isSafeInteger(slot.offset) || slot.offset < end || !Buffer.isBuffer(slot.expected) || slot.expected.length === 0
      || slot.offset + slot.expected.length > source.length
      || !source.subarray(slot.offset, slot.offset + slot.expected.length).equals(slot.expected)) fail()
    end = slot.offset + slot.expected.length
  }
  return ordered
}

function applyReviewedSlots(source, slots, values) {
  const pieces = []
  let offset = 0
  for (const slot of validateRanges(source, slots)) {
    const value = values.get(slot.slot)
    if (!Buffer.isBuffer(value)) fail()
    pieces.push(source.subarray(offset, slot.offset), value)
    offset = slot.offset + slot.expected.length
  }
  pieces.push(source.subarray(offset))
  return Buffer.concat(pieces)
}

function approvedPatches(patches) {
  if (!Array.isArray(patches) || patches.length !== SLOTS.length) fail()
  const seen = new Set()
  for (const patch of patches) {
    if (!patch || !SLOTS.includes(patch.slot) || seen.has(patch.slot)) fail()
    seen.add(patch.slot)
    const hashSlot = patch.slot.endsWith('Hash')
    if (!keysExactly(patch, hashSlot ? ['slot', 'offset', 'expected'] : ['slot', 'offset', 'expected', 'value'])) fail()
    bytes(patch.expected)
    if (!Number.isSafeInteger(patch.offset) || patch.offset < 0) fail()
    if (hashSlot) {
      if (!/^[a-fA-F0-9]{64}$/.test(patch.expected.toString('utf8'))) fail()
    } else {
      // Quotes and layout stay outside the approved address-token byte range.
      if (typeof patch.value !== 'string' || !/^[A-Za-z0-9:/._\[\]-]+$/.test(patch.value)
        || !/^[A-Za-z0-9:/._\[\]-]+$/.test(patch.expected.toString('utf8'))) fail()
    }
  }
  for (const prefix of ['root.', 'deployment.']) {
    let end = 0
    for (const patch of patches.filter(row => row.slot.startsWith(prefix)).toSorted((a, b) => a.offset - b.offset)) {
      if (patch.offset < end) fail()
      end = patch.offset + patch.expected.length
    }
  }
  return patches
}

function credentialsBytes(authInit) {
  const source = Buffer.isBuffer(authInit) ? decodeJson(authInit) : authInit
  const password = source?.database?.password, authSecret = source?.authSecret
  if (typeof password !== 'string' || !password || typeof authSecret !== 'string' || !authSecret) fail()
  // credentials-local/src/index.ts parseCredentialsDocument accepts version 1 with string refs.
  return Buffer.from(JSON.stringify({ version: 1, refs: {
    DSH_FEATURE_PG_PASSWORD: password, DSH_FEATURE_AUTH_SECRET: authSecret,
  } }, null, 2) + '\n')
}

/**
 * Rebuild six files using reviewed byte slots and the public credentials-local version 1/refs format.
 * @param {object} input - Exactly rootBytes, deploymentBytes, packageBytes, storagePlanBytes, mutableProfileBytes, authInit, patches and fileMetadata. The original mutable profile Buffer is copied without parsing or normalization, including an empty file. Hash slots span 64 old hexadecimal bytes; address slots span unquoted ASCII tokens. Only declared offsets change, including when the same token occurs elsewhere. Credentials follow packages/credentials/credentials-local/src/index.ts parseCredentialsDocument and include only the two existing references.
 * @returns {{files: object[], hashes: object}} Files with relativePath, secret-bearing bytes Buffer, uid, gid and four-digit mode; hashes are computed from the final plan/deployment bytes. Never log the returned files.
 */
export function rebuildRecoveryFiles(input) {
  try {
    if (!keysExactly(input, ['rootBytes', 'deploymentBytes', 'packageBytes', 'authInit', 'storagePlanBytes', 'mutableProfileBytes', 'patches', 'fileMetadata'])) fail()
    const { rootBytes, deploymentBytes, packageBytes, authInit, storagePlanBytes, mutableProfileBytes, patches, fileMetadata } = input
    bytes(rootBytes); bytes(deploymentBytes); bytes(packageBytes); bytes(storagePlanBytes); mutableProfile(mutableProfileBytes)
    const plan = decodeJson(storagePlanBytes)
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail()
    validateMetadata(fileMetadata)
    const reviewed = approvedPatches(patches)
    const original = slot => reviewed.find(row => row.slot === slot).expected.toString('utf8').toLowerCase()
    if (original('root.storagePlanHash') !== original('deployment.storagePlanHash')
      || original('root.deploymentHash') !== sha256(deploymentBytes)) fail()
    const values = new Map(reviewed.filter(row => Object.hasOwn(row, 'value')).map(row => [row.slot, Buffer.from(row.value)]))
    const storagePlanHash = sha256(storagePlanBytes)
    values.set('root.storagePlanHash', Buffer.from(storagePlanHash))
    values.set('deployment.storagePlanHash', Buffer.from(storagePlanHash))
    const deployment = applyReviewedSlots(deploymentBytes, reviewed.filter(row => row.slot.startsWith('deployment.')), values)
    const deploymentHash = sha256(deployment)
    values.set('root.deploymentHash', Buffer.from(deploymentHash))
    const root = applyReviewedSlots(rootBytes, reviewed.filter(row => row.slot.startsWith('root.')), values)
    const credentials = credentialsBytes(authInit)
    const contents = [root, deployment, Buffer.from(packageBytes), credentials, Buffer.from(storagePlanBytes), Buffer.from(mutableProfileBytes)]
    return { files: FILES.map((relativePath, index) => ({ relativePath, bytes: contents[index], ...fileMetadata[relativePath] })),
      hashes: { storagePlan: storagePlanHash, deployment: deploymentHash } }
  } catch (error) {
    if (error instanceof CandidateError && SAFE_ERRORS.has(error.message)) throw error
    throw new CandidateError(INPUT_ERROR)
  }
}

function absolutePath(value) {
  return typeof value === 'string' && value.startsWith('/') && value !== '/' && !value.includes('\0') && posix.normalize(value) === value
}

/**
 * Read only explicitly supplied private sources through injected I/O, then run the pure rebuild.
 * @param {object} specification - Exactly patches, fileMetadata and sources mapping root/deployment/package/authInit/storagePlan/mutableProfile to explicit absolute paths; there are no default private paths. Missing profile sources refuse before any private read.
 * @param {object} io - readFile(path) returns a Buffer; no write operation is used.
 * @returns {Promise<object>} Prepared secret-bearing buffers, or a fixed diagnostic without input contents or external error text.
 */
export async function readAndRebuildRecoveryFiles(specification, io = {}) {
  const names = ['root', 'deployment', 'package', 'authInit', 'storagePlan', 'mutableProfile']
  let loaded
  try {
    if (typeof io?.readFile !== 'function' || !keysExactly(specification, ['sources', 'patches', 'fileMetadata']) || !keysExactly(specification.sources, names)
      || names.some(name => !absolutePath(specification.sources[name]))) fail(READ_ERROR)
    validateMetadata(specification.fileMetadata)
    approvedPatches(specification.patches)
  } catch (error) {
    if (error instanceof CandidateError && SAFE_ERRORS.has(error.message)) throw error
    throw new CandidateError(READ_ERROR)
  }
  try {
    loaded = {}
    for (const name of names) {
      const original = await io.readFile(specification.sources[name])
      loaded[name] = Buffer.from(name === 'mutableProfile' ? mutableProfile(original) : bytes(original))
    }
  } catch (_error) { throw new CandidateError(READ_ERROR) }
  return rebuildRecoveryFiles({ patches: specification.patches, fileMetadata: specification.fileMetadata,
    rootBytes: loaded.root, deploymentBytes: loaded.deployment, packageBytes: loaded.package,
    authInit: loaded.authInit, storagePlanBytes: loaded.storagePlan, mutableProfileBytes: loaded.mutableProfile })
}

function preparedFiles(prepared) {
  if (!Array.isArray(prepared?.files) || prepared.files.length !== FILES.length) fail(OUTPUT_ERROR)
  const seen = new Set(), metadata = {}
  for (const row of prepared.files) {
    if (!keysExactly(row, ['relativePath', 'bytes', 'uid', 'gid', 'mode']) || !FILES.includes(row.relativePath)
      || seen.has(row.relativePath) || !Buffer.isBuffer(row.bytes) || row.bytes.length === 0 && row.relativePath !== FILES[5]) fail(OUTPUT_ERROR)
    seen.add(row.relativePath)
    metadata[row.relativePath] = { uid: row.uid, gid: row.gid, mode: row.mode }
  }
  try { validateMetadata(metadata) }
  catch (_error) { fail(OUTPUT_ERROR) }
  return prepared.files.map(row => ({ ...row, bytes: Buffer.from(row.bytes) }))
}

/**
 * Write exclusive new files in an already prepared side directory, preserving all original files.
 * @param {object} prepared - The six files returned by rebuildRecoveryFiles; all entries are validated before opening anything.
 * @param {object} destination - Explicit targetDirectory and originalPaths; targets must differ from every original path. Caller exclusively owns the prepared private directory and its parent path; nested output directories must already exist without symlinks.
 * @param {object} io - lstat(path) and readFile(path) must confirm exact bytes/ownership/mode for existing outputs, or ENOENT for missing targets; every target and parent is checked before any open. open(path, 'wx', 0o600) must return a complete handle with writeFile(Buffer), chown, chmod, sync and close. Secrets are passed only as Buffers, never commands or logs.
 * @returns {Promise<object[]>} Non-secret output metadata with action skip/written. Matching existing files are skipped; any existing mismatch or unknown observation prevents all writes. I/O failure closes the current handle, stops without retry and leaves new files for inspection; a later explicit call observes them again. Originals are never overwritten or unlinked.
 */
export async function writeRecoveryFilesBesideSources(prepared, destination, io = {}) {
  let files, targets
  const ready = new Set()
  try {
    files = preparedFiles(prepared)
    if (typeof io?.open !== 'function' || typeof io?.lstat !== 'function' || typeof io?.readFile !== 'function'
      || !keysExactly(destination, ['targetDirectory', 'originalPaths']) || !absolutePath(destination.targetDirectory)
      || !Array.isArray(destination.originalPaths) || destination.originalPaths.length === 0
      || destination.originalPaths.some(path => !absolutePath(path))) fail(OUTPUT_ERROR)
    const targetDirectory = posix.resolve(destination.targetDirectory)
    targets = files.map(row => posix.join(targetDirectory, row.relativePath))
    const originals = destination.originalPaths.map(path => posix.resolve(path))
    if (targets.some(path => originals.includes(path))) fail(OUTPUT_ERROR)
    const parents = new Set([targetDirectory])
    for (const target of targets) {
      for (let parent = posix.dirname(target); parent !== targetDirectory; parent = posix.dirname(parent)) parents.add(parent)
    }
    for (const parent of [...parents].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const stat = await io.lstat(parent)
      if (typeof stat?.isDirectory !== 'function' || !stat.isDirectory()) fail(OUTPUT_ERROR)
    }
    for (let index = 0; index < targets.length; index++) {
      const path = targets[index], file = files[index]
      let stat
      try { stat = await io.lstat(path) }
      catch (error) { if (error?.code === 'ENOENT') continue; fail(OUTPUT_ERROR) }
      if (typeof stat?.isFile !== 'function' || !stat.isFile() || !Number.isSafeInteger(stat.uid) || !Number.isSafeInteger(stat.gid)
        || !Number.isSafeInteger(stat.mode) || !Number.isSafeInteger(stat.size) || stat.size !== file.bytes.length
        || stat.uid !== file.uid || stat.gid !== file.gid || (stat.mode & 0o7777) !== Number.parseInt(file.mode, 8)) fail(OUTPUT_ERROR)
      const content = await io.readFile(path)
      if (!Buffer.isBuffer(content) || !content.equals(file.bytes)) fail(OUTPUT_ERROR)
      ready.add(index)
    }
  } catch (_error) { throw new CandidateError(OUTPUT_ERROR) }
  const written = []
  for (let index = 0; index < files.length; index++) {
    const file = files[index], path = targets[index]
    if (ready.has(index)) {
      written.push({ relativePath: file.relativePath, path, uid: file.uid, gid: file.gid, mode: file.mode, action: 'skip' })
      continue
    }
    let handle, failed = false
    try {
      handle = await io.open(path, 'wx', 0o600)
      if (!['writeFile', 'chown', 'chmod', 'sync', 'close'].every(name => typeof handle?.[name] === 'function')) fail(WRITE_ERROR)
      await handle.writeFile(file.bytes)
      await handle.chown(file.uid, file.gid)
      await handle.chmod(Number.parseInt(file.mode, 8))
      await handle.sync()
    } catch (_error) { failed = true }
    finally {
      if (handle) {
        try { await handle.close() }
        catch (_error) { failed = true }
      }
    }
    if (failed) throw new CandidateError(WRITE_ERROR)
    written.push({ relativePath: file.relativePath, path, uid: file.uid, gid: file.gid, mode: file.mode, action: 'written' })
  }
  return written
}
