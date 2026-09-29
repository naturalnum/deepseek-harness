/** Global admission under two real Platform processes sharing one PostgreSQL database. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
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
import { ExecutionService } from '../lib/platform/executions.js'
import { LoginAdmission } from '../lib/platform/login-admission.js'

const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const product = join(root, 'products/power-evolve')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))

async function eventually(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(25)
  }
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('two Platform replicas isolate account limits behind one peer and retain global overload state',
  { timeout: 90000 }, async t => {
    const temporary = await mkdtemp(join(tmpdir(), 'pe-s7-admission-'))
    const database = `pe_test_${randomBytes(10).toString('hex')}`
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    const children = new Set()
    let pool, created = false
    const stop = async (child, signal = 'SIGTERM') => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill(signal)
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
      try { await exited } finally { clearTimeout(timer); children.delete(child) }
    }
    t.after(async () => {
      for (const child of children) await stop(child)
      await pool?.end()
      if (created) {
        await eventually(async () => Number((await admin.query(
          'SELECT count(*) FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].count) === 0,
        'Platform database connections closed')
        await admin.query(`DROP DATABASE "${database}"`)
      }
      await admin.end()
      await rm(temporary, { recursive: true, force: true })
    })
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    pool = new Pool({ connectionString: url.href, max: 5 })
    const password = randomBytes(24).toString('base64url')
    const [firstPort, secondPort, lbPort, hostPort] = await Promise.all(
      Array.from({ length: 4 }, () => freePort()))
    assert.equal(new Set([firstPort, secondPort, lbPort, hostPort]).size, 4)
    const origin = `http://127.0.0.1:${lbPort}`
    const users = ['alice', 'bob'].map(username => ({ username, password,
      settings: { model: 'fixture', maxTokens: 128, revision: 1 },
      models: [{ id: 'fixture', label: 'Fixture', maxTokens: 256 }] }))
    for (const [name, value] of Object.entries({
      'database-url': url.href, 'worker-token': randomBytes(32).toString('base64url'),
      'model-key': 'test-model-key', 'connector-key': 'test-connector-key',
      'users.json': JSON.stringify(users),
    })) await writeFile(join(temporary, name), value, { mode: 0o600 })

    async function start(name, limits = {}, listenPort = 0) {
      const home = join(temporary, name), profile = join(home, 'profiles', `power-evolve-${name}`)
      await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
      await symlink(join(product, 'platform'), join(profile, 'node_modules/@power-evolve/platform'), 'dir')
        .catch(error => { if (error.code !== 'EEXIST') throw error })
      await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
        dsh: { profile: { bundles: ['@power-evolve/platform'] } } }))
      const bundle = yaml.load(await readFile(join(product, 'platform/cordis.patch.yml'), 'utf8'),
        { schema: manifestSchema })
      const rows = bundle[0].insert
      const patch = rows.filter(row => ['web-server', 'power-evolve-platform'].includes(row.id)).map(row => ({
        id: row.id, config: row.id === 'web-server' ? { ...row.config, port: listenPort } : {
          ...row.config, databaseUrlFile: join(temporary, 'database-url'),
          workerTokenFile: join(temporary, 'worker-token'), modelKeyFile: join(temporary, 'model-key'),
          connectorKeyFile: join(temporary, 'connector-key'), seedUsersFile: join(temporary, 'users.json'),
          workspaceRoot: join(temporary, 'workspaces'), artifactRoot: join(temporary, 'artifacts'),
          readyFile: join(home, 'ready.json'), modelUrl: 'http://127.0.0.1:9/model',
          platformOrigin: origin,
          connectorUrl: 'http://127.0.0.1:9', connectorPollMs: 1000,
          sandboxKubeconfigFile: '', sandboxKeyFile: '', sandboxNamespace: '', sandboxImage: '',
          sandboxLocalRoot: '', sandboxNodeRoot: '', loginWindowMs: 60000,
          loginAttemptsPerWindow: 2, loginTrackedAccounts: 3,
          loginGlobalAttemptsPerWindow: 20, sandboxConcurrency: 1,
          ...limits,
        },
      }))
      await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
      const logPath = join(temporary, `${name}.log`)
      const log = openSync(logPath, 'a', 0o600)
      const child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', `power-evolve-${name}`], {
        cwd: root, env: { ...process.env, DSH_HOME: home, PE_PRIVATE_DIR: temporary },
        stdio: ['ignore', log, log],
      })
      closeSync(log); children.add(child)
      try {
        const ready = await eventually(async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`${name} exited before ready: ${await readFile(logPath, 'utf8')}`)
          }
          if (name.startsWith('mismatch') && (await readFile(logPath, 'utf8')).includes(
            'Platform replicas disagree on global admission limits')) {
            throw new Error('Platform replicas disagree on global admission limits')
          }
          try { return JSON.parse(await readFile(join(home, 'ready.json'), 'utf8')) }
          catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
        }, `${name} ready`, 15000)
        const health = await (await fetch(`${ready.url}/health`)).json()
        assert.equal(health.schema, 19)
        return { child, url: ready.url }
      } catch (error) {
        await stop(child)
        throw new Error(`${error.message}: ${await readFile(logPath, 'utf8')}`)
      }
    }

    const first = await start('first', {}, firstPort)
    const second = await start('second', {}, secondPort)
    const lbLog = openSync(join(temporary, 'platform-lb.log'), 'a', 0o600)
    const lbChild = spawn(process.execPath, [join(product, 'scripts/trial-platform-lb.mjs')], {
      cwd: root, env: { ...process.env, PE_PLATFORM_PORT: String(firstPort),
        PE_PLATFORM_SECOND_PORT: String(secondPort), PE_PLATFORM_LOAD_BALANCER_PORT: String(lbPort),
        PE_MULTI_HOST: '1', PE_LOAD_BALANCER_PORT: String(hostPort),
        PE_READY_FILE: join(temporary, 'platform-lb-ready.json') },
      stdio: ['ignore', lbLog, lbLog],
    })
    closeSync(lbLog); children.add(lbChild)
    const lbHealthy = count => eventually(async () => {
      if (lbChild.exitCode !== null || lbChild.signalCode !== null) {
        throw new Error(`Platform LB exited: ${await readFile(join(temporary, 'platform-lb.log'), 'utf8')}`)
      }
      try {
        const health = await (await fetch(`${origin}/health`)).json()
        return health.backends.filter(item => item.healthy).length === count ? health : false
      } catch { return false }
    }, `${count} Platform LB backends healthy`)
    await lbHealthy(2)
    const login = (base, username = 'alice', path = '/identity/login',
      body = JSON.stringify({ username, password }), forwardedFor = '203.0.113.1') =>
      fetch(`${base}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor }, body })
    const concurrent = await Promise.all([
      login(origin, 'alice', '/identity/login', undefined, '203.0.113.1'),
      login(origin, 'alice', '/identity/approval-login', undefined, '198.51.100.2'),
      login(origin, 'alice', '/identity/login', undefined, '192.0.2.3'),
      login(origin, 'alice', '/identity/login', undefined, '192.0.2.4'),
      login(origin, 'bob'), login(origin, 'bob'),
    ])
    assert.deepEqual(concurrent.map(response => response.status).sort((a, b) => a - b),
      [200, 200, 200, 200, 429, 429])
    assert.deepEqual(new Set(concurrent.map(response => response.headers.get('x-pe-trial-platform'))),
      new Set(['platform', 'platform-b']))
    assert.deepEqual((await pool.query('SELECT attempts FROM pe_login_attempt_windows ORDER BY account_digest'))
      .rows.map(row => row.attempts), [2, 2])
    assert.equal((await pool.query('SELECT attempts FROM pe_login_global_window')).rows[0].attempts, 6)

    await stop(first.child, 'SIGKILL')
    await lbHealthy(1)
    assert.equal((await login(origin)).status, 429)
    assert.equal((await login(origin, 'bob')).status, 429)
    await start('restarted', {}, firstPort)
    await lbHealthy(2)
    assert.equal((await login(origin)).status, 429)
    await pool.query("UPDATE pe_login_attempt_windows SET window_since=clock_timestamp()-interval '61 seconds'")
    assert.equal((await login(origin, 'alice', '/identity/login', '{')).status, 400)

    await assert.rejects(start('mismatch', { loginAttemptsPerWindow: 3 }),
      /Platform replicas disagree on global admission limits/)
    await assert.rejects(start('mismatch-worker', { sandboxConcurrency: 2 }),
      /Platform replicas disagree on global admission limits/)
    await assert.rejects(start('mismatch-global', { loginGlobalAttemptsPerWindow: 21 }),
      /Platform replicas disagree on global admission limits/)
    assert.equal((await login(origin)).status, 200)
    assert.equal((await login(origin)).status, 200)
    assert.equal((await login(origin)).status, 429)

    const limits = { loginWindowMs: 60000, loginAttemptsPerWindow: 2,
      loginTrackedAccounts: 3, loginGlobalAttemptsPerWindow: 20, sandboxConcurrency: 1 }
    const admission = new LoginAdmission(pool, limits)
    await admission.chargeAccount('charlie')
    await admission.chargeAccount('dave')
    await assert.rejects(admission.chargeAccount('erin'), /login_rate_limit/)
    assert.equal((await pool.query('SELECT tracked_accounts FROM pe_login_global_window')).rows[0].tracked_accounts, 3)
    await pool.query('UPDATE pe_login_global_window SET attempts=20 WHERE singleton=true')
    assert.equal((await login(origin, 'bob')).status, 429)
    await pool.query("UPDATE pe_login_global_window SET window_since=clock_timestamp()-interval '61 seconds'")
    await pool.query("UPDATE pe_login_attempt_windows SET window_since=clock_timestamp()-interval '61 seconds'")
    assert.equal((await login(origin, 'bob')).status, 200)
    await pool.query('UPDATE pe_login_global_window SET window_since=clock_timestamp(),attempts=0')
    const globalRace = await Promise.allSettled(Array.from({ length: 30 }, () => admission.chargeGlobal()))
    assert.equal(globalRace.filter(result => result.status === 'fulfilled').length, 20)
    assert.equal(globalRace.filter(result => result.status === 'rejected').length, 10)
    assert.equal((await pool.query('SELECT attempts FROM pe_login_global_window')).rows[0].attempts, 20)
  })

test('two PG-connected workers claim one global slot and recover after lease expiry',
  { timeout: 30000 }, async t => {
    const admin = new Pool({ connectionString: databaseUrl, max: 2 })
    const database = `pe_test_${randomBytes(10).toString('hex')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(databaseUrl); url.pathname = `/${database}`
    const firstPool = new Pool({ connectionString: url.href, max: 3 })
    const secondPool = new Pool({ connectionString: url.href, max: 3 })
    t.after(async () => {
      await firstPool.end(); await secondPool.end()
      await admin.query(`DROP DATABASE "${database}"`); await admin.end()
    })
    const { initializeDatabase } = await import('../lib/platform/database.js')
    await initializeDatabase(firstPool)
    const userId = randomUUID(), workspaceId = randomUUID()
    await firstPool.query("INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,'alice','irrelevant','{}')", [userId])
    await firstPool.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [workspaceId, userId])
    for (let index = 0; index < 2; index++) {
      const sessionId = randomUUID(), operationId = randomUUID()
      await firstPool.query(
        "INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,'{}')",
        [sessionId, userId, workspaceId, randomUUID()])
      await firstPool.query(
        "INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,'test','{}','running')",
        [operationId, sessionId, randomUUID()])
      await firstPool.query(`INSERT INTO pe_cloud_executions
        (id,user_id,session_id,operation_id,call_id,command,cwd,request_digest,state)
        VALUES($1,$2,$3,$4,$5,'echo test','','${'a'.repeat(64)}','queued')`,
      [randomUUID(), userId, sessionId, operationId, `call-${index}`])
    }
    const first = new ExecutionService({ pool: firstPool }, null, 1, 100, 1000, 2000, 1000)
    const second = new ExecutionService({ pool: secondPool }, null, 1, 100, 1000, 2000, 1000)
    const claimed = await Promise.all([first.claim(), second.claim()])
    assert.equal(claimed.filter(Boolean).length, 1)
    assert.equal((await firstPool.query(`SELECT count(*)::integer AS count FROM pe_cloud_executions
      WHERE lease_owner IS NOT NULL AND lease_until>clock_timestamp()`)).rows[0].count, 1)
    assert.equal(await first.claim(), null)
    assert.equal(await second.claim(), null)
    const survivor = claimed[0] ? second : first
    await firstPool.query("UPDATE pe_cloud_executions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [claimed.find(Boolean).id])
    const recovered = await survivor.claim()
    assert(recovered)
    assert.equal(recovered.id, claimed.find(Boolean).id)
    assert.equal(recovered.attempts, 2)
  })
