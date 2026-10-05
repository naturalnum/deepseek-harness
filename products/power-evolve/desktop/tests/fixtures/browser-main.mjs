/** Real product controller and Chromium guests; only the isolated HTTP membership authority is substituted. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, session } from 'electron'

const root = process.argv.find(value => value.startsWith('--pe-browser-gate-root='))?.slice('--pe-browser-gate-root='.length)
if (root === undefined) throw new Error('Browser fixture requires an owned temporary directory')
app.setPath('userData', join(root, 'user-data'))
app.setName('PowerEvolve Browser Gate')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('use-mock-keychain')

const { bindCloudSidebarBrowser, installCloudBrowserIpc } = await import(pathToFileURL(join(root, 'compiled/browser.js')).href)
const { parseCloudDesktopConfig } = await import(pathToFileURL(join(root, 'compiled/config.js')).href)
const { installCloudNavigation, loadCloudDocument } = await import(pathToFileURL(join(root, 'compiled/window-policy.js')).href)
const preload = fileURLToPath(new URL('./browser-preload.cjs', import.meta.url))
const windows = new Set(), guests = new Set(), inspectors = new Map(), servers = [], cases = [], calls = [], held = []
const identities = { alice: randomUUID(), bob: randomUUID() }
const tokens = { alice: randomBytes(32).toString('base64url'), bob: randomBytes(32).toString('base64url') }
const first = randomUUID(), sibling = randomUUID(), second = randomUUID(), other = randomUUID()
const workspaces = { first: randomUUID(), second: randomUUID(), other: randomUUID() }
const membership = new Map([[first, ['alice', workspaces.first]], [sibling, ['alice', workspaces.first]],
  [second, ['alice', workspaces.second]], [other, ['bob', workspaces.other]]])
const scopePath = '/api/powerEvolve/desktopBrowserScope'
let primary, controller, disposeIpc, browser, foreign, hostOrigin, platformOrigin, deviceOrigin, externalOrigin, config
let activeCase = 'startup', mode = 'normal', protectedRequests = 0, guestReceivedAgent = false, views = 0

async function until(condition, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error('Bounded browser observation timed out')
}

function eventOnce(contents, name) {
  return new Promise((resolve, reject) => {
    const listener = (...args) => { clearTimeout(timer); contents.off(name, listener); resolve(args) }
    const timer = setTimeout(() => { contents.off(name, listener); reject(new Error('Guest event deadline exceeded')) }, 5000)
    contents.on(name, listener)
  })
}

async function check(name, action) {
  activeCase = name
  await action()
  cases.push({ name, passed: true })
}

/** Raw headers stay inside this synthetic server; results retain only credential-free observations. */
async function serve(role) {
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      if (path === '/blocked') protectedRequests++
      if (role === 'external' && (request.headers.cookie ?? '').split(';').some(value => value.trim().startsWith('pe_agent='))) guestReceivedAgent = true
      if (role === 'host' && path === scopePath) {
        let size = 0
        const chunks = []
        for await (const chunk of request) { size += chunk.length; if (size > 1024) throw new Error('Scope request exceeded fixture budget'); chunks.push(chunk) }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const cookie = request.headers.cookie ?? ''
        const owner = ['alice', 'bob'].find(name => cookie.split(';').some(value => value.trim() === `pe_agent=${tokens[name]}`))
        const selected = membership.get(input.request?.sessionId)
        const strict = Object.keys(input).length === 1 && input.request !== null && typeof input.request === 'object'
          && Object.keys(input.request).length === 1 && typeof input.request.sessionId === 'string'
        const origin = request.headers.origin === hostOrigin
        calls.push({ owner: owner ?? 'none', sessionId: input.request?.sessionId, strict, origin,
          json: request.headers['content-type'] === 'application/json', post: request.method === 'POST' })
        const answer = (status, value) => {
          if (response.destroyed) return
          response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(JSON.stringify(value))
        }
        if (!strict || !origin || request.method !== 'POST') { answer(400, { error: 'invalid_request' }); return }
        if (owner === undefined || mode === 'revoked') { answer(401, { error: 'fixture_revoked' }); return }
        if (selected?.[0] !== owner) { answer(404, { error: 'session_not_found' }); return }
        const value = { userId: identities[owner], sessionId: input.request.sessionId, workspaceId: selected[1] }
        if (mode === 'held' || mode === 'timeout') { held.push(() => answer(200, value)); return }
        if (mode === 'extra') { answer(200, { ...value, path: '/workspace' }); return }
        if (mode === 'mismatch') { answer(200, { ...value, sessionId: randomUUID() }); return }
        if (mode === 'oversized') { answer(200, { ...value, padding: 'x'.repeat(4097) }); return }
        if (mode === 'unavailable') { answer(503, { error: 'fixture_unavailable' }); return }
        answer(200, value)
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
      response.end(`<!doctype html><meta charset="utf-8"><title>Browser gate</title><body>${
        role === 'host' && path === '/native/' ? '<iframe name="browser-child" src="/native/frame"></iframe>' : ''}</body>`)
    } catch (_fixtureRequestFailed) {
      if (!response.destroyed) { response.writeHead(400); response.end() }
    }
  })
  server.on('upgrade', (request, socket) => { if (request.url === '/blocked') protectedRequests++; socket.destroy() })
  servers.push(server)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}

function windowFor(selected, testPreload = true) {
  const window = new BrowserWindow({ show: false, webPreferences: { session: selected,
    ...(testPreload ? { preload, nodeIntegrationInSubFrames: true, webviewTag: true } : {}),
    nodeIntegration: false, sandbox: true, contextIsolation: true, webSecurity: true } })
  windows.add(window)
  window.once('closed', () => { windows.delete(window); if (primary === window) primary = undefined })
  return window
}

async function setIdentity(owner, selected = browser) {
  await selected.cookies.set({ url: hostOrigin + scopePath, name: 'pe_agent', value: tokens[owner],
    path: '/api/powerEvolve', httpOnly: true, sameSite: 'strict' })
}

async function acquire(sessionId, workspace = 'cwd:/workspace') {
  return primary.webContents.executeJavaScript(`probe.acquire(${JSON.stringify(workspace)}, ${JSON.stringify(sessionId)})`)
}

async function rejected(frame, args) {
  assert.equal(await frame.executeJavaScript(`probe.invoke('dsh-desktop:browser-acquire', ...${JSON.stringify(args)}).then(() => false, () => true)`), true)
}

/** Create the same inert lease bootstrap used by the native sidebar presentation. */
async function attach(reservation) {
  const id = `gate-view-${++views}`, attached = eventOnce(primary.webContents, 'did-attach-webview')
  await primary.webContents.executeJavaScript(`new Promise(resolve => {
    const view = document.createElement('webview'); view.id = ${JSON.stringify(id)};
    view.setAttribute('partition', ${JSON.stringify(reservation.partition)});
    view.setAttribute('src', ${JSON.stringify('about:blank#' + reservation.lease)});
    view.style.cssText = 'width:160px;height:120px';
    view.addEventListener('dom-ready', () => resolve(true), {once:true}); document.body.append(view);
  })`)
  const [, guest] = await attached
  guests.add(guest)
  guest.once('destroyed', () => guests.delete(guest))
  await guest.loadURL(externalOrigin + '/guest')
  if (!inspectors.has(reservation.partition)) {
    const inspection = windowFor(session.fromPartition(reservation.partition), false)
    await inspection.loadURL(externalOrigin + '/inspect')
    inspectors.set(reservation.partition, inspection)
  }
  return { reservation, guest }
}

async function open(sessionId, workspace) { return attach(await acquire(sessionId, workspace)) }
async function release(value) {
  await primary.webContents.executeJavaScript(`probe.release(${JSON.stringify(value.reservation.lease)})`)
  assert.equal(value.guest.isDestroyed(), true)
}
async function save(guest, value) {
  await guest.executeJavaScript(`localStorage.setItem('gate-state', ${JSON.stringify(value)});
    document.cookie = ${JSON.stringify('gate-cookie=' + value + '; Path=/; SameSite=Strict')}; true`)
}
async function state(guest) {
  return guest.executeJavaScript(`({saved:localStorage.getItem('gate-state'), cookie:document.cookie.includes('gate-cookie='),
    agent:document.cookie.includes('pe_agent=')})`)
}

/** Read preloaded synthetic storage after retirement; retired Sessions correctly reject new navigation. */
async function cleared(partition) {
  const inspection = inspectors.get(partition)
  assert(inspection && !inspection.isDestroyed())
  assert.deepEqual(await state(inspection.webContents), { saved: null, cookie: false, agent: false })
  inspection.destroy()
  inspectors.delete(partition)
}

function flushHeld() { for (const answer of held.splice(0)) answer() }
async function pending() {
  mode = 'held'
  const promise = primary.webContents.executeJavaScript(`probe.acquire('cwd:/workspace', ${JSON.stringify(first)})
    .then(value => { const view = document.createElement('webview'); view.setAttribute('partition',value.partition);
      view.setAttribute('src','about:blank#'+value.lease); document.body.append(view); return true; }, () => false)`)
    .catch(() => false)
  await until(() => held.length > 0)
  return { promise }
}

async function run() {
  let failure
  try {
    await app.whenReady()
    hostOrigin = await serve('host'); platformOrigin = await serve('platform')
    deviceOrigin = await serve('device'); externalOrigin = await serve('external')
    config = parseCloudDesktopConfig({ hostOrigin, platformOrigin,
      sidebarBrowser: { scopeRequestTimeoutMs: 800, scopeRecheckIntervalMs: 1200 } })
    browser = session.fromPartition('pe-browser-gate-owned-' + randomUUID())
    primary = windowFor(browser)
    // Native shortcut input is an explicit no-op substitute; guest ownership and cleanup are real.
    controller = bindCloudSidebarBrowser(primary, browser, config, () => () => {}, deviceOrigin)
    installCloudNavigation(primary, config, true)
    disposeIpc = installCloudBrowserIpc(() => primary === undefined ? undefined : { window: primary, browser: controller }, config)
    await loadCloudDocument(primary, config, hostOrigin + '/native/')
    foreign = windowFor(session.fromPartition('pe-browser-gate-foreign-' + randomUUID()))
    await foreign.loadURL(hostOrigin + '/native/')
    await setIdentity('bob', session.defaultSession)
    await setIdentity('alice')
    let firstGuest, secondGuest

    await check('owned-session-cookie-and-scope', async () => {
      firstGuest = await open(first)
      assert.equal(await primary.webContents.executeJavaScript(`typeof require === 'undefined' && typeof process === 'undefined' && !document.cookie.includes('pe_agent=')`), true)
      assert.equal(calls.at(-1).owner, 'alice')
      assert.equal(calls.at(-1).sessionId, first)
      assert(calls.every(call => call.strict && call.origin && call.json && call.post))
      assert.equal(guestReceivedAgent, false)
      assert.deepEqual(await state(firstGuest.guest), { saved: null, cookie: false, agent: false })
      await save(firstGuest.guest, 'alice-first')
    })

    await check('workspace-storage-and-release', async () => {
      const same = await open(sibling, 'forged-renderer-owner-and-workspace')
      secondGuest = await open(second)
      assert.equal(same.reservation.partition, firstGuest.reservation.partition)
      assert.notEqual(secondGuest.reservation.partition, firstGuest.reservation.partition)
      assert.deepEqual(await state(same.guest), { saved: 'alice-first', cookie: true, agent: false })
      assert.deepEqual(await state(secondGuest.guest), { saved: null, cookie: false, agent: false })
      await save(secondGuest.guest, 'alice-second')
      await release(same); await release(firstGuest)
      const reopened = await open(first)
      assert.equal(reopened.reservation.partition, firstGuest.reservation.partition)
      assert.deepEqual(await state(reopened.guest), { saved: 'alice-first', cookie: true, agent: false })
      await release(reopened)
    })

    await check('frame-and-session-denials', async () => {
      const count = calls.length
      const child = primary.webContents.mainFrame.frames.find(frame => frame.name === 'browser-child')
      assert(child)
      await rejected(child, ['cwd:/workspace', first])
      await rejected(foreign.webContents, ['cwd:/workspace', first])
      for (const args of [['cwd:/workspace'], ['cwd:/workspace', { sessionId: first }], ['cwd:/workspace', first, identities.bob]]) await rejected(primary.webContents, args)
      assert.equal(calls.length, count)
      await rejected(primary.webContents, ['cwd:/workspace', other])
      await until(() => secondGuest.guest.isDestroyed())
      const barrier = await acquire(first)
      await cleared(secondGuest.reservation.partition)
      await primary.webContents.executeJavaScript(`probe.release(${JSON.stringify(barrier.lease)})`)
      await loadCloudDocument(primary, config, platformOrigin + '/login')
      const platformCount = calls.length
      await rejected(primary.webContents, ['cwd:/workspace', first])
      assert.equal(calls.length, platformCount)
      await loadCloudDocument(primary, config, hostOrigin + '/native/')
    })

    await check('product-endpoints-and-aliases-denied', async () => {
      const value = await open(first)
      const urls = [hostOrigin, platformOrigin, deviceOrigin].flatMap(origin =>
        [origin, ...['localhost', '127.0.0.2', '127.1', '0.0.0.0', '[::1]', '[::ffff:127.0.0.1]'].map(alias => {
          const url = new URL(origin); url.hostname = alias; return url.origin
        })].map(origin => origin + '/blocked'))
      for (const url of urls) {
        assert.equal(await value.guest.executeJavaScript(`fetch(${JSON.stringify(url)}).then(() => false, () => true)`), true)
        await assert.rejects(value.guest.loadURL(url))
        await value.guest.loadURL(externalOrigin + '/guest')
      }
      for (const origin of [hostOrigin, deviceOrigin]) {
        const url = origin.replace('http:', 'ws:') + '/blocked'
        assert.equal(await value.guest.executeJavaScript(`new Promise(resolve => { const socket = new WebSocket(${JSON.stringify(url)});
          socket.onopen = () => { socket.close(); resolve(false); }; socket.onerror = () => resolve(true); })`), true)
      }
      assert.equal(protectedRequests, 0)
      await release(value)
    })

    await check('cookie-account-retirement-and-logout', async () => {
      const alice = await open(first); await save(alice.guest, 'alice-before-switch')
      await setIdentity('bob')
      await until(() => alice.guest.isDestroyed())
      const bob = await open(other)
      assert.notEqual(bob.reservation.partition, alice.reservation.partition)
      await cleared(alice.reservation.partition)
      assert.deepEqual(await state(bob.guest), { saved: null, cookie: false, agent: false })
      await save(bob.guest, 'bob-before-logout')
      await browser.cookies.remove(hostOrigin + scopePath, 'pe_agent')
      await until(() => bob.guest.isDestroyed())
      await rejected(primary.webContents, ['cwd:/workspace', other])
      await cleared(bob.reservation.partition)
      await setIdentity('alice')
    })

    await check('late-account-and-navigation-observations', async () => {
      for (const change of ['account', 'navigation']) {
        const value = await open(first); await save(value.guest, 'before-late-' + change)
        const heldRequest = await pending()
        if (change === 'account') { await setIdentity('bob'); await setIdentity('alice') }
        else await loadCloudDocument(primary, config, hostOrigin + '/native/?new-document')
        mode = 'normal'; flushHeld()
        assert.equal(await heldRequest.promise, false)
        await until(() => value.guest.isDestroyed())
        const current = await open(first)
        await cleared(value.reservation.partition)
        assert.notEqual(current.reservation.partition, value.reservation.partition)
        assert.deepEqual(await state(current.guest), { saved: null, cookie: false, agent: false })
        await release(current)
      }
      await loadCloudDocument(primary, config, hostOrigin + '/native/')
    })

    await check('strict-bounded-scope-and-deadline', async () => {
      const value = await open(first); await save(value.guest, 'before-invalid-response')
      for (const next of ['extra', 'mismatch', 'oversized', 'unavailable', 'timeout']) {
        mode = next
        const start = Date.now()
        await rejected(primary.webContents, ['cwd:/workspace', first])
        if (next === 'timeout') assert(Date.now() - start < 3000)
        mode = 'normal'; flushHeld()
      }
      await until(() => value.guest.isDestroyed())
      const current = await open(first)
      await cleared(value.reservation.partition)
      await release(current)
    })

    await check('same-cookie-service-revocation', async () => {
      const value = await open(first); await save(value.guest, 'before-service-revoke')
      const count = calls.length
      mode = 'revoked'
      await until(() => value.guest.isDestroyed(), 5000)
      assert(calls.length > count)
      assert.equal(calls.at(-1).owner, 'alice')
      await rejected(primary.webContents, ['cwd:/workspace', first])
      mode = 'normal'
      const current = await open(first)
      await cleared(value.reservation.partition)
      assert.deepEqual(await state(current.guest), { saved: null, cookie: false, agent: false })
      await release(current)
    })

    await check('window-close-retirement', async () => {
      const value = await open(first); await save(value.guest, 'before-window-close')
      primary.destroy()
      await controller.dispose()
      assert.equal(value.guest.isDestroyed(), true)
      await cleared(value.reservation.partition)
      assert.equal(protectedRequests, 0)
      assert.equal(guestReceivedAgent, false)
    })
  } catch (error) {
    failure = { name: activeCase, code: error instanceof Error ? error.name : 'unknown' }
  } finally {
    mode = 'normal'; flushHeld()
    disposeIpc?.()
    await controller?.dispose()
    for (const guest of guests) if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false })
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
    for (const selected of [browser, session.defaultSession]) if (selected !== undefined) await selected.clearStorageData()
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
  writeSync(1, 'PE_BROWSER_ELECTRON_RESULT ' + JSON.stringify({ complete: failure === undefined, electron: process.versions.electron,
    cases, ...(failure === undefined ? {} : { failure }), cleanup: { windows: windows.size, guests: guests.size,
      servers: servers.filter(server => server.listening).length } }) + '\n')
  app.exit(failure === undefined ? 0 : 1)
}

// Electron's launcher finishes module evaluation before emitting ready.
void run().catch(() => {
  writeSync(1, 'PE_BROWSER_ELECTRON_RESULT ' + JSON.stringify({ complete: false, cases,
    failure: { name: activeCase, code: 'fixture_cleanup_failed' } }) + '\n')
  app.exit(1)
})
