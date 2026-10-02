/** Capture fixed Deployment projections and restore private files without creating Secrets or starting writers.
 * Callers freeze configuration first and supply a real, private materialized projection directory, not Kubernetes symlinks.
 */
import { constants } from 'node:fs'
import { createHash, X509Certificate } from 'node:crypto'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { requireSeparateBackupPaths } from '../scripts/backup-support.mjs'
import { remoteMcpConfigPath, remoteMcpKeyPath, remoteMcpCaPath, remoteMcpMountedMetadata } from './remote-mcp.mjs'
import { validateRemoteMcpStartup } from './start.mjs'
import { validateAccountStartup } from './accounts.mjs'

const logicalRoot = '/run/power-evolve/private'
const bundleDirectory = 'config/deployment-private'
const baseFiles = ['users.json', 'worker-token', 'model-key', 'connector-key', 'runner-key', 'account-management.json']
const maxBytes = 1024 * 1024, maxFiles = 128
const preparedFiles = new WeakMap()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const refuse = () => { throw new Error('Invalid Deployment backup private materials') }
const check = value => { if (!value) refuse() }
const text = bytes => { const value = bytes.toString('utf8'); check(Buffer.from(value).equals(bytes)); return value }

function features(input) {
  check(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => ['ssh', 'remoteMcp', 'notesCa'].includes(key)))
  const result = {}
  for (const key of ['ssh', 'remoteMcp', 'notesCa']) {
    check(input[key] === undefined || typeof input[key] === 'boolean')
    result[key] = input[key] ?? false
  }
  return result
}
function absolute(path) {
  check(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path !== '/'
    && path.trim() === path && !/[\u0000-\u001f\u007f\\]/u.test(path))
  return path
}
async function directory(path, privateOnly = true) {
  const info = await lstat(path)
  check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & (privateOnly ? 0o077 : 0o022)) === 0)
}
async function absent(path) {
  try { await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  refuse()
}
function relative(logical) {
  check(typeof logical === 'string' && logical.startsWith(logicalRoot + '/'))
  return logical.slice(logicalRoot.length + 1)
}
function allowed(path, selected) {
  if (baseFiles.includes(path)) return true
  if (path === 'ssh-credential-key') return selected.ssh
  if (path === 'qa-notes-ca.pem') return selected.notesCa
  if (!selected.remoteMcp) return false
  if ([relative(remoteMcpConfigPath), relative(remoteMcpKeyPath)].includes(path)) return true
  if (!path.startsWith('remote-mcp/ca/')) return false
  try { return relative(remoteMcpCaPath(path.slice('remote-mcp/ca/'.length))) === path }
  catch { return false }
}
async function privateBytes(root, path) {
  const pieces = path.split('/')
  check(pieces.every(piece => piece && piece !== '.' && piece !== '..') && !/[\\\u0000-\u001f\u007f]/u.test(path))
  for (let count = 1; count < pieces.length; count++) await directory(join(root, ...pieces.slice(0, count)))
  const filename = join(root, path), info = await lstat(filename)
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.size > 0 && info.size <= maxBytes)
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat()
    check(opened.isFile() && opened.ino === info.ino && opened.dev === info.dev && opened.size === info.size)
    const bytes = await file.readFile()
    check(bytes.length === info.size && bytes.length <= maxBytes)
    text(bytes)
    return bytes
  } finally { await file.close() }
}
function requiredPaths(selected, files) {
  const paths = [...baseFiles, ...(selected.ssh ? ['ssh-credential-key'] : []), ...(selected.notesCa ? ['qa-notes-ca.pem'] : [])]
  if (selected.remoteMcp) {
    const configuration = JSON.parse(text(files.get(relative(remoteMcpConfigPath))))
    paths.push(...remoteMcpMountedMetadata(configuration).paths.map(relative))
  }
  return [...new Set(paths)].sort()
}
async function validateMaterials(selected, files) {
  const required = requiredPaths(selected, files)
  check(required.length <= maxFiles && JSON.stringify([...files.keys()].sort()) === JSON.stringify(required))
  const readText = async logical => {
    check(required.includes(relative(logical)))
    return text(files.get(relative(logical)))
  }
  await validateAccountStartup('', readText)
  if (selected.remoteMcp) await validateRemoteMcpStartup(remoteMcpConfigPath, readText)
  if (selected.ssh) {
    const { SshCredentialCipher } = await import('../application/lib/platform/ssh-credentials.js')
    new SshCredentialCipher(text(files.get('ssh-credential-key')))
  }
  if (selected.notesCa) {
    const certificates = text(files.get('qa-notes-ca.pem')).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu)
    check(certificates?.length && certificates.every(pem => new X509Certificate(pem).ca))
  }
}
async function writeFiles(root, files) {
  await mkdir(root, { mode: 0o700 })
  const directories = new Set([root])
  for (const [path, bytes] of files) {
    const parts = path.split('/')
    for (let count = 1; count < parts.length; count++) {
      const parent = join(root, ...parts.slice(0, count))
      if (!directories.has(parent)) { await mkdir(parent, { mode: 0o700 }); directories.add(parent) }
    }
    const file = await open(join(root, path), 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  }
  for (const path of [...directories].reverse()) {
    const file = await open(path, 'r')
    try { await file.sync() } finally { await file.close() }
  }
}
function descriptorFiles(descriptor) {
  check(descriptor && descriptor.format === 1 && descriptor.kind === 'power-evolve-deployment-private'
    && Object.keys(descriptor).sort().join(',') === 'features,files,format,kind,sourceProjectedRoot'
    && Array.isArray(descriptor.files) && descriptor.files.length <= maxFiles)
  absolute(descriptor.sourceProjectedRoot)
  check(descriptor.features && Object.keys(descriptor.features).sort().join(',') === 'notesCa,remoteMcp,ssh')
  const selected = features(descriptor.features), paths = new Set()
  for (const entry of descriptor.files) {
    check(entry && Object.keys(entry).sort().join(',') === 'file,path,sha256,size'
      && typeof entry.path === 'string' && allowed(entry.path, selected) && !paths.has(entry.path)
      && entry.file === bundleDirectory + '/' + entry.path && /^[a-f0-9]{64}$/u.test(entry.sha256)
      && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= maxBytes)
    paths.add(entry.path)
  }
  return selected
}

/** Capture only six required files and explicitly enabled SSH/MCP/Notes material; never database-url or model.env.
 * @param projectedRoot Absolute private physical mirror of /run/power-evolve/private, with real directories and files.
 * @param bundleRoot Existing private backup staging directory; config/deployment-private must be absent.
 * @param selected Explicit ssh, remoteMcp and notesCa feature switches supplied by the Deployment operator.
 * @returns Version-one file descriptor containing paths, sizes and digests, without private contents.
 */
export async function captureDeploymentPrivate(projectedRoot, bundleRoot, selected = {}) {
  try {
    absolute(projectedRoot); absolute(bundleRoot); selected = features(selected)
    await directory(projectedRoot); await directory(bundleRoot)
    await requireSeparateBackupPaths([bundleRoot], [projectedRoot])
    const target = join(bundleRoot, bundleDirectory)
    await absent(target)
    const files = new Map()
    for (const path of [...baseFiles, ...(selected.ssh ? ['ssh-credential-key'] : []), ...(selected.notesCa ? ['qa-notes-ca.pem'] : []),
      ...(selected.remoteMcp ? [relative(remoteMcpConfigPath)] : [])]) files.set(path, await privateBytes(projectedRoot, path))
    for (const path of requiredPaths(selected, files)) if (!files.has(path)) files.set(path, await privateBytes(projectedRoot, path))
    await validateMaterials(selected, files)
    const config = join(bundleRoot, 'config')
    try { await directory(config) }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(config, { mode: 0o700 }) }
    await writeFiles(target, files)
    return { format: 1, kind: 'power-evolve-deployment-private', sourceProjectedRoot: projectedRoot, features: selected,
      files: [...files].map(([path, bytes]) => ({ path, file: bundleDirectory + '/' + path, size: bytes.length, sha256: digest(bytes) })) }
  } catch { throw new Error('Deployment private capture failed') }
}

/** Validate and preload a private descriptor before any restore mutation. Logical paths remain fixed for startup.
 * @param descriptor Version-one descriptor returned by captureDeploymentPrivate.
 * @param bundleRoot Existing private backup directory whose complete inventory the caller has verified.
 * @param targetRoot Absent absolute physical destination, separate from the source and bundle; its real parent must not be group/world writable.
 * @returns Opaque in-process preparation; serializing it exposes only target and file metadata.
 */
export async function prepareRestoredDeploymentPrivate(descriptor, bundleRoot, targetRoot) {
  try {
    absolute(bundleRoot); absolute(targetRoot)
    const selected = descriptorFiles(descriptor)
    await directory(bundleRoot); await directory(dirname(targetRoot), false); await absent(targetRoot)
    await requireSeparateBackupPaths([targetRoot], [bundleRoot, descriptor.sourceProjectedRoot])
    const files = new Map()
    for (const entry of descriptor.files) {
      const bytes = await privateBytes(bundleRoot, entry.file)
      check(bytes.length === entry.size && digest(bytes) === entry.sha256)
      files.set(entry.path, bytes)
    }
    await validateMaterials(selected, files)
    const prepared = Object.freeze({ targetRoot, files: Object.freeze(descriptor.files.map(entry => Object.freeze({ ...entry }))) })
    preparedFiles.set(prepared, files)
    return prepared
  } catch { throw new Error('Deployment private restore preparation failed') }
}

/** Publish one validated preparation to fresh 0700 directories and exclusive 0600 files; failures leave partial output for inspection.
 * @param prepared Opaque preparation from prepareRestoredDeploymentPrivate, usable once in the same process.
 * @returns Absolute private root and relative file names; the caller separately supplies the target database URL and creates Secrets.
 */
export async function writeRestoredDeploymentPrivate(prepared) {
  try {
    const files = preparedFiles.get(prepared)
    check(files)
    await directory(dirname(prepared.targetRoot), false); await absent(prepared.targetRoot)
    preparedFiles.delete(prepared)
    try { await writeFiles(prepared.targetRoot, files) }
    finally { for (const bytes of files.values()) bytes.fill(0) }
    return { privateRoot: prepared.targetRoot, files: [...files.keys()] }
  } catch { throw new Error('Deployment private restore write failed') }
}
