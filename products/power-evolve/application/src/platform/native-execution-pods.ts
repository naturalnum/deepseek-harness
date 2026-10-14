/** Credential-free gVisor payload Pods with durable admission and exact kubelet stop observations. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Pool } from 'pg'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { nativeExecutionWorld, type NativeExecutionWorld } from '../native-execution/types.ts'
import type { StorageBinding } from './cloud-storage-types.ts'
import { KubernetesClient, KubernetesError } from './kubernetes.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'
import { digest } from './identity.ts'
import { SafePosix } from './safe-posix.ts'

const FINALIZER = 'powerevolve.dev/native-execution-stop'
const podSchema = z.object({ metadata: z.object({ name: z.string(), uid: z.string().min(1), resourceVersion: z.string(),
  labels: z.record(z.string(), z.string()), finalizers: z.array(z.string()).optional(), deletionTimestamp: z.string().optional() }).loose(),
spec: z.object({ nodeName: z.string().optional() }).loose(), status: z.object({ phase: z.string().optional(),
  containerStatuses: z.array(z.object({ ready: z.boolean() }).loose()).optional() }).loose().optional() }).loose()

/** Platform-only Pod configuration; every resource is created inside one explicit owned namespace. */
export interface NativeExecutionPodConfig {
  namespace: string
  runtimeClassName: string
  image: string
  storageVolumeClaim: string
  storageVolumePrefix: string
  homeVolumePrefix: string
  homeLocalRoot: string
  tmpVolumePrefix: string
  tmpLocalRoot: string
  nodeName?: string
  cpu: string
  memory: string
  /** Scheduling requests; omitted fields retain the corresponding hard limit. */
  requestCpu?: string
  requestMemory?: string
  pollMs: number
  readyTimeoutMs: number
  stopTimeoutMs: number
  maxPodSeconds: number
}

/** Durable managed range; a missing Pod without persisted stop evidence remains uncertain. */
export interface NativeExecutionPod {
  id: string
  name: string
  uid: string
  world: NativeExecutionWorld
}

/** Owns only native-execution Pods; user processes receive neither control credentials nor shared roots. */
export class NativeExecutionPods {
  readonly config: NativeExecutionPodConfig & { requestCpu: string; requestMemory: string }
  private readonly homes: SafePosix
  private readonly temporary: SafePosix
  constructor(private readonly pool: Pool, private readonly kube: KubernetesClient, config: NativeExecutionPodConfig) {
    this.config = { ...config, requestCpu: config.requestCpu ?? config.cpu, requestMemory: config.requestMemory ?? config.memory }
    this.homes = new SafePosix(config.homeLocalRoot, { uid: 1000, gid: 1000 })
    this.temporary = new SafePosix(config.tmpLocalRoot, { uid: 1000, gid: 1000 })
  }

  /** Admit once before creating a Pod; failed creates reconcile the same name and never reissue the command.
   * @param world Original Agent world.
   * @param binding Server-selected storage generation.
   * @param kind Process, terminal, or native filesystem utility.
   * @param request Exact wire request retained as an identity digest.
   * @param assertAuthority Rechecks current grant and both generations before mutation.
   * @param admissionId Optional original caller nonce; never reused for another dispatch.
   * @returns Exact ready Pod UID, or a durable uncertain admission.
   */
  async create(world: NativeExecutionWorld, binding: StorageBinding, kind: 'process' | 'terminal' | 'filesystem',
    request: unknown, assertAuthority: () => Promise<unknown>, admissionId?: string): Promise<NativeExecutionPod> {
    await assertAuthority()
    await this.homes.init()
    await this.homes.ensureWorkspace(world.userId)
    await this.temporary.init()
    await this.temporary.ensureWorkspace(world.userId)
    await this.temporary.createDirectory(world.userId, [], '.native-tmp')
    await this.temporary.createDirectory(world.userId, ['.native-tmp'], world.sessionId)
    const id = admissionId ?? randomUUID(), name = 'pe-native-' + id
    await this.pool.query(`INSERT INTO pe_native_execution_processes(id,world_id,kind,namespace,pod_name,state,request_digest)
      VALUES($1,$2,$3,$4,$5,'admitted',$6)`, [id, world.worldId, kind, this.config.namespace, name, digest(JSON.stringify(request))])
    const labels = { 'powerevolve.dev/native-world': world.worldId, 'powerevolve.dev/native-process': id }
    const prefix = this.config.storageVolumePrefix.replace(/\/$/u, '')
    const root = [prefix, binding.rootKey, binding.rootRelativePath].filter(Boolean).join('/')
    const home = [this.config.homeVolumePrefix.replace(/\/$/u, ''), world.userId].filter(Boolean).join('/')
    const temporary = [this.config.tmpVolumePrefix, world.userId, '.native-tmp', world.sessionId].join('/')
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name, labels, finalizers: [FINALIZER] }, spec: {
      runtimeClassName: this.config.runtimeClassName, restartPolicy: 'Never', automountServiceAccountToken: false,
      ...(this.config.nodeName === undefined ? {} : { nodeName: this.config.nodeName }),
      terminationGracePeriodSeconds: 1, activeDeadlineSeconds: this.config.maxPodSeconds,
      securityContext: { runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'payload', image: this.config.image, imagePullPolicy: 'IfNotPresent',
        command: ['/bin/sleep', 'infinity'], workingDir: '/workspace',
        env: [{ name: 'HOME', value: '/home/agent' }, { name: 'PATH', value: '/usr/local/bin:/usr/bin:/bin' }],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: this.config.requestCpu, memory: this.config.requestMemory }, limits: { cpu: this.config.cpu,
          memory: this.config.memory } },
        volumeMounts: [{ name: 'data', mountPath: '/workspace', subPath: root, readOnly: world.mode === 'read-only' },
          { name: 'data', mountPath: '/home/agent', subPath: home, readOnly: world.mode !== 'danger-full-access' },
          { name: 'data', mountPath: '/tmp', subPath: temporary, readOnly: world.mode === 'read-only' }] }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: this.config.storageVolumeClaim } }],
    } }
    let current: z.infer<typeof podSchema> | undefined
    try {
      await assertAuthority()
      await this.pool.query("UPDATE pe_native_execution_processes SET state='creating',updated_at=clock_timestamp() WHERE id=$1 AND state='admitted'", [id])
      try { current = podSchema.parse(await this.kube.call('POST', this.path(), pod)) }
      catch (error) {
        current = await this.get(name)
        if (!current) throw error
      }
      this.check(current, name, labels)
      const range = { id, name, uid: current.metadata.uid, world }
      await this.pool.query('UPDATE pe_native_execution_processes SET pod_uid=$2 WHERE id=$1 AND pod_uid IS NULL', [id, range.uid])
      const deadline = Date.now() + this.config.readyTimeoutMs
      while (Date.now() < deadline) {
        await assertAuthority()
        current = await this.get(name)
        if (!current) throw new Error('native_payload_disappeared_before_ready')
        this.check(current, name, labels, range.uid)
        if (current.metadata.deletionTimestamp || ['Failed', 'Succeeded'].includes(current.status?.phase ?? '')) {
          throw new Error('native_payload_failed_before_ready')
        }
        if (current.status?.phase === 'Running' && current.status.containerStatuses?.length === 1
          && current.status.containerStatuses[0]?.ready) {
          await this.pool.query("UPDATE pe_native_execution_processes SET state='running',updated_at=clock_timestamp() WHERE id=$1 AND pod_uid=$2", [id, range.uid])
          return range
        }
        await delay(this.config.pollMs)
      }
      throw new Error('native_payload_ready_timeout')
    } catch (error) {
      await this.pool.query("UPDATE pe_native_execution_processes SET state='uncertain',updated_at=clock_timestamp() WHERE id=$1", [id])
      if (current) {
        this.check(current, name, labels)
        await this.stop({ id, name, uid: current.metadata.uid, world }, 'failure')
      }
      throw error
    }
  }

  /** Stop the whole original Pod range, persist native kubelet evidence, then release its finalizer.
   * Cleanup remains permitted after account/operation revocation; no new execution is authorized.
   * @param range Exact original Pod identity.
   * @param cause First stop cause; subsequent requests cannot replace it.
   * @returns Completion only after positive exact stop evidence is durable.
   */
  async stop(range: NativeExecutionPod, cause: 'abort' | 'authority' | 'dispose' | 'completed' | 'failure'): Promise<void> {
    const deadline = Date.now() + this.config.stopTimeoutMs
    const stored = await this.pool.query<{ state: string; stop_evidence: unknown }>(
      `UPDATE pe_native_execution_processes SET first_stop_cause=COALESCE(first_stop_cause,$3),
       state=CASE WHEN state='stopped' THEN state ELSE 'stopping' END,updated_at=clock_timestamp()
       WHERE id=$1 AND world_id=$2 AND pod_name=$4 AND pod_uid=$5 RETURNING state,stop_evidence`,
      [range.id, range.world.worldId, cause, range.name, range.uid])
    const record = stored.rows[0]
    if (!record) throw new Error('native_payload_stop_identity_changed')
    const labels = { 'powerevolve.dev/native-world': range.world.worldId, 'powerevolve.dev/native-process': range.id }
    let pod = await this.get(range.name, this.remaining(deadline))
    if (record.state === 'stopped') {
      const proof = z.object({ processId: z.string(), podUid: z.string(), worldId: z.string(),
        status: z.enum(['KUBELET_STOPPED', 'UNSCHEDULED_DELETING']), observation: podSchema }).loose().parse(record.stop_evidence)
      if (proof.processId !== range.id || proof.podUid !== range.uid || proof.worldId !== range.world.worldId) {
        throw new Error('native_payload_stop_evidence_identity_changed')
      }
      this.check(proof.observation, range.name, labels, range.uid, false)
      if (kubernetesPodStopStatus(proof.observation) !== proof.status) throw new Error('native_payload_stop_evidence_invalid')
      await this.releaseFinalizer(proof.observation, deadline)
      return
    }
    if (!pod) throw new Error('native_payload_stop_evidence_missing')
    this.check(pod, range.name, labels, range.uid)
    if (!pod.metadata.deletionTimestamp) await this.kube.call('DELETE', this.path(range.name), {
      apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: range.uid }, gracePeriodSeconds: 1 }, this.remaining(deadline))
    while (Date.now() < deadline) {
      pod = await this.get(range.name, this.remaining(deadline))
      if (!pod) throw new Error('native_payload_stop_evidence_missing')
      this.check(pod, range.name, labels, range.uid)
      const status = kubernetesPodStopStatus(pod)
      if (status === 'KUBELET_STOPPED' || status === 'UNSCHEDULED_DELETING') {
        const evidence = { status, podUid: range.uid, processId: range.id, worldId: range.world.worldId,
          storageGeneration: range.world.storageGeneration, permissionGeneration: range.world.permissionGeneration,
          observedAt: new Date().toISOString(), observation: pod }
        await this.pool.query(`UPDATE pe_native_execution_processes SET state='stopped',stop_evidence=$3,
          updated_at=clock_timestamp() WHERE id=$1 AND pod_uid=$2 AND state='stopping'`, [range.id, range.uid, evidence])
        await this.releaseFinalizer(pod, deadline)
        return
      }
      await delay(Math.min(this.config.pollMs, Math.max(0, deadline - Date.now())))
    }
    await this.pool.query("UPDATE pe_native_execution_processes SET state='uncertain',updated_at=clock_timestamp() WHERE id=$1 AND pod_uid=$2 AND state<>'stopped'", [range.id, range.uid])
    throw new Error('native_payload_stop_unconfirmed')
  }

  /** Resolve an original durable range for cleanup after controller restart; never recreate an admission.
   * @param world Original issued world already authenticated for ownership.
   * @param id Caller-retained original admission nonce.
   * @returns Exact original Pod identity, or undefined if no admission occurred.
   */
  async original(world: NativeExecutionWorld, id: string): Promise<NativeExecutionPod | undefined> {
    const result = await this.pool.query<{ name: string; uid: string | null }>(
      'SELECT pod_name AS name,pod_uid AS uid FROM pe_native_execution_processes WHERE id=$1 AND world_id=$2 AND namespace=$3',
      [id, world.worldId, this.config.namespace])
    const row = result.rows[0]
    if (!row) return undefined
    let uid = row.uid
    if (!uid) {
      const pod = await this.get(row.name)
      if (!pod) throw new Error('native_payload_original_admission_uncertain')
      this.check(pod, row.name, { 'powerevolve.dev/native-world': world.worldId, 'powerevolve.dev/native-process': id })
      uid = pod.metadata.uid
      await this.pool.query('UPDATE pe_native_execution_processes SET pod_uid=$2 WHERE id=$1 AND pod_uid IS NULL', [id, uid])
    }
    return { id, name: row.name, uid, world }
  }

  /** Persist command outcome only after the exact whole range has positive stop evidence.
   * @param range Original immutable process identity.
   * @param outcome Native guest wait facts; separate from range-stop proof.
   */
  async recordOutcome(range: NativeExecutionPod, outcome: SubprocessOutcome): Promise<void> {
    const result = await this.pool.query(`UPDATE pe_native_execution_processes SET outcome=$4,updated_at=clock_timestamp()
      WHERE id=$1 AND world_id=$2 AND pod_uid=$3 AND state='stopped' RETURNING id`, [range.id, range.world.worldId, range.uid, outcome])
    if (result.rowCount !== 1) throw new Error('native_payload_outcome_requires_stop_evidence')
  }

  /** Reconcile original admissions on exclusive broker startup; no command or Pod is recreated.
   * @param maximum Maximum original rows allowed in one bounded recovery pass.
   * @returns Uncertain identities that still lack positive native stop observations.
   */
  async recover(maximum: number): Promise<string[]> {
    const result = await this.pool.query<{ id: string; name: string; uid: string | null; world: unknown }>(
      `SELECT p.id,p.pod_name AS name,p.pod_uid AS uid,jsonb_build_object('worldId',w.id,'userId',w.user_id,
       'sessionId',w.session_id,'agentId',w.agent_id,'workspaceId',w.workspace_id,'operationId',w.operation_id,
       'operationEpoch',w.operation_epoch,'storageGeneration',w.storage_generation,'permissionGeneration',w.permission_generation,
       'mode',w.mode,'workspaceRoot','/workspace','homeRoot','/home/agent') AS world
       FROM pe_native_execution_processes p JOIN pe_native_execution_worlds w ON w.id=p.world_id
       WHERE p.namespace=$1 AND (p.state<>'stopped' OR p.stop_evidence->>'resourceReleased' IS DISTINCT FROM 'true')
       ORDER BY p.created_at LIMIT $2`, [this.config.namespace, maximum + 1])
    if (result.rows.length > maximum) throw new Error('native_payload_recovery_budget')
    const uncertain: string[] = []
    for (const row of result.rows) {
      const world = nativeExecutionWorld.parse(row.world)
      let uid = row.uid
      if (uid === null) {
        const pod = await this.get(row.name)
        if (!pod) { uncertain.push(row.id); continue }
        this.check(pod, row.name, { 'powerevolve.dev/native-world': world.worldId, 'powerevolve.dev/native-process': row.id })
        uid = pod.metadata.uid
        await this.pool.query('UPDATE pe_native_execution_processes SET pod_uid=$2 WHERE id=$1 AND pod_uid IS NULL', [row.id, uid])
      }
      try { await this.stop({ id: row.id, name: row.name, uid, world }, 'dispose') }
      catch (error) {
        if (error instanceof Error && ['native_payload_stop_unconfirmed', 'native_payload_stop_evidence_missing'].includes(error.message)) {
          uncertain.push(row.id)
        } else throw error
      }
    }
    return uncertain
  }

  private releaseObservation(original: z.infer<typeof podSchema>, current: z.infer<typeof podSchema>): void {
    if (!current.metadata.deletionTimestamp || !isDeepStrictEqual(current.spec, original.spec)
      || current.metadata.generation !== original.metadata.generation) throw new Error('native_payload_stopped_identity_changed')
    if (kubernetesPodStopStatus(current) !== kubernetesPodStopStatus(original)
      || !isDeepStrictEqual(current.status?.containerStatuses, original.status?.containerStatuses)
      || !isDeepStrictEqual(current.status?.initContainerStatuses, original.status?.initContainerStatuses)) {
      throw new Error('native_payload_stop_facts_changed')
    }
  }

  private remaining(deadline: number): number {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('native_payload_release_unconfirmed')
    return Math.min(10_000, remaining)
  }

  private async releaseFinalizer(original: z.infer<typeof podSchema>, deadline: number): Promise<void> {
    const worldId = original.metadata.labels['powerevolve.dev/native-world']
    const processId = original.metadata.labels['powerevolve.dev/native-process']
    const positive = kubernetesPodStopStatus(original)
    if (!worldId || !processId || !positive) throw new Error('native_payload_stop_evidence_invalid')
    const labels = { 'powerevolve.dev/native-world': worldId, 'powerevolve.dev/native-process': processId }
    for (;;) {
      const current = await this.get(original.metadata.name, this.remaining(deadline))
      // Absence is a resource-release fact only after the original positive stop observation was durable.
      if (!current) break
      this.check(current, original.metadata.name, labels, original.metadata.uid, false)
      this.releaseObservation(original, current)
      if (!current.metadata.finalizers?.includes(FINALIZER)) break
      try {
        const updated = podSchema.parse(await this.kube.call('PATCH', this.path(current.metadata.name), { metadata: { uid: current.metadata.uid,
          resourceVersion: current.metadata.resourceVersion,
          finalizers: current.metadata.finalizers.filter(value => value !== FINALIZER) } }, this.remaining(deadline)))
        this.check(updated, original.metadata.name, labels, original.metadata.uid, false)
        this.releaseObservation(original, updated)
        if (updated.metadata.finalizers?.includes(FINALIZER) || current.metadata.finalizers.some(value => value !== FINALIZER
          && !updated.metadata.finalizers?.includes(value))) throw new Error('native_payload_finalizer_release_unconfirmed')
        break
      } catch (error) {
        if (error instanceof KubernetesError && error.status === 404) break
        if (!(error instanceof KubernetesError && error.status === 409)) throw error
        // Reconcile only this original cleanup CAS; payload admission and execution are never repeated.
        await delay(Math.min(this.config.pollMs, this.remaining(deadline)))
      }
    }
    const released = await this.pool.query(`UPDATE pe_native_execution_processes SET stop_evidence=stop_evidence||'{"resourceReleased":true}'::jsonb
      WHERE id=$1 AND world_id=$2 AND pod_name=$3 AND pod_uid=$4 AND namespace=$5 AND state='stopped' RETURNING id`,
    [processId, worldId, original.metadata.name, original.metadata.uid, this.config.namespace])
    if (released.rowCount !== 1) throw new Error('native_payload_release_identity_changed')
  }

  private path(name?: string) { return this.kube.resourcePath(this.config.namespace, 'pods', name) }
  private async get(name: string, timeoutMs = 10_000) {
    try { return podSchema.parse(await this.kube.call('GET', this.path(name), undefined, timeoutMs)) }
    catch (error) { if (error instanceof KubernetesError && error.status === 404) return undefined; throw error }
  }
  private check(pod: z.infer<typeof podSchema>, name: string, labels: Record<string, string>, uid?: string, requireFinalizer = true) {
    if (pod.metadata.name !== name || uid !== undefined && pod.metadata.uid !== uid
      || Object.entries(labels).some(([key, value]) => pod.metadata.labels[key] !== value)
      || requireFinalizer && !pod.metadata.finalizers?.includes(FINALIZER)) throw new Error('native_payload_identity_changed')
  }
}
