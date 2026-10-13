/** Credential authority under actual PostgreSQL SHARE and UPDATE lock waits. */
import { expect, test } from 'vitest'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { digest } from '../src/platform/identity.ts'
import { transaction } from '../src/platform/database.ts'
import { cloudFixture } from './cloud-fixture.ts'

for (const credentialLock of ['share', 'update'] as const) {
  test(`a credential ${credentialLock} lock wait cannot authorize a bearer after its expiry`, () =>
    cloudFixture(async ({ pool, alice }) => {
      const hashed = digest(alice.token)
      await pool.query("UPDATE pe_credentials SET expires_at=clock_timestamp()+interval '2 seconds' WHERE digest=$1", [hashed])
      const blocker = await pool.connect(), waiter = await pool.connect()
      let pending: Promise<{ allowed: boolean; error?: unknown }> | undefined
      try {
        const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
        const waiterPid = (await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
        if (blockerPid === undefined || waiterPid === undefined) throw new Error('Expected real PostgreSQL backend identities')
        expect(blockerPid).not.toBe(waiterPid)
        await blocker.query('BEGIN')
        await blocker.query('SELECT digest FROM pe_credentials WHERE digest=$1 FOR UPDATE', [hashed])
        await waiter.query('BEGIN')
        pending = requireBrowserAccount(waiter, alice.token, { lock: 'update', credentialLock })
          .then(() => ({ allowed: true }), (error: unknown) => ({ allowed: false, error }))
        await expect.poll(async () => {
          const result = await pool.query<{ waiting: boolean }>(`SELECT wait_event_type='Lock'
            AND $2=ANY(pg_blocking_pids(pid)) AND strpos(query,'FROM pe_credentials')>0 AS waiting
            FROM pg_stat_activity WHERE pid=$1`, [waiterPid, blockerPid])
          return result.rows[0]?.waiting
        }, { timeout: 10_000, interval: 10 }).toBe(true)
        await expect.poll(async () => (await blocker.query<{ expired: boolean }>(
          'SELECT expires_at<=clock_timestamp() AS expired FROM pe_credentials WHERE digest=$1', [hashed])).rows[0]?.expired,
        { timeout: 10_000, interval: 10 }).toBe(true)
        await blocker.query('COMMIT')
        const outcome = await pending
        expect(outcome.allowed).toBe(false)
        expect(outcome.error).toMatchObject({ status: 401, code: 'account_unauthorized' })
      } finally {
        try { await blocker.query('ROLLBACK') }
        finally {
          blocker.release()
          try { if (pending) await pending }
          finally {
            try { await waiter.query('ROLLBACK') }
            finally { waiter.release() }
          }
        }
      }
    }))
}

test('current authority accepts the intended audience and refuses rotation, a different audience and disabled accounts', () =>
  cloudFixture(async ({ pool, alice }) => {
    const authorize = () => transaction(pool, client => requireBrowserAccount(client, alice.token))
    expect(await authorize()).toMatchObject({ userId: alice.user.userId, enabled: true, credentialVersion: 1 })
    await expect(transaction(pool, client => requireBrowserAccount(client, alice.token, { audience: 'approval' })))
      .rejects.toMatchObject({ status: 401, code: 'account_unauthorized' })
    await pool.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [alice.user.userId])
    await expect(authorize()).rejects.toMatchObject({ status: 401, code: 'account_unauthorized' })
    await pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [alice.user.userId])
    await expect(authorize()).rejects.toMatchObject({ status: 401, code: 'account_disabled' })
  }))
