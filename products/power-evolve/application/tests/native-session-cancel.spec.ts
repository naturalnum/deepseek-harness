/** Native active-turn cancellation preserves durable pending input in real PostgreSQL. */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { requestId, sessionId } from '../src/contracts.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('native stop while idle preserves both pending inputs and their receipts for later execution', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const first = requestId.parse(randomUUID()), second = requestId.parse(randomUUID())
    await tasks.accept(alice.user, session.sessionId, first, 'first pending input', alice.token)
    await tasks.accept(alice.user, session.sessionId, second, 'second pending input', alice.token)
    const before = (await pool.query<Record<string, unknown>>('SELECT * FROM pe_operations WHERE session_id=$1 ORDER BY created_at,id', [session.sessionId])).rows
    const receipts = (await pool.query<Record<string, unknown>>('SELECT * FROM pe_native_prompt_inputs WHERE session_id=$1 ORDER BY request_id', [session.sessionId])).rows
    expect(await tasks.cancelActive(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
    expect(await tasks.cancelActive(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
    expect((await pool.query<Record<string, unknown>>('SELECT * FROM pe_operations WHERE session_id=$1 ORDER BY created_at,id', [session.sessionId])).rows).toEqual(before)
    expect((await pool.query<Record<string, unknown>>('SELECT * FROM pe_native_prompt_inputs WHERE session_id=$1 ORDER BY request_id', [session.sessionId])).rows).toEqual(receipts)
    for (const id of [first, second]) {
      const grant = await tasks.claim(randomUUID())
      if (!grant) throw new Error('Expected the retained pending input')
      expect(grant.requestId).toBe(id)
      expect(await tasks.renew(grant.token)).toEqual({ cancelRequested: false })
      await tasks.finish(grant.token, 'completed', null)
    }
    expect(await tasks.claim(randomUUID())).toBeNull()
  }))

for (const completed of [false, true]) {
  test(`native stop cancels the active turn, preserves later input and retains its ${completed ? 'completed' : 'aborted'} outcome`, () =>
    cloudFixture(async ({ pool, alice }) => {
      const tasks = new TaskStore(pool, limits)
      const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
      const first = requestId.parse(randomUUID()), second = requestId.parse(randomUUID())
      await tasks.accept(alice.user, session.sessionId, first, 'active turn', alice.token)
      const grant = await tasks.claim(randomUUID())
      if (!grant) throw new Error('Expected the active turn')
      await tasks.accept(alice.user, session.sessionId, second, 'retained pending input', alice.token)
      const pending = (await pool.query<Record<string, unknown>>('SELECT * FROM pe_operations WHERE session_id=$1 AND request_id=$2', [session.sessionId, second])).rows
      const receipts = (await pool.query<Record<string, unknown>>('SELECT * FROM pe_native_prompt_inputs WHERE session_id=$1 ORDER BY request_id', [session.sessionId])).rows
      expect(await tasks.cancelActive(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
      expect(await tasks.cancelActive(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
      expect(await tasks.renew(grant.token)).toEqual({ cancelRequested: true })
      expect(await tasks.claim(randomUUID())).toBeNull()
      expect((await pool.query<Record<string, unknown>>('SELECT * FROM pe_operations WHERE session_id=$1 AND request_id=$2', [session.sessionId, second])).rows).toEqual(pending)
      expect((await pool.query<Record<string, unknown>>('SELECT * FROM pe_native_prompt_inputs WHERE session_id=$1 ORDER BY request_id', [session.sessionId])).rows).toEqual(receipts)
      await tasks.finish(grant.token, completed ? 'completed' : 'failed', completed ? null : 'turn_aborted')
      expect((await pool.query<{ state: string; error_code: string | null }>('SELECT state,error_code FROM pe_operations WHERE id=$1', [grant.operationId])).rows)
        .toEqual([{ state: completed ? 'completed' : 'failed', error_code: completed ? null : 'turn_user' }])
      const next = await tasks.claim(randomUUID())
      if (!next) throw new Error('Expected the retained input after active turn settlement')
      expect(next.requestId).toBe(second)
      expect(await tasks.renew(next.token)).toEqual({ cancelRequested: false })
    }))
}

test('native stop acknowledges an idle empty Session without creating work', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    expect(await tasks.cancelActive(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
    expect(await tasks.cancelActive(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
    expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations')).rows).toEqual([{ count: 0 }])
  }))

test('native stop rejects foreign, missing, mismatched and revoked authority without changing pending input', () =>
  cloudFixture(async ({ pool, alice, bob, identities }) => {
    const tasks = new TaskStore(pool, limits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'pending owner input', alice.token)
    const before = (await pool.query<Record<string, unknown>>('SELECT * FROM pe_operations WHERE session_id=$1', [session.sessionId])).rows
    await expect(tasks.cancelActive(bob.user, session.sessionId, bob.token)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
    await expect(tasks.cancelActive(alice.user, sessionId.parse(randomUUID()), alice.token)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
    await expect(tasks.cancelActive(alice.user, session.sessionId, bob.token)).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    await identities.logout(alice.token)
    await expect(tasks.cancelActive(alice.user, session.sessionId, alice.token)).rejects.toMatchObject({ status: 401 })
    expect((await pool.query<Record<string, unknown>>('SELECT * FROM pe_operations WHERE session_id=$1', [session.sessionId])).rows).toEqual(before)
  }))
