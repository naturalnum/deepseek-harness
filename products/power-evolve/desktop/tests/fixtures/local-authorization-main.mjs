/** Real Electron component gate; synthetic HTML, Device generations and controlled native chooser only. */
import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'

const root = process.argv.find(value => value.startsWith('--pe-local-gate-root='))?.slice('--pe-local-gate-root='.length)
if (root === undefined) throw new Error('The gate requires its parent-owned temporary directory')
app.setPath('userData', join(root, 'user-data'))
app.setName('PowerEvolve Local Authorization Gate')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('use-mock-keychain')
const probe = fileURLToPath(new URL('./local-authorization-preload.cjs', import.meta.url))
const windows = new Set(), cloudWindows = new Set(), servers = [], cases = [], sessions = new Set()
const actualEvents = new Map(), handlers = new Map(), pickerOutcomes = []
let active = 'startup', primary, manager, device = { generation: 1 }, config, channels
let chooser, chooserCalls = 0, activePickers = 0, heldResponse, heldEntered, deviceMode = 'normal', deviceLoads = 0
const originalDialog = dialog.showOpenDialog
const originalHandle = ipcMain.handle.bind(ipcMain)

/** One bounded fixture wait; production waits remain unchanged. */
function bounded(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture_deadline')), 5000)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/** A controlled operation whose completion can follow real navigation or window close. */
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

/** Emit only fixed behavior names, without DOM contents or directory paths. */
async function check(name, action) {
  active = name
  await bounded(action())
  cases.push({ name, passed: true })
}

/** Three ephemeral loopback servers contain no account, application or runtime data. */
async function serve(role) {
  const server = createServer((request, response) => {
    if (role === 'device' && request.url === '/') {
      deviceLoads++
      if (deviceMode === 'fail') { response.destroy(); return }
      if (deviceMode === 'held') { heldResponse = response; heldEntered.resolve(); return }
    }
    respond(response, role)
  })
  servers.push(server)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}

function respond(response, role) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html><meta charset="utf-8"><title>Local gate ${role}</title>
    <h1>${role}</h1><script>window.syntheticNonce=${JSON.stringify('fixture-generation-' + device?.generation)}</script>
    ${role === 'host' ? '<iframe name="local-gate-child" src="/native/frame"></iframe>' : ''}`)
}

/** The real frame invokes a real registered main handler; refusal cannot come from the test renderer. */
async function rejected(frame, channel) {
  assert.equal(await frame.executeJavaScript(`localGateProbe.invoke(${JSON.stringify(channel)}).then(() => false, () => true)`), true)
}

/** Find the component-owned window without reading its private fields. */
function localWindow() {
  const matches = [...windows].filter(window => !window.isDestroyed() && !cloudWindows.has(window))
  assert.equal(matches.length, 1)
  return matches[0]
}

/** Real windows receive production preloads plus a separate test-only IPC probe. */
function cloudWindow() {
  const window = new BrowserWindow({ show: false, webPreferences: { preload: join(root, 'compiled/preload-cloud.cjs'),
    session: session.fromPartition('local-gate-cloud'), sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInSubFrames: true, webSecurity: true, webviewTag: false,
    additionalArguments: [`--power-evolve-host-origin=${config.hostOrigin}`, '--power-evolve-device-enabled'] } })
  cloudWindows.add(window)
  window.once('closed', () => cloudWindows.delete(window))
  return window
}

/** Attach metadata observation around the unchanged production handler, retaining actual Electron events. */
function observeHandlers() {
  ipcMain.handle = (channel, listener) => {
    handlers.set(channel, listener)
    originalHandle(channel, async (event, ...args) => {
      actualEvents.set(channel, event)
      try {
        const value = await listener(event, ...args)
        if (channel === channels.choose) pickerOutcomes.push({ returnedPath: typeof value === 'string', cancelled: value === null })
        return value
      } catch (error) {
        if (channel === channels.choose) pickerOutcomes.push({ returnedPath: false, rejected: true })
        throw error
      }
    })
  }
}

/** Begin a picker through real renderer IPC; its synthetic OS result remains pending. */
async function beginPicker(window) {
  const entered = deferred(), result = deferred()
  chooser = { entered, result }
  await window.webContents.executeJavaScript(`void localGateProbe.invoke(${JSON.stringify(channels.choose)})
    .catch(_retiredDocument => { /* The gate intentionally retires the invoking document. */ }); true`)
  await bounded(entered.promise)
  return result
}

/** Close the current component before another one installs the same product channel. */
async function replaceManager(LocalDeviceWindow, origin, messages) {
  if (manager !== undefined) await manager.close()
  manager = new LocalDeviceWindow({ origin, getDevice: () => device, messages })
}

async function run() {
  let failure
  try {
    await app.whenReady()
    const base = name => import(pathToFileURL(join(root, 'compiled', name + '.js')).href)
    const [{ LocalDeviceWindow }, { DEVICE_DESKTOP_IPC }, { assertCloudSender }, { parseCloudDesktopConfig }] = await Promise.all([
      base('local-device-window'), base('device-ipc'), base('window-policy'), base('config'),
    ])
    channels = DEVICE_DESKTOP_IPC
    const { resolveDesktopLocale } = await import(pathToFileURL(join(root, 'compiled/node_modules/@deepseek-ai/dsh-desktop/lib/types/locale.js')).href)
    const messages = () => resolveDesktopLocale('en').messages
    config = parseCloudDesktopConfig({ hostOrigin: await serve('host'), platformOrigin: await serve('platform') })
    const deviceOrigin = await serve('device')
    app.on('browser-window-created', (_event, window) => {
      windows.add(window)
      window.once('closed', () => windows.delete(window))
      const browser = window.webContents.session
      if (!sessions.has(browser)) {
        browser.registerPreloadScript({ type: 'frame', filePath: probe })
        sessions.add(browser)
      }
    })
    dialog.showOpenDialog = async window => {
      assert(windows.has(window))
      chooserCalls++
      activePickers++
      try {
        if (chooser !== undefined) { const current = chooser; current.entered.resolve(); return await current.result.promise }
        return { canceled: false, filePaths: ['/synthetic/local-authorized-project'] }
      } finally { activePickers-- }
    }
    observeHandlers()
    await replaceManager(LocalDeviceWindow, deviceOrigin, messages)
    ipcMain.handle(channels.open, async (event, ...args) => {
      assertCloudSender(primary, config, event)
      if (args.length !== 0) throw new Error('invalid_local_authorization_request')
      await manager.open()
    })
    primary = cloudWindow()
    await primary.loadURL(config.hostOrigin + '/native/')
    const foreign = cloudWindow()
    await foreign.loadURL(config.hostOrigin + '/native/')

    await check('owned-host-opener-and-device-picker', async () => {
      assert.equal(await primary.webContents.executeJavaScript('typeof powerEvolveDesktopDevice.openAuthorization'), 'function')
      assert.equal(await primary.webContents.executeJavaScript('typeof window.powerEvolveDevicePicker'), 'undefined')
      await primary.webContents.executeJavaScript('powerEvolveDesktopDevice.openAuthorization()')
      const window = localWindow()
      assert.equal(await window.webContents.executeJavaScript('typeof powerEvolveDevicePicker.choose'), 'function')
      assert.equal(await window.webContents.executeJavaScript('typeof window.powerEvolveDesktopDevice'), 'undefined')
      assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined')
      assert.equal(await window.webContents.executeJavaScript('typeof process'), 'undefined')
      assert.equal(await window.webContents.executeJavaScript('powerEvolveDevicePicker.choose().then(value => typeof value === "string")'), true)
      assert.equal(chooserCalls, 1)
    })
    await check('cloud-picker-denied', async () => { await rejected(primary.webContents, channels.choose); assert.equal(chooserCalls, 1) })
    await check('platform-open-picker-denied', async () => {
      await primary.loadURL(config.platformOrigin + '/approval')
      assert.equal(await primary.webContents.executeJavaScript('typeof window.powerEvolveDesktopDevice'), 'undefined')
      await rejected(primary.webContents, channels.open)
      await rejected(primary.webContents, channels.choose)
      assert.equal(chooserCalls, 1)
      await primary.loadURL(config.hostOrigin + '/native/')
    })
    await check('host-iframe-open-picker-denied', async () => {
      const frame = primary.webContents.mainFrame.frames.find(value => value.name === 'local-gate-child')
      assert(frame)
      assert.equal(await frame.executeJavaScript('typeof window.powerEvolveDesktopDevice'), 'undefined')
      await rejected(frame, channels.open)
      await rejected(frame, channels.choose)
      assert.equal(chooserCalls, 1)
    })
    await check('foreign-open-picker-denied', async () => {
      await rejected(foreign.webContents, channels.open)
      await rejected(foreign.webContents, channels.choose)
      assert.equal(chooserCalls, 1)
    })
    await check('stale-open-picker-event-denied', async () => {
      await primary.webContents.executeJavaScript('powerEvolveDesktopDevice.openAuthorization()')
      const oldOpen = actualEvents.get(channels.open)
      const window = localWindow()
      await window.webContents.executeJavaScript('powerEvolveDevicePicker.choose()')
      const oldPicker = actualEvents.get(channels.choose)
      await primary.loadURL(config.platformOrigin + '/login')
      await window.loadURL(config.platformOrigin + '/login')
      await assert.rejects(handlers.get(channels.open)(oldOpen))
      await assert.rejects(handlers.get(channels.choose)(oldPicker))
      await primary.loadURL(config.hostOrigin + '/native/')
    })
    await check('concurrent-open-awaits-one-load', async () => {
      await replaceManager(LocalDeviceWindow, deviceOrigin, messages)
      deviceMode = 'held'; heldEntered = deferred()
      const count = deviceLoads
      const first = manager.open(), second = manager.open()
      assert.equal(first, second)
      let finished = false
      const both = Promise.all([first, second]).then(() => { finished = true })
      await heldEntered.promise
      assert.equal(finished, false)
      assert.equal(deviceLoads, count + 1)
      deviceMode = 'normal'; respond(heldResponse, 'device'); heldResponse = undefined
      await both
      assert.equal(localWindow().isVisible(), true)
    })
    await check('loadfail-retry', async () => {
      await replaceManager(LocalDeviceWindow, deviceOrigin, messages)
      deviceMode = 'fail'
      await assert.rejects(manager.open(), /local authorization unavailable/)
      assert.equal([...windows].filter(value => !cloudWindows.has(value)).length, 0)
      deviceMode = 'normal'
      await manager.open()
      assert.equal(localWindow().isVisible(), true)
    })
    await check('device-generation-reloads-nonce', async () => {
      const previous = localWindow(), previousId = previous.id
      assert.equal(await previous.webContents.executeJavaScript('syntheticNonce'), 'fixture-generation-1')
      device = { generation: 2 }
      await manager.open()
      assert.equal(previous.isDestroyed(), true)
      const current = localWindow()
      assert.notEqual(current.id, previousId)
      assert.equal(await current.webContents.executeJavaScript('syntheticNonce'), 'fixture-generation-2')
    })
    await check('pending-picker-navigation-no-path', async () => {
      const window = localWindow(), count = pickerOutcomes.length
      const result = await beginPicker(window)
      await window.loadURL(config.platformOrigin + '/login')
      result.resolve({ canceled: false, filePaths: ['/synthetic/late-selection'] })
      await new Promise(resolve => setImmediate(resolve))
      await bounded((async () => { while (pickerOutcomes.length === count) await new Promise(resolve => setImmediate(resolve)) })())
      assert.deepEqual(pickerOutcomes.at(-1), { returnedPath: false, rejected: true })
      chooser = undefined
    })
    await check('pending-picker-close-no-path', async () => {
      await replaceManager(LocalDeviceWindow, deviceOrigin, messages)
      await manager.open()
      const result = await beginPicker(localWindow()), count = pickerOutcomes.length
      const closed = manager.close()
      result.resolve({ canceled: false, filePaths: ['/synthetic/late-selection'] })
      await closed
      assert.equal(pickerOutcomes.length, count + 1)
      assert.deepEqual(pickerOutcomes.at(-1), { returnedPath: false, cancelled: true })
      chooser = undefined
    })
    await check('unavailable-device-does-not-open', async () => {
      device = undefined
      await replaceManager(LocalDeviceWindow, deviceOrigin, messages)
      const count = windows.size
      await rejected(primary.webContents, channels.open)
      assert.equal(windows.size, count)
    })
  } catch (error) {
    failure = { name: active, code: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message.slice(0, 250) : 'fixture_failure' }
  } finally {
    chooser?.result.resolve({ canceled: true, filePaths: [] })
    heldResponse?.destroy()
    await manager?.close()
    if (channels !== undefined) { ipcMain.removeHandler(channels.open); ipcMain.removeHandler(channels.choose) }
    ipcMain.handle = originalHandle
    dialog.showOpenDialog = originalDialog
    for (const browser of sessions) await browser.clearStorageData()
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
  }
  writeSync(1, 'PE_LOCAL_AUTHORIZATION_RESULT ' + JSON.stringify({ complete: failure === undefined,
    electron: process.versions.electron, cases, ...(failure === undefined ? {} : { failure }),
    substitutes: { chooser: 'controlled-dialog-promise', device: 'generation-identity-only', model: false, profile: false },
    cleanup: { windows: windows.size, servers: servers.filter(server => server.listening).length, pickers: activePickers } }) + '\n')
  app.exit(failure === undefined ? 0 : 1)
}
// The default Electron launcher emits ready after this module finishes evaluation.
void run().catch(() => {
  writeSync(1, 'PE_LOCAL_AUTHORIZATION_RESULT ' + JSON.stringify({ complete: false,
    failure: { name: active, code: 'fixture_cleanup_failed' }, cases }) + '\n')
  app.exit(1)
})
