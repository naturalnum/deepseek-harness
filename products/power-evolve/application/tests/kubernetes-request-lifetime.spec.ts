/** Real verified TLS requests apply elapsed deadlines and release streamed responses before settlement. */
import { createServer, type Server } from 'node:https'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { KubernetesClient } from '../src/platform/kubernetes.ts'

async function fixture(run: (server: Server, client: KubernetesClient) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pe-kubernetes-tls-'))
  let server: Server | undefined
  const sockets = new Set<Duplex>()
  try {
    const key = join(root, 'key.pem'), cert = join(root, 'cert.pem'), token = join(root, 'token')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1', '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10000 })
    await writeFile(token, 'owned-platform-fixture-token', { mode: 0o600 })
    server = createServer({ key: await readFile(key), cert: await readFile(cert) })
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing HTTPS listener address')
    const client = await KubernetesClient.fromServiceAccount(`https://127.0.0.1:${address.port}`, cert, token)
    await run(server, client)
  } finally {
    vi.useRealTimers()
    if (server) {
      const active = server
      const closing = new Promise<void>((resolve, reject) => {
        active.close((error) => { if (error) reject(error); else resolve() })
      })
      await Promise.all([...sockets].map(async (socket) => {
        const closed = socket.closed ? Promise.resolve() : once(socket, 'close')
        socket.destroy(); await closed
      }))
      await closing
    }
    await rm(root, { recursive: true, force: true })
  }
}

test('verified service proxy preserves Platform headers and validates its bounded JSON reply', () => fixture(async (server, client) => {
  server.on('request', (request, response) => {
    expect(request.headers.authorization).toBe('Bearer owned-platform-fixture-token')
    expect(request.headers['x-power-evolve-runner-token']).toBe('owned-process-fixture-token')
    expect(request.headers['x-power-evolve-browser-token']).toBe('owned-browser-fixture-token')
    expect(request.headers.origin).toBe('https://trial.example')
    response.end(JSON.stringify({ owned: true }))
  })
  expect(await client.call('GET', '/', undefined, 2000, 'owned-process-fixture-token', 1024,
    { 'x-power-evolve-browser-token': 'owned-browser-fixture-token', origin: 'https://trial.example' }))
    .toEqual({ owned: true })
}))

test('continuous response progress cannot extend the elapsed request deadline', () => fixture(async (server, client) => {
  const began = Promise.withResolvers<undefined>()
  let progress = 0, ticker: NodeJS.Timeout | undefined
  server.on('request', (_request, response) => {
    response.on('error', () => {})
    response.write('{')
    ticker = setInterval(() => { response.write(' '); progress++ }, 200)
    response.once('close', () => { clearInterval(ticker) })
    began.resolve(undefined)
  })
  vi.useFakeTimers()
  let settled = false
  const result = client.call('GET', '/', undefined, 1000).then(() => {
    throw new Error('Incomplete response unexpectedly accepted')
  }, (error: unknown) => { settled = true; return error })
  try {
    await began.promise
    await vi.advanceTimersByTimeAsync(1001)
    expect(progress).toBeGreaterThan(0)
    expect(settled).toBe(true)
    expect(await result).toMatchObject({ message: 'Kubernetes request timed out' })
  } finally { clearInterval(ticker); vi.useRealTimers(); await result }
}))
