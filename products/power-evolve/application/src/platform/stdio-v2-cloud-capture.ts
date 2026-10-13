/** Prepare only an already captured Cloud STDIO writer in its original authorization transaction. */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { stdioDigestV2, stdioExecutionRefV2, stdioJsonV2, stdioLimitsV2, stdioPreparedV2, stdioTaskSchemasV2,
  type StdioExecutionRefV2, type StdioPreparedV2, type StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { PlatformError } from '../contracts.ts'
import type { SandboxManager } from './sandbox.ts'
import { storageBinding } from './cloud-storage-types.ts'

const uuid = z.uuid(), name = z.string().min(1).refine(value => !value.includes('\0'))
const executionRow = z.object({ id: uuid, user_id: uuid, session_id: uuid,
  execution_kind: z.literal('stdio_v2'), execution_target: z.literal('cloud'), task_version: z.literal(2),
  stdio_phase: z.enum(['discover', 'call']), origin_kind: z.enum(['stdio_discovery', 'operation']), stdio_action_id: uuid,
  stdio_task: z.unknown(), request_digest: stdioDigestV2, operation_id: uuid.nullable(), call_id: name.nullable(),
  command: z.null(), cwd: z.null(), continuation_request_id: uuid.nullable(),
  state: z.enum(['queued', 'starting']), cancel_requested: z.literal(false),
  sandbox_name: name, pod_uid: uuid, runner_instance_id: uuid,
})
const sessionRow = z.object({ id: uuid, user_id: uuid, workspace_id: uuid })
const slotRow = z.object({ user_id: uuid, session_id: uuid, workspace_id: uuid,
  generation: z.string().regex(/^(0|[1-9][0-9]*)$/u), state: z.literal('ready'),
  pod_uid: uuid, runner_instance_id: uuid, binding_snapshot: storageBinding })
const instanceRow = z.object({ session_id: uuid, user_id: uuid, name, state: z.literal('ready'),
  pod_uid: uuid, runner_instance_id: uuid, binding_snapshot: storageBinding })

/** Authorization calls this adapter under owner -> Session -> connection -> action -> execution locks; it grants no start. */
export class StdioCloudPreparationV2 {
  constructor(private readonly sandboxes: Pick<SandboxManager, 'observeReady' | 'captureStdioV2'>) {}

  /** Recheck the original execution and capture its same ready writer without provisioning or a new transaction.
   * @param client Original authorization transaction, already holding the owner and accepted resource locks.
   * @param task Complete immutable accepted task, with the trusted deployment pin and original budgets.
   * @param executionRef Original Cloud execution selected by the action, never a replacement execution.
   * @returns Strict private Prepared observations and complete task/spec/scope digests; no bearer is returned.
   * @throws Missing, cancelled, changed or unavailable original facts reject without releasing the writer or quarantining; the
   * caller handles quarantine after rollback.
   */
  async capture(client: PoolClient, task: StdioTaskV2, executionRef: StdioExecutionRefV2): Promise<StdioPreparedV2> {
    const invalid = () => new PlatformError(409, 'stdio_v2_capture_changed')
    const limits = stdioLimitsV2.parse(task.limits)
    const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
    const schemas = stdioTaskSchemasV2(limits), original = schemas.task.parse(task), ref = stdioExecutionRefV2.parse(executionRef)
    const scope = original.scopeBinding, pin = original.expectedDeploymentPin
    const taskDigest = stdioSha256V2('task', original, budget)
    const execution = executionRow.safeParse((await client.query<Record<string, unknown>>(`SELECT * FROM pe_cloud_executions
      WHERE id=$1 AND user_id=$2 AND session_id=$3`, [ref.executionId, original.userId, original.sessionId])).rows[0])
    if (!execution.success) throw invalid()
    const e = execution.data, saved = schemas.task.safeParse(e.stdio_task)
    if (!saved.success || e.id !== ref.executionId || e.user_id !== original.userId || e.session_id !== original.sessionId
      || e.stdio_action_id !== original.actionId || e.stdio_phase !== original.phase || e.request_digest !== taskDigest
      || stdioSha256V2('task', saved.data, budget) !== taskDigest
      || (original.phase === 'discover' ? e.origin_kind !== 'stdio_discovery' || e.operation_id !== null
        || e.call_id !== null || e.continuation_request_id !== null
        : e.origin_kind !== 'operation' || e.operation_id !== original.origin.operationId
          || e.call_id !== original.origin.callKey || e.continuation_request_id === null)) throw invalid()
    const session = sessionRow.safeParse((await client.query<Record<string, unknown>>(`SELECT id,user_id,workspace_id FROM pe_sessions
      WHERE id=$1 AND user_id=$2`, [original.sessionId, original.userId])).rows[0])
    const slot = slotRow.safeParse((await client.query<Record<string, unknown>>('SELECT * FROM pe_mount_slots WHERE user_id=$1', [original.userId])).rows[0])
    const instance = instanceRow.safeParse((await client.query<Record<string, unknown>>(`SELECT session_id,user_id,name,state,pod_uid,runner_instance_id,binding_snapshot
      FROM pe_sandbox_instances WHERE session_id=$1 AND user_id=$2`, [original.sessionId, original.userId])).rows[0])
    if (!session.success || !slot.success || !instance.success) throw invalid()
    const s = session.data, m = slot.data, i = instance.data, binding = m.binding_snapshot
    if (s.id !== original.sessionId || s.user_id !== original.userId || s.workspace_id !== scope.workspaceId
      || m.user_id !== original.userId || m.session_id !== original.sessionId || m.workspace_id !== scope.workspaceId
      || m.pod_uid !== e.pod_uid || m.runner_instance_id !== e.runner_instance_id
      || i.user_id !== original.userId || i.session_id !== original.sessionId || i.name !== e.sandbox_name
      || i.pod_uid !== e.pod_uid || i.runner_instance_id !== e.runner_instance_id
      || binding.workspaceId !== scope.workspaceId || binding.generation !== scope.bindingGeneration
      || binding.spaceId !== scope.target.spaceId || binding.rootRelativePath !== scope.target.rootRelativePath
      || stdioSha256V2('scope', binding, budget) !== stdioSha256V2('scope', i.binding_snapshot, budget)) throw invalid()
    const writer = await this.sandboxes.observeReady(original.sessionId, original.userId, e.pod_uid, e.runner_instance_id, client)
    if (writer.name !== e.sandbox_name || writer.podUid !== e.pod_uid || writer.runnerInstanceId !== e.runner_instance_id
      || writer.generation !== m.generation || writer.sessionId !== original.sessionId || writer.userId !== original.userId
      || stdioSha256V2('scope', storageBinding.parse(writer.binding), budget) !== stdioSha256V2('scope', binding, budget)) throw invalid()
    const observed = await this.sandboxes.captureStdioV2(writer, scope, pin, limits, client)
    const prepared = stdioJsonV2(budget).pipe(stdioPreparedV2).parse({ formatVersion: 2, actionId: original.actionId,
      executionRef: ref, taskDigest, scopeBinding: scope, expectedDeploymentPin: pin, actualExecutorImage: observed.actualExecutorImage,
      capture: observed.capture, specDigest: stdioSha256V2('spec', observed.spec, budget),
      fullScopeDigest: stdioSha256V2('scope', { scopeBinding: scope,
        workspaceMount: observed.capture.workspaceMount, homeMount: observed.capture.homeMount }, budget) })
    if (prepared.capture.podUid !== e.pod_uid || prepared.capture.podName !== e.sandbox_name
      || prepared.capture.runnerInstanceId !== e.runner_instance_id || prepared.capture.mountGeneration !== m.generation
      || original.phase === 'call' && stdioSha256V2('spec', prepared.actualExecutorImage, budget)
        !== stdioSha256V2('spec', original.selection.catalogImageExpectation, budget)) throw invalid()
    return prepared
  }
}
