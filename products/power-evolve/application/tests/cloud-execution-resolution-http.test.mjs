/** Real dsh Host/Platform profiles and isolated PostgreSQL; executors are intentionally disabled and no browser trial is claimed. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import yaml from 'js-yaml'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const product = join(root, 'products/power-evolve')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('actual product ingress keeps Cloud reconciliation read-only and requires independent approval Origin/audience', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-resolution-http-'))
  const database = `pe_resolution_http_${randomBytes(8).toString('hex')}`
  const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const children = []
  let pool, created = false
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000)
      try { await exited } finally { clearTimeout(deadline) }
    }
    await pool?.end()
    if (created) await admin.query(`DROP DATABASE "${database}"`)
    await admin.end()
    await rm(temporary, { recursive: true, force: true })
  })
  await admin.query(`CREATE DATABASE "${database}"`); created = true
  const connection = new URL(databaseUrl); connection.pathname = `/${database}`
  pool = new Pool({ connectionString: connection.href, max: 1 })
  const usernames = ['alice-http', 'bob-http'], password = randomBytes(24).toString('base64url')
  const users = usernames.map(username => ({ username, password,
    settings: { model: 'deepseek-flash', maxTokens: 1024, revision: 1 },
    models: [{ id: 'deepseek-flash', label: 'Fixture', maxTokens: 4096 }] }))
  for (const [name, value] of Object.entries({ 'database-url': connection.href, 'worker-token': randomBytes(32).toString('base64url'),
    'model-key': randomBytes(32).toString('base64url'), 'connector-key': randomBytes(32).toString('base64url'), 'users.json': JSON.stringify(users) })) {
    await writeFile(join(temporary, name), value, { mode: 0o600 })
  }
  const hostPort = await freePort(), platformPort = await freePort()
  const hostOrigin = `http://127.0.0.1:${hostPort}`, platformOrigin = `http://127.0.0.1:${platformPort}`
  async function launch(name) {
    const home = join(temporary, name), profileName = `resolution-${name}`, profile = join(home, 'profiles', profileName)
    await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
    await symlink(join(product, name), join(profile, 'node_modules/@power-evolve', name), 'dir')
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [`@power-evolve/${name}`] } } }))
    const bundle = yaml.load(await readFile(join(product, name, 'cordis.patch.yml'), 'utf8'), { schema: manifestSchema })
    const rows = bundle[0].insert, readyFile = join(home, 'ready.json')
    const update = (id, fields) => ({ id, config: { ...rows.find(row => row.id === id).config, ...fields } })
    const patch = [update('web-server', { port: name === 'host' ? hostPort : platformPort })]
    if (name === 'platform') patch.push(update('power-evolve-platform', {
      readyFile, databaseUrlFile: join(temporary, 'database-url'), seedUsersFile: join(temporary, 'users.json'),
      workerTokenFile: join(temporary, 'worker-token'), modelKeyFile: join(temporary, 'model-key'), connectorKeyFile: join(temporary, 'connector-key'),
      workspaceRoot: join(temporary, 'workspaces'), artifactRoot: join(temporary, 'artifacts'), skillLibraryRoot: join(temporary, 'skills'),
      sandboxKeyFile: '', sandboxKubeconfigFile: '', sandboxNamespace: '', sandboxImage: '', preinstalledSkills: [],
      accountManagementFile: '', accountBootstrapFile: '', hostOrigin, platformOrigin, connectorUrl: 'http://127.0.0.1:1',
    }))
    else patch.push(update('power-evolve-runtime', { platformUrl: platformOrigin, workerTokenFile: join(temporary, 'worker-token') }),
      update('power-evolve-host', { readyFile, origin: hostOrigin, platformOrigin }))
    await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
    const child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', profileName], {
      cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, PE_PRIVATE_DIR: temporary },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let diagnostic = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4000) })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned ${name} exited: ${diagnostic}`)
      try { const ready = JSON.parse(await readFile(readyFile, 'utf8')); if (ready.pid === child.pid) return }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await delay(25)
    }
    throw new Error(`Owned ${name} startup deadline: ${diagnostic}`)
  }
  await launch('platform'); await launch('host')
  const post = (origin, path, token, input, browserOrigin) => fetch(origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(browserOrigin === undefined ? {} : { origin: browserOrigin }) }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
  })
  for (const username of usernames) {
    const login = await post(platformOrigin, '/identity/login', null, { username, password }, platformOrigin)
    assert.equal(login.status, 200)
    const agent = (await login.json()).token
    const approvalLogin = await post(platformOrigin, '/identity/approval-login', null, { username, password }, platformOrigin)
    assert.equal(approvalLogin.status, 200)
    const approval = (await approvalLogin.json()).token
    const listing = await post(hostOrigin, '/api/powerEvolve/executionResolutionsList', agent, { request: {} })
    assert.equal(listing.status, 200); assert.deepEqual(await listing.json(), { available: false, items: [] })
    assert.equal((await post(hostOrigin, '/api/powerEvolve/executionResolutionResolve', agent, { request: {} })).status, 400)
    assert.equal((await post(hostOrigin, '/api/powerEvolve/executionResolutionsList', approval, { request: {} })).status, 401)
    const request = { requestId: randomUUID(), executionId: randomUUID(), target: 'cloud', fingerprint: 'a'.repeat(64), note: '' }
    for (const value of [undefined, hostOrigin]) assert.equal((await post(platformOrigin, '/approvals/executions/resolve',
      approval, request, value)).status, 403)
    assert.equal((await post(platformOrigin, '/approvals/executions/resolve', agent, request, platformOrigin)).status, 401)
    assert.equal((await post(platformOrigin, '/approvals/executions/resolve', approval, request, platformOrigin)).status, 503)
    const valid = await post(platformOrigin, '/approvals/executions/list', approval, {}, platformOrigin)
    assert.equal(valid.status, 200); assert.deepEqual(await valid.json(), { available: false, items: [] })
  }
  assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 28)
  assert.equal((await pool.query('SELECT count(*) FROM pe_cloud_execution_resolutions')).rows[0].count, '0')
  assert.equal((await pool.query('SELECT count(*) FROM pe_sandbox_instances')).rows[0].count, '0')
})
