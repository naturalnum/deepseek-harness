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
  const reservation = createServer()
  const port = await listen(reservation)
  await new Promise(resolve => reservation.close(resolve))
  const child = spawn(process.execPath, [trialLb], {
    cwd: root,
    env: { ...process.env, PE_LOAD_BALANCER_PORT: String(port), PE_HOST_PORT: String(first),
      PE_HOST_SECOND_PORT: String(second), PE_READY_FILE: join(temporary, 'ready.json') },
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
