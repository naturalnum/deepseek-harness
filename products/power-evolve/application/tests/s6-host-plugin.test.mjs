/** S6 product RPC admission through the real DSH Host profile and a bounded Platform fixture. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import yaml from 'js-yaml'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const product = join(root, 'products/power-evolve')
const require = createRequire(new URL('../package.json', import.meta.url))
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function ready(file, child) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('DSH Host exited before ready')
    try { return JSON.parse(await readFile(file, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    await delay(50)
  }
  throw new Error('DSH Host did not become ready')
}

test('native Host plugin RPC forwards only authenticated, strict user-scoped fields', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pe-s6-host-plugin-'))
  let host
  let platform
  let publicPlatform
  let proxy
  t.after(async () => {
    if (host && host.exitCode === null && host.signalCode === null) {
      const exited = once(host, 'exit')
      host.kill('SIGTERM')
      const deadline = setTimeout(() => host.kill('SIGKILL'), 8_000)
      try { await exited } finally { clearTimeout(deadline) }
    }
    if (platform) {
      platform.closeAllConnections()
      await new Promise(resolve => platform.close(resolve))
    }
    if (publicPlatform) {
      publicPlatform.closeAllConnections()
      await new Promise(resolve => publicPlatform.close(resolve))
    }
    if (proxy) {
      proxy.closeAllConnections()
      await new Promise(resolve => proxy.close(resolve))
    }
    await rm(directory, { recursive: true, force: true })
  })

  const users = ['alice', 'bob'].map(username => ({ userId: randomUUID(), username,
    token: randomBytes(32).toString('base64url') }))
  const mcpIds = new Map(users.map(user => [user.token, randomUUID()]))
  const loginToken = randomBytes(32).toString('base64url')
  const issuedLoginTokens = new Set([loginToken])
  const artifactId = randomUUID(), redirectArtifactId = randomUUID()
  const artifactBytes = Buffer.from('internal artifact bytes')
  const sessionId = randomUUID()
  let revoked = false
  const calls = []
  platform = createServer(async (request, response) => {
    const answer = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      const token = request.headers.authorization?.replace(/^Bearer /, '')
      if (request.method === 'GET' && path === `/artifacts/${redirectArtifactId}/content`) {
        response.writeHead(302, { location: `${platformOrigin}/artifacts/${artifactId}/content` })
        response.end()
        return
      }
      if (request.method === 'GET' && path === `/artifacts/${artifactId}/content`) {
        calls.push({ path, token })
        if (token !== users[0].token || revoked) { answer(404, { error: 'artifact_not_found' }); return }
        response.writeHead(200, { 'content-type': 'application/octet-stream',
          'content-length': String(artifactBytes.length), 'content-disposition': 'attachment; filename="fixture.txt"' })
        response.end(artifactBytes)
        return
      }
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
      if (path === '/runtime/claim') { answer(token === workerToken ? 200 : 401, null); return }
      if (path === '/identity/login') {
        const issued = randomBytes(32).toString('base64url')
        issuedLoginTokens.add(issued)
        answer(200, { token: issued }); return
      }
      if (path === '/identity/exchange') {
        const accepted = issuedLoginTokens.delete(token)
        answer(accepted ? 200 : 401, accepted ? { token: users[0].token } : { error: 'unauthorized' })
        return
      }
      const user = revoked ? undefined : users.find(item => item.token === token)
      if (!user) { answer(401, { error: 'unauthorized' }); return }
      if (path === '/identity/logout') { revoked = true; answer(200, { ok: true }); return }
      if (path === '/identity/me') {
        answer(200, { userId: user.userId, username: user.username,
          settings: { model: 'fixture', maxTokens: 32, revision: 1 } })
        return
      }
      if (path === '/native/sessions/list') {
        calls.push({ path, token, body })
        answer(200, { items: user.username === 'alice' ? [{ sessionId, updatedAt: 1,
          agentAvailable: true, running: false, blank: false }] : [] }); return
      }
      if (path === '/native/sessions/snapshot') {
        calls.push({ path, token, body })
        answer(body.address?.sessionId === sessionId && user.username === 'alice' ? 200 : 404,
          body.address?.sessionId === sessionId && user.username === 'alice'
            ? { cursor: -1, records: [] } : { error: 'session_not_found' }); return
      }
      if (path === '/native/sessions/after') {
        calls.push({ path, token, body })
        answer(200, { events: [] }); return
      }
      if (path === '/plugins/list' || path === '/plugins/notes/set-enabled') {
        calls.push({ path, token, body })
        answer(200, path === '/plugins/list'
          ? { items: [{ id: 'notes', title: '受控便签', category: 'tools', kind: 'builtin',
            enabled: user.username === 'alice', revision: 1, requiresApproval: true }] }
          : { id: 'notes', title: '受控便签', category: 'tools', kind: 'builtin',
            enabled: body.enabled, revision: 2, requiresApproval: true })
        return
      }
      if (path.startsWith('/mcp/')) {
        calls.push({ path, token, body })
        if ((path === '/mcp/check' || path === '/mcp/toggle') && body.connectionId !== mcpIds.get(token)) {
          answer(404, { error: 'mcp_connection_not_found' }); return
        }
        if (path === '/mcp/list') {
          answer(200, { available: true, items: [{ connectionId: mcpIds.get(token),
            name: `${user.username} MCP`, enabled: true, revision: 1,
            toolName: 'mcp__personal__whoami', description: 'Read account identity' }] }); return
        }
        if (path === '/mcp/install') {
          answer(200, { connectionId: body.requestId, name: body.name, enabled: true,
            revision: 1, toolName: 'mcp__personal__whoami', description: 'Read account identity' }); return
        }
        if (path === '/mcp/toggle') {
          answer(200, { connectionId: body.connectionId, name: `${user.username} MCP`,
            enabled: body.enabled, revision: body.baseRevision + 1,
            toolName: 'mcp__personal__whoami', description: 'Read account identity' }); return
        }
        if (path === '/mcp/check') {
          answer(200, { toolName: 'mcp__personal__whoami', result: `user:${user.userId}` }); return
        }
      }
      answer(404, { error: 'not_found' })
    } catch (_error) { answer(500, { error: 'fixture_error' }) }
  })
  const platformInternalUrl = await listen(platform)
  const publicRequests = []
  publicPlatform = createServer((request, response) => {
    publicRequests.push({ method: request.method, path: request.url })
    const upstream = httpRequest(new URL(request.url, platformInternalUrl), {
      method: request.method, headers: request.headers,
    }, fromPlatform => {
      response.writeHead(fromPlatform.statusCode, fromPlatform.headers)
      fromPlatform.pipe(response)
    })
    upstream.on('error', () => response.destroy())
    request.pipe(upstream)
  })
  const platformOrigin = await listen(publicPlatform)
  const workerToken = randomBytes(32).toString('base64url')
  await writeFile(join(directory, 'worker-token'), workerToken, { mode: 0o600 })

  let hostTarget
  proxy = createServer((request, response) => {
    if (!hostTarget) { response.writeHead(503).end(); return }
    const upstream = httpRequest(new URL(request.url, hostTarget), {
      method: request.method, headers: request.headers,
    }, fromHost => {
      response.writeHead(fromHost.statusCode, fromHost.headers)
      fromHost.pipe(response)
    })
    upstream.on('error', () => response.destroy())
    request.pipe(upstream)
  })
  const hostOrigin = await listen(proxy)
  const home = join(directory, 'home')
  const profile = join(home, 'profiles', 'pe-s6-host-test')
  await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
  await symlink(join(product, 'host'), join(profile, 'node_modules/@power-evolve/host'), 'dir')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
    dsh: { profile: { bundles: ['@power-evolve/host'] } } }))
  const bundle = yaml.load(await readFile(join(product, 'host/cordis.patch.yml'), 'utf8'), { schema: manifestSchema })
  const rows = bundle[0].insert
  const update = (id, values) => ({ id, config: { ...rows.find(row => row.id === id).config, ...values } })
  const readyFile = join(home, 'ready.json')
  await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump([
    update('web-server', { port: 0 }),
    update('power-evolve-runtime', { platformUrl: platformInternalUrl, workerTokenFile: join(directory, 'worker-token') }),
    update('power-evolve-host', { origin: hostOrigin, platformOrigin, readyFile, pollMs: 50 }),
  ]))
  const logPath = join(directory, 'host.log')
  const log = openSync(logPath, 'a', 0o600)
  host = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'pe-s6-host-test'], {
    cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, PE_PRIVATE_DIR: directory },
    stdio: ['ignore', log, log],
  })
  closeSync(log)
  try { hostTarget = (await ready(readyFile, host)).url }
  catch (error) { throw new Error(`${error.message}\n${await readFile(logPath, 'utf8')}`) }

  const rpc = (method, token, request, headers = {}) => fetch(`${hostOrigin}/api/powerEvolve/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ request }),
  })
  assert.equal((await rpc('pluginsList', null, {}, { origin: hostOrigin })).status, 401)
  assert.equal(calls.length, 0)
  const aliceList = await rpc('pluginsList', users[0].token, {})
  assert.equal(aliceList.status, 200)
  assert.equal((await aliceList.json()).items[0].enabled, true)
  const bobList = await rpc('pluginsList', users[1].token, {})
  assert.equal(bobList.status, 200)
  assert.equal((await bobList.json()).items[0].enabled, false)
  assert.deepEqual(calls.map(call => [call.path, call.token, call.body]), [
    ['/plugins/list', users[0].token, {}], ['/plugins/list', users[1].token, {}],
  ])

  const mutation = { requestId: randomUUID(), expectedRevision: 1, enabled: false }
  assert.equal((await rpc('pluginsNotesSetEnabled', users[0].token, { ...mutation, userId: users[1].userId })).status, 400)
  assert.equal((await rpc('pluginsNotesSetEnabled', users[0].token, { ...mutation, credential: 'secret' })).status, 400)
  assert.equal((await rpc('pluginsNotesSetEnabled', users[0].token, { ...mutation, expectedRevision: 0 })).status, 400)
  assert.equal((await rpc('pluginsList', users[0].token, { userId: users[1].userId })).status, 400)
  assert.equal(calls.length, 2, 'invalid requests never reach the Platform')
  const changed = await rpc('pluginsNotesSetEnabled', users[0].token, mutation)
  assert.equal(changed.status, 200)
  assert.equal((await changed.json()).enabled, false)
  assert.deepEqual(calls[2], { path: '/plugins/notes/set-enabled', token: users[0].token, body: mutation })
  assert.equal((await rpc('pluginsNotesSetEnabled', users[0].token, mutation,
    { origin: 'https://attacker.example' })).status, 403)
  assert.equal(calls.length, 3)

  const exchanged = await fetch(`${hostOrigin}/auth/exchange`, { method: 'POST',
    headers: { origin: platformOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: loginToken }) })
  assert.equal(exchanged.status, 200)
  const cookie = exchanged.headers.getSetCookie().find(value => value.includes('Path=/api/powerEvolve')).split(';')[0]
  const cookieRpc = (origin, method = 'pluginsList', request = {}) =>
    rpc(method, null, request, { cookie, ...(origin ? { origin } : {}) })
  assert.equal((await cookieRpc(undefined)).status, 403)
  assert.equal((await cookieRpc('https://attacker.example')).status, 403)
  assert.equal((await cookieRpc(hostOrigin)).status, 200)
  assert.equal(calls.length, 4, 'only the same-origin cookie request reaches the Platform')
  assert.equal((await cookieRpc('https://attacker.example', 'pluginsNotesSetEnabled', mutation)).status, 403)
  assert.equal((await cookieRpc(hostOrigin, 'pluginsNotesSetEnabled', mutation)).status, 200)
  assert.deepEqual(calls[4], { path: '/plugins/notes/set-enabled', token: users[0].token, body: mutation })

  const mcpListAlice = await rpc('mcpList', users[0].token, {})
  const mcpListBob = await rpc('mcpList', users[1].token, {})
  assert.equal((await mcpListAlice.json()).items[0].connectionId, mcpIds.get(users[0].token))
  assert.equal((await mcpListBob.json()).items[0].connectionId, mcpIds.get(users[1].token))
  const mcpInstall = { requestId: randomUUID(), name: 'Personal read-only MCP' }
  assert.equal((await rpc('mcpInstall', users[0].token, { ...mcpInstall, url: 'https://attacker.example' })).status, 400)
  assert.equal((await rpc('mcpInstall', users[0].token, { ...mcpInstall, token: 'secret' })).status, 400)
  assert.equal((await rpc('mcpInstall', users[0].token, mcpInstall)).status, 200)
  const mcpToggle = { connectionId: mcpIds.get(users[0].token), requestId: randomUUID(),
    baseRevision: 1, enabled: false }
  assert.equal((await rpc('mcpToggle', users[0].token, { ...mcpToggle, baseRevision: 0 })).status, 400)
  assert.equal((await rpc('mcpToggle', users[0].token, mcpToggle)).status, 200)
  assert.equal((await rpc('mcpToggle', users[1].token, mcpToggle)).status, 404)
  assert.equal((await rpc('mcpCheck', users[1].token,
    { connectionId: mcpIds.get(users[0].token) })).status, 404)
  assert.equal((await rpc('mcpCheck', users[0].token,
    { connectionId: mcpIds.get(users[0].token), toolName: 'write' })).status, 400)
  const mcpCheck = await rpc('mcpCheck', users[0].token, { connectionId: mcpIds.get(users[0].token) })
  assert.deepEqual(await mcpCheck.json(), { toolName: 'mcp__personal__whoami', result: `user:${users[0].userId}` })
  assert.equal((await cookieRpc('https://attacker.example', 'mcpToggle', mcpToggle)).status, 403)
  assert.equal((await cookieRpc(hostOrigin, 'mcpToggle', mcpToggle)).status, 200)
  assert.deepEqual(calls.filter(call => call.path.startsWith('/mcp/')).map(call => call.body), [
    {}, {}, mcpInstall, mcpToggle, mcpToggle, { connectionId: mcpIds.get(users[0].token) },
    { connectionId: mcpIds.get(users[0].token) }, mcpToggle,
  ])

  assert.equal(publicRequests.length, 0, 'Host RPC used only the internal Platform URL')
  const config = await (await fetch(`${hostOrigin}/config`)).json()
  assert.equal(config.loginUrl, `${platformOrigin}/login`)
  assert.equal(config.approvalUrl, `${platformOrigin}/approval`)
  const nativePage = await fetch(`${hostOrigin}/native/`)
  assert(nativePage.headers.get('content-security-policy').includes(`connect-src 'self' ${platformOrigin}`))
  const browserLogin = await fetch(`${platformOrigin}/identity/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(browserLogin.status, 200)
  const browserToken = (await browserLogin.json()).token
  assert.deepEqual(publicRequests, [{ method: 'POST', path: '/identity/login' }])
  const browserExchange = await fetch(`${hostOrigin}/auth/exchange`, { method: 'POST',
    headers: { origin: platformOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: browserToken }) })
  assert.equal(browserExchange.status, 200)
  assert.equal(browserExchange.headers.get('access-control-allow-origin'), platformOrigin)
  const productCookie = browserExchange.headers.getSetCookie()
    .find(value => value.includes('Path=/api/powerEvolve')).split(';')[0]
  const nativeCookie = browserExchange.headers.getSetCookie()
    .find(value => value.includes('Path=/native/api')).split(';')[0]
  const nativeRequest = (cookie, rpcId = randomUUID()) => fetch(`${hostOrigin}/native/api/session/list`, {
    method: 'POST', headers: { origin: hostOrigin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/list',
      payload: { args: { _request: {} } } }),
  })
  const ownSessions = await nativeRequest(nativeCookie)
  assert.equal(ownSessions.status, 200)
  assert.deepEqual((await ownSessions.json()).result.value.items.map(item => item.sessionId), [sessionId])
  const foreignSessions = await fetch(`${hostOrigin}/native/api/session/list`, { method: 'POST',
    headers: { origin: hostOrigin, authorization: `Bearer ${users[1].token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/list',
      payload: { args: { _request: {} } } }),
  })
  assert.deepEqual((await foreignSessions.json()).result.value.items, [])
  const WebSocket = createRequire(require.resolve('@deepseek-ai/dsh-api-gateway/package.json'))('ws')
  const socket = new WebSocket(`${hostTarget.replace('http:', 'ws:')}/native/api/remote.mux`, {
    headers: { host: new URL(hostOrigin).host, origin: hostOrigin, cookie: nativeCookie },
  })
  await once(socket, 'open')
  try {
    const streamId = randomUUID()
    const first = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Native follow stream timed out')) }, 5000)
      const onMessage = raw => {
        const frame = JSON.parse(raw.toString())
        if (frame.streamId !== streamId) return
        cleanup(); resolve(frame)
      }
      const cleanup = () => { clearTimeout(timeout); socket.off('message', onMessage) }
      socket.on('message', onMessage)
    })
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId } } } } }))
    const frame = await first
    assert.equal(frame.type, 'item')
    assert.equal(frame.value.cursor, -1)
  } finally { socket.close(); await once(socket, 'close') }
  const download = await fetch(`${hostOrigin}/api/powerEvolve/artifacts/${artifactId}/content`, {
    headers: { origin: hostOrigin, cookie: productCookie },
  })
  assert.equal(download.status, 200)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), artifactBytes)
  assert(calls.some(call => call.path === `/artifacts/${artifactId}/content` && call.token === users[0].token))
  const foreignDownload = await fetch(`${hostOrigin}/api/powerEvolve/artifacts/${artifactId}/content`, {
    headers: { origin: hostOrigin, authorization: `Bearer ${users[1].token}` },
  })
  assert.equal(foreignDownload.status, 404)
  const redirected = await fetch(`${hostOrigin}/api/powerEvolve/artifacts/${redirectArtifactId}/content`, {
    headers: { origin: hostOrigin, cookie: productCookie },
  })
  assert.notEqual(redirected.status, 200)
  assert.deepEqual(publicRequests, [{ method: 'POST', path: '/identity/login' }],
    'Host exchange, native Session and stream, and download never reached the public Platform Origin')
  const browserLogout = await rpc('logout', null, {}, { origin: hostOrigin, cookie: productCookie })
  assert.equal(browserLogout.status, 200)
  assert.equal(browserLogout.headers.getSetCookie().length, 2)
  assert.equal((await nativeRequest(nativeCookie)).status, 401)
  assert.equal((await fetch(`${hostOrigin}/api/powerEvolve/artifacts/${artifactId}/content`, {
    headers: { origin: hostOrigin, cookie: productCookie },
  })).status, 401)
  assert.equal(publicRequests.length, 1, 'logout also used only the internal Platform URL')
})
