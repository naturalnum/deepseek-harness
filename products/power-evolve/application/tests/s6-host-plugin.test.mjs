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
import { setTimeout as delay } from 'node:timers/promises'
import yaml from 'js-yaml'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const product = join(root, 'products/power-evolve')
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
    if (proxy) {
      proxy.closeAllConnections()
      await new Promise(resolve => proxy.close(resolve))
    }
    await rm(directory, { recursive: true, force: true })
  })

  const users = ['alice', 'bob'].map(username => ({ userId: randomUUID(), username,
    token: randomBytes(32).toString('base64url') }))
  const loginToken = randomBytes(32).toString('base64url')
  const calls = []
  platform = createServer(async (request, response) => {
    const answer = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      const token = request.headers.authorization?.replace(/^Bearer /, '')
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
      if (path === '/runtime/claim') { answer(token === workerToken ? 200 : 401, null); return }
      if (path === '/identity/exchange') {
        answer(token === loginToken ? 200 : 401, token === loginToken ? { token: users[0].token } : { error: 'unauthorized' })
        return
      }
      const user = users.find(item => item.token === token)
      if (!user) { answer(401, { error: 'unauthorized' }); return }
      if (path === '/identity/me') {
        answer(200, { userId: user.userId, username: user.username,
          settings: { model: 'fixture', maxTokens: 32, revision: 1 } })
        return
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
      answer(404, { error: 'not_found' })
    } catch (_error) { answer(500, { error: 'fixture_error' }) }
  })
  const platformOrigin = await listen(platform)
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
    update('power-evolve-runtime', { platformUrl: platformOrigin, workerTokenFile: join(directory, 'worker-token') }),
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
})
