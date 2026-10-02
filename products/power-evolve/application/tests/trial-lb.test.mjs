/** The local multi-host trial must preserve external authority and upgraded streams. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const trialLb = join(root, 'products/power-evolve/scripts/trial-lb.mjs')

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

test('trial load balancer forwards native WebSocket and the public Host', { timeout: 15000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-native-lb-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const seen = []
  const backendSockets = new Set()
  const backends = [0, 1].map(index => {
    const server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ready":true,"service":"host"}')
        return
      }
      seen.push({ index, host: request.headers.host, path: request.url })
      response.end('ok')
    })
    server.on('upgrade', (request, socket) => {
      backendSockets.add(socket)
      socket.on('close', () => backendSockets.delete(socket))
      seen.push({ index, host: request.headers.host, path: request.url })
      const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]))
    })
    t.after(() => new Promise(resolve => {
      for (const socket of backendSockets) socket.destroy()
      server.closeAllConnections()
      server.close(resolve)
    }))
    return server
  })
  const first = await listen(backends[0])
  const second = await listen(backends[1])
  const platformPort = 18900
  const reservation = createServer()
  const port = await listen(reservation)
  await new Promise(resolve => reservation.close(resolve))
  const child = spawn(process.execPath, [trialLb], {
    cwd: root,
    env: { ...process.env, PE_LOAD_BALANCER_PORT: String(port), PE_HOST_PORT: String(first),
      PE_HOST_SECOND_PORT: String(second), PE_MULTI_PLATFORM: '1',
      PE_PLATFORM_LOAD_BALANCER_PORT: String(platformPort), PE_READY_FILE: join(temporary, 'ready.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await once(child, 'exit') }
      finally { clearTimeout(deadline) }
    }
  })
  const origin = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`LB exited: ${output}`)
    try { ready = (await (await fetch(`${origin}/health`)).json()).ready; if (ready) break }
    catch { await delay(30) }
  }
  assert.equal(ready, true, output)
  const response = await fetch(`${origin}/native/api/session/list`, { method: 'POST', body: '{}' })
  assert.equal(response.status, 200)
  assert.equal(seen[0].host, `127.0.0.1:${port}`)
  const platformOrigin = `http://127.0.0.1:${platformPort}`
  const exchange = await fetch(`${origin}/auth/exchange`, {
    method: 'OPTIONS', headers: { origin: platformOrigin },
  })
  assert.equal(exchange.status, 200)
  assert.equal(seen.at(-1).path, '/auth/exchange')
  const unrelated = await fetch(`${origin}/native/api/session/list`, {
    method: 'POST', headers: { origin: platformOrigin }, body: '{}',
  })
  assert.equal(unrelated.status, 403)
  const invalidHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/native/api/session/list`, {
      method: 'POST', headers: { host: 'wrong.example' },
    }, response => { response.resume(); resolve(response.statusCode) })
    request.on('error', reject)
    request.end('{}')
  })
  assert.equal(invalidHost, 403)
  const socket = new WebSocket(`ws://127.0.0.1:${port}/native/api/remote.mux`)
  t.after(() => socket.close())
  const message = await Promise.race([
    new Promise((resolve, reject) => {
      socket.addEventListener('message', event => resolve(event.data), { once: true })
      socket.addEventListener('error', reject, { once: true })
    }),
    delay(3000).then(() => { throw new Error('WebSocket proxy timed out') }),
  ])
  assert.equal(message, 'ok')
  assert.equal(seen.at(-1).host, `127.0.0.1:${port}`)
  assert.equal(seen.at(-1).path, '/native/api/remote.mux')
})

// The backend substitutes only Host admission; the actual CLI and TCP/HTTP Upgrade forwarding run unchanged.
test('trial proxy preserves rejected upgrades and closes its substitute Host connections', { timeout: 15000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-native-lb-rejections-'))
  const backendSockets = new Set(), seen = []
  const backends = [0, 1].map(() => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ready":true,"service":"host"}')
    })
    server.on('upgrade', (request, socket) => {
      backendSockets.add(socket)
      socket.on('close', () => backendSockets.delete(socket))
      socket.on('error', () => socket.destroy())
      socket.on('end', () => socket.end())
      const mode = request.headers['x-trial-test-case']
      seen.push(mode)
      if (mode === 'connection-error') { socket.destroy(); return }
      if (mode === '101') {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: synthetic-accept\r\n\r\n')
        socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]))
        socket.on('data', bytes => socket.write(bytes))
        return
      }
      const status = ['oversized', 'stalled'].includes(mode) ? 503 : Number(mode)
      const body = mode === 'oversized' ? 'x'.repeat(16384) : mode === 'stalled' ? '' : `denied-${status}`
      const reason = { 401: 'Unauthorized', 403: 'Forbidden', 503: 'Service Unavailable' }[status]
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: keep-alive, x-hop-test\r\nX-Hop-Test: remove-me\r\nKeep-Alive: timeout=60\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nWWW-Authenticate: Bearer realm="synthetic"\r\nRetry-After: 2\r\nTransfer-Encoding: chunked\r\n\r\n`)
      if (body) socket.write(`${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`)
      socket.on('data', () => {})
    })
    return server
  })
  let child
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGTERM')
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await closed } finally { clearTimeout(deadline) }
    }
    for (const socket of backendSockets) socket.destroy()
    for (const backend of backends) {
      backend.closeAllConnections()
      await new Promise(resolve => backend.close(resolve))
    }
    await rm(temporary, { recursive: true, force: true })
  })
  const first = await listen(backends[0]), second = await listen(backends[1])
  const reservation = createServer(), port = await listen(reservation)
  await new Promise(resolve => reservation.close(resolve))
  child = spawn(process.execPath, [trialLb], { cwd: root,
    env: { PATH: process.env.PATH, PE_LOAD_BALANCER_PORT: String(port), PE_HOST_PORT: String(first),
      PE_HOST_SECOND_PORT: String(second), PE_READY_FILE: join(temporary, 'ready.json') },
    stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  const origin = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Trial proxy exited: ${output}`)
    try { if ((await (await fetch(origin + '/health')).json()).backends.every(row => row.healthy)) break }
    catch (error) { /* The child has not opened its listener yet. */ }
    await delay(30)
  }
  assert.equal((await (await fetch(origin + '/health')).json()).backends.filter(row => row.healthy).length, 2)
  function attempt(mode) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(origin + '/native/api/remote.mux', { headers: {
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
        'sec-websocket-key': 'c3ludGhldGljLXRlc3Q=', 'x-trial-test-case': mode,
      } })
      request.setTimeout(5000, () => request.destroy(new Error('Upgrade response deadline')))
      request.on('error', reject)
      request.on('upgrade', (response, socket, head) => resolve({ response, socket, head }))
      request.on('response', response => {
        const socket = response.socket, closed = once(socket, 'close')
        void (async () => {
          const chunks = []
          for await (const chunk of response) chunks.push(chunk)
          await closed
          resolve({ response, socket, body: Buffer.concat(chunks) })
        })().catch(reject)
      })
      request.end()
    })
  }
  async function backendClosed() {
    for (let i = 0; i < 50 && backendSockets.size; i++) await delay(10)
    assert.equal(backendSockets.size, 0, 'The proxy must close the backend Upgrade socket')
  }
  for (const status of [401, 403, 503]) await t.test(`wire ${status} retains applicable headers and body`, async () => {
    const value = await attempt(String(status))
    assert.equal(value.response.statusCode, status)
    assert.equal(value.response.headers.connection, 'close')
    assert.equal(value.response.headers['content-type'], 'text/plain')
    assert.equal(value.response.headers['cache-control'], 'no-store')
    assert.equal(value.response.headers['www-authenticate'], 'Bearer realm="synthetic"')
    assert.equal(value.response.headers['retry-after'], '2')
    assert.equal(value.response.headers['keep-alive'], undefined)
    assert.equal(value.response.headers['x-hop-test'], undefined)
    assert.equal(value.response.headers['transfer-encoding'], undefined)
    assert.equal(value.body.toString(), `denied-${status}`)
    assert.equal(Number(value.response.headers['content-length']), value.body.length)
    assert.equal(value.socket.destroyed, true)
    assert.equal(seen.filter(mode => mode === String(status)).length, 1)
    await backendClosed()
  })
  await t.test('wire rejection body and response wait are bounded', async () => {
    const oversized = await attempt('oversized')
    assert.equal(oversized.response.statusCode, 503)
    assert.equal(oversized.body.length, 8192)
    assert.equal(Number(oversized.response.headers['content-length']), 8192)
    await backendClosed()
    const began = Date.now(), stalled = await attempt('stalled')
    assert.equal(stalled.response.statusCode, 503)
    assert.equal(stalled.body.length, 0)
    assert(Date.now() - began < 4500)
    await backendClosed()
  })
  await t.test('wire 101 streams unchanged and either-side disconnect closes its peer', async () => {
    for (const side of ['client', 'backend']) {
      const value = await attempt('101')
      assert.equal(value.response.statusCode, 101)
      assert.equal(value.response.headers.upgrade, 'websocket')
      assert.equal(value.response.headers['sec-websocket-accept'], 'synthetic-accept')
      let bytes = value.head
      while (bytes.length < 4) {
        const [chunk] = await once(value.socket, 'data')
        bytes = Buffer.concat([bytes, chunk])
      }
      assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x81, 0x02, 0x6f, 0x6b]))
      const echoed = once(value.socket, 'data'), outbound = Buffer.from('synthetic-client-bytes')
      value.socket.write(outbound)
      assert.deepEqual((await echoed)[0], outbound)
      const closed = once(value.socket, 'close')
      if (side === 'client') value.socket.destroy()
      else for (const socket of backendSockets) socket.destroy()
      await closed
      await backendClosed()
    }
  })
  await t.test('wire connection failure stays 502 without retry', async () => {
    const value = await attempt('connection-error')
    assert.equal(value.response.statusCode, 502)
    assert.equal(value.socket.destroyed, true)
    assert.equal(seen.filter(mode => mode === 'connection-error').length, 1)
    await backendClosed()
  })
})
