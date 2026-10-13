/** Source plane: real schema6 PG account lifecycle, without excluded Device tables or service substitutes. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { accountChangePasswordRequest, accountTargetMutationRequest, accountUpdateRequest } from '../src/account-contracts.ts'
import { requestId } from '../src/contracts.ts'
import { AccountService } from '../src/platform/accounts.ts'
import { accountManagementConfig } from '../src/platform/account-config.ts'
import { revokeAccountExecutions } from '../src/platform/account-execution-revocation.ts'
import { hashPassword } from '../src/platform/identity.ts'
import { transaction } from '../src/platform/database.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

const management = accountManagementConfig.parse({ maxUsers: 10,
  models: [{ id: 'trial-model', label: 'Trial', maxTokens: 2000 }],
  initialSettings: { model: 'trial-model', maxTokens: 1000 } })

async function cloudSchema(pool: Pool): Promise<void> {
  expect((await pool.query('SELECT family,version FROM pe_schema')).rows).toEqual([{ family: 'cloud-native', version: 6 }])
  const tables = await pool.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
  expect(tables.rows).toHaveLength(82)
  expect(tables.rows.some(row => row.name === 'pe_device_pairings' || row.name === 'pe_devices')).toBe(false)
  const database = (await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]
  assert(database)
  console.info('Account cloud regression database: ' + database.name)
}

const tasksFor = (pool: Pool) => new TaskStore(pool, {
  maxEventBytes: 524288, leaseMs: 30000, maxPendingPerUser: 8, maxActivePerUser: 1,
})

test('cloud password change revokes every browser audience while preserving the accepted native operation grant', () =>
  cloudFixture(async ({ pool, root, identities, alice, bob }) => {
    await cloudSchema(pool)
    const password = randomUUID(), nextPassword = randomUUID()
    await pool.query('UPDATE pe_users SET password_hash=$2 WHERE id=$1', [alice.user.userId, await hashPassword(password)])
    const service = new AccountService(pool, identities, { platformOrigin: 'http://127.0.0.1:12345',
      workspaceRoot: root, management, revokeExecutions: revokeAccountExecutions })
    const account = await service.login('alice', password)
    const approval = await identities.login('alice', password, 'approval')
    const tasks = tasksFor(pool)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'Accepted before password change', alice.token)
    const grant = await tasks.claim(randomUUID())
    assert(grant)
    const snapshot = () => pool.query('SELECT grant_digest,lease_epoch,lease_until FROM pe_sessions WHERE id=$1', [session.sessionId])
    const before = (await snapshot()).rows
    const input = accountChangePasswordRequest.parse({ requestId: randomUUID(), currentPassword: password, newPassword: nextPassword })
    const changed = await service.changePassword(account.token, input)
    expect(changed.replay).toBe(false)
    expect(changed.receipt.account).toMatchObject({ revision: 2, passwordChangeRequired: false })
    expect((await pool.query('SELECT credential_version FROM pe_users WHERE id=$1', [alice.user.userId])).rows)
      .toEqual([{ credential_version: 2 }])
    expect((await pool.query('SELECT count(*)::int AS count FROM pe_credentials WHERE user_id=$1', [alice.user.userId])).rows)
      .toEqual([{ count: 0 }])
    expect((await snapshot()).rows).toEqual(before)
    expect(await transaction(pool, client => tasks.authorized(client, grant.token))).toMatchObject({ id: session.sessionId })
    for (const [token, audience] of [[alice.token, 'agent'], [approval.token, 'approval'], [account.token, 'account']] as const) {
      await expect(identities.authenticate(token, audience)).rejects.toMatchObject({ status: 401 })
    }
    expect(await identities.authenticate(bob.token)).toMatchObject({ userId: bob.user.userId })
    await expect(service.login('alice', password)).rejects.toMatchObject({ status: 401 })
    const fresh = await service.login('alice', nextPassword)
    expect(await service.changePassword(fresh.token, input)).toEqual({ ...changed, replay: true })
    expect((await pool.query('SELECT credential_version,account_revision FROM pe_users WHERE id=$1', [alice.user.userId])).rows)
      .toEqual([{ credential_version: 2, account_revision: 2 }])
  }))

test('cloud disablement revokes credentials and fences running and queued native work in the account transaction', () =>
  cloudFixture(async ({ pool, root, identities, alice, bob }) => {
    await cloudSchema(pool)
    const password = randomUUID()
    await pool.query("UPDATE pe_users SET password_hash=$2,role='ADMIN' WHERE id=$1", [alice.user.userId, await hashPassword(password)])
    const service = new AccountService(pool, identities, { platformOrigin: 'http://127.0.0.1:12345',
      workspaceRoot: root, management, revokeExecutions: revokeAccountExecutions })
    const administrator = await service.login('alice', password)
    const tasks = tasksFor(pool)
    const session = await tasks.create(bob.user, requestId.parse(randomUUID()), bob.token)
    await tasks.accept(bob.user, session.sessionId, requestId.parse(randomUUID()), 'Running before disablement', bob.token)
    const grant = await tasks.claim(randomUUID())
    assert(grant)
    await tasks.accept(bob.user, session.sessionId, requestId.parse(randomUUID()), 'Queued before disablement', bob.token)
    const before = (await pool.query<{ lease_epoch: number }>('SELECT lease_epoch FROM pe_sessions WHERE id=$1', [session.sessionId])).rows[0]
    assert(before)
    const input = accountUpdateRequest.parse({ requestId: randomUUID(), userId: bob.user.userId, expectedRevision: 1, enabled: false })
    const disabled = await service.update(administrator.token, input)
    expect(disabled.receipt.account).toMatchObject({ enabled: false, revision: 2 })
    expect((await pool.query('SELECT grant_digest,lease_until,lease_epoch FROM pe_sessions WHERE id=$1', [session.sessionId])).rows)
      .toEqual([{ grant_digest: null, lease_until: null, lease_epoch: before.lease_epoch + 1 }])
    const operations = (await pool.query<{ state: string; error_code: string | null }>('SELECT state,error_code FROM pe_operations WHERE session_id=$1', [session.sessionId])).rows
    expect(operations).toHaveLength(2)
    expect(operations.every(row => row.state === 'failed' && row.error_code === 'account_disabled')).toBe(true)
    expect((await pool.query('SELECT ended_at IS NOT NULL AS ended FROM pe_attempts WHERE operation_id=$1', [grant.operationId])).rows)
      .toEqual([{ ended: true }])
    expect((await pool.query('SELECT count(*)::int AS count FROM pe_credentials WHERE user_id=$1', [bob.user.userId])).rows)
      .toEqual([{ count: 0 }])
    await expect(identities.authenticate(bob.token)).rejects.toMatchObject({ status: 401 })
    await expect(transaction(pool, client => tasks.authorized(client, grant.token))).rejects.toMatchObject({ status: 409, code: 'lease_lost' })
    expect(await service.update(administrator.token, input)).toEqual({ ...disabled, replay: true })
    expect(await service.me(administrator.token)).toMatchObject({ user: { userId: alice.user.userId, enabled: true } })
  }))

test('cloud deletion tombstones an empty account and commits its revocation receipt without Device tables', () =>
  cloudFixture(async ({ pool, root, identities, alice, bob }) => {
    await cloudSchema(pool)
    const password = randomUUID()
    await pool.query("UPDATE pe_users SET password_hash=$2,role='ADMIN' WHERE id=$1", [alice.user.userId, await hashPassword(password)])
    const service = new AccountService(pool, identities, { platformOrigin: 'http://127.0.0.1:12345',
      workspaceRoot: root, management, revokeExecutions: revokeAccountExecutions })
    const administrator = await service.login('alice', password)
    const input = accountTargetMutationRequest.parse({ requestId: randomUUID(), userId: bob.user.userId, expectedRevision: 1 })
    const removed = await service.remove(administrator.token, input)
    expect(removed.receipt.account).toMatchObject({ enabled: false, revision: 2 })
    expect(removed.receipt.account.deletedAt).not.toBeNull()
    expect((await pool.query('SELECT credential_version,deleted_at IS NOT NULL AS deleted FROM pe_users WHERE id=$1', [bob.user.userId])).rows)
      .toEqual([{ credential_version: 2, deleted: true }])
    expect((await pool.query('SELECT count(*)::int AS count FROM pe_credentials WHERE user_id=$1', [bob.user.userId])).rows)
      .toEqual([{ count: 0 }])
    await expect(identities.authenticate(bob.token)).rejects.toMatchObject({ status: 401 })
    expect(await service.remove(administrator.token, input)).toEqual({ ...removed, replay: true })
    expect(await service.receipt(administrator.token, input.requestId)).toEqual({ receipt: removed.receipt })
    expect(await service.me(administrator.token)).toMatchObject({ user: { userId: alice.user.userId, enabled: true } })
  }))
