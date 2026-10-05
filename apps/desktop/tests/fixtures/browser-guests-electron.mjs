/** Controlled native guest/storage qualification; no Host application or account backend. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session, webContents } from 'electron'

const root = process.argv[3] === undefined ? mkdtempSync(join(tmpdir(), 'dsh-browser-guests-')) : resolve(process.argv[3])
app.setPath('userData', join(root, 'electron'))
const windows = [], disposers = [], servers = [], sockets = new Set(), events = []
let blockedRequests = 0, blockedSockets = 0
let cleanup
async function closeResources() {
  if (cleanup !== undefined) return cleanup
  cleanup = (async () => {
    for (const window of windows) { if (!window.isDestroyed()) window.destroy() }
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(value => new Promise(resolveClosed => value.close(resolveClosed))))
    if (process.argv[3] === undefined) await rm(root, { recursive: true, force: true })
  })()
  return cleanup
}
const deadline = setTimeout(() => {
  console.error('native guest fixture exceeded its deadline')
  void closeResources().finally(() => { app.exit(1) })
}, 30000)
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return
  events.push({ event: 'created', id: contents.id, url: contents.getURL(), owner: contents.hostWebContents?.id })
  contents.once('destroyed', () => { events.push({ event: 'destroyed', id: contents.id }) })
})
async function server(blocked) {
  const value = createServer((request, response) => {
    if (blocked) blockedRequests++
    if (request.url === '/sw.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' })
      response.end('self.addEventListener("fetch", () => {})')
    } else if (request.url === '/redirect') {
      response.writeHead(302, { location: trustedOrigin + '/redirected' }); response.end()
    } else { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><body>controlled guest fixture</body>') }
  })
  servers.push(value)
  value.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  value.on('upgrade', (request, socket) => {
    if (blocked) blockedSockets++
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  })
  await new Promise((resolveReady, reject) => { value.once('error', reject); value.listen(0, '127.0.0.1', resolveReady) })
  return 'http://127.0.0.1:' + value.address().port
}
let trustedOrigin
app.whenReady().then(async () => {
  const { DesktopBrowserGuests } = await import(pathToFileURL(resolve(process.argv[2])).href)
  const origin = await server(false)
  trustedOrigin = await server(true)
  const additionalOrigin = await server(true)
  const input = []
  const manager = new DesktopBrowserGuests(() => trustedOrigin, {
    rejectsUrl: url => url.port === new URL(additionalOrigin).port && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  })
  async function owner() {
    const window = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true } })
    windows.push(window)
    disposers.push(manager.bind(window, (contents, id) => { input.push(id); return () => { input.splice(input.indexOf(id), 1) } }))
    await window.loadURL(origin + '/owner')
    return window
  }
  async function guest(window, reservation, onAttach) {
    const attached = new Promise(resolveAttached => {
      window.webContents.once('did-attach-webview', (_event, contents) => {
        events.push({ event: 'did-attach', id: contents.id, url: contents.getURL(), owner: contents.hostWebContents?.id })
        assert.equal(contents.session, session.fromPartition(reservation.partition))
        onAttach?.(contents)
        resolveAttached(contents)
      })
    })
    await window.webContents.executeJavaScript(`(() => {
      const v = document.createElement('webview'); v.setAttribute('allowpopups', '');
      v.partition = ${JSON.stringify(reservation.partition)}; v.src = ${JSON.stringify('about:blank#' + reservation.lease)};
      document.body.append(v);
    })()`)
    return attached
  }
  async function ready(window, reservation) {
    let readyDone
    const done = new Promise(resolveReady => { readyDone = resolveReady })
    const contents = await guest(window, reservation, value => { value.once('dom-ready', readyDone) })
    await done
    assert.equal(contents.getURL(), 'about:blank#' + reservation.lease)
    await contents.loadURL(origin + '/page')
    return contents
  }
  const a = await owner(), b = await owner()
  const aLease = manager.acquire(a.webContents, 'normal'), bLease = manager.acquire(b.webContents, 'normal')
  assert.equal(aLease.partition, bLease.partition)
  const aGuest = await ready(a, aLease), bGuest = await ready(b, bLease)
  const oldSession = bGuest.session
  await bGuest.executeJavaScript(`(async () => {
    document.cookie = 'guest=present; SameSite=Lax'; localStorage.setItem('guest', 'present');
    const db = await new Promise((resolveDb, reject) => { const request = indexedDB.open('guest', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('guest');
      request.onsuccess = () => resolveDb(request.result); request.onerror = () => reject(request.error); }); db.close();
    await (await caches.open('guest')).put('/cache-key', new Response('present'));
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  })()`)
  assert.equal((await oldSession.cookies.get({ url: origin })).length, 1)
  const released = manager.release(a.webContents, aLease.lease)
  assert.equal(manager.release(a.webContents, aLease.lease), released)
  await released
  assert(aGuest.isDestroyed())
  assert(!bGuest.isDestroyed())
  assert.equal((await oldSession.cookies.get({ url: origin })).length, 1)
  assert.equal(await bGuest.executeJavaScript('localStorage.getItem("guest")'), 'present')
  const failedFrames = new Set()
  const framesDenied = new Promise(resolveDenied => {
    oldSession.webRequest.onErrorOccurred(details => {
      if ([trustedOrigin + '/frame', additionalOrigin + '/frame'].includes(details.url)) {
        assert.equal(details.resourceType, 'subFrame'); assert.equal(details.error, 'net::ERR_BLOCKED_BY_CLIENT');
        failedFrames.add(details.url); if (failedFrames.size === 2) resolveDenied();
      }
    })
  })
  await bGuest.executeJavaScript(`(async () => {
    const targets = ${JSON.stringify([trustedOrigin, additionalOrigin])};
    await Promise.all(targets.map(async endpoint => {
      await fetch(endpoint + '/resource').catch(() => {});
      await new Promise(resolveSocket => { const socket = new WebSocket(endpoint.replace('http:', 'ws:') + '/ws');
        socket.onopen = () => { socket.close(); resolveSocket(); }; socket.onerror = () => resolveSocket(); });
      const frame = document.createElement('iframe'); frame.src = endpoint + '/frame'; document.body.append(frame);
    }));
    await fetch(${JSON.stringify(origin + '/redirect')}).catch(() => {});
  })()`)
  await framesDenied
  oldSession.webRequest.onErrorOccurred(null)
  assert.equal(blockedRequests, 0)
  assert.equal(blockedSockets, 0)
  const closingB = manager.release(b.webContents, bLease.lease)
  const retired = manager.retireWorkspace('normal')
  assert.throws(() => manager.acquire(a.webContents, 'normal'), /retired/)
  await Promise.all([closingB, retired])
  assert(bGuest.isDestroyed())
  assert.equal((await oldSession.cookies.get({ url: origin })).length, 0)
  assert.equal(Object.keys(oldSession.serviceWorkers.getAllRunning()).length, 0)
  // A privileged inspection window temporarily removes the retired Session request
  // blocker to read the old origin's storage; it never obtains a browser lease.
  oldSession.webRequest.onBeforeRequest(null)
  const inspector = new BrowserWindow({ show: false, webPreferences: { session: oldSession, sandbox: true, contextIsolation: true } })
  windows.push(inspector)
  await inspector.loadURL(origin + '/inspect')
  const storage = await inspector.webContents.executeJavaScript(`(async () => ({
    localStorage: localStorage.length, databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length, workers: (await navigator.serviceWorker.getRegistrations()).length,
  }))()`)
  assert.deepEqual(storage, { localStorage: 0, databases: 0, caches: 0, workers: 0 })
  inspector.destroy()
  const fresh = manager.acquire(a.webContents, 'next-epoch')
  assert.notEqual(fresh.partition, aLease.partition)
  assert.equal((await session.fromPartition(fresh.partition).cookies.get({ url: origin })).length, 0)
  const freshGuest = await ready(a, fresh)
  const freshStorage = await freshGuest.executeJavaScript(`(async () => ({
    localStorage: localStorage.length, databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length, workers: (await navigator.serviceWorker.getRegistrations()).length,
  }))()`)
  assert.deepEqual(freshStorage, storage)

  const preReady = manager.acquire(a.webContents, 'pre-ready')
  let retiring
  const before = input.length
  const preReadyGuest = await guest(a, preReady, () => { retiring = manager.retireWorkspace('pre-ready') })
  await retiring
  assert(preReadyGuest.isDestroyed())
  assert.equal(input.length, before)
  assert(!webContents.getAllWebContents().some(contents => contents.getType() === 'webview' && contents.session === session.fromPartition(preReady.partition)))

  const gap = manager.acquire(a.webContents, 'accepted-gap')
  let gapRetirement
  a.webContents.once('will-attach-webview', () => { gapRetirement = manager.retireWorkspace('accepted-gap') })
  await a.webContents.executeJavaScript(`const gap=document.createElement('webview'); gap.partition=${JSON.stringify(gap.partition)};
    gap.src=${JSON.stringify('about:blank#' + gap.lease)}; document.body.append(gap);`)
  await gapRetirement
  assert.throws(() => manager.acquire(a.webContents, 'accepted-gap'), /retired/)
  assert(!webContents.getAllWebContents().some(contents => contents.getType() === 'webview' && contents.session === session.fromPartition(gap.partition)))
  const createdGap = manager.acquire(a.webContents, 'created-gap')
  let createdRetirement
  app.once('web-contents-created', () => { createdRetirement = manager.retireWorkspace('created-gap') })
  await a.webContents.executeJavaScript(`const createdGap=document.createElement('webview'); createdGap.partition=${JSON.stringify(createdGap.partition)};
    createdGap.src=${JSON.stringify('about:blank#' + createdGap.lease)}; document.body.append(createdGap);`)
  await createdRetirement
  assert(!webContents.getAllWebContents().some(contents => contents.getType() === 'webview' && contents.session === session.fromPartition(createdGap.partition)))
  console.log(JSON.stringify({ electron: process.versions.electron, passed: ['pre-ready retirement', 'accepted attachment gap',
    'shared normal storage', 'release/retire overlap', 'HTTP iframe redirect WS endpoint denial', 'cookie/localStorage/IndexedDB/CacheStorage/service-worker cleanup'],
    blockedRequests, blockedSockets, failedFrames: failedFrames.size, storage, freshStorage, events }))
}).then(async () => {
  for (const dispose of disposers) await dispose()
  await closeResources()
  clearTimeout(deadline)
  app.quit()
}).catch(async error => {
  console.error(error)
  await closeResources()
  clearTimeout(deadline)
  app.exit(1)
})
