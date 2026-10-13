/** Real PG SSH admission and cancellation; synthetic Runner identities exercise store fences without a network execution. */
import { randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Pool } from 'pg'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { cloudFixture } from './cloud-fixture.ts'
import { seedNewUser } from '../src/platform/account-settings.ts'
import { hashPassword, type IdentityService } from '../src/platform/identity.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { SshConnectionService } from '../src/platform/ssh.ts'
import { SshExecuteService } from '../src/platform/ssh-execute.ts'
import { SshCallStore, type SshCallLease } from '../src/platform/ssh-calls.ts'
import { SshRunnerOrchestrator, type SshRunnerHandle } from '../src/platform/ssh-runner.ts'
import { sshConnectionDeleteRequest, sshConnectionToggleRequest, sshConnectionUpdateRequest,
  sshCredentialTicketRequest } from '../src/ssh-management-contracts.ts'
import { requestId } from '../src/contracts.ts'
import { requireBrowserAccount } from '../src/platform/account-authority.ts'
import { transaction } from '../src/platform/database.ts'
import { requestSessionActivityStopInTransaction } from '../src/platform/native-session-activity-stop.ts'

type Login = Awaited<ReturnType<IdentityService['login']>>
type Credential = { token: string; audience: 'agent' | 'approval' }
type StoredSshAction = Record<string, unknown> & { session_id: SessionId; updated_at: Date }
const taskLimits = { maxEventBytes: 524_288, leaseMs: 60_000, maxPendingPerUser: 8, maxActivePerUser: 1, sshEnabled: true }
const hostKey = `SHA256:${'A'.repeat(43)}`
const destination = { ip: '192.0.2.50', port: 22, username: 'agent', hostKeySha256: hostKey }
const handle = (callId: string): SshRunnerHandle => ({ callId, podUid: randomUUID(), instanceId: randomUUID(), destination })
const leaseFor = (row: Awaited<ReturnType<SshCallStore['claim']>>): SshCallLease => {
  if (!row || !row.lease_owner) throw new Error('Owned SSH lease required')
  return { callId: row.id, owner: row.lease_owner, epoch: row.lease_epoch }
}

async function sshFixture(run: (fixture: {
  pool: Pool
  tasks: TaskStore
  service: SshExecuteService
  calls: SshCallStore
  connections: SshConnectionService
  owner: Login
  foreign: Login
  approval: Credential
  agent: Credential
  action: Awaited<ReturnType<SshExecuteService['propose']>>
  connectionId: string
  logout: () => Promise<void>
}) => Promise<void>): Promise<void> {
  return cloudFixture(async ({ pool, identities, bob }) => {
    const password = randomUUID(), key = randomBytes(32).toString('base64url')
    await seedNewUser(pool, 'ssh-owner', await hashPassword(password), { model: 'trial-model', maxTokens: 1000, revision: 1 })
    const owner = await identities.login('ssh-owner', password), approval = await identities.login('ssh-owner', password, 'approval')
    const connections = new SshConnectionService(pool, key, '192.0.2.50:22')
    const bytes = Buffer.from(JSON.stringify({ formatVersion: 2, password: randomUUID() }))
    const ticket = await connections.issueManagedTicket(owner.user, sshCredentialTicketRequest.parse({ purpose: 'create',
      requestId: randomUUID(), sizeBytes: bytes.length, configuration: { displayName: 'PG SSH fixture', host: destination.ip,
        port: destination.port, username: destination.username, hostKeySha256: hostKey, workingDirectory: null,
        authentication: { kind: 'password', password: 'replace' }, enabled: true } }), 'https://platform.invalid')
    const connection = (await connections.upload(ticket.ticket, Readable.from([bytes]))).item
    bytes.fill(0)
    const tasks = new TaskStore(pool, taskLimits), calls = new SshCallStore(pool)
    let networkRequests = 0
    const forbidden = (): never => { networkRequests++; throw new Error('SSH PG fixture cannot call Kubernetes or Runner') }
    const runner = new SshRunnerOrchestrator({ call: async () => forbidden(), resourcePath: forbidden, proxyPath: forbidden }, {
      namespace: 'unused-pg-fixture', image: 'fixture.invalid/connector', runtimeClassName: 'gvisor', controlKey: randomBytes(32).toString('hex'),
      readyTimeoutMs: 1000, platformIngressCidrs: ['192.0.2.51/32'], forbiddenProbe: { ip: '192.0.2.52', port: 8080 },
      proveForbiddenListener: async () => forbidden(),
    })
    const service = new SshExecuteService(tasks, calls, connections, runner, key, randomUUID(), 60_000, 100)
    try {
      const session = await tasks.create(owner.user, requestId.parse(randomUUID()), owner.token)
      await tasks.accept(owner.user, session.sessionId, requestId.parse(randomUUID()), 'SSH approval fixture', owner.token)
      const grant = await tasks.claim(randomUUID())
      expect(grant).not.toBeNull()
      const action = await service.propose(grant!.token, randomUUID(), connection.connectionId, connection.revision,
        connection.credentialRevision, 'printf exact')
      await tasks.finish(grant!.token, 'completed', null)
      await run({ pool, tasks, service, calls, connections, owner, foreign: bob, action, connectionId: connection.connectionId,
        approval: { token: approval.token, audience: 'approval' }, agent: { token: owner.token, audience: 'agent' },
        logout: () => identities.logout(approval.token) })
    } finally {
      await service.close()
      expect(networkRequests).toBe(0)
    }
  })
}

test('fresh SSH admission rechecks the stop purpose in its own write transaction', () => sshFixture(async (f) => {
  const session = await f.tasks.create(f.owner.user, requestId.parse(randomUUID()), f.owner.token)
  await f.tasks.accept(f.owner.user, session.sessionId, requestId.parse(randomUUID()), 'new SSH origin', f.owner.token)
  const grant = await f.tasks.claim(randomUUID())
  if (!grant || grant.sessionId !== session.sessionId || !grant.sshConnections[0]) throw new Error('Fresh SSH operation not claimed')
  const selected = grant.sshConnections[0]
  await transaction(f.pool, async (client) => {
    await requireBrowserAccount(client, f.owner.token, { lock: 'update' })
    await f.tasks.requestArchiveStopInTransaction(client, f.owner.user, session.sessionId)
  })
  await expect(f.service.propose(grant.token, randomUUID(), selected.connectionId, selected.revision,
    selected.credentialRevision, 'printf forbidden')).rejects.toMatchObject({ code: 'native_session_archived' })
  expect((await f.pool.query('SELECT id FROM pe_ssh_execute_actions WHERE session_id=$1', [session.sessionId])).rows).toEqual([])
  expect((await f.service.status(f.owner.user, f.action.actionId)).state).toBe('pending')
}))

test.each(['pending', 'approved'] as const)('archival activity stop cancels original SSH %s without dispatch or a business follow-up', state => sshFixture(async (f) => {
  if (state === 'approved') await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const original = (await f.pool.query<StoredSshAction>('SELECT * FROM pe_ssh_execute_actions WHERE id=$1', [f.action.actionId])).rows[0]!
  await transaction(f.pool, async (client) => {
    await requireBrowserAccount(client, f.owner.token, { lock: 'update' })
    await f.tasks.requestArchiveStopInTransaction(client, f.owner.user, original.session_id)
    await requestSessionActivityStopInTransaction(client, f.owner.user, original.session_id)
  })
  const stored = (await f.pool.query<StoredSshAction>('SELECT * FROM pe_ssh_execute_actions WHERE id=$1', [f.action.actionId])).rows[0]!
  expect(stored).toEqual({ ...original, state: 'cancelled', updated_at: stored.updated_at })
  if (state === 'approved') expect(await f.calls.get(f.owner.user, f.action.actionId)).toMatchObject({
    state: 'cancelled', cancel_requested: true, pod_uid: null, runner_instance_id: null, dispatch_digest: null,
  })
  else expect((await f.pool.query('SELECT id FROM pe_ssh_calls WHERE id=$1', [f.action.actionId])).rows).toEqual([])
  expect((await f.pool.query('SELECT id FROM pe_operations WHERE source_ssh_execute_action_id=$1', [f.action.actionId])).rows).toEqual([])
}))

test('archival activity stop preserves original SSH dispatch identity for uncertain reconciliation', () => sshFixture(async (f) => {
  await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const lease = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
  await f.calls.startPreparing(lease)
  const original = handle(lease.callId)
  await f.calls.markReady(lease, original)
  const dispatched = await f.calls.markDispatchIntent(lease, 'a'.repeat(64))
  const action = (await f.pool.query<{ session_id: SessionId }>(
    'SELECT session_id FROM pe_ssh_execute_actions WHERE id=$1', [f.action.actionId])).rows[0]!
  await transaction(f.pool, async (client) => {
    await requireBrowserAccount(client, f.owner.token, { lock: 'update' })
    await f.tasks.requestArchiveStopInTransaction(client, f.owner.user, action.session_id)
    await requestSessionActivityStopInTransaction(client, f.owner.user, action.session_id)
  })
  const stopped = await f.calls.get(f.owner.user, lease.callId)
  expect(stopped).toEqual({ ...dispatched, state: 'uncertain', cancel_requested: true,
    lease_until: stopped.lease_until, updated_at: stopped.updated_at })
  expect((await f.service.status(f.owner.user, f.action.actionId)).state).toBe('uncertain')
  await expect(f.calls.assertDispatchLease(lease)).rejects.toMatchObject({ status: 409 })
  expect((await f.pool.query('SELECT id FROM pe_operations WHERE source_ssh_execute_action_id=$1', [f.action.actionId])).rows).toEqual([])
}))

test.each(['pending', 'approved'] as const)('SSH %s cancellation waiting on the account lock rejects newly revoked credentials', state => sshFixture(async (f) => {
  if (state === 'approved') await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const blocker = await f.pool.connect()
  let cancellation: Promise<unknown> | undefined
  try {
    await blocker.query('BEGIN')
    const pid = (await blocker.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await blocker.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.owner.user.userId])
    cancellation = f.service.cancel(f.owner.user, f.action.actionId, f.approval)
    const outcome = cancellation.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
    await expect.poll(async () => (await f.pool.query<{ readonly waiting: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0]!.waiting)
      .toBe(true)
    await blocker.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [f.owner.user.userId])
    await blocker.query('COMMIT')
    expect((await outcome).error).toMatchObject({ status: 401 })
    expect((await f.pool.query<{ readonly state: string }>('SELECT state FROM pe_ssh_execute_actions WHERE id=$1', [f.action.actionId])).rows[0]!.state).toBe(state)
    expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_ssh_execute_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(0)
    if (state === 'approved') expect((await f.calls.get(f.owner.user, f.action.actionId)).state).toBe('accepted')
  } finally {
    try { await blocker.query('ROLLBACK') } finally { blocker.release() }
    await cancellation?.catch(() => undefined)
  }
}))

test.each(['agent', 'approval'] as const)('SSH %s owner cancellation is idempotent and cannot grant approval', audience => sshFixture(async (f) => {
  const credential = audience === 'agent' ? f.agent : f.approval
  if (audience === 'agent') await expect(f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.agent.token))
    .rejects.toMatchObject({ status: 401 })
  const receipts = await Promise.all(Array.from({ length: 4 }, () => f.service.cancel(f.owner.user, f.action.actionId, credential)))
  for (const receipt of receipts) expect(receipt).toEqual({ ...f.action, state: 'cancelled' })
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_ssh_calls')).rows[0]!.n).toBe(0)
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_ssh_execute_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(1)
}))

test('SSH cancellation rejects wrong audience, forged owner and logged-out credentials including terminal retries', () => sshFixture(async (f) => {
  await expect(f.service.cancel(f.owner.user, f.action.actionId, { token: f.agent.token, audience: 'approval' })).rejects.toMatchObject({ status: 401 })
  await expect(f.service.cancel(f.owner.user, f.action.actionId, { token: f.approval.token, audience: 'agent' })).rejects.toMatchObject({ status: 401 })
  await expect(f.service.cancel(f.foreign.user, f.action.actionId, f.approval)).rejects.toMatchObject({ status: 401 })
  await expect(f.service.cancel(f.foreign.user, f.action.actionId, { token: f.foreign.token, audience: 'agent' })).rejects.toMatchObject({ status: 404 })
  await expect(f.service.cancel(f.owner.user, randomUUID(), f.approval)).rejects.toMatchObject({ status: 404 })
  await f.service.cancel(f.owner.user, f.action.actionId, f.approval)
  await f.logout()
  await expect(f.service.cancel(f.owner.user, f.action.actionId, f.approval)).rejects.toMatchObject({ status: 401 })
  expect((await f.pool.query<{ readonly state: string }>('SELECT state FROM pe_ssh_execute_actions WHERE id=$1', [f.action.actionId])).rows[0]!.state).toBe('cancelled')
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_ssh_execute_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(1)
}))

test('SSH accepted-call cancellation commits one continuation while preserving the original call identity', () => sshFixture(async (f) => {
  await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const before = await f.calls.get(f.owner.user, f.action.actionId)
  const cancelled = await f.service.cancel(f.owner.user, f.action.actionId, f.agent)
  expect(cancelled).toMatchObject({ actionId: f.action.actionId, state: 'cancelled' })
  expect(await f.service.cancel(f.owner.user, f.action.actionId, f.approval)).toEqual(cancelled)
  const after = await f.calls.get(f.owner.user, f.action.actionId)
  expect(after).toMatchObject({ id: before.id, request_digest: before.request_digest, state: 'cancelled', cancel_requested: true,
    dispatch_digest: null, pod_uid: null, runner_instance_id: null })
  expect(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute')).toBeNull()
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_ssh_execute_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(1)
}))

test('SSH cancellation overlapping approval admits no dispatch and commits only one continuation', () => sshFixture(async (f) => {
  const blocker = await f.pool.connect()
  const pending: Promise<unknown>[] = []
  try {
    await blocker.query('BEGIN')
    const pid = (await blocker.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await blocker.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.owner.user.userId])
    const cancellation = f.service.cancel(f.owner.user, f.action.actionId, f.agent)
    const approval = f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
    pending.push(cancellation, approval)
    const outcomes = pending.map(work => work.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error })))
    await expect.poll(async () => (await f.pool.query<{ readonly n: number }>(`WITH RECURSIVE blocked AS (
      SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
    ) SELECT count(*)::int AS n FROM blocked`, [pid])).rows[0]!.n)
      .toBe(2)
    await blocker.query('COMMIT')
    expect((await outcomes[0]!).value).toMatchObject({ state: 'cancelled' })
    const decided = await outcomes[1]!
    if (decided.error) expect(decided.error).toMatchObject({ status: 409 })
    else expect(decided.value).toMatchObject({ state: 'approved' })
    expect((await f.pool.query<{ readonly state: string }>('SELECT state FROM pe_ssh_execute_actions WHERE id=$1', [f.action.actionId])).rows[0]!.state).toBe('cancelled')
    expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_ssh_calls WHERE dispatch_digest IS NOT NULL')).rows[0]!.n).toBe(0)
    expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_ssh_execute_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(1)
  } finally {
    try { await blocker.query('ROLLBACK') } finally { blocker.release() }
    await Promise.allSettled(pending)
  }
}))

test('SSH committed dispatch cancellation preserves its permit and remains uncertain without synthesizing a continuation', () => sshFixture(async (f) => {
  await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const lease = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
  await f.calls.startPreparing(lease)
  const original = handle(lease.callId)
  await f.calls.markReady(lease, original)
  const dispatched = await f.calls.markDispatchIntent(lease, 'a'.repeat(64))
  expect(await f.service.cancel(f.owner.user, f.action.actionId, f.agent)).toMatchObject({ state: 'uncertain', callId: lease.callId })
  expect(await f.service.cancel(f.owner.user, f.action.actionId, f.approval)).toMatchObject({ state: 'uncertain', callId: lease.callId })
  const cancelled = await f.calls.get(f.owner.user, lease.callId)
  expect(cancelled).toMatchObject({ state: 'uncertain', cancel_requested: true, pod_uid: original.podUid, runner_instance_id: original.instanceId,
    dispatch_digest: dispatched.dispatch_digest, dispatch_owner: dispatched.dispatch_owner, dispatch_epoch: dispatched.dispatch_epoch })
  await expect(f.calls.assertDispatchLease(lease)).rejects.toMatchObject({ status: 409 })
  expect((await f.pool.query<{ readonly n: number }>('SELECT count(*)::int AS n FROM pe_operations WHERE source_ssh_execute_action_id=$1', [f.action.actionId])).rows[0]!.n).toBe(0)
}))

test('SSH Runner observations and first dispatch reject changed call, instance and digest identities', () => sshFixture(async (f) => {
  await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const lease = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
  await f.calls.startPreparing(lease)
  await expect(f.calls.markReady(lease, handle(randomUUID()))).rejects.toMatchObject({ code: 'ssh_call_identity_invalid' })
  const original = handle(lease.callId)
  await f.calls.markReady(lease, original)
  await expect(f.calls.markDispatchIntent(lease, 'invalid')).rejects.toMatchObject({ code: 'ssh_dispatch_digest_invalid' })
  const dispatched = await f.calls.markDispatchIntent(lease, 'b'.repeat(64))
  await expect(f.calls.markDispatchIntent(lease, 'c'.repeat(64))).rejects.toMatchObject({ status: 409 })
  const status = { callId: lease.callId, instanceId: original.instanceId, digest: dispatched.dispatch_digest!, state: 'running' as const }
  for (const changed of [{ ...status, callId: randomUUID() }, { ...status, instanceId: randomUUID() }, { ...status, digest: 'd'.repeat(64) }]) {
    await expect(f.calls.recordStatus(lease, changed)).rejects.toMatchObject({ status: 409 })
  }
  expect(await f.calls.recordStatus(lease, status)).toMatchObject({ state: 'running', result: null })
  expect(await f.calls.get(f.owner.user, lease.callId)).toMatchObject({ dispatch_digest: dispatched.dispatch_digest,
    runner_instance_id: original.instanceId })
}))

test('SSH renewal cannot revive a lease that expired while waiting on the call lock', () => sshFixture(async (f) => {
  await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const lease = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
  await f.pool.query("UPDATE pe_ssh_calls SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1", [lease.callId])
  const blocker = await f.pool.connect()
  let renewal: Promise<void> | undefined
  try {
    await blocker.query('BEGIN')
    const pid = (await blocker.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await blocker.query('SELECT id FROM pe_ssh_calls WHERE id=$1 FOR UPDATE', [lease.callId])
    renewal = f.calls.renew(lease, 60_000)
    const outcome = renewal.then(() => ({ error: null }), (error: unknown) => ({ error }))
    await expect.poll(async () => (await f.pool.query<{ readonly waiting: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0]!.waiting)
      .toBe(true)
    await expect.poll(async () => (await blocker.query<{ readonly expired: boolean }>('SELECT lease_until<=clock_timestamp() AS expired FROM pe_ssh_calls WHERE id=$1', [lease.callId])).rows[0]!.expired)
      .toBe(true)
    await blocker.query('COMMIT')
    expect((await outcome).error).toMatchObject({ code: 'ssh_call_lease_lost' })
    expect((await f.pool.query<{ readonly expired: boolean }>('SELECT lease_until<=clock_timestamp() AS expired FROM pe_ssh_calls WHERE id=$1', [lease.callId])).rows[0]!.expired).toBe(true)
  } finally {
    try { await blocker.query('ROLLBACK') } finally { blocker.release() }
    await renewal?.catch(() => undefined)
  }
}))

test.each(['preparation', 'runner-observation', 'defer-running', 'settle-without-dispatch'] as const)(
  'SSH %s rejects a lease that expires during an unchanged call-row lock wait', phase => sshFixture(async (f) => {
    await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
    const lease = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
    const original = handle(lease.callId)
    const status = { callId: lease.callId, instanceId: original.instanceId, digest: 'e'.repeat(64), state: 'running' as const }
    if (phase === 'runner-observation' || phase === 'defer-running') {
      await f.calls.startPreparing(lease)
      await f.calls.markReady(lease, original)
      await f.calls.markDispatchIntent(lease, status.digest)
      if (phase === 'defer-running') await f.calls.recordStatus(lease, status)
    }
    const before = await f.calls.get(f.owner.user, lease.callId)
    await f.pool.query("UPDATE pe_ssh_calls SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1", [lease.callId])
    const blocker = await f.pool.connect()
    let mutation: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      const pid = (await blocker.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      await blocker.query('SELECT id FROM pe_ssh_calls WHERE id=$1 FOR UPDATE', [lease.callId])
      mutation = phase === 'preparation' ? f.calls.startPreparing(lease)
        : phase === 'runner-observation' ? f.calls.recordStatus(lease, status)
          : phase === 'defer-running' ? f.calls.deferRunning(lease, 1000)
            : f.calls.settleWithoutDispatch(lease, 'accepted', 'cancelled', null)
      const outcome = mutation.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
      await expect.poll(async () => (await f.pool.query<{ readonly waiting: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0]!.waiting)
        .toBe(true)
      await expect.poll(async () => (await blocker.query<{ readonly expired: boolean }>('SELECT lease_until<=clock_timestamp() AS expired FROM pe_ssh_calls WHERE id=$1', [lease.callId])).rows[0]!.expired)
        .toBe(true)
      await blocker.query('COMMIT')
      expect((await outcome).error).toMatchObject({ status: 409 })
      expect(await f.calls.get(f.owner.user, lease.callId)).toMatchObject({ state: before.state, lease_owner: before.lease_owner,
        lease_epoch: before.lease_epoch, runner_instance_id: before.runner_instance_id,
        dispatch_digest: before.dispatch_digest, result: null })
      expect((await f.pool.query<{ readonly expired: boolean }>('SELECT lease_until<=clock_timestamp() AS expired FROM pe_ssh_calls WHERE id=$1', [lease.callId])).rows[0]!.expired).toBe(true)
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await mutation?.catch(() => undefined)
    }
  }))

test.each(['disabled', 'deleted', 'configuration', 'credentials'] as const)(
  'SSH first dispatch rejects a connection whose %s authority changed after approval', change => sshFixture(async (f) => {
    await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
    const lease = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
    await f.calls.startPreparing(lease)
    await f.calls.markReady(lease, handle(lease.callId))
    const identity = { requestId: randomUUID(), connectionId: f.connectionId, baseRevision: 1 }
    if (change === 'disabled') await f.connections.toggleManaged(f.owner.user, sshConnectionToggleRequest.parse({ ...identity, enabled: false }))
    else if (change === 'deleted') await f.connections.remove(f.owner.user, sshConnectionDeleteRequest.parse(identity))
    else {
      const configuration = { displayName: 'Changed PG SSH fixture', host: destination.ip, port: destination.port,
        username: destination.username, hostKeySha256: hostKey, workingDirectory: null,
        authentication: { kind: 'password', password: change === 'credentials' ? 'replace' : 'retain' }, enabled: true }
      if (change === 'configuration') await f.connections.update(f.owner.user, sshConnectionUpdateRequest.parse({ ...identity, configuration }))
      else {
        const bytes = Buffer.from(JSON.stringify({ formatVersion: 2, password: randomUUID() }))
        try {
          const ticket = await f.connections.issueManagedTicket(f.owner.user, sshCredentialTicketRequest.parse({ ...identity,
            purpose: 'update', sizeBytes: bytes.length, configuration }), 'https://platform.invalid')
          await f.connections.upload(ticket.ticket, Readable.from([bytes]))
        } finally { bytes.fill(0) }
      }
    }
    expect(await f.calls.markDispatchIntent(lease, 'f'.repeat(64))).toMatchObject({ id: lease.callId,
      state: 'failed', error_code: 'ssh_connection_changed', dispatch_digest: null, dispatch_owner: null, dispatch_epoch: null })
    await expect(f.calls.assertDispatchLease(lease)).rejects.toMatchObject({ status: 409 })
  }))

test('SSH concurrent claim and first-dispatch permits fence old epochs without replacing execution identities', () => sshFixture(async (f) => {
  await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const claims = await Promise.all(Array.from({ length: 4 }, () => f.calls.claim(randomUUID(), 60_000, 'ssh.execute')))
  const owned = claims.filter(row => row !== null)
  expect(owned).toHaveLength(1)
  const lease = leaseFor(owned[0]!)
  await f.calls.startPreparing(lease)
  const original = handle(lease.callId)
  await f.calls.markReady(lease, original)
  const permits = await Promise.allSettled([f.calls.markDispatchIntent(lease, '1'.repeat(64)), f.calls.markDispatchIntent(lease, '2'.repeat(64))])
  expect(permits.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  for (const result of permits) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409 })
  const dispatched = await f.calls.get(f.owner.user, lease.callId)
  await f.pool.query("UPDATE pe_ssh_calls SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [lease.callId])
  const recovered = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
  expect(recovered).toMatchObject({ callId: lease.callId, epoch: lease.epoch + 1 })
  await expect(f.calls.renew(lease, 60_000)).rejects.toMatchObject({ status: 409 })
  await expect(f.calls.assertDispatchLease(recovered)).rejects.toMatchObject({ status: 409 })
  await expect(f.calls.markDispatchIntent(recovered, '3'.repeat(64))).rejects.toMatchObject({ status: 409 })
  const status = { callId: lease.callId, instanceId: original.instanceId, digest: dispatched.dispatch_digest!, state: 'running' as const }
  await expect(f.calls.recordStatus(lease, status)).rejects.toMatchObject({ status: 409 })
  expect(await f.calls.recordStatus(recovered, status)).toMatchObject({ state: 'running', pod_uid: original.podUid,
    runner_instance_id: original.instanceId, dispatch_digest: dispatched.dispatch_digest, dispatch_owner: dispatched.dispatch_owner,
    dispatch_epoch: dispatched.dispatch_epoch })
  await expect(f.calls.markCleanupComplete(lease.callId, randomUUID())).rejects.toMatchObject({ status: 409 })
  expect((await f.calls.get(f.owner.user, lease.callId)).cleanup_complete).toBe(false)
}))

test('SSH current lease renewal and deferred observation preserve the original dispatch permit', () => sshFixture(async (f) => {
  await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const lease = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
  const before = await f.calls.get(f.owner.user, lease.callId)
  await f.calls.renew(lease, 90_000)
  expect((await f.calls.get(f.owner.user, lease.callId)).lease_until!.getTime()).toBeGreaterThan(before.lease_until!.getTime())
  await f.calls.startPreparing(lease)
  const original = handle(lease.callId)
  await f.calls.markReady(lease, original)
  const dispatched = await f.calls.markDispatchIntent(lease, '4'.repeat(64))
  const status = { callId: lease.callId, instanceId: original.instanceId, digest: dispatched.dispatch_digest!, state: 'running' as const }
  await f.calls.recordStatus(lease, status)
  await f.calls.deferRunning(lease, 100)
  expect(await f.calls.get(f.owner.user, lease.callId)).toMatchObject({ state: 'running', lease_owner: null,
    dispatch_owner: lease.owner, dispatch_epoch: lease.epoch, dispatch_digest: status.digest })
  await expect(f.calls.renew(lease, 60_000)).rejects.toMatchObject({ status: 409 })
  await expect.poll(async () => (await f.pool.query<{ readonly due: boolean }>('SELECT lease_until<=clock_timestamp() AS due FROM pe_ssh_calls WHERE id=$1', [lease.callId])).rows[0]!.due)
    .toBe(true)
  const recovered = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
  expect(await f.calls.recordStatus(recovered, { ...status, state: 'succeeded' })).toMatchObject({ state: 'succeeded',
    pod_uid: original.podUid, runner_instance_id: original.instanceId, dispatch_digest: status.digest, dispatch_epoch: lease.epoch })
  await f.calls.markCleanupComplete(lease.callId, original.podUid)
  expect((await f.calls.get(f.owner.user, lease.callId)).cleanup_complete).toBe(true)
  await expect(f.calls.renew(recovered, 60_000)).rejects.toMatchObject({ status: 409 })
  expect(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute')).toBeNull()
}))

test('SSH current lease can settle after preparation without committing a dispatch permit', () => sshFixture(async (f) => {
  await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const lease = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
  await f.calls.startPreparing(lease)
  expect(await f.calls.settleWithoutDispatch(lease, 'preparing', 'failed', 'ssh_fixture_refused')).toMatchObject({ state: 'failed',
    error_code: 'ssh_fixture_refused', dispatch_digest: null, dispatch_owner: null, dispatch_epoch: null })
  await expect(f.calls.startPreparing(lease)).rejects.toMatchObject({ status: 409 })
  expect(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute')).toBeNull()
}))

test('SSH first dispatch rejects expiry while waiting on the approved connection lock', () => sshFixture(async (f) => {
  await f.service.decide(f.owner.user, f.action.actionId, f.action.fingerprint, true, f.approval.token)
  const lease = leaseFor(await f.calls.claim(randomUUID(), 60_000, 'ssh.execute'))
  await f.calls.startPreparing(lease)
  await f.calls.markReady(lease, handle(lease.callId))
  await f.pool.query("UPDATE pe_ssh_calls SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1", [lease.callId])
  const blocker = await f.pool.connect()
  let dispatch: Promise<unknown> | undefined
  try {
    await blocker.query('BEGIN')
    const pid = (await blocker.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await blocker.query('SELECT id FROM pe_ssh_connections WHERE id=$1 FOR UPDATE', [f.connectionId])
    dispatch = f.calls.markDispatchIntent(lease, '5'.repeat(64))
    const outcome = dispatch.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
    await expect.poll(async () => (await f.pool.query<{ readonly waiting: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0]!.waiting)
      .toBe(true)
    await expect.poll(async () => (await f.pool.query<{ readonly expired: boolean }>('SELECT lease_until<=clock_timestamp() AS expired FROM pe_ssh_calls WHERE id=$1', [lease.callId])).rows[0]!.expired)
      .toBe(true)
    await blocker.query('COMMIT')
    expect((await outcome).error).toMatchObject({ status: 409 })
    expect(await f.calls.get(f.owner.user, lease.callId)).toMatchObject({ state: 'ready', dispatch_digest: null,
      dispatch_owner: null, dispatch_epoch: null })
  } finally {
    try { await blocker.query('ROLLBACK') } finally { blocker.release() }
    await dispatch?.catch(() => undefined)
  }
}))
