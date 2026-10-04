/** Physical temporary resources exercise installed parsing; no interpreter, Profile or app is launched. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { readInstalledDesktopConfig, type InstalledDesktopConfig } from '../src/installed-config.ts'

function description() {
  return {
    kind: 'power-evolve-desktop', version: 1,
    deployment: { hostOrigin: 'https://host.example/', platformOrigin: 'https://platform.example' },
    runtime: { nodeExecutable: 'node/bin/node', cliEntrypoint: 'cli/lib/bin.js',
      pythonExecutable: 'python/bin/python3', fileHelper: 'application/.src/device/local-files.py', deviceBundle: 'device-bundle' },
    worker: { image: 'sha256:' + 'a'.repeat(64), pollMs: 500, contactGraceMs: 5000, commandPollMs: 250,
      platformRequestTimeoutMs: 10000, dockerCommandTimeoutMs: 15000, dockerStopTimeoutMs: 10000,
      dockerStopGraceSeconds: 2, directoryPickerTimeoutMs: 120000, fileOperationTimeoutMs: 10000 },
    device: { profile: 'power-evolve-device', loopbackOrigin: 'http://127.0.0.1:20891/',
      startupTimeoutMs: 30000, requestTimeoutMs: 3000, quiesceTimeoutMs: 60000, exitTimeoutMs: 10000,
      maxOutputBytes: 65536, maxMessageBytes: 262144, maxHealthBytes: 4096 },
  }
}
function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'power-evolve-installed-config-'))
  t.after(() => { rmSync(base, { recursive: true, force: true }) })
  const resourcesPath = join(base, 'resources'), productUserDataPath = join(base, 'PowerEvolve')
  mkdirSync(resourcesPath); mkdirSync(productUserDataPath, { mode: 0o700 })
  const data = description()
  for (const [name, path] of Object.entries(data.runtime)) {
    const absolute = join(resourcesPath, path)
    if (name === 'deviceBundle') { mkdirSync(absolute); continue }
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, 'component fixture; not an interpreter\n', { mode: name.endsWith('Executable') ? 0o700 : 0o600 })
  }
  const descriptorPath = join(resourcesPath, 'power-evolve-desktop.json')
  function write(value: unknown): void { writeFileSync(descriptorPath, JSON.stringify(value), { mode: 0o600 }) }
  write(data)
  return { base, resourcesPath, productUserDataPath, data, descriptorPath, write }
}
function rejects(options: { resourcesPath: string; productUserDataPath: string }): void {
  assert.throws(() => readInstalledDesktopConfig(options), { message: 'PowerEvolve desktop: invalid installed configuration' })
}

test('reads a fixed description, normalizes origins and derives stable state without creating it', t => {
  const f = fixture(t)
  const value: InstalledDesktopConfig = readInstalledDesktopConfig(f)
  assert.deepEqual(value.config, { hostOrigin: 'https://host.example', platformOrigin: 'https://platform.example' })
  assert.equal(value.resources.nodeExecutable, realpathSync(join(f.resourcesPath, f.data.runtime.nodeExecutable)))
  assert.equal(value.resources.pythonExecutable, realpathSync(join(f.resourcesPath, f.data.runtime.pythonExecutable)))
  assert.equal(value.resources.cliEntrypoint, realpathSync(join(f.resourcesPath, f.data.runtime.cliEntrypoint)))
  assert.equal(value.resources.fileHelper, realpathSync(join(f.resourcesPath, f.data.runtime.fileHelper)))
  assert.equal(value.resources.deviceBundle, realpathSync(join(f.resourcesPath, f.data.runtime.deviceBundle)))
  assert.deepEqual(value.worker, f.data.worker)
  const user = realpathSync(f.productUserDataPath)
  assert.deepEqual(value.state, { productUserDataPath: user, homeDir: join(user, 'device/home'),
    workingDir: join(user, 'device/work'), privateDir: join(user, 'device/private'), coordinationRoot: join(user, 'device-writers') })
  assert.deepEqual(value.deviceConfig, { ...f.data.device, loopbackOrigin: 'http://127.0.0.1:20891',
    nodeExecutable: value.resources.nodeExecutable, cliEntrypoint: value.resources.cliEntrypoint,
    homeDir: value.state.homeDir, workingDir: value.state.workingDir })
  assert.deepEqual(readdirSync(f.productUserDataPath), [])
})

test('keeps existing Home and journal bytes and does not inherit alternative environment roots', t => {
  const f = fixture(t), first = readInstalledDesktopConfig(f)
  mkdirSync(first.state.homeDir, { recursive: true }); mkdirSync(first.state.privateDir)
  writeFileSync(join(first.state.homeDir, 'history'), 'retained home')
  writeFileSync(join(first.state.privateDir, 'journal'), 'retained journal')
  const before = { home: process.env.HOME, private: process.env.PE_PRIVATE_DIR, dsh: process.env.DSH_HOME }
  try {
    process.env.HOME = join(f.base, 'other-home'); process.env.PE_PRIVATE_DIR = join(f.base, 'other-private')
    process.env.DSH_HOME = join(f.base, 'other-dsh')
    assert.deepEqual(readInstalledDesktopConfig(f), first)
  } finally {
    for (const [name, old] of [['HOME', before.home], ['PE_PRIVATE_DIR', before.private], ['DSH_HOME', before.dsh]] as const) {
      if (old === undefined) delete process.env[name]
      else process.env[name] = old
    }
  }
  assert.equal(readFileSync(join(first.state.homeDir, 'history'), 'utf8'), 'retained home')
  assert.equal(readFileSync(join(first.state.privateDir, 'journal'), 'utf8'), 'retained journal')
  assert(!existsSync(first.state.workingDir))
})

test('allows internal relative aliases and returns physical files that need not be adjacent', t => {
  const f = fixture(t)
  mkdirSync(join(f.resourcesPath, 'aliases'))
  symlinkSync('../node', join(f.resourcesPath, 'aliases/node'))
  symlinkSync('../cli/lib/bin.js', join(f.resourcesPath, 'aliases/cli'))
  symlinkSync('../application/.src/device/local-files.py', join(f.resourcesPath, 'aliases/helper'))
  f.write({ ...f.data, runtime: { ...f.data.runtime, nodeExecutable: 'aliases/node/bin/node',
    cliEntrypoint: 'aliases/cli', fileHelper: 'aliases/helper' } })
  const value = readInstalledDesktopConfig(f)
  assert.equal(value.resources.nodeExecutable, realpathSync(join(f.resourcesPath, f.data.runtime.nodeExecutable)))
  assert.equal(value.resources.cliEntrypoint, realpathSync(join(f.resourcesPath, f.data.runtime.cliEntrypoint)))
  assert.equal(value.resources.fileHelper, realpathSync(join(f.resourcesPath, f.data.runtime.fileHelper)))
})

test('rejects unknown fields, missing resources and unrecognized description versions', t => {
  const f = fixture(t)
  for (const value of [null, [], {}, { ...f.data, version: 2 }, { ...f.data, kind: 'other-product' },
    { ...f.data, credentials: 'not-a-credential' }, { ...f.data, deployment: { ...f.data.deployment, token: 'not-a-token' } },
    { ...f.data, runtime: { ...f.data.runtime, safePosixHelper: 'another.py' } },
    { ...f.data, device: { ...f.data.device, homeDir: '/other-home' } },
    { ...f.data, device: { ...f.data.device, env: {} } }]) {
    f.write(value); rejects(f)
  }
  for (const key of Object.keys(f.data.runtime)) {
    const runtime: Record<string, string> = { ...f.data.runtime }
    delete runtime[key]; f.write({ ...f.data, runtime }); rejects(f)
  }
})

test('reuses the existing origin, Profile and bounded lifecycle budget rules', t => {
  const f = fixture(t)
  for (const hostOrigin of ['http://host.example', 'http://localhost:20880', 'file:///native/',
    'https://user:pass@host.example', 'https://host.example/native/', f.data.deployment.platformOrigin]) {
    f.write({ ...f.data, deployment: { ...f.data.deployment, hostOrigin } }); rejects(f)
  }
  for (const loopbackOrigin of ['http://localhost:20891', 'https://device.example', 'http://127.0.0.1',
    'http://127.0.0.1:20891/api', 'http://127.0.0.1:20891/?token=x']) {
    f.write({ ...f.data, device: { ...f.data.device, loopbackOrigin } }); rejects(f)
  }
  f.write({ ...f.data, deployment: { hostOrigin: 'http://127.0.0.1:20891', platformOrigin: 'http://127.0.0.1:20881' } }); rejects(f)
  f.write({ ...f.data, deployment: { hostOrigin: 'http://127.0.0.1:20880', platformOrigin: 'http://127.0.0.1:20891' } }); rejects(f)
  f.write({ ...f.data, device: { ...f.data.device, profile: '../../other' } }); rejects(f)
  for (const key of ['startupTimeoutMs', 'requestTimeoutMs', 'quiesceTimeoutMs', 'exitTimeoutMs']) {
    for (const value of [0, 1.5, 180001]) { f.write({ ...f.data, device: { ...f.data.device, [key]: value } }); rejects(f) }
  }
  for (const key of ['maxOutputBytes', 'maxMessageBytes', 'maxHealthBytes']) {
    for (const value of [0, 1023, 1048577]) { f.write({ ...f.data, device: { ...f.data.device, [key]: value } }); rejects(f) }
  }
})

test('rejects traversal, absolute, URI and ambiguous relative resource paths for every resource', t => {
  const f = fixture(t)
  for (const key of Object.keys(f.data.runtime)) {
    for (const value of ['', '/tmp/outside', '../outside', 'cli/../outside', './cli/lib/bin.js',
      'cli//lib/bin.js', 'cli/lib/bin.js/', 'C:\\runtime\\node', 'file:///tmp/node', 'https://example/node', 'cli\u0000/file']) {
      f.write({ ...f.data, runtime: { ...f.data.runtime, [key]: value } }); rejects(f)
    }
  }
})

test('rejects missing and nonregular physical resources and nonexecutable interpreters', t => {
  const f = fixture(t)
  mkdirSync(join(f.resourcesPath, 'directory'))
  for (const key of Object.keys(f.data.runtime)) {
    for (const value of ['missing', key === 'deviceBundle' ? f.data.runtime.cliEntrypoint : 'directory']) {
      f.write({ ...f.data, runtime: { ...f.data.runtime, [key]: value } }); rejects(f)
    }
  }
  f.write(f.data)
  for (const path of [f.data.runtime.nodeExecutable, f.data.runtime.pythonExecutable]) {
    chmodSync(join(f.resourcesPath, path), 0o600); rejects(f); chmodSync(join(f.resourcesPath, path), 0o700)
  }
})

test('rejects physical FIFOs without reading or executing them', t => {
  const f = fixture(t), fifo = join(f.resourcesPath, 'fifo')
  execFileSync('/usr/bin/mkfifo', [fifo])
  for (const key of Object.keys(f.data.runtime)) {
    f.write({ ...f.data, runtime: { ...f.data.runtime, [key]: 'fifo' } }); rejects(f)
  }
  rmSync(f.descriptorPath); execFileSync('/usr/bin/mkfifo', [f.descriptorPath]); rejects(f)
})

test('rejects direct and intermediate resource symlinks escaping the resource root', t => {
  const f = fixture(t)
  const outside = join(f.base, 'outside'); mkdirSync(outside)
  writeFileSync(join(outside, 'node'), 'outside', { mode: 0o700 })
  symlinkSync(outside, join(f.resourcesPath, 'escape'))
  symlinkSync(join(outside, 'node'), join(f.resourcesPath, 'escape-file'))
  for (const key of Object.keys(f.data.runtime)) {
    for (const value of ['escape/node', 'escape-file']) {
      f.write({ ...f.data, runtime: { ...f.data.runtime, [key]: value } }); rejects(f)
    }
  }
  // Even a path that returns inside through a second alias may not traverse an outside directory.
  symlinkSync(join(f.resourcesPath, 'node'), join(outside, 'back'))
  f.write({ ...f.data, runtime: { ...f.data.runtime, nodeExecutable: 'escape/back/bin/node' } }); rejects(f)
})

test('refuses ASAR entry paths and aliases but permits physical unpacked resources', t => {
  const f = fixture(t)
  for (const directory of ['runtime.asar', 'CAPITAL.ASAR', 'runtime.asar.unpacked']) {
    mkdirSync(join(f.resourcesPath, directory))
    writeFileSync(join(f.resourcesPath, directory, 'node'), 'physical fixture', { mode: 0o700 })
  }
  for (const key of Object.keys(f.data.runtime)) {
    for (const directory of ['runtime.asar', 'CAPITAL.ASAR']) {
      f.write({ ...f.data, runtime: { ...f.data.runtime, [key]: key === 'deviceBundle' ? directory : `${directory}/node` } }); rejects(f)
    }
  }
  symlinkSync('runtime.asar/node', join(f.resourcesPath, 'asar-alias'))
  f.write({ ...f.data, runtime: { ...f.data.runtime, nodeExecutable: 'asar-alias' } }); rejects(f)
  f.write({ ...f.data, runtime: { ...f.data.runtime, nodeExecutable: 'runtime.asar.unpacked/node' } })
  assert.equal(readInstalledDesktopConfig(f).resources.nodeExecutable, realpathSync(join(f.resourcesPath, 'runtime.asar.unpacked/node')))
})

test('requires explicit worker limits and an immutable already-local Runner image', t => {
  const f = fixture(t)
  const { worker: _worker, ...withoutWorker } = f.data
  f.write(withoutWorker); rejects(f)
  for (const worker of [{ ...f.data.worker, image: 'runner:latest' }, { ...f.data.worker, env: {} },
    { ...f.data.worker, platformUrl: 'https://other.example' }, { ...f.data.worker, privateDir: '/other' },
    { ...f.data.worker, dockerStopGraceSeconds: 10 }, { ...f.data.worker, directoryPickerTimeoutMs: 120001 }]) {
    f.write({ ...f.data, worker }); rejects(f)
  }
  for (const key of ['pollMs', 'contactGraceMs', 'commandPollMs', 'platformRequestTimeoutMs',
    'dockerCommandTimeoutMs', 'dockerStopTimeoutMs', 'fileOperationTimeoutMs']) {
    for (const value of [0, 1.5, 60001]) { f.write({ ...f.data, worker: { ...f.data.worker, [key]: value } }); rejects(f) }
  }
})

test('bounds the fixed descriptor and rejects missing, malformed, directory and escaping descriptions', t => {
  const f = fixture(t)
  rmSync(f.descriptorPath); rejects(f)
  mkdirSync(f.descriptorPath); rejects(f); rmSync(f.descriptorPath, { recursive: true })
  writeFileSync(f.descriptorPath, '{invalid'); rejects(f)
  writeFileSync(f.descriptorPath, ' '.repeat(65537)); rejects(f)
  const outside = join(f.base, 'description.json'); writeFileSync(outside, JSON.stringify(f.data))
  rmSync(f.descriptorPath); symlinkSync(outside, f.descriptorPath); rejects(f)
})

test('requires an existing private owned state root outside the installation', t => {
  const f = fixture(t)
  for (const resourcesPath of ['relative', join(f.base, 'missing'), f.descriptorPath]) rejects({ ...f, resourcesPath })
  for (const productUserDataPath of ['relative', join(f.base, 'missing'), f.descriptorPath, f.resourcesPath]) {
    rejects({ ...f, productUserDataPath })
  }
  chmodSync(f.productUserDataPath, 0o755); rejects(f); chmodSync(f.productUserDataPath, 0o700)
  const alias = join(f.base, 'state-alias'); symlinkSync(f.productUserDataPath, alias)
  rejects({ ...f, productUserDataPath: alias })
  const inside = join(f.resourcesPath, 'state'); mkdirSync(inside, { mode: 0o700 })
  rejects({ ...f, productUserDataPath: inside })
})

test('rejects aliases and files at existing state paths without modifying them', t => {
  const f = fixture(t), outside = join(f.base, 'external-state'); mkdirSync(outside)
  for (const name of ['device', 'device-writers']) {
    const path = join(f.productUserDataPath, name)
    symlinkSync(outside, path); rejects(f); rmSync(path)
    writeFileSync(path, 'retained invalid state'); rejects(f)
    assert.equal(readFileSync(path, 'utf8'), 'retained invalid state'); rmSync(path)
  }
  const device = join(f.productUserDataPath, 'device'); mkdirSync(device)
  for (const name of ['home', 'work', 'private']) {
    const path = join(device, name)
    symlinkSync(outside, path); rejects(f); rmSync(path)
    writeFileSync(path, 'retained invalid state'); rejects(f); rmSync(path)
  }
})
