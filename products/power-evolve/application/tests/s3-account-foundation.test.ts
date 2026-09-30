/** Account DTO, V25 preservation and transactional authority checks. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Pool } from 'pg'
import { accountChangePasswordRequest, accountCreateRequest, accountLoginRequest, accountMutationReceipt,
  accountNewPassword, accountNewUsername, accountSecretMutationValue, accountUpdateRequest, accountUserId } from '../src/account-contracts.ts'
import { assertAccountAdministrator, assertActiveAccount, assertProductLoginAllowed,
  requireActiveAccount, requireBrowserAccount, type AccountAuthority } from '../src/platform/account-authority.ts'
import { initializeDatabase, transaction } from '../src/platform/database.ts'
import * as migrations from '../src/platform/schema.ts'

const userId = accountUserId.parse(randomUUID())
const current: AccountAuthority = { userId, username: 'LegacyName', displayName: 'LegacyName', role: 'USER',
  enabled: true, revision: 1, credentialVersion: 2, passwordChangeRequired: true, deletedAt: null }
const account = { userId, username: 'legacy', displayName: 'Legacy', role: 'USER' as const, enabled: true,
  revision: 1, passwordChangeRequired: true, deletedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }

test('new usernames normalize while legacy login names and passwords remain exact', () => {
  assert.equal(accountNewUsername.parse(' New.User '), 'new.user')
  assert.deepEqual(accountLoginRequest.parse({ username: 'LegacyName', password: 'short' }),
    { username: 'LegacyName', password: 'short' })
  assert.equal(accountNewUsername.safeParse('ab').success, false)
  assert.equal(accountLoginRequest.safeParse({ username: 'legacy', password: 'legacy', role: 'ADMIN' }).success, false)
})

test('new password bounds count UTF-8 bytes and change requires distinct inputs', () => {
  assert.equal(accountNewPassword.safeParse('密'.repeat(4)).success, true)
  assert.equal(accountNewPassword.safeParse('a'.repeat(11)).success, false)
  assert.equal(accountNewPassword.safeParse('密'.repeat(86)).success, false)
  assert.equal(accountNewPassword.safeParse('a'.repeat(12) + '\0').success, false)
  assert.equal(accountChangePasswordRequest.safeParse({ requestId: randomUUID(),
    currentPassword: 'a'.repeat(12), newPassword: 'a'.repeat(12) }).success, false)
})

test('create accepts bounded model grants covering the initial settings and excludes browser labels', () => {
  const input = { requestId: randomUUID(), username: 'new-user', displayName: 'New User', role: 'USER',
    settings: { model: 'catalog-a', maxTokens: 64 }, models: [{ id: 'catalog-a', maxTokens: 128 }] }
  assert.equal(accountCreateRequest.safeParse(input).success, true)
  assert.equal(accountCreateRequest.safeParse({ ...input, models: [{ id: 'catalog-b', maxTokens: 128 }] }).success, false)
  assert.equal(accountCreateRequest.safeParse({ ...input, models: [...input.models, ...input.models] }).success, false)
  assert.equal(accountCreateRequest.safeParse({ ...input, models: [{ ...input.models[0], label: 'Invented' }] }).success, false)
  assert.equal(accountUpdateRequest.safeParse({ requestId: randomUUID(), userId, expectedRevision: 1 }).success, false)
})

test('durable receipts exclude secrets and a replay cannot expose a temporary password', () => {
  const receipt = { requestId: randomUUID(), kind: 'create', account, completedAt: account.createdAt }
  assert.equal(accountMutationReceipt.safeParse({ ...receipt, temporaryPassword: 'a'.repeat(12) }).success, false)
  assert.equal(accountSecretMutationValue.safeParse({ receipt, replay: false, temporaryPassword: 'a'.repeat(12) }).success, true)
  assert.equal(accountSecretMutationValue.safeParse({ receipt, replay: true, temporaryPassword: 'a'.repeat(12) }).success, false)
  assert.equal(accountSecretMutationValue.safeParse({ receipt, replay: true, temporaryPassword: null }).success, true)
})

test('existing grants survive rotation and forced change while new product work requires change completion', () => {
  assert.doesNotThrow(() => assertActiveAccount(current))
  assert.throws(() => assertProductLoginAllowed(current), { status: 403, code: 'password_change_required' })
  assert.throws(() => assertActiveAccount({ ...current, enabled: false }), { status: 401, code: 'account_disabled' })
  assert.throws(() => assertActiveAccount({ ...current, enabled: false, deletedAt: new Date() }),
    { status: 401, code: 'account_deleted' })
  assert.throws(() => assertAccountAdministrator({ ...current, passwordChangeRequired: false }),
    { status: 403, code: 'account_forbidden' })
  assert.doesNotThrow(() => assertAccountAdministrator({ ...current, role: 'ADMIN', passwordChangeRequired: false }))
})

const privateDir = process.env.PE_ACCOUNT_TEST_PRIVATE_DIR
test('V25 preserves legacy state and user locks exclude disable and stale browser credentials',
  { skip: !privateDir, timeout: 30000 }, async () => {
    const source = new URL((await readFile(join(privateDir!, 'database-url'), 'utf8')).trim())
    const name = `pe_account_e1_${randomBytes(10).toString('hex')}`
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres'
    const admin = new Pool({ connectionString: adminUrl.href, max: 2 })
    const testUrl = new URL(source); testUrl.pathname = `/${name}`
    const pool = new Pool({ connectionString: testUrl.href, max: 6 })
    let created = false
    try {
      await admin.query(`CREATE DATABASE "${name}"`); created = true
      await pool.query(migrations.schema)
      await pool.query('INSERT INTO pe_schema(version) VALUES(1)')
      for (let version = 2; version <= 24; version++) {
        const step = migrations[`schemaV${version}` as keyof typeof migrations]
        assert.equal(typeof step, 'string')
        await pool.query(String(step))
      }
      const original = { model: 'legacy-model', maxTokens: 64, revision: 7 }
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [userId, 'LegacyName', 'legacy-hash-preserved', original])
      await pool.query('INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$3,64,false)',
        [userId, 'legacy-model', 'Legacy Model'])
      const token = randomBytes(32).toString('base64url')
      const digest = createHash('sha256').update(token).digest('hex')
      await pool.query("INSERT INTO pe_credentials(digest,user_id,audience,expires_at) VALUES($1,$2,'agent',now()+interval '1 hour')",
        [digest, userId])
      await initializeDatabase(pool)
      await initializeDatabase(pool)
      assert.equal((await pool.query('SELECT version FROM pe_schema')).rows[0].version, 25)
      assert.deepEqual((await pool.query('SELECT id,username,password_hash,settings,display_name,role,enabled,account_revision,credential_version,password_change_required FROM pe_users')).rows,
        [{ id: userId, username: 'LegacyName', password_hash: 'legacy-hash-preserved', settings: original,
          display_name: 'LegacyName', role: 'USER', enabled: true, account_revision: 1, credential_version: 1, password_change_required: false }])
      assert.equal((await pool.query('SELECT enabled FROM pe_user_models')).rows[0].enabled, false)
      await transaction(pool, async client => {
        assert.equal((await requireBrowserAccount(client, token)).userId, userId)
      })
      await assert.rejects(transaction(pool, client => requireBrowserAccount(client, token, { audience: 'account' })),
        { status: 401, code: 'account_unauthorized' })
      await pool.query('UPDATE pe_users SET credential_version=2,password_change_required=true WHERE id=$1', [userId])
      await transaction(pool, async client => { assert.equal((await requireActiveAccount(client, userId)).credentialVersion, 2) })
      await assert.rejects(transaction(pool, client => requireBrowserAccount(client, token)), { status: 401, code: 'account_unauthorized' })
      await pool.query("UPDATE pe_credentials SET credential_version=2,audience='account' WHERE digest=$1", [digest])
      await assert.rejects(transaction(pool, client => requireBrowserAccount(client, token, { audience: 'account' })),
        { status: 403, code: 'password_change_required' })
      await transaction(pool, async client => {
        assert.equal((await requireBrowserAccount(client, token, { audience: 'account', allowPasswordChangeRequired: true })).userId, userId)
      })
      const admission = await pool.connect()
      const disabling = await pool.connect()
      try {
        await admission.query('BEGIN')
        await requireActiveAccount(admission, userId)
        await disabling.query('BEGIN')
        await disabling.query("SET LOCAL lock_timeout='100ms'")
        await assert.rejects(disabling.query('UPDATE pe_users SET enabled=false WHERE id=$1', [userId]), { code: '55P03' })
        await disabling.query('ROLLBACK')
        await admission.query('COMMIT')
      } finally { admission.release(); disabling.release() }
      await pool.query('UPDATE pe_users SET enabled=false,deleted_at=now() WHERE id=$1', [userId])
      await assert.rejects(transaction(pool, client => requireActiveAccount(client, userId)), { status: 401, code: 'account_deleted' })
      await assert.rejects(pool.query('UPDATE pe_users SET deleted_at=NULL WHERE id=$1', [userId]), /tombstone is immutable/u)
      await assert.rejects(pool.query('DELETE FROM pe_users WHERE id=$1', [userId]), /requires a tombstone/u)
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING',
        [randomUUID(), 'LegacyName', 'replacement', original])
      assert.equal((await pool.query('SELECT password_hash,enabled FROM pe_users WHERE id=$1', [userId])).rows[0].password_hash, 'legacy-hash-preserved')
    } finally {
      await pool.end()
      if (created) await admin.query(`DROP DATABASE "${name}"`)
      await admin.end()
    }
  })
