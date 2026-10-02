/** Loopback trial proxy: round-robin healthy hosts without replaying a POST. */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { writeFile } from 'node:fs/promises'

const port = Number(process.env.PE_LOAD_BALANCER_PORT ?? 18898)
const backends = [process.env.PE_HOST_PORT ?? '18880', process.env.PE_HOST_SECOND_PORT ?? '18897']
  .map(value => ({ origin: `http://127.0.0.1:${value}`, healthy: false, served: 0 }))
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !process.env.PE_READY_FILE) {
  throw new Error('Invalid trial load balancer configuration')
}
const instanceId = randomUUID()
let cursor = 0
const upgraded = new Set()
const publicHost = `127.0.0.1:${port}`
const platformPort = process.env.PE_MULTI_PLATFORM === '1'
  ? process.env.PE_PLATFORM_LOAD_BALANCER_PORT ?? '18900'
  : process.env.PE_PLATFORM_PORT ?? '18881'
const platformOrigin = `http://127.0.0.1:${platformPort}`
function choose() {
  const choices = backends.filter(backend => backend.healthy)
  return choices.length ? choices[cursor++ % choices.length] : undefined
}
function authorityValid(request) {
  return request.headers.host === publicHost
    && (request.headers.origin === undefined || request.headers.origin === `http://${publicHost}`
      || (request.url === '/auth/exchange' && request.headers.origin === platformOrigin))
}
async function probe() {
  await Promise.all(backends.map(async backend => {
    try {
      const response = await fetch(`${backend.origin}/health`, { signal: AbortSignal.timeout(1000) })
      const value = await response.json()
      backend.healthy = response.ok && value.ready === true && value.service === 'host'
    } catch (_unavailable) { backend.healthy = false }
  }))
}
await probe()
const timer = setInterval(() => void probe(), 500)
const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ ready: backends.some(backend => backend.healthy), service: 'load-balancer',
      instanceId, backends: backends.map(({ origin, healthy, served }) => ({ origin, healthy, served })) }))
    return
  }
  if (!authorityValid(request)) {
    response.writeHead(403, { 'cache-control': 'no-store' })
    response.end('forbidden')
    return
  }
  const selected = choose()
  if (!selected) {
    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end('{"error":"hosts_unavailable"}')
    return
  }
  selected.served++
  const headers = { ...request.headers, host: publicHost,
    'x-forwarded-host': publicHost, 'x-forwarded-proto': 'http' }
  for (const key of ['connection', 'proxy-connection', 'keep-alive', 'upgrade', 'te', 'trailer']) delete headers[key]
  const upstream = http.request(new URL(request.url ?? '/', selected.origin), {
    method: request.method, headers, agent: false,
  }, result => {
    response.writeHead(result.statusCode ?? 502, result.headers)
    result.pipe(response)
    response.on('close', () => { if (!response.writableEnded) result.destroy() })
  })
  request.on('aborted', () => upstream.destroy())
  upstream.on('error', () => {
    if (response.headersSent) response.destroy()
    else {
      response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end('{"error":"host_unavailable"}')
    }
  })
  request.pipe(upstream)
})
server.on('upgrade', (request, socket, head) => {
  let target
  try { target = new URL(request.url ?? '/', `http://${publicHost}`) }
  catch { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return }
  if (!authorityValid(request) || target.pathname !== '/native/api/remote.mux' || target.search) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  const selected = choose()
  if (!selected) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    return
  }
  selected.served++
  const headers = { ...request.headers, host: publicHost,
    'x-forwarded-host': publicHost, 'x-forwarded-proto': 'http' }
  delete headers['proxy-connection']
  const upstream = http.request(new URL(request.url, selected.origin), {
    method: 'GET', headers, agent: false,
  })
  let connected = false, answered = false, rejection
  const chunks = []
  let bytes = 0
  const deadline = setTimeout(() => rejection ? finishRejection() : fail(), 3000)
  const end = payload => {
    answered = true
    clearTimeout(deadline)
    rejection?.destroy()
    upstream.destroy()
    socket.end(payload, () => socket.destroy())
  }
  const fail = () => {
    if (connected || answered) return
    end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  }
  // Buffer only a small rejection body; hop headers and old framing cannot survive a closed connection.
  const finishRejection = () => {
    if (answered || !rejection) return
    const omitted = new Set(['connection', 'proxy-connection', 'keep-alive', 'upgrade', 'te', 'trailer',
      'transfer-encoding', 'content-length', 'proxy-authenticate', 'proxy-authorization',
      ...(rejection.headers.connection ?? '').split(',').map(name => name.trim().toLowerCase())])
    const fields = []
    for (let index = 0; index < rejection.rawHeaders.length; index += 2) {
      if (!omitted.has(rejection.rawHeaders[index].toLowerCase())) {
        fields.push(`${rejection.rawHeaders[index]}: ${rejection.rawHeaders[index + 1]}`)
      }
    }
    const status = rejection.statusCode ?? 502
    const header = `HTTP/1.1 ${status} ${rejection.statusMessage ?? http.STATUS_CODES[status]}\r\n`
      + [...fields, 'Connection: close', `Content-Length: ${bytes}`].join('\r\n') + '\r\n\r\n'
    end(Buffer.concat([Buffer.from(header), ...chunks]))
  }
  upstream.on('upgrade', (response, backendSocket, backendHead) => {
    if (answered || socket.destroyed) { backendSocket.destroy(); return }
    connected = true
    clearTimeout(deadline)
    upgraded.add(socket); upgraded.add(backendSocket)
    const fields = response.rawHeaders.map((field, index) => index % 2 === 0
      ? `${field}: ${response.rawHeaders[index + 1]}` : null).filter(Boolean)
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${fields.join('\r\n')}\r\n\r\n`)
    if (head.length) backendSocket.write(head)
    if (backendHead.length) socket.write(backendHead)
    socket.on('close', () => { upgraded.delete(socket); backendSocket.destroy() })
    backendSocket.on('close', () => { upgraded.delete(backendSocket); socket.destroy() })
    backendSocket.on('error', () => socket.destroy())
    socket.pipe(backendSocket)
    backendSocket.pipe(socket)
  })
  upstream.on('response', response => {
    if (answered || socket.destroyed) { response.destroy(); return }
    rejection = response
    response.on('data', chunk => {
      const selected = chunk.subarray(0, 8192 - bytes)
      chunks.push(selected); bytes += selected.length
      if (bytes === 8192) finishRejection()
    })
    response.on('end', finishRejection)
    response.on('aborted', finishRejection)
    response.on('error', finishRejection)
  })
  upstream.on('error', fail)
  socket.on('error', () => socket.destroy())
  socket.on('close', () => {
    answered = true
    clearTimeout(deadline)
    rejection?.destroy()
    upstream.destroy()
  })
  upstream.end()
})
await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve))
await writeFile(process.env.PE_READY_FILE, JSON.stringify({ pid: process.pid,
  url: `http://127.0.0.1:${port}`, instanceId }), { mode: 0o600 })
const close = () => {
  clearInterval(timer)
  server.close()
  setTimeout(() => {
    server.closeAllConnections()
    for (const socket of upgraded) socket.destroy()
  }, 3000).unref()
}
process.once('SIGTERM', close)
process.once('SIGINT', close)
