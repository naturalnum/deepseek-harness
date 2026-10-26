/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver row, and every assertion observes the
 * user-visible HTTP surface of the running server (routing precedence, index
 * taps, fallback-seat semantics, per-request error containment, the TLS
 * listener and its teardown). The bind-address schema and both address
 * predicates are asserted directly, before any server binds; one wildcard load
 * denial goes through the real Loader.
 */

import { generateKeyPairSync, X509Certificate } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { once } from 'node:events'
import { Agent, request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getDefaultHighWaterMark, type Duplex } from 'node:stream'
import { connect as tlsConnect, TLSSocket } from 'node:tls'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer, { bindUrlHost, isLoopbackHost, normalizeBindAddress, renderIndexInjections, type Config, type TlsConfig } from '../src/index.ts'
import { materializeTlsFixture, materializeClientTlsFixture, type TlsFixture } from './tls-fixture.ts'

/** One-shot barrier for disposal overlapping a pending PEM read. */
const tlsReadGate = vi.hoisted(() => {
  let held: { entered: () => void; resume: Promise<void> } | undefined
  return {
    /** Arm the gate and return the barrier the reading side reaches. */
    arm() {
      const entered = Promise.withResolvers<undefined>()
      const resumed = Promise.withResolvers<undefined>()
      held = { entered: () => { entered.resolve(undefined) }, resume: resumed.promise }
      return { entered: entered.promise, release: () => { resumed.resolve(undefined) } }
    },
    async hold(path: string): Promise<void> {
      if (held === undefined || !path.endsWith('.pem')) return
      const gate = held
      held = undefined
      gate.entered()
      await gate.resume
    },
  }
})

const clientCaReadGate = vi.hoisted(() => {
  const handles: FileHandle[] = []
  let held: { entered: (handle: FileHandle) => void; resume: Promise<void> } | undefined
  return {
    handles,
    arm() {
      const entered = Promise.withResolvers<FileHandle>(), resumed = Promise.withResolvers<undefined>()
      held = { entered: entered.resolve, resume: resumed.promise }
      return { entered: entered.promise, release: () => { resumed.resolve(undefined) } }
    },
    async hold(path: string, handle: FileHandle): Promise<void> {
      if (!path.endsWith('client-ca.pem')) return
      handles.push(handle)
      if (held === undefined) return
      const gate = held
      held = undefined
      gate.entered(handle)
      await gate.resume
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      if (typeof args[0] === 'string') await tlsReadGate.hold(args[0])
      return actual.readFile(...args)
    },
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args)
      if (typeof args[0] === 'string') await clientCaReadGate.hold(args[0], handle)
      return handle
    },
  }
})

// Every composition a test boots owns a temp root and a fiber; both are released
// even when an assertion fails, so a test may boot more than one.
let compositions: { context: Context; root: string }[] = []
let tlsRoot: string | undefined

afterEach(async () => {
  const loaded = compositions
  compositions = []
  await Promise.all(loaded.map(async ({ context, root }) => {
    await context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }))
  if (tlsRoot !== undefined) await rm(tlsRoot, { recursive: true, force: true })
  tlsRoot = undefined
})

/** Materialize the generated TLS fixture into a temp root this file cleans up. */
async function tlsFixture(): Promise<TlsFixture> {
  tlsRoot ??= await mkdtemp(join(tmpdir(), 'dsh-webserver-tls-'))
  return materializeTlsFixture(tlsRoot)
}

/**
 * Write a cordis.yml with one webserver row, then boot it through the real Loader.
 * @param tls - a TLS row (partial rows model a user's incomplete YAML), `null`
 * for an explicit empty `tls:` (what a user's `tls:` with no value parses to),
 * or undefined to omit the field entirely.
 */
async function loadComposition(
  port = 0,
  gzip = false,
  host = '127.0.0.1',
  tls?: Partial<TlsConfig> | null,
  transportLimits?: Config['transportLimits'] | null,
): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-webserver-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    `    host: '${host}'`,
    `    port: ${String(port)}`,
    ...(tls === undefined
      ? []
      : tls === null
        ? ['    tls:']
        : [
          '    tls:',
          ...(tls.certFile === undefined ? [] : [`      certFile: '${tls.certFile}'`]),
          ...(tls.keyFile === undefined ? [] : [`      keyFile: '${tls.keyFile}'`]),
          ...(tls.clientCa === undefined ? [] : [`      clientCa: ${JSON.stringify(tls.clientCa)}`]),
        ]),
    ...(gzip
      ? [
        '    compression: gzip',
        '    compressionLevel: 1',
        '    compressionThresholdBytes: 16',
      ]
      : []),
    ...(transportLimits === undefined ? [] : [`    transportLimits: ${JSON.stringify(transportLimits)}`]),
    '',
  ].join('\n'))

  const context = new Context()
  compositions.push({ context, root })
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** The webserver row's fiber in a Loaded composition. */
function webserverFiber(context: Context) {
  return [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-host-webserver')?.fiber
}

/** The port a started listener bound; a test that reads it before `listen` fails here. */
function boundPort(port: number | undefined): number {
  if (port === undefined) throw new Error('webserver test: the listener has not bound a port')
  return port
}

/** GET (by default) one path against the running server; returns status plus a body prefix. */
async function request(
  port: number | undefined,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(`http://127.0.0.1:${String(boundPort(port))}${path}`, init)
  return { status: response.status, body: (await response.text()).slice(0, 80), headers: response.headers }
}

/** Open one raw upgrade request and return after the handler writes its response. */
async function upgrade(listenerPort: number | undefined, path: string): Promise<ReturnType<typeof connect>> {
  const port = boundPort(listenerPort)
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    '',
    '',
  ].join('\r\n'))
  const [data] = await response as [Buffer]
  expect(String(data)).toContain('101 Switching Protocols')
  return socket
}

/**
 * GET one path over TLS. `ca` is the client's trust anchor, and a call without
 * it trusts nothing, so it only succeeds if the listener really speaks TLS.
 */
function tlsRequest(
  port: number | undefined,
  path: string,
  ca?: string,
  agent?: Agent | false,
  credentials?: { cert: string; key: string },
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>()
  const request = httpsRequest({
    host: '127.0.0.1',
    port: boundPort(port),
    path,
    ...(ca === undefined ? {} : { ca }),
    ...(agent === undefined ? {} : { agent }),
    ...(credentials === undefined ? {} : credentials),
    ...(headers === undefined ? {} : { headers }),
  }, (response) => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => { body += chunk })
    response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }) })
  })
  request.on('error', reject)
  request.end()
  return promise
}

/** Open one upgrade request over TLS and return after the handler answers 101. */
function tlsUpgrade(port: number | undefined, path: string, ca: string): Promise<{ status: number; socket: Duplex }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; socket: Duplex }>()
  const request = httpsRequest({
    host: '127.0.0.1',
    port: boundPort(port),
    path,
    ca,
    headers: { Connection: 'Upgrade', Upgrade: 'dsh-test' },
  })
  request.on('upgrade', (response, socket) => {
    resolve({ status: response.statusCode ?? 0, socket })
  })
  request.on('error', reject)
  request.end()
  return promise
}

describe('real Loader composition', () => {
  it('accepts one concrete IP literal, keeping an IPv6 zone for listen', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '0.1.2.3', '::1', 'fd00::1', '::ffff:10.1.2.3', '::ffff:0.1.2.3', '0:0:0:0:0:0:0:1', 'fe80::1%lo', '::0.0.0.1', '::0.0.0.1%lo', '::127.0.0.1']) {
      expect(HttpServer.Config({ host, port: 0 }).host).toBe(host)
    }
  })

  it('rejects every wildcard spelling by address value, not by text', () => {
    // Every spelling node:net accepts that parses to the unspecified address:
    // IPv4 any, IPv6 any in long and short forms, IPv4-compatible, and the
    // IPv4-mapped forms of IPv4 any, with or without a zone.
    for (const host of [
      '0.0.0.0', '::', '::0', '0000::', '0::', '0:0:0:0:0:0:0:0', '::0.0.0.0', '::0.0.0.0%lo', '::%lo',
      '::ffff:0.0.0.0', '::ffff:0:0', '::ffff:0000:0000', '0:0:0:0:0:ffff:0:0',
      '0:0:0:0:0:ffff:0.0.0.0', '::ffff:0.0.0.0%eth0',
    ]) {
      expect(() => HttpServer.Config({ host, port: 0 })).toThrow(
        /is an unspecified \(wildcard\) address, which is not supported/,
      )
    }
    for (const host of ['localhost', 'example.com', '*', '[::]', '[fd00::1]', '10.1.2.3/8']) {
      expect(() => HttpServer.Config({ host, port: 0 }))
        .toThrow(/is not a concrete IPv4 or IPv6 address literal/)
    }
  })

  it('denies the IPv4-mapped wildcard through the real plugin load, not only the predicate', async () => {
    // The Loader is nontransactional: a rejected config leaves a FAILED fiber
    // whose await carries the schema error rather than rejecting loader.await().
    const denied = await loadComposition(0, false, '::ffff:0.0.0.0')
    const fiber = webserverFiber(denied)
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow(/is an unspecified \(wildcard\) address/)
  })

  it('classifies loopback bind addresses from the parsed value, including mapped and zone forms', () => {
    for (const host of ['127.0.0.1', '127.8.9.10', '127.5.5.5', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::1%lo', '::0.0.0.1', '::0.0.0.1%lo']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
    // A dotted-quad tail is the address's own low 32 bits, never an IPv4 tail:
    // ::127.0.0.1 is the unrelated IPv6 address ::7f00:1, not IPv4 loopback.
    for (const host of ['10.1.2.3', '::ffff:10.1.2.3', 'fd00::1', 'fe80::1%lo', '::2', 'localhost', '::127.0.0.1', '::127.0.0.1%lo', '::0.0.0.2']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })

  it('reads a dotted-quad IPv6 tail as the address it names', () => {
    const rows: [string, string][] = [
      ['::0.0.0.1', '::1'],
      ['::0.0.0.1%lo', '::1'],
      ['::127.0.0.1', '::7f00:1'],
      ['::1', '::1'],
      ['10.1.2.3', '10.1.2.3'],
      // Genuinely IPv4-mapped literals keep their IPv4 form for a browser URL.
      ['::ffff:127.0.0.1', '127.0.0.1'],
      ['::ffff:7f00:1', '127.0.0.1'],
      ['::ffff:10.1.2.3', '10.1.2.3'],
    ]
    for (const [host, text] of rows) expect(normalizeBindAddress(host)).toBe(text)
    expect(() => normalizeBindAddress('localhost')).toThrow(/is not a concrete IPv4 or IPv6 address literal/)
  })

  it('writes bind addresses in their URL host form', () => {
    const rows: [string, string | undefined][] = [
      ['127.0.0.1', '127.0.0.1'],
      ['::ffff:127.0.0.1%lo', '127.0.0.1'],
      ['::1', '[::1]'],
      ['::0.0.0.1%lo', '[::1]'],
      ['10.1.2.3', '10.1.2.3'],
      ['fd00::1', '[fd00::1]'],
      // A zone selects an interface and no URL can carry it; only a loopback zone is redundant.
      ['fe80::1%eth0', undefined],
      ['::127.0.0.1%lo', undefined],
    ]
    for (const [host, text] of rows) expect(bindUrlHost(host)).toBe(text)
  })

  it('reports no origin before binding or for a bind address that no URL can express', () => {
    expect(() => new HttpServer(new Context(), HttpServer.Config({ host: '127.0.0.1', port: 0 })).getOrigin())
      .toThrow('webserver: origin read before the listener bound a port')
    expect(() => new HttpServer(new Context(), HttpServer.Config({ host: 'fe80::1%eth0', port: 0 })).getOrigin())
      .toThrow('webserver: bind address "fe80::1%eth0" carries an interface zone id, which no URL can express')
  })


  it('applies gzip only to eligible socket-backed HTTP responses', { timeout: 60_000 }, async () => {
    expect(HttpServer.Config({ host: '127.0.0.1', port: 0 })).toEqual({
      host: '127.0.0.1',
      port: 0,
      compression: 'none',
      compressionLevel: 1,
      compressionThresholdBytes: 1024,
    })
    expect(() => HttpServer.Config({
      host: '127.0.0.1', port: 0, compressionLevel: 10,
    })).toThrow()

    const loaded = await loadComposition(0, true)
    const server = loaded.webServer
    const body = 'compressible response '.repeat(8)
    server.register({
      kind: 'exact',
      path: '/text',
      handler: (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
        })
        res.end(body)
      },
    })
    server.register({
      kind: 'exact',
      path: '/stream',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write(body.slice(0, 40))
        res.end(body.slice(40))
      },
    })
    server.register({
      kind: 'exact',
      path: '/small',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' })
        res.end('small')
      },
    })
    server.register({
      kind: 'exact',
      path: '/events',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(body)
      },
    })
    server.register({
      kind: 'exact',
      path: '/archive',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/gzip' })
        res.end(body)
      },
    })
    server.register({
      kind: 'exact',
      path: '/range',
      handler: (_req, res) => {
        res.writeHead(206, { 'content-type': 'text/plain', 'content-range': 'bytes 0-15/160' })
        res.end(body.slice(0, 16))
      },
    })

    const compressed = await request(server.port, '/text', { headers: { 'accept-encoding': 'br, gzip, deflate' } })
    expect(compressed).toMatchObject({ status: 200, body: body.slice(0, 80) })
    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    expect(compressed.headers.get('content-length')).toBeNull()
    expect(compressed.headers.get('vary')).toBe('Accept-Encoding')
    const streamed = await request(server.port, '/stream', { headers: { 'accept-encoding': 'gzip' } })
    expect(streamed).toMatchObject({ body: body.slice(0, 80) })
    expect(streamed.headers.get('content-encoding')).toBe('gzip')
    expect((await request(server.port, '/small', { headers: { 'accept-encoding': 'gzip' } }))
      .headers.get('content-encoding')).toBeNull()

    const identity = await request(server.port, '/text', {
      headers: { 'accept-encoding': 'gzip;q=0.5, identity;q=1' },
    })
    expect(identity.headers.get('content-encoding')).toBeNull()
    expect(identity.headers.get('vary')).toBe('Accept-Encoding')
    expect((await request(server.port, '/events', { headers: { 'accept-encoding': 'gzip' } }))
      .headers.get('content-encoding')).toBeNull()
    expect((await request(server.port, '/archive', { headers: { 'accept-encoding': 'gzip' } }))
      .headers.get('content-encoding')).toBeNull()
    expect((await request(server.port, '/range', { headers: { 'accept-encoding': 'gzip' } }))
      .headers.get('content-encoding')).toBeNull()
  })

  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('serves registered routes, index taps, and the fallback-seat semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const server = loaded.webServer
    expect(server).toBeInstanceOf(HttpServer)
    const port = server.port
    expect(port).toBeGreaterThan(0)

    // Routing precedence: exact beats prefix, longest prefix wins, a prefix
    // route answers its own path, and routes own their method handling
    // (POST reaches a registered prefix; 405 is fallback-only semantics).
    server.register({ kind: 'exact', path: '/probe', handler: (_req, res) => { res.writeHead(200); res.end('EXACT') } })
    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    server.register({ kind: 'prefix', path: '/api/deep', handler: (_req, res) => { res.writeHead(200); res.end('DEEP') } })
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })
    expect(await request(port, '/api/anything')).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/deep/leaf')).toMatchObject({ status: 200, body: 'DEEP' })
    expect(await request(port, '/api')).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/anything', { method: 'POST' })).toMatchObject({ status: 200, body: 'API' })

    // Fallback seat: 404 while unclaimed; the owner answers everything no
    // named route matches; index taps are the owner's to apply; the seat
    // admits exactly one owner and the disposer releases it.
    expect((await request(port, '/no/such/route')).status).toBe(404)
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    expect(server.applyIndexTaps('<head></head>')).toContain('__T__')
    const releaseFallback = server.registerFallback((req, res) => {
      // Decode like a real static server would — a malformed %-escape throws
      // here, probing the webserver's per-request error containment.
      decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(server.applyIndexTaps('<head></head><body>shell</body>'))
    })
    expect(() => server.registerFallback(() => {})).toThrow(/fallback already registered/)
    expect((await request(port, '/no/such/route')).body).toContain('__T__')
    untap()
    expect((await request(port, '/no/such/route')).body).not.toContain('__T__')
    expect((await request(port, '/no/such/route')).body).toContain('shell')

    // Per-request error containment: a malformed %-escape answers 400 and the
    // server keeps serving afterwards (no process-level failure path).
    expect((await request(port, '/%zz')).status).toBe(400)
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })

    // Duplicate (kind, path) is a misconfiguration and throws; the disposer
    // restores registrability (register/disposer symmetry).
    expect(() => server.register({ kind: 'exact', path: '/probe', handler: () => {} }))
      .toThrow(/duplicate exact route/)
    const disposeOnce = server.register({ kind: 'exact', path: '/once', handler: (_req, res) => { res.writeHead(200); res.end('ONCE') } })
    expect(await request(port, '/once')).toMatchObject({ status: 200, body: 'ONCE' })
    disposeOnce()
    expect((await request(port, '/once')).body).toContain('shell') // back to the fallback owner
    expect(() => server.register({ kind: 'exact', path: '/once', handler: () => {} })).not.toThrow()

    // Releasing the seat restores the unclaimed 404 and registrability.
    releaseFallback()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()

    // Upgrade routes match exact pathnames, reject duplicate ownership, and
    // become registrable again after disposal. The accepted socket stays open
    // so the teardown assertion also covers upgraded-connection ownership.
    let upgradedServerClosed = false
    const disposeUpgrade = server.registerUpgrade({
      path: '/events',
      handler: (_req, socket) => {
        socket.once('close', () => { upgradedServerClosed = true })
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    expect(() => server.registerUpgrade({ path: '/events', handler: () => {} }))
      .toThrow(/duplicate upgrade route/)
    const upgraded = await upgrade(port, '/events?stream=mux')
    disposeUpgrade()
    expect(() => server.registerUpgrade({ path: '/events', handler: () => {} })).not.toThrow()

    // The webserver contains raw-socket errors even before an upgrade handler
    // has installed its protocol implementation.
    server.registerUpgrade({
      path: '/upgrade-error',
      handler: async (_req, socket) => {
        await Promise.resolve()
        socket.destroy(new Error('test upgrade transport failure'))
      },
    })
    const failedUpgrade = connect(boundPort(port), '127.0.0.1')
    failedUpgrade.on('error', () => { /* The server-side reset is the fixture outcome. */ })
    await once(failedUpgrade, 'connect')
    const failedUpgradeClosed = once(failedUpgrade, 'close')
    failedUpgrade.write([
      'GET /upgrade-error HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Connection: Upgrade',
      'Upgrade: dsh-test',
      '',
      '',
    ].join('\r\n'))
    await failedUpgradeClosed
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })

    // Teardown closes both ordinary and upgraded sockets before it resolves.
    await loaded.fiber.dispose()
    expect(upgradedServerClosed).toBe(true)
    upgraded.destroy()
    await expect(request(port, '/probe')).rejects.toThrow()
  })

  it('collects injection rows fresh per render and layers taps over the rendered rows', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const server = loaded.webServer
    let flag = 'dark'
    loaded.on('webserver/index-inject', (table) => {
      table.push(
        { kind: 'script', placement: 'head', text: 'window.__Q__=1' },
        { kind: 'script-src', placement: 'head', src: '/plugins/a.js?rev="1"&x=<y>' },
        { kind: 'script-preload', src: '/plugins/b.js?rev="2"&x=<z>' },
        { kind: 'global', name: '__DSH_BOOT__', value: { rev: '</script><b>' } },
        { kind: 'style', text: 'body{margin:0}' },
        { kind: 'html', placement: 'head', html: '<meta name="probe">' },
        { kind: 'script', placement: 'body', text: `window.__P__=${JSON.stringify(flag)}` },
      )
    })

    const html = server.renderIndex('<html><head></head><body>shell</body></html>')
    // Head rows land right after the opening head tag in table order; the body
    // row lands right after the opening body tag.
    const order = [
      '<head>',
      '<script>window.__Q__=1</script>',
      '<script src="/plugins/a.js?rev=&quot;1&quot;&amp;x=&lt;y&gt;"></script>',
      '<link rel="preload" as="script" href="/plugins/b.js?rev=&quot;2&quot;&amp;x=&lt;z&gt;">',
      'globalThis["__DSH_BOOT__"] = {"rev":"\\u003c/script>\\u003cb>"}',
      '<style>body{margin:0}</style>',
      '<meta name="probe">',
      '<body>',
      '<script>window.__P__="dark"</script>',
      'shell',
    ].map(part => html.indexOf(part))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every(at => at !== -1)).toBe(true)

    // Fresh collection per render: the listener reads live state at emit time.
    flag = 'light'
    expect(server.renderIndex('<head></head><body></body>')).toContain('window.__P__="light"')

    // Raw taps still run, over the already-rendered rows.
    const untap = server.tapIndex(h => h.replace('window.__Q__=1', 'window.__Q__=2'))
    expect(server.renderIndex('<head></head><body></body>')).toContain('window.__Q__=2')
    untap()

    // Tag-less fragments: head rows prepend, body rows append, and the
    // boot-readiness tail lands after the last body row.
    expect(renderIndexInjections('<main>x</main>', [
      { kind: 'script', placement: 'head', text: 'H' },
      { kind: 'script', placement: 'body', text: 'B' },
    ])).toBe('<script>H</script><main>x</main><script>B</script>'
      + '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>')
  })

  it('serves HTTPS to a verifying client and reports the https protocol', { timeout: 60_000 }, async () => {
    const fixture = await tlsFixture()
    const tls = { certFile: fixture.certFile, keyFile: fixture.keyFile }
    expect(HttpServer.Config({ host: '127.0.0.1', port: 0, tls })).toEqual({
      host: '127.0.0.1',
      port: 0,
      tls,
      compression: 'none',
      compressionLevel: 1,
      compressionThresholdBytes: 1024,
    })

    const loaded = await loadComposition(0, false, '127.0.0.1', tls)
    const server = loaded.webServer
    expect(server.protocol).toBe('https:')
    expect(server.getOrigin()).toBe(`https://127.0.0.1:${String(server.port)}`)
    server.register({
      kind: 'exact',
      path: '/tls',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('SECURE')
      },
    })

    // The fixture CA is the only reason the handshake succeeds, so this is a
    // verifying client rather than one that disabled its checks.
    expect(await tlsRequest(server.port, '/tls', fixture.ca)).toEqual({ status: 200, body: 'SECURE' })
    await expect(tlsRequest(server.port, '/tls')).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    // The listener speaks TLS only: a plain-HTTP client cannot reach the route.
    await expect(request(server.port, '/tls')).rejects.toThrow()

    await loaded.fiber.dispose()
    await expect(tlsRequest(server.port, '/tls', fixture.ca)).rejects.toThrow()
  })

  it('treats an explicit null tls as no TLS and keeps serving plain HTTP', { timeout: 60_000 }, async () => {
    // A user's `tls:` with no value reaches the service as null through the schema.
    const loaded = await loadComposition(0, false, '127.0.0.1', null)
    const server = loaded.webServer
    expect(server.protocol).toBe('http:')
    expect(server.getOrigin()).toBe(`http://127.0.0.1:${String(server.port)}`)
    server.register({ kind: 'exact', path: '/plain', handler: (_req, res) => { res.writeHead(200); res.end('PLAIN') } })
    expect(await request(server.port, '/plain')).toMatchObject({ status: 200, body: 'PLAIN' })
    await expect(tlsRequest(server.port, '/plain')).rejects.toThrow()
  })

  it('rejects unusable TLS material at activation, before the listener binds', { timeout: 60_000 }, async () => {
    const fixture = await tlsFixture()
    const directory = dirname(fixture.certFile)
    // A valid key that pairs with nothing, plus an empty and an absent file.
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const otherKeyFile = join(directory, 'tls-other-key.pem')
    const emptyFile = join(directory, 'tls-empty.pem')
    await writeFile(otherKeyFile, otherKey)
    await writeFile(emptyFile, '')

    // Holding the port makes the ordering observable: material validated only
    // after a successful bind would report EADDRINUSE here instead.
    const holder = createTcpServer()
    const listening = once(holder, 'listening')
    holder.listen(0, '127.0.0.1')
    await listening
    const port = (holder.address() as AddressInfo).port
    const cases: { label: string; config: Partial<TlsConfig>; expected: RegExp }[] = [
      {
        label: 'mismatched key',
        config: { certFile: fixture.certFile, keyFile: otherKeyFile },
        expected: /are not a usable certificate and key pair/,
      },
      {
        label: 'absent file',
        config: { certFile: join(directory, 'tls-absent.pem'), keyFile: fixture.keyFile },
        expected: /cannot read tls\.certFile/,
      },
      {
        label: 'empty file',
        config: { certFile: emptyFile, keyFile: fixture.keyFile },
        expected: /tls\.certFile .* is empty/,
      },
      {
        // Both files are one setting: a row naming only the certificate never resolves.
        label: 'incomplete pair',
        config: { certFile: fixture.certFile },
        expected: /tls\.keyFile/,
      },
    ]
    try {
      for (const { label, config, expected } of cases) {
        const denied = await loadComposition(port, false, '127.0.0.1', config)
        const fiber = webserverFiber(denied)
        expect(fiber?.state, label).toBe(FiberState.FAILED)
        if (fiber === undefined) throw new Error(`${label}: webserver row is missing from the composition`)
        const failure = await fiber.await().then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error))
        expect(failure, label).toMatch(expected)
        expect(failure, label).not.toMatch(/EADDRINUSE/)
        // Diagnostics carry the paths that failed and never the material itself.
        expect(failure, label).not.toMatch(/PRIVATE KEY/)
        expect(failure, label).not.toContain(otherKey.split('\n')[1])
      }
    } finally {
      const closed = once(holder, 'close')
      holder.close()
      await closed
    }
  })

  it('reaches teardown quiescence for upgraded, idle, and handshaking TLS sockets', { timeout: 60_000 }, async () => {
    const fixture = await tlsFixture()
    const loaded = await loadComposition(0, false, '127.0.0.1', { certFile: fixture.certFile, keyFile: fixture.keyFile })
    const server = loaded.webServer
    let upgradeClosed = false
    server.registerUpgrade({
      path: '/events',
      handler: (_req, socket) => {
        socket.once('close', () => { upgradeClosed = true })
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    server.register({ kind: 'exact', path: '/probe', handler: (_req, res) => { res.writeHead(200); res.end('EXACT') } })

    const clients = new Map<Duplex, Promise<void>>()
    const clientErrors: Error[] = []
    const observeClient = (socket: Duplex): void => {
      const onError = (error: Error): void => { clientErrors.push(error) }
      socket.on('error', onError)
      // Destruction may emit ECONNRESET before close; only close confirms release.
      clients.set(socket, new Promise<void>((resolve) => {
        socket.once('close', () => {
          socket.off('error', onError)
          resolve()
        })
      }))
    }
    const agent = new Agent({ keepAlive: true, ca: fixture.ca, maxSockets: 1 })
    const idleReady = new Promise<void>((resolve) => {
      agent.once('free', (socket: Duplex) => {
        observeClient(socket)
        resolve()
      })
    })
    try {
      const upgraded = await tlsUpgrade(server.port, '/events', fixture.ca)
      observeClient(upgraded.socket)
      expect(upgraded.status).toBe(101)
      expect(await tlsRequest(server.port, '/probe', fixture.ca, agent)).toEqual({ status: 200, body: 'EXACT' })
      await idleReady
      // A TCP connection without a ClientHello is absent from closeAllConnections().
      const handshaking = connect(boundPort(server.port), '127.0.0.1')
      observeClient(handshaking)
      await once(handshaking, 'connect')

      expect(clientErrors).toEqual([])
      for (const socket of clients.keys()) expect(socket.destroyed).toBe(false)
      await loaded.fiber.dispose()

      await Promise.all(clients.values())
      for (const error of clientErrors) expect(error).toMatchObject({ code: 'ECONNRESET' })
      expect(upgradeClosed).toBe(true)
      await expect(tlsRequest(server.port, '/probe', fixture.ca)).rejects.toThrow()
    } finally {
      agent.destroy()
      for (const socket of clients.keys()) socket.destroy()
      await Promise.all(clients.values())
    }
  })

  it('closes the listener when disposal lands while the TLS material is still being read', { timeout: 60_000 }, async () => {
    const fixture = await tlsFixture()
    const gate = tlsReadGate.arm()
    const loading = loadComposition(0, false, '127.0.0.1', { certFile: fixture.certFile, keyFile: fixture.keyFile })
    await gate.entered
    // loadComposition registers the composition before its Loader starts, so the
    // booting one — and the service its constructor already provided — is
    // observable while initialization is parked inside the TLS read.
    const composed = compositions.at(-1)
    if (composed === undefined) throw new Error('the booting composition is not registered')
    const server = composed.context.webServer
    // Disposal is issued first and settles only after the read, the listen, and
    // the teardown it owns: the listener bound in between must be closed.
    const disposal = composed.context.fiber.dispose()
    gate.release()
    await disposal
    await loading
    expect(server.port).toBeGreaterThan(0)
    await expect(tlsRequest(server.port, '/', fixture.ca)).rejects.toThrow()
  })

  it('fails the fiber when the port is already taken (fail-loud at activation)', { timeout: 60_000 }, async () => {
    const first = await loadComposition()
    const second = await loadComposition(first.webServer.port)
    const fiber = webserverFiber(second)
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow('EADDRINUSE')
  })
})

describe('finite transport limits through the original Loader', () => {
  const limits = { maxHeaderPairs: 1600, maxHeaderBytes: 131072, highWaterMark: 1024, maxConnections: 4 }
  const clients = new Map<Duplex, Promise<void>>()

  afterEach(async () => {
    for (const client of clients.keys()) client.destroy()
    await Promise.all(clients.values())
    clients.clear()
  })

  async function open(context: Context, ca?: string): Promise<Duplex> {
    const port = boundPort(context.webServer.port)
    const endpoint = { host: '127.0.0.1', port, allowHalfOpen: true }
    const client = ca === undefined
      ? connect(endpoint)
      : tlsConnect({ ...endpoint, ca })
    // Cancellation and admission refusal can reset the wire; actual close owns cleanup.
    client.on('error', () => {})
    client.on('end', () => { client.end() })
    clients.set(client, new Promise<void>((resolve) => { client.once('close', () => { resolve() }) }))
    await once(client, ca === undefined ? 'connect' : 'secureConnect')
    return client
  }

  async function exchange(context: Context, input: string | Buffer, ca?: string): Promise<Buffer> {
    const client = await open(context, ca)
    const chunks: Buffer[] = []
    client.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    client.write(input)
    await clients.get(client)
    return Buffer.concat(chunks)
  }

  async function compose(secure: boolean, selected = limits): Promise<{ context: Context; ca?: string }> {
    const fixture = secure ? await tlsFixture() : undefined
    const context = await loadComposition(0, false, '127.0.0.1', fixture === undefined
      ? undefined : { certFile: fixture.certFile, keyFile: fixture.keyFile }, selected)
    return fixture === undefined ? { context } : { context, ca: fixture.ca }
  }

  it('rejects incomplete, nonpositive, nonfinite and overflowing settings before listen', async () => {
    for (const field of Object.keys(limits)) {
      for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => HttpServer.Config({ host: '127.0.0.1', port: 0,
          transportLimits: { ...limits, [field]: value } })).toThrow()
      }
    }
    for (const value of [{}, { ...limits, maxHeaderPairs: 0x3fff_ffff }]) {
      expect(() => { Reflect.apply(HttpServer.Config, undefined, [{ host: '127.0.0.1', port: 0, transportLimits: value }]) }).toThrow()
    }
    const denied = await loadComposition(0, false, '127.0.0.1', undefined, { ...limits, maxConnections: 0 })
    await expect(webserverFiber(denied)?.await()).rejects.toThrow()
    expect(denied.get('webServer')?.port).toBeUndefined()
  })

  for (const secure of [false, true]) {
    const protocol = secure ? 'HTTPS' : 'HTTP'
    const selected = { ...limits, highWaterMark: secure ? getDefaultHighWaterMark(false) : limits.highWaterMark }
    it(`${protocol} retains duplicate raw headers beyond Node's default and the original body/URL with selected watermarks`, async () => {
      const { context, ca } = await compose(secure, selected)
      const observed = Promise.withResolvers<Buffer>()
      let capture: { url: string | undefined; headers: string[]; flowing: boolean | null; watermarks: number[] } | undefined
      context.webServer.register({ kind: 'exact', path: '/wire', handler: (req, res) => {
        capture = { url: req.url, headers: req.rawHeaders, flowing: req.readableFlowing,
          watermarks: [req.readableHighWaterMark, res.writableHighWaterMark,
            req.socket.readableHighWaterMark, req.socket.writableHighWaterMark] }
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        req.on('end', () => { observed.resolve(Buffer.concat(chunks)); res.end('accepted') })
      } })
      const head = 'POST /wire?value=%2f HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\nContent-Length: 3\r\n'
        + Array.from({ length: 1497 }, (_, i) => `X-Pad: ${String(i)}\r\n`).join('') + '\r\n'
      const body = Buffer.from([0, 255, 3])
      expect((await exchange(context, Buffer.concat([Buffer.from(head), body]), ca)).toString()).toContain('200 OK')
      expect(await observed.promise).toEqual(body)
      expect(capture?.url).toBe('/wire?value=%2f')
      expect(capture?.headers.filter((_, i) => i % 2 === 0)).toHaveLength(1500)
      expect(capture?.headers.at(-1)).toBe('1496')
      expect(capture?.flowing).toBeNull()
      expect(capture?.watermarks).toEqual(Array<number>(4).fill(selected.highWaterMark))
    })

    it(`${protocol} captures one excess header pair so the route rejects every oversized count`, async () => {
      const { context, ca } = await compose(secure, selected)
      let captured = 0
      context.webServer.register({ kind: 'exact', path: '/wire', handler: (req, res) => {
        captured = req.rawHeaders.length / 2
        // The route owns pair admission; an excess sentinel must survive the native parser.
        res.writeHead(captured > limits.maxHeaderPairs ? 431 : 200)
        res.end()
      } })
      const input = 'GET /wire HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n'
        + Array.from({ length: 1700 }, () => 'X-Pad: x\r\n').join('') + '\r\n'
      expect((await exchange(context, input, ca)).toString()).toContain('431 Request Header Fields Too Large')
      expect(captured).toBe(limits.maxHeaderPairs + 1)
    })

    it(`${protocol} rejects oversized header bytes in the original parser before route dispatch`, async () => {
      const { context, ca } = await compose(secure, { ...selected, maxHeaderBytes: 256 })
      const handler = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end() })
      context.webServer.register({ kind: 'exact', path: '/wire', handler })
      const result = await exchange(context,
        'GET /wire HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\nX-Pad: ' + 'x'.repeat(1024) + '\r\n\r\n', ca)
      expect(result.toString()).toContain('431 Request Header Fields Too Large')
      expect(handler).not.toHaveBeenCalled()
    })

    it(`${protocol} rejects Expect before automatic 100 or ordinary/upgrade route dispatch`, async () => {
      const { context, ca } = await compose(secure, selected)
      const handler = vi.fn((_req: IncomingMessage, res: ServerResponse) => { res.end() }), upgraded = vi.fn()
      context.webServer.register({ kind: 'exact', path: '/wire', handler })
      context.webServer.registerUpgrade({ path: '/wire', handler: upgraded })
      for (const value of ['100-continue', 'custom-expectation']) {
        const result = (await exchange(context,
          `POST /wire HTTP/1.1\r\nHost: public.example\r\nExpect: ${value}\r\nContent-Length: 9\r\n\r\n`, ca)).toString()
        expect(result).toContain('417 Expectation Failed')
        expect(result).not.toContain('100 Continue')
      }
      expect((await exchange(context,
        'GET /wire HTTP/1.1\r\nHost: public.example\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\nExpect: 100-continue\r\n\r\n', ca)).length).toBe(0)
      expect(handler).not.toHaveBeenCalled()
      expect(upgraded).not.toHaveBeenCalled()
    })

    it(`${protocol} preserves original upgrade head/bytes and a delayed reply after client half-close`, async () => {
      const { context, ca } = await compose(secure, selected)
      const received = Promise.withResolvers<Buffer>(), replied = Promise.withResolvers<undefined>()
      const initial = Buffer.from([0, 255, 1]), tail = Buffer.from([128, 4, 0]), answer = Buffer.from([255, 0, 127])
      context.webServer.registerUpgrade({ path: '/wire', handler: (req, socket, head) => {
        expect(req.url).toBe('/wire?raw=%2f')
        expect(req.readableFlowing).toBeNull()
        const chunks: Buffer[] = [head]
        socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        socket.on('end', () => { received.resolve(Buffer.concat(chunks)); socket.end(answer) })
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      } })
      const client = await open(context, ca), chunks: Buffer[] = []
      client.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        if (Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) replied.resolve(undefined)
      })
      client.write(Buffer.concat([Buffer.from('GET /wire?raw=%2f HTTP/1.1\r\nHost: public.example\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n'), initial]))
      await replied.promise
      client.end(tail)
      await clients.get(client)
      expect(await received.promise).toEqual(Buffer.concat([initial, tail]))
      expect(Buffer.concat(chunks).subarray(-answer.length)).toEqual(answer)
    })
  }

  it('rejects a TLS watermark unequal to the public native default before listening', async () => {
    const fixture = await tlsFixture()
    const denied = await loadComposition(0, false, '127.0.0.1',
      { certFile: fixture.certFile, keyFile: fixture.keyFile },
      { ...limits, highWaterMark: getDefaultHighWaterMark(false) + 1 })
    await expect(webserverFiber(denied)?.await()).rejects.toThrow('must equal getDefaultHighWaterMark(false)')
    expect(denied.get('webServer')?.port).toBeUndefined()
  })

  it.each([false, true])('limits connections and joins actual cancellation/disposal (TLS=%s)', async (secure) => {
    const { context, ca } = await compose(secure, { ...limits, maxConnections: 1,
      highWaterMark: secure ? getDefaultHighWaterMark(false) : limits.highWaterMark })
    const entered = Promise.withResolvers<undefined>(), serverClosed = Promise.withResolvers<undefined>()
    context.webServer.register({ kind: 'exact', path: '/held', handler: (req) => {
      req.socket.once('close', () => { serverClosed.resolve(undefined) })
      entered.resolve(undefined)
    } })
    context.webServer.register({ kind: 'exact', path: '/probe', handler: (_req, res) => { res.end('open') } })
    const first = await open(context, ca)
    first.write('GET /held HTTP/1.1\r\nHost: public.example\r\n\r\n')
    await entered.promise
    const second = await open(context)
    await clients.get(second)
    first.destroy()
    await serverClosed.promise
    expect((await exchange(context, 'GET /probe HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n', ca)).toString()).toContain('open')
    const upgradedClosed = Promise.withResolvers<undefined>()
    context.webServer.registerUpgrade({ path: '/held', handler: (_req, socket) => {
      socket.once('close', () => { upgradedClosed.resolve(undefined) })
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
    } })
    const upgraded = ca === undefined ? await upgrade(context.webServer.port, '/held')
      : (await tlsUpgrade(context.webServer.port, '/held', ca)).socket
    const closed = once(upgraded, 'close')
    await context.fiber.dispose()
    await closed
    await upgradedClosed.promise
    expect(upgraded.destroyed).toBe(true)
  })

  it.each([undefined, null])('retains automatic 100 Continue for omitted/null limits (%s)', async (value) => {
    const context = await loadComposition(0, false, '127.0.0.1', undefined, value)
    context.webServer.register({ kind: 'exact', path: '/wire', handler: (req, res) => {
      req.resume(); req.on('end', () => { res.end('default') })
    } })
    const result = (await exchange(context,
      'POST /wire HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\nExpect: 100-continue\r\nContent-Length: 1\r\n\r\nx')).toString()
    expect(result).toContain('100 Continue')
    expect(result).toContain('default')
  })
})

describe('optional client CA on the original HTTPS listener', () => {
  it('keeps public requests anonymous and exposes the real trusted or foreign TLS peer', async () => {
    const server = await tlsFixture(), clients = await materializeClientTlsFixture(dirname(server.certFile))
    const loaded = await loadComposition(0, false, '127.0.0.1', { certFile: server.certFile, keyFile: server.keyFile,
      clientCa: { certFile: clients.caFile, maxBytes: Buffer.byteLength(clients.ca) } },
    { maxHeaderPairs: 128, maxHeaderBytes: 32768, highWaterMark: getDefaultHighWaterMark(false), maxConnections: 4 })
    loaded.webServer.register({ kind: 'exact', path: '/peer', handler: (req, res) => {
      if (!(req.socket instanceof TLSSocket)) throw new Error('Expected the original TLS socket')
      const peer = req.socket.getPeerCertificate()
      res.end(JSON.stringify({ authorized: req.socket.authorized, raw: peer.raw?.toString('base64') ?? null }))
    } })
    const observe = async (credentials?: { cert: string; key: string }, headers?: Record<string, string>) => {
      const result = await tlsRequest(loaded.webServer.port, '/peer', server.ca, false, credentials, headers)
      expect(result.status).toBe(200)
      return JSON.parse(result.body) as { authorized: boolean; raw: string | null }
    }
    expect(await observe()).toEqual({ authorized: false, raw: null })
    expect(await observe(undefined, { 'x-forwarded-client-cert': 'trusted-client' })).toEqual({ authorized: false, raw: null })
    expect(await observe(clients.client)).toEqual({ authorized: true,
      raw: new X509Certificate(clients.client.cert).raw.toString('base64') })
    expect(await observe(clients.foreign)).toEqual({ authorized: false,
      raw: new X509Certificate(clients.foreign.cert).raw.toString('base64') })
    expect(clientCaReadGate.handles.at(-1)?.fd).toBe(-1)
  })

  it('does not request a client certificate when the CA option is omitted', async () => {
    const server = await tlsFixture(), clients = await materializeClientTlsFixture(dirname(server.certFile))
    const loaded = await loadComposition(0, false, '127.0.0.1', { certFile: server.certFile, keyFile: server.keyFile })
    loaded.webServer.register({ kind: 'exact', path: '/peer', handler: (req, res) => {
      if (!(req.socket instanceof TLSSocket)) throw new Error('Expected the original TLS socket')
      res.end(JSON.stringify({ authorized: req.socket.authorized, raw: req.socket.getPeerCertificate().raw ?? null }))
    } })
    const result = await tlsRequest(loaded.webServer.port, '/peer', server.ca, false, clients.client)
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ authorized: false, raw: null })
  })

  it('rejects incomplete or nonfinite CA read budgets at the configuration parser', () => {
    for (const clientCa of [{}, { certFile: 'client-ca.pem' }, ...[0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]
      .map(maxBytes => ({ certFile: 'client-ca.pem', maxBytes }))]) {
      expect(() => { Reflect.apply(HttpServer.Config, undefined,
        [{ host: '127.0.0.1', port: 0, tls: { certFile: 'cert.pem', keyFile: 'key.pem', clientCa } }]) }).toThrow()
    }
  })

  it('rejects missing, empty, oversized or unparseable CA material before listen and closes each read handle', async () => {
    const server = await tlsFixture(), clients = await materializeClientTlsFixture(dirname(server.certFile))
    const holder = createTcpServer(), listening = once(holder, 'listening')
    holder.listen(0, '127.0.0.1')
    await listening
    const port = (holder.address() as AddressInfo).port
    const directoryCa = join(dirname(server.certFile), 'directory-client-ca.pem')
    await mkdir(directoryCa)
    const cases = [
      { content: '', maxBytes: 65536, reason: /is empty/ },
      { content: 'not a certificate', maxBytes: 65536, reason: /not a usable CA certificate bundle/ },
      { content: clients.ca + '\nnot PEM', maxBytes: 65536, reason: /not a usable CA certificate bundle/ },
      { content: server.ca, maxBytes: 65536, reason: /not a usable CA certificate bundle/ },
      { content: clients.ca, maxBytes: Buffer.byteLength(clients.ca) - 1, reason: /configured byte limit/ },
      { content: clients.ca, maxBytes: 65536, reason: /cannot read tls\.clientCa\.certFile/, missing: true },
      { content: clients.ca, maxBytes: 65536, reason: /cannot read tls\.clientCa\.certFile/, directory: true },
    ]
    try {
      for (const row of cases) {
        await writeFile(clients.caFile, row.content)
        const count = clientCaReadGate.handles.length
        const denied = await loadComposition(port, false, '127.0.0.1', { certFile: server.certFile, keyFile: server.keyFile,
          clientCa: { certFile: row.directory ? directoryCa : row.missing ? clients.caFile + '.absent' : clients.caFile,
            maxBytes: row.maxBytes } })
        const fiber = webserverFiber(denied)
        if (fiber === undefined) throw new Error('CA-denied webserver row is missing')
        const failure = await fiber.await().then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error))
        expect(failure).toMatch(row.reason)
        expect(failure).not.toMatch(/EADDRINUSE|BEGIN CERTIFICATE|PRIVATE KEY/)
        expect(denied.get('webServer')?.port).toBeUndefined()
        expect(clientCaReadGate.handles.slice(count).every(handle => handle.fd === -1)).toBe(true)
      }
    } finally {
      const closed = once(holder, 'close')
      holder.close()
      await closed
    }
  })

  it('joins a pending CA open/read and closes its actual file handle before disposal settles', async () => {
    const server = await tlsFixture(), clients = await materializeClientTlsFixture(dirname(server.certFile))
    const gate = clientCaReadGate.arm()
    const loading = loadComposition(0, false, '127.0.0.1', { certFile: server.certFile, keyFile: server.keyFile,
      clientCa: { certFile: clients.caFile, maxBytes: 65536 } })
    try {
      const handle = await gate.entered
      expect(handle.fd).toBeGreaterThanOrEqual(0)
      const composed = compositions.at(-1)
      if (composed === undefined) throw new Error('CA-loading composition is missing')
      const originalServer = composed.context.webServer
      const disposal = composed.context.fiber.dispose()
      gate.release()
      await disposal
      await loading
      expect(handle.fd).toBe(-1)
      await expect(tlsRequest(originalServer.port, '/', server.ca)).rejects.toThrow()
    } finally { gate.release() }
  })
})
