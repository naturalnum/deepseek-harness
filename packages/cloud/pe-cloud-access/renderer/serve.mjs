// Run under a dedicated user with no IP network access. The only application connection is a Unix socket to Access.
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const origin = 'https://application-preview.invalid'
const viewport = { width: 960, height: 640 }
const timeout = 8_000
const maxFrameBytes = 4 * 1024 * 1024
// The wire allows one 1 MiB response body plus bounded headers and JSON escapes.
const maxResourceMessageBytes = 9 * 1024 * 1024

async function* messages(socket) {
  let pending = Buffer.alloc(0)
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    pending = Buffer.concat([pending, chunk])
    let end
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > maxResourceMessageBytes) throw new Error('Oversize renderer message.')
      const value = JSON.parse(pending.subarray(0, end).toString('utf8'))
      pending = pending.subarray(end + 1)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid renderer message.')
      yield value
    }
    if (pending.length > maxResourceMessageBytes) throw new Error('Oversize renderer message.')
  }
}

function send(socket, message) {
  return new Promise((resolve, reject) => {
    socket.write(JSON.stringify(message) + '\n', error => { if (error) reject(error); else resolve() })
  })
}

async function renderView(socket, input, chromium, executablePath, ticket, confirmRetired) {
  let browser, turn, page, browserClose
  let attemptedLaunch = false
  let closeRequested = false
  const closeBrowser = async () => {
    if (browser) await (browserClose ??= browser.close())
  }
  // A disconnected Access process cannot leave a Chromium process behind.
  socket.once('close', () => { void closeBrowser().catch(() => { console.error('Private preview browser close unconfirmed.') }) })
  try {
    await send(socket, { kind: 'opened', ticket })
    while (true) {
      const { value: action, done } = await input.next()
      if (done || action.kind === 'close') break
      if (action.kind !== 'frame' && action.kind !== 'click') throw new Error('Invalid renderer action.')
      if (!page) {
        if (action.kind !== 'frame') throw new Error('Private preview requires an initial frame.')
        attemptedLaunch = true
        browser = await chromium.launch({ executablePath, chromiumSandbox: true, headless: true, timeout,
          args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
          env: Object.fromEntries(['HOME', 'PATH', 'LANG', 'TMPDIR', 'XDG_RUNTIME_DIR'].filter(name => process.env[name])
            .map(name => [name, process.env[name]])),
        })
        if (socket.destroyed) return
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block' })
        await context.routeWebSocket('**/*', async (ws) => { await ws.close() })
        await context.route('**/*', async (route) => {
          const active = turn
          const request = route.request(), url = new URL(request.url())
          if (!active || active.left === 0 || url.origin !== origin || request.method() !== 'GET'
            || url.username || url.password || url.hash) {
            await route.abort().catch(() => {})
            return
          }
          active.left--
          const work = active.tail.then(async () => {
            // Each socket's single in-flight relay response belongs to its own original Access view.
            if (closeRequested) return route.abort()
            await send(socket, { kind: 'read', path: url.pathname + url.search })
            const reply = await input.next()
            if (reply.done || reply.value.kind === 'close') {
              closeRequested = true
              return route.abort()
            }
            const { kind, status, headers, body } = reply.value
            if (kind !== 'resource' || !Number.isInteger(status) || typeof body !== 'string') throw new Error('Invalid relay reply.')
            await route.fulfill({ status, headers, body: Buffer.from(body, 'base64') })
          })
          active.tail = work.catch(() => { closeRequested = true; socket.destroy() })
          await active.tail
        })
        page = await context.newPage()
        context.on('page', (other) => { void other.close().catch(() => {}) })
      }
      const active = { left: 128, tail: Promise.resolve() }
      turn = active
      let frame
      try {
        if (page.url() === 'about:blank') await page.goto(origin + '/', { waitUntil: 'load', timeout })
        if (action.kind === 'click') {
          if (!Number.isInteger(action.x) || action.x < 0 || action.x >= viewport.width
            || !Number.isInteger(action.y) || action.y < 0 || action.y >= viewport.height) throw new Error('Invalid renderer click.')
          await page.mouse.click(action.x, action.y)
        }
        frame = await page.screenshot({ type: 'png', timeout })
      } catch (error) {
        if (!closeRequested) throw error
      } finally {
        turn = undefined
        await active.tail
      }
      if (closeRequested) break
      if (frame.length > maxFrameBytes) throw new Error('Oversize renderer frame.')
      await send(socket, { kind: 'frame', png: frame.toString('base64') })
    }
  } catch (error) {
    if (!socket.destroyed) await send(socket, { kind: 'failed' })
    throw error
  } finally {
    await closeBrowser()
    if (attemptedLaunch && browser === undefined) throw new Error('Private preview launch cleanup is unconfirmed.')
    await confirmRetired()
  }
}

function isTicketMessage(message, kind) {
  return message !== undefined && message.kind === kind && Object.keys(message).length === 2
    && typeof message.ticket === 'string' && /^[a-f0-9]{64}$/.test(message.ticket)
}

function isPrivateDirectory(stat) {
  return stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0
}

async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() }
  finally { await directory.close() }
}

async function publishGeneration(path, generation) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!isPrivateDirectory(await lstat(path))) throw new Error('Private renderer requires owner-only generation storage.')
  const marker = join(path, generation)
  const temporary = join(path, `${generation}.${randomBytes(16).toString('hex')}.tmp`)
  const record = await open(temporary, 'wx+', 0o600)
  try {
    const expected = Buffer.from(generation + '\n')
    await record.writeFile(expected)
    await record.sync()
    const actual = Buffer.alloc(expected.length)
    const { bytesRead } = await record.read(actual, 0, actual.length, 0)
    if (bytesRead !== expected.length || !actual.equals(expected) || (await record.stat()).size !== expected.length) {
      throw new Error('Private renderer generation record is incomplete.')
    }
    await link(temporary, marker)
  } finally {
    try { await record.close() }
    finally { await unlink(temporary) }
  }
  await syncDirectory(path)
  await syncDirectory(dirname(path))
  return marker
}

/** Start an operator-owned renderer on a protected local Unix path. Access authenticates and selects every service read. */
export async function serveIpApplicationPreview(socketPath, chromium, executablePath, generation = randomBytes(32).toString('hex')) {
  if (!/^[a-f0-9]{64}$/.test(generation)) throw new Error('Invalid private renderer generation.')
  const directory = await lstat(dirname(socketPath))
  if (!directory.isDirectory() || (directory.mode & 0o022) !== 0) throw new Error('Private renderer requires a protected socket directory.')
  const receipts = socketPath + '.retired'
  await mkdir(receipts, { recursive: true, mode: 0o700 })
  const storage = await lstat(receipts)
  if (!isPrivateDirectory(storage)) throw new Error('Private renderer requires owner-only retirement storage.')
  const retained = new Set((await readdir(receipts)).filter(name => name !== '.generation').map(name => {
    if (!/^[a-f0-9]{64}\.(pending|closed)$/.test(name)) throw new Error('Invalid private retirement record.')
    return name.slice(0, 64)
  }))
  const file = (ticket, state) => join(receipts, ticket + '.' + state)
  const active = new Map()
  const retiring = new Map()
  const failedOpens = new Map()
  const generationMarker = await publishGeneration(join(receipts, '.generation'), generation)
  const markerIdentity = await lstat(generationMarker)
  const sameStorage = async () => {
    const current = await lstat(receipts)
    if (!isPrivateDirectory(current) || current.dev !== storage.dev || current.ino !== storage.ino) return false
    const marker = await lstat(generationMarker)
    return marker.isFile() && marker.uid === storage.uid && (marker.mode & 0o077) === 0
      && marker.dev === markerIdentity.dev && marker.ino === markerIdentity.ino
  }
  const clearMissingFailedOpen = async ticket => {
    const attempt = failedOpens.get(ticket)
    if (attempt === undefined) return false
    try {
      if (!(await sameStorage())) return false
      for (const state of ['pending', 'closed']) {
        try { await lstat(file(ticket, state)); return false }
        catch (error) { if (error.code !== 'ENOENT') return false }
      }
      if (!(await sameStorage()) || failedOpens.get(ticket) !== attempt) return false
    } catch (_unknownStorage) { return false }
    failedOpens.delete(ticket)
    retained.delete(ticket)
    return true
  }
  const forget = async (socket, ticket) => {
    try {
      await retiring.get(ticket)
      if (failedOpens.has(ticket)) {
        if (!(await clearMissingFailedOpen(ticket))) throw new Error('Private preview durable open is unconfirmed.')
      } else if (retained.has(ticket)) {
        // Only a closed record may be removed. A pending record can still own Chromium.
        await unlink(file(ticket, 'closed'))
        retained.delete(ticket)
      }
      await send(socket, { kind: 'forgotten', ticket })
    } catch (_unconfirmed) {
      if (!socket.destroyed) await send(socket, { kind: 'unconfirmed', ticket })
    }
  }
  const confirm = async (input, socket, ticket) => {
    await send(socket, { kind: 'closed', ticket })
    const { value } = await input.next()
    if (!isTicketMessage(value, 'forget') || value.ticket !== ticket) return
    await forget(socket, ticket)
  }
  const manage = async socket => {
    const input = messages(socket)
    try {
      const { value } = await input.next()
      if (isTicketMessage(value, 'forget')) {
        await forget(socket, value.ticket)
        return
      }
      if (isTicketMessage(value, 'recover')) {
        const { ticket } = value
        try {
          await retiring.get(ticket)
          const receipt = await lstat(file(ticket, 'closed'))
          if (!receipt.isFile() || receipt.uid !== process.getuid()) throw new Error('Invalid private close receipt.')
        } catch (_unconfirmed) {
          if (!socket.destroyed) await send(socket, { kind: 'unconfirmed', ticket })
          return
        }
        await confirm(input, socket, ticket)
        return
      }
      if (!isTicketMessage(value, 'register') || retained.size >= 32 || retained.has(value.ticket)) return
      const { ticket } = value
      retained.add(ticket)
      const terminal = Promise.withResolvers()
      retiring.set(ticket, terminal.promise)
      void terminal.promise.catch((_unconfirmed) => { /* The original pending record keeps the reservation. */ })
      let needsReceipt = false
      try {
        // A client which never saw registered cannot request a durable open on this channel.
        await send(socket, { kind: 'registered', ticket })
        const { value: request } = await input.next()
        if (!isTicketMessage(request, 'open') || request.ticket !== ticket) return
        needsReceipt = true
        try {
          if (!(await sameStorage())) throw new Error('Private renderer receipt storage changed.')
          // A ticket becomes visible only as a complete, no-overwrite link to the durable generation record.
          await link(generationMarker, file(ticket, 'pending'))
          await syncDirectory(receipts)
          if (!(await sameStorage())) throw new Error('Private renderer receipt storage changed.')
        }
        catch (error) {
          // No browser operation can have run before the durable open completes.
          failedOpens.set(ticket, terminal)
          if (await clearMissingFailedOpen(ticket)) needsReceipt = false
          throw error
        }
        await renderView(socket, input, chromium, executablePath, ticket, async () => {
          await rename(file(ticket, 'pending'), file(ticket, 'closed'))
          terminal.resolve()
        })
      } catch (error) {
        if (needsReceipt) terminal.reject(error)
        throw error
      } finally {
        if (!needsReceipt) { retained.delete(ticket); terminal.resolve() }
        retiring.delete(ticket)
      }
      if (!socket.destroyed) await confirm(input, socket, ticket)
    } finally {
      socket.destroy()
      await input.return()
    }
  }
  const server = createServer(socket => {
    socket.on('error', () => {})
    if (active.size >= 64) { socket.destroy(); return }
    const task = manage(socket).catch(() => {
      console.error('Private preview renderer channel failed.')
    }).finally(() => { active.delete(socket) })
    active.set(socket, task)
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
    await chmod(socketPath, 0o660)
  }
  catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await unlink(generationMarker)
    throw error
  }
  return async () => {
    const closing = new Promise(resolve => server.close(resolve))
    const pending = [...retiring.values()]
    for (const socket of active.keys()) socket.destroy()
    await Promise.all([closing, ...active.values()])
    const results = await Promise.allSettled(pending)
    await Promise.all([...failedOpens.keys()].map(clearMissingFailedOpen))
    if (results.some(result => result.status === 'rejected') || failedOpens.size !== 0
      || (await readdir(receipts)).some(name => name.endsWith('.pending'))) {
      throw new Error('Private preview worker retirement is unconfirmed.')
    }
    await unlink(generationMarker)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [socketPath, playwrightEntry, executablePath] = process.argv.slice(2)
  if (!socketPath || !playwrightEntry || !isAbsolute(socketPath) || !isAbsolute(playwrightEntry)
    || (executablePath && !isAbsolute(executablePath))) throw new Error('Use absolute socket, Playwright module and optional Chromium paths.')
  process.umask(0o077)
  const { chromium } = await import(pathToFileURL(playwrightEntry))
  const stop = await serveIpApplicationPreview(socketPath, chromium, executablePath, process.env.PE_IP_PREVIEW_WORKER_GENERATION)
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    void stop().catch(() => { process.exitCode = 1 })
  })
}
