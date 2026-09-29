/** The local Platform proxy preserves public origin and never retries an uncertain POST. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const script = join(root, 'products/power-evolve/scripts/trial-platform-lb.mjs')
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}
async function freePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

test('two Platform backends share one origin and an interrupted POST is not replayed',
  { timeout: 15_000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), 'pe-platform-lb-'))
    t.after(() => rm(temporary, { recursive: true, force: true }))
    const seen = []
    const servers = [0, 1].map(index => createServer(async (request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ready: true, service: 'platform', instanceId: `platform-${index}` }))
        return
      }
      seen.push({ index, host: request.headers.host, origin: request.headers.origin,
        peer: request.socket.remoteAddress, forwardedFor: request.headers['x-forwarded-for'],
        path: request.url, method: request.method })
      if (request.url === '/accepted') { for await (const _chunk of request) { /* drain */ }
        response.destroy(); return }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: platform-${index}\n\n`)
    }))
    const [first, second] = await Promise.all(servers.map(listen))
    t.after(async () => { for (const server of servers) {
      server.closeAllConnections()
      if (server.listening) await new Promise(resolve => server.close(resolve))
    } })
    const port = await freePort(), hostPort = await freePort()
    const child = spawn(process.execPath, [script], { cwd: root,
      env: { ...process.env, PE_PLATFORM_PORT: String(first), PE_PLATFORM_SECOND_PORT: String(second),
        PE_PLATFORM_LOAD_BALANCER_PORT: String(port), PE_MULTI_HOST: '1',
        PE_LOAD_BALANCER_PORT: String(hostPort), PE_READY_FILE: join(temporary, 'ready.json') },
      stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
        try { await once(child, 'exit') } finally { clearTimeout(deadline) }
      }
    })
    const origin = `http://127.0.0.1:${port}`
    let healthy
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Platform LB exited: ${output}`)
      try { healthy = await (await fetch(`${origin}/health`)).json()
        if (healthy.backends.every(item => item.healthy)) break }
      catch { await delay(30) }
    }
    assert.equal(healthy.backends.filter(item => item.healthy).length, 2, output)
    const a = await fetch(`${origin}/config`)
    const b = await fetch(`${origin}/config`, { headers: { origin: `http://127.0.0.1:${hostPort}`,
      'x-forwarded-for': '203.0.113.123' } })
    assert.equal(a.headers.get('x-pe-trial-platform'), 'platform')
    assert.equal(b.headers.get('x-pe-trial-platform'), 'platform-b')
    assert.deepEqual(seen.map(item => item.host), [`127.0.0.1:${port}`, `127.0.0.1:${port}`])
    assert.deepEqual(seen.map(item => item.peer), ['127.0.0.1', '127.0.0.1'])
    assert.equal(seen[1].forwardedFor, '203.0.113.123')
    assert.equal((await fetch(`${origin}/config`, { headers: { origin: 'https://attacker.test' } })).status, 403)
    const wrongHost = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/config`, { headers: { host: 'wrong.test' } }, response => {
        response.resume(); resolve(response.statusCode)
      })
      request.on('error', reject); request.end()
    })
    assert.equal(wrongHost, 403)
    assert.equal((await fetch(`${origin}/accepted`, { method: 'POST', body: '{}' })).status, 502)
    assert.equal(seen.filter(item => item.path === '/accepted').length, 1)
    assert.equal(seen.at(-1).index, 0)
    servers[0].closeAllConnections()
    await new Promise(resolve => servers[0].close(resolve))
    for (let attempt = 0; attempt < 50; attempt++) {
      healthy = await (await fetch(`${origin}/health`)).json()
      if (!healthy.backends[0].healthy) break
      await delay(30)
    }
    assert.equal(healthy.backends[0].healthy, false)
    const recovered = await fetch(`${origin}/config`)
    assert.equal(recovered.headers.get('x-pe-trial-platform'), 'platform-b')
    assert.equal(await recovered.text(), 'data: platform-1\n\n')
  })
