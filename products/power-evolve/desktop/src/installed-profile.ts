/** Prepare the application-owned Device Profile without loading plugins or changing execution data. */
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, symlink, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { InstalledDesktopConfig } from './installed-config.ts'

const devicePackage = '@power-evolve/device'
const manifestByteLimit = 64 * 1024

/** Main-parsed image and Worker budgets (milliseconds except stop grace seconds); installation supplies paths and origins. */
export interface DeviceWorkerParameters {
  readonly image: string
  readonly pollMs: number
  readonly contactGraceMs: number
  readonly commandPollMs: number
  readonly platformRequestTimeoutMs: number
  readonly dockerCommandTimeoutMs: number
  readonly dockerStopTimeoutMs: number
  readonly dockerStopGraceSeconds: number
  readonly directoryPickerTimeoutMs: number
  readonly fileOperationTimeoutMs: number
}

function invalid(): Error { return new Error('PowerEvolve desktop: invalid installed Device Profile') }
function contains(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino }
function owned(info: Stats): boolean { return process.getuid !== undefined && info.uid === process.getuid() }
async function optionalStat(path: string): Promise<Stats | undefined> {
  try { return await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function privateDirectory(path: string): Promise<void> {
  const before = await lstat(path)
  if (!before.isDirectory() || !owned(before) || (before.mode & 0o777) !== 0o700) throw invalid()
  const descriptor = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (!sameFile(before, await descriptor.stat())) throw invalid()
  } finally { await descriptor.close() }
}
async function syncDirectory(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await descriptor.sync() }
  finally { await descriptor.close() }
}
async function ensureDirectories(root: string, path: string): Promise<void> {
  if (!contains(root, path)) throw invalid()
  await privateDirectory(root)
  const parts = relative(root, path).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    const next = join(current, part)
    if (await optionalStat(next) === undefined) {
      await mkdir(next, { mode: 0o700 })
      await syncDirectory(current)
    }
    await privateDirectory(next)
    current = next
  }
}
async function reservedFile(path: string): Promise<void> {
  const info = await optionalStat(path)
  if (info !== undefined && (!info.isFile() || !owned(info) || (info.mode & 0o777) !== 0o600)) throw invalid()
}
async function resourceBundle(root: string, selected: string): Promise<string> {
  if (!isAbsolute(selected) || !contains(root, selected)) throw invalid()
  let current = root
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || await realpath(root) !== root) throw invalid()
  for (const part of relative(root, selected).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (!contains(root, await realpath(current))) throw invalid()
  }
  const physical = await realpath(selected)
  if (!(await lstat(physical)).isDirectory()) throw invalid()
  const path = join(physical, 'package.json')
  const before = await lstat(path)
  if (!before.isFile()) throw invalid()
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await descriptor.stat()
    if (!info.isFile() || !sameFile(before, info) || info.size > manifestByteLimit) throw invalid()
    const bytes = await descriptor.readFile()
    if (bytes.length > manifestByteLimit) throw invalid()
    const manifest: unknown = JSON.parse(bytes.toString('utf8'))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
      || !('name' in manifest) || manifest.name !== devicePackage) throw invalid()
  } finally { await descriptor.close() }
  return physical
}
async function reservedLink(path: string): Promise<void> {
  const info = await optionalStat(path)
  // This one projection is replaced without following its previous target during an upgrade.
  if (info !== undefined && (!info.isSymbolicLink() || !owned(info))) throw invalid()
}
async function retainedPlatform(path: string, platformOrigin: string, privateDir: string): Promise<void> {
  if (await optionalStat(path) === undefined) {
    for (const name of ['device.json', 'journal.json']) {
      if (await optionalStat(join(privateDir, name)) !== undefined) throw invalid()
    }
    return
  }
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await descriptor.stat()
    if (!info.isFile() || !owned(info) || (info.mode & 0o777) !== 0o600 || info.size > manifestByteLimit) throw invalid()
    const bytes = await descriptor.readFile()
    if (bytes.length > manifestByteLimit) throw invalid()
    const rows: unknown = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(rows)) throw invalid()
    const devices = rows.filter((row: unknown) => row !== null && typeof row === 'object'
      && 'id' in row && row.id === 'power-evolve-device')
    if (devices.length !== 1) throw invalid()
    const device: unknown = devices[0]
    if (device === null || typeof device !== 'object' || !('config' in device)
      || device.config === null || typeof device.config !== 'object'
      || !('platformUrl' in device.config) || device.config.platformUrl !== platformOrigin) throw invalid()
  } finally { await descriptor.close() }
}
async function replaceFile(path: string, bytes: string): Promise<void> {
  const temporary = join(dirname(path), `.device-profile-${randomUUID()}`)
  const descriptor = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try { await descriptor.writeFile(bytes); await descriptor.sync() }
    finally { await descriptor.close() }
    await reservedFile(path)
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    try { await unlink(temporary) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
async function replaceLink(path: string, target: string): Promise<void> {
  const temporary = join(dirname(path), `.device-profile-${randomUUID()}`)
  await symlink(relative(dirname(path), target), temporary, 'dir')
  try {
    await reservedLink(path)
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    try { await unlink(temporary) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * Prepare the fixed Device Profile under the installed configuration's private Harness Home.
 * The caller holds Electron's single-instance lock and has not started its owned Device. This
 * operation does not establish that an old writer stopped and never removes journals, locks or
 * other Home files. Its three reserved files are individually fsynced and atomically replaced;
 * callers must await completion before launching the official dsh Profile. Reopening completes
 * an interrupted preparation without installing dependencies or executing resource code. The
 * retained product patch must bind the same Platform origin before any replacement or child launch;
 * another deployment uses a new installed namespace. This check does not detect database replacement
 * behind an unchanged origin. Installed namespaces retain one OS-user writer coordinator; preparing
 * it never clears an unresolved slot or establishes that a writer stopped.
 * @param config - Main-parsed installed resources, origins and fixed owner-only state paths.
 * @param worker - Main-parsed image and explicit execution budgets; no origins or local paths.
 * @param bundleDirectory - Main-selected Device package inside the fixed physical resources root.
 * @returns The prepared Profile directory and installation-derived readiness-file path.
 */
export async function prepareInstalledDeviceProfile(
  config: InstalledDesktopConfig,
  worker: DeviceWorkerParameters,
  bundleDirectory: string,
): Promise<{ profileDir: string; readyFile: string }> {
  try {
    const bundle = await resourceBundle(config.resources.root, bundleDirectory)
    const root = config.state.productUserDataPath
    for (const path of [config.state.homeDir, config.state.workingDir, config.state.privateDir]) {
      await ensureDirectories(root, path)
    }
    const coordinatorParent = dirname(config.state.coordinationRoot)
    if (await optionalStat(coordinatorParent) === undefined) {
      await mkdir(coordinatorParent, { mode: 0o700 })
      await syncDirectory(dirname(coordinatorParent))
    }
    await ensureDirectories(coordinatorParent, config.state.coordinationRoot)
    const profileDir = join(config.state.homeDir, 'profiles', config.deviceConfig.profile)
    const scope = join(profileDir, 'node_modules', '@power-evolve')
    await ensureDirectories(root, scope)
    const files = ['package.json', 'cordis.yml', 'cordis.patch.yml']
    for (const file of files) await reservedFile(join(profileDir, file))
    await retainedPlatform(join(profileDir, 'cordis.patch.yml'), config.config.platformOrigin, config.state.privateDir)
    const projection = join(scope, 'device')
    await reservedLink(projection)
    const readyFile = join(config.state.privateDir, 'ready.json')
    await reservedFile(readyFile)
    const loopback = new URL(config.deviceConfig.loopbackOrigin)
    const patch = [
      { id: 'web-server', config: { host: loopback.hostname, port: Number(loopback.port) } },
      { id: 'power-evolve-device', config: {
        platformUrl: config.config.platformOrigin, privateDir: config.state.privateDir,
        coordinationRoot: config.state.coordinationRoot, pythonExecutable: config.resources.pythonExecutable,
        image: worker.image, pollMs: worker.pollMs, contactGraceMs: worker.contactGraceMs,
        commandPollMs: worker.commandPollMs, platformRequestTimeoutMs: worker.platformRequestTimeoutMs,
        dockerCommandTimeoutMs: worker.dockerCommandTimeoutMs, dockerStopTimeoutMs: worker.dockerStopTimeoutMs,
        dockerStopGraceSeconds: worker.dockerStopGraceSeconds, directoryPickerTimeoutMs: worker.directoryPickerTimeoutMs,
        fileOperationTimeoutMs: worker.fileOperationTimeoutMs, readyFile,
      } },
    ]
    const manifest = { name: `dsh-profile-${config.deviceConfig.profile}`, private: true, dependencies: {},
      dsh: { profile: { bundles: [devicePackage] } } }
    await replaceFile(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    await replaceFile(join(profileDir, 'cordis.yml'), '[]\n')
    await replaceFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify(patch, null, 2) + '\n')
    await replaceLink(projection, bundle)
    return { profileDir, readyFile }
  } catch (_profilePreparationFailure) {
    // Filesystem and parser failures may contain private local paths or resource JSON.
    throw invalid()
  }
}
