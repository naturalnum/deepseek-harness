/** Real-PG account lifecycle; the injected execution revoker is a deterministic transaction-only fixture. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { ACCOUNT_ROUTES, accountChangePasswordRequest, accountCreateRequest, accountListRequest,
  accountTargetMutationRequest, accountUpdateRequest } from '../src/account-contracts.ts'
import { settings, settingsUpdateRequest, type UserId } from '../src/contracts.ts'
import { bootstrapAccount } from '../src/platform/account-bootstrap.ts'
import { accountBootstrapConfig, accountManagementConfig, loadAccountBootstrapConfig, loadAccountManagementConfig } from '../src/platform/account-config.ts'
import { routeAccount } from '../src/platform/account-routes.ts'
import { AccountService } from '../src/platform/accounts.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { AccountSettingsService, seedNewUser } from '../src/platform/account-settings.ts'
import { initializeDatabase } from '../src/platform/database.ts'
import { digest, hashPassword, IdentityService } from '../src/platform/identity.ts'

const privateDir = process.env.PE_ACCOUNT_TEST_PRIVATE_DIR
const pgTest = { skip: !privateDir, timeout: 30000 }
const origin = 'https://platform.example.test'
const initialPassword = 'initial-admin-password-fixture'
const management = accountManagementConfig.parse({ maxUsers: 12, models: [
  { id: 'catalog-a', label: 'Catalog A', maxTokens: 256 }, { id: 'catalog-b', label: 'Catalog B', maxTokens: 512 },
], initialSettings: { model: 'catalog-a', maxTokens: 64 } })
type Fixture = { pool: Pool; identities: IdentityService; accounts: AccountService; root: string; adminId: UserId;
  bootstrap: ReturnType<typeof accountBootstrapConfig.parse>; revoked: UserId[] }

async function isolated(run: (fixture: Fixture) => Promise<void>, bootstrap = true): Promise<void> {
  const source = new URL((await readFile(join(privateDir!, 'database-url'), 'utf8')).trim())
  const name = `pe_account_lifecycle_e1_${randomBytes(10).toString('hex')}`
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres'
  const admin = new Pool({ connectionString: adminUrl.href, max: 2 })
  const url = new URL(source); url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.href, max: 8 })
  const root = await mkdtemp(join(tmpdir(), 'pe-account-e1-'))
  let created = false
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true
    await initializeDatabase(pool)
    const config = accountBootstrapConfig.parse({ mode: 'create', userId: randomUUID(), username: 'admin',
      displayName: 'Administrator', password: initialPassword })
    if (bootstrap) await bootstrapAccount(pool, config, management)
    const identities = new IdentityService(pool, 60000)
    const revoked: UserId[] = []
    const accounts = new AccountService(pool, identities, { platformOrigin: origin, workspaceRoot: root, management,
      revokeExecutions: async (client, userId) => {
        assert.equal((await client.query('SELECT enabled FROM pe_users WHERE id=$1', [userId])).rows[0].enabled, false)
        revoked.push(userId)
        await client.query('UPDATE pe_sessions SET grant_digest=NULL,lease_epoch=lease_epoch+1,lease_until=NULL WHERE user_id=$1', [userId])
        return { fenced: 1 }
      } })
    await run({ pool, identities, accounts, root, adminId: config.userId, bootstrap: config, revoked })
  } finally {
    await pool.end()
    if (created) await admin.query(`DROP DATABASE "${name}"`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
}

const creation = (username: string, role: 'ADMIN' | 'USER' = 'USER') => accountCreateRequest.parse({ requestId: randomUUID(),
  username, displayName: `User ${username}`, role, settings: management.initialSettings,
  models: [{ id: 'catalog-a', maxTokens: 128 }] })
async function unrestricted(f: Fixture, adminToken: string, username: string, role: 'ADMIN' | 'USER' = 'USER') {
  const created = await f.accounts.create(adminToken, creation(username, role))
  assert.ok(created.temporaryPassword)
  const first = await f.accounts.login(username, created.temporaryPassword)
  const password = `new-password-fixture-${username}`
  await f.accounts.changePassword(first.token, accountChangePasswordRequest.parse({ requestId: randomUUID(),
    currentPassword: created.temporaryPassword, newPassword: password }))
  return { account: created.receipt.account, password, login: await f.accounts.login(username, password) }
}
async function session(pool: Pool, userId: UserId) {
  const workspaceId = randomUUID()
  const sessionId = randomUUID()
  await pool.query('INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,$3,true)', [workspaceId, userId, 'Workspace'])
  await pool.query(`INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header,grant_digest,lease_until)
    VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour')`, [sessionId, userId, workspaceId, randomUUID(), {}, 'accepted-execution-grant'])
  return { sessionId, workspaceId }
}
async function temporaryTickets(pool: Pool, userId: UserId): Promise<void> {
  const requestId = randomUUID()
  const hashed = digest(randomBytes(32).toString('hex'))
  await pool.query(`INSERT INTO pe_skill_upload_intents(request_id,user_id,size_bytes,archive_digest,token_digest,expires_at)
    VALUES($1,$2,32,$3,$3,now()+interval '1 hour')`, [requestId, userId, hashed])
  await pool.query(`INSERT INTO pe_skill_upload_intents(request_id,user_id,size_bytes,archive_digest,token_digest,expires_at,consumed_at)
    VALUES($1,$2,32,$3,$3,now()+interval '1 hour',now())`, [randomUUID(), userId, digest(randomUUID())])
  await pool.query(`INSERT INTO pe_ssh_management_requests(user_id,request_id,purpose,request_format_version,request_digest,input)
    VALUES($1,$2,'create',2,$3,$4)`, [userId, requestId, hashed, {}])
  await pool.query(`INSERT INTO pe_ssh_upload_intents(request_id,user_id,request_digest,config,size_bytes,token_digest,expires_at,format_version)
    VALUES($1,$2,$3,$4,32,$3,now()+interval '1 hour',2)`, [requestId, userId, hashed, {}])
  await pool.query(`INSERT INTO pe_mcp_management_requests(user_id,request_id,purpose,metadata_digest)
    VALUES($1,$2,'create',$3)`, [userId, requestId, hashed])
  await pool.query(`INSERT INTO pe_mcp_credential_tickets(user_id,request_id,token_digest,purpose,input,resource_id,size_bytes,expires_at)
    VALUES($1,$2,$3,'create',$4,$5,32,now()+interval '1 hour')`, [userId, requestId, hashed, {}, randomUUID()])
  await pool.query("INSERT INTO pe_device_pairings(digest,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashed, userId])
}
async function ticketsExpired(pool: Pool, userId: UserId): Promise<void> {
  for (const table of ['pe_skill_upload_intents', 'pe_ssh_upload_intents', 'pe_mcp_credential_tickets']) {
    const count = (await pool.query(`SELECT count(*)::integer AS count FROM ${table}
      WHERE user_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, [userId])).rows[0].count
    assert.equal(count, 0, `${table} pending tickets must remain expired`)
    assert.ok((await pool.query(`SELECT 1 FROM ${table} WHERE user_id=$1`, [userId])).rowCount, 'Ticket metadata must remain')
  }
  assert.equal((await pool.query('SELECT expires_at>clock_timestamp() AS live FROM pe_device_pairings WHERE user_id=$1', [userId])).rows[0].live, false)
  assert.equal((await pool.query('SELECT expires_at>clock_timestamp() AS live FROM pe_skill_upload_intents WHERE user_id=$1 AND consumed_at IS NOT NULL', [userId])).rows[0].live, true)
}
async function waitForUserLock(pool: Pool, backend?: number): Promise<void> {
  for (let retry = 0; retry < 200; retry++) {
    const row = (await pool.query(`SELECT wait_event_type FROM pg_stat_activity WHERE datname=current_database()
      AND ($1::integer IS NULL OR pid=$1) AND wait_event_type='Lock'`, [backend ?? null])).rows[0]
    if (row?.wait_event_type === 'Lock') return
    await pause(10)
  }
  assert.fail('Contending identity operation did not reach the user lock')
}

test('private configuration validates catalogs and redacts bootstrap parser inputs', async () => {
  assert.equal(await loadAccountBootstrapConfig(''), null)
  assert.equal(accountManagementConfig.safeParse({ ...management, models: [...management.models, management.models[0]] }).success, false)
  await assert.rejects(loadAccountBootstrapConfig('/private/bootstrap.json', async () => '{"password":"private-fixture"}'),
    error => error instanceof Error && error.message === 'Invalid account bootstrap configuration')
  await assert.rejects(loadAccountManagementConfig('relative.json', async () => JSON.stringify(management)), /Invalid account management/u)
})

test('concurrent bootstrap is one-shot and existing identities, hashes and grants remain authoritative', pgTest, async () => {
  await isolated(async f => {
    const password = 'legacy-short'
    await seedNewUser(f.pool, 'ExistingCase', await hashPassword(password),
      settings.parse({ model: 'catalog-a', maxTokens: 96, revision: 7 }), [{ id: 'catalog-a', label: 'Legacy grant', maxTokens: 128, enabled: true }])
    await f.pool.query('UPDATE pe_user_models SET enabled=false')
    const existing = (await f.pool.query('SELECT id,password_hash,settings FROM pe_users WHERE username=$1', ['ExistingCase'])).rows[0]
    const config = accountBootstrapConfig.parse({ mode: 'existing', userId: existing.id, username: 'ExistingCase' })
    await Promise.all([bootstrapAccount(f.pool, config, management), bootstrapAccount(f.pool, config, management)])
    assert.equal((await f.pool.query("SELECT count(*)::integer AS count FROM pe_users WHERE role='ADMIN'")).rows[0].count, 1)
    assert.equal((await f.pool.query('SELECT count(*)::integer AS count FROM pe_account_bootstrap')).rows[0].count, 1)
    assert.equal((await f.pool.query('SELECT count(*)::integer AS count FROM pe_account_audit')).rows[0].count, 1)
    assert.equal((await f.identities.login('ExistingCase', password)).user.userId, existing.id)
    await assert.rejects(f.identities.login('existingcase', password), { status: 401, code: 'invalid_login' })
    await f.pool.query("UPDATE pe_users SET role='USER',enabled=false WHERE id=$1", [existing.id])
    await bootstrapAccount(f.pool, config, management)
    await seedNewUser(f.pool, 'ExistingCase', await hashPassword('replacement-fixture-password'),
      settings.parse({ ...management.initialSettings, revision: 1 }))
    assert.deepEqual((await f.pool.query('SELECT id,password_hash,settings FROM pe_users')).rows[0], existing)
    assert.deepEqual((await f.pool.query('SELECT role,enabled FROM pe_users')).rows[0], { role: 'USER', enabled: false })
    assert.equal((await f.pool.query('SELECT enabled FROM pe_user_models')).rows[0].enabled, false)
    await assert.rejects(bootstrapAccount(f.pool, f.bootstrap, management), { status: 409, code: 'account_bootstrap_conflict' })
  }, false)
  await isolated(async f => {
    await Promise.all([bootstrapAccount(f.pool, f.bootstrap, management), bootstrapAccount(f.pool, f.bootstrap, management)])
    assert.equal((await f.pool.query('SELECT count(*)::integer AS count FROM pe_users')).rows[0].count, 1)
    await assert.rejects(bootstrapAccount(f.pool, accountBootstrapConfig.parse({ ...f.bootstrap, userId: randomUUID() }), management),
      { status: 409, code: 'account_bootstrap_conflict' })
  }, false)
})

test('trusted create is catalog-bound and forced-change tokens have only own status, change, receipt and logout', pgTest, async () => {
  await isolated(async f => {
    const admin = await f.accounts.login('admin', initialPassword)
    const agent = await f.identities.login('admin', initialPassword)
    const approval = await f.identities.login('admin', initialPassword, 'approval')
    assert.equal((await f.accounts.capabilities(agent.token)).canManage, true)
    assert.deepEqual((await f.accounts.models(admin.token)).models, management.models)
    for (const token of [agent.token, approval.token]) await assert.rejects(f.accounts.list(token, accountListRequest.parse({})),
      { status: 401, code: 'account_unauthorized' })
    for (const badOrigin of [undefined, 'https://host.example.test', `${origin}/`]) {
      await assert.rejects(routeAccount(f.accounts, ACCOUNT_ROUTES.login, undefined,
        { username: 'admin', password: initialPassword }, badOrigin), { status: 403, code: 'invalid_origin' })
    }
    const input = creation('new-user')
    const created = await f.accounts.create(admin.token, input)
    assert.ok(created.temporaryPassword)
    assert.equal(created.receipt.account.passwordChangeRequired, true)
    const replay = await f.accounts.create(admin.token, input)
    assert.deepEqual(replay, { receipt: created.receipt, replay: true, temporaryPassword: null })
    assert.deepEqual(await f.accounts.receipt(admin.token, input.requestId), { receipt: created.receipt })
    await assert.rejects(f.accounts.create(admin.token, { ...input, displayName: 'Changed' }), { status: 409, code: 'request_id_conflict' })
    await assert.rejects(f.accounts.create(admin.token, creation('NEW-USER')), { status: 409, code: 'account_username_conflict' })
    await assert.rejects(f.accounts.create(admin.token, accountCreateRequest.parse({ ...creation('invalid-model'),
      settings: { model: 'invented', maxTokens: 64 }, models: [{ id: 'invented', maxTokens: 64 }] })),
      { status: 403, code: 'model_not_authorized' })
    const first = await f.accounts.login('new-user', created.temporaryPassword)
    assert.equal(first.restricted, true)
    assert.equal((await f.accounts.me(first.token)).restricted, true)
    assert.deepEqual(await f.accounts.receipt(first.token, input.requestId), { receipt: null })
    await assert.rejects(f.identities.login('new-user', created.temporaryPassword), { status: 403, code: 'password_change_required' })
    await assert.rejects(f.identities.login('new-user', created.temporaryPassword, 'approval'), { status: 403, code: 'password_change_required' })
    await assert.rejects(f.accounts.models(first.token), { status: 403, code: 'password_change_required' })
    assert.deepEqual(await routeAccount(f.accounts, ACCOUNT_ROUTES.logout, first.token, {}, origin), { ok: true })
    await assert.rejects(f.accounts.me(first.token), { status: 401, code: 'account_unauthorized' })
    const durable = JSON.stringify((await f.pool.query('SELECT request_digest,password_verifier,receipt FROM pe_account_mutations')).rows)
    assert.equal(durable.includes(created.temporaryPassword), false)
    assert.equal(durable.includes('password_hash'), false)
  })
})

test('own password change revokes every browser audience and preserves accepted grants, models and settings', pgTest, async () => {
  await isolated(async f => {
    const admin = await f.accounts.login('admin', initialPassword)
    const alice = await unrestricted(f, admin.token, 'alice')
    const bob = await unrestricted(f, admin.token, 'bob')
    const agent = await f.identities.login('alice', alice.password)
    const secondAgent = await f.identities.login('alice', alice.password)
    const approval = await f.identities.login('alice', alice.password, 'approval')
    const accepted = await session(f.pool, alice.account.userId)
    await temporaryTickets(f.pool, alice.account.userId)
    const before = (await f.pool.query('SELECT settings FROM pe_users WHERE id=$1', [alice.account.userId])).rows[0]
    const grants = (await f.pool.query('SELECT * FROM pe_user_models WHERE user_id=$1', [alice.account.userId])).rows
    await assert.rejects(f.accounts.list(alice.login.token, accountListRequest.parse({})), { status: 403, code: 'account_forbidden' })
    const mutation = accountChangePasswordRequest.parse({ requestId: randomUUID(), currentPassword: alice.password,
      newPassword: 'changed-password-fixture-alice' })
    await assert.rejects(f.accounts.changePassword(alice.login.token, { ...mutation, currentPassword: 'wrong-fixture-password' }),
      { status: 403, code: 'account_current_password_invalid' })
    const changed = await f.accounts.changePassword(alice.login.token, mutation)
    await ticketsExpired(f.pool, alice.account.userId)
    for (const token of [agent.token, secondAgent.token]) await assert.rejects(f.identities.authenticate(token), { status: 401, code: 'unauthorized' })
    await assert.rejects(f.identities.authenticate(approval.token, 'approval'), { status: 401, code: 'unauthorized' })
    await assert.rejects(f.accounts.me(alice.login.token), { status: 401, code: 'account_unauthorized' })
    await assert.rejects(f.identities.login('alice', alice.password), { status: 401, code: 'invalid_login' })
    assert.equal((await f.accounts.me(bob.login.token)).user.userId, bob.account.userId)
    const fresh = await f.accounts.login('alice', mutation.newPassword)
    assert.deepEqual(await f.accounts.receipt(fresh.token, mutation.requestId), { receipt: changed.receipt })
    assert.deepEqual(await f.accounts.changePassword(fresh.token, mutation), { receipt: changed.receipt, replay: true })
    await assert.rejects(f.accounts.changePassword(fresh.token, { ...mutation, newPassword: 'another-password-fixture' }),
      { status: 409, code: 'request_id_conflict' })
    assert.equal((await f.pool.query('SELECT grant_digest FROM pe_sessions WHERE id=$1', [accepted.sessionId])).rows[0].grant_digest, 'accepted-execution-grant')
    assert.deepEqual((await f.pool.query('SELECT settings FROM pe_users WHERE id=$1', [alice.account.userId])).rows[0], before)
    assert.deepEqual((await f.pool.query('SELECT * FROM pe_user_models WHERE user_id=$1', [alice.account.userId])).rows, grants)
    assert.equal(f.revoked.length, 0)
    const row = (await f.pool.query('SELECT request_digest,password_verifier,receipt FROM pe_account_mutations WHERE request_id=$1', [mutation.requestId])).rows[0]
    assert.match(row.password_verifier, /^[a-f0-9]{32}:[a-f0-9]{128}$/u)
    assert.equal(JSON.stringify(row).includes(mutation.newPassword), false)
    assert.notEqual(row.request_digest, digest(mutation.newPassword))
  })
})

test('reset receipts do not rotate twice and restarted seeds never restore credentials or grants', pgTest, async () => {
  await isolated(async f => {
    const admin = await f.accounts.login('admin', initialPassword)
    const alice = await unrestricted(f, admin.token, 'alice')
    const accepted = await session(f.pool, alice.account.userId)
    await temporaryTickets(f.pool, alice.account.userId)
    const before = (await f.accounts.me(alice.login.token)).user
    const request = accountTargetMutationRequest.parse({ requestId: randomUUID(), userId: alice.account.userId, expectedRevision: before.revision })
    const reset = await f.accounts.resetPassword(admin.token, request)
    await ticketsExpired(f.pool, alice.account.userId)
    assert.ok(reset.temporaryPassword)
    const passwordHash = (await f.pool.query('SELECT password_hash FROM pe_users WHERE id=$1', [alice.account.userId])).rows[0].password_hash
    assert.deepEqual(await f.accounts.resetPassword(admin.token, request), { receipt: reset.receipt, replay: true, temporaryPassword: null })
    assert.deepEqual(await f.accounts.receipt(admin.token, request.requestId), { receipt: reset.receipt })
    await assert.rejects(f.accounts.resetPassword(admin.token, { ...request, expectedRevision: before.revision + 1 }), { status: 409, code: 'request_id_conflict' })
    await assert.rejects(f.accounts.me(alice.login.token), { status: 401, code: 'account_unauthorized' })
    assert.equal((await f.accounts.login('alice', reset.temporaryPassword)).restricted, true)
    await assert.rejects(f.identities.login('alice', reset.temporaryPassword), { status: 403, code: 'password_change_required' })
    await seedNewUser(f.pool, 'alice', await hashPassword(alice.password), settings.parse({ ...management.initialSettings, revision: 1 }))
    await initializeDatabase(f.pool)
    assert.equal((await f.pool.query('SELECT password_hash FROM pe_users WHERE id=$1', [alice.account.userId])).rows[0].password_hash, passwordHash)
    assert.equal((await f.pool.query('SELECT grant_digest FROM pe_sessions WHERE id=$1', [accepted.sessionId])).rows[0].grant_digest, 'accepted-execution-grant')
    assert.equal(f.revoked.length, 0)
  })
})

test('last-administrator protection serializes concurrent demotion, disable and deletion', pgTest, async () => {
  await isolated(async f => {
    const admin = await f.accounts.login('admin', initialPassword)
    const own = (await f.accounts.me(admin.token)).user
    await assert.rejects(f.accounts.update(admin.token, accountUpdateRequest.parse({ requestId: randomUUID(), userId: own.userId,
      expectedRevision: own.revision, enabled: false })), { status: 409, code: 'account_last_administrator' })
    await assert.rejects(f.accounts.remove(admin.token, accountTargetMutationRequest.parse({ requestId: randomUUID(), userId: own.userId,
      expectedRevision: own.revision })), { status: 409, code: 'account_last_administrator' })
    await assert.rejects(f.accounts.resetPassword(admin.token, accountTargetMutationRequest.parse({ requestId: randomUUID(), userId: own.userId,
      expectedRevision: own.revision })), { status: 409, code: 'account_last_administrator' })
    await f.accounts.create(admin.token, creation('restricted-admin', 'ADMIN'))
    await assert.rejects(f.accounts.update(admin.token, accountUpdateRequest.parse({ requestId: randomUUID(), userId: own.userId,
      expectedRevision: own.revision, role: 'USER' })), { status: 409, code: 'account_last_administrator' })
    const other = await unrestricted(f, admin.token, 'other-admin', 'ADMIN')
    const second = (await f.accounts.me(other.login.token)).user
    const results = await Promise.allSettled([
      f.accounts.update(admin.token, accountUpdateRequest.parse({ requestId: randomUUID(), userId: own.userId, expectedRevision: own.revision, role: 'USER' })),
      f.accounts.update(other.login.token, accountUpdateRequest.parse({ requestId: randomUUID(), userId: second.userId, expectedRevision: second.revision, role: 'USER' })),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal((await f.pool.query("SELECT count(*)::integer AS count FROM pe_users WHERE role='ADMIN' AND enabled AND deleted_at IS NULL AND NOT password_change_required")).rows[0].count, 1)
  })
})

test('disable commits credential revocation and coordinator fencing atomically; re-enable requires fresh login', pgTest, async () => {
  await isolated(async f => {
    const admin = await f.accounts.login('admin', initialPassword)
    const alice = await unrestricted(f, admin.token, 'alice')
    const agent = await f.identities.login('alice', alice.password)
    const user = await f.identities.authenticate(agent.token)
    const accountSettings = new AccountSettingsService(f.pool)
    const updateSettings = settingsUpdateRequest.parse({ requestId: randomUUID(), expectedRevision: 1, model: 'catalog-a', maxTokens: 96 })
    assert.equal((await accountSettings.update(user, updateSettings, agent.token)).revision, 2)
    assert.equal((await accountSettings.modelsList(user, agent.token)).models[0]!.id, 'catalog-a')
    const accepted = await session(f.pool, alice.account.userId)
    await temporaryTickets(f.pool, alice.account.userId)
    const own = (await f.accounts.me(alice.login.token)).user
    const mutation = accountUpdateRequest.parse({ requestId: randomUUID(), userId: own.userId, expectedRevision: own.revision, enabled: false })
    const failing = new AccountService(f.pool, f.identities, { platformOrigin: origin, workspaceRoot: f.root, management,
      revokeExecutions: async () => { throw new Error('Fixture coordinator rollback') } })
    await assert.rejects(failing.update(admin.token, mutation), /Fixture coordinator rollback/u)
    assert.equal((await f.accounts.me(alice.login.token)).user.enabled, true)
    assert.deepEqual(await f.accounts.receipt(admin.token, mutation.requestId), { receipt: null })
    const disabled = await f.accounts.update(admin.token, mutation)
    await ticketsExpired(f.pool, alice.account.userId)
    assert.deepEqual(await f.accounts.update(admin.token, mutation), { receipt: disabled.receipt, replay: true })
    assert.deepEqual(f.revoked, [own.userId])
    await assert.rejects(f.identities.authenticate(agent.token), { status: 401, code: 'unauthorized' })
    await assert.rejects(f.identities.login('alice', alice.password), { status: 401, code: 'account_disabled' })
    await assert.rejects(accountSettings.update(user, { ...updateSettings, requestId: settingsUpdateRequest.parse({ ...updateSettings, requestId: randomUUID() }).requestId }, agent.token),
      { status: 401, code: 'account_unauthorized' })
    await assert.rejects(accountSettings.modelsList(user, agent.token), { status: 401, code: 'account_unauthorized' })
    const enabled = await f.accounts.update(admin.token, accountUpdateRequest.parse({ requestId: randomUUID(), userId: own.userId,
      expectedRevision: disabled.receipt.account.revision, enabled: true }))
    assert.equal(enabled.receipt.account.enabled, true)
    await ticketsExpired(f.pool, alice.account.userId)
    await assert.rejects(f.identities.authenticate(agent.token), { status: 401, code: 'unauthorized' })
    assert.equal((await f.identities.login('alice', alice.password)).user.userId, own.userId)
    assert.equal((await f.pool.query('SELECT grant_digest FROM pe_sessions WHERE id=$1', [accepted.sessionId])).rows[0].grant_digest, null)
  })
})

test('delete checks live filesystem content and business history, then preserves identity tombstones and receipts', pgTest, async () => {
  await isolated(async f => {
    const admin = await f.accounts.login('admin', initialPassword)
    const input = creation('empty-user')
    const empty = await f.accounts.create(admin.token, input)
    const userId = empty.receipt.account.userId
    const workspaceId = randomUUID()
    await f.pool.query('INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,$3,true)', [workspaceId, userId, 'Workspace'])
    const workspace = join(f.root, workspaceId)
    await mkdir(workspace)
    await writeFile(join(workspace, 'sandbox-created.txt'), 'durable content without a file-mutation row')
    const request = accountTargetMutationRequest.parse({ requestId: randomUUID(), userId, expectedRevision: empty.receipt.account.revision })
    await assert.rejects(f.accounts.remove(admin.token, request), { status: 409, code: 'account_not_empty' })
    await rm(join(workspace, 'sandbox-created.txt'))
    const removed = await f.accounts.remove(admin.token, request)
    assert.ok(removed.receipt.account.deletedAt)
    assert.equal(removed.receipt.account.enabled, false)
    assert.deepEqual(await f.accounts.remove(admin.token, request), { receipt: removed.receipt, replay: true })
    assert.deepEqual(await f.accounts.receipt(admin.token, request.requestId), { receipt: removed.receipt })
    assert.equal((await f.accounts.list(admin.token, accountListRequest.parse({}))).items.some(item => item.userId === userId), false)
    await seedNewUser(f.pool, 'empty-user', await hashPassword('replacement-fixture-password'), settings.parse({ ...management.initialSettings, revision: 1 }))
    assert.equal((await f.pool.query('SELECT id,enabled FROM pe_users WHERE username=$1', ['empty-user'])).rows[0].id, userId)
    await assert.rejects(f.accounts.create(admin.token, creation('EMPTY-USER')), { status: 409, code: 'account_username_conflict' })
    const busy = await unrestricted(f, admin.token, 'busy-user')
    const accepted = await session(f.pool, busy.account.userId)
    const op = randomUUID()
    await f.pool.query("INSERT INTO pe_operations(id,session_id,request_id,input,settings,state) VALUES($1,$2,$3,'fixture',$4,'queued')",
      [op, accepted.sessionId, randomUUID(), { ...management.initialSettings, revision: 1 }])
    const busyRequest = accountTargetMutationRequest.parse({ requestId: randomUUID(), userId: busy.account.userId,
      expectedRevision: (await f.accounts.me(busy.login.token)).user.revision })
    await assert.rejects(f.accounts.remove(admin.token, busyRequest), { status: 409, code: 'account_execution_active' })
    await f.pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1", [op])
    await assert.rejects(f.accounts.remove(admin.token, busyRequest), { status: 409, code: 'account_not_empty' })
    assert.equal((await f.pool.query('SELECT count(*)::integer AS count FROM pe_sessions WHERE user_id=$1', [busy.account.userId])).rows[0].count, 1)
  })
})

test('login, exchange and admission recheck after waiting for concurrent credential rotation', pgTest, async () => {
  await isolated(async f => {
    const admin = await f.accounts.login('admin', initialPassword)
    const alice = await unrestricted(f, admin.token, 'alice')
    const issued = await f.identities.login('alice', alice.password)
    const expires = (await f.pool.query('SELECT expires_at FROM pe_credentials WHERE digest=$1', [digest(issued.token)])).rows[0].expires_at
    const exchanged = await f.identities.exchange(issued.token)
    assert.equal((await f.pool.query('SELECT expires_at FROM pe_credentials WHERE digest=$1', [digest(exchanged)])).rows[0].expires_at.toISOString(), expires.toISOString())
    const replacements = await Promise.allSettled([f.identities.exchange(exchanged), f.identities.exchange(exchanged)])
    assert.equal(replacements.filter(result => result.status === 'fulfilled').length, 1)
    const valid = replacements.find(result => result.status === 'fulfilled')
    assert.ok(valid && valid.status === 'fulfilled')
    const rotating = await f.pool.connect()
    const accepting = await f.pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await rotating.query('BEGIN')
      await rotating.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [alice.account.userId])
      await accepting.query('BEGIN')
      const backend = (await accepting.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      pending = requireBrowserAccount(accepting, valid.value)
      const denied = assert.rejects(pending, { status: 401, code: 'account_unauthorized' })
      await waitForUserLock(f.pool, backend)
      await rotating.query('UPDATE pe_users SET credential_version=credential_version+1,password_hash=$2 WHERE id=$1',
        [alice.account.userId, await hashPassword('rotated-password-fixture')])
      await rotating.query('DELETE FROM pe_credentials WHERE user_id=$1', [alice.account.userId])
      await rotating.query('COMMIT')
      await denied
      await accepting.query('ROLLBACK')
      assert.equal((await f.identities.login('alice', 'rotated-password-fixture')).user.userId, alice.account.userId)
      await rotating.query('BEGIN')
      await rotating.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [alice.account.userId])
      const staleLogin = f.identities.login('alice', 'rotated-password-fixture')
      const refused = assert.rejects(staleLogin, { status: 401, code: 'invalid_login' })
      await waitForUserLock(f.pool)
      await rotating.query('UPDATE pe_users SET password_hash=$2,credential_version=credential_version+1 WHERE id=$1',
        [alice.account.userId, await hashPassword('second-rotation-password-fixture')])
      await rotating.query('DELETE FROM pe_credentials WHERE user_id=$1', [alice.account.userId])
      await rotating.query('COMMIT')
      await refused
      assert.equal((await f.identities.login('alice', 'second-rotation-password-fixture')).user.userId, alice.account.userId)
    } finally {
      if (pending) await pending.catch(() => undefined)
      await rotating.query('ROLLBACK')
      await accepting.query('ROLLBACK')
      rotating.release(); accepting.release()
    }
  })
})
