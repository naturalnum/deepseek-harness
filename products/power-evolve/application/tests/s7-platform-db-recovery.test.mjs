/** Real PostgreSQL disconnect/recovery must not kill the trusted Platform. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openSync, closeSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import yaml from 'js-yaml'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const product = join(root, 'products/power-evolve')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))
async function eventually(check, label, timeout = 12000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await check()
    if (value) return value
    await delay(50)
  }
  throw new Error(`Timed out: ${label}`)
}

test('Platform stays alive, becomes unready, and resumes only new requests after PG reconnect',
  { timeout: 45000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), 'pe-s7-db-recovery-'))
    const database = `pe_test_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    let created = false, child, databaseClosed = false
    t.after(async () => {
      if (databaseClosed) await admin.query(`ALTER DATABASE "${database}" WITH ALLOW_CONNECTIONS true`)
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
        try { await exited } finally { clearTimeout(timer) }
      }
      if (created) {
        await eventually(async () => Number((await admin.query(
          'SELECT count(*) FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].count) === 0,
        'Platform connections closed')
        await admin.query(`DROP DATABASE "${database}"`)
      }
      await admin.end()
      await rm(temporary, { recursive: true, force: true })
    })
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    const password = randomBytes(24).toString('base64url')
    const users = ['alice', 'bob'].map(username => ({ username, password,
      settings: { model: 'fixture', maxTokens: 128, revision: 1 },
      models: [{ id: 'fixture', label: 'Fixture', maxTokens: 256 }] }))
    for (const [name, value] of Object.entries({
      'database-url': url.href, 'worker-token': randomBytes(32).toString('base64url'),
      'model-key': 'test-model-key', 'connector-key': 'test-connector-key',
      'users.json': JSON.stringify(users),
    })) await writeFile(join(temporary, name), value, { mode: 0o600 })
    const home = join(temporary, 'platform'), profile = join(home, 'profiles', 'power-evolve-platform')
    await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
    await symlink(join(product, 'platform'), join(profile, 'node_modules/@power-evolve/platform'), 'dir')
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
      dsh: { profile: { bundles: ['@power-evolve/platform'] } } }))
    const bundle = yaml.load(await readFile(join(product, 'platform/cordis.patch.yml'), 'utf8'),
      { schema: manifestSchema })
    const rows = bundle[0].insert
    const readyFile = join(home, 'ready.json')
    const patch = rows.filter(row => ['web-server', 'power-evolve-platform'].includes(row.id)).map(row => ({
      id: row.id, config: row.id === 'web-server' ? { ...row.config, port: 0 } : {
        ...row.config, databaseUrlFile: join(temporary, 'database-url'),
        workerTokenFile: join(temporary, 'worker-token'), modelKeyFile: join(temporary, 'model-key'),
        connectorKeyFile: join(temporary, 'connector-key'), seedUsersFile: join(temporary, 'users.json'),
        workspaceRoot: join(temporary, 'workspaces'), artifactRoot: join(temporary, 'artifacts'),
        readyFile, modelUrl: 'http://127.0.0.1:9/model', connectorUrl: 'http://127.0.0.1:9',
        sandboxKubeconfigFile: '', sandboxKeyFile: '', sandboxNamespace: '', sandboxImage: '',
        sandboxLocalRoot: '', sandboxNodeRoot: '', databaseTimeoutMs: 2000,
      },
    }))
    await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
    const logPath = join(temporary, 'platform.log')
    const log = openSync(logPath, 'a', 0o600)
    child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'power-evolve-platform'], {
      cwd: root, env: { ...process.env, DSH_HOME: home, PE_PRIVATE_DIR: temporary },
      stdio: ['ignore', log, log],
    })
    closeSync(log)
    const ready = await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Platform exited during startup: ${await readFile(logPath, 'utf8')}`)
      }
      try { return JSON.parse(await readFile(readyFile, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
    }, 'Platform ready')
    const health = () => fetch(`${ready.url}/health`, { signal: AbortSignal.timeout(1500) })
    assert.equal((await health()).status, 200)
    const idle = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1 AND state=$2',
      [database, 'idle'])
    assert(idle.rows.length > 0)
    await admin.query('SELECT pg_terminate_backend($1)', [idle.rows[0].pid])
    await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Platform died on idle PG disconnect: ${await readFile(logPath, 'utf8')}`)
      }
      return (await readFile(logPath, 'utf8')).includes('Platform PostgreSQL connection lost')
    }, 'visible idle connection loss')
    assert.equal((await health()).status, 200)

    await admin.query(`ALTER DATABASE "${database}" WITH ALLOW_CONNECTIONS false`)
    databaseClosed = true
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [database])
    await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Platform died during PG outage')
      try {
        const response = await health()
        const body = await response.json()
        return response.status === 503 && body.ready === false && body.database === 'unavailable'
      } catch { return false }
    }, 'Platform health unready')
    const denied = await fetch(`${ready.url}/identity/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password }),
      signal: AbortSignal.timeout(3000) })
    assert.equal(denied.status, 503)
    await admin.query(`ALTER DATABASE "${database}" WITH ALLOW_CONNECTIONS true`)
    databaseClosed = false
    await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Platform died before PG recovery')
      try { return (await health()).status === 200 } catch { return false }
    }, 'Platform health recovered')
    const login = await fetch(`${ready.url}/identity/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password }) })
    assert.equal(login.status, 200)
    const check = new Pool({ connectionString: url.href, max: 1 })
    try {
      assert.equal((await check.query('SELECT count(*)::integer AS count FROM pe_credentials')).rows[0].count, 1)
    } finally { await check.end() }
    assert.match(await readFile(logPath, 'utf8'), /Platform PostgreSQL connection recovered/)
  })
