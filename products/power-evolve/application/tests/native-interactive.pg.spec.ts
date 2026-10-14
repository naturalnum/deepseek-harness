/** Actual PG separates browser-authorized interactive occupancy from accepted native model consumption. */
import { randomBytes, randomUUID } from 'node:crypto'
import { Session } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { TaskStore } from '../src/platform/tasks.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeInteractive } from '../src/platform/native-interactive.ts'
import { NativeRuntimeAuthority } from '../src/platform/native-runtime-authority.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { cleanupNativeRuntime } from '../src/platform/native-runtime-cleanup.ts'
import { cleanupExpiredNativeDerivations } from '../src/platform/native-derived-cleanup.ts'
import { readNativeRuntimePolicy } from '../src/platform/native-runtime-policy.ts'
import { transaction } from '../src/platform/database.ts'
import { headerSchema } from '../src/session-records.ts'
import { requestId } from '../src/contracts.ts'
import { nativeWriterIdentity } from '../src/native-writer-contracts.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { maxEventBytes: 524288, maxHistoryBytes: 67108864, maxHistoryEvents: 100000,
  leaseMs: 30000, maxPendingPerUser: 8, maxActivePerUser: 2 }
const secret = () => randomBytes(32).toString('base64url')

test('interactive identity, original retry and PG Writer permit only explicit native world access', () => cloudFixture(async ({ pool, alice, bob }) => {
  const tasks = new TaskStore(pool, limits), authority = new NativeRuntimeAuthority(pool)
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const service = new NativeInteractive(tasks, authority, { lifetimeMs: 30000, leaseMs: 30000, maxActivePerUser: 2 })
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token, undefined, 'standard')
  const other = await tasks.create(bob.user, requestId.parse(randomUUID()), bob.token)
  const input = { sessionId: created.sessionId, requestId: requestId.parse(randomUUID()), browserToken: alice.token, candidateToken: secret() }
  await expect(service.open(issued.token, { ...input, sessionId: other.sessionId })).rejects.toMatchObject({ status: 404 })
  await expect(service.open(issued.token, { ...input, browserToken: bob.token })).rejects.toMatchObject({ status: 403 })
  const bound = await service.open(issued.token, input)
  expect(bound).toMatchObject({ source: 'native_interactive', text: '', nativeContent: null })
  expect(await service.open(issued.token, input)).toEqual(bound)
  expect((await pool.query('SELECT * FROM pe_native_input_origins WHERE session_id=$1', [bound.sessionId])).rowCount).toBe(0)
  expect((await pool.query('SELECT * FROM pe_events WHERE session_id=$1', [bound.sessionId])).rowCount).toBe(0)
  await expect(transaction(pool, client => tasks.nativeWorldAuthorized(client, bound.token))).rejects.toMatchObject({ code: 'native_interactive_writer_lost' })
  const writers = new NativeSessionWriter(tasks, { leaseMs: 30000 }), writerToken = secret()
  const leased = await writers.acquire(bound.token, { sessionId: bound.sessionId, workerId: issued.runtimeId, token: writerToken })
  expect(await transaction(pool, client => tasks.nativeWorldAuthorized(client, bound.token))).toMatchObject({ id: bound.sessionId })
  await expect(transaction(pool, client => tasks.executionAuthorized(client, bound.token))).rejects.toMatchObject({ status: 503 })
  await tasks.accept(alice.user, bound.sessionId, requestId.parse(randomUUID()), 'real subsequent prompt', alice.token)
  expect(await tasks.claim(issued.runtimeId)).toBeNull()
  await cleanupNativeRuntime(pool, bound.token, { operationId: bound.operationId, epoch: bound.epoch,
    writer: nativeWriterIdentity.parse({ sessionId: bound.sessionId, workerId: issued.runtimeId, token: writerToken, epoch: leased.epoch }), errorCode: 'native_interactive_closed' }, limits)
  expect((await tasks.claim(issued.runtimeId))?.source).toBe('user')
}))

test.each(['runtime', 'account'] as const)('revoked %s permits only exact original cleanup and official committed-prefix closers', lost => cloudFixture(async ({ pool, alice }) => {
  const tasks = new TaskStore(pool, limits), authority = new NativeRuntimeAuthority(pool), events = new EventStore(tasks, limits)
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const service = new NativeInteractive(tasks, authority, { lifetimeMs: 30000, leaseMs: 30000, maxActivePerUser: 2 })
  const bound = await service.open(issued.token, { sessionId: created.sessionId, requestId: requestId.parse(randomUUID()), browserToken: alice.token, candidateToken: secret() })
  const writers = new NativeSessionWriter(tasks, { leaseMs: 30000 }), writerToken = secret()
  const leased = await writers.acquire(bound.token, { sessionId: bound.sessionId, workerId: issued.runtimeId, token: writerToken })
  const snapshot = await events.runtimeSnapshot(bound.token) as { header: unknown }
  const header = headerSchema.parse(snapshot.header), session = Session.create(header.id, undefined, header)
  session.append('sandbox/mode', { mode: 'workspace-write' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  await events.append(bound.token, session.snapshotEvents())
  expect(await transaction(pool, async client => readNativeRuntimePolicy(client, await tasks.authorized(client, bound.token)))).toMatchObject({ mode: 'workspace-write' })
  if (lost === 'runtime') await authority.revoke(issued.credentialId)
  else await pool.query('UPDATE pe_users SET enabled=false WHERE id=$1', [alice.user.userId])
  await expect(transaction(pool, client => tasks.nativeWorldAuthorized(client, bound.token))).rejects.toMatchObject({ status: 401 })
  await expect(events.runtimeSnapshot(bound.token)).rejects.toMatchObject({ status: 401 })
  const input = { operationId: bound.operationId, epoch: bound.epoch,
    writer: nativeWriterIdentity.parse({ sessionId: bound.sessionId, workerId: issued.runtimeId, token: writerToken, epoch: leased.epoch }), errorCode: 'native_runtime_closed' }
  await expect(cleanupNativeRuntime(pool, bound.token, { ...input, writer: { ...input.writer, token: secret() } }, limits)).rejects.toMatchObject({ code: 'native_cleanup_lost' })
  const result = await cleanupNativeRuntime(pool, bound.token, input, limits)
  expect(result.cleaned).toBe(true)
  expect(await cleanupNativeRuntime(pool, bound.token, input, limits)).toEqual(result)
  const end = await pool.query<{ event: { type: string; data: { reason: { kind: string } } } }>('SELECT event FROM pe_events WHERE session_id=$1 ORDER BY seq DESC LIMIT 1', [bound.sessionId])
  expect(end.rows[0]?.event).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
  expect((await pool.query('SELECT state,error_code FROM pe_operations WHERE id=$1', [bound.operationId])).rows).toEqual([{ state: 'failed', error_code: input.errorCode }])
  expect(await tasks.claim(issued.runtimeId)).toBeNull()
}))


test('a crashed interactive holder cannot block or replay the later accepted user prompt', () => cloudFixture(async ({ pool, alice }) => {
  const tasks = new TaskStore(pool, limits), authority = new NativeRuntimeAuthority(pool)
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const service = new NativeInteractive(tasks, authority, { lifetimeMs: 30000, leaseMs: 30000, maxActivePerUser: 2 })
  const interactive = await service.open(issued.token, { sessionId: created.sessionId, requestId: requestId.parse(randomUUID()), browserToken: alice.token, candidateToken: secret() })
  await tasks.accept(alice.user, created.sessionId, requestId.parse(randomUUID()), 'only genuine next input', alice.token)
  await pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [created.sessionId])
  const next = await tasks.claim(issued.runtimeId)
  expect(next).toMatchObject({ source: 'user', text: 'only genuine next input' })
  expect(next?.operationId).not.toBe(interactive.operationId)
  expect((await pool.query('SELECT state,error_code FROM pe_operations WHERE id=$1', [interactive.operationId])).rows)
    .toEqual([{ state: 'failed', error_code: 'native_interactive_expired' }])
}))


test('concurrent owned interactive opens acquire account update locks before credential and Session ownership', () => cloudFixture(async ({ pool, alice }) => {
  const tasks = new TaskStore(pool, limits), authority = new NativeRuntimeAuthority(pool)
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const service = new NativeInteractive(tasks, authority, { lifetimeMs: 30000, leaseMs: 30000, maxActivePerUser: 2 })
  const first = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const second = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const opened = await Promise.all([first, second].map(created => service.open(issued.token, { sessionId: created.sessionId,
    requestId: requestId.parse(randomUUID()), browserToken: alice.token, candidateToken: secret() })))
  expect(opened.map(value => value.sessionId).sort()).toEqual([first.sessionId, second.sessionId].sort())
}))


test('owned startup maintenance terminalizes expired idle holders without replaying a command or prompt', () => cloudFixture(async ({ pool, alice }) => {
  const tasks = new TaskStore(pool, limits), authority = new NativeRuntimeAuthority(pool)
  const issued = await authority.issue({ userId: alice.user.userId, runtimeId: randomUUID(), generation: 1, lifetimeMs: 60000 })
  const created = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
  const service = new NativeInteractive(tasks, authority, { lifetimeMs: 30000, leaseMs: 30000, maxActivePerUser: 2 })
  const original = await service.open(issued.token, { sessionId: created.sessionId, requestId: requestId.parse(randomUUID()), browserToken: alice.token, candidateToken: secret() })
  const owner = { userId: issued.userId, authenticate: async (client: Parameters<NativeRuntimeAuthority['authenticateInTransaction']>[0]) => {
    await authority.authenticateInTransaction(client, issued.token, undefined, 'update')
  } }
  expect(await cleanupExpiredNativeDerivations(tasks, owner, limits, 16)).toBe(0)
  await pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [created.sessionId])
  expect(await cleanupExpiredNativeDerivations(tasks, owner, limits, 16)).toBe(1)
  expect(await cleanupExpiredNativeDerivations(tasks, owner, limits, 16)).toBe(0)
  expect((await pool.query('SELECT state,error_code FROM pe_operations WHERE id=$1', [original.operationId])).rows)
    .toEqual([{ state: 'failed', error_code: 'native_derivation_expired' }])
  expect((await pool.query('SELECT * FROM pe_native_input_origins WHERE session_id=$1', [created.sessionId])).rowCount).toBe(0)
}))
