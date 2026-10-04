/** Loads unmodified production main after replacing only Electron installation facts and local services. */
import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import promises from 'node:fs/promises'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createPortReservation } from 'node:net'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog } from 'electron'

const root = process.env.PE_INSTALLED_GATE_ROOT, scenario = process.env.PE_INSTALLED_GATE_SCENARIO
const compiled = process.env.PE_INSTALLED_GATE_COMPILED, runtime = JSON.parse(process.env.PE_INSTALLED_GATE_RUNTIME ?? 'null')
if ([root, scenario, compiled].some(value => value === undefined) || runtime === null) throw new Error('invalid_installed_main_fixture')
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('use-mock-keychain')
Object.defineProperty(app, 'isPackaged', { value: true })
Object.defineProperty(process, 'resourcesPath', { value: join(root, 'resources') })
app.setPath('appData', join(root, 'app-data'))
process.argv = [process.execPath, ...(scenario.startsWith('override-') ? ['--' + scenario.slice('override-'.length), join(root, 'unused')] : [])]
const servers = [], cases = [], dialogs = [], data = join(root, 'app-data/PowerEvolve')
let failure, finishing = false, normalQuit = false
let prepareEntered = false, releasePreparation
if (scenario === 'prepare-quit') {
  const original = promises.mkdir
  const gate = new Promise(resolve => { releasePreparation = resolve })
  promises.mkdir = async (path, ...args) => {
    if (path === join(data, 'device/home/profiles')) { prepareEntered = true; await gate }
    return original(path, ...args)
  }
  syncBuiltinESMExports()
}

async function until(check, code, limit = 5000) {
  const deadline = Date.now() + limit
  while (!await check()) { if (Date.now() > deadline) throw new Error(code); await delay(10) }
}
async function absent(path) {
  try { await lstat(path); return false }
  catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
async function records() {
  try { return (await readFile(join(root, 'cli.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function serve() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>Installed main fixture</title><h1>Cloud fixture</h1>')
  })
  servers.push(server)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}
async function devicePort() {
  const server = createPortReservation()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
dialog.showMessageBox = async (...args) => {
  const options = args.find(value => Array.isArray(value?.buttons)); assert(options, 'unexpected_dialog')
  dialogs.push({ type: options.type, buttons: options.buttons.length })
  return { response: options.buttons.length === 2 ? 1 : 0, checkboxChecked: false }
}

async function finalize() {
  if (finishing) return
  finishing = true
  try {
    const rows = await records(), pids = rows.filter(row => row.event === 'spawn').map(row => row.pid)
    if (scenario === 'installed' && failure === undefined) {
      assert(normalQuit, 'normal_quit_not_requested'); assert.equal(pids.length, 1, 'unexpected_child_count')
      assert.equal(rows.at(-1)?.event, 'terminate-exit', 'owned_cli_not_terminated')
      await until(() => pids.every(pid => !alive(pid)), 'owned_cli_remained_alive', 1000)
      assert.deepEqual(rows.filter(row => row.event === 'request').map(row => row.action), ['inspect', 'quiesce', 'inspect', 'terminate'])
      assert.equal(dialogs.length, 0, 'clean_quit_warned')
      cases.push({ name: 'normal-quit-awaits-owned-node-close', passed: true })
    }
    if (scenario === 'prepare-quit' && failure === undefined) {
      assert(normalQuit && prepareEntered, 'prepare_quit_not_requested')
      assert.equal(pids.length, 0, 'cancelled_preparation_spawned_child')
      const profile = join(data, 'device/home/profiles/power-evolve-device')
      for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml']) assert((await lstat(join(profile, name))).isFile(), 'preparation_not_awaited')
      assert.equal(await realpath(join(profile, 'node_modules/@power-evolve/device')), join(root, 'resources', runtime.deviceBundle))
      cases.push({ name: 'quit-awaits-real-profile-preparation-without-spawning', passed: true })
    }
    for (const pid of pids) if (alive(pid)) {
      process.kill(pid, 'SIGKILL'); await until(() => !alive(pid), 'fixture_child_cleanup_failed', 2000)
    }
  } catch (error) { failure ??= error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'fixture_cleanup_failed' }
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  const rows = await records()
  const result = { scenario, complete: failure === undefined, electron: process.versions.electron, cases,
    cleanup: { windows: BrowserWindow.getAllWindows().length, servers: servers.filter(server => server.listening).length,
      ownedChildren: rows.filter(row => row.event === 'spawn' && alive(row.pid)).length },
    substitutes: { installationFacts: 'isPackaged/resourcesPath/appData/packaged-argv', descriptor: 'physical-static-template',
      node: 'copied-actual-node-executable', cli: 'owned-os-child-lifecycle-protocol', html: 'independent-loopback',
      preparation: scenario === 'prepare-quit' ? 'promise-gated-real-mkdir-for-lifecycle-only' : 'unchanged-production-filesystem-preparation',
      dialog: 'answers-only', deviceBundle: 'static-manifest-not-loaded', pythonAndHelper: 'existence-only-never-executed',
      mainAndPreloads: 'unchanged-production-artifacts', actualApp: false, abi: false, profileRuntime: false, worker: false, docker: false, pg: false },
    ...(failure === undefined ? {} : { failure: { code: failure } }) }
  writeSync(1, 'PE_PRODUCT_INSTALLED_RESULT ' + JSON.stringify(result) + '\n')
  app.exit(failure === undefined ? 0 : 1)
}
// Product main owns before-quit. The observer closes fixture services only after will-quit.
app.on('will-quit', event => { event.preventDefault(); void finalize() })

async function run() {
  const hostOrigin = await serve(), platformOrigin = await serve(), port = await devicePort()
  process.env.PE_INSTALLED_GATE_PORT = String(port)
  const worker = { image: 'sha256:' + 'a'.repeat(64), pollMs: 500, contactGraceMs: 5000, commandPollMs: 250,
    platformRequestTimeoutMs: 10000, dockerCommandTimeoutMs: 15000, dockerStopTimeoutMs: 10000,
    dockerStopGraceSeconds: 2, directoryPickerTimeoutMs: 120000, fileOperationTimeoutMs: 10000 }
  const descriptor = { kind: 'power-evolve-desktop', version: 1, deployment: { hostOrigin, platformOrigin },
    runtime: { ...runtime, ...(scenario === 'cli-anchor' ? { deviceBundle: 'runtime/descriptor-device' } : {}) }, worker,
    device: { profile: 'power-evolve-device', loopbackOrigin: `http://127.0.0.1:${port}`,
      startupTimeoutMs: 5000, requestTimeoutMs: 500, quiesceTimeoutMs: 1500, exitTimeoutMs: 1000,
      maxOutputBytes: 16384, maxMessageBytes: 16384, maxHealthBytes: 4096 } }
  const descriptorPath = join(root, 'resources/power-evolve-desktop.json')
  const descriptorBytes = JSON.stringify(descriptor)
  await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 })
  let overlayInfo, overlayBytes
  const overlay = join(data, 'device/home/cordis.patch.yml')
  if (scenario === 'home-overlay') {
    await mkdir(join(data, 'device/home'), { recursive: true, mode: 0o700 })
    overlayBytes = 'retained-installation-overlay\n'; await writeFile(overlay, overlayBytes, { mode: 0o600 }); overlayInfo = await lstat(overlay)
  }
  if (scenario.startsWith('override-')) {
    await assert.rejects(import(pathToFileURL(join(compiled, 'main.js')).href),
      { message: 'PowerEvolve desktop: installed startup does not accept runtime overrides' })
    assert.equal(BrowserWindow.getAllWindows().length, 0, 'override_created_window')
    assert.equal((await records()).length, 0, 'override_spawned_child'); assert(await absent(data), 'override_created_user_data')
    cases.push({ name: scenario + '-rejected-before-startup', passed: true }); await finalize(); return
  }
  await import(pathToFileURL(join(compiled, 'main.js')).href)
  let primary
  await until(() => {
    primary = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === hostOrigin + '/native/')
    return primary !== undefined
  }, 'fixed_host_window_missing')
  await until(async () => primary.webContents.executeJavaScript('typeof window.powerEvolveDesktopDevice?.openAuthorization === "function"'),
    'production_preload_missing')
  assert.equal(app.getPath('userData'), data, 'installed_state_root_changed')
  assert.equal((await records()).length, 0, 'cloud_start_spawned_child')
  assert(await absent(join(data, 'device/home/profiles')), 'cloud_start_created_profile')
  if (scenario === 'installed') assert(await absent(join(data, 'device')), 'cloud_start_created_device_state')
  cases.push({ name: 'fixed-resource-cloud-start-without-profile-or-child', passed: true })
  if (scenario === 'prepare-quit') {
    await primary.webContents.executeJavaScript('void powerEvolveDesktopDevice.openAuthorization().catch(() => {}); true')
    await until(() => prepareEntered, 'profile_preparation_gate_not_reached')
    assert(await absent(join(data, 'device/home/profiles')), 'preparation_gate_not_blocking')
    normalQuit = true; app.quit()
    await delay(100)
    assert.equal(finishing, false, 'quit_did_not_wait_for_profile_preparation')
    assert.equal(primary.isDestroyed(), false, 'quit_destroyed_primary_during_preparation')
    assert.equal((await records()).length, 0, 'preparation_spawned_child')
    cases.push({ name: 'quit-held-while-profile-mkdir-is-pending', passed: true })
    releasePreparation(); return
  }
  if (scenario === 'installed') {
    await primary.webContents.executeJavaScript('Promise.all([powerEvolveDesktopDevice.openAuthorization(), powerEvolveDesktopDevice.openAuthorization()])')
    const profile = join(data, 'device/home/profiles/power-evolve-device')
    assert.deepEqual(await readdir(join(data, 'device/home/profiles')), ['power-evolve-device'], 'duplicate_profile')
    assert.equal((await records()).filter(row => row.event === 'spawn').length, 1, 'duplicate_child')
    assert.equal(BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() === `http://127.0.0.1:${port}/`).length, 1, 'duplicate_device_window')
    cases.push({ name: 'concurrent-local-openers-share-one-profile-child-window', passed: true })
    assert.deepEqual(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')),
      { name: 'dsh-profile-power-evolve-device', private: true, dependencies: {}, dsh: { profile: { bundles: ['@power-evolve/device'] } } })
    assert.equal(await readFile(join(profile, 'cordis.yml'), 'utf8'), '[]\n')
    assert.equal(await realpath(join(profile, 'node_modules/@power-evolve/device')), join(root, 'resources', runtime.deviceBundle))
    const patch = JSON.parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'))
    assert.deepEqual(patch, [{ id: 'web-server', config: { host: '127.0.0.1', port } }, { id: 'power-evolve-device', config: {
      platformUrl: platformOrigin, privateDir: join(data, 'device/private'), coordinationRoot: join(data, 'device-writers'),
      pythonExecutable: join(root, 'resources', runtime.pythonExecutable), ...worker, readyFile: join(data, 'device/private/ready.json'),
    } }])
    const spawn = (await records()).find(row => row.event === 'spawn')
    for (const field of ['executableMatches', 'homeMatches', 'cwdMatches', 'profileMatches']) assert.equal(spawn[field], true, 'installed_cli_launch_changed')
    assert.equal(await readFile(descriptorPath, 'utf8'), descriptorBytes, 'installed_descriptor_changed')
    cases.push({ name: 'fixed-worker-and-resource-profile-prepared-before-real-node-launch', passed: true })
  } else {
    assert.equal(await primary.webContents.executeJavaScript('powerEvolveDesktopDevice.openAuthorization().then(() => false, () => true)'), true,
      'unsafe_installation_admitted')
    assert.equal((await records()).length, 0, 'rejected_installation_spawned_child')
    assert(await absent(join(data, 'device/home/profiles')), 'rejected_installation_created_profile')
    if (scenario === 'home-overlay') {
      assert.equal(await readFile(overlay, 'utf8'), overlayBytes, 'overlay_bytes_changed')
      assert.equal((await lstat(overlay)).ino, overlayInfo.ino, 'overlay_inode_changed')
    }
    cases.push({ name: scenario + '-retained-and-refused-before-profile-and-spawn', passed: true })
  }
  normalQuit = true; app.quit()
}
void run().catch(error => {
  failure = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'installed_fixture_failed'
  releasePreparation?.()
  void finalize()
})
