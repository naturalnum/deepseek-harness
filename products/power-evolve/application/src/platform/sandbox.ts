/** One writable Kubernetes mount slot per user, with a distinct Pod and runner for each Session. */
import { createHmac } from 'node:crypto'
import { chown, lstat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolClient } from 'pg'
import type { FileService } from './files.ts'
import { transaction } from './database.ts'
import { userId as executionUserId } from '../contracts.ts'
import { lockAccountAuthorities, requireActiveAccount } from './account-authority.ts'
import { KubernetesClient, KubernetesError, RUNNER_RESPONSE_MAX_BYTES } from './kubernetes.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'
import { storageBinding, workspaceRecoveryClaim, type StorageBinding, type WorkspaceRecoveryClaim,
  type RecoveryStopProof, type AssertWorkspaceRecoveryLease } from './workspace-binding-types.ts'

const STOP_FINALIZER = 'powerevolve.dev/retain-stop-observation'
type SlotState = 'free' | 'reserved' | 'ready' | 'stopping' | 'unknown'
interface MountSlot {
  user_id: string; session_id: string | null; workspace_id: string | null; generation: string
  state: SlotState; pod_uid: string | null; runner_instance_id: string | null
  stop_pod_uid: string | null; stop_evidence: unknown
  binding_snapshot: unknown
}
interface BindingWorkspace { binding_generation: string; binding_state: string; recovery_request_id: string | null }
interface StopInstance { stop_pod_uid: string | null; stop_evidence: unknown; binding_snapshot: unknown }
type SandboxFiles = Pick<FileService, 'workspaceForId'> & {
  bindingForId(userId: string, workspaceId: string, client?: PoolClient): Promise<StorageBinding>
}
interface Metadata { name: string; uid?: string; resourceVersion?: string; labels?: Record<string, string>; deletionTimestamp?: string;
  finalizers?: string[]; ownerReferences?: Array<{ uid?: string }> }
interface Resource { metadata: Metadata; spec?: Record<string, unknown>; status?: Record<string, unknown>; data?: Record<string, string> }
interface Pod extends Resource { status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean; restartCount?: number }> } }
/** Ready writer identity and platform-only token, valid while its mount slot remains current. */
export interface SandboxReady { name: string; podUid: string; runnerInstanceId: string; token: string; restartCount: number;
  generation: string; sessionId: string; userId: string; binding: StorageBinding }
/** Deployment values resolved by the Platform Profile before creating Sandbox resources. */
export interface SandboxConfig {
  readonly namespace: string
  readonly image: string
  readonly localRoot: string
  readonly nodeRoot: string
  readonly volumeClaimName?: string
  readonly readyTimeoutMs: number
  /** Independent limits for each scan before and after a command. */
  readonly fileScan: {
    readonly maxEntries: number
    readonly maxHashBytes: number
    readonly timeoutMs: number
    readonly maxSnapshotBytes: number
    readonly maxFiles: number
  }
}

/** Retryable means another live Session currently owns the slot; all other cases require reconciliation. */
export class MountSlotBlocked extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code) }
}

type Acquired = { kind: 'reserved' | 'ready'; slot: MountSlot; binding: StorageBinding }
  | { kind: 'stop'; slot: MountSlot }
  | { kind: 'blocked'; code: string; retryable: boolean }

/** The platform owns Kubernetes credentials; neither Host nor browser receives a Pod or mount path. */
export class SandboxManager {
  constructor(private readonly kube: KubernetesClient, private readonly files: SandboxFiles, private readonly pool: Pool,
    private readonly key: string, private readonly config: SandboxConfig) {
    if (Boolean(config.volumeClaimName) === Boolean(config.nodeRoot)) {
      throw new Error('Configure exactly one Sandbox volume source')
    }
    if (config.volumeClaimName && !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(config.volumeClaimName)) {
      throw new Error('Invalid Sandbox PVC claim name')
    }
  }

  /**
   * The physical resource name is stable for the user's shared writable Home.
   * @param userId - Owner of the writable Home.
   * @returns Kubernetes resource name shared by that user's sequential writers.
   */
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
    await lockAccountAuthorities(client, [executionUserId.parse(userId)], 'update')
  }
  private sameBinding(value: unknown, expected: StorageBinding): boolean {
    const parsed = storageBinding.safeParse(value)
    return parsed.success && parsed.data.workspaceId === expected.workspaceId && parsed.data.spaceId === expected.spaceId
      && parsed.data.rootKey === expected.rootKey && parsed.data.rootRelativePath === expected.rootRelativePath
      && parsed.data.generation === expected.generation
  }
  private snapshot(slot: MountSlot): StorageBinding {
    const parsed = storageBinding.safeParse(slot.binding_snapshot)
    if (!parsed.success || slot.workspace_id !== parsed.data.workspaceId) {
      throw new MountSlotBlocked('mount_binding_snapshot_invalid', false)
    }
    return parsed.data
  }
  private async lockWorkspace(client: PoolClient, userId: string, workspaceId: string): Promise<BindingWorkspace> {
    const selected = await client.query<BindingWorkspace>(
      'SELECT binding_generation,binding_state,recovery_request_id FROM pe_workspaces WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [workspaceId, userId])
    if (!selected.rows[0]) throw new MountSlotBlocked('mount_session_workspace_missing', false)
    return selected.rows[0]
  }
  private async assertAdmission(client: PoolClient, userId: string): Promise<void> {
    const fenced = await client.query(
      "SELECT id FROM pe_workspaces WHERE user_id=$1 AND binding_state IN ('recovering','blocked') LIMIT 1", [userId])
    if (fenced.rowCount) throw new MountSlotBlocked('mount_workspace_recovering', false)
  }
  private async readyBinding(client: PoolClient, userId: string, workspaceId: string): Promise<StorageBinding> {
    const workspace = await this.lockWorkspace(client, userId, workspaceId)
    await this.assertAdmission(client, userId)
    if (workspace.binding_state !== 'ready') throw new MountSlotBlocked('mount_binding_not_ready', false)
    const binding = storageBinding.parse(await this.files.bindingForId(userId, workspaceId, client))
    if (binding.workspaceId !== workspaceId || binding.generation !== Number(workspace.binding_generation)) {
      throw new MountSlotBlocked('mount_binding_generation_changed', false)
    }
    return binding
  }
  private async storedBinding(userId: string, workspaceId: string): Promise<StorageBinding | null> {
    const selected = await this.pool.query<{ workspace_id: string; space_id: string; root_key: string;
      root_relative_path: string; binding_generation: string }>(
      `SELECT b.workspace_id,b.space_id,s.root_key,b.root_relative_path,w.binding_generation
       FROM pe_workspaces w JOIN pe_workspace_bindings b ON b.workspace_id=w.id AND b.user_id=w.user_id
       JOIN pe_storage_spaces s ON s.id=b.space_id AND s.user_id=b.user_id WHERE w.id=$1 AND w.user_id=$2`,
      [workspaceId, userId])
    const row = selected.rows[0]
    if (!row) return null
    const parsed = storageBinding.safeParse({ workspaceId: row.workspace_id, spaceId: row.space_id, rootKey: row.root_key,
      rootRelativePath: row.root_relative_path, generation: Number(row.binding_generation) })
    return parsed.success ? parsed.data : null
  }
  private async get(resource: 'sandboxes' | 'pods' | 'services' | 'secrets', name: string): Promise<Resource | null> {
    try { return await this.kube.call<Resource>('GET', this.kube.resourcePath(this.config.namespace, resource, name)) }
    catch (error) { if (error instanceof KubernetesError && error.status === 404) return null; throw error }
  }
  private async ensure(resource: 'sandboxes' | 'services' | 'secrets', name: string,
    body: Record<string, unknown>, labels: Record<string, string>, token: string,
    assertCurrent: () => Promise<void>): Promise<void> {
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
    await assertCurrent()
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

  private async skillPackages(userId: string): Promise<void> {
    const root = resolve(this.config.localRoot)
    const parent = join(root, 'skill-packages'), directory = join(parent, userId)
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new MountSlotBlocked('mount_skill_package_root_unavailable', false)
    }
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentStat = await lstat(parent)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new MountSlotBlocked('mount_skill_package_root_unavailable', false)
    }
    await mkdir(directory, { mode: 0o755 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o005) !== 0o005) {
      throw new MountSlotBlocked('mount_skill_package_root_unavailable', false)
    }
  }

  private hasDataMounts(spec: unknown, userId: string, binding: StorageBinding): boolean {
    const record = (value: unknown): value is Record<string, unknown> => value !== null
      && typeof value === 'object' && !Array.isArray(value)
    if (!record(spec) || !Array.isArray(spec.volumes) || !Array.isArray(spec.containers)
      || spec.volumes.length !== 5 || spec.containers.length !== 1
      || spec.automountServiceAccountToken !== false || spec.runtimeClassName !== 'gvisor'
      || spec.hostPID === true || spec.shareProcessNamespace === true
      || Array.isArray(spec.initContainers) && spec.initContainers.length > 0
      || Array.isArray(spec.ephemeralContainers) && spec.ephemeralContainers.length > 0) return false
    const volumes: unknown[] = spec.volumes, workers: unknown[] = spec.containers
    const runner = workers[0]
    if (!record(runner) || runner.name !== 'runner' || !Array.isArray(runner.volumeMounts)
      || runner.volumeMounts.length !== 5 || runner.volumeDevices !== undefined) return false
    const mounts: unknown[] = runner.volumeMounts
    const named = (values: unknown[], name: string): Record<string, unknown> | null => {
      const found = values.filter(record).filter(value => value.name === name)
      return found.length === 1 ? found[0]! : null
    }
    const names = ['workspace', 'home', 'skill-packages', 'token', 'scratch']
    if (!names.every(name => named(volumes, name) && named(mounts, name))) return false
    const token = named(volumes, 'token'), scratch = named(volumes, 'scratch')
    const tokenMount = named(mounts, 'token'), scratchMount = named(mounts, 'scratch')
    if (!token || !scratch || !tokenMount || !scratchMount || !record(token.secret)
      || !Object.keys(token).every(key => ['name', 'secret'].includes(key))
      || !Object.keys(scratch).every(key => ['name', 'emptyDir'].includes(key))
      || token.secret.secretName !== this.name(userId) || token.secret.defaultMode !== 0o400
      || !Array.isArray(token.secret.items) || token.secret.items.length !== 1
      || !record(token.secret.items[0]) || token.secret.items[0].key !== 'token'
      || token.secret.items[0].path !== 'runner-token' || token.secret.items[0].mode !== 0o400
      || !record(scratch.emptyDir) || tokenMount.mountPath !== '/run/power-evolve'
      || tokenMount.readOnly !== true || scratchMount.mountPath !== '/tmp' || scratchMount.readOnly === true
      || 'subPath' in tokenMount || 'subPathExpr' in tokenMount || 'subPath' in scratchMount || 'subPathExpr' in scratchMount) return false
    const suffix = binding.rootRelativePath ? `/${binding.rootRelativePath}` : ''
    const expected = [
      { name: 'workspace', mountPath: '/workspace', source: `workspaces/${binding.rootKey}`,
        relative: binding.rootRelativePath, readOnly: false },
      { name: 'home', mountPath: '/home/agent', source: `homes/${userId}`, relative: '', readOnly: false },
      { name: 'skill-packages', mountPath: '/opt/power-evolve/skills', source: `skill-packages/${userId}`,
        relative: '', readOnly: true },
    ]
    if (this.config.volumeClaimName && spec.serviceAccountName !== 'power-evolve-runner') return false
    return expected.every(({ name, mountPath, source, relative, readOnly }) => {
      const volume = named(volumes, name), mount = named(mounts, name)
      if (!volume || !mount || mount.mountPath !== mountPath || (mount.readOnly === true) !== readOnly
        || 'subPathExpr' in mount || mount.mountPropagation !== undefined && mount.mountPropagation !== 'None') return false
      if (this.config.volumeClaimName) {
        return Object.keys(volume).every(key => ['name', 'persistentVolumeClaim'].includes(key))
          && record(volume.persistentVolumeClaim) && volume.persistentVolumeClaim.claimName === this.config.volumeClaimName
          && volume.persistentVolumeClaim.readOnly !== true && mount.subPath === source + (name === 'workspace' ? suffix : '')
      }
      return Object.keys(volume).every(key => ['name', 'hostPath'].includes(key))
        && record(volume.hostPath) && volume.hostPath.path === join(this.config.nodeRoot, source)
        && volume.hostPath.type === 'Directory'
        && (relative ? mount.subPath === relative : !('subPath' in mount))
    })
  }

  private hasSkillPackageIdentity(sandbox: Resource, pod: Pod, userId: string, binding: StorageBinding): boolean {
    const template = sandbox.spec?.podTemplate
    return typeof template === 'object' && template !== null && !Array.isArray(template)
      && this.hasDataMounts((template as Record<string, unknown>).spec, userId, binding)
      && this.hasDataMounts(pod.spec, userId, binding)
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
      const binding = await this.readyBinding(client, userId, workspaceId)
      await client.query("INSERT INTO pe_mount_slots(user_id,state) VALUES($1,'free') ON CONFLICT(user_id) DO NOTHING", [userId])
      const selected = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
      const slot = selected.rows[0]!
      if (slot.state === 'free') {
        await requireActiveAccount(client, executionUserId.parse(userId), 'update')
        const prior = await client.query<{ state: string }>(
          'SELECT state FROM pe_sandbox_instances WHERE session_id=$1 FOR UPDATE', [sessionId])
        if (prior.rows[0] && prior.rows[0].state !== 'deleted') {
          return { kind: 'blocked', code: 'mount_instance_unreconciled', retryable: false }
        }
        await this.home(userId)
        await this.skillPackages(userId)
        const updated = await client.query<MountSlot>(
          `UPDATE pe_mount_slots SET state='reserved',session_id=$2,workspace_id=$3,
           generation=generation+1,pod_uid=NULL,runner_instance_id=NULL,binding_snapshot=$4::jsonb,
           stop_pod_uid=NULL,stop_evidence=NULL,updated_at=now()
           WHERE user_id=$1 AND state='free' RETURNING *`, [userId, sessionId, workspaceId, JSON.stringify(binding)])
        const created = await client.query(
          `INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,binding_snapshot)
           VALUES($1,$2,$3,'creating',$4::jsonb) ON CONFLICT(session_id) DO UPDATE
           SET state='creating',name=$3,pod_uid=NULL,runner_instance_id=NULL,
             stop_pod_uid=NULL,stop_evidence=NULL,binding_snapshot=$4::jsonb,updated_at=now()
           WHERE pe_sandbox_instances.state='deleted' RETURNING session_id`,
          [sessionId, userId, this.name(userId), JSON.stringify(binding)])
        if (!created.rowCount) throw new MountSlotBlocked('mount_instance_unreconciled', false)
        return { kind: 'reserved', slot: updated.rows[0]!, binding }
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
        runner_instance_id: string | null; binding_snapshot: unknown }>(
        'SELECT state,user_id,name,pod_uid,runner_instance_id,binding_snapshot FROM pe_sandbox_instances WHERE session_id=$1 FOR UPDATE',
        [slot.session_id])
      const row = instance.rows[0]
      if (!row || row.state !== 'ready' || row.user_id !== userId || row.name !== this.name(userId)
        || row.pod_uid !== slot.pod_uid || row.runner_instance_id !== slot.runner_instance_id
        || !this.sameBinding(row.binding_snapshot, this.snapshot(slot))) {
        await client.query("UPDATE pe_mount_slots SET state='unknown',updated_at=now() WHERE user_id=$1", [userId])
        return { kind: 'blocked', code: 'mount_instance_mismatch', retryable: false }
      }
      if (slot.session_id === sessionId) {
        if (slot.workspace_id !== workspaceId || !this.sameBinding(slot.binding_snapshot, binding)) {
          await client.query("UPDATE pe_mount_slots SET state='unknown',updated_at=now() WHERE user_id=$1", [userId])
          return { kind: 'blocked', code: 'mount_workspace_mismatch', retryable: false }
        }
        return { kind: 'ready', slot, binding }
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
    await transaction(this.pool, async client => {
      await this.lockUser(client, slot.user_id)
      const binding = await this.readyBinding(client, slot.user_id, slot.workspace_id!)
      const result = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [slot.user_id])
      const current = result.rows[0]
      if (!current || current.state !== 'reserved' || current.generation !== slot.generation
        || current.session_id !== slot.session_id || current.workspace_id !== slot.workspace_id
        || !this.sameBinding(slot.binding_snapshot, binding) || !this.sameBinding(current.binding_snapshot, binding)) {
        throw new MountSlotBlocked('mount_reservation_changed', false)
      }
    })
  }

  /**
   * Creating is persisted before the first Kubernetes mutation; an interrupted creation stays blocked.
   * @param sessionId - Session requesting its owned workspace.
   * @param userId - Owner whose shared Home limits the active writer.
   * @param assertLease - Rejects when the calling execution worker loses its lease.
   * @returns Current ready writer; rejects if reservation, identity, readiness, or stop evidence is unavailable.
   */
  async ensureReady(sessionId: string, userId: string, assertLease: () => Promise<void>): Promise<SandboxReady> {
    const workspaceId = await this.workspaceId(sessionId, userId)
    for (let handoffs = 0; handoffs < 3; handoffs++) {
      await assertLease()
      await this.files.workspaceForId(userId, workspaceId)
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
          generation: slot.generation, sessionId, userId, binding: selected.binding }
      }
      return this.createReserved(slot, selected.binding, assertLease)
    }
    throw new MountSlotBlocked('mount_handoff_incomplete', false)
  }

  private async createReserved(slot: MountSlot, binding: StorageBinding,
    assertLease: () => Promise<void>): Promise<SandboxReady> {
    const workspaceId = binding.workspaceId
    const sessionId = slot.session_id!, userId = slot.user_id, generation = slot.generation
    const name = this.name(userId), labels = this.labels(sessionId, userId, name, generation)
    const namespace = this.config.namespace, token = this.token(name, sessionId, generation)
    const check = () => this.assertReserved(slot, assertLease)
    await check()
    await this.ensure('secrets', name, {
      apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace, labels }, type: 'Opaque',
      stringData: { token },
    }, labels, token, check)
    await check()
    await this.ensure('services', name, {
      apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, labels },
      spec: { type: 'ClusterIP', selector: { 'app.kubernetes.io/instance': name,
        'powerevolve.dev/session': sessionId, 'powerevolve.dev/generation': generation },
        ports: [{ name: 'http', port: 8080, targetPort: 8080 }] },
    }, labels, token, check)
    await check()
    const claim = this.config.volumeClaimName
    const volumeMounts = [
      { name: 'workspace', mountPath: '/workspace', ...(claim
        ? { subPath: `workspaces/${binding.rootKey}${binding.rootRelativePath ? `/${binding.rootRelativePath}` : ''}` }
        : binding.rootRelativePath ? { subPath: binding.rootRelativePath } : {}) },
      { name: 'home', mountPath: '/home/agent', ...(claim ? { subPath: `homes/${userId}` } : {}) },
      { name: 'skill-packages', mountPath: '/opt/power-evolve/skills', readOnly: true,
        ...(claim ? { subPath: `skill-packages/${userId}` } : {}) },
      { name: 'token', mountPath: '/run/power-evolve', readOnly: true },
      { name: 'scratch', mountPath: '/tmp' },
    ]
    const dataVolumes = claim ? [
      { name: 'workspace', persistentVolumeClaim: { claimName: claim } },
      { name: 'home', persistentVolumeClaim: { claimName: claim } },
      { name: 'skill-packages', persistentVolumeClaim: { claimName: claim } },
    ] : [
      { name: 'workspace', hostPath: { path: join(this.config.nodeRoot, 'workspaces', binding.rootKey), type: 'Directory' } },
      { name: 'home', hostPath: { path: join(this.config.nodeRoot, 'homes', userId), type: 'Directory' } },
      { name: 'skill-packages', hostPath: { path: join(this.config.nodeRoot, 'skill-packages', userId),
        type: 'Directory' } },
    ]
    await this.ensure('sandboxes', name, {
      apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', metadata: { name, namespace, labels },
      spec: { podTemplate: { metadata: { labels }, spec: {
        automountServiceAccountToken: false, runtimeClassName: 'gvisor', restartPolicy: 'Always',
        ...(claim ? { serviceAccountName: 'power-evolve-runner' } : {}),
        terminationGracePeriodSeconds: 8,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'runner', image: this.config.image, imagePullPolicy: claim ? 'IfNotPresent' : 'Never',
          env: [
            { name: 'PE_RUNNER_SCAN_MAX_ENTRIES', value: String(this.config.fileScan.maxEntries) },
            { name: 'PE_RUNNER_SCAN_MAX_HASH_BYTES', value: String(this.config.fileScan.maxHashBytes) },
            { name: 'PE_RUNNER_SCAN_TIMEOUT_MS', value: String(this.config.fileScan.timeoutMs) },
            { name: 'PE_RUNNER_SCAN_MAX_SNAPSHOT_BYTES', value: String(this.config.fileScan.maxSnapshotBytes) },
            { name: 'PE_RUNNER_SCAN_MAX_FILES', value: String(this.config.fileScan.maxFiles) },
          ],
          ports: [{ name: 'http', containerPort: 8080 }],
          readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 2, timeoutSeconds: 2 },
          resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '768Mi' } },
          securityContext: { allowPrivilegeEscalation: false, capabilities: {
            drop: ['ALL'], add: ['SETUID', 'SETGID', 'DAC_OVERRIDE', 'KILL'],
          }, readOnlyRootFilesystem: true, runAsUser: 0, runAsGroup: 0 },
          volumeMounts,
        }],
        volumes: [
          ...dataVolumes,
          { name: 'token', secret: { secretName: name, defaultMode: 0o400,
            items: [{ key: 'token', path: 'runner-token', mode: 0o400 }] } },
          { name: 'scratch', emptyDir: { sizeLimit: '256Mi' } },
        ],
      } } },
    }, labels, token, check)
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
        if (!sandbox || !this.hasSkillPackageIdentity(sandbox, current, userId, binding)) {
          throw new MountSlotBlocked('mount_skill_package_identity_changed', false)
        }
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
              const currentBinding = await this.readyBinding(client, userId, workspaceId)
              const currentSlot = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
              const value = currentSlot.rows[0]
              if (!value || value.state !== 'reserved' || value.generation !== generation
                || value.session_id !== sessionId || value.workspace_id !== workspaceId
                || !this.sameBinding(value.binding_snapshot, binding) || !this.sameBinding(currentBinding, binding)) return false
              const instance = await client.query(
                `UPDATE pe_sandbox_instances SET state='ready',pod_uid=$2,runner_instance_id=$3,
                 last_used_at=now(),updated_at=now() WHERE session_id=$1 AND user_id=$4 AND name=$5
                 AND state='creating' AND binding_snapshot=$6::jsonb RETURNING session_id`,
                [sessionId, retained.metadata.uid, health.instanceId, userId, name, JSON.stringify(binding)])
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
              generation, sessionId, userId, binding }
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

  /**
   * Verify the slot first; a prior Session cannot recreate a Pod after handoff.
   * @param sandbox - Previously issued writer identity; an instance mismatch quarantines the slot and rejects.
   */
  async assertCurrent(sandbox: SandboxReady): Promise<void> {
    const slot = await this.pool.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1', [sandbox.userId])
    const row = slot.rows[0]
    if (!row || row.state !== 'ready' || row.session_id !== sandbox.sessionId
      || row.generation !== sandbox.generation || row.pod_uid !== sandbox.podUid
      || row.runner_instance_id !== sandbox.runnerInstanceId || !this.sameBinding(row.binding_snapshot, sandbox.binding)) {
      throw new MountSlotBlocked('mount_slot_changed', false)
    }
    if (!await this.matchesInstance(sandbox.sessionId, sandbox.userId,
      sandbox.podUid, sandbox.runnerInstanceId)) {
      await this.quarantine(sandbox.sessionId, sandbox.userId)
      throw new MountSlotBlocked('mount_instance_changed', false)
    }
  }

  /**
   * Observe an already captured writer without provisioning or bypassing its exact old identity.
   * @param sessionId - Session retained by the execution record.
   * @param userId - Owner of the captured mount slot.
   * @param podUid - Previously dispatched Pod identity.
   * @param runnerInstanceId - Previously dispatched Runner identity.
   * @returns Matching writer including its frozen binding; recovery fences do not prevent observation.
   */
  async observeReady(sessionId: string, userId: string, podUid: string, runnerInstanceId: string): Promise<SandboxReady> {
    const selected = await this.pool.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1', [userId])
    const slot = selected.rows[0]
    if (!slot || slot.state !== 'ready' || slot.session_id !== sessionId
      || slot.pod_uid !== podUid || slot.runner_instance_id !== runnerInstanceId) {
      throw new MountSlotBlocked('mount_slot_changed', false)
    }
    const binding = this.snapshot(slot)
    const sandbox = { name: this.name(userId), podUid, runnerInstanceId,
      token: this.token(this.name(userId), sessionId, slot.generation), restartCount: 0,
      generation: slot.generation, sessionId, userId, binding }
    await this.assertCurrent(sandbox)
    return sandbox
  }

  /**
   * Fence a new command with account authority and the complete current storage binding.
   * @param sandbox - Ready writer selected before dispatch; observation uses assertCurrent instead.
   */
  async assertDispatchAllowed(sandbox: SandboxReady): Promise<void> {
    await this.assertCurrent(sandbox)
    await transaction(this.pool, async client => {
      await requireActiveAccount(client, executionUserId.parse(sandbox.userId), 'update')
      const binding = await this.readyBinding(client, sandbox.userId, sandbox.binding.workspaceId)
      const selected = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [sandbox.userId])
      const slot = selected.rows[0]
      if (!slot || slot.state !== 'ready' || slot.session_id !== sandbox.sessionId
        || slot.generation !== sandbox.generation || slot.pod_uid !== sandbox.podUid
        || slot.runner_instance_id !== sandbox.runnerInstanceId || !this.sameBinding(binding, sandbox.binding)
        || !this.sameBinding(slot.binding_snapshot, sandbox.binding)) throw new MountSlotBlocked('mount_slot_changed', false)
    })
  }

  /**
   * Check a previously admitted writer without creating any Kubernetes resource.
   * @param sessionId - Session recorded as the writer.
   * @param userId - Owner of its mount slot.
   * @param podUid - Expected Kubernetes Pod identity.
   * @param runnerInstanceId - Expected live Runner process identity.
   * @returns Whether the slot, resources, mounts and live Runner match; provider errors reject.
   */
  async matchesInstance(sessionId: string, userId: string, podUid: string, runnerInstanceId: string): Promise<boolean> {
    const selected = await this.pool.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1', [userId])
    const slot = selected.rows[0]
    if (!slot || slot.state !== 'ready' || slot.session_id !== sessionId || slot.pod_uid !== podUid
      || slot.runner_instance_id !== runnerInstanceId) return false
    const parsed = storageBinding.safeParse(slot.binding_snapshot)
    if (!parsed.success || parsed.data.workspaceId !== slot.workspace_id) return false
    const binding = await this.storedBinding(userId, slot.workspace_id!)
    if (!binding || !this.sameBinding(binding, parsed.data)) return false
    const instance = await this.pool.query<{ state: string; pod_uid: string | null; runner_instance_id: string | null;
      binding_snapshot: unknown }>(
      'SELECT state,pod_uid,runner_instance_id,binding_snapshot FROM pe_sandbox_instances WHERE session_id=$1 AND user_id=$2',
      [sessionId, userId])
    const current = instance.rows[0]
    if (!current || current.state !== 'ready' || current.pod_uid !== podUid || current.runner_instance_id !== runnerInstanceId
      || !this.sameBinding(current.binding_snapshot, binding)) return false
    const name = this.name(userId), labels = this.labels(sessionId, userId, name, slot.generation)
    const [sandbox, pod] = await Promise.all([this.get('sandboxes', name), this.get('pods', name)])
    if (!sandbox || sandbox.metadata.deletionTimestamp || !this.owned(sandbox, labels)
      || !pod || pod.metadata.deletionTimestamp || !this.owned(pod, labels)
      || pod.metadata.uid !== podUid || !pod.metadata.ownerReferences?.some(ref => ref.uid === sandbox.metadata.uid)
      || !pod.metadata.finalizers?.includes(STOP_FINALIZER)
      || !this.hasSkillPackageIdentity(sandbox, pod, userId, binding)) return false
    const health = await this.runner<{ ready: boolean; instanceId: string }>(name,
      this.token(name, sessionId, slot.generation), 'GET', '/health')
    return health.ready && health.instanceId === runnerInstanceId
  }

  /**
   * Quarantine an identity mismatch, preserving the Pod and denying new writers.
   * @param sessionId - Session to quarantine; a slot handed to another Session is unchanged.
   * @param userId - Owner of the mount slot to lock.
   */
  async quarantine(sessionId: string, userId: string): Promise<void> {
    await transaction(this.pool, async client => {
      await this.lockUser(client, userId)
      const selected = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
      if (selected.rows[0]?.session_id !== sessionId) return
      await client.query("UPDATE pe_mount_slots SET state='unknown',updated_at=now() WHERE user_id=$1", [userId])
      await client.query("UPDATE pe_sandbox_instances SET state='unknown',updated_at=now() WHERE session_id=$1", [sessionId])
    })
  }

  /**
   * Call a Runner through the namespace-scoped Kubernetes service proxy with bounded response bytes.
   * @param name - Authorized service resource name.
   * @param token - Platform-only Runner authentication token.
   * @param method - Observation or command operation.
   * @param path - Runner endpoint path.
   * @param body - Optional JSON request body.
   * @returns Decoded Runner response; transport, timeout and response-size errors reject without replay.
   */
  runner<T>(name: string, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return this.kube.call<T>(method, this.kube.proxyPath(this.config.namespace, name, path), body,
      10_000, token, RUNNER_RESPONSE_MAX_BYTES)
  }

  private async recoveryFence(claim: WorkspaceRecoveryClaim, client: PoolClient): Promise<void> {
    const workspace = await this.lockWorkspace(client, claim.userId, claim.workspaceId)
    if (workspace.binding_state !== 'recovering' || workspace.recovery_request_id !== claim.requestId
      || Number(workspace.binding_generation) !== claim.expectedGeneration) {
      throw new MountSlotBlocked('mount_recovery_fence_changed', false)
    }
  }

  /**
   * Stop only the writer captured by a durable, generation-fenced recovery request.
   * @param claim - Trusted worker claim; no browser supplies its stop identity.
   * @param assertLease - Validates the recovery owner, epoch, expiry and request before progress.
   * @returns Exact stopped-Pod evidence, or a verified unchanged free slot; absence is not stop proof.
   */
  async stopForRecovery(claim: WorkspaceRecoveryClaim, assertLease: AssertWorkspaceRecoveryLease): Promise<RecoveryStopProof> {
    claim = workspaceRecoveryClaim.parse(claim)
    const check = async () => {
      await assertLease()
      await transaction(this.pool, async client => {
        await this.lockUser(client, claim.userId)
        await this.recoveryFence(claim, client)
        await assertLease(client)
      })
    }
    await check()
    const selected = await transaction(this.pool, async client => {
      await this.lockUser(client, claim.userId)
      await this.recoveryFence(claim, client)
      const result = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [claim.userId])
      const slot = result.rows[0], target = claim.stopTarget
      if (!slot || slot.generation !== target.mountGeneration) throw new MountSlotBlocked('mount_recovery_slot_changed', false)
      if (target.kind === 'no_writer') {
        const live = await client.query("SELECT session_id FROM pe_sandbox_instances WHERE user_id=$1 AND state<>'deleted' LIMIT 1",
          [claim.userId])
        if (slot.state !== 'free' || live.rowCount) throw new MountSlotBlocked('mount_recovery_writer_present', false)
        return null
      }
      const instance = await client.query<StopInstance & { state: string; name: string; pod_uid: string | null;
        runner_instance_id: string | null }>(
        'SELECT state,name,pod_uid,runner_instance_id,stop_pod_uid,stop_evidence,binding_snapshot FROM pe_sandbox_instances WHERE session_id=$1 AND user_id=$2 FOR UPDATE',
        [target.sessionId, claim.userId])
      const old = instance.rows[0]
      if (slot.state === 'free') {
        if (!old || old.state !== 'deleted' || old.name !== this.name(claim.userId)
          || !this.hasProof(slot, old, target.podUid, target)) throw new MountSlotBlocked('mount_stop_proof_missing', false)
        return null
      }
      if (!['ready', 'stopping'].includes(slot.state) || slot.session_id !== target.sessionId
        || slot.pod_uid !== target.podUid || slot.runner_instance_id !== target.runnerInstanceId
        || !old || old.name !== this.name(claim.userId) || old.pod_uid !== target.podUid
        || old.runner_instance_id !== target.runnerInstanceId
        || old.state !== (slot.state === 'ready' ? 'ready' : 'deleting')
        || !this.sameBinding(old.binding_snapshot, this.snapshot(slot))) {
        throw new MountSlotBlocked('mount_recovery_slot_changed', false)
      }
      await assertLease(client)
      if (slot.state === 'ready') {
        await client.query("UPDATE pe_mount_slots SET state='stopping',updated_at=now() WHERE user_id=$1", [claim.userId])
        await client.query("UPDATE pe_sandbox_instances SET state='deleting',updated_at=now() WHERE session_id=$1", [target.sessionId])
      }
      return { ...slot, state: 'stopping' as const }
    })
    if (selected) await this.stopAndRelease(selected, check, async client => {
      await assertLease(client)
      await this.recoveryFence(claim, client)
    })
    await check()
    return transaction(this.pool, async client => {
      await this.lockUser(client, claim.userId)
      await this.recoveryFence(claim, client)
      const result = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [claim.userId])
      const slot = result.rows[0], target = claim.stopTarget
      if (!slot || slot.state !== 'free' || slot.generation !== target.mountGeneration) {
        throw new MountSlotBlocked('mount_recovery_slot_changed', false)
      }
      if (target.kind === 'no_writer') {
        const live = await client.query("SELECT session_id FROM pe_sandbox_instances WHERE user_id=$1 AND state<>'deleted' LIMIT 1", [claim.userId])
        if (live.rowCount) throw new MountSlotBlocked('mount_recovery_writer_present', false)
        await assertLease(client)
        return { kind: 'no_writer', mountGeneration: target.mountGeneration }
      }
      const instance = await client.query<StopInstance & { state: string }>(
        'SELECT state,stop_pod_uid,stop_evidence,binding_snapshot FROM pe_sandbox_instances WHERE session_id=$1 AND user_id=$2 FOR UPDATE',
        [target.sessionId, claim.userId])
      if (!instance.rows[0] || instance.rows[0].state !== 'deleted'
        || !this.hasProof(slot, instance.rows[0], target.podUid, target)) throw new MountSlotBlocked('mount_stop_proof_missing', false)
      await assertLease(client)
      return { kind: 'kubelet_stopped', mountGeneration: target.mountGeneration, podUid: target.podUid }
    })
  }

  private async stopping(slot: MountSlot): Promise<MountSlot> {
    const selected = await this.pool.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1', [slot.user_id])
    const current = selected.rows[0]
    if (!current || current.state !== 'stopping' || current.session_id !== slot.session_id
      || current.generation !== slot.generation || current.pod_uid !== slot.pod_uid
      || current.runner_instance_id !== slot.runner_instance_id || !this.sameBinding(current.binding_snapshot, this.snapshot(slot))) {
      throw new MountSlotBlocked('mount_stop_generation_changed', false)
    }
    return current
  }

  private hasProof(slot: MountSlot, instance: StopInstance, uid: string,
    target?: { sessionId: string; runnerInstanceId: string }): boolean {
    const binding = storageBinding.safeParse(slot.binding_snapshot)
    if (!binding.success || !this.sameBinding(instance.binding_snapshot, binding.data)) return false
    const evidence = slot.stop_evidence, prior = instance.stop_evidence
    const matches = (value: unknown): boolean => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const item = value as Record<string, unknown>
      return item.status === 'KUBELET_STOPPED' && item.podUid === uid && item.generation === slot.generation
        && (item.sessionId === undefined && !target || item.sessionId === (target?.sessionId ?? slot.session_id))
        && (item.runnerInstanceId === undefined && !target || item.runnerInstanceId === (target?.runnerInstanceId ?? slot.runner_instance_id))
        && (item.bindingSnapshot === undefined && !target || this.sameBinding(item.bindingSnapshot, binding.data))
    }
    return slot.stop_pod_uid === uid && instance.stop_pod_uid === uid && matches(evidence) && matches(prior)
  }

  private async proof(slot: MountSlot): Promise<boolean> {
    const current = await this.stopping(slot)
    const instance = await this.pool.query<StopInstance>(
      'SELECT stop_pod_uid,stop_evidence,binding_snapshot FROM pe_sandbox_instances WHERE session_id=$1', [slot.session_id])
    return !!instance.rows[0] && this.hasProof(current, instance.rows[0], slot.pod_uid!)
  }

  private async persistProof(slot: MountSlot, sandboxUid: string | null): Promise<void> {
    const uid = slot.pod_uid!
    const evidence = { status: 'KUBELET_STOPPED', podUid: uid, sandboxUid,
      generation: slot.generation, sessionId: slot.session_id, runnerInstanceId: slot.runner_instance_id,
      bindingSnapshot: this.snapshot(slot), observedAt: new Date().toISOString() }
    await transaction(this.pool, async client => {
      await this.lockUser(client, slot.user_id)
      await this.lockWorkspace(client, slot.user_id, slot.workspace_id!)
      const current = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [slot.user_id])
      const row = current.rows[0]
      if (!row || row.state !== 'stopping' || row.session_id !== slot.session_id
        || row.generation !== slot.generation || row.pod_uid !== uid || row.runner_instance_id !== slot.runner_instance_id
        || !this.sameBinding(row.binding_snapshot, this.snapshot(slot))) {
        throw new MountSlotBlocked('mount_stop_generation_changed', false)
      }
      const instance = await client.query(
        `UPDATE pe_sandbox_instances SET stop_pod_uid=$2,stop_evidence=$3,updated_at=now()
         WHERE session_id=$1 AND user_id=$4 AND pod_uid=$2 AND state='deleting'
         AND binding_snapshot=$5::jsonb AND runner_instance_id=$6 RETURNING session_id`,
        [slot.session_id, uid, JSON.stringify(evidence), slot.user_id, JSON.stringify(this.snapshot(slot)), slot.runner_instance_id])
      if (!instance.rowCount) throw new MountSlotBlocked('mount_stop_instance_changed', false)
      await client.query(
        `UPDATE pe_mount_slots SET stop_pod_uid=$2,stop_evidence=$3,updated_at=now()
         WHERE user_id=$1 AND generation=$4 AND state='stopping'`,
        [slot.user_id, uid, JSON.stringify(evidence), slot.generation])
    })
  }

  private async stopAndRelease(slot: MountSlot, assertLease: () => Promise<void>,
    assertLockedLease?: (client: PoolClient) => Promise<void>): Promise<void> {
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
      await assertLease()
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
          await assertLease()
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
        await assertLease()
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
      await this.lockWorkspace(client, userId, slot.workspace_id!)
      const selected = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
      const current = selected.rows[0]
      const instance = await client.query<StopInstance>(
        'SELECT stop_pod_uid,stop_evidence,binding_snapshot FROM pe_sandbox_instances WHERE session_id=$1 FOR UPDATE', [sessionId])
      if (!current || current.state !== 'stopping' || current.generation !== slot.generation
        || current.session_id !== sessionId || current.pod_uid !== uid || current.runner_instance_id !== slot.runner_instance_id
        || !instance.rows[0] || !this.hasProof(current, instance.rows[0], uid)) {
        throw new MountSlotBlocked('mount_stop_proof_missing', false)
      }
      if (assertLockedLease) await assertLockedLease(client)
      const identity = JSON.stringify({ sessionId, runnerInstanceId: slot.runner_instance_id, bindingSnapshot: this.snapshot(slot) })
      await client.query(
        `UPDATE pe_sandbox_instances SET state='deleted',pod_uid=NULL,runner_instance_id=NULL,
         stop_evidence=stop_evidence||$3::jsonb,updated_at=now()
         WHERE session_id=$1 AND user_id=$2 AND state='deleting'`, [sessionId, userId, identity])
      await client.query(
        `UPDATE pe_mount_slots SET state='free',session_id=NULL,workspace_id=NULL,pod_uid=NULL,
         runner_instance_id=NULL,stop_evidence=stop_evidence||$3::jsonb,updated_at=now()
         WHERE user_id=$1 AND generation=$2 AND state='stopping'`, [userId, slot.generation, identity])
    })
  }

  /**
   * Recycle one idle writer; incomplete stop evidence leaves its slot blocked for reconciliation.
   * @param idleMs - Inactivity threshold; already stopping or disabled-account writers are also eligible.
   */
  async recycleIdle(idleMs: number): Promise<void> {
    const candidate = await this.pool.query<{ user_id: string }>(
      `SELECT m.user_id FROM pe_mount_slots m JOIN pe_sandbox_instances s ON s.session_id=m.session_id
       WHERE m.state IN ('ready','stopping')
       AND (m.state='stopping' OR s.last_used_at<now()-$1::double precision*interval '1 millisecond'
         OR EXISTS(SELECT 1 FROM pe_cloud_executions e WHERE e.session_id=m.session_id
           AND e.error_code='account_disabled' AND e.state IN ('uncertain','succeeded','failed','cancelled')))
       ORDER BY s.last_used_at LIMIT 1`, [idleMs])
    const userId = candidate.rows[0]?.user_id
    if (!userId) return
    const selected = await transaction(this.pool, async client => {
      await this.lockUser(client, userId)
      const hint = await client.query<{ workspace_id: string | null }>('SELECT workspace_id FROM pe_mount_slots WHERE user_id=$1', [userId])
      if (hint.rows[0]?.workspace_id) await this.lockWorkspace(client, userId, hint.rows[0].workspace_id)
      const result = await client.query<MountSlot>('SELECT * FROM pe_mount_slots WHERE user_id=$1 FOR UPDATE', [userId])
      const slot = result.rows[0]
      if (!slot || !slot.session_id || !slot.pod_uid || !slot.runner_instance_id
        || !['ready', 'stopping'].includes(slot.state)) return null
      const active = await client.query(
        `SELECT id FROM pe_cloud_executions WHERE session_id=$1
         AND state IN ('queued','starting','running','cancelling','uncertain')
         AND NOT (state='uncertain' AND cancel_requested AND error_code='account_disabled') LIMIT 1`, [slot.session_id])
      if (active.rowCount) return null
      if (slot.state === 'ready') {
        const old = await client.query(
          `UPDATE pe_sandbox_instances SET state='deleting',updated_at=now()
           WHERE session_id=$1 AND user_id=$2 AND state='ready' AND pod_uid=$3
           AND (last_used_at<now()-$4::double precision*interval '1 millisecond'
             OR EXISTS(SELECT 1 FROM pe_cloud_executions e WHERE e.session_id=$1
               AND e.error_code='account_disabled' AND e.state IN ('uncertain','succeeded','failed','cancelled')))
           RETURNING session_id`,
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
