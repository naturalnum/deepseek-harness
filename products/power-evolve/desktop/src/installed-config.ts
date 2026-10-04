/** Main-owned installed resources and stable private state; no Profile or process is created here. */
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
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
const descriptor = z.object({
  kind: z.literal('power-evolve-desktop'), version: z.literal(1),
  deployment: z.unknown(),
  runtime: z.object({ nodeExecutable: resourcePath, cliEntrypoint: resourcePath,
    pythonExecutable: resourcePath, fileHelper: resourcePath }).strict(),
  device: z.object({
    profile: z.string(), loopbackOrigin: z.string(),
    startupTimeoutMs: z.number(), requestTimeoutMs: z.number(), quiesceTimeoutMs: z.number(), exitTimeoutMs: z.number(),
    maxOutputBytes: z.number(), maxMessageBytes: z.number(), maxHealthBytes: z.number(),
  }).strict(),
}).strict()

/** Validated physical installation resources and fixed user paths for the later Profile bootstrap. */
export interface InstalledDesktopConfig {
  readonly config: CloudDesktopConfig
  readonly deviceConfig: ReturnType<typeof parseDesktopDeviceConfig>
  readonly resources: {
    readonly root: string
    readonly nodeExecutable: string
    readonly cliEntrypoint: string
    readonly pythonExecutable: string
    readonly fileHelper: string
  }
  readonly state: {
    readonly productUserDataPath: string
    readonly homeDir: string
    readonly workingDir: string
    readonly privateDir: string
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
function file(root: string, path: string, executable = false): string {
  const parts = resourcePath.parse(path).split('/')
  // A contained relative alias is allowed; an intermediate alias cannot leave the resource root.
  for (let index = 1; index <= parts.length; index++) {
    const resolved = realpathSync(join(root, ...parts.slice(0, index)))
    if (!physicalPath(resolved) || !contains(root, resolved)) throw invalid()
  }
  const resolved = realpathSync(join(root, ...parts))
  if (!physicalPath(resolved) || !statSync(resolved).isFile()) throw invalid()
  accessSync(resolved, constants.R_OK | (executable ? constants.X_OK : 0))
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
  if (!isAbsolute(path)) throw invalid()
  const info = lstatSync(path)
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
 * be executable. The existing origin and lifecycle-budget parsers remain authoritative.
 * User state derives only from the existing owner-only product directory and never from environment
 * variables, descriptor fields or launch arguments. Missing state directories are returned without
 * creation; the later bootstrap creates the fixed working directory and official Device Profile.
 * @param options - Electron resourcesPath and main's already created, current-user-owned 0700 productUserDataPath.
 * @returns Normalized Cloud and Device configuration, physical resources, and version-independent state paths.
 */
export function readInstalledDesktopConfig(options: { resourcesPath: string; productUserDataPath: string }): InstalledDesktopConfig {
  try {
    const root = directory(options.resourcesPath)
    const data = descriptor.parse(readDescriptor(root))
    const config = parseCloudDesktopConfig(data.deployment)
    const resources = {
      root, nodeExecutable: file(root, data.runtime.nodeExecutable, true),
      cliEntrypoint: file(root, data.runtime.cliEntrypoint),
      pythonExecutable: file(root, data.runtime.pythonExecutable, true), fileHelper: file(root, data.runtime.fileHelper),
    }
    const productUserDataPath = privateRoot(options.productUserDataPath, root)
    const state = {
      productUserDataPath, homeDir: stateDirectory(productUserDataPath, 'device', 'home'),
      workingDir: stateDirectory(productUserDataPath, 'device', 'work'),
      privateDir: stateDirectory(productUserDataPath, 'device', 'private'),
      coordinationRoot: stateDirectory(productUserDataPath, 'device-writers'),
    }
    const deviceConfig = parseDesktopDeviceConfig({ ...data.device, nodeExecutable: resources.nodeExecutable,
      cliEntrypoint: resources.cliEntrypoint, homeDir: state.homeDir, workingDir: state.workingDir })
    if ([config.hostOrigin, config.platformOrigin].includes(deviceConfig.loopbackOrigin)) throw invalid()
    return { config, deviceConfig, resources, state }
  } catch (_invalidConfiguration) {
    // Parser and filesystem errors can contain private paths or untrusted descriptor values.
    throw invalid()
  }
}
