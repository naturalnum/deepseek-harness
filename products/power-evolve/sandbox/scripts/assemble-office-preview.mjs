/** Copy a prepared physical Linux WASM closure; never installs packages or executes conversion. */
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { officePackageDirectories, selectOfficeEngine } from '../../../../scripts/libreoffice-packages.mjs'

const kitName = '@deepseek-ai/libreoffice-kit'
const wasmName = `${kitName}-wasm`
const sdkVersion = '0.1.1'
const wrapperPath = fileURLToPath(new URL('../office-preview.mjs', import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function inside(root, path) {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

async function physicalFiles(root) {
  const files = []
  async function visit(path) {
    const status = await lstat(path)
    if (status.isSymbolicLink()) throw new Error('Office closure contains a symbolic link')
    if (status.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else if (status.isFile()) files.push(path)
    else throw new Error('Office closure contains a nonregular resource')
  }
  await visit(root)
  return files
}

async function verifyEngine(root) {
  const manifest = JSON.parse(await readFile(join(root, 'prebuilds.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.version !== sdkVersion || manifest.platform !== 'wasm'
    || manifest.status !== 'built' || manifest.engine?.kind !== 'wasm'
    || manifest.engine.programDirectory !== '/instdir/program'
    || manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Office WASM manifest is incompatible')
  }
  for (const field of ['loader', 'wasm', 'data', 'metadata']) {
    const path = manifest.engine[field]
    if (typeof path !== 'string' || !Object.hasOwn(manifest.files, path)) throw new Error('Office WASM asset is undeclared')
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (typeof path !== 'string' || path.includes('\\') || isAbsolute(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')
      || typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected)) throw new Error('Office WASM asset declaration is invalid')
    const file = join(root, path)
    if (!inside(root, file) || !(await lstat(file)).isFile() || sha256(await readFile(file)) !== expected) {
      throw new Error('Office WASM asset digest does not match')
    }
  }
}

/**
 * Assemble a new offline runtime directory from an already prepared, symlink-free closure.
 * The caller supplies the built shared validation module; neither input may contain credentials.
 * Package paths retain their installed dependency resolution. Failure removes only the new owned destination.
 * @param {{ closureRoot: string, destination: string, arch: 'arm64' | 'x64', validatorModule: string }} input - Deployment resources.
 * @returns {Promise<object>} Package identities and copied physical-file SHA256 inventory.
 */
export async function assembleOfficePreview(input) {
  if (!['arm64', 'x64'].includes(input.arch)) throw new Error('Office preview target architecture is unsupported')
  const root = resolve(input.closureRoot)
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('Office closure root must be physical')
  await physicalFiles(root)
  const target = { platform: 'linux', arch: input.arch }
  const kit = JSON.parse(await readFile(join(root, 'node_modules', kitName, 'package.json'), 'utf8'))
  if (kit.name !== kitName || kit.version !== sdkVersion || selectOfficeEngine(kit, target) !== 'wasm') {
    throw new Error('Office preview requires the fixed 0.1.1 Linux WASM kit')
  }
  const directories = await officePackageDirectories(root, target)
  const engineRoot = join(root, 'node_modules', wasmName)
  const engine = JSON.parse(await readFile(join(engineRoot, 'package.json'), 'utf8'))
  if (engine.name !== wasmName || engine.version !== sdkVersion) throw new Error('Office WASM package version is incompatible')
  await verifyEngine(engineRoot)
  const validator = resolve(input.validatorModule)
  if (await realpath(validator) !== validator || !(await lstat(validator)).isFile()) throw new Error('Office validator must be a physical file')
  const destination = resolve(input.destination)
  if (inside(root, destination) || inside(destination, root)) throw new Error('Office destination overlaps its input closure')
  const selected = new Set()
  const packages = []
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    packages.push({ path: relative(root, directory).split(sep).join('/'), name: manifest.name, version: manifest.version })
    const nested = join(directory, 'node_modules')
    for (const file of await physicalFiles(directory)) {
      if (file !== nested && !file.startsWith(nested + sep)) selected.add(file)
    }
  }
  const sources = [...selected].sort().map(file => ({ source: file, path: relative(root, file).split(sep).join('/') }))
  sources.push({ source: wrapperPath, path: 'office-preview.mjs' }, { source: validator, path: 'office-preview-contract.mjs' })
  const records = []
  for (const file of sources) {
    const status = await lstat(file.source)
    if (!status.isFile()) throw new Error('Office assembly source is nonregular')
    records.push({ ...file, bytes: status.size, sha256: sha256(await readFile(file.source)), mode: status.mode & 0o777 })
  }
  let owned = false
  try {
    await mkdir(destination, { mode: 0o755 })
    owned = true
    for (const file of records) {
      const path = join(destination, file.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o755 })
      await copyFile(file.source, path)
      await chmod(path, file.mode)
      const bytes = await readFile(path)
      if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('Office copied resource changed')
    }
    const project = '{"private":true,"type":"module"}\n'
    await writeFile(join(destination, 'package.json'), project, { flag: 'wx', mode: 0o644 })
    const manifest = { protocolVersion: 1, sdkVersion, backend: 'wasm', target, packages,
      files: [...records.map(({ path, bytes, sha256, mode }) => ({ path, bytes, sha256, mode })),
        { path: 'package.json', bytes: Buffer.byteLength(project), sha256: sha256(project), mode: 0o644 }] }
    await writeFile(join(destination, 'office-preview-closure.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 })
    return manifest
  } catch (error) {
    if (owned) await rm(destination, { recursive: true, force: true })
    throw error
  }
}
