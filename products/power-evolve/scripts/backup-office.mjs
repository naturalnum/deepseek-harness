/** Preserve stopped Office cache bytes and explicit configuration independently of live Workspace mounts. */
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inventoryBackupTree } from './backup-state.mjs'
import { copyPosixTree } from './backup-posix.mjs'
import { canonicalBackupPath, requireSeparateBackupPaths } from './backup-support.mjs'

const configFile = 'config/office-preview.json', cacheDirectory = 'data/office-previews'
const maximumFileBytes = 8 * 1024 * 1024, maximumConfigBytes = 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const fail = () => { throw new Error('Invalid Office backup materials') }
const check = value => { if (!value) fail() }
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const absolute = path => typeof path === 'string' && isAbsolute(path) && path !== '/'
  && resolve(path) === path && !/[\\\u0000-\u001f\u007f]/u.test(path)
async function exists(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function physical(path, directory, missing = false) {
  const info = await exists(path)
  if (!info && missing) {
    check(await canonicalBackupPath(path) === path); return null
  }
  check(info && (directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink())
  check(await realpath(path) === path)
  if (directory) check((info.mode & 0o077) === 0)
  return info
}
async function bytes(path, maximum, privateOnly = false) {
  const info = await physical(path, false)
  check(info.nlink === 1 && info.size <= maximum && (!privateOnly || (info.mode & 0o077) === 0))
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat(); check(before.isFile() && before.ino === info.ino && before.dev === info.dev)
    const value = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < value.length) {
      const { bytesRead } = await handle.read(value, length, value.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat(), current = await lstat(path)
    check(length === info.size && after.size === info.size && after.nlink === 1
      && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs && !current.isSymbolicLink()
      && current.ino === info.ino && current.dev === info.dev)
    return value.subarray(0, length)
  } finally { await handle.close() }
}
async function cacheInventory(root, missing = false) {
  if (!await physical(root, true, missing)) return []
  async function walk(path) {
    const info = await lstat(path)
    check(!info.isSymbolicLink())
    if (info.isDirectory()) {
      check((info.mode & 0o077) === 0)
      for (const name of await readdir(path)) await walk(join(path, name))
    } else check(info.isFile() && info.nlink === 1 && info.size <= maximumFileBytes)
  }
  await walk(root)
  return inventoryBackupTree(root)
}

/** Validate a caller's explicit source or target configuration file and physical cache root.
 * @param selection Null for a disabled feature, otherwise exact configFile/cacheRoot absolute paths.
 * @returns The selection, or null; no files or credentials are read.
 */
export function validateOfficeBackupSelection(selection) {
  if (selection === undefined || selection === null) return null
  check(exact(selection, ['configFile', 'cacheRoot']) && absolute(selection.configFile) && absolute(selection.cacheRoot))
  return selection
}

/** Read explicit private settings through the Application startup parser; no Kubernetes client is created.
 * @param selection Validated configFile/cacheRoot selection.
 * @param protectedRoots All Workspace, Home, artifact and Skill roots that must not overlap the cache.
 * @returns Original configuration bytes and validated settings.
 */
export async function readOfficeBackupSelection(selection, protectedRoots) {
  selection = validateOfficeBackupSelection(selection)
  if (!selection) return null
  try {
    await requireSeparateBackupPaths([selection.cacheRoot], [...protectedRoots, selection.configFile])
    const value = await bytes(selection.configFile, maximumConfigBytes, true)
    const { loadOfficePreviewConfig } = await import('../application/lib/platform/office-preview-config.js')
    const settings = await loadOfficePreviewConfig(selection.configFile, 'in-cluster', protectedRoots, async () => value.toString('utf8'))
    check(settings.localRoot === selection.cacheRoot)
    await physical(selection.cacheRoot, true, true)
    return { selection, settings, bytes: value }
  } catch (_configurationError) { throw new Error('Cannot inspect Office backup configuration') }
}

/** Bind all retained Office records without recording user inputs or credentials.
 * @param state Read-only backup state; schemas before Office have an empty census.
 * @returns Counts and canonical digest over job/source/converter/result/stop metadata.
 */
export function officeBackupCensus(state) {
  const rows = state.officeJobs
  check(Array.isArray(rows))
  return { records: rows.length, byteRecords: rows.filter(row => row.source_snapshot !== null).length,
    sha256: digest(canonical(rows)) }
}

/** Validate new-format census metadata before touching a restore destination.
 * @param census Canonical digest and total/byte-dependent record counts in the bundle.
 * @param material Office cache descriptor, or null only for a census without byte-dependent jobs.
 * @returns The census; a descriptor must carry the identical census.
 */
export function validateOfficeBackupCensus(census, material) {
  check(exact(census, ['records', 'byteRecords', 'sha256']) && sha256(census.sha256)
    && Number.isSafeInteger(census.records) && Number.isSafeInteger(census.byteRecords)
    && census.records >= census.byteRecords && census.byteRecords >= 0)
  if (material !== null) check(isDeepStrictEqual(descriptor(material).census, census))
  else check(census.byteRecords === 0)
  return census
}
async function verifyRecords(root, state) {
  for (const row of state.officeJobs) {
    const source = row.source_snapshot
    if (source === null) continue
    check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row.id)
      && source.jobId === row.id && ['doc', 'docx', 'ppt', 'pptx'].includes(source.extension)
      && /^[a-f0-9]{64}$/u.test(source.sourceSha256) && Number.isSafeInteger(source.sourceBytes)
      && source.sourceBytes >= 0 && source.sourceBytes <= 2 * 1024 * 1024)
    const input = join(root, row.id, 'input'), output = join(root, row.id, 'output')
    const job = await bytes(join(input, 'job.json'), 64 * 1024)
    check(isDeepStrictEqual(JSON.parse(job), source))
    const original = await bytes(join(input, `source.${source.extension}`), 2 * 1024 * 1024)
    check(original.length === source.sourceBytes && digest(original) === source.sourceSha256)
    if (row.result !== null) {
      const result = row.result
      check(result.jobId === row.id && result.nonce === source.nonce && result.generation === source.generation
        && result.sourceSha256 === source.sourceSha256 && Number.isSafeInteger(result.pdfBytes)
        && result.pdfBytes > 0 && result.pdfBytes <= maximumFileBytes)
      check(isDeepStrictEqual(JSON.parse(await bytes(join(output, 'result.json'), 64 * 1024)), result))
      const pdf = await bytes(join(output, 'result.pdf'), maximumFileBytes)
      check(pdf.length === result.pdfBytes && digest(pdf) === result.pdfSha256
        && pdf.subarray(0, 5).toString('ascii') === '%PDF-' && pdf.subarray(-1024).includes(Buffer.from('%%EOF')))
    }
    if (row.worker_observation?.failure) {
      check(isDeepStrictEqual(JSON.parse(await bytes(join(output, 'failure.json'), 64 * 1024)), row.worker_observation.failure))
    }
  }
}
function descriptor(value) {
  check(exact(value, ['format', 'sourceConfigFile', 'sourceCacheRoot', 'configFile', 'configSha256', 'cacheDirectory', 'cacheFiles', 'census'])
    && value.format === 1 && absolute(value.sourceConfigFile) && absolute(value.sourceCacheRoot)
    && value.configFile === configFile && value.cacheDirectory === cacheDirectory
    && sha256(value.configSha256) && Array.isArray(value.cacheFiles)
    && exact(value.census, ['records', 'byteRecords', 'sha256']) && sha256(value.census.sha256)
    && Number.isSafeInteger(value.census.records) && Number.isSafeInteger(value.census.byteRecords)
    && value.census.records >= value.census.byteRecords && value.census.byteRecords >= 0)
  return value
}

/** Copy a stopped cache, original configuration and census into the private bundle.
 * @param prepared Explicit source settings from readOfficeBackupSelection, or null.
 * @param bundle Existing stopped backup staging directory.
 * @param state Actual read-only PG census after all writers and parser Pods have stopped.
 * @returns Version-one descriptor, or null only when no recorded job requires cache bytes.
 */
export async function captureOfficeBackup(prepared, bundle, state) {
  const census = officeBackupCensus(state)
  if (!prepared) {
    if (census.byteRecords) throw new Error('Recorded Office jobs require explicit cache backup configuration')
    return null
  }
  try {
    await requireSeparateBackupPaths([bundle], [prepared.selection.cacheRoot, prepared.selection.configFile])
    const before = await cacheInventory(prepared.selection.cacheRoot, true)
    await verifyRecords(prepared.selection.cacheRoot, state)
    const target = join(bundle, cacheDirectory)
    check(!await exists(target)); await copyPosixTree(prepared.selection.cacheRoot, target)
    const copied = await cacheInventory(target)
    check(isDeepStrictEqual(copied, before) && isDeepStrictEqual(await cacheInventory(prepared.selection.cacheRoot, true), before))
    await verifyRecords(target, state)
    check((await bytes(prepared.selection.configFile, maximumConfigBytes, true)).equals(prepared.bytes))
    await mkdir(join(bundle, 'config'), { recursive: true, mode: 0o700 })
    await writeFile(join(bundle, configFile), prepared.bytes, { mode: 0o600, flag: 'wx' })
    return { format: 1, sourceConfigFile: prepared.selection.configFile, sourceCacheRoot: prepared.selection.cacheRoot,
      configFile, configSha256: digest(prepared.bytes), cacheDirectory, cacheFiles: copied, census }
  } catch (_captureError) { throw new Error('Office cache backup failed') }
}

/** Validate source bytes and fresh explicit target placement before restore mutations.
 * @param material Version-one Office descriptor, or null for a legacy/disabled bundle.
 * @param bundle Integrity-checked private bundle directory.
 * @param prepared Explicit target settings from readOfficeBackupSelection, or null.
 * @param protectedRoots Fresh target roots and original source roots that the cache must not overlap.
 * @returns Opaque restore preparation; no target files or database are changed.
 */
export async function prepareRestoredOfficeBackup(material, bundle, prepared, protectedRoots) {
  if (!material) {
    check(!prepared); return null
  }
  try {
    material = descriptor(material); check(prepared)
    const root = prepared.selection.cacheRoot
    await requireSeparateBackupPaths([root], [...protectedRoots, bundle, material.sourceCacheRoot, material.sourceConfigFile, prepared.selection.configFile])
    await requireSeparateBackupPaths([prepared.selection.configFile], [...protectedRoots, bundle, material.sourceCacheRoot, material.sourceConfigFile])
    check(!await exists(root))
    const sourceBytes = await bytes(join(bundle, material.configFile), maximumConfigBytes, true)
    check(digest(sourceBytes) === material.configSha256)
    const source = JSON.parse(sourceBytes), target = JSON.parse(prepared.bytes)
    check(source.localRoot === material.sourceCacheRoot)
    const { loadOfficePreviewConfig } = await import('../application/lib/platform/office-preview-config.js')
    await loadOfficePreviewConfig(material.sourceConfigFile, 'in-cluster', [], async () => sourceBytes.toString('utf8'))
    const placement = new Set(['namespace', 'volumeClaimName', 'volumeSubPath', 'localRoot'])
    const settings = value => Object.fromEntries(Object.entries(value).filter(([key]) => !placement.has(key)))
    check(isDeepStrictEqual(settings(source), settings(target)))
    check(isDeepStrictEqual(await cacheInventory(join(bundle, material.cacheDirectory)), material.cacheFiles))
    return { material, bundle, prepared }
  } catch (_preparationError) { throw new Error('Office cache restore preparation failed') }
}

/** Restore immutable cache bytes into an absent root; ambiguous failures remain stopped partial output.
 * @param preparation Office preparation from prepareRestoredOfficeBackup, or null.
 * @returns Cache root and original inventory digest, or null.
 */
export async function writeRestoredOfficeBackup(preparation) {
  if (!preparation) return null
  try {
    const { material, bundle, prepared } = preparation, root = prepared.selection.cacheRoot
    check((await bytes(prepared.selection.configFile, maximumConfigBytes, true)).equals(prepared.bytes))
    check(!await exists(root) && await canonicalBackupPath(root) === root)
    await mkdir(dirname(root), { recursive: true, mode: 0o700 })
    await copyPosixTree(join(bundle, material.cacheDirectory), root)
    check(isDeepStrictEqual(await cacheInventory(root), material.cacheFiles))
    return { cacheRoot: root, configFile: prepared.selection.configFile, configSha256: digest(prepared.bytes),
      originalConfigSha256: material.configSha256, cacheInventorySha256: digest(canonical(material.cacheFiles)) }
  } catch (_restoreError) { throw new Error('Office cache restore failed; target remains stopped and partial') }
}

/** Recheck restored PG against actual preserved cache bytes before startup or successful restore.
 * @param material Original Office descriptor, or null when the old bundle has no Office mapping.
 * @param restored Cache root and explicit target configuration digest from writeRestoredOfficeBackup, or null.
 * @param state Actual read-only restored PG state.
 * @returns Completion only for exact census and byte bindings; absence never triggers conversion.
 */
export async function verifyRestoredOfficeBackup(material, restored, state) {
  const census = officeBackupCensus(state)
  if (!material) {
    if (census.byteRecords) throw new Error('Legacy backup omits recorded Office cache; restore remains stopped and partial; use a fresh target')
    return
  }
  try {
    material = descriptor(material); check(isDeepStrictEqual(census, material.census))
    check(restored && absolute(restored.cacheRoot) && absolute(restored.configFile)
      && digest(await bytes(restored.configFile, maximumConfigBytes, true)) === restored.configSha256)
    const root = restored.cacheRoot
    check(isDeepStrictEqual(await cacheInventory(root), material.cacheFiles))
    await verifyRecords(root, state)
  } catch (_verificationError) { throw new Error('Restored Office census, configuration or cache bytes differ; target remains stopped and partial') }
}
