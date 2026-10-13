/** Actual PG native ownership, receipt recovery and cancellation admission; physical stop proof belongs to sandbox acceptance. */
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, test, vi } from 'vitest'
import { requestId } from '../src/contracts.ts'
import { admittedInputMessage, inputCohortId, nativeInputAdmissionCommand, nativeInputClaimCommand,
  nativeInputStepCommand, originInputId } from '../src/native-input-ledger-contracts.ts'
import { nativeTurnMessageId } from '../src/native-turn-contracts.ts'
import { nativeWriterIdentity, nativeWriterWorkerId } from '../src/native-writer-contracts.ts'
import { headerSchema } from '../src/session-records.ts'
import { capturedRunnerRequest, cloudRequestDigest, nativeCloudEnvironment,
  type CloudExecutionRow } from '../src/platform/cloud-execution-resolution-types.ts'
import { transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { ExecutionService } from '../src/platform/executions.ts'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { NativeExecutionAuthority } from '../src/platform/native-execution-authority.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { readWorkspaceLayout, writeWorkspaceLayout, type LayoutWorkspace } from '../src/platform/native-workspace-layout.ts'
import { SandboxManager } from '../src/platform/sandbox.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { cloudFixture } from './cloud-fixture.ts'

type Fixture = Parameters<Parameters<typeof cloudFixture>[0]>[0]
const taskLimits = { maxEventBytes: 524_288, leaseMs: 60_000, maxPendingPerUser: 8, maxActivePerUser: 2, executionEnabled: true }
const historyLimits = { maxHistoryEvents: 1000, maxHistoryBytes: 8_388_608 }
const executionLimits = { ...historyLimits, maxCohortInputs: 128, maxFactBytes: 2_097_152 }
const command = () => ({ callId: randomUUID(), command: 'printf native', cwd: '', timeoutMs: 5000 })

function first<T>(rows: readonly T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Owned native Shell fixture returned no row')
  return row
}

async function prepare(f: Fixture, phase: 'prepared' | 'claimed' | 'step' = 'step') {
  const tasks = new TaskStore(f.pool, taskLimits)
  const created = await tasks.create(f.alice.user, requestId.parse(randomUUID()), f.alice.token)
  const rpcId = requestId.parse(randomUUID())
  await tasks.accept(f.alice.user, created.sessionId, rpcId, 'Original native Shell task', f.alice.token)
  const workerId = nativeWriterWorkerId.parse(randomUUID()), grant = await tasks.claim(workerId)
  if (!grant) throw new Error('Actual original Shell operation was not claimed')
  const writers = new NativeSessionWriter(tasks, { leaseMs: 60_000 })
  const acquire = { sessionId: created.sessionId, workerId, token: randomBytes(32).toString('base64url') }
  const leased = await writers.acquire(grant.token, acquire), writer = nativeWriterIdentity.parse({ ...acquire, epoch: leased.epoch })
  const authority = { writer, operationToken: grant.token }
  const events = new EventStore(tasks, { maxEventBytes: taskLimits.maxEventBytes, ...historyLimits })
  const frames = new NativeExecutionFrames(tasks, writers, { ...historyLimits, maxFrameBytes: 2_097_152, maxCohortInputs: 128 })
  const ledger = new NativeInputLedger(tasks, writers, events, { ...historyLimits, maxEventBytes: taskLimits.maxEventBytes,
    maxAcceptedAuditBytes: 2_097_152, maxRevisionBytes: 262_144, maxCohortInputs: 128, maxCommandBytes: 4_194_304 },
  (client, value) => frames.verifyInTransaction(client, value))
  const header = headerSchema.parse(first((await f.pool.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [created.sessionId])).rows).header)
  const session = Session.create(header.id, undefined, header), history: SessionEvent[] = []
  const content = first((await f.pool.query<{ admitted: unknown }>('SELECT admitted FROM pe_native_prompt_inputs WHERE session_id=$1 AND request_id=$2',
    [created.sessionId, rpcId])).rows).admitted
  const origin = originInputId.parse(randomUUID()), message = admittedInputMessage.parse({ id: nativeTurnMessageId.parse(randomUUID()),
    role: 'user', source: { kind: 'user', rpcId }, content })
  const admission = session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  history.push(admission)
  await ledger.admit(f.alice.token, { authority, expectedEventCount: 0, events: [admission],
    command: nativeInputAdmissionCommand.parse({ rpcNonce: randomUUID(), sessionId: created.sessionId,
      originInputId: origin, originOperationId: grant.operationId, messageId: message.id, target: 'next-turn' }) })
  const frame = await transaction(f.pool, client => frames.prepareInTransaction(client, authority, origin))
  if (phase !== 'prepared') {
    const expectedEventCount = history.length, consumed = [session.append('turn/start', { turn: 1 }),
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })]
    history.push(...consumed)
    const claim = nativeInputClaimCommand.parse({ rpcNonce: randomUUID(), cohortId: inputCohortId.parse(randomUUID()),
      boundaryKind: 'initial-turn-step', frame: { sessionId: grant.sessionId, operationId: grant.operationId,
        operationEpoch: grant.epoch, writerEpoch: writer.epoch, frozenSnapshotDigest: frame.frozenSnapshotDigest } })
    await ledger.claim({ command: claim, authority, expectedEventCount, events: consumed })
    if (phase === 'step') {
      const step = session.append('step/start', { turn: 1, step: 1 }); history.push(step)
      await transaction(f.pool, async client => {
        const current = await tasks.authorized(client, grant.token)
        await events.appendInTransaction(client, current, [step])
        await ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: claim.cohortId,
          frame: claim.frame, stepStartSeq: step.seq }), authority)
      })
    }
  }
  const nativeAuthority = new NativeExecutionAuthority((client, current, token) => frames.readExecutionInTransaction(client, current, token), executionLimits)
  const executionTasks = new TaskStore(f.pool, taskLimits, (client, current, token) => nativeAuthority.assertExecutionInTransaction(client, current, token))
  const kubeconfig = join(f.root, `unused-shell-${randomUUID()}.json`)
  await writeFile(kubeconfig, JSON.stringify({ 'current-context': 'owned',
    clusters: [{ name: 'owned', cluster: { server: 'https://127.0.0.1:9', 'certificate-authority-data': Buffer.from('unused').toString('base64') } }],
    contexts: [{ name: 'owned', context: { cluster: 'owned', user: 'owned' } }], users: [{ name: 'owned', user: { token: 'unused' } }] }))
  const kube = await KubernetesClient.fromFile(kubeconfig)
  const sandbox = new SandboxManager(kube, f.files, f.pool, randomUUID(), { namespace: 'owned-unused-shell',
    image: 'fixture.invalid/unused', localRoot: f.root, nodeRoot: join(f.root, 'unused-node'), readyTimeoutMs: 1000, maxExecutions: 2 })
  return { tasks, executionTasks, grant, writers, writer, sandbox, kube,
    executions: new ExecutionService(executionTasks, sandbox, 1, 10, 60_000, 3000) }
}

test('native Shell admission requires the actual claimed cohort and its current open step', () => cloudFixture(async f => {
  for (const phase of ['prepared', 'claimed'] as const) {
    const n = await prepare(f, phase)
    await expect(n.executions.proposeShell(n.grant.token, command())).rejects.toMatchObject({ status: 409,
      code: phase === 'prepared' ? 'native_execution_frame_not_claimed' : 'native_execution_step_unclaimed' })
  }
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_cloud_executions')).rows).count).toBe(0)
}))

test('reply loss and configuration changes retain the original request, timeout and managed environment', () => cloudFixture(async f => {
  const n = await prepare(f), input = command(), receipt = await n.executions.proposeShell(n.grant.token, input)
  expect(receipt).toMatchObject({ state: 'queued', timeoutMs: 3000, result: null })
  const row = first((await f.pool.query<CloudExecutionRow>('SELECT * FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows)
  const instanceId = randomUUID(), request = capturedRunnerRequest({ ...row, runner_instance_id: instanceId }, 9000)
  expect(request).toEqual({ id: row.id, command: input.command, cwd: '', timeoutMs: 3000, instanceId,
    outputMode: 'tail', dshEnv: nativeCloudEnvironment(n.grant.sessionId) })
  expect(row.request_digest).toBe(cloudRequestDigest({ command: input.command, cwd: '', timeoutMs: 3000,
    outputMode: 'tail', dshEnv: { DSH_SHELL: '1', DSH_HOME: '/home/agent/.dsh', DSH_SESSION_ID: n.grant.sessionId } }))
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [n.grant.sessionId])
  const changed = new ExecutionService(n.executionTasks, n.sandbox, 1, 10, 60_000, 9000)
  expect(await changed.proposeShell(n.grant.token, input)).toEqual(receipt)
  await expect(changed.proposeShell(n.grant.token, { ...input, timeoutMs: 6000 })).rejects.toMatchObject({ status: 409, code: 'request_id_conflict' })
  await expect(changed.proposeShell(n.grant.token, { ...input, callId: randomUUID() })).rejects.toMatchObject({ status: 409, code: 'lease_lost' })
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_cloud_executions')).rows).count).toBe(1)
}))

test('native directory admission preserves Chinese and spaces but refuses traversal and control paths', () => cloudFixture(async f => {
  const n = await prepare(f), input = { ...command(), cwd: '中文 项目' }
  const receipt = await n.executions.proposeShell(n.grant.token, input)
  expect(receipt.cwd).toBe(input.cwd)
  const row = first((await f.pool.query<CloudExecutionRow>('SELECT * FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows)
  expect(capturedRunnerRequest({ ...row, runner_instance_id: randomUUID() }, 9000)?.cwd).toBe(input.cwd)
  for (const cwd of ['../outside', '/absolute', 'bad\\path', 'bad\u0000path']) {
    await expect(n.executions.proposeShell(n.grant.token, { ...input, callId: randomUUID(), cwd })).rejects.toBeDefined()
  }
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_cloud_executions')).rows).count).toBe(1)
}))

test('an unknown cancelled receipt is persisted once and the delayed original call cannot create a second command', () => cloudFixture(async f => {
  const n = await prepare(f), input = command()
  const receipt = await n.executions.proposeShell(n.grant.token, { ...input, cancelRequested: true })
  expect(receipt.state).toBe('queued')
  expect(await n.executions.proposeShell(n.grant.token, input)).toEqual(receipt)
  expect(first((await f.pool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows).cancel_requested).toBe(true)
  await n.executions.cancelShell(n.grant.token, receipt.executionId)
  expect((await n.executions.statusShell(n.grant.token, receipt.executionId)).state).toBe('queued')
  const other = await prepare(f)
  await expect(n.executions.statusShell(other.grant.token, receipt.executionId)).rejects.toMatchObject({ status: 404, code: 'execution_not_found' })
  await expect(n.executions.cancelShell(other.grant.token, receipt.executionId)).rejects.toMatchObject({ status: 404, code: 'execution_not_found' })
  await expect(n.executions.statusShell(f.bob.token, receipt.executionId)).rejects.toMatchObject({ status: 404, code: 'execution_not_found' })
}))

test('credential revocation masks stored output while the original token still requests exact cleanup', () => cloudFixture(async f => {
  const n = await prepare(f), receipt = await n.executions.proposeShell(n.grant.token, command())
  const result = { exitCode: 0, stdout: 'owned output', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false }
  await f.pool.query("UPDATE pe_cloud_executions SET state='succeeded',result=$2 WHERE id=$1", [receipt.executionId, JSON.stringify(result)])
  expect((await n.executions.statusShell(n.grant.token, receipt.executionId)).result).toEqual(result)
  await f.pool.query('UPDATE pe_users SET credential_version=credential_version+1,enabled=false WHERE id=$1', [f.alice.user.userId])
  expect(await n.executions.statusShell(n.grant.token, receipt.executionId)).toMatchObject({ state: 'succeeded', result: null, errorCode: 'native_shell_output_revoked' })
  expect((await n.executions.cancelShell(n.grant.token, receipt.executionId)).result).toBeNull()
  await expect(n.executions.proposeShell(n.grant.token, command())).rejects.toMatchObject({ status: 401, code: 'account_disabled' })
}))

test('archive suppresses result reads and keeps the captured cleanup capability', () => cloudFixture(async f => {
  const n = await prepare(f), receipt = await n.executions.proposeShell(n.grant.token, command())
  await transaction(f.pool, async client => {
    const workspaces = (await client.query<LayoutWorkspace>('SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [f.alice.user.userId])).rows
    const layout = await readWorkspaceLayout(client, f.alice.user.userId, workspaces)
    layout.archivedSessionIds = [n.grant.sessionId]
    await writeWorkspaceLayout(client, f.alice.user.userId, layout)
  })
  expect(await n.executions.statusShell(n.grant.token, receipt.executionId)).toMatchObject({ result: null, errorCode: 'native_shell_output_revoked' })
  await n.executions.cancelShell(n.grant.token, receipt.executionId)
  expect(first((await f.pool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows).cancel_requested).toBe(true)
}))

test('an ended foreground owner cancels its undispatched command without a continuation or Kubernetes call', () => cloudFixture(async f => {
  const n = await prepare(f), receipt = await n.executions.proposeShell(n.grant.token, command()), remote = vi.spyOn(n.kube, 'call')
  await f.pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1", [n.grant.operationId])
  n.executions.start()
  try {
    await vi.waitFor(async () => expect((await n.executions.statusShell(n.grant.token, receipt.executionId)).state).toBe('cancelled'), { timeout: 5000 })
    expect(remote).not.toHaveBeenCalled()
    expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations WHERE source_execution_id=$1', [receipt.executionId])).rows).count).toBe(0)
  } finally { await n.executions.close(); remote.mockRestore() }
}))

test('a captured executor without matching stop identity stays uncertain and never publishes an invented terminal result', () => cloudFixture(async f => {
  const n = await prepare(f), receipt = await n.executions.proposeShell(n.grant.token, command())
  await f.pool.query("UPDATE pe_cloud_executions SET state='running',cancel_requested=true,sandbox_name='missing-owned-runner',pod_uid=$2,runner_instance_id=$3 WHERE id=$1",
    [receipt.executionId, randomUUID(), randomUUID()])
  n.executions.start()
  try {
    await vi.waitFor(async () => expect(await n.executions.statusShell(n.grant.token, receipt.executionId))
      .toMatchObject({ state: 'uncertain', result: null, errorCode: 'native_tool_stop_unconfirmed' }), { timeout: 5000 })
    expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations WHERE source_execution_id=$1', [receipt.executionId])).rows).count).toBe(0)
  } finally { await n.executions.close() }
}))
