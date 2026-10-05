/** Real owned PostgreSQL; no Device process, container, model or filesystem service is started. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { DesktopBrowserScopeService } from '../lib/platform/desktop-browser-scope.js'
import { IdentityService, digest } from '../lib/platform/identity.js'
import { deviceProtocolFixture } from './device-execution-protocol-fixture.mjs'
import { taskCredential } from './task-credential-fixture.mjs'

const options = { timeout: 30000, skip: !process.env.PE_PRIVATE_DIR && !process.env.PE_TEST_DATABASE_URL }

async function fixture(t) {
  const cleanup = []
  const scopePools = new Set()
  t.after(async () => {
    await Promise.allSettled([...scopePools].map(pool => pool.end()))
    for (const callback of cleanup) await callback()
  })
  const f = await deviceProtocolFixture({ after: callback => cleanup.push(callback) })
  const pool = new Pool({ connectionString: f.pool.options.connectionString, max: 1,
    connectionTimeoutMillis: 3000, statement_timeout: 10000, query_timeout: 15000 })
  scopePools.add(pool)
  const token = await taskCredential(f.pool, f.alice)
  const identities = new IdentityService(f.pool, 3600000)
  const service = new DesktopBrowserScopeService(pool)
  const session = async user => {
    const workspaceId = randomUUID(), sessionId = randomUUID()
    await f.pool.query('INSERT INTO pe_workspaces(id,user_id,is_default) VALUES($1,$2,false)',
      [workspaceId, user.userId])
    await f.pool.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [sessionId, user.userId, workspaceId, randomUUID(), '{}'])
    return { userId: user.userId, sessionId, workspaceId }
  }
  return { ...f, scopePool: pool, scopePools, token, identities, service, session }
}

test('one-connection scope returns exact owner and Session membership without default Workspace creation', options, async t => {
  const f = await fixture(t)
  const first = await f.session(f.alice), second = await f.session(f.alice), foreign = await f.session(f.bob)
  const before = (await f.pool.query('SELECT count(*)::integer AS n FROM pe_workspaces')).rows[0].n
  for (const value of [first, second]) {
    assert.deepEqual(await f.service.read(f.token, { sessionId: value.sessionId }), value)
  }
  const otherToken = await taskCredential(f.pool, f.bob)
  assert.deepEqual(await f.service.read(otherToken, { sessionId: foreign.sessionId }), foreign)
  for (const sessionId of [foreign.sessionId, randomUUID()]) {
    await assert.rejects(f.service.read(f.token, { sessionId }), { status: 404, code: 'session_not_found' })
  }
  for (const extra of [{ userId: foreign.userId }, { workspaceId: foreign.workspaceId }, { path: '/workspace' }, { url: 'https://example.test' }]) {
    await assert.rejects(f.service.read(f.token, { sessionId: first.sessionId, ...extra }), { name: 'ZodError' })
  }
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_workspaces')).rows[0].n, before)
  assert.equal((await f.pool.query('SELECT count(*)::integer AS n FROM pe_workspaces WHERE is_default')).rows[0].n, 0)
})

test('approval, account, enrolled Device and runtime grant credentials cannot read browser scope', options, async t => {
  const f = await fixture(t), value = await f.session(f.alice)
  const approval = await taskCredential(f.pool, f.alice, 'approval')
  const account = await taskCredential(f.pool, f.alice, 'account')
  const device = await f.enroll(f.alice)
  const { grant } = await f.operation(f.alice, device)
  for (const token of [approval, account, device.token, grant.token]) {
    await assert.rejects(f.service.read(token, { sessionId: value.sessionId }), { status: 401, code: 'account_unauthorized' })
  }
})

test('scope rechecks the bearer after prior outer authentication and account mutation', options, async t => {
  for (const kind of ['logout', 'rotation', 'disable', 'expiry', 'forced password change', 'delete']) {
    await t.test(kind, async t => {
      const f = await fixture(t), value = await f.session(f.alice)
      assert.equal((await f.identities.authenticate(f.token)).userId, value.userId)
      if (kind === 'logout') await f.identities.logout(f.token)
      else if (kind === 'rotation') await f.pool.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [value.userId])
      else if (kind === 'disable') await f.pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [value.userId])
      else if (kind === 'expiry') await f.pool.query('UPDATE pe_credentials SET expires_at=clock_timestamp() WHERE digest=$1', [digest(f.token)])
      else if (kind === 'forced password change') await f.pool.query('UPDATE pe_users SET password_change_required=true WHERE id=$1', [value.userId])
      else await f.pool.query('UPDATE pe_users SET enabled=false,deleted_at=clock_timestamp() WHERE id=$1', [value.userId])
      const code = kind === 'disable' ? 'account_disabled' : kind === 'delete' ? 'account_deleted'
        : kind === 'forced password change' ? 'password_change_required' : 'account_unauthorized'
      await assert.rejects(f.service.read(f.token, { sessionId: value.sessionId }),
        { status: kind === 'forced password change' ? 403 : 401, code })
    })
  }
})

test('credential expiry while membership is read is rejected before returning', options, async t => {
  const f = await fixture(t), value = await f.session(f.alice)
  await f.pool.query("UPDATE pe_credentials SET expires_at=clock_timestamp()+interval '750 milliseconds' WHERE digest=$1", [digest(f.token)])
  let read = false
  f.scopePool.on('connect', client => {
    const query = client.query.bind(client)
    client.query = async (...args) => {
      const result = await query(...args)
      if (typeof args[0] === 'string' && args[0].includes('FROM pe_sessions s JOIN pe_workspaces')) {
        read = true
        await query('SELECT pg_sleep(1)')
      }
      return result
    }
  })
  await assert.rejects(f.service.read(f.token, { sessionId: value.sessionId }), { status: 401, code: 'account_unauthorized' })
  assert.equal(read, true, 'expiry occurred after the first authority check and membership read')
})

test('concurrent logout waits for scope authority locks, then prevents the next scope', options, async t => {
  const f = await fixture(t), value = await f.session(f.alice)
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const reached = new Promise(resolve => { entered = resolve })
  f.scopePool.on('connect', client => {
    const query = client.query.bind(client)
    client.query = async (...args) => {
      const result = await query(...args)
      if (typeof args[0] === 'string' && args[0].includes('FROM pe_sessions s JOIN pe_workspaces')) {
        entered()
        await gate
      }
      return result
    }
  })
  const marker = `scope_logout_${randomUUID()}`
  const revokePool = new Pool({ connectionString: f.pool.options.connectionString, max: 1,
    application_name: marker, connectionTimeoutMillis: 3000, statement_timeout: 10000, query_timeout: 15000 })
  f.scopePools.add(revokePool)
  const scope = f.service.read(f.token, { sessionId: value.sessionId })
  let logout
  try {
    await Promise.race([reached, delay(2000).then(() => { throw new Error('membership read did not reach its barrier') })])
    logout = new IdentityService(revokePool, 3600000).logout(f.token)
    let blocked = false
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const wait = await f.pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1", [marker])
      if (wait.rows.some(row => row.wait_event_type === 'Lock')) { blocked = true; break }
      await delay(10)
    }
    assert.equal(blocked, true, 'logout must wait for the real account or credential row lock')
    release()
    assert.deepEqual(await scope, value)
    await logout
    await assert.rejects(f.service.read(f.token, { sessionId: value.sessionId }), { status: 401, code: 'account_unauthorized' })
  } finally {
    release()
    await Promise.allSettled([scope, ...(logout ? [logout] : [])])
  }
})
