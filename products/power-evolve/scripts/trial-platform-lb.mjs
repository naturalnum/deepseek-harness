/** Loopback trial proxy for two trusted Platform processes; it never retries a request. */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { writeFile } from 'node:fs/promises'

function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Invalid ${name}`)
  return value
}
const portNumber = port('PE_PLATFORM_LOAD_BALANCER_PORT', 18900)
const hostPort = port(process.env.PE_MULTI_HOST === '1' ? 'PE_LOAD_BALANCER_PORT' : 'PE_HOST_PORT',
  process.env.PE_MULTI_HOST === '1' ? 18898 : 18880)
const backends = [
  { name: 'platform', port: port('PE_PLATFORM_PORT', 18881) },
  { name: 'platform-b', port: port('PE_PLATFORM_SECOND_PORT', 18899) },
].map(value => ({ ...value, origin: `http://127.0.0.1:${value.port}`, healthy: false,
  instanceId: null, served: 0 }))
if (!process.env.PE_READY_FILE || new Set([portNumber, hostPort, ...backends.map(value => value.port)]).size !== 4) {
  throw new Error('Invalid trial Platform load balancer configuration')
}
const instanceId = randomUUID()
const authority = `127.0.0.1:${portNumber}`
const platformOrigin = `http://${authority}`
const hostOrigin = `http://127.0.0.1:${hostPort}`
let cursor = 0
function choose() {
  const healthy = backends.filter(value => value.healthy)
  return healthy.length ? healthy[cursor++ % healthy.length] : null
}
async function probe() {
  await Promise.all(backends.map(async backend => {
    try {
      const response = await fetch(`${backend.origin}/health`, { signal: AbortSignal.timeout(1000) })
      const value = await response.json()
      backend.healthy = response.ok && value.ready === true && value.service === 'platform'
      backend.instanceId = backend.healthy && typeof value.instanceId === 'string' ? value.instanceId : null
    } catch (_unavailable) { backend.healthy = false; backend.instanceId = null }
  }))
}
function authorityValid(request) {
  return request.headers.host === authority && (request.headers.origin === undefined
    || request.headers.origin === platformOrigin || request.headers.origin === hostOrigin)
}
await probe()
const timer = setInterval(() => void probe(), 500)
const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ ready: backends.some(value => value.healthy),
      service: 'platform-load-balancer', instanceId,
      backends: backends.map(({ name, origin, healthy, instanceId, served }) =>
        ({ name, origin, healthy, instanceId, served })) }))
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
    response.end('{"error":"platforms_unavailable"}')
    return
  }
  selected.served++
  const headers = { ...request.headers, host: authority,
    'x-forwarded-host': authority, 'x-forwarded-proto': 'http' }
  for (const key of ['connection', 'proxy-connection', 'keep-alive', 'upgrade', 'te', 'trailer']) delete headers[key]
  const upstream = http.request(new URL(request.url ?? '/', selected.origin), {
    method: request.method, headers, agent: false,
  }, result => {
    response.writeHead(result.statusCode ?? 502,
      { ...result.headers, 'x-pe-trial-platform': selected.name })
    result.pipe(response)
    response.on('close', () => { if (!response.writableEnded) result.destroy() })
  })
  request.on('aborted', () => upstream.destroy())
  upstream.on('error', () => {
    if (response.headersSent) response.destroy()
    else {
      response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end('{"error":"platform_unavailable"}')
    }
  })
  request.pipe(upstream)
})
await new Promise((resolve, reject) => server.once('error', reject).listen(portNumber, '127.0.0.1', resolve))
await writeFile(process.env.PE_READY_FILE, JSON.stringify({ pid: process.pid,
  url: platformOrigin, instanceId }), { mode: 0o600 })
const close = () => {
  clearInterval(timer)
  server.close()
  setTimeout(() => server.closeAllConnections(), 3000).unref()
}
process.once('SIGTERM', close)
process.once('SIGINT', close)
