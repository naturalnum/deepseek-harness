/** Offline macOS ARM64 assembly from prepared bytes. Run this source tool with node --import tsx/esm. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { accessSync, chmodSync, closeSync, constants, copyFileSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { verifyTrialRuntime } from './capture-runtime.mjs'
import { readInstalledDesktopConfig } from '../src/installed-config.ts'

const FORMAT = 'power-evolve-installed-assembly-v1'
const RECORD = 'Contents/Resources/power-evolve-assembly.json'
const EXECUTABLE = 'Contents/MacOS/PowerEvolve'
const CLI = '@deepseek-ai/dsh', DEVICE = '@power-evolve/device', APPLICATION = '@power-evolve/application'
const DEVICE_FIELDS = ['profile', 'loopbackOrigin', 'startupTimeoutMs', 'requestTimeoutMs', 'quiesceTimeoutMs',
  'exitTimeoutMs', 'maxOutputBytes', 'maxMessageBytes', 'maxHealthBytes']
const WORKER_FIELDS = ['image', 'pollMs', 'contactGraceMs', 'commandPollMs', 'platformRequestTimeoutMs',
  'dockerCommandTimeoutMs', 'dockerStopTimeoutMs', 'dockerStopGraceSeconds', 'directoryPickerTimeoutMs', 'fileOperationTimeoutMs']
const forbidden = /^(?:\.git|\.env(?:\..*)?|model\.env|database(?:-local)?-url|\.credentials|\.private)$/iu
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const portable = path => path.split(sep).join('/')
function fail(code) { throw new Error(`installed_app_${code}`) }
function inside(root, path) {
  const part = relative(root, path)
  return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}
function keys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail('invalid_input')
}
function relativePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\:\u0000-\u001f\u007f]/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) fail('invalid_path')
  return path
}
function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !lstatSync(path).isDirectory()) fail('invalid_directory')
  return realpathSync(path)
}
function present(path) {
  try { lstatSync(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function removeOwned(path) {
  if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
  else rmSync(path, { recursive: true })
}
function physical(root, path) {
  const parts = relativePath(path).split('/')
  for (let i = 1; i <= parts.length; i++) {
    if (!inside(root, realpathSync(join(root, ...parts.slice(0, i))))) fail('alias_escape')
  }
  return realpathSync(join(root, ...parts))
}
function digest(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) fail('not_regular')
    const bytes = Buffer.alloc(64 * 1024), sum = createHash('sha256')
    let size = 0, count
    while ((count = readSync(fd, bytes, 0, bytes.length, null)) !== 0) { sum.update(bytes.subarray(0, count)); size += count }
    const after = fstatSync(fd)
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== size
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) fail('source_changed')
    return { bytes: size, sha256: sum.digest('hex'), mode: before.mode & 0o777 }
  } finally { closeSync(fd) }
}
function ordered(value) {
  const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  return { files: value.files.sort(byPath), aliases: value.aliases.sort(byPath), directories: value.directories.sort() }
}
function inventory(root, excluded = new Set()) {
  const files = [], aliases = [], directories = []
  let bytes = 0
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      const source = join(path, name), rel = portable(relative(root, source)), info = lstatSync(source)
      if (excluded.has(rel)) continue
      if (forbidden.test(name)) fail('private_input')
      if (info.isSymbolicLink()) {
        const target = readlinkSync(source)
        if (isAbsolute(target) || target.includes('\\') || !inside(root, resolve(dirname(source), target))
          || !inside(root, realpathSync(source))) fail('alias_escape')
        aliases.push({ path: rel, target })
      } else if (info.isDirectory()) { directories.push(rel); visit(source) }
      else if (info.isFile()) { const value = digest(source); bytes += value.bytes; files.push({ path: rel, ...value }) }
      else fail('not_regular')
      if (files.length + aliases.length + directories.length > 200000 || bytes > 8 * 1024 ** 3) fail('payload_limit')
    }
  }
  visit(root)
  return ordered({ files, aliases, directories })
}
function desktopInventory(root) {
  const lib = inventory(join(root, 'lib'), new Set(['types']))
  for (const entry of ['main.js', 'preload-cloud.cjs', 'preload-device.cjs']) {
    if (!lib.files.some(file => file.path === entry)) fail('invalid_desktop')
  }
  return ordered({ files: [{ path: 'package.json', ...digest(join(root, 'package.json')) }, ...lib.files.map(file => ({ ...file, path: `lib/${file.path}` }))],
    aliases: lib.aliases.map(alias => ({ ...alias, path: `lib/${alias.path}` })), directories: ['lib', ...lib.directories.map(path => `lib/${path}`)] })
}
function treeHash(value) { return hash(JSON.stringify(value)) }
function syncFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function syncDirectories(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (lstatSync(path).isDirectory()) syncDirectories(path)
  }
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function copyTree(source, destination, selected) {
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const path of selected.directories) mkdirSync(join(destination, path), { recursive: true, mode: 0o700 })
  for (const file of selected.files) {
    const input = join(source, file.path), output = join(destination, file.path)
    const before = digest(input)
    if (realpathSync(input) !== input || before.sha256 !== file.sha256 || before.bytes !== file.bytes || before.mode !== file.mode) fail('source_changed')
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
    copyFileSync(input, output, constants.COPYFILE_EXCL)
    chmodSync(output, file.mode)
    const copied = digest(output)
    if (copied.sha256 !== file.sha256 || copied.bytes !== file.bytes || copied.mode !== file.mode
      || statSync(input).ino === statSync(output).ino && statSync(input).dev === statSync(output).dev) fail('copy_changed')
    syncFile(output)
  }
  for (const alias of selected.aliases) {
    const output = join(destination, alias.path)
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); symlinkSync(alias.target, output)
  }
  if (treeHash(inventory(destination)) !== treeHash(selected)) fail('copy_changed')
}
function json(path, limit = 32 * 1024 ** 2) {
  if (!lstatSync(path).isFile() || statSync(path).size > limit) fail('invalid_metadata')
  const bytes = readFileSync(path)
  if (bytes.length > limit) fail('invalid_metadata')
  return JSON.parse(bytes.toString('utf8'))
}
function arm64(path) {
  accessSync(path, constants.R_OK | constants.X_OK)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) fail('not_regular')
    const header = Buffer.alloc(4096), size = readSync(fd, header, 0, header.length, 0)
    if (size >= 8 && header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c) return
    const magic = size >= 8 ? header.readUInt32BE(0) : 0
    if ([0xcafebabe, 0xcafebabf].includes(magic)) {
      const count = header.readUInt32BE(4), width = magic === 0xcafebabe ? 20 : 32
      if (count >= 1 && count <= 16 && size >= 8 + count * width) {
        for (let i = 0; i < count; i++) if (header.readUInt32BE(8 + i * width) === 0x0100000c) return
      }
    }
    fail('not_arm64')
  } finally { closeSync(fd) }
}
function plutil(path, args) {
  try { return execFileSync('/usr/bin/plutil', [...args, path], { env: {}, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 ** 2 }).trim() }
  catch { fail('plist_failed') }
}
function closureResources(root, record) {
  const cli = record.roots.find(entry => entry.name === CLI), device = record.roots.find(entry => entry.name === DEVICE)
  if (!cli || !device) fail('invalid_closure')
  const packages = new Map(record.packages.map(item => [item.id, item]))
  const bundle = packages.get(device.id), applicationEdge = bundle?.dependencies.find(edge => edge.name === APPLICATION)
  const application = packages.get(applicationEdge?.target)
  if (application?.name !== APPLICATION) fail('invalid_closure')
  const cliRoot = physical(root, `runtime/objects/${cli.id}`), manifest = json(join(cliRoot, 'package.json'))
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  const cliEntrypoint = `runtime/objects/${cli.id}/${relativePath(entry?.replace(/^\.\//u, ''))}`
  const deviceBundle = `runtime/objects/${device.id}`
  const fileHelper = `runtime/objects/${application.id}/src/device/local-files.py`
  for (const path of [cliEntrypoint, fileHelper]) if (!statSync(physical(root, path)).isFile()) fail('invalid_closure')
  return { cliEntrypoint, deviceBundle, fileHelper }
}
function validateDescription(resourcesPath) {
  const state = mkdtempSync(join(tmpdir(), 'pe-installed-validation-'))
  try { chmodSync(state, 0o700); return readInstalledDesktopConfig({ resourcesPath, productUserDataPath: state }) }
  finally { rmSync(state, { recursive: true }) }
}
function publish(stage, output) {
  // macOS SDK sys/stdio.h defines RENAME_EXCL=0x00000004. No overwrite fallback is allowed.
  const script = 'import ctypes,errno,json,os,sys\nlibc=ctypes.CDLL(None,use_errno=True)\nfn=libc.renamex_np\nfn.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint]\nfn.restype=ctypes.c_int\nresult=fn(os.fsencode(sys.argv[1]),os.fsencode(sys.argv[2]),4)\nif result!=0:\n e=ctypes.get_errno()\n print(json.dumps({"error":"exists" if e==errno.EEXIST else "rename_failed"}))\n sys.exit(1)\n'
  try { execFileSync('/usr/bin/python3', ['-I', '-c', script, stage, output], { env: {}, timeout: 10000, maxBuffer: 4096 }) }
  catch (error) {
    let value
    try { value = JSON.parse(error.stdout?.toString() ?? '') } catch { /* An unavailable helper has no structured result. */ }
    fail(value?.error === 'exists' ? 'output_exists' : 'exclusive_publish_failed')
  }
}

/**
 * Independently verify a completed app inventory, captured closure, installed description and product identity.
 * This source operator requires tsx/esm, plutil and macOS; it runs no app, Profile or bundled interpreter.
 * @param {string} output - Absolute assembled PowerEvolve.app path.
 * @returns {object} Recorded hashes after local verification, without signature or ABI claims.
 */
export function verifyInstalledApp(output) {
  const root = directory(output), record = json(join(root, RECORD))
  if (record.format !== FORMAT || record.target !== 'darwin-arm64' || !record.inventory) fail('invalid_record')
  const actual = inventory(root, new Set([RECORD]))
  if (treeHash(actual) !== record.inventorySha256 || treeHash(actual) !== treeHash(record.inventory)) fail('inventory_changed')
  const resources = join(root, 'Contents/Resources'), capture = verifyTrialRuntime(join(resources, 'closure'))
  if (capture.sourceCommit !== record.inputs.closure.sourceCommit) fail('closure_changed')
  const description = validateDescription(resources)
  if (description.config.hostOrigin !== record.deployment.hostOrigin || description.config.platformOrigin !== record.deployment.platformOrigin) fail('description_changed')
  const plist = join(root, 'Contents/Info.plist')
  for (const [key, value] of Object.entries({ CFBundleExecutable: 'PowerEvolve', CFBundleIdentifier: record.product.bundleId, CFBundleName: 'PowerEvolve',
    CFBundleDisplayName: 'PowerEvolve', CFBundleShortVersionString: record.product.version, CFBundleVersion: record.product.buildVersion })) {
    if (plutil(plist, ['-extract', key, 'raw', '-o', '-']) !== value) fail('identity_changed')
  }
  if (record.executableMapping?.installedPath !== EXECUTABLE) fail('invalid_record')
  const sourcePath = relativePath(record.executableMapping.sourcePath), executablePath = join(root, EXECUTABLE)
  if (!sourcePath.startsWith('Contents/MacOS/') || physical(root, EXECUTABLE) !== executablePath
    || !lstatSync(executablePath).isFile() || sourcePath !== EXECUTABLE && present(join(root, sourcePath))) fail('invalid_executable')
  arm64(executablePath)
  const original = record.inputs.electron.inventory.files.find(file => file.path === sourcePath), executable = digest(executablePath)
  if (!original || executable.sha256 !== original.sha256 || executable.bytes !== original.bytes || executable.mode !== original.mode) fail('executable_changed')
  return { ...record, assemblyRecordSha256: digest(join(root, RECORD)).sha256 }
}

/**
 * Copy prepared Electron, desktop bundles, captured CLI/Device closure and locked interpreters into a new app.
 * Inputs remain unchanged. Internal relative aliases are preserved; escape, special files and sensitive
 * filenames fail closed. A unique sibling stage is published with macOS exclusive rename; only that
 * stage is cleaned on failure. Bundled interpreters are inspected for ARM64 Mach-O headers, never run.
 * The copied main executable is named PowerEvolve with unchanged bytes, and its Info.plist entry is updated.
 * The copied outer signature seal is removed, and nested Framework/helper bytes remain intact.
 * Signing, notarization, native ABI, Docker availability and real installed startup are not established.
 * @param {object} options - Explicit prepared input directories, new absolute PowerEvolve.app output, product
 * identity, caller-declared desktopSourceCommit and nonsecret deployment/device/worker parameters.
 * @returns {object} Independent input and output inventories; closure commit and desktop commit remain distinct.
 */
export function assembleInstalledApp(options) {
  let stage, owned
  try {
    if (process.platform !== 'darwin') fail('unsupported_platform')
    keys(options, ['electronApp', 'desktopPackage', 'closureDirectory', 'nodeDirectory', 'pythonRuntimeDirectory',
      'output', 'product', 'desktopSourceCommit', 'deployment', 'device', 'worker'])
    keys(options.product, ['bundleId', 'version', 'buildVersion']); keys(options.device, DEVICE_FIELDS); keys(options.worker, WORKER_FIELDS)
    if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(options.product.bundleId)
      || !/^\d+\.\d+\.\d+$/u.test(options.product.version) || !/^\d+(?:\.\d+){0,2}$/u.test(options.product.buildVersion)
      || !/^[a-f0-9]{40}$/u.test(options.desktopSourceCommit)) fail('invalid_input')
    const roots = { electron: directory(options.electronApp), desktop: directory(options.desktopPackage),
      closure: directory(options.closureDirectory), node: directory(options.nodeDirectory), python: directory(options.pythonRuntimeDirectory) }
    if (typeof options.output !== 'string' || !isAbsolute(options.output) || basename(options.output) !== 'PowerEvolve.app') fail('invalid_output')
    const parent = directory(dirname(options.output)), output = join(parent, 'PowerEvolve.app')
    if (present(output)) fail('output_exists')
    if (Object.values(roots).some(root => inside(root, output) || inside(output, root))) fail('invalid_output')
    const capture = verifyTrialRuntime(roots.closure), locations = closureResources(roots.closure, capture)
    const desktopManifest = json(join(roots.desktop, 'package.json'))
    if (desktopManifest.name !== '@power-evolve/desktop' || desktopManifest.type !== 'module'
      || desktopManifest.main !== 'lib/main.js' || desktopManifest.version !== options.product.version) fail('invalid_desktop')
    const pythonManifest = json(join(roots.python, 'runtime.json'))
    if (pythonManifest.platform !== 'darwin' || pythonManifest.arch !== 'arm64'
      || !/^[a-f0-9]{64}$/u.test(pythonManifest.payloadDigest ?? '') || typeof pythonManifest.python !== 'string') fail('invalid_python')
    for (const path of ['Contents', 'Contents/Resources']) {
      if (physical(roots.electron, path) !== join(roots.electron, path) || !lstatSync(join(roots.electron, path)).isDirectory()) fail('invalid_electron_layout')
    }
    const plist = physical(roots.electron, 'Contents/Info.plist')
    if (plist !== join(roots.electron, 'Contents/Info.plist') || !lstatSync(plist).isFile()) fail('invalid_electron_layout')
    const executable = plutil(plist, ['-extract', 'CFBundleExecutable', 'raw', '-o', '-'])
    if (options.product.bundleId === plutil(plist, ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-'])) fail('invalid_identity')
    const sourceExecutable = `Contents/MacOS/${relativePath(executable)}`
    if (physical(roots.electron, sourceExecutable) !== join(roots.electron, sourceExecutable)
      || !lstatSync(join(roots.electron, sourceExecutable)).isFile()) fail('invalid_electron_layout')
    if (sourceExecutable !== EXECUTABLE && present(join(roots.electron, EXECUTABLE))) fail('occupied_executable')
    arm64(join(roots.electron, sourceExecutable))
    arm64(physical(roots.node, 'bin/node')); arm64(physical(roots.python, 'dependencies/python/bin/python3'))
    for (const name of ['app', 'app.asar', 'closure', 'node', 'python', 'power-evolve-desktop.json', 'power-evolve-assembly.json']) {
      if (present(join(roots.electron, 'Contents/Resources', name))) fail('occupied_resources')
    }
    const inputs = Object.fromEntries(Object.entries(roots).map(([name, root]) => {
      const value = name === 'desktop' ? desktopInventory(root) : inventory(root)
      return [name, { inventory: value, inventorySha256: treeHash(value) }]
    }))
    stage = join(parent, `.PowerEvolve-assemble-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 }); owned = lstatSync(stage)
    copyTree(roots.electron, stage, inputs.electron.inventory)
    const resources = join(stage, 'Contents/Resources')
    copyTree(roots.desktop, join(resources, 'app'), inputs.desktop.inventory)
    for (const name of ['closure', 'node', 'python']) copyTree(roots[name], join(resources, name), inputs[name].inventory)
    const removed = []
    for (const path of ['Contents/_CodeSignature', 'Contents/Resources/default_app.asar']) {
      if (present(join(stage, path))) { removeOwned(join(stage, path)); removed.push(path) }
    }
    if (sourceExecutable !== EXECUTABLE) renameSync(join(stage, sourceExecutable), join(stage, EXECUTABLE))
    const targetPlist = join(stage, 'Contents/Info.plist'), plistMode = lstatSync(targetPlist).mode & 0o777
    chmodSync(targetPlist, 0o600)
    for (const [key, value] of Object.entries({ CFBundleExecutable: 'PowerEvolve', CFBundleIdentifier: options.product.bundleId, CFBundleName: 'PowerEvolve',
      CFBundleDisplayName: 'PowerEvolve', CFBundleShortVersionString: options.product.version, CFBundleVersion: options.product.buildVersion })) {
      plutil(targetPlist, ['-replace', key, '-string', value])
    }
    chmodSync(targetPlist, plistMode); syncFile(targetPlist)
    const description = { kind: 'power-evolve-desktop', version: 1, deployment: options.deployment, device: options.device, worker: options.worker,
      runtime: { nodeExecutable: 'node/bin/node', pythonExecutable: 'python/dependencies/python/bin/python3',
        cliEntrypoint: `closure/${locations.cliEntrypoint}`, deviceBundle: `closure/${locations.deviceBundle}`, fileHelper: `closure/${locations.fileHelper}` } }
    writeFileSync(join(resources, 'power-evolve-desktop.json'), JSON.stringify(description, null, 2) + '\n', { flag: 'wx', mode: 0o400 })
    syncFile(join(resources, 'power-evolve-desktop.json'))
    const parsed = validateDescription(resources)
    verifyTrialRuntime(join(resources, 'closure'))
    for (const [name, root] of Object.entries(roots)) {
      const expected = inputs[name].inventory
      const actual = name === 'desktop' ? desktopInventory(root) : inventory(root)
      if (treeHash(expected) !== treeHash(actual)) fail('source_changed')
    }
    const payload = inventory(stage)
    const record = { format: FORMAT, target: 'darwin-arm64', product: options.product,
      deployment: parsed.config, signingPerformed: false, notarizationPerformed: false, removedInputPaths: removed,
      executableMapping: { sourcePath: sourceExecutable, installedPath: EXECUTABLE },
      inputs: { ...inputs, desktop: { ...inputs.desktop, declaredSourceCommit: options.desktopSourceCommit, version: desktopManifest.version },
        closure: { ...inputs.closure, sourceCommit: capture.sourceCommit }, python: { ...inputs.python, runtimeManifest: pythonManifest } },
      operatorSha256: hash(readFileSync(fileURLToPath(import.meta.url))), inventory: payload, inventorySha256: treeHash(payload) }
    const bytes = JSON.stringify(record, null, 2) + '\n'
    if (Buffer.byteLength(bytes) > 32 * 1024 ** 2) fail('metadata_limit')
    writeFileSync(join(stage, RECORD), bytes, { flag: 'wx', mode: 0o400 })
    syncFile(join(stage, RECORD))
    syncDirectories(stage)
    const verified = verifyInstalledApp(stage)
    publish(stage, output)
    const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
    return { output, ...verified }
  } catch (error) {
    if (stage && owned && present(stage)) {
      const current = lstatSync(stage)
      if (current.isDirectory() && current.dev === owned.dev && current.ino === owned.ino) rmSync(stage, { recursive: true })
    }
    if (error.message?.startsWith('installed_app_')) throw error
    fail('assembly_failed')
  }
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' }, input: { type: 'string' }, app: { type: 'string' } } })
  if (values.help) { console.log('node --import tsx/esm assemble-installed-app.mjs assemble --input <nonsecret-input.json>\nnode --import tsx/esm assemble-installed-app.mjs verify --app <PowerEvolve.app>'); return }
  if (positionals.length !== 1) fail('invalid_arguments')
  if (positionals[0] === 'assemble' && values.input && !values.app) console.log(JSON.stringify(assembleInstalledApp(json(values.input))))
  else if (positionals[0] === 'verify' && values.app && !values.input) console.log(JSON.stringify(verifyInstalledApp(values.app)))
  else fail('invalid_arguments')
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(JSON.stringify({ error: error.message?.startsWith('installed_app_') ? error.message : 'installed_app_failed' })); process.exitCode = 1 }
}
