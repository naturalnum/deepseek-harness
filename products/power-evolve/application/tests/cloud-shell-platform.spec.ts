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
import { capturedRunnerRequest, cloudRequestDigest, cloudRunnerRequest, nativeCloudEnvironment,
  type CloudExecutionRow } from '../src/platform/cloud-execution-resolution-types.ts'
import { transaction } from '../src/platform/database.ts'
import { EventStore } from '../src/platform/events.ts'
import { ExecutionService } from '../src/platform/executions.ts'
import { KubernetesClient, KubernetesError } from '../src/platform/kubernetes.ts'
import { NativeExecutionAuthority } from '../src/platform/native-execution-authority.ts'
import { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import { readWorkspaceLayout, writeWorkspaceLayout, type LayoutWorkspace } from '../src/platform/native-workspace-layout.ts'
import { SandboxManager, MountSlotBlocked, type SandboxReady } from '../src/platform/sandbox.ts'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
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
      await transaction(f.pool, async (client) => {
        const current = await tasks.authorized(client, grant.token)
        await events.appendInTransaction(client, current, [step])
        await ledger.bindStepInTransaction(client, nativeInputStepCommand.parse({ cohortId: claim.cohortId,
          frame: claim.frame, stepStartSeq: step.seq }), authority)
      })
    }
  }
  const nativeAuthority = new NativeExecutionAuthority(
    (client, current, token) => frames.readExecutionInTransaction(client, current, token), executionLimits)
  const executionTasks = new TaskStore(f.pool, taskLimits,
    (client, current, token) => nativeAuthority.assertExecutionInTransaction(client, current, token))
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

test('native Shell admission requires the actual claimed cohort and its current open step', () => cloudFixture(async (f) => {
  for (const phase of ['prepared', 'claimed'] as const) {
    const n = await prepare(f, phase)
    await expect(n.executions.proposeShell(n.grant.token, command())).rejects.toMatchObject({ status: 409,
      code: phase === 'prepared' ? 'native_execution_frame_not_claimed' : 'native_execution_step_unclaimed' })
  }
  expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_cloud_executions')).rows).count).toBe(0)
}))

test('reply loss and configuration changes retain the original request, timeout and managed environment', () => cloudFixture(async (f) => {
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

test('native directory admission preserves Chinese and spaces but refuses traversal and control paths', () => cloudFixture(async (f) => {
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

test('an unknown cancelled receipt is persisted once and the delayed original call cannot create a second command', () => cloudFixture(async (f) => {
  const n = await prepare(f), input = command()
  const receipt = await n.executions.proposeShell(n.grant.token, { ...input, cancelRequested: true })
  expect(receipt.state).toBe('queued')
  expect(await n.executions.proposeShell(n.grant.token, input)).toEqual(receipt)
  expect(first((await f.pool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows).cancel_requested).toBe(true)
  await n.executions.cancelShell(n.grant.token, receipt.executionId, 'abort')
  expect((await n.executions.statusShell(n.grant.token, receipt.executionId)).state).toBe('queued')
  const other = await prepare(f)
  await expect(n.executions.statusShell(other.grant.token, receipt.executionId)).rejects.toMatchObject({ status: 404, code: 'execution_not_found' })
  await expect(n.executions.cancelShell(other.grant.token, receipt.executionId, 'abort')).rejects.toMatchObject({ status: 404, code: 'execution_not_found' })
  await expect(n.executions.statusShell(f.bob.token, receipt.executionId)).rejects.toMatchObject({ status: 404, code: 'execution_not_found' })
}))

test('credential revocation masks stored output while the original token still requests exact cleanup', () => cloudFixture(async (f) => {
  const n = await prepare(f), receipt = await n.executions.proposeShell(n.grant.token, command())
  const result = { exitCode: 0, stdout: 'owned output', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false }
  await f.pool.query("UPDATE pe_cloud_executions SET state='succeeded',result=$2 WHERE id=$1", [receipt.executionId, JSON.stringify(result)])
  expect((await n.executions.statusShell(n.grant.token, receipt.executionId)).result).toEqual(result)
  await f.pool.query('UPDATE pe_users SET credential_version=credential_version+1,enabled=false WHERE id=$1', [f.alice.user.userId])
  expect(await n.executions.statusShell(n.grant.token, receipt.executionId)).toMatchObject({ state: 'succeeded', result: null, errorCode: 'native_shell_output_revoked' })
  expect((await n.executions.cancelShell(n.grant.token, receipt.executionId, 'abort')).result).toBeNull()
  await expect(n.executions.proposeShell(n.grant.token, command())).rejects.toMatchObject({ status: 401, code: 'account_disabled' })
}))

test('archive suppresses result reads and keeps the captured cleanup capability', () => cloudFixture(async (f) => {
  const n = await prepare(f), receipt = await n.executions.proposeShell(n.grant.token, command())
  await transaction(f.pool, async (client) => {
    const workspaces = (await client.query<LayoutWorkspace>('SELECT id,title,is_default FROM pe_workspaces WHERE user_id=$1', [f.alice.user.userId])).rows
    const layout = await readWorkspaceLayout(client, f.alice.user.userId, workspaces)
    layout.archivedSessionIds = [n.grant.sessionId]
    await writeWorkspaceLayout(client, f.alice.user.userId, layout)
  })
  expect(await n.executions.statusShell(n.grant.token, receipt.executionId)).toMatchObject({ result: null, errorCode: 'native_shell_output_revoked' })
  await n.executions.cancelShell(n.grant.token, receipt.executionId, 'abort')
  expect(first((await f.pool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows).cancel_requested).toBe(true)
}))

test('an ended foreground owner cancels its undispatched command without a continuation or Kubernetes call', () => cloudFixture(async (f) => {
  const n = await prepare(f), receipt = await n.executions.proposeShell(n.grant.token, command()), remote = vi.spyOn(n.kube, 'call')
  await f.pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1", [n.grant.operationId])
  n.executions.start()
  try {
    await vi.waitFor(async () =>{  expect((await n.executions.statusShell(n.grant.token, receipt.executionId)).state).toBe('cancelled') }, { timeout: 5000 })
    expect(remote).not.toHaveBeenCalled()
    expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations WHERE source_execution_id=$1', [receipt.executionId])).rows).count).toBe(0)
  } finally { await n.executions.close(); remote.mockRestore() }
}))

test('a captured executor without matching stop identity stays uncertain and never publishes an invented terminal result', () => cloudFixture(async (f) => {
  const n = await prepare(f), receipt = await n.executions.proposeShell(n.grant.token, command())
  await f.pool.query("UPDATE pe_cloud_executions SET state='running',cancel_requested=true,sandbox_name='missing-owned-runner',pod_uid=$2,runner_instance_id=$3 WHERE id=$1",
    [receipt.executionId, randomUUID(), randomUUID()])
  n.executions.start()
  try {
    await vi.waitFor(async () =>{  expect(await n.executions.statusShell(n.grant.token, receipt.executionId))
      .toMatchObject({ state: 'uncertain', result: null, errorCode: 'native_tool_stop_unconfirmed' }) }, { timeout: 5000 })
    expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations WHERE source_execution_id=$1', [receipt.executionId])).rows).count).toBe(0)
  } finally { await n.executions.close() }
}))

test.each(['expired', 'operation-ended', 'grant-replaced', 'credential-rotated'] as const)(
  'cold preparation fences %s authority while its full execution slot cannot run another claim', reason => cloudFixture(async (f) => {
    const n = await prepare(f), receipt = await n.executions.proposeShell(n.grant.token, command())
    const workspace = first((await f.pool.query<{ workspace_id: string }>('SELECT workspace_id FROM pe_sessions WHERE id=$1', [n.grant.sessionId])).rows)
    const binding = await f.files.bindingForId(f.alice.user.userId, workspace.workspace_id)
    const writer: SandboxReady = { name: n.sandbox.name(f.alice.user.userId), sessionId: n.grant.sessionId,
      userId: f.alice.user.userId, binding, generation: '1', podUid: randomUUID(), runnerInstanceId: randomUUID(),
      token: randomUUID(), restartCount: 0 }
    const prepared = deferred<undefined>(), ready = deferred<SandboxReady>()
    const stopRetry = deferred<undefined>(), releaseStop = deferred<undefined>()
    const ensure = vi.spyOn(n.sandbox, 'ensureReady').mockImplementation(async () => { prepared.resolve(undefined); return ready.promise })
    const current = vi.spyOn(n.sandbox, 'assertCurrent').mockResolvedValue(undefined)
    const allowed = vi.spyOn(n.sandbox, 'assertDispatchAllowed').mockResolvedValue(undefined)
    const recycle = vi.spyOn(n.sandbox, 'recycleIdle').mockResolvedValue(undefined)
    const runner = vi.spyOn(n.sandbox, 'runner').mockImplementation(async (_name, _token, method, path, input) => {
      if (method === 'GET') throw new KubernetesError(404, 'controlled missing receipt')
      if (method !== 'POST' || path !== '/executions') throw new Error('Unexpected controlled Runner call')
      const request = cloudRunnerRequest.parse(input)
      return { id: request.id, instanceId: writer.runnerInstanceId, digest: cloudRequestDigest(request), state: 'succeeded',
        exitCode: 0, stdout: 'must never dispatch', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false }
    })
    let stops = 0
    // This controlled provider never supplies physical stop proof. The test checks
    // exact stop routing and persisted retry identity while completion stays uncertain.
    const stop = vi.spyOn(n.sandbox, 'stopForExecutionResolution').mockImplementation(async (_target, _request, fence) => {
      await fence()
      if (++stops === 1) throw new MountSlotBlocked('controlled_stop_unconfirmed', false)
      stopRetry.resolve(undefined)
      await releaseStop.promise
      throw new MountSlotBlocked('controlled_stop_unconfirmed', false)
    })
    n.executions.start()
    try {
      await prepared.promise
      expect(first((await f.pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM pe_cloud_executions
        WHERE lease_owner IS NOT NULL AND lease_until>clock_timestamp() AND state='starting'`)).rows).count).toBe(1)
      if (reason === 'expired') await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [n.grant.sessionId])
      if (reason === 'operation-ended') await f.pool.query("UPDATE pe_operations SET state='completed' WHERE id=$1", [n.grant.operationId])
      if (reason === 'grant-replaced') await f.pool.query("UPDATE pe_sessions SET grant_digest=repeat('a',64) WHERE id=$1", [n.grant.sessionId])
      if (reason === 'credential-rotated') await f.pool.query('UPDATE pe_users SET credential_version=credential_version+1 WHERE id=$1', [f.alice.user.userId])
      expect(first((await f.pool.query<{ cancel_requested: boolean }>('SELECT cancel_requested FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows).cancel_requested).toBe(false)
      await f.pool.query(`INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,pod_uid,runner_instance_id,binding_snapshot)
        VALUES($1,$2,$3,1,'ready',$4,$5,$6)`, [writer.userId, writer.sessionId, binding.workspaceId, writer.podUid, writer.runnerInstanceId, binding])
      await f.pool.query(`INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id,binding_snapshot)
        VALUES($1,$2,$3,'ready',$4,$5,$6)`, [writer.sessionId, writer.userId, writer.name, writer.podUid, writer.runnerInstanceId, binding])
      ready.resolve(writer)
      await vi.waitFor(() =>{  expect(stops).toBeGreaterThanOrEqual(2) }, { timeout: 5000 })
      await stopRetry.promise
      expect(runner.mock.calls.filter(call => call[2] === 'POST')).toHaveLength(0)
      const persisted = first((await f.pool.query<CloudExecutionRow>('SELECT * FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows)
      expect(persisted).toMatchObject({ cancel_requested: true, dispatch_request: null, result: null })
      expect(['starting', 'uncertain']).toContain(persisted.state)
      const exact = { userId: writer.userId, sessionId: writer.sessionId, workspaceId: binding.workspaceId,
        generation: '1', name: writer.name, podUid: writer.podUid, runnerInstanceId: writer.runnerInstanceId, binding }
      expect(persisted.native_tool_stop_target).toEqual(exact)
      for (const [target, stopId] of stop.mock.calls) {
        expect(target).toEqual(exact)
        expect(stopId).toBe(persisted.native_tool_stop_request_id)
      }
      expect(first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations WHERE source_execution_id=$1', [receipt.executionId])).rows).count).toBe(0)
    } finally {
      ready.resolve(writer); releaseStop.resolve(undefined)
      await n.executions.close()
      for (const spy of [ensure, current, allowed, recycle, runner, stop]) spy.mockRestore()
    }
    expect(first((await f.pool.query<CloudExecutionRow>('SELECT * FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows))
      .toMatchObject({ state: 'uncertain', dispatch_request: null, result: null, cancel_requested: true })
  }))

test('timeout cancellation survives expired-grant reply recovery and later abort retries', () => cloudFixture(async (f) => {
  const n = await prepare(f), input = command()
  const receipt = await n.executions.proposeShell(n.grant.token, { ...input, cancelRequested: true, cancelCause: 'timeout' })
  expect(receipt).toMatchObject({ state: 'queued', cancelCause: 'timeout', result: null })
  await f.pool.query("UPDATE pe_sessions SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [n.grant.sessionId])
  expect(await n.executions.proposeShell(n.grant.token, { ...input, cancelRequested: true, cancelCause: 'abort' })).toEqual(receipt)
  expect(await n.executions.cancelShell(n.grant.token, receipt.executionId, 'abort')).toEqual(receipt)
  expect(first((await f.pool.query<CloudExecutionRow>('SELECT * FROM pe_cloud_executions WHERE id=$1', [receipt.executionId])).rows))
    .toMatchObject({ cancel_requested: true, native_tool_cancel_cause: 'timeout', dispatch_request: null })
}))

test.each(['timeout', 'abort', 'legacy', 'late-success'] as const)(
  'Runner cancellation carries only the stored cause for %s delivery', reason => cloudFixture(async (f) => {
    const n = await prepare(f), input = command()
    if (reason === 'legacy') await n.executions.propose(n.grant.token, input.callId, input.command, input.cwd)
    else await n.executions.proposeShell(n.grant.token, input)
    const row = first((await f.pool.query<CloudExecutionRow>('SELECT * FROM pe_cloud_executions WHERE operation_id=$1 AND call_id=$2',
      [n.grant.operationId, input.callId])).rows)
    const workspace = first((await f.pool.query<{ workspace_id: string }>('SELECT workspace_id FROM pe_sessions WHERE id=$1', [n.grant.sessionId])).rows)
    const binding = await f.files.bindingForId(f.alice.user.userId, workspace.workspace_id)
    const writer: SandboxReady = { name: n.sandbox.name(f.alice.user.userId), sessionId: n.grant.sessionId, userId: f.alice.user.userId,
      binding, generation: '1', podUid: randomUUID(), runnerInstanceId: randomUUID(), token: randomUUID(), restartCount: 0 }
    const request = capturedRunnerRequest({ ...row, runner_instance_id: writer.runnerInstanceId }, 3000)
    if (!request) throw new Error('Owned cancellation fixture did not capture its exact request')
    await f.pool.query("UPDATE pe_cloud_executions SET state='running',sandbox_name=$2,pod_uid=$3,runner_instance_id=$4,dispatch_request=$5 WHERE id=$1",
      [row.id, writer.name, writer.podUid, writer.runnerInstanceId, JSON.stringify(request)])
    if (reason === 'legacy') await n.executions.cancel(f.alice.user, row.id)
    else await n.executions.cancelShell(n.grant.token, row.id, reason === 'abort' ? 'abort' : 'timeout')
    const observe = vi.spyOn(n.sandbox, 'observeReady').mockResolvedValue(writer)
    const current = vi.spyOn(n.sandbox, 'assertCurrent').mockResolvedValue(undefined)
    const fact = { id: row.id, instanceId: writer.runnerInstanceId, digest: cloudRequestDigest(request), exitCode: null,
      stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false }
    const runner = vi.spyOn(n.sandbox, 'runner').mockImplementation(async (_name, _token, method, path, value) => {
      if (method === 'GET') return reason === 'late-success' ? { ...fact, state: 'succeeded', exitCode: 0 } : { ...fact, state: 'running' }
      if (method !== 'POST' || path !== `/executions/${row.id}/cancel`) throw new Error('Unexpected cancellation Runner request')
      expect(value).toEqual(reason === 'legacy' ? {} : { cause: reason })
      return { ...fact, state: reason === 'timeout' ? 'failed' : 'cancelled', timedOut: reason === 'timeout' }
    })
    n.executions.start()
    try {
      await vi.waitFor(async () => {
        const final = first((await f.pool.query<CloudExecutionRow>('SELECT * FROM pe_cloud_executions WHERE id=$1', [row.id])).rows)
        expect(final.state).toBe(reason === 'late-success' ? 'succeeded' : reason === 'timeout' ? 'failed' : 'cancelled')
      }, { timeout: 5000 })
      expect(runner.mock.calls.filter(call => call[2] === 'POST')).toHaveLength(reason === 'late-success' ? 0 : 1)
      const continuations = first((await f.pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations WHERE source_execution_id=$1', [row.id])).rows).count
      expect(continuations).toBe(reason === 'legacy' ? 1 : 0)
      if (reason !== 'legacy') {
        const final = await n.executions.statusShell(n.grant.token, row.id)
        expect(final.cancelCause).toBe(reason === 'abort' ? 'abort' : 'timeout')
        expect(final.result?.timedOut).toBe(reason === 'timeout')
        expect(await n.executions.cancelShell(n.grant.token, row.id, 'abort')).toEqual(final)
      }
    } finally { await n.executions.close(); observe.mockRestore(); current.mockRestore(); runner.mockRestore() }
  }))
