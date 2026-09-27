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
  const choices = backends.map((backend, index) => ({ backend, index })).filter(item => item.backend.healthy)
  if (!choices.length) {
    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end('{"error":"hosts_unavailable"}')
    return
  }
  const selected = choices[cursor++ % choices.length].backend
  selected.served++
  const headers = { ...request.headers, host: new URL(selected.origin).host,
    'x-forwarded-host': request.headers.host ?? '', 'x-forwarded-proto': 'http' }
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
server.on('upgrade', (_request, socket) => socket.destroy())
await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve))
await writeFile(process.env.PE_READY_FILE, JSON.stringify({ pid: process.pid,
  url: `http://127.0.0.1:${port}`, instanceId }), { mode: 0o600 })
const close = () => {
  clearInterval(timer)
  server.close()
  setTimeout(() => server.closeAllConnections(), 3000).unref()
}
process.once('SIGTERM', close)
process.once('SIGINT', close)
