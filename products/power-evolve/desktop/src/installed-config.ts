/** Main-owned installed resources and stable private state; no Profile or process is created here. */
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import { z } from 'zod'
import { parseCloudDesktopConfig, type CloudDesktopConfig } from './config.ts'
import { parseDesktopDeviceConfig } from './device-config.ts'

const descriptorName = 'power-evolve-desktop.json'
const maxDescriptorBytes = 64 * 1024
function physicalPath(path: string): boolean { return !path.split(/[\\/]/u).some(part => /\.asar$/iu.test(part)) }
const resourcePath = z.string().min(1).max(4096).refine(value => !isAbsolute(value)
  && physicalPath(value)
  && !/[\\:\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
const commandSearchDirectory = z.string().min(1).max(4096).refine(value => posix.isAbsolute(value)
  && !/[\\:\u0000-\u001f\u007f]/u.test(value)
  && !value.split('/').some(part => part === '.' || part === '..'))
const workerMilliseconds = z.number().int().min(100).max(60000)
const workerParameters = z.object({
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  pollMs: workerMilliseconds, contactGraceMs: workerMilliseconds,
  commandPollMs: z.number().int().min(10).max(60000), platformRequestTimeoutMs: workerMilliseconds,
  dockerCommandTimeoutMs: workerMilliseconds, dockerStopTimeoutMs: workerMilliseconds,
  dockerStopGraceSeconds: z.number().int().min(0).max(30),
  directoryPickerTimeoutMs: z.number().int().min(1000).max(120000), fileOperationTimeoutMs: workerMilliseconds,
}).strict().refine(value => value.dockerStopTimeoutMs > value.dockerStopGraceSeconds * 1000)
const descriptorV1 = z.object({
  kind: z.literal('power-evolve-desktop'), version: z.literal(1),
  deployment: z.unknown(),
  runtime: z.object({ nodeExecutable: resourcePath, cliEntrypoint: resourcePath,
    pythonExecutable: resourcePath, fileHelper: resourcePath, deviceBundle: resourcePath }).strict(),
  worker: workerParameters,
  device: z.object({
    profile: z.string(), loopbackOrigin: z.string(),
    commandSearchPath: z.array(commandSearchDirectory).min(1).max(32),
    startupTimeoutMs: z.number(), requestTimeoutMs: z.number(), quiesceTimeoutMs: z.number(), exitTimeoutMs: z.number(),
    maxOutputBytes: z.number(), maxMessageBytes: z.number(), maxHealthBytes: z.number(),
  }).strict(),
}).strict()
const descriptorV2 = descriptorV1.omit({ version: true }).extend({
  version: z.literal(2), stateNamespace: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
}).strict()
const descriptor = z.discriminatedUnion('version', [descriptorV1, descriptorV2])

/** Validated physical installation resources and fixed user paths for the later Profile bootstrap. */
export interface InstalledDesktopConfig {
  readonly config: CloudDesktopConfig
  readonly deviceConfig: ReturnType<typeof parseDesktopDeviceConfig>
  /** Ordered external POSIX directories for the installed Device child's PATH; not package resources. */
  readonly commandSearchPath: readonly string[]
  readonly worker: z.infer<typeof workerParameters>
  readonly resources: {
    readonly root: string
    readonly nodeExecutable: string
    readonly cliEntrypoint: string
    readonly pythonExecutable: string
    readonly fileHelper: string
    readonly deviceBundle: string
  }
  readonly state: {
    readonly productUserDataPath: string
    readonly homeDir: string
    readonly workingDir: string
    readonly privateDir: string
    /** One OS-user writer root retained across installed namespaces, including version 1. */
    readonly coordinationRoot: string
  }
}

function invalid(): Error { return new Error('PowerEvolve desktop: invalid installed configuration') }
function contains(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)
}
function directory(path: string): string {
  if (!isAbsolute(path) || !physicalPath(path)) throw invalid()
  const resolved = realpathSync(path)
  if (!physicalPath(resolved) || !statSync(resolved).isDirectory()) throw invalid()
  return resolved
}
function resource(root: string, path: string): string {
  const parts = resourcePath.parse(path).split('/')
  // A contained relative alias is allowed; an intermediate alias cannot leave the resource root.
  for (let index = 1; index <= parts.length; index++) {
    const resolved = realpathSync(join(root, ...parts.slice(0, index)))
    if (!physicalPath(resolved) || !contains(root, resolved)) throw invalid()
  }
  const resolved = realpathSync(join(root, ...parts))
  if (!physicalPath(resolved)) throw invalid()
  return resolved
}
function file(root: string, path: string, executable = false): string {
  const resolved = resource(root, path)
  if (!statSync(resolved).isFile()) throw invalid()
  accessSync(resolved, constants.R_OK | (executable ? constants.X_OK : 0))
  return resolved
}
function resourceDirectory(root: string, path: string): string {
  const resolved = resource(root, path)
  if (!statSync(resolved).isDirectory()) throw invalid()
  accessSync(resolved, constants.R_OK | constants.X_OK)
  return resolved
}
function readDescriptor(root: string): unknown {
  const path = file(root, descriptorName)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > maxDescriptorBytes) throw invalid()
    const bytes = readFileSync(fd)
    if (bytes.length > maxDescriptorBytes) throw invalid()
    return JSON.parse(bytes.toString('utf8'))
  } finally { closeSync(fd) }
}
function privateRoot(path: string, resources: string): string {
  if (contains(resources, path) || contains(path, resources)) throw invalid()
  let info: Stats
  try { info = lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
    throw error
  }
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700
    || process.getuid === undefined || info.uid !== process.getuid()) throw invalid()
  const root = directory(path)
  if (contains(resources, root) || contains(root, resources)) throw invalid()
  return root
}
function stateDirectory(root: string, ...parts: string[]): string {
  for (let index = 1; index <= parts.length; index++) {
    let info: Stats
    try { info = lstatSync(join(root, ...parts.slice(0, index))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
    // State does not follow aliases, including aliases that happen to point into the private root.
    if (!info.isDirectory() || info.uid !== process.getuid?.()) throw invalid()
  }
  return join(root, ...parts)
}

/**
 * Read the fixed installed description under Electron's main-selected resources directory.
 * Internal resource aliases must resolve to ordinary physical files inside that directory; ASAR
 * entries are refused, while physical .asar.unpacked resources are allowed. Node and Python must
 * be executable. The Device bundle directory remains inside resources. Worker timing is explicit
 * and the Runner image is an already-local immutable Docker image ID. The existing origin and
 * lifecycle-budget parsers remain authoritative. The required command search list contains
 * 1–32 absolute POSIX directory names, each at most 4096 characters without colon, backslash,
 * C0/DEL controls or dot/traversal segments; order and trailing slashes are preserved.
 * It selects only the installed Device child's PATH; reading it does not probe directories or
 * executables, run a shell, or change the parent's environment.
 * Version 1 retains appData/PowerEvolve. Version 2 selects appData/PowerEvolve-<stateNamespace>,
 * where the trusted descriptor supplies a 1–63 character lowercase alphanumeric/hyphen name
 * starting and ending with an alphanumeric character. The namespace remains fixed across upgrades;
 * changing it creates a separate installation identity without copying Device credentials or journals.
 * Environment variables and launch arguments cannot select installed state. Existing product roots
 * must be current-user-owned 0700 directories without aliases. All namespaces retain the version 1
 * appData/PowerEvolve/device-writers coordinator so unknown writers also block another installation.
 * Missing roots and state directories
 * are returned without creation; main creates the product root before Electron Session setup.
 * @param options - Electron's resourcesPath and appDataPath; the latter must be an existing physical directory.
 * @returns Cloud and Device configuration, a separate command search list, physical resources, and fixed state paths.
 */
export function readInstalledDesktopConfig(options: { resourcesPath: string; appDataPath: string }): InstalledDesktopConfig {
  try {
    const root = directory(options.resourcesPath)
    const data = descriptor.parse(readDescriptor(root))
    const config = parseCloudDesktopConfig(data.deployment)
    const resources = {
      root, nodeExecutable: file(root, data.runtime.nodeExecutable, true),
      cliEntrypoint: file(root, data.runtime.cliEntrypoint),
      pythonExecutable: file(root, data.runtime.pythonExecutable, true), fileHelper: file(root, data.runtime.fileHelper),
      deviceBundle: resourceDirectory(root, data.runtime.deviceBundle),
    }
    const appDataPath = directory(options.appDataPath)
    const productUserDataPath = privateRoot(join(appDataPath,
      data.version === 1 ? 'PowerEvolve' : `PowerEvolve-${data.stateNamespace}`), root)
    const coordinatorParent = privateRoot(join(appDataPath, 'PowerEvolve'), root)
    const state = {
      productUserDataPath, homeDir: stateDirectory(productUserDataPath, 'device', 'home'),
      workingDir: stateDirectory(productUserDataPath, 'device', 'work'),
      privateDir: stateDirectory(productUserDataPath, 'device', 'private'),
      coordinationRoot: stateDirectory(coordinatorParent, 'device-writers'),
    }
    const { commandSearchPath, ...device } = data.device
    const deviceConfig = parseDesktopDeviceConfig({ ...device, nodeExecutable: resources.nodeExecutable,
      cliEntrypoint: resources.cliEntrypoint, homeDir: state.homeDir, workingDir: state.workingDir })
    if ([config.hostOrigin, config.platformOrigin].includes(deviceConfig.loopbackOrigin)) throw invalid()
    return { config, deviceConfig, commandSearchPath, worker: data.worker, resources, state }
  } catch (_invalidConfiguration) {
    // Parser and filesystem errors can contain private paths or untrusted descriptor values.
    throw invalid()
  }
}
