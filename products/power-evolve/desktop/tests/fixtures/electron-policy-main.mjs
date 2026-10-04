/** Real Electron gate for the Cloud carrier's IPC ownership and navigation, using isolated local documents. */
import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron'
import { DESKTOP_IPC, installDesktopShortcuts } from '@deepseek-ai/dsh-desktop/assembly'
import { allowsCloudHost, parseCloudDesktopConfig } from '../../lib/types/config.js'
import { cloudDesktopPartition } from '../../lib/types/partition.js'
import { installCloudPreferences } from '../../lib/types/preferences.js'
import { assertCloudSender, installCloudNavigation, loadCloudDocument } from '../../lib/types/window-policy.js'

const root = process.argv.find(value => value.startsWith('--pe-policy-root='))?.slice('--pe-policy-root='.length)
if (root === undefined) throw new Error('Policy fixture requires its parent-owned temporary directory')
app.setPath('userData', join(root, 'user-data'))
app.setName('PowerEvolve Policy Gate')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('use-mock-keychain')
console.log('PE_ELECTRON_POLICY_PROGRESS startup')

const barrier = 'pe-policy:barrier'
const deferred = 'pe-policy:deferred'
const windows = new Set()
const servers = []
const cases = []
let activeCase = 'startup'
let primary
let disposePreferences
let shortcuts
let browser
let extraBrowser
let locale = 'en'
const localeChanges = []
let deferredEntered
let deferredRelease
let deferredChecked
let foreignRequests = 0
const preload = fileURLToPath(new URL('./electron-policy-preload.cjs', import.meta.url))

/** Await one real Electron event with a bounded timeout and listener cleanup. */
function eventOnce(contents, eventName, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { contents.off(eventName, listener); reject(new Error(`Timed out: ${eventName}`)) }, 5000)
    const listener = (...args) => {
      if (!predicate(...args)) return
      clearTimeout(timer)
      contents.off(eventName, listener)
      resolve(args)
    }
    contents.on(eventName, listener)
  })
}

/** Run a public behavior assertion and emit only its fixed test name. */
async function check(name, action) {
  activeCase = name
  console.log(`PE_ELECTRON_POLICY_PROGRESS ${name}`)
  await action()
  cases.push({ name, passed: true })
}

/** Serve only synthetic test HTML; no application configuration or credentials are read. */
async function serve(role) {
  const server = createServer((request, response) => {
    if (role === 'foreign') foreignRequests++
    if (role === 'host' && request.url === '/native/redirect') {
      response.writeHead(302, { location: `${foreignOrigin}/landing` })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`<!doctype html><meta charset="utf-8"><title>Policy ${role}</title><h1>${role}</h1>${
      role === 'host' && request.url === '/native/' ? '<iframe name="policy-child" src="/native/frame"></iframe>' : ''}`)
  })
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

/** Test-only subframe preload enables hostile calls without enabling renderer Node or guest capabilities. */
function windowFor(browserSession) {
  const window = new BrowserWindow({ show: false, webPreferences: {
    session: browserSession, preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInSubFrames: true, webSecurity: true, webviewTag: false,
  } })
  windows.add(window)
  window.once('closed', () => { windows.delete(window); if (primary === window) primary = undefined })
  return window
}

/** Make a real renderer invoke and assert that the main handler refused it. */
async function rejected(frame, channel, args = []) {
  assert.equal(await frame.executeJavaScript(`probe.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})
    .then(() => false, () => true)`), true)
}

/** Sends are ordered before the following invoke on the same renderer IPC connection. */
async function sendPreferences(frame, nextLocale, nextTheme) {
  await frame.executeJavaScript(`(async () => {
    probe.send(${JSON.stringify(DESKTOP_IPC.localeChanged)}, ${JSON.stringify(nextLocale)});
    probe.send(${JSON.stringify(DESKTOP_IPC.nativeThemeSet)}, ${JSON.stringify(nextTheme)});
    await probe.invoke(${JSON.stringify(barrier)});
  })()`)
}

/** Find the real child WebFrameMain after both its document and test preload have loaded. */
async function childFrame(window) {
  const frame = window.webContents.mainFrame.frames.find(value => value.name === 'policy-child')
  assert(frame, 'Same-origin child frame must exist')
  assert.equal(await frame.executeJavaScript('typeof probe.invoke'), 'function')
  return frame
}

let foreignOrigin
let config
let foreign
async function run() {
  let failure
  try {
    await app.whenReady()
    console.log('PE_ELECTRON_POLICY_PROGRESS ready')
    const hostOrigin = await serve('host')
    const platformOrigin = await serve('platform')
    foreignOrigin = await serve('foreign')
    config = parseCloudDesktopConfig({ hostOrigin, platformOrigin })
    browser = session.fromPartition(cloudDesktopPartition(config))
    primary = windowFor(browser)
    foreign = windowFor(browser)
    installCloudNavigation(primary, config)
    ipcMain.handle(barrier, () => null)
    disposePreferences = installCloudPreferences(() => primary, config, () => ['en-US'], next => {
      locale = next
      localeChanges.push(next)
    })
    shortcuts = installDesktopShortcuts(() => primary, root,
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
      () => {}, () => ({ revision: 0, blocked: false }), value => allowsCloudHost(config, value))
    shortcuts.attach(primary)
    const home = `${hostOrigin}/native/`
    console.log('PE_ELECTRON_POLICY_PROGRESS loading')
    await loadCloudDocument(primary, config, home)
    await foreign.loadURL(home)

    await check('owned-host-ipc', async () => {
      assert.equal(await primary.webContents.executeJavaScript('typeof require'), 'undefined')
      assert.equal(await primary.webContents.executeJavaScript('typeof process'), 'undefined')
      assert.deepEqual(await primary.webContents.executeJavaScript(`probe.invoke(${JSON.stringify(DESKTOP_IPC.localeBootstrap)})`),
        { preference: null, languages: ['en-US'] })
      const snapshot = await primary.webContents.executeJavaScript(`probe.invoke(${JSON.stringify(DESKTOP_IPC.shortcutsGet)}, [])`)
      assert.equal(snapshot.status, 'ready')
      const saved = await primary.webContents.executeJavaScript(`probe.invoke(${JSON.stringify(DESKTOP_IPC.shortcutsEdit)},
        { type: 'reset-all' }, ${JSON.stringify(snapshot.revision)})`)
      assert.equal(saved.status, 'saved')
      await primary.webContents.executeJavaScript(`probe.invoke(${JSON.stringify(DESKTOP_IPC.shortcutsRecording)}, false)`)
      await sendPreferences(primary.webContents, 'zh-CN', 'dark')
      assert.equal(locale, 'zh-CN')
      assert.equal(nativeTheme.themeSource, 'dark')
    })

    await check('invalid-preferences', async () => {
      await sendPreferences(primary.webContents, 'unsupported', 'unsupported')
      assert.equal(locale, 'zh-CN')
      assert.deepEqual(localeChanges, ['zh-CN'])
      assert.equal(nativeTheme.themeSource, 'dark')
    })

    async function deniedFrame(frame) {
      await rejected(frame, DESKTOP_IPC.localeBootstrap)
      await rejected(frame, DESKTOP_IPC.shortcutsGet, [[]])
      await rejected(frame, DESKTOP_IPC.shortcutsEdit, [{ type: 'reset-all' }, 'policy-stale-revision'])
      await rejected(frame, DESKTOP_IPC.shortcutsRecording, [true])
      await rejected(frame, DESKTOP_IPC.shortcutsCloseWindow, ['policy-stale-revision'])
      await sendPreferences(frame, 'en', 'light')
      assert.equal(locale, 'zh-CN')
      assert.equal(nativeTheme.themeSource, 'dark')
    }
    await check('same-origin-iframe-denied', async () => { await deniedFrame(await childFrame(primary)) })
    await check('foreign-window-denied', async () => { await deniedFrame(foreign.webContents) })
    await check('platform-denied', async () => {
      await loadCloudDocument(primary, config, `${platformOrigin}/login`)
      await deniedFrame(primary.webContents)
    })

    await check('stale-frame-denied', async () => {
      await loadCloudDocument(primary, config, home)
      const entered = new Promise(resolve => { deferredEntered = resolve })
      const release = new Promise(resolve => { deferredRelease = resolve })
      const checked = new Promise(resolve => { deferredChecked = resolve })
      ipcMain.handle(deferred, async event => {
        // Preserve Electron's actual sender event; the production guard runs after its frame navigates away.
        deferredEntered()
        await release
        try {
          assertCloudSender(primary, config, event)
          deferredChecked(false)
          return true
        } catch (error) {
          deferredChecked(true)
          throw error
        }
      })
      await primary.webContents.executeJavaScript(`void probe.invoke(${JSON.stringify(deferred)}).catch(_retiredFrame => { /* The original renderer is intentionally retired. */ }); true`)
      await entered
      await loadCloudDocument(primary, config, `${platformOrigin}/account`)
      deferredRelease()
      assert.equal(await checked, true)
      ipcMain.removeHandler(deferred)
      await loadCloudDocument(primary, config, home)
    })

    await check('foreign-navigation-denied', async () => {
      const navigation = eventOnce(primary.webContents, 'will-frame-navigate', event => event.isMainFrame)
      await primary.webContents.executeJavaScript(`location.assign(${JSON.stringify(`${foreignOrigin}/landing`)}); true`)
      const [event] = await navigation
      assert.equal(event.defaultPrevented, true)
      assert.equal(primary.webContents.getURL(), home)
      assert.equal(foreignRequests, 0)
    })

    await check('foreign-redirect-denied', async () => {
      const redirect = eventOnce(primary.webContents, 'will-redirect', event => event.isMainFrame)
      await assert.rejects(loadCloudDocument(primary, config, `${hostOrigin}/native/redirect`))
      const [event] = await redirect
      assert.equal(event.defaultPrevented, true)
      assert.equal(foreignRequests, 0)
      await loadCloudDocument(primary, config, home)
    })

    await check('foreign-popup-denied', async () => {
      const count = BrowserWindow.getAllWindows().length
      assert.equal(await primary.webContents.executeJavaScript(`window.open(${JSON.stringify(`${foreignOrigin}/landing`)}, '_blank') === null`), true)
      assert.equal(BrowserWindow.getAllWindows().length, count)
      assert.equal(primary.webContents.getURL(), home)
      assert.equal(foreignRequests, 0)
    })

    await check('trusted-approval-main-navigation', async () => {
      const count = BrowserWindow.getAllWindows().length
      const destination = `${platformOrigin}/approval#execution=policy-synthetic`
      const loaded = eventOnce(primary.webContents, 'did-finish-load', () => primary.webContents.getURL() === destination)
      assert.equal(await primary.webContents.executeJavaScript(`window.open(${JSON.stringify(destination)}, '_blank') === null`), true)
      await loaded
      assert.equal(BrowserWindow.getAllWindows().length, count)
      await deniedFrame(primary.webContents)
    })

    await check('explicit-load-denied', async () => {
      const current = primary.webContents.getURL()
      for (const value of ['file:///policy-nonexistent', 'data:text/html,policy', 'javascript:alert(1)',
        `${foreignOrigin}/landing`, `${platformOrigin}/identity/login`]) {
        await assert.rejects(loadCloudDocument(primary, config, value), /rejected navigation/)
        assert.equal(primary.webContents.getURL(), current)
      }
    })

    await check('reopened-window-ownership', async () => {
      primary.destroy()
      assert.equal(primary, undefined)
      primary = windowFor(browser)
      installCloudNavigation(primary, config)
      shortcuts.attach(primary)
      await loadCloudDocument(primary, config, home)
      assert.deepEqual(await primary.webContents.executeJavaScript(`probe.invoke(${JSON.stringify(DESKTOP_IPC.localeBootstrap)})`),
        { preference: null, languages: ['en-US'] })
      await deniedFrame(foreign.webContents)
    })

    await check('deployment-session-isolation', async () => {
      const changed = parseCloudDesktopConfig({ hostOrigin, platformOrigin: foreignOrigin })
      extraBrowser = session.fromPartition(cloudDesktopPartition(changed))
      assert.notEqual(extraBrowser, browser)
      assert.equal(session.fromPartition(cloudDesktopPartition(config)), browser)
      await browser.cookies.set({ url: `${hostOrigin}/native/api`, name: 'pe-policy-synthetic', value: 'fixture-only',
        path: '/native/api', httpOnly: true, sameSite: 'strict' })
      assert.equal((await browser.cookies.get({ url: `${platformOrigin}/native/api`, name: 'pe-policy-synthetic' })).length, 1)
      assert.equal((await extraBrowser.cookies.get({ url: `${hostOrigin}/native/api`, name: 'pe-policy-synthetic' })).length, 0)
    })
  } catch (error) {
    failure = { name: activeCase, code: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message.slice(0, 300) : 'Unknown fixture failure' }
  } finally {
    if (deferredRelease !== undefined) deferredRelease()
    ipcMain.removeHandler(deferred)
    ipcMain.removeHandler(barrier)
    disposePreferences?.()
    shortcuts?.dispose()
    for (const current of [browser, extraBrowser]) if (current !== undefined) await current.clearStorageData()
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise(resolve => { server.close(resolve) })
    }
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
  }
  writeSync(1, `PE_ELECTRON_POLICY_RESULT ${JSON.stringify({ complete: failure === undefined, electron: process.versions.electron,
    cases, ...(failure === undefined ? {} : { failure }), cleanup: { windows: windows.size, servers: servers.filter(server => server.listening).length } })}\n`)
  app.exit(failure === undefined ? 0 : 1)
}
// Electron's default launcher must finish evaluating this module before it emits ready.
void run().catch(error => {
  console.log(`PE_ELECTRON_POLICY_RESULT ${JSON.stringify({ complete: false, cases,
    failure: { name: activeCase, code: error instanceof Error ? error.name : 'unknown', message: 'Fixture cleanup failed' } })}`)
  app.exit(1)
})
