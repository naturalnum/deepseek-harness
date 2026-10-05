/** Real temporary filesystem and the built formal Profile parser; no plugin or interpreter is launched. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, type TestContext } from 'node:test'
import type { InstalledDesktopConfig } from '../src/installed-config.ts'
import { prepareInstalledDeviceProfile, type DeviceWorkerParameters } from '../src/installed-profile.ts'
import { DeviceWriterCoordinator, deviceWriterOwner, DEVICE_WRITER_SLOT_FILENAME } from '../../application/src/device/writer-coordinator.ts'
import { randomUUID } from 'node:crypto'

const worker: DeviceWorkerParameters = {
  image: 'qa-runner@sha256:' + 'a'.repeat(64), pollMs: 500, contactGraceMs: 5000,
  commandPollMs: 250, platformRequestTimeoutMs: 10000, dockerCommandTimeoutMs: 15000,
  dockerStopTimeoutMs: 10000, dockerStopGraceSeconds: 2, directoryPickerTimeoutMs: 120000,
  fileOperationTimeoutMs: 10000,
}
const error = { message: 'PowerEvolve desktop: invalid installed Device Profile' }
const sourceDevice = fileURLToPath(new URL('../../device/', import.meta.url))

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'pe-installed-profile-')))
  t.after(async () => { await rm(base, { recursive: true, force: true }) })
  const productUserDataPath = join(base, 'PowerEvolve')
  await mkdir(productUserDataPath, { mode: 0o700 })
  async function resources(name: string) {
    const resourcesPath = join(base, name)
    await mkdir(resourcesPath)
    const runtime = { nodeExecutable: 'node/bin/node', cliEntrypoint: 'cli/lib/bin.js',
      pythonExecutable: 'python/bin/python3', fileHelper: 'application/.src/device/local-files.py' }
    for (const [key, value] of Object.entries(runtime)) {
      const path = join(resourcesPath, value)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'nonexecutable fixture content\n', { mode: key.endsWith('Executable') ? 0o700 : 0o600 })
    }
    const bundle = join(resourcesPath, 'runtime', 'objects', 'device')
    await mkdir(bundle, { recursive: true })
    for (const file of ['package.json', 'cordis.patch.yml']) await copyFile(join(sourceDevice, file), join(bundle, file))
    const state = { productUserDataPath, homeDir: join(productUserDataPath, 'device/home'),
      workingDir: join(productUserDataPath, 'device/work'), privateDir: join(productUserDataPath, 'device/private'),
      coordinationRoot: join(productUserDataPath, 'device-writers') }
    const input = {
      config: { hostOrigin: 'https://host.example', platformOrigin: 'https://platform.example' },
      commandSearchPath: ['/usr/bin', '/bin'],
      deviceConfig: { nodeExecutable: join(resourcesPath, runtime.nodeExecutable), cliEntrypoint: join(resourcesPath, runtime.cliEntrypoint),
        homeDir: state.homeDir, workingDir: state.workingDir, profile: 'power-evolve-device', loopbackOrigin: 'http://127.0.0.1:20891',
        startupTimeoutMs: 30000, requestTimeoutMs: 3000, quiesceTimeoutMs: 60000, exitTimeoutMs: 10000,
        maxOutputBytes: 65536, maxMessageBytes: 262144, maxHealthBytes: 4096 },
      resources: { root: resourcesPath, nodeExecutable: join(resourcesPath, runtime.nodeExecutable),
        cliEntrypoint: join(resourcesPath, runtime.cliEntrypoint), pythonExecutable: join(resourcesPath, runtime.pythonExecutable),
        fileHelper: join(resourcesPath, runtime.fileHelper), deviceBundle: bundle },
      state, worker,
    }
    const config: InstalledDesktopConfig = input
    return { config, bundle }
  }
  const installed = await resources('resources-v1')
  const prepare = () => prepareInstalledDeviceProfile(installed.config, worker, installed.bundle)
  return { base, ...installed, resources, prepare }
}
async function absent(path: string): Promise<void> { await assert.rejects(lstat(path), { code: 'ENOENT' }) }

test('prepares only the Device bundle, empty root and complete fixed product updates', async t => {
  const f = await fixture(t), result = await f.prepare()
  assert.equal(result.profileDir, join(f.config.state.homeDir, 'profiles', f.config.deviceConfig.profile))
  assert.equal(result.readyFile, join(f.config.state.privateDir, 'ready.json'))
  const manifest = JSON.parse(await readFile(join(result.profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest, { name: 'dsh-profile-power-evolve-device', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@power-evolve/device'] } } })
  assert.equal(await readFile(join(result.profileDir, 'cordis.yml'), 'utf8'), '[]\n')
  const patch = JSON.parse(await readFile(join(result.profileDir, 'cordis.patch.yml'), 'utf8'))
  assert.deepEqual(patch, [
    { id: 'web-server', config: { host: '127.0.0.1', port: 20891 } },
    { id: 'power-evolve-device', config: { platformUrl: 'https://platform.example', privateDir: f.config.state.privateDir,
      coordinationRoot: f.config.state.coordinationRoot, pythonExecutable: f.config.resources.pythonExecutable,
      ...worker, readyFile: result.readyFile } },
  ])
  assert.equal(await realpath(join(result.profileDir, 'node_modules/@power-evolve/device')), f.bundle)
  for (const path of [f.config.state.productUserDataPath, f.config.state.homeDir, f.config.state.workingDir,
    f.config.state.privateDir, f.config.state.coordinationRoot, dirname(result.profileDir), result.profileDir,
    join(result.profileDir, 'node_modules'), join(result.profileDir, 'node_modules/@power-evolve')]) {
    const info = await lstat(path)
    assert.equal(info.uid, process.getuid?.()); assert.equal(info.mode & 0o777, 0o700)
  }
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
    assert.equal((await lstat(join(result.profileDir, file))).mode & 0o777, 0o600)
  }
  await absent(result.readyFile)
})

test('separate installed identities retain one writer slot and block a different or unknown writer', async t => {
  const f = await fixture(t)
  await f.prepare()
  const root = join(f.base, 'PowerEvolve-office-qa-1')
  await mkdir(root, { mode: 0o700 })
  const namespaced: InstalledDesktopConfig = { ...f.config,
    state: { ...f.config.state, productUserDataPath: root, homeDir: join(root, 'device/home'),
      workingDir: join(root, 'device/work'), privateDir: join(root, 'device/private') },
    deviceConfig: { ...f.config.deviceConfig, homeDir: join(root, 'device/home'), workingDir: join(root, 'device/work') },
  }
  const original = deviceWriterOwner.parse({ kind: 'command', deviceId: randomUUID(), enrollmentId: randomUUID(),
    executionId: randomUUID(), processId: randomUUID(), directoryId: randomUUID(), requestDigest: 'a'.repeat(64) })
  const first = new DeviceWriterCoordinator(f.config.state.coordinationRoot), second = new DeviceWriterCoordinator(namespaced.state.coordinationRoot)
  const lease = await first.command(original)
  t.after(() => lease.release())
  const slotPath = join(f.config.state.coordinationRoot, DEVICE_WRITER_SLOT_FILENAME)
  const before = { info: await lstat(slotPath, { bigint: true }), bytes: await readFile(slotPath) }
  await prepareInstalledDeviceProfile(namespaced, worker, f.bundle)
  const patch = JSON.parse(await readFile(join(namespaced.state.homeDir, 'profiles/power-evolve-device/cordis.patch.yml'), 'utf8'))
  assert.equal(patch[1].config.coordinationRoot, f.config.state.coordinationRoot)
  assert.equal(patch[1].config.privateDir, namespaced.state.privateDir)
  await assert.rejects(second.command({ ...original, executionId: deviceWriterOwner.shape.executionId.parse(randomUUID()) }),
    { code: 'device_process_already_owned' })
  await lease.release()
  await assert.rejects(second.transfer(async () => {}), { code: 'device_writer_busy' })
  await assert.rejects(second.command({ ...original, executionId: deviceWriterOwner.shape.executionId.parse(randomUUID()) }),
    { code: 'device_writer_busy' })
  assert.deepEqual(await readFile(slotPath), before.bytes)
  const after = await lstat(slotPath, { bigint: true })
  assert.equal(after.ino, before.info.ino); assert.equal(after.dev, before.info.dev)
})

test('refuses changing the retained Platform origin before replacing Profile or Device identity bytes', async t => {
  const f = await fixture(t), result = await f.prepare()
  const patchPath = join(result.profileDir, 'cordis.patch.yml')
  const privatePath = join(f.config.state.privateDir, 'device.json')
  await writeFile(privatePath, 'retained device identity', { mode: 0o600 })
  const before = { patch: await readFile(patchPath), identity: await readFile(privatePath), info: await lstat(patchPath, { bigint: true }) }
  const another: InstalledDesktopConfig = { ...f.config, config: { ...f.config.config, platformOrigin: 'https://another-platform.example' } }
  await assert.rejects(prepareInstalledDeviceProfile(another, worker, f.bundle), error)
  assert.deepEqual(await readFile(patchPath), before.patch)
  assert.deepEqual(await readFile(privatePath), before.identity)
  const after = await lstat(patchPath, { bigint: true })
  assert.equal(after.ino, before.info.ino); assert.equal(after.dev, before.info.dev)
})

test('does not treat a missing Profile patch with retained Device identity or journal as a fresh installation', async t => {
  const f = await fixture(t), result = await f.prepare()
  await rm(join(result.profileDir, 'cordis.patch.yml'))
  for (const name of ['device.json', 'journal.json']) {
    const path = join(f.config.state.privateDir, name)
    await writeFile(path, 'retained private bytes', { mode: 0o600 })
    await assert.rejects(f.prepare(), error)
    assert.equal(await readFile(path, 'utf8'), 'retained private bytes')
    await absent(join(result.profileDir, 'cordis.patch.yml'))
    await rm(path)
  }
  await f.prepare()
  assert((await readFile(join(result.profileDir, 'cordis.patch.yml'), 'utf8')).includes('https://platform.example'))
})

test('formal loader resolves the projection and replaces ambient bundle config without duplicate plugins', async t => {
  const f = await fixture(t), result = await f.prepare()
  // This offline regression requires app-boot's existing built bytes, supplied explicitly in source-only lanes.
  const bootPath = process.env.PE_INSTALLED_PROFILE_BOOT
    ?? fileURLToPath(new URL('../../../../packages/boot/app-boot/lib/index.js', import.meta.url))
  const boot: Pick<typeof import('../../../../packages/boot/app-boot/src/index.ts'),
    'loadProfileDirectory' | 'composeEntries' | 'renderConfigDump'> = await import(pathToFileURL(bootPath).href)
  const installAnchor = join(f.base, 'unrelated-cli', 'package.json')
  await mkdir(dirname(installAnchor))
  await writeFile(installAnchor, JSON.stringify({ name: 'fixture-cli', type: 'module' }))
  const profile = boot.loadProfileDirectory('dsh', result.profileDir, installAnchor)
  assert.deepEqual(profile.skippedBundles, [])
  assert.deepEqual(profile.layers.map(layer => layer.packageName), ['@power-evolve/device'])
  const warnings: string[] = []
  const rows = boot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], message => warnings.push(message))
  assert.deepEqual(warnings, [])
  assert.deepEqual(rows.map(row => row.id), ['logger-console', 'web-server', 'power-evolve-device'])
  assert.deepEqual(rows[1]?.config, { host: '127.0.0.1', port: 20891 })
  assert.deepEqual(rows[2]?.config, { platformUrl: f.config.config.platformOrigin, privateDir: f.config.state.privateDir,
    coordinationRoot: f.config.state.coordinationRoot, pythonExecutable: f.config.resources.pythonExecutable,
    ...worker, readyFile: result.readyFile })
  const dump = boot.renderConfigDump('dsh', join(result.profileDir, 'cordis.yml'), [
    ...profile.layers.map(layer => ({ label: layer.packageName, patches: layer.patches })),
    { label: 'owned-device-profile', patches: profile.patches },
  ], message => warnings.push(message))
  assert.deepEqual(warnings, [])
  assert(!dump.includes('!!js')); assert(!dump.includes('process.env')); assert(!dump.includes('dshHomePath'))
})

test('reopening preserves journal, writer lock, readiness and arbitrary Home files and inodes', async t => {
  const f = await fixture(t), result = await f.prepare()
  const preserved = [join(f.config.state.privateDir, 'journal.json'), join(f.config.state.privateDir, 'worker.lock'),
    join(f.config.state.coordinationRoot, 'writer.lock'), join(f.config.state.homeDir, 'user-notes'),
    join(f.config.state.homeDir, 'cordis.patch.yml'), join(result.profileDir, 'unrelated-state'), result.readyFile]
  for (const path of preserved) await writeFile(path, `retained ${path.split('/').at(-1)}\n`, { mode: 0o600 })
  const bytes = await Promise.all(preserved.map(path => readFile(path)))
  const infos = await Promise.all(preserved.map(path => lstat(path)))
  const home = await lstat(f.config.state.homeDir)
  const profileBytes = await readFile(join(result.profileDir, 'cordis.patch.yml'))
  assert.deepEqual(await f.prepare(), result)
  for (let index = 0; index < preserved.length; index++) {
    const path = preserved[index]!
    assert.deepEqual(await readFile(path), bytes[index]); assert.equal((await lstat(path)).ino, infos[index]?.ino)
  }
  assert.equal((await lstat(f.config.state.homeDir)).ino, home.ino)
  assert.deepEqual(await readFile(join(result.profileDir, 'cordis.patch.yml')), profileBytes)
  assert(!(await readdir(result.profileDir)).some(name => name.startsWith('.device-profile-')))
})

test('an installed resource upgrade atomically redirects only its projection and updates the owned patch', async t => {
  const f = await fixture(t), first = await f.prepare(), replacement = await f.resources('resources-v2')
  const previous = await readFile(join(f.bundle, 'package.json'))
  const journal = join(f.config.state.privateDir, 'journal.json')
  await writeFile(journal, 'kept recovery intent', { mode: 0o600 })
  const second = await prepareInstalledDeviceProfile(replacement.config, { ...worker, pollMs: 750 }, replacement.bundle)
  assert.deepEqual(second, first)
  assert.equal(await realpath(join(first.profileDir, 'node_modules/@power-evolve/device')), replacement.bundle)
  assert.deepEqual(await readFile(join(f.bundle, 'package.json')), previous)
  assert.equal(await readFile(journal, 'utf8'), 'kept recovery intent')
  const patch = JSON.parse(await readFile(join(first.profileDir, 'cordis.patch.yml'), 'utf8'))
  assert.equal(patch[1].config.pollMs, 750)
})

test('permits a contained resource alias but refuses a package or intermediate lookup outside resources', async t => {
  const f = await fixture(t)
  const alias = join(f.config.resources.root, 'selected-device')
  await symlink('runtime/objects/device', alias)
  await prepareInstalledDeviceProfile(f.config, worker, alias)
  const outside = join(f.base, 'outside'); await mkdir(outside)
  await symlink(f.bundle, join(outside, 'back'))
  const escape = join(f.config.resources.root, 'escape'); await symlink(outside, escape)
  await assert.rejects(prepareInstalledDeviceProfile(f.config, worker, outside), error)
  await assert.rejects(prepareInstalledDeviceProfile(f.config, worker, join(escape, 'back')), error)
})

test('refuses mismatched, malformed, oversized, symlink and nonregular package manifests before creating state', async t => {
  const f = await fixture(t), path = join(f.bundle, 'package.json'), original = await readFile(path)
  for (const bytes of ['{"name":"@power-evolve/host"}', 'null', '[]', '{invalid', ' '.repeat(65537)]) {
    await writeFile(path, bytes); await assert.rejects(f.prepare(), error); await absent(f.config.state.homeDir)
  }
  await rm(path)
  const outside = join(f.base, 'ordinary.json'); await writeFile(outside, original)
  await symlink(outside, path); await assert.rejects(f.prepare(), error); await rm(path)
  await mkdir(path); await assert.rejects(f.prepare(), error); await rm(path, { recursive: true })
  execFileSync('/usr/bin/mkfifo', [path]); await assert.rejects(f.prepare(), error)
  await absent(f.config.state.homeDir)
})

test('refuses unsafe existing state and Profile directories without clearing any bytes', async t => {
  const f = await fixture(t), result = await f.prepare(), outside = join(f.base, 'outside')
  await mkdir(outside)
  const paths = [f.config.state.workingDir, f.config.state.privateDir, f.config.state.coordinationRoot,
    join(result.profileDir, 'node_modules/@power-evolve'), join(result.profileDir, 'node_modules'),
    result.profileDir, dirname(result.profileDir), f.config.state.homeDir, dirname(f.config.state.homeDir)]
  for (const path of paths) {
    const backup = `${path}-retained`
    await rename(path, backup)
    await symlink(outside, path); await assert.rejects(f.prepare(), error); await rm(path)
    await writeFile(path, 'retained invalid path', { mode: 0o600 }); await assert.rejects(f.prepare(), error)
    assert.equal(await readFile(path, 'utf8'), 'retained invalid path'); await rm(path)
    await rename(backup, path)
    await chmod(path, 0o755); await assert.rejects(f.prepare(), error); await chmod(path, 0o700)
  }
})

test('refuses symlink, directory, FIFO and public reserved files without changing other Profile bytes', async t => {
  const f = await fixture(t), result = await f.prepare()
  const outside = join(f.base, 'outside'); await writeFile(outside, 'unchanged external bytes')
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
    const path = join(result.profileDir, file), original = await readFile(path)
    await rm(path); await symlink(outside, path); await assert.rejects(f.prepare(), error); await rm(path)
    await mkdir(path); await assert.rejects(f.prepare(), error); await rm(path, { recursive: true })
    execFileSync('/usr/bin/mkfifo', [path]); await assert.rejects(f.prepare(), error); await rm(path)
    await writeFile(path, original, { mode: 0o644 }); await assert.rejects(f.prepare(), error)
    assert.deepEqual(await readFile(path), original); await chmod(path, 0o600)
  }
  assert.equal(await readFile(outside, 'utf8'), 'unchanged external bytes')
  assert(!(await readdir(result.profileDir)).some(name => name.startsWith('.device-profile-')))
})

test('rejects nonlink package projections but can replace a broken old link without following it', async t => {
  const f = await fixture(t), result = await f.prepare(), path = join(result.profileDir, 'node_modules/@power-evolve/device')
  await rm(path); await mkdir(path); await assert.rejects(f.prepare(), error); await rm(path, { recursive: true })
  await writeFile(path, 'retained invalid projection'); await assert.rejects(f.prepare(), error)
  assert.equal(await readFile(path, 'utf8'), 'retained invalid projection'); await rm(path)
  await symlink(join(f.base, 'missing-old-resources'), path); await f.prepare()
  assert.equal(await realpath(path), f.bundle)
})

test('refuses unsafe existing readiness path instead of clearing or following it', async t => {
  const f = await fixture(t), result = await f.prepare(), outside = join(f.base, 'outside')
  await writeFile(outside, 'external readiness retained')
  await symlink(outside, result.readyFile); await assert.rejects(f.prepare(), error); await rm(result.readyFile)
  await mkdir(result.readyFile); await assert.rejects(f.prepare(), error)
  assert.equal(await readFile(outside, 'utf8'), 'external readiness retained')
})
