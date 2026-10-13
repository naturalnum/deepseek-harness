/** Real task cancellation, account capacity, catalog pagination and frozen skill selection. */
import { createHash, randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { requestId, workspaceId, sessionId } from '../src/contracts.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { SkillService } from '../src/platform/skills.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }

test('canceling queued work stops only its first input while a later request remains independently claimable', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const first = requestId.parse(randomUUID()), second = requestId.parse(randomUUID())
    await tasks.accept(alice.user, session.sessionId, first, 'cancel oldest queued input', alice.token)
    await tasks.accept(alice.user, session.sessionId, second, 'independent later input', alice.token)
    expect(await tasks.cancel(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
    expect((await pool.query<{ request_id: string; state: string; error_code: string | null; ended: boolean }>(
      `SELECT request_id,state,error_code,completed_at IS NOT NULL AS ended FROM pe_operations
       WHERE session_id=$1 ORDER BY created_at,id`, [session.sessionId])).rows).toEqual([
      { request_id: first, state: 'failed', error_code: 'turn_user', ended: true },
      { request_id: second, state: 'queued', error_code: null, ended: false },
    ])
    const next = await new TaskStore(pool, limits).claim(randomUUID())
    if (!next) throw new Error('Expected the later uncancelled input')
    expect(next.requestId).toBe(second)
    expect(await tasks.renew(next.token)).toEqual({ cancelRequested: false })
  }))

for (const completed of [false, true]) {
  test(`canceling a running task ${completed ? 'preserves the Host reported completed outcome' : 'settles its observed abort as turn_user'} and leaves later input queued`, () =>
    cloudFixture(async ({ pool, alice }) => {
      const tasks = new TaskStore(pool, limits)
      const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
      const first = requestId.parse(randomUUID()), second = requestId.parse(randomUUID())
      await tasks.accept(alice.user, session.sessionId, first, 'running cancellation', alice.token)
      const grant = await tasks.claim(randomUUID())
      if (!grant) throw new Error('Expected the running turn')
      await tasks.accept(alice.user, session.sessionId, second, 'later independent user input', alice.token)
      expect(await tasks.cancel(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
      expect(await tasks.cancel(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
      expect(await tasks.renew(grant.token)).toEqual({ cancelRequested: true })
      await tasks.finish(grant.token, completed ? 'completed' : 'failed', completed ? null : 'turn_aborted')
      expect((await pool.query<{ request_id: string; state: string; error_code: string | null; chainStopped: boolean }>(
        `SELECT request_id,state,error_code,mcp_chain_cancelled_at IS NOT NULL AS "chainStopped"
         FROM pe_operations WHERE session_id=$1 ORDER BY created_at,id`, [session.sessionId])).rows).toEqual([
        { request_id: first, state: completed ? 'completed' : 'failed', error_code: completed ? null : 'turn_user', chainStopped: true },
        { request_id: second, state: 'queued', error_code: null, chainStopped: false },
      ])
      expect((await pool.query<{ ended: boolean }>('SELECT ended_at IS NOT NULL AS ended FROM pe_attempts WHERE operation_id=$1',
        [grant.operationId])).rows).toEqual([{ ended: true }])
      const next = await new TaskStore(pool, limits).claim(randomUUID())
      if (!next) throw new Error('Expected the later request after original settlement')
      expect(next.requestId).toBe(second)
      expect(await tasks.renew(next.token)).toEqual({ cancelRequested: false })
    }))
}

test('canceling an empty owned Session acknowledges no work while foreign and absent Sessions are refused', () =>
  cloudFixture(async ({ pool, alice, bob }) => {
    const tasks = new TaskStore(pool, limits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    expect(await tasks.cancel(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
    expect(await tasks.cancel(alice.user, session.sessionId, alice.token)).toEqual({ accepted: true })
    await expect(tasks.cancel(bob.user, session.sessionId, bob.token)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
    await expect(tasks.cancel(alice.user, sessionId.parse(randomUUID()), alice.token))
      .rejects.toMatchObject({ status: 404, code: 'session_not_found' })
    expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations')).rows[0]?.count).toBe(0)
  }))

test('pending account capacity refuses new work without blocking identical retries or another account', () =>
  cloudFixture(async ({ pool, alice, bob }) => {
    const config = { ...limits, maxPendingPerUser: 1 }, tasks = new TaskStore(pool, config)
    const first = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const second = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const request = requestId.parse(randomUUID()), later = requestId.parse(randomUUID())
    const accepted = await tasks.accept(alice.user, first.sessionId, request, 'one pending slot', alice.token)
    await expect(tasks.accept(alice.user, second.sessionId, later, 'over pending capacity', alice.token))
      .rejects.toMatchObject({ status: 429, code: 'pending_limit' })
    expect(await tasks.accept(alice.user, first.sessionId, request, 'one pending slot', alice.token)).toEqual(accepted)
    expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_prompt_inputs WHERE session_id=$1',
      [second.sessionId])).rows[0]?.count).toBe(0)
    const other = await tasks.create(bob.user, requestId.parse(randomUUID()), bob.token)
    await tasks.accept(bob.user, other.sessionId, requestId.parse(randomUUID()), 'another account slot', bob.token)
    const running = await tasks.claim(randomUUID()), independent = await tasks.claim(randomUUID())
    if (!running || !independent) throw new Error('Expected independent account capacity')
    expect(new Set([running.userId, independent.userId])).toEqual(new Set([alice.user.userId, bob.user.userId]))
    const original = running.userId === alice.user.userId ? running : independent
    await tasks.finish(original.token, 'completed', null)
    await expect(tasks.accept(alice.user, second.sessionId, later, 'over pending capacity', alice.token)).resolves.toMatchObject({ state: 'queued' })
  }))

test('concurrent admissions to different Sessions serialize the real account pending limit', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, { ...limits, maxPendingPerUser: 1 })
    const first = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const second = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const results = await Promise.allSettled([first, second].map(session =>
      tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'one concurrent pending slot', alice.token)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(refused?.reason).toMatchObject({ status: 429, code: 'pending_limit' })
    expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations')).rows[0]?.count).toBe(1)
    expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_native_prompt_inputs')).rows[0]?.count).toBe(1)
  }))

test('two real concurrent claims cannot exceed the single active slot of one account', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, limits)
    const first = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const second = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, first.sessionId, requestId.parse(randomUUID()), 'first concurrent active claim', alice.token)
    await tasks.accept(alice.user, second.sessionId, requestId.parse(randomUUID()), 'second concurrent active claim', alice.token)
    const claimed = await Promise.all([tasks.claim(randomUUID()), tasks.claim(randomUUID())])
    expect(claimed.filter(value => value !== null)).toHaveLength(1)
    expect(claimed.filter(value => value === null)).toHaveLength(1)
    expect((await pool.query<{ state: string; attempts: number }>('SELECT state,attempts FROM pe_operations ORDER BY attempts DESC')).rows)
      .toEqual([{ state: 'running', attempts: 1 }, { state: 'queued', attempts: 0 }])
    expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_attempts')).rows[0]?.count).toBe(1)
  }))

test('active account capacity admits Bob while Alice waits, then admits Alice after her original lease is released', () =>
  cloudFixture(async ({ pool, alice, bob }) => {
    const tasks = new TaskStore(pool, limits)
    const a = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const b = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const c = await tasks.create(bob.user, requestId.parse(randomUUID()), bob.token)
    await tasks.accept(alice.user, a.sessionId, requestId.parse(randomUUID()), 'Alice active', alice.token)
    await tasks.accept(alice.user, b.sessionId, requestId.parse(randomUUID()), 'Alice waits for capacity', alice.token)
    await tasks.accept(bob.user, c.sessionId, requestId.parse(randomUUID()), 'Bob independent', bob.token)
    const first = await tasks.claim(randomUUID()), other = await tasks.claim(randomUUID())
    if (!first || !other) throw new Error('Expected two independent active users')
    expect(first.sessionId).toBe(a.sessionId)
    expect(other.sessionId).toBe(c.sessionId)
    expect(await tasks.claim(randomUUID())).toBeNull()
    expect((await pool.query<{ attempts: number; state: string }>('SELECT attempts,state FROM pe_operations WHERE session_id=$1', [b.sessionId])).rows)
      .toEqual([{ attempts: 0, state: 'queued' }])
    await tasks.finish(first.token, 'completed', null)
    const next = await tasks.claim(randomUUID())
    if (!next) throw new Error('Expected released Alice capacity')
    expect(next.sessionId).toBe(b.sessionId)
  }))

test('two active slots still serialize requests belonging to the same native Session', () =>
  cloudFixture(async ({ pool, alice }) => {
    const tasks = new TaskStore(pool, { ...limits, maxActivePerUser: 2 })
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const first = requestId.parse(randomUUID()), second = requestId.parse(randomUUID())
    await tasks.accept(alice.user, session.sessionId, first, 'first same Session input', alice.token)
    await tasks.accept(alice.user, session.sessionId, second, 'second same Session input', alice.token)
    const original = await tasks.claim(randomUUID())
    if (!original) throw new Error('Expected first same Session operation')
    expect(original.requestId).toBe(first)
    expect(await tasks.claim(randomUUID())).toBeNull()
    await tasks.finish(original.token, 'completed', null)
    const next = await tasks.claim(randomUUID())
    if (!next) throw new Error('Expected the serialized second operation')
    expect(next.requestId).toBe(second)
    expect(next.epoch).toBe(original.epoch + 1)
  }))

test('Session creation reuses its accepted workspace identity and refuses a conflicting or foreign workspace', () =>
  cloudFixture(async ({ pool, alice, bob }) => {
    const tasks = new TaskStore(pool, limits), request = requestId.parse(randomUUID())
    const original = await tasks.create(alice.user, request, alice.token)
    const bound = (await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM pe_sessions WHERE id=$1', [original.sessionId])).rows[0]?.workspace_id
    if (bound === undefined) throw new Error('Expected the accepted Workspace binding')
    expect(await tasks.create(alice.user, request, alice.token)).toEqual(original)
    expect(await tasks.create(alice.user, request, alice.token, workspaceId.parse(bound))).toEqual(original)
    const other = workspaceId.parse(randomUUID()), foreign = workspaceId.parse(randomUUID())
    await pool.query("INSERT INTO pe_workspaces(id,user_id,title,is_default) VALUES($1,$2,'Other owned',false),($3,$4,'Foreign',false)",
      [other, alice.user.userId, foreign, bob.user.userId])
    await expect(tasks.create(alice.user, request, alice.token, other)).rejects.toMatchObject({ status: 409, code: 'request_id_conflict' })
    await expect(tasks.create(alice.user, requestId.parse(randomUUID()), alice.token, foreign))
      .rejects.toMatchObject({ status: 404, code: 'workspace_not_found' })
    expect((await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_sessions')).rows[0]?.count).toBe(1)
    expect(await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token, other)).toHaveProperty('sessionId')
  }))

test('the task catalog returns only owned Sessions and the first durable input title with bounded pagination', () =>
  cloudFixture(async ({ pool, alice, bob }) => {
    const tasks = new TaskStore(pool, limits)
    const owned = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const foreign = await tasks.create(bob.user, requestId.parse(randomUUID()), bob.token)
    await tasks.accept(alice.user, owned.sessionId, requestId.parse(randomUUID()), '表'.repeat(100), alice.token)
    await tasks.accept(alice.user, owned.sessionId, requestId.parse(randomUUID()), 'later input must not replace the catalog title', alice.token)
    await tasks.accept(bob.user, foreign.sessionId, requestId.parse(randomUUID()), 'foreign catalog title', bob.token)
    expect(await new TaskStore(pool, limits).list(alice.user, 0, 1)).toMatchObject({ offset: 0, limit: 1,
      items: [{ sessionId: owned.sessionId, eventCount: 0, title: '表'.repeat(80) }] })
    expect(await tasks.list(alice.user, 1, 1)).toEqual({ items: [], offset: 1, limit: 1 })
    expect(await tasks.list(bob.user, 0, 1)).toMatchObject({ items: [{ sessionId: foreign.sessionId, title: 'foreign catalog title' }] })
  }))

test('selectedSkills reads the original durable selection after eligibility changes and refuses a settled grant', () =>
  cloudFixture(async ({ pool, root, alice, bob }) => {
    const tasks = new TaskStore(pool, limits), skills = new SkillService(pool, root)
    await skills.init()
    const alpha = randomUUID(), zeta = randomUUID(), added = randomUUID(), foreign = randomUUID()
    const instructions = 'Original private instructions'
    await skills.install(alice.user, zeta, 'Zeta', 'Zeta original', instructions)
    await skills.install(alice.user, alpha, 'Alpha', 'Alpha original', instructions)
    await skills.install(bob.user, foreign, 'Bob only', 'Bob private', instructions)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'freeze skill selection', alice.token)
    await skills.toggle(alice.user, alpha, false)
    await skills.install(alice.user, added, 'New', 'New only after acceptance', instructions)
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'new skill eligibility', alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Expected original frozen skill grant')
    const expected = [[alpha, 'Alpha'], [zeta, 'Zeta']].map(([id, name]) => ({ skillId: id, name, description: `${name} original`,
      digest: createHash('sha256').update(instructions).digest('hex'), revision: 1, kind: 'text', version: null, packageDigest: null, manifestDigest: null }))
    expect(grant.selection).toEqual(expected)
    expect(await new TaskStore(pool, limits).selectedSkills(grant.token)).toEqual({ userId: alice.user.userId,
      target: { kind: 'cloud' }, selection: expected })
    expect((await pool.query<{ skill_selection: unknown }>('SELECT skill_selection FROM pe_operations WHERE id=$1', [grant.operationId])).rows[0]?.skill_selection)
      .toEqual(expected)
    await tasks.finish(grant.token, 'completed', null)
    await expect(tasks.selectedSkills(grant.token)).rejects.toMatchObject({ status: 409, code: 'lease_lost' })
    const next = await tasks.claim(randomUUID())
    if (!next) throw new Error('Expected current skill eligibility for the later request')
    expect(next.selection.map(skill => skill.skillId)).toEqual([added, zeta])
  }))
