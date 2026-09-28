/** One writable Kubernetes mount slot per user, with a distinct Pod and runner for each Session. */
import { createHmac } from 'node:crypto'
import { chown, lstat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolClient } from 'pg'
import type { FileService } from './files.ts'
import { transaction } from './database.ts'
import { KubernetesClient, KubernetesError } from './kubernetes.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'

const STOP_FINALIZER = 'powerevolve.dev/retain-stop-observation'
type SlotState = 'free' | 'reserved' | 'ready' | 'stopping' | 'unknown'
interface MountSlot {
  user_id: string; session_id: string | null; workspace_id: string | null; generation: string
  state: SlotState; pod_uid: string | null; runner_instance_id: string | null
  stop_pod_uid: string | null; stop_evidence: unknown
}
interface Metadata { name: string; uid?: string; resourceVersion?: string; labels?: Record<string, string>; deletionTimestamp?: string;
  finalizers?: string[]; ownerReferences?: Array<{ uid?: string }> }
interface Resource { metadata: Metadata; spec?: Record<string, unknown>; status?: Record<string, unknown>; data?: Record<string, string> }
interface Pod extends Resource { status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean; restartCount?: number }> } }
export interface SandboxReady { name: string; podUid: string; runnerInstanceId: string; token: string; restartCount: number;
  generation: string; sessionId: string; userId: string }
export interface SandboxConfig {
  readonly namespace: string
  readonly image: string
  readonly localRoot: string
  readonly nodeRoot: string
  readonly readyTimeoutMs: number
}

/** Retryable means another live Session currently owns the slot; all other cases require reconciliation. */
export class MountSlotBlocked extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code) }
}

type Acquired = { kind: 'reserved' | 'ready'; slot: MountSlot }
  | { kind: 'stop'; slot: MountSlot }
  | { kind: 'blocked'; code: string; retryable: boolean }

/** The platform owns Kubernetes credentials; neither Host nor browser receives a Pod or mount path. */
export class SandboxManager {
  constructor(private readonly kube: KubernetesClient, private readonly files: FileService, private readonly pool: Pool,
    private readonly key: string, private readonly config: SandboxConfig) {}

  /** The physical resource name is stable for the user's shared writable Home. */
  name(userId: string): string { return `pe-sb-${userId.replaceAll('-', '')}` }
  private token(name: string, sessionId: string, generation: string): string {
    return createHmac('sha256', this.key).update(`${name}:${sessionId}:${generation}`).digest('hex')
  }
  private labels(sessionId: string, userId: string, name: string, generation: string): Record<string, string> {
    return { 'app.kubernetes.io/name': 'power-evolve-sandbox', 'app.kubernetes.io/instance': name,
      'powerevolve.dev/session': sessionId, 'powerevolve.dev/user': userId,
      'powerevolve.dev/generation': generation }
  }
  private async lockUser(client: PoolClient, userId: string): Promise<void> {
    const result = await client.query('SELECT id FROM pe_users WHERE id=$1 FOR UPDATE', [userId])
    if (!result.rowCount) throw new MountSlotBlocked('mount_user_missing', false)
  }
  private async get(resource: 'sandboxes' | 'pods' | 'services' | 'secrets', name: string): Promise<Resource | null> {
    try { return await this.kube.call<Resource>('GET', this.kube.resourcePath(this.config.namespace, resource, name)) }
    catch (error) { if (error instanceof KubernetesError && error.status === 404) return null; throw error }
  }
  private async ensure(resource: 'sandboxes' | 'services' | 'secrets', name: string,
    body: Record<string, unknown>, labels: Record<string, string>, token: string): Promise<void> {
    const matches = (expected: unknown, actual: unknown): boolean => {
      if (typeof expected !== 'object' || expected === null) return expected === actual
      if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length
        && expected.every((item, index) => matches(item, actual[index]))
      return typeof actual === 'object' && actual !== null && !Array.isArray(actual)
        && Object.entries(expected).every(([key, item]) => matches(item, (actual as Record<string, unknown>)[key]))
    }
    const sameResource = (value: Resource | null): boolean => value !== null && value.metadata.name === name
      && Object.entries(labels).every(([key, expected]) => value.metadata.labels?.[key] === expected)
      && (resource === 'secrets'
        ? value.data?.token === Buffer.from(token).toString('base64')
        : matches(body.spec, value.spec))
    const existing = await this.get(resource, name)
    if (existing) {
      if (!sameResource(existing) || existing.metadata.deletionTimestamp) {
        throw new MountSlotBlocked(`mount_${resource}_identity_changed`, false)
      }
      return
    }
    try { await this.kube.call('POST', this.kube.resourcePath(this.config.namespace, resource), body) }
    catch (error) {
      if (!(error instanceof KubernetesError && error.status === 409)) throw error
      const after = await this.get(resource, name)
      if (!sameResource(after) || after?.metadata.deletionTimestamp) throw error
    }
  }

  private async home(userId: string): Promise<{ local: string; node: string }> {
    const local = join(resolve(this.config.localRoot), 'homes', userId)
    await mkdir(local, { recursive: true, mode: 0o700 })
    const stat = await lstat(local)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Sandbox home is unavailable')
    await chown(local, 1000, 1000)
    return { local, node: join(this.config.nodeRoot, 'homes', userId) }
  }

  private async workspaceId(sessionId: string, userId: string): Promise<string> {
    const result = await this.pool.query<{ workspace_id: string }>(
      `SELECT s.workspace_id FROM pe_sessions s JOIN pe_workspaces w
       ON w.id=s.workspace_id AND w.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2`, [sessionId, userId])
    if (!result.rows[0]?.workspace_id) throw new MountSlotBlocked('mount_session_workspace_missing', false)
    return result.rows[0].workspace_id
  }

  private async acquire(sessionId: string, userId: string, workspaceId: string): Promise<Acquired> {
    return transaction(this.pool, async client => {
      await this.lockUser(client, userId)
      await client.query("INSERT INTO pe_mount_slots(user_id,state) VALUES($1,'free') ON CONFLICT(user_id) DO NOTHING", [userId])
      const selected = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
      const slot = selected.rows[0]!
      if (slot.state === 'free') {
        const prior = await client.query<{ state: string }>(
          'SELECT state FROM pe_sandbox_instances WHERE session_id=$1 FOR UPDATE', [sessionId])
        if (prior.rows[0] && prior.rows[0].state !== 'deleted') {
          return { kind: 'blocked', code: 'mount_instance_unreconciled', retryable: false }
        }
        const updated = await client.query<MountSlot>(
          `UPDATE pe_mount_slots SET state='reserved',session_id=$2,workspace_id=$3,
           generation=generation+1,pod_uid=NULL,runner_instance_id=NULL,updated_at=now()
           WHERE user_id=$1 AND state='free' RETURNING *`, [userId, sessionId, workspaceId])
        const created = await client.query(
          `INSERT INTO pe_sandbox_instances(session_id,user_id,name,state)
           VALUES($1,$2,$3,'creating') ON CONFLICT(session_id) DO UPDATE
           SET state='creating',name=$3,pod_uid=NULL,runner_instance_id=NULL,
             stop_pod_uid=NULL,stop_evidence=NULL,updated_at=now()
           WHERE pe_sandbox_instances.state='deleted' RETURNING session_id`,
          [sessionId, userId, this.name(userId)])
        if (!created.rowCount) throw new MountSlotBlocked('mount_instance_unreconciled', false)
        return { kind: 'reserved', slot: updated.rows[0]! }
      }
      if (slot.state === 'unknown' || slot.state === 'reserved') {
        return { kind: 'blocked', code: `mount_slot_${slot.state}`, retryable: false }
      }
      if (slot.state === 'stopping') {
        if (!slot.session_id || !slot.workspace_id || !slot.pod_uid || !slot.runner_instance_id) {
          await client.query("UPDATE pe_mount_slots SET state='unknown',updated_at=now() WHERE user_id=$1", [userId])
          return { kind: 'blocked', code: 'mount_stop_identity_missing', retryable: false }
        }
        return { kind: 'stop', slot }
      }
      if (!slot.session_id || !slot.workspace_id || !slot.pod_uid || !slot.runner_instance_id) {
        await client.query("UPDATE pe_mount_slots SET state='unknown',updated_at=now() WHERE user_id=$1", [userId])
        return { kind: 'blocked', code: 'mount_ready_identity_missing', retryable: false }
      }
      const instance = await client.query<{ state: string; user_id: string; name: string; pod_uid: string | null;
        runner_instance_id: string | null }>(
        'SELECT state,user_id,name,pod_uid,runner_instance_id FROM pe_sandbox_instances WHERE session_id=$1 FOR UPDATE',
        [slot.session_id])
      const row = instance.rows[0]
      if (!row || row.state !== 'ready' || row.user_id !== userId || row.name !== this.name(userId)
        || row.pod_uid !== slot.pod_uid || row.runner_instance_id !== slot.runner_instance_id) {
        await client.query("UPDATE pe_mount_slots SET state='unknown',updated_at=now() WHERE user_id=$1", [userId])
        return { kind: 'blocked', code: 'mount_instance_mismatch', retryable: false }
      }
      if (slot.session_id === sessionId) {
        if (slot.workspace_id !== workspaceId) {
          await client.query("UPDATE pe_mount_slots SET state='unknown',updated_at=now() WHERE user_id=$1", [userId])
          return { kind: 'blocked', code: 'mount_workspace_mismatch', retryable: false }
        }
        return { kind: 'ready', slot }
      }
      const active = await client.query(
        `SELECT id FROM pe_cloud_executions WHERE session_id=$1
         AND state IN ('queued','starting','running','cancelling','uncertain') LIMIT 1`, [slot.session_id])
      if (active.rowCount) return { kind: 'blocked', code: 'mount_slot_busy', retryable: true }
      await client.query("UPDATE pe_mount_slots SET state='stopping',updated_at=now() WHERE user_id=$1", [userId])
      await client.query("UPDATE pe_sandbox_instances SET state='deleting',updated_at=now() WHERE session_id=$1", [slot.session_id])
      return { kind: 'stop', slot: { ...slot, state: 'stopping' } }
    })
  }

  private async assertReserved(slot: MountSlot, assertLease: () => Promise<void>): Promise<void> {
    await assertLease()
    const result = await this.pool.query<MountSlot>(
      'SELECT * FROM pe_mount_slots WHERE user_id=$1', [slot.user_id])
    const current = result.rows[0]
    if (!current || current.state !== 'reserved' || current.generation !== slot.generation
      || current.session_id !== slot.session_id || current.workspace_id !== slot.workspace_id) {
      throw new MountSlotBlocked('mount_reservation_changed', false)
    }
  }

  /** Creating is persisted before the first Kubernetes mutation; an interrupted creation stays blocked. */
  async ensureReady(sessionId: string, userId: string, assertLease: () => Promise<void>): Promise<SandboxReady> {
    const workspaceId = await this.workspaceId(sessionId, userId)
    for (let handoffs = 0; handoffs < 3; handoffs++) {
      await assertLease()
      const selected = await this.acquire(sessionId, userId, workspaceId)
      if (selected.kind === 'blocked') throw new MountSlotBlocked(selected.code, selected.retryable)
      if (selected.kind === 'stop') {
        await this.stopAndRelease(selected.slot, assertLease)
        continue
      }
      const slot = selected.slot
      if (selected.kind === 'ready') {
        if (!slot.pod_uid || !slot.runner_instance_id || !await this.matchesInstance(
          sessionId, userId, slot.pod_uid, slot.runner_instance_id)) {
          await this.quarantine(sessionId, userId)
          throw new MountSlotBlocked('mount_instance_changed', false)
        }
        return { name: this.name(userId), podUid: slot.pod_uid, runnerInstanceId: slot.runner_instance_id,
          token: this.token(this.name(userId), sessionId, slot.generation), restartCount: 0,
          generation: slot.generation, sessionId, userId }
      }
      const workspace = await (this.files as FileService & {
        workspaceForId(userId: string, workspaceId: string): Promise<{ id: string; path: string }>
      }).workspaceForId(userId, workspaceId)
      if (workspace.id !== workspaceId
        || resolve(workspace.path) !== join(resolve(this.config.localRoot), 'workspaces', workspaceId)) {
        throw new MountSlotBlocked('mount_workspace_root_changed', false)
      }
      await this.home(userId)
      return this.createReserved(slot, workspaceId, assertLease)
    }
    throw new MountSlotBlocked('mount_handoff_incomplete', false)
  }

  private async createReserved(slot: MountSlot, workspaceId: string,
    assertLease: () => Promise<void>): Promise<SandboxReady> {
    const sessionId = slot.session_id!, userId = slot.user_id, generation = slot.generation
    const name = this.name(userId), labels = this.labels(sessionId, userId, name, generation)
    const namespace = this.config.namespace, token = this.token(name, sessionId, generation)
    const check = () => this.assertReserved(slot, assertLease)
    await check()
    await this.ensure('secrets', name, {
      apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace, labels }, type: 'Opaque',
      stringData: { token },
    }, labels, token)
    await check()
    await this.ensure('services', name, {
      apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, labels },
      spec: { type: 'ClusterIP', selector: { 'app.kubernetes.io/instance': name,
        'powerevolve.dev/session': sessionId, 'powerevolve.dev/generation': generation },
        ports: [{ name: 'http', port: 8080, targetPort: 8080 }] },
    }, labels, token)
    await check()
    await this.ensure('sandboxes', name, {
      apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', metadata: { name, namespace, labels },
      spec: { podTemplate: { metadata: { labels }, spec: {
        automountServiceAccountToken: false, runtimeClassName: 'gvisor', restartPolicy: 'Always',
        terminationGracePeriodSeconds: 8,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'runner', image: this.config.image, imagePullPolicy: 'Never',
          ports: [{ name: 'http', containerPort: 8080 }],
          readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 2, timeoutSeconds: 2 },
          resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '768Mi' } },
          securityContext: { allowPrivilegeEscalation: false, capabilities: {
            drop: ['ALL'], add: ['SETUID', 'SETGID', 'DAC_OVERRIDE', 'KILL'],
          }, readOnlyRootFilesystem: true, runAsUser: 0, runAsGroup: 0 },
          volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }, { name: 'home', mountPath: '/home/agent' },
            { name: 'token', mountPath: '/run/power-evolve', readOnly: true }, { name: 'scratch', mountPath: '/tmp' }],
        }],
        volumes: [
          { name: 'workspace', hostPath: { path: join(this.config.nodeRoot, 'workspaces', workspaceId), type: 'Directory' } },
          { name: 'home', hostPath: { path: join(this.config.nodeRoot, 'homes', userId), type: 'Directory' } },
          { name: 'token', secret: { secretName: name, defaultMode: 0o400,
            items: [{ key: 'token', path: 'runner-token', mode: 0o400 }] } },
          { name: 'scratch', emptyDir: { sizeLimit: '256Mi' } },
        ],
      } } },
    }, labels, token)
    const deadline = Date.now() + this.config.readyTimeoutMs
    while (Date.now() < deadline) {
      await check()
      const [sandbox, pod] = await Promise.all([this.get('sandboxes', name), this.get('pods', name)])
      const conditions = sandbox?.status?.conditions
      const ready = Array.isArray(conditions) && conditions.some(value =>
        typeof value === 'object' && value !== null && 'type' in value && value.type === 'Ready'
        && 'status' in value && value.status === 'True')
      const current = pod as Pod | null
      if (ready && current?.metadata.uid && this.owned(current, labels)
        && current.metadata.ownerReferences?.some(ref => ref.uid === sandbox?.metadata.uid)
        && current.status?.phase === 'Running' && current.status.containerStatuses?.[0]?.ready) {
        try {
          const health = await this.runner<{ ready: boolean; instanceId: string }>(name, token, 'GET', '/health')
          if (health.ready && /^[a-f0-9-]{36}$/.test(health.instanceId)) {
            const finalizers = current.metadata.finalizers ?? []
            if (!finalizers.includes(STOP_FINALIZER)) {
              if (!current.metadata.resourceVersion || current.metadata.deletionTimestamp || finalizers.length > 16) {
                throw new MountSlotBlocked('mount_pod_finalizer_unavailable', false)
              }
              await check()
              await this.kube.call('PATCH', this.kube.resourcePath(namespace, 'pods', name), {
                metadata: { resourceVersion: current.metadata.resourceVersion, finalizers: [...finalizers, STOP_FINALIZER] },
              })
            }
            const retained = await this.get('pods', name)
            if (!retained || retained.metadata.uid !== current.metadata.uid || retained.metadata.deletionTimestamp
              || !retained.metadata.finalizers?.includes(STOP_FINALIZER) || !this.owned(retained, labels)) {
              throw new MountSlotBlocked('mount_pod_identity_changed', false)
            }
            await check()
            const recorded = await transaction(this.pool, async client => {
              await this.lockUser(client, userId)
              const currentSlot = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
              const value = currentSlot.rows[0]
              if (!value || value.state !== 'reserved' || value.generation !== generation
                || value.session_id !== sessionId || value.workspace_id !== workspaceId) return false
              const instance = await client.query(
                `UPDATE pe_sandbox_instances SET state='ready',pod_uid=$2,runner_instance_id=$3,
                 last_used_at=now(),updated_at=now() WHERE session_id=$1 AND user_id=$4 AND name=$5
                 AND state='creating' RETURNING session_id`,
                [sessionId, retained.metadata.uid, health.instanceId, userId, name])
              if (!instance.rowCount) return false
              await client.query(
                `UPDATE pe_mount_slots SET state='ready',pod_uid=$2,runner_instance_id=$3,updated_at=now()
                 WHERE user_id=$1 AND generation=$4 AND state='reserved'`,
                [userId, retained.metadata.uid, health.instanceId, generation])
              return true
            })
            if (!recorded) throw new MountSlotBlocked('mount_reservation_changed', false)
            return { name, podUid: retained.metadata.uid, runnerInstanceId: health.instanceId, token,
              restartCount: current.status.containerStatuses[0].restartCount ?? 0,
              generation, sessionId, userId }
          }
        } catch (error) {
          if (error instanceof MountSlotBlocked) throw error
          // The Service can lag Pod readiness; retain the reservation while polling.
        }
      }
      await delay(250)
    }
    throw new MountSlotBlocked('mount_creation_unconfirmed', false)
  }

  private owned(resource: Resource, labels: Record<string, string>): boolean {
    return Object.entries(labels).every(([key, value]) => resource.metadata.labels?.[key] === value)
  }

  /** Verify the slot first; a prior Session cannot recreate a Pod after handoff. */
  async assertCurrent(sandbox: SandboxReady): Promise<void> {
    const slot = await this.pool.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1', [sandbox.userId])
    const row = slot.rows[0]
    if (!row || row.state !== 'ready' || row.session_id !== sandbox.sessionId
      || row.generation !== sandbox.generation || row.pod_uid !== sandbox.podUid
      || row.runner_instance_id !== sandbox.runnerInstanceId) {
      throw new MountSlotBlocked('mount_slot_changed', false)
    }
    if (!await this.matchesInstance(sandbox.sessionId, sandbox.userId,
      sandbox.podUid, sandbox.runnerInstanceId)) {
      await this.quarantine(sandbox.sessionId, sandbox.userId)
      throw new MountSlotBlocked('mount_instance_changed', false)
    }
  }

  /** Check a previously admitted writer without creating any Kubernetes resource. */
  async matchesInstance(sessionId: string, userId: string, podUid: string, runnerInstanceId: string): Promise<boolean> {
    const selected = await this.pool.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1', [userId])
    const slot = selected.rows[0]
    if (!slot || slot.state !== 'ready' || slot.session_id !== sessionId || slot.pod_uid !== podUid
      || slot.runner_instance_id !== runnerInstanceId) return false
    const name = this.name(userId), labels = this.labels(sessionId, userId, name, slot.generation)
    const [sandbox, pod] = await Promise.all([this.get('sandboxes', name), this.get('pods', name)])
    if (!sandbox || sandbox.metadata.deletionTimestamp || !this.owned(sandbox, labels)
      || !pod || pod.metadata.deletionTimestamp || !this.owned(pod, labels)
      || pod.metadata.uid !== podUid || !pod.metadata.ownerReferences?.some(ref => ref.uid === sandbox.metadata.uid)
      || !pod.metadata.finalizers?.includes(STOP_FINALIZER)) return false
    const health = await this.runner<{ ready: boolean; instanceId: string }>(name,
      this.token(name, sessionId, slot.generation), 'GET', '/health')
    return health.ready && health.instanceId === runnerInstanceId
  }

  /** Quarantine an identity mismatch, preserving the Pod and denying new writers. */
  async quarantine(sessionId: string, userId: string): Promise<void> {
    await transaction(this.pool, async client => {
      await this.lockUser(client, userId)
      const selected = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
      if (selected.rows[0]?.session_id !== sessionId) return
      await client.query("UPDATE pe_mount_slots SET state='unknown',updated_at=now() WHERE user_id=$1", [userId])
      await client.query("UPDATE pe_sandbox_instances SET state='unknown',updated_at=now() WHERE session_id=$1", [sessionId])
    })
  }

  runner<T>(name: string, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return this.kube.call<T>(method, this.kube.proxyPath(this.config.namespace, name, path), body, 10_000, token)
  }

  private async stopping(slot: MountSlot): Promise<MountSlot> {
    const selected = await this.pool.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1', [slot.user_id])
    const current = selected.rows[0]
    if (!current || current.state !== 'stopping' || current.session_id !== slot.session_id
      || current.generation !== slot.generation || current.pod_uid !== slot.pod_uid) {
      throw new MountSlotBlocked('mount_stop_generation_changed', false)
    }
    return current
  }

  private hasProof(slot: MountSlot, instance: { stop_pod_uid: string | null; stop_evidence: unknown }, uid: string): boolean {
    const evidence = slot.stop_evidence, prior = instance.stop_evidence
    return slot.stop_pod_uid === uid && instance.stop_pod_uid === uid
      && typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence)
      && (evidence as Record<string, unknown>).status === 'KUBELET_STOPPED'
      && (evidence as Record<string, unknown>).podUid === uid
      && (evidence as Record<string, unknown>).generation === slot.generation
      && typeof prior === 'object' && prior !== null && !Array.isArray(prior)
      && (prior as Record<string, unknown>).status === 'KUBELET_STOPPED'
      && (prior as Record<string, unknown>).podUid === uid
  }

  private async proof(slot: MountSlot): Promise<boolean> {
    const current = await this.stopping(slot)
    const instance = await this.pool.query<{ stop_pod_uid: string | null; stop_evidence: unknown }>(
      'SELECT stop_pod_uid,stop_evidence FROM pe_sandbox_instances WHERE session_id=$1', [slot.session_id])
    return !!instance.rows[0] && this.hasProof(current, instance.rows[0], slot.pod_uid!)
  }

  private async persistProof(slot: MountSlot, sandboxUid: string | null): Promise<void> {
    const uid = slot.pod_uid!
    const evidence = { status: 'KUBELET_STOPPED', podUid: uid, sandboxUid,
      generation: slot.generation, observedAt: new Date().toISOString() }
    await transaction(this.pool, async client => {
      await this.lockUser(client, slot.user_id)
      const current = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [slot.user_id])
      const row = current.rows[0]
      if (!row || row.state !== 'stopping' || row.session_id !== slot.session_id
        || row.generation !== slot.generation || row.pod_uid !== uid) {
        throw new MountSlotBlocked('mount_stop_generation_changed', false)
      }
      const instance = await client.query(
        `UPDATE pe_sandbox_instances SET stop_pod_uid=$2,stop_evidence=$3,updated_at=now()
         WHERE session_id=$1 AND user_id=$4 AND pod_uid=$2 AND state='deleting' RETURNING session_id`,
        [slot.session_id, uid, JSON.stringify(evidence), slot.user_id])
      if (!instance.rowCount) throw new MountSlotBlocked('mount_stop_instance_changed', false)
      await client.query(
        `UPDATE pe_mount_slots SET stop_pod_uid=$2,stop_evidence=$3,updated_at=now()
         WHERE user_id=$1 AND generation=$4 AND state='stopping'`,
        [slot.user_id, uid, JSON.stringify(evidence), slot.generation])
    })
  }

  private async stopAndRelease(slot: MountSlot, assertLease: () => Promise<void>): Promise<void> {
    const userId = slot.user_id, sessionId = slot.session_id!, uid = slot.pod_uid!
    const name = this.name(userId), labels = this.labels(sessionId, userId, name, slot.generation)
    await assertLease()
    await this.stopping(slot)
    const [sandbox, firstPod] = await Promise.all([this.get('sandboxes', name), this.get('pods', name)])
    if (sandbox && (!sandbox.metadata.uid || !this.owned(sandbox, labels))) {
      throw new MountSlotBlocked('mount_stop_sandbox_identity_changed', false)
    }
    if (firstPod && (!this.owned(firstPod, labels) || firstPod.metadata.uid !== uid
      || !firstPod.metadata.finalizers?.includes(STOP_FINALIZER)
      || sandbox && !firstPod.metadata.ownerReferences?.some(ref => ref.uid === sandbox.metadata.uid))) {
      throw new MountSlotBlocked('mount_stop_pod_identity_changed', false)
    }
    if (!firstPod && !await this.proof(slot)) throw new MountSlotBlocked('mount_stop_proof_missing', false)
    if (sandbox) {
      try { await this.kube.call('DELETE', this.kube.resourcePath(this.config.namespace, 'sandboxes', name),
        { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: sandbox.metadata.uid } }) }
      catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
    }
    const deadline = Date.now() + this.config.readyTimeoutMs
    while (Date.now() < deadline) {
      await assertLease()
      await this.stopping(slot)
      const [pod, currentSandbox] = await Promise.all([this.get('pods', name), this.get('sandboxes', name)])
      if (pod) {
        if (!this.owned(pod, labels) || pod.metadata.uid !== uid
          || !pod.metadata.finalizers?.includes(STOP_FINALIZER)) {
          throw new MountSlotBlocked('mount_stop_pod_identity_changed', false)
        }
        if (kubernetesPodStopStatus(pod) === 'KUBELET_STOPPED') {
          if (!await this.proof(slot)) await this.persistProof(slot, currentSandbox?.metadata.uid ?? sandbox?.metadata.uid ?? null)
          if (!pod.metadata.resourceVersion) throw new MountSlotBlocked('mount_stop_pod_version_missing', false)
          try {
            await this.kube.call('PATCH', this.kube.resourcePath(this.config.namespace, 'pods', name), {
              metadata: { resourceVersion: pod.metadata.resourceVersion,
                finalizers: pod.metadata.finalizers.filter(value => value !== STOP_FINALIZER) },
            })
          } catch (error) {
            if (!(error instanceof KubernetesError && [404, 409].includes(error.status))) throw error
          }
        }
      } else if (!await this.proof(slot)) throw new MountSlotBlocked('mount_stop_proof_missing', false)
      if (!pod && !currentSandbox) break
      await delay(250)
    }
    if (await this.get('pods', name) || await this.get('sandboxes', name)
      || !await this.proof(slot)) throw new MountSlotBlocked('mount_stop_unconfirmed', false)
    for (const resource of ['services', 'secrets'] as const) {
      const existing = await this.get(resource, name)
      if (existing) {
        if (!existing.metadata.uid || !this.owned(existing, labels)) {
          throw new MountSlotBlocked(`mount_stop_${resource}_identity_changed`, false)
        }
        try { await this.kube.call('DELETE', this.kube.resourcePath(this.config.namespace, resource, name),
          { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: existing.metadata.uid } }) }
        catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
      }
      while (Date.now() < deadline && await this.get(resource, name)) await delay(250)
      if (await this.get(resource, name)) throw new MountSlotBlocked(`mount_stop_${resource}_unconfirmed`, false)
    }
    await assertLease()
    await transaction(this.pool, async client => {
      await this.lockUser(client, userId)
      const selected = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
      const current = selected.rows[0]
      const instance = await client.query<{ stop_pod_uid: string | null; stop_evidence: unknown }>(
        'SELECT stop_pod_uid,stop_evidence FROM pe_sandbox_instances WHERE session_id=$1 FOR UPDATE', [sessionId])
      if (!current || current.state !== 'stopping' || current.generation !== slot.generation
        || current.session_id !== sessionId || current.pod_uid !== uid
        || !instance.rows[0] || !this.hasProof(current, instance.rows[0], uid)) {
        throw new MountSlotBlocked('mount_stop_proof_missing', false)
      }
      await client.query(
        `UPDATE pe_sandbox_instances SET state='deleted',pod_uid=NULL,runner_instance_id=NULL,updated_at=now()
         WHERE session_id=$1 AND user_id=$2 AND state='deleting'`, [sessionId, userId])
      await client.query(
        `UPDATE pe_mount_slots SET state='free',session_id=NULL,workspace_id=NULL,pod_uid=NULL,
         runner_instance_id=NULL,updated_at=now() WHERE user_id=$1 AND generation=$2 AND state='stopping'`,
        [userId, slot.generation])
    })
  }

  /** Recycle one idle writer; incomplete stop evidence leaves its slot blocked for reconciliation. */
  async recycleIdle(idleMs: number): Promise<void> {
    const candidate = await this.pool.query<{ user_id: string }>(
      `SELECT m.user_id FROM pe_mount_slots m JOIN pe_sandbox_instances s ON s.session_id=m.session_id
       WHERE m.state IN ('ready','stopping')
       AND (m.state='stopping' OR s.last_used_at<now()-$1::double precision*interval '1 millisecond')
       ORDER BY s.last_used_at LIMIT 1`, [idleMs])
    const userId = candidate.rows[0]?.user_id
    if (!userId) return
    const selected = await transaction(this.pool, async client => {
      await this.lockUser(client, userId)
      const result = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
      const slot = result.rows[0]
      if (!slot || !slot.session_id || !slot.pod_uid || !slot.runner_instance_id
        || !['ready', 'stopping'].includes(slot.state)) return null
      const active = await client.query(
        `SELECT id FROM pe_cloud_executions WHERE session_id=$1
         AND state IN ('queued','starting','running','cancelling','uncertain') LIMIT 1`, [slot.session_id])
      if (active.rowCount) return null
      if (slot.state === 'ready') {
        const old = await client.query(
          `UPDATE pe_sandbox_instances SET state='deleting',updated_at=now()
           WHERE session_id=$1 AND user_id=$2 AND state='ready' AND pod_uid=$3
           AND last_used_at<now()-$4::double precision*interval '1 millisecond' RETURNING session_id`,
          [slot.session_id, userId, slot.pod_uid, idleMs])
        if (!old.rowCount) {
          return null
        }
        await client.query("UPDATE pe_mount_slots SET state='stopping',updated_at=now() WHERE user_id=$1", [userId])
      }
      return { ...slot, state: 'stopping' as const }
    })
    if (selected) await this.stopAndRelease(selected, async () => {})
  }
}
