/** Small physical fixtures test offline assembly only; their Mach-O headers are not runnable Electron or ABI evidence. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { captureTrialRuntime, verifyTrialRuntime } from '../scripts/capture-runtime.mjs'
import { assembleInstalledApp, verifyInstalledApp } from '../scripts/assemble-installed-app.mjs'

const mac = { skip: process.platform !== 'darwin' }
const operator = fileURLToPath(new URL('../scripts/assemble-installed-app.mjs', import.meta.url))
function writableDirectories(root) {
  if (!lstatSync(root).isDirectory()) return
  chmodSync(root, 0o700)
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (lstatSync(path).isDirectory()) writableDirectories(path)
  }
}
function freeze(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry), info = lstatSync(path)
    if (info.isDirectory()) freeze(path)
    else if (info.isFile()) chmodSync(path, (info.mode & 0o111) !== 0 ? 0o500 : 0o400)
  }
  chmodSync(root, 0o500)
}
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pe-installed-assembly-'))
  t.after(() => { writableDirectories(base); rmSync(base, { recursive: true }) })
  function put(path, content, mode = 0o400) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, content, { mode })
  }
  function macho() {
    const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12)
    return bytes
  }
  const electronApp = join(base, 'Electron.app'), desktopPackage = join(base, 'desktop'), nodeDirectory = join(base, 'node'), pythonRuntimeDirectory = join(base, 'primary-runtime')
  put(join(electronApp, 'Contents/MacOS/Electron'), macho(), 0o500)
  const fields = { CFBundleExecutable: 'Electron', CFBundleIdentifier: 'com.github.Electron', CFBundleName: 'Electron',
    CFBundleShortVersionString: '44.0.0', CFBundleVersion: '44.0.0' }
  put(join(electronApp, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(fields).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join('')}</dict></plist>\n`)
  put(join(electronApp, 'Contents/Resources/default_app.asar'), 'default application fixture')
  put(join(electronApp, 'Contents/_CodeSignature/CodeResources'), 'obsolete outer seal fixture')
  const framework = join(electronApp, 'Contents/Frameworks/Electron Framework.framework')
  put(join(framework, 'Versions/A/Electron Framework'), macho(), 0o500)
  put(join(framework, 'Versions/A/_CodeSignature/CodeResources'), 'nested seal unchanged')
  symlinkSync('A', join(framework, 'Versions/Current'))
  symlinkSync('Versions/Current/Electron Framework', join(framework, 'Electron Framework'))
  put(join(desktopPackage, 'package.json'), JSON.stringify({ name: '@power-evolve/desktop', version: '0.1.0', type: 'module', main: 'lib/main.js' }))
  for (const name of ['main.js', 'preload-cloud.cjs', 'preload-device.cjs', 'chunks/shared.js']) put(join(desktopPackage, 'lib', name), `// inert compiled ${name}\n`)
  put(join(desktopPackage, 'lib/types/unused.js'), '// do not ship an unbundled source face')
  put(join(desktopPackage, 'src/unused.ts'), '// do not read the source tree')
  put(join(nodeDirectory, 'bin/node'), macho(), 0o500)
  put(join(pythonRuntimeDirectory, 'dependencies/python/bin/python3.14'), macho(), 0o500)
  symlinkSync('python3.14', join(pythonRuntimeDirectory, 'dependencies/python/bin/python3'))
  put(join(pythonRuntimeDirectory, 'runtime.json'), JSON.stringify({ desktopVersion: '0.1.0', platform: 'darwin', arch: 'arm64',
    payloadDigest: '1'.repeat(64), python: '3.14.3', pythonPackages: { lxml: '6.1.3' } }))
  const sourceRoot = join(base, 'source'), closureDirectory = join(base, 'closure')
  mkdirSync(sourceRoot)
  put(join(sourceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - products/*\n')
  put(join(sourceRoot, '.gitignore'), 'node_modules/\n')
  function pkg(directory, name, version, extra = {}) {
    const root = join(sourceRoot, directory)
    put(join(root, 'package.json'), JSON.stringify({ name, version, type: 'module', files: ['lib'], main: 'lib/index.js', ...extra }))
    put(join(root, 'lib/index.js'), '// public component fixture\n')
    return root
  }
  function link(root, name, destination) { const path = join(root, 'node_modules', name); mkdirSync(dirname(path), { recursive: true }); symlinkSync(destination, path) }
  const cli = pkg('apps/cli', '@deepseek-ai/dsh', '0.1.7-rc.2', { bin: { dsh: 'lib/selected-entry.mjs' }, dependencies: { '@power-evolve/application': '^0.9.0' } })
  put(join(cli, 'lib/selected-entry.mjs'), '// actual selected CLI entry, never executed\n')
  const device = pkg('products/device', '@power-evolve/device', '0.1.0', { files: ['lib', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: { '@power-evolve/application': 'workspace:*' } })
  put(join(device, 'cordis.patch.yml'), '- insert: []\n')
  function application(directory, version, content) {
    const root = pkg(directory, '@power-evolve/application', version, { files: ['lib', 'src/device/local-files.py', 'src/platform/safe-posix.py'] })
    put(join(root, 'src/device/local-files.py'), content)
    put(join(root, 'src/platform/safe-posix.py'), '# dependent Python resource fixture\n')
    return root
  }
  const correct = application('products/application', '1.0.0', '# Device-bound helper\n')
  const other = application('node_modules/.pnpm/other/node_modules/application', '0.9.0', '# unselected CLI-context helper\n')
  link(cli, '@power-evolve/application', other); link(device, '@power-evolve/application', correct)
  const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot, env: gitEnv })
  execFileSync('git', ['add', '.'], { cwd: sourceRoot, env: gitEnv })
  execFileSync('git', ['-c', 'user.name=Assembly Fixture', '-c', 'user.email=assembly@example.invalid', 'commit', '--quiet', '-m', 'public fixture'], { cwd: sourceRoot, env: gitEnv })
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, env: gitEnv, encoding: 'utf8' }).trim()
  captureTrialRuntime({ sourceRoot, sourceCommit, output: closureDirectory })
  const options = { electronApp, desktopPackage, closureDirectory, nodeDirectory, pythonRuntimeDirectory,
    output: join(base, 'PowerEvolve.app'), desktopSourceCommit: 'b'.repeat(40), product: { bundleId: 'com.powerevolve.desktop', version: '0.1.0', buildVersion: '1.0' },
    deployment: { hostOrigin: 'https://host.example/', platformOrigin: 'https://platform.example' },
    device: { profile: 'power-evolve-device', loopbackOrigin: 'http://127.0.0.1:21091', startupTimeoutMs: 30000,
      requestTimeoutMs: 5000, quiesceTimeoutMs: 45000, exitTimeoutMs: 10000, maxOutputBytes: 262144, maxMessageBytes: 524288, maxHealthBytes: 4096 },
    worker: { image: `sha256:${'c'.repeat(64)}`, pollMs: 500, contactGraceMs: 5000, commandPollMs: 250,
      platformRequestTimeoutMs: 10000, dockerCommandTimeoutMs: 15000, dockerStopTimeoutMs: 10000,
      dockerStopGraceSeconds: 2, directoryPickerTimeoutMs: 120000, fileOperationTimeoutMs: 10000 } }
  return { base, sourceRoot, sourceCommit, options, put, macho }
}
function noStage(f) { assert(!readdirSync(f.base).some(name => name.startsWith('.PowerEvolve-assemble-'))) }

test('copies read-only resources, preserves framework aliases and binds helpers through the actual Device dependency', mac, t => {
  const f = fixture(t), before = readFileSync(join(f.options.electronApp, 'Contents/Info.plist'))
  const executable = readFileSync(join(f.options.electronApp, 'Contents/MacOS/Electron'))
  for (const root of [f.options.electronApp, f.options.desktopPackage, f.options.closureDirectory, f.options.nodeDirectory, f.options.pythonRuntimeDirectory]) freeze(root)
  const value = assembleInstalledApp(f.options), resources = join(value.output, 'Contents/Resources')
  assert.equal(value.inputs.closure.sourceCommit, f.sourceCommit)
  assert.equal(value.inputs.desktop.declaredSourceCommit, f.options.desktopSourceCommit)
  assert.notEqual(value.inputs.closure.sourceCommit, value.inputs.desktop.declaredSourceCommit)
  assert.equal(value.signingPerformed, false); assert.equal(value.notarizationPerformed, false)
  assert.deepEqual(value.executableMapping, { sourcePath: 'Contents/MacOS/Electron', installedPath: 'Contents/MacOS/PowerEvolve' })
  assert(!existsSync(join(value.output, 'Contents/MacOS/Electron')))
  assert.deepEqual(readFileSync(join(value.output, 'Contents/MacOS/PowerEvolve')), executable)
  assert(lstatSync(join(value.output, 'Contents/MacOS/PowerEvolve')).isFile())
  assert.equal(lstatSync(join(value.output, 'Contents/MacOS/PowerEvolve')).mode & 0o777, 0o500)
  assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(value.output, 'Contents/Info.plist')], { encoding: 'utf8' }).trim(), 'PowerEvolve')
  const description = JSON.parse(readFileSync(join(resources, 'power-evolve-desktop.json'), 'utf8'))
  assert.equal(readFileSync(join(resources, description.runtime.fileHelper), 'utf8'), '# Device-bound helper\n')
  assert.match(description.runtime.cliEntrypoint, /\/lib\/selected-entry\.mjs$/u)
  assert.equal(description.runtime.nodeExecutable, 'node/bin/node')
  assert.deepEqual(description.worker, f.options.worker)
  assert.equal(readlinkSync(join(value.output, 'Contents/Frameworks/Electron Framework.framework/Versions/Current')), 'A')
  assert.equal(readFileSync(join(value.output, 'Contents/Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/CodeResources'), 'utf8'), 'nested seal unchanged')
  assert(!existsSync(join(value.output, 'Contents/_CodeSignature'))); assert(!existsSync(join(resources, 'default_app.asar')))
  assert(!existsSync(join(resources, 'app/lib/types'))); assert(!existsSync(join(resources, 'app/src')))
  assert(existsSync(join(resources, 'app/lib/chunks/shared.js')))
  assert.notEqual(statSync(join(resources, 'node/bin/node')).ino, statSync(join(f.options.nodeDirectory, 'bin/node')).ino)
  assert.deepEqual(readFileSync(join(f.options.electronApp, 'Contents/Info.plist')), before)
  assert.deepEqual(readFileSync(join(f.options.electronApp, 'Contents/MacOS/Electron')), executable)
  assert.equal(lstatSync(join(f.options.electronApp, 'Contents/Info.plist')).mode & 0o777, 0o400)
  assert.equal(verifyInstalledApp(value.output).inventorySha256, value.inventorySha256); noStage(f)
})

test('copied inventories and closure verify after source inputs are removed', mac, t => {
  const f = fixture(t), value = assembleInstalledApp(f.options)
  for (const root of [f.options.electronApp, f.options.desktopPackage, f.options.closureDirectory, f.options.nodeDirectory, f.options.pythonRuntimeDirectory, f.sourceRoot]) {
    writableDirectories(root); rmSync(root, { recursive: true })
  }
  assert.equal(verifyInstalledApp(value.output).inventorySha256, value.inventorySha256)
  assert.equal(verifyTrialRuntime(join(value.output, 'Contents/Resources/closure')).sourceCommit, f.sourceCommit)
})

test('never overwrites an existing file, directory or symlink target', mac, t => {
  const f = fixture(t)
  mkdirSync(f.options.output); f.put(join(f.options.output, 'keep'), 'retained target')
  assert.throws(() => assembleInstalledApp(f.options), /installed_app_output_exists/u)
  assert.equal(readFileSync(join(f.options.output, 'keep'), 'utf8'), 'retained target'); noStage(f)
  writableDirectories(f.options.output); rmSync(f.options.output, { recursive: true }); f.put(f.options.output, 'retained file')
  assert.throws(() => assembleInstalledApp(f.options), /installed_app_output_exists/u)
  assert.equal(readFileSync(f.options.output, 'utf8'), 'retained file'); rmSync(f.options.output)
  symlinkSync(f.options.electronApp, f.options.output)
  assert.throws(() => assembleInstalledApp(f.options), /installed_app_output_exists/u)
  assert.equal(realpathSync(f.options.output), realpathSync(f.options.electronApp)); noStage(f)
})

test('macOS exclusive publication refuses a target created after preflight without modifying it', mac, async t => {
  const f = fixture(t)
  f.put(join(f.options.electronApp, 'Contents/Resources/padding'), Buffer.alloc(16 * 1024 ** 2))
  const input = join(f.base, 'assembly-input.json'); f.put(input, JSON.stringify(f.options), 0o600)
  const child = spawn(process.execPath, ['--import', 'tsx/esm', operator, 'assemble', '--input', input], { cwd: fileURLToPath(new URL('../../../..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = '', collided = false
  child.stdout.resume(); child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data })
  const watcher = setInterval(() => {
    if (!collided && !existsSync(f.options.output) && readdirSync(f.base).some(name => name.startsWith('.PowerEvolve-assemble-'))) {
      mkdirSync(f.options.output); f.put(join(f.options.output, 'keep'), 'late target retained'); collided = true
    }
  }, 1)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
  const done = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit) })
  t.after(async () => {
    clearInterval(watcher); clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await done.catch(() => { /* A failed spawn owns no live child. */ })
  })
  let code
  try { code = await done } finally { clearInterval(watcher); clearTimeout(timeout) }
  assert(collided, 'fixture must create the target during staging')
  assert.equal(code, 1); assert.match(stderr, /installed_app_output_exists/u)
  assert.equal(readFileSync(join(f.options.output, 'keep'), 'utf8'), 'late target retained'); noStage(f)
})

test('rejects external aliases for each copied runtime without publishing an app', mac, t => {
  const f = fixture(t), outside = join(f.base, 'outside'); f.put(outside, 'outside bytes')
  for (const root of [f.options.electronApp, f.options.nodeDirectory, f.options.pythonRuntimeDirectory]) {
    for (const target of [outside, relative(root, outside)]) {
      const alias = join(root, 'escape'); symlinkSync(target, alias)
      assert.throws(() => assembleInstalledApp(f.options)); assert(!existsSync(f.options.output)); noStage(f)
      rmSync(alias)
    }
  }
  const value = verifyTrialRuntime(f.options.closureDirectory), cli = join(f.options.closureDirectory, value.paths['@deepseek-ai/dsh'])
  rmSync(cli); symlinkSync(outside, cli)
  assert.throws(() => assembleInstalledApp(f.options)); assert(!existsSync(f.options.output)); noStage(f)
})

test('rejects wrong architecture, missing built entries and input output overlap', mac, t => {
  const f = fixture(t), node = join(f.options.nodeDirectory, 'bin/node'), original = readFileSync(node)
  chmodSync(node, 0o600); const x64 = f.macho(); x64.writeUInt32LE(0x01000007, 4); writeFileSync(node, x64); chmodSync(node, 0o500)
  assert.throws(() => assembleInstalledApp(f.options), /installed_app_not_arm64/u)
  chmodSync(node, 0o600); writeFileSync(node, original); chmodSync(node, 0o500)
  rmSync(join(f.options.desktopPackage, 'lib/preload-device.cjs'))
  assert.throws(() => assembleInstalledApp(f.options), /installed_app_invalid_desktop/u)
  assert.throws(() => assembleInstalledApp({ ...f.options, output: join(f.options.nodeDirectory, 'PowerEvolve.app') }), /installed_app_invalid_output/u)
  assert(!existsSync(f.options.output)); noStage(f)
})

test('invalid budgets or added credentials fail after copying and remove only the owned stage', mac, t => {
  const f = fixture(t), info = readFileSync(join(f.options.electronApp, 'Contents/Info.plist'))
  assert.throws(() => assembleInstalledApp({ ...f.options, worker: { ...f.options.worker, image: 'unfixed:tag' } }))
  assert(!existsSync(f.options.output)); noStage(f)
  assert.throws(() => assembleInstalledApp({ ...f.options, device: { ...f.options.device, credentials: 'synthetic-forbidden-field' } }), /installed_app_invalid_input/u)
  assert.deepEqual(readFileSync(join(f.options.electronApp, 'Contents/Info.plist')), info)
  noStage(f)
})

test('independent verification rejects changed installed bytes', mac, t => {
  const f = fixture(t), value = assembleInstalledApp(f.options), main = join(value.output, 'Contents/Resources/app/lib/main.js')
  chmodSync(main, 0o600); writeFileSync(main, '// altered installed bytes\n')
  assert.throws(() => verifyInstalledApp(value.output), /installed_app_inventory_changed/u)
})

test('rejects an occupied product executable or an aliased original without changing the input', mac, t => {
  const f = fixture(t), original = join(f.options.electronApp, 'Contents/MacOS/Electron'), product = join(f.options.electronApp, 'Contents/MacOS/PowerEvolve')
  f.put(product, 'retained executable name')
  assert.throws(() => assembleInstalledApp(f.options), /installed_app_occupied_executable/u)
  assert.equal(readFileSync(product, 'utf8'), 'retained executable name')
  rmSync(product)
  f.put(join(f.options.electronApp, 'Contents/MacOS/Original'), readFileSync(original), 0o500)
  rmSync(original); symlinkSync('Original', original)
  assert.throws(() => assembleInstalledApp(f.options), /installed_app_invalid_electron_layout/u)
  assert.equal(readlinkSync(original), 'Original')
  assert(!existsSync(f.options.output)); noStage(f)
})

test('verification checks the executable name, ARM64 header and original bytes beyond the inventory', mac, t => {
  const f = fixture(t), value = assembleInstalledApp(f.options), plist = join(value.output, 'Contents/Info.plist')
  const executable = join(value.output, 'Contents/MacOS/PowerEvolve'), originalPlist = readFileSync(plist), originalExecutable = readFileSync(executable)
  function updateRecordedFile(path, bytes, mode) {
    chmodSync(path, 0o600); writeFileSync(path, bytes); chmodSync(path, mode)
    const recordPath = join(value.output, 'Contents/Resources/power-evolve-assembly.json'), record = JSON.parse(readFileSync(recordPath, 'utf8'))
    const entry = record.inventory.files.find(file => file.path === relative(value.output, path))
    entry.bytes = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex'); entry.mode = mode
    record.inventorySha256 = createHash('sha256').update(JSON.stringify(record.inventory)).digest('hex')
    chmodSync(recordPath, 0o600); writeFileSync(recordPath, JSON.stringify(record) + '\n'); chmodSync(recordPath, 0o400)
  }
  chmodSync(plist, 0o600)
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleExecutable', '-string', 'Electron', plist])
  updateRecordedFile(plist, readFileSync(plist), 0o400)
  assert.throws(() => verifyInstalledApp(value.output), /installed_app_identity_changed/u)
  updateRecordedFile(plist, originalPlist, 0o400)
  const x64 = Buffer.from(originalExecutable); x64.writeUInt32LE(0x01000007, 4)
  updateRecordedFile(executable, x64, 0o500)
  assert.throws(() => verifyInstalledApp(value.output), /installed_app_not_arm64/u)
  const altered = Buffer.from(originalExecutable); altered[31] = 1
  updateRecordedFile(executable, altered, 0o500)
  assert.throws(() => verifyInstalledApp(value.output), /installed_app_executable_changed/u)
})
