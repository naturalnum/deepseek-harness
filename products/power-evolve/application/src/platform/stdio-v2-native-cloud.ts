/** Independently owned STDIO actions execute once in the common native gVisor provider. */
import { dirname, posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { stdioPreparedV2, stdioExecutorImageV2, stdioObjectV2,
  type StdioDispatchV2, type StdioPreparedV2, type StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCloudStopEvidenceV2, stdioOutcomeV2, stdioRuntimeViewV2,
  type StdioActionLeaseV2, type StdioCloudObservationV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { validateStdioStartV2 } from '@power-evolve/connector-runner/stdio-v2-dispatch'
import { nativeExecutionServiceWorld, type NativeExecutionServiceWorld } from '../native-execution/types.ts'
import { PlatformError } from '../contracts.ts'
import { storageBinding } from './cloud-storage-types.ts'
import type { NativeProcessBroker } from './native-execution-broker.ts'
import type { NativeExecutionPod } from './native-execution-pods.ts'
import { NativeExecutionServiceAuthority, nativeExecutionServiceOwner } from './native-execution-service-authority.ts'
import type { StdioCloudWorkerStoreV2 } from './stdio-v2-worker-store.ts'
import type { SandboxReady } from './sandbox.ts'
import type { StdioCloudAuthorizationV2, StdioCloudCaptureTransactionV2 } from './stdio-v2-cloud-runtime.ts'
import type { StdioNoStartResourceV2 } from './stdio-v2-no-start.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'

const resource = z.object({ action_id: z.uuid(), world: nativeExecutionServiceWorld, binding: storageBinding,
  process_id: z.uuid(), runner_instance_id: z.uuid(), pod_name: z.string(), pod_uid: z.string().nullable(),
  namespace: z.string(), state: z.string(), activation_digest: z.string().nullable(),
  prepared: stdioPreparedV2.nullable(), observation: z.unknown(), stop_evidence: z.unknown() })
type Resource = z.infer<typeof resource>

/** Native STDIO keeps approval and immutable SDK selection separate from physical lifecycle authority. */
export class StdioNativeCloudV2 {
  private readonly owned = new Map<string, NativeExecutionPod>()
  private readonly stop = new AbortController()
  private closed = false
  private closing: Promise<void> | undefined
  constructor(private readonly pool: Pool, readonly broker: NativeProcessBroker<NativeExecutionServiceWorld>,
    private readonly store: Pick<StdioCloudWorkerStoreV2, 'snapshot'>, private readonly maxReplyBytes: number) {}

  private deny(): never { throw new PlatformError(409, 'stdio_v2_native_original_changed') }
  private authority(): NativeExecutionServiceAuthority {
    if (!(this.broker.authority instanceof NativeExecutionServiceAuthority)) this.deny()
    return this.broker.authority
  }
  private async load(client: Pool | PoolClient, task: StdioTaskV2): Promise<Resource | null> {
    const result = await client.query<Record<string, unknown>>(`SELECT n.*,p.pod_name,p.pod_uid,p.namespace,p.state,
      p.activation_digest,p.stop_evidence,w.binding_snapshot AS binding,jsonb_build_object('worldId',w.id,
      'userId',w.user_id,'sessionId',w.session_id,'workspaceId',w.workspace_id,'mode',w.mode,
      'storageGeneration',w.storage_generation,'permissionGeneration',w.permission_generation,
      'workspaceRoot','/workspace','homeRoot','/home/agent','serviceId',w.service_id,
      'serviceEpoch',w.service_epoch,'authorityKind',w.authority_kind) AS world
      FROM pe_native_stdio_executions n JOIN pe_native_execution_worlds w ON w.id=n.world_id
      JOIN pe_native_execution_processes p ON p.id=n.process_id AND p.world_id=w.id
      WHERE n.action_id=$1`, [task.actionId])
    const raw = result.rows[0]
    if (!raw) return null
    const value = resource.parse(raw), scope = task.scopeBinding
    if (value.world.authorityKind !== 'stdio-action' || value.world.userId !== task.userId
      || String(value.world.sessionId) !== task.sessionId || String(value.world.workspaceId) !== scope.workspaceId
      || value.binding.workspaceId !== scope.workspaceId || value.binding.generation !== scope.bindingGeneration
      || value.binding.spaceId !== scope.target.spaceId || value.binding.rootRelativePath !== scope.target.rootRelativePath
      || value.namespace !== this.broker.pods.config.namespace) this.deny()
    return value
  }
  private range(value: Resource): NativeExecutionPod {
    if (!value.pod_uid) this.deny()
    const range = { id: value.process_id, name: value.pod_name, uid: value.pod_uid, world: value.world }
    if (value.state !== 'stopped') this.owned.set(range.id, range)
    return range
  }
  private writer(value: Resource): SandboxReady {
    const range = this.range(value)
    return { name: range.name, podUid: range.uid, runnerInstanceId: value.runner_instance_id,
      generation: String(value.world.storageGeneration), userId: value.world.userId, sessionId: value.world.sessionId,
      binding: value.binding, restartCount: value.prepared?.capture.restartCount ?? 0, token: '' }
  }
  private budget(task: StdioTaskV2) {
    return { maxDepth: task.limits.maxJsonDepth, maxNodes: task.limits.maxJsonNodes, maxBytes: task.limits.maxInputBytes }
  }
  private sha(task: StdioTaskV2, domain: 'task' | 'spec' | 'scope' | 'prepared' | 'dispatch', value: unknown) {
    return stdioSha256V2(domain, value, this.budget(task))
  }

  /** Provision one idle original Pod before approval without executing the configured MCP program.
   * @param lease Current action worker lease, verified before and after physical provisioning.
   * @returns Exact durable native resource; a lost creation acknowledgement never creates a replacement.
   */
  async prepare(lease: StdioActionLeaseV2): Promise<SandboxReady> {
    if (this.closed) throw new Error('stdio_v2_native_closed')
    const original = await this.store.snapshot(lease), task = original.task
    if (original.cancelRequested || original.dispatch) this.deny()
    const prior = await this.load(this.pool, task)
    if (prior) return this.writer(prior)
    const issued = await this.authority().issue(nativeExecutionServiceOwner.parse({ userId: task.userId,
      kind: 'stdio-action', id: task.actionId, epoch: 1, workerId: original.executionRef.executionId }))
    const inserted = await this.pool.query(`INSERT INTO pe_native_stdio_executions(action_id,world_id,process_id,runner_instance_id)
      VALUES($1,$2,$3,$3) ON CONFLICT(action_id) DO NOTHING RETURNING action_id`,
    [task.actionId, issued.world.worldId, original.executionRef.executionId])
    if (inserted.rowCount !== 1) this.deny()
    await this.broker.pods.create(issued.world, issued.binding, 'process',
      { kind: 'stdio-preparation', actionId: task.actionId, taskDigest: original.taskDigest },
      async () => { const current = await this.store.snapshot(lease)
        if (this.closed || current.cancelRequested || current.dispatch) this.deny()
        return this.broker.authority.assert(issued.token, issued.world, 'storage-read') },
      original.executionRef.executionId, true)
    const ready = await this.load(this.pool, task)
    if (!ready) this.deny()
    return this.writer(ready)
  }

  /** Validate one original native capture under the worker's existing account and action transaction.
   * @param client Existing original worker transaction.
   * @param task Original complete accepted task.
   * @param ready Captured exact execution identity; no user-wide slot is consulted.
   */
  async ready(client: PoolClient, task: StdioTaskV2, ready: SandboxReady): Promise<void> {
    const value = await this.load(client, task)
    if (!value || !isDeepStrictEqual(this.writer(value), ready)) this.deny()
  }

  /** Capture immutable observed image, spec and actual mounts for the original approval.
   * @param client Existing original authorization transaction; no extra PG connection is borrowed.
   * @param task Original complete accepted task.
   * @param _ref Original protocol execution reference, independently checked against its retained process.
   * @returns Strict preparation; no program starts and no bearer is returned.
   */
  async capture(client: PoolClient, task: StdioTaskV2, _ref?: StdioPreparedV2['executionRef']): Promise<StdioPreparedV2> {
    const value = await this.load(client, task)
    if (!value || value.state !== 'running' || value.activation_digest !== null) this.deny()
    const observation = await this.broker.pods.capture(this.range(value))
    const pod = z.object({ spec: z.object({ nodeName: z.string(), containers: z.array(z.object({
      name: z.literal('payload'), image: z.string(), volumeMounts: z.array(z.object({ name: z.string(),
        mountPath: z.string(), subPath: z.string(), readOnly: z.boolean().default(false) }).loose()) }).loose()).length(1),
    volumes: z.array(z.object({ name: z.string(), persistentVolumeClaim: z.object({ claimName: z.string() }) }).loose()) }).loose(),
    status: z.object({ containerStatuses: z.array(z.object({ name: z.literal('payload'), imageID: z.string(),
      containerID: z.string(), restartCount: z.number().int().nonnegative() }).loose()).length(1) }).loose(),
    }).loose().parse(observation.pod)
    const node = z.object({ metadata: z.object({ name: z.literal(pod.spec.nodeName) }).loose(), status: z.object({
      nodeInfo: z.object({ operatingSystem: z.string(), architecture: z.string() }).loose() }).loose() }).loose().parse(observation.node)
    const container = pod.spec.containers[0], status = pod.status.containerStatuses[0]
    if (!container || !status) this.deny()
    if (container.image !== task.expectedDeploymentPin.imageReference || status.restartCount !== 0) this.deny()
    const mount = (path: '/workspace' | '/home/agent') => {
      const entry = container.volumeMounts.find(item => item.mountPath === path)
      const volume = pod.spec.volumes.find(item => item.name === entry?.name)
      if (!entry || !volume) return this.deny()
      return { claimName: volume.persistentVolumeClaim.claimName, subPath: entry.subPath,
        mountPath: path, readOnly: entry.readOnly }
    }
    const prepared = stdioPreparedV2.parse({ formatVersion: 2, actionId: task.actionId,
      executionRef: { kind: 'cloud', executionId: value.process_id }, taskDigest: this.sha(task, 'task', task),
      scopeBinding: task.scopeBinding, expectedDeploymentPin: task.expectedDeploymentPin,
      actualExecutorImage: stdioExecutorImageV2.parse({ kind: 'cloud', imageReference: container.image,
        runtimeImageId: status.imageID, platform: { os: node.status.nodeInfo.operatingSystem,
          architecture: node.status.nodeInfo.architecture } }),
      capture: { kind: 'cloud', podUid: value.pod_uid, podName: value.pod_name, namespace: value.namespace,
        nodeName: pod.spec.nodeName, runnerInstanceId: value.runner_instance_id, containerId: status.containerID,
        restartCount: status.restartCount, mountGeneration: String(value.world.storageGeneration),
        workspaceMount: mount('/workspace'), homeMount: mount('/home/agent') },
      specDigest: this.sha(task, 'spec', stdioObjectV2(this.budget(task)).parse(pod.spec)),
      fullScopeDigest: this.sha(task, 'scope', { scopeBinding: task.scopeBinding,
        workspaceMount: mount('/workspace'), homeMount: mount('/home/agent') }) })
    if (value.prepared && !isDeepStrictEqual(value.prepared, prepared)) this.deny()
    await client.query(`UPDATE pe_native_stdio_executions SET prepared=$2,updated_at=clock_timestamp()
      WHERE action_id=$1 AND (prepared IS NULL OR prepared=$2::jsonb)`, [task.actionId, prepared])
    return prepared
  }

  private async check(capture: StdioCloudCaptureTransactionV2, dispatch: StdioDispatchV2,
    prepared: StdioPreparedV2, mode: 'dispatch' | 'observe'): Promise<Resource> {
    let retained: Resource | undefined
    await capture(mode, async (client) => {
      const value = await this.load(client, dispatch.task)
      if (!value || !isDeepStrictEqual(value.prepared, prepared)
        || this.sha(dispatch.task, 'prepared', prepared) !== dispatch.preparedDigest) this.deny()
      retained = value
      if (mode === 'dispatch' && !isDeepStrictEqual(await this.capture(client, dispatch.task), prepared)) this.deny()
      return this.writer(value)
    })
    if (!retained) return this.deny()
    return retained
  }

  /** Consume only an actual original true authorization in the prepared native Pod, then await exact Pod stop.
   * @param dispatch Original immutable SDK selection and committed permit.
   * @param authorization Original true reply; query receipts grant observation only.
   * @param prepared Original actual Pod preparation.
   * @param capture Current worker lease transaction, committed before physical dispatch.
   * @param environment Optional private resolver invoked only before this once-only start.
   * @returns Exact native stop observation after SDK result persistence; lost output is never replayed.
   */
  async startDetached(dispatch: StdioDispatchV2, authorization: StdioCloudAuthorizationV2, prepared: StdioPreparedV2,
    capture: StdioCloudCaptureTransactionV2, environment?: () => Promise<Readonly<Record<string, string>>>,
  ): Promise<StdioCloudObservationV2 | null> {
    if (this.closed) throw new Error('stdio_v2_native_closed')
    if (!authorization.grantOnce) return this.observeDetached(dispatch, prepared, capture)
    validateStdioStartV2({ dispatch, authorization }, dispatch.task.limits, dispatch.permit.executorOwner, Date.now())
    const value = await this.check(capture, dispatch, prepared, 'dispatch')
    if (value.activation_digest !== null) return this.observeDetached(dispatch, prepared, capture)
    const issued = await this.authority().issue(nativeExecutionServiceOwner.parse({ userId: dispatch.task.userId,
      kind: 'stdio-action', id: dispatch.task.actionId, epoch: 1, workerId: value.process_id }))
    if (!isDeepStrictEqual(issued.world, value.world)) this.deny()
    const env = await environment?.()
    const handle = this.broker.spawn(issued.token, issued.world, { argv: ['node',
      posix.join(dirname(this.broker.config.fsWorkerPath), 'native-stdio-worker.mjs')], cwd: '/workspace',
    graceMs: this.broker.config.transportGraceMs, signal: this.stop.signal, stdio: { stdin: { data: JSON.stringify({
      packet: { dispatch, authorization }, limits: dispatch.task.limits, maxReplyBytes: this.maxReplyBytes,
      ...(env ? { environment: env } : {}) }) },
    stdout: { maxBytes: this.maxReplyBytes }, stderr: { maxBytes: this.maxReplyBytes } } }, 'process', false, value.process_id, this.range(value), async () => {
      await this.check(capture, dispatch, prepared, 'observe')
    })
    await handle.done.catch(() => undefined)
    await this.assertStopped(this.pool, dispatch.task, this.range(value).uid)
    const output = handle.collected.stdout?.readFrom(0)
    if (!output || output.lossy || !output.text) throw new PlatformError(409, 'stdio_v2_native_result_uncertain')
    const outcome = stdioOutcomeV2(dispatch.task.limits, this.maxReplyBytes).parse(JSON.parse(output.text))
    const view = stdioRuntimeViewV2(dispatch.task.limits, this.maxReplyBytes).parse({ formatVersion: 2,
      instanceId: value.runner_instance_id, actionId: dispatch.task.actionId, executionRef: dispatch.executionRef,
      taskDigest: dispatch.taskDigest, dispatchDigest: this.sha(dispatch.task, 'dispatch', dispatch),
      state: outcome.state, outcome, writerStopConfirmed: true,
      ...(outcome.state === 'failed' ? { errorCode: outcome.errorCode } : {}) })
    const proof = stdioCloudStopEvidenceV2.parse({ formatVersion: 2, kind: 'cloud_uid_quiet',
      actionId: dispatch.task.actionId, executionRef: dispatch.executionRef, taskDigest: dispatch.taskDigest,
      dispatchDigest: view.dispatchDigest, preparedDigest: dispatch.preparedDigest, fullScopeDigest: prepared.fullScopeDigest,
      podUid: value.pod_uid, runnerInstanceId: value.runner_instance_id,
      mountGeneration: prepared.capture.mountGeneration, observedAt: new Date().toISOString() })
    const observation = { view, stopEvidence: proof }
    await capture('observe', async (client) => {
      await this.assertStopped(client, dispatch.task, proof.podUid)
      const status = await client.query<{ cancelled: boolean }>(`SELECT a.cancel_requested OR e.cancel_requested
        OR NOT u.enabled OR u.deleted_at IS NOT NULL AS cancelled FROM pe_stdio_v2_actions a
        JOIN pe_cloud_executions e ON e.id=a.execution_id JOIN pe_users u ON u.id=a.user_id WHERE a.id=$1`,
      [dispatch.task.actionId])
      if (status.rows[0]?.cancelled) { view.state = 'cancelled'; view.errorCode = 'stdio_v2_cancelled' }
      await client.query(`UPDATE pe_native_stdio_executions SET observation=$2,updated_at=clock_timestamp()
        WHERE action_id=$1 AND observation IS NULL`, [dispatch.task.actionId, observation])
      return this.writer(value)
    })
    return observation
  }

  /** Observe the durable original result; a cold process or lost output never authorizes a replay.
   * @param dispatch Original immutable dispatch.
   * @param prepared Original Pod preparation.
   * @param capture Current original worker lease transaction.
   * @returns Persisted result or null when original external effects remain unresolved.
   */
  async observeDetached(dispatch: StdioDispatchV2, prepared: StdioPreparedV2,
    capture: StdioCloudCaptureTransactionV2): Promise<StdioCloudObservationV2 | null> {
    const value = await this.check(capture, dispatch, prepared, 'observe')
    if (value.observation === null) return null
    const observation = z.object({ view: stdioRuntimeViewV2(dispatch.task.limits, this.maxReplyBytes),
      stopEvidence: stdioCloudStopEvidenceV2 }).strict().parse(value.observation)
    await this.assertStopped(this.pool, dispatch.task, observation.stopEvidence.podUid)
    return observation
  }

  /** Stop only the captured original Pod; absence of an SDK result remains unresolved after cancellation.
   * @param dispatch Original dispatch; no SDK invocation is reconstructed.
   * @param prepared Original exact Pod preparation.
   * @param capture Current worker observation transaction.
   * @returns Previously persisted SDK result, or null when output is unknown.
   */
  async cancelDetached(dispatch: StdioDispatchV2, prepared: StdioPreparedV2,
    capture: StdioCloudCaptureTransactionV2): Promise<StdioCloudObservationV2 | null> {
    const value = await this.check(capture, dispatch, prepared, 'observe')
    await this.broker.pods.stop(this.range(value), 'abort')
    return this.observeDetached(dispatch, prepared, capture)
  }

  /** Require durable full-Pod stop and resource release for the exact original UID.
   * @param client Original producer transaction or trusted provider pool.
   * @param task Original accepted SDK task.
   * @param uid Exact captured native Pod UID.
   */
  async assertStopped(client: Pool | PoolClient, task: StdioTaskV2, uid: string): Promise<void> {
    const value = await this.load(client, task)
    const proof = z.object({ processId: z.string(), worldId: z.string(), podUid: z.string(),
      resourceReleased: z.literal(true), status: z.string(), observation: z.unknown() }).loose().safeParse(value?.stop_evidence)
    if (!value || value.state !== 'stopped' || value.pod_uid !== uid || !proof.success
      || proof.data.processId !== value.process_id || proof.data.worldId !== value.world.worldId
      || proof.data.podUid !== uid || kubernetesPodStopStatus(proof.data.observation) !== proof.data.status) this.deny()
    this.owned.delete(value.process_id)
  }

  /** Recycle an unstarted original prepared Pod without borrowing a different action or releasing sibling resources.
   * @param lease Exact current action lease.
   */
  async retireUnstarted(lease: StdioActionLeaseV2): Promise<void> {
    const original = await this.store.snapshot(lease)
    if (!original.cancelRequested || original.dispatch) this.deny()
    const value = await this.load(this.pool, original.task)
    if (value) {
      const original = await this.broker.pods.original(value.world, value.process_id)
      if (!original) this.deny()
      await this.broker.pods.stop(original, 'abort')
    }
  }

  /** Read only exact original no-start resource disposition in the existing closure transaction.
   * @param client Existing original action transaction.
   * @param task Original accepted task.
   * @returns Unallocated or positively stopped original native resource.
   */
  async noStart(client: PoolClient, task: StdioTaskV2): Promise<StdioNoStartResourceV2> {
    const value = await this.load(client, task)
    if (!value) {
      if ((await client.query(`SELECT n.action_id FROM pe_native_stdio_executions n
        JOIN pe_native_execution_processes p ON p.id=n.process_id WHERE n.action_id=$1`, [task.actionId])).rowCount) {
        throw new PlatformError(409, 'stdio_v2_no_start_resources_unavailable')
      }
      return { kind: 'unallocated' }
    }
    await this.assertStopped(client, task, this.range(value).uid)
    return { kind: 'native_stopped', name: value.pod_name, podUid: this.range(value).uid,
      runnerInstanceId: value.runner_instance_id, mountGeneration: String(value.world.storageGeneration),
      bindingSnapshot: value.binding, processId: value.process_id, worldId: value.world.worldId }
  }

  /** Close admission and interrupt active original ranges before joining action workers. */
  interrupt(): void { this.closed = true; this.stop.abort() }

  /** Join idle original ranges after the supervisor has stopped and joined action workers.
   * @returns Completion after every retained exact Pod has positive released stop evidence.
   */
  dispose(): Promise<void> {
    this.interrupt()
    return this.closing ??= (async () => {
      const stopped = await Promise.allSettled([...this.owned.values()].map(range => this.broker.pods.stop(range, 'dispose')))
      const failures = stopped.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length) throw new AggregateError(failures, 'Native STDIO preparation disposal failed')
      this.owned.clear()
    })()
  }

}
