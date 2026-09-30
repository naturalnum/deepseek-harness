/** S3 account settings, model grants, and egress checks against real PostgreSQL. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { settingsUpdateRequest } from '../lib/contracts.js'
import { initializeDatabase } from '../lib/platform/database.js'
import { IdentityService, hashPassword } from '../lib/platform/identity.js'
import { AccountSettingsService, seedNewUser } from '../lib/platform/account-settings.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { proxyModel } from '../lib/platform/model.js'
import { schema, schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8,
  schemaV9, schemaV10 } from '../lib/platform/schema.js'

const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()

async function isolated(run) {
  const name = `pe_s3_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  let pool
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(databaseUrl); url.pathname = `/${name}`
    pool = new Pool({ connectionString: url.href, max: 8 })
    await run(pool)
  } finally {
    await pool?.end()
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    await admin.end()
  }
}

async function seeded(pool, identities, username, settings, models) {
  const password = randomBytes(24).toString('base64url')
  await seedNewUser(pool, username, await hashPassword(password), settings, models)
  const { token } = await identities.login(username, password)
  return { token, user: await identities.authenticate(token) }
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

test('S3 settings are user-scoped, revisioned, idempotent and snapshotted under the user lock',
  { timeout: 30000 }, async () => {
    await isolated(async pool => {
      await initializeDatabase(pool)
      const identities = new IdentityService(pool, 60_000)
      const account = new AccountSettingsService(pool)
      const alice = await seeded(pool, identities, 'alice', { model: 'fixture-a', maxTokens: 64, revision: 1 }, [
        { id: 'fixture-a', label: 'Model A', maxTokens: 128, enabled: true },
        { id: 'fixture-b', label: 'Model B', maxTokens: 256, enabled: true },
      ])
      const bob = await seeded(pool, identities, 'bob', { model: 'fixture-c', maxTokens: 32, revision: 1 }, [
        { id: 'fixture-c', label: 'Model C', maxTokens: 64, enabled: true },
        { id: 'fixture-b', label: 'Disabled B', maxTokens: 128, enabled: false },
      ])
      const carol = await seeded(pool, identities, 'carol', { model: 'fixture-d', maxTokens: 40, revision: 1 })
      assert.deepEqual(await account.modelsList(carol.user), { models: [
        { id: 'fixture-d', label: 'fixture-d', maxTokens: 40 },
      ] })
      await assert.rejects(account.update(carol.user, { requestId: randomUUID(), expectedRevision: 1,
        model: 'fixture-d', maxTokens: 41 }), { status: 403, code: 'model_not_authorized' })
      assert.deepEqual(await account.modelsList(alice.user), { models: [
        { id: 'fixture-a', label: 'Model A', maxTokens: 128 },
        { id: 'fixture-b', label: 'Model B', maxTokens: 256 },
      ] })
      assert.deepEqual(await account.modelsList(bob.user), { models: [
        { id: 'fixture-c', label: 'Model C', maxTokens: 64 },
      ] })
      assert.throws(() => settingsUpdateRequest.parse({ requestId: randomUUID(), expectedRevision: 1,
        model: 'fixture-a', maxTokens: 64, userId: bob.user.userId }))
      await assert.rejects(account.update(bob.user, { requestId: randomUUID(), expectedRevision: 1,
        model: 'fixture-a', maxTokens: 32 }), { status: 403, code: 'model_not_authorized' })
      await assert.rejects(account.update(alice.user, { requestId: randomUUID(), expectedRevision: 1,
        model: 'fixture-b', maxTokens: 257 }), { status: 403, code: 'model_not_authorized' })

      const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 3000, maxPendingPerUser: 8, maxActivePerUser: 1 })
      const { sessionId } = await tasks.create(alice.user, randomUUID())
      const oldRequest = randomUUID()
      const old = await tasks.accept(alice.user, sessionId, oldRequest, 'before update')
      const staleAuthentication = await identities.authenticate(alice.token)
      const mutation = { requestId: randomUUID(), expectedRevision: 1, model: 'fixture-b', maxTokens: 200 }
      assert.deepEqual(await account.update(alice.user, mutation), { model: 'fixture-b', maxTokens: 200, revision: 2 })
      assert.deepEqual(await account.update(alice.user, mutation), { model: 'fixture-b', maxTokens: 200, revision: 2 })
      await assert.rejects(account.update(alice.user, { ...mutation, maxTokens: 201 }),
        { status: 409, code: 'request_id_conflict' })
      const fresh = await tasks.accept(staleAuthentication, sessionId, randomUUID(), 'after update')
      const snapshots = await pool.query('SELECT id,settings FROM pe_operations WHERE id=ANY($1::uuid[])',
        [[old.operationId, fresh.operationId]])
      assert.deepEqual(snapshots.rows.find(row => row.id === old.operationId).settings,
        { model: 'fixture-a', maxTokens: 64, revision: 1 })
      assert.deepEqual(snapshots.rows.find(row => row.id === fresh.operationId).settings,
        { model: 'fixture-b', maxTokens: 200, revision: 2 })
      assert.equal((await tasks.accept(alice.user, sessionId, oldRequest, 'before update')).operationId, old.operationId)
      assert.equal((await identities.authenticate(alice.token)).settings.revision, 2)
      assert.equal((await identities.authenticate(bob.token)).settings.revision, 1)

      const contenders = await Promise.allSettled([
        account.update(alice.user, { requestId: randomUUID(), expectedRevision: 2,
          model: 'fixture-a', maxTokens: 80 }),
        account.update(alice.user, { requestId: randomUUID(), expectedRevision: 2,
          model: 'fixture-b', maxTokens: 220 }),
      ])
      assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1)
      assert.deepEqual(contenders.filter(result => result.status === 'rejected').map(result =>
        [result.reason.status, result.reason.code]), [[409, 'settings_revision_conflict']])
      assert.equal((await identities.authenticate(alice.token)).settings.revision, 3)
      assert.equal((await identities.authenticate(bob.token)).settings.revision, 1)

      await pool.query('UPDATE pe_user_models SET enabled=false WHERE user_id=$1 AND model_id=$2',
        [alice.user.userId, 'fixture-a'])
      await seedNewUser(pool, 'alice', 'replacement-password-hash',
        { model: 'fixture-a', maxTokens: 64, revision: 1 },
        [{ id: 'fixture-b', label: 'Changed seed', maxTokens: 256, enabled: true }])
      assert.deepEqual((await account.modelsList(alice.user)).models.map(model => model.id), ['fixture-b'],
        'restart seeding must not restore a revoked grant')
      assert.equal((await tasks.accept(alice.user, sessionId, oldRequest, 'before update')).operationId, old.operationId,
        'idempotent prompt retry keeps the old operation even after revocation')
    })
  })

test('model egress refuses revoked grants before sending upstream', { timeout: 30000 }, async () => {
  await isolated(async pool => {
    await initializeDatabase(pool)
    const identities = new IdentityService(pool, 60_000)
    const alice = await seeded(pool, identities, 'alice', { model: 'fixture-a', maxTokens: 64, revision: 1 }, [
      { id: 'fixture-a', label: 'Model A', maxTokens: 100, enabled: true },
    ])
    const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 })
    const { sessionId } = await tasks.create(alice.user, randomUUID())
    await tasks.accept(alice.user, sessionId, randomUUID(), 'egress')
    const grant = await tasks.claim(randomUUID())
    const upstreamModels = []
    const upstream = createServer(async (request, response) => {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString())
      upstreamModels.push(body.model)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: done\n\n')
    })
    const upstreamUrl = await listen(upstream)
    const proxy = createServer(async (request, response) => {
      try {
        await proxyModel(tasks, { url: `${upstreamUrl}/v1/messages`, apiKey: 'test-only',
          timeoutMs: 3000, maxRequestBytes: 4096, maxResponseBytes: 4096 }, request, response)
      } catch (error) { response.writeHead(error.status ?? 500); response.end(error.code ?? 'error') }
    })
    const proxyUrl = await listen(proxy)
    try {
      const call = (model, maxTokens = 64) => fetch(`${proxyUrl}/model/v1/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, stream: true,
          messages: [{ role: 'user', content: 'test' }] }),
      })
      const allowed = await call('fixture-a')
      assert.equal(allowed.status, 200)
      await allowed.text()
      assert.deepEqual(upstreamModels, ['fixture-a'])
      assert.equal((await call('fixture-b')).status, 403)
      assert.equal((await call('fixture-a', 65)).status, 403)
      await pool.query('UPDATE pe_user_models SET enabled=false WHERE user_id=$1 AND model_id=$2',
        [alice.user.userId, 'fixture-a'])
      assert.equal((await call('fixture-a')).status, 403)
      assert.deepEqual(upstreamModels, ['fixture-a'])
      await assert.rejects(tasks.accept(alice.user, sessionId, randomUUID(), 'after revoke'),
        { status: 403, code: 'model_not_authorized' })
    } finally { await close(proxy); await close(upstream) }
  })
})

test('V11 migrates only each existing user current model and never regrants on restart',
  { timeout: 30000 }, async () => {
    await isolated(async pool => {
      await pool.query(schema)
      await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
      for (const step of [schemaV2, schemaV3, schemaV4, schemaV5, schemaV6, schemaV7, schemaV8,
        schemaV9, schemaV10]) await pool.query(step)
      const id = randomUUID()
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [id, 'legacy', 'test-only', { model: 'fixture-legacy', maxTokens: 96, revision: 7 }])
      await initializeDatabase(pool)
      assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 23)
      assert.deepEqual((await pool.query('SELECT model_id,label,max_tokens,enabled FROM pe_user_models WHERE user_id=$1',
        [id])).rows, [{ model_id: 'fixture-legacy', label: 'fixture-legacy', max_tokens: 96, enabled: true }])
      await pool.query('UPDATE pe_user_models SET enabled=false WHERE user_id=$1', [id])
      await initializeDatabase(pool)
      assert.equal((await pool.query('SELECT enabled FROM pe_user_models WHERE user_id=$1', [id])).rows[0].enabled, false)
      assert.deepEqual((await pool.query('SELECT settings FROM pe_users WHERE id=$1', [id])).rows[0].settings,
        { model: 'fixture-legacy', maxTokens: 96, revision: 7 })
    })
  })
