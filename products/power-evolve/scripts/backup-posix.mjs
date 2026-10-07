/** Resolve trial storage, check package bytes and restore mount ownership before starting writers. */
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { cp, lchown, lstat, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

function storageLayout(value) {
  const fields = ['format', 'sharedRoot', 'workspaceRoot', 'artifactRoot', 'skillLibraryRoot']
  if (!value || value.format !== 1 || Object.keys(value).length !== fields.length
    || fields.some(field => !Object.hasOwn(value, field))
    || fields.slice(1).some(field => typeof value[field] !== 'string' || !isAbsolute(value[field])
      || resolve(value[field]) !== value[field])) throw new Error('Unknown trial storage layout')
  return value
}

/**
 * Resolve prepared storage roots without losing an override when trial startup filters its environment.
 * @param {string} privateDir - Absolute private trial directory.
 * @param {object | null} sandbox - Trial Sandbox configuration, or null for a conversation-only trial.
 * @param {object} env - Explicit environment overrides for preparation or backup.
 * @param {boolean} requireRecorded - Refuse to guess a running source trial's storage layout.
 * @returns {Promise<object>} Validated storage roots, retaining the recorded layout on later starts.
 */
export async function resolveTrialStorage(privateDir, sandbox, env, requireRecorded = false) {
  const privateRoot = resolve(privateDir)
  let recorded
  try { recorded = storageLayout(JSON.parse(await readFile(join(privateRoot, 'storage-layout.json'), 'utf8'))) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (requireRecorded) throw new Error('Prepare the trial storage layout before backing it up')
  }
  const explicit = (key, fallback) => {
    const value = env[key] || fallback
    if (!isAbsolute(value)) throw new Error(`Trial storage root ${key} must be absolute`)
    return resolve(value)
  }
  const sharedRoot = sandbox ? resolve(sandbox.localRoot) : privateRoot
  const layout = storageLayout({ format: 1, sharedRoot,
    workspaceRoot: explicit('PE_WORKSPACE_ROOT', sandbox?.workspaceRoot
      || recorded?.workspaceRoot || join(privateRoot, 'workspaces')),
    artifactRoot: explicit('PE_ARTIFACT_ROOT', recorded?.artifactRoot || join(privateRoot, 'artifacts')),
    skillLibraryRoot: explicit('PE_SKILL_LIBRARY_ROOT', sandbox?.localRoot
      || recorded?.skillLibraryRoot || env.PE_SANDBOX_LOCAL_ROOT || join(privateRoot, 'skill-library')) })
  if (sandbox && (layout.workspaceRoot !== join(sharedRoot, 'workspaces')
    || layout.skillLibraryRoot !== sharedRoot)) throw new Error('Sandbox and trial storage roots differ')
  if (recorded && Object.keys(layout).some(field => layout[field] !== recorded[field])) {
    throw new Error('Trial storage roots differ from its recorded layout; use a fresh trial')
  }
  return layout
}

/**
 * Map the stable backup directory names to the trial's actual source or restore destinations.
 * @param {object} layout - Validated trial storage layout.
 * @param {string} name - One of workspaces, homes, skill-packages or artifacts.
 * @returns {string} Absolute POSIX path for that data tree.
 */
export function trialDataPath(layout, name) {
  switch (name) {
    case 'workspaces': return layout.workspaceRoot
    case 'homes': return join(layout.sharedRoot, 'homes')
    case 'skill-packages': return join(layout.skillLibraryRoot, 'skill-packages')
    case 'artifacts': return layout.artifactRoot
    default: throw new Error('Unknown backup data tree')
  }
}

/**
 * Validate legacy and explicit storage layouts, including a separately placed Office cache.
 * @param {object} manifest - Parsed backup manifest.
 * @returns {string[]} Source roots that restore destinations must not overlap.
 */
export function backupSourceRoots(manifest) {
  if (!manifest || typeof manifest.sourceSharedRoot !== 'string' || !isAbsolute(manifest.sourceSharedRoot)
    || resolve(manifest.sourceSharedRoot) !== manifest.sourceSharedRoot) throw new Error('Unknown backup storage layout')
  if (manifest.format === 1 && !Object.hasOwn(manifest, 'storage')) return [manifest.sourceSharedRoot]
  if (![2, 3].includes(manifest.format)) throw new Error('Unknown backup storage layout')
  const layout = storageLayout(manifest.storage)
  if (layout.sharedRoot !== manifest.sourceSharedRoot) throw new Error('Inconsistent backup storage layout')
  const roots = [layout.sharedRoot, layout.workspaceRoot, layout.artifactRoot, layout.skillLibraryRoot]
  if (manifest.format === 3 && manifest.officeCache) {
    const root = manifest.officeCache.sourceCacheRoot
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root === '/') {
      throw new Error('Invalid Office backup source root')
    }
    roots.push(root)
  }
  return roots
}

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
 * Refuse a storage tree that omits any recorded package version, including revoked or superseded versions.
 * Requires the built application verifier, as does the trial's Profile launcher.
 * @param {string} root - Actual skill-packages directory in a stopped trial or freshly restored tree.
 * @param {readonly object[]} versions - Owner, archive digest and manifest digest rows from PostgreSQL.
 * @returns {Promise<void>} Resolves when every recorded version has all its original files.
 */
export async function requireSkillPackageVersions(root, versions) {
  await realRoot(root)
  if (!versions.length) return
  const { verifyPublishedSkillPackage } = await import('../application/lib/platform/skill-package-manifest.js')
  for (const version of versions) {
    requireUuid(version.user_id)
    if (![version.archive_digest, version.manifest_digest].every(value => /^[a-f0-9]{64}$/u.test(value))) {
      throw new Error('Invalid stored Skill package digest')
    }
    const userRoot = join(root, version.user_id)
    const archiveRoot = join(userRoot, 'sha256')
    const packageRoot = join(archiveRoot, version.archive_digest)
    for (const directory of [userRoot, archiveRoot, packageRoot]) await realRoot(directory)
    if (typeof version.manifest !== 'string' || Buffer.byteLength(version.manifest) > 128 * 1024
      || createHash('sha256').update(version.manifest).digest('hex') !== version.manifest_digest) {
      throw new Error('Backup Skill package version manifest is inconsistent')
    }
    const document = JSON.parse(version.manifest)
    if (document.schemaVersion !== 1 || document.artifactSha256 !== version.archive_digest
      || !Array.isArray(document.files) || document.files.length < 1 || document.files.length > 256
      || !document.files.some(file => file.path === 'skill/SKILL.md')
      || document.files.some(file => typeof file.path !== 'string' || !file.path.startsWith('skill/')
        || file.path.split('/').some(part => !part || part === '.' || part === '..') || /[\\:\0]/u.test(file.path)
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 8 * 1024 * 1024
        || !/^[a-f0-9]{64}$/u.test(file.sha256))) throw new Error('Unknown Skill package manifest')
    await verifyPublishedSkillPackage(packageRoot, version.manifest, document.files)
  }
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
 * @param {{storageRootKeys: readonly string[], userIds: readonly string[]}} resources - Immutable physical roots and Home owners from restored PG rows.
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
  for (const [directory, ids] of [['workspaces', resources.storageRootKeys], ['homes', resources.userIds]]) {
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
