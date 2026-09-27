/** Kubernetes Agent Sandbox resources for one authorized root Session. */
import { createHmac } from 'node:crypto'
import { chown, lstat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import type { FileService } from './files.ts'
import { KubernetesClient, KubernetesError } from './kubernetes.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'

const STOP_FINALIZER = 'powerevolve.dev/retain-stop-observation'
interface Metadata { name: string; uid?: string; resourceVersion?: string; labels?: Record<string, string>; deletionTimestamp?: string;
  finalizers?: string[]; ownerReferences?: Array<{ uid?: string }> }
interface Resource { metadata: Metadata; spec?: Record<string, unknown>; status?: Record<string, unknown>; data?: Record<string, string> }
interface Pod extends Resource { status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean; restartCount?: number }> } }
export interface SandboxReady { name: string; podUid: string; runnerInstanceId: string; token: string; restartCount: number }

export interface SandboxConfig {
  readonly namespace: string
  readonly image: string
  readonly localRoot: string
  readonly nodeRoot: string
  readonly readyTimeoutMs: number
}

/** The platform owns Kubernetes credentials; the host never receives a Pod or mount path. */
export class SandboxManager {
  constructor(private readonly kube: KubernetesClient, private readonly files: FileService, private readonly pool: Pool,
    private readonly key: string, private readonly config: SandboxConfig) {}

  name(sessionId: string): string { return `pe-sb-${sessionId.replaceAll('-', '')}` }
  private token(name: string): string { return createHmac('sha256', this.key).update(name).digest('hex') }
  private labels(sessionId: string, userId: string, name: string): Record<string, string> {
    return { 'app.kubernetes.io/name': 'power-evolve-sandbox', 'app.kubernetes.io/instance': name,
      'powerevolve.dev/session': sessionId, 'powerevolve.dev/user': userId }
  }

  private async get(resource: 'sandboxes' | 'pods' | 'services' | 'secrets', name: string): Promise<Resource | null> {
    try { return await this.kube.call<Resource>('GET', this.kube.resourcePath(this.config.namespace, resource, name)) }
    catch (error) { if (error instanceof KubernetesError && error.status === 404) return null; throw error }
  }

  private async ensure(resource: 'sandboxes' | 'services' | 'secrets', name: string,
    body: Record<string, unknown>, labels: Record<string, string>): Promise<void> {
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
        ? value.data?.token === Buffer.from(this.token(name)).toString('base64')
        : matches(body.spec, value.spec))
    const existing = await this.get(resource, name)
    if (existing) {
      if (!sameResource(existing) || existing.metadata.deletionTimestamp) {
        throw new Error(`Existing ${resource} differs from the requested Sandbox resource or is deleting`)
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

  /** Check a previously admitted writer without creating any Kubernetes resource. */
  async matchesInstance(sessionId: string, userId: string, podUid: string, runnerInstanceId: string): Promise<boolean> {
    const name = this.name(sessionId)
    const [sandbox, pod] = await Promise.all([this.get('sandboxes', name), this.get('pods', name)])
    if (!sandbox || sandbox.metadata.deletionTimestamp || !pod || pod.metadata.deletionTimestamp
      || pod.metadata.uid !== podUid || pod.metadata.labels?.['powerevolve.dev/session'] !== sessionId
      || pod.metadata.labels?.['powerevolve.dev/user'] !== userId
      || !pod.metadata.ownerReferences?.some(ref => ref.uid === sandbox.metadata.uid)
      || !pod.metadata.finalizers?.includes(STOP_FINALIZER)) return false
    const health = await this.runner<{ ready: boolean; instanceId: string }>(name, this.token(name), 'GET', '/health')
    return health.ready && health.instanceId === runnerInstanceId
  }

  /** Create missing resources and accept only the exact ready Pod and runner instance. */
  async ensureReady(sessionId: string, userId: string): Promise<SandboxReady> {
    const name = this.name(sessionId), labels = this.labels(sessionId, userId, name)
    const workspace = await this.files.workspaceForUser(userId)
    if (resolve(workspace.path) !== join(resolve(this.config.localRoot), 'workspaces', workspace.id)) {
      throw new Error('Workspace root does not match Sandbox storage root')
    }
    await this.home(userId)
    const namespace = this.config.namespace
    const token = this.token(name)
    await this.ensure('secrets', name, {
      apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace, labels }, type: 'Opaque',
      stringData: { token },
    }, labels)
    await this.ensure('services', name, {
      apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, labels },
      spec: { type: 'ClusterIP', selector: { 'app.kubernetes.io/instance': name },
        ports: [{ name: 'http', port: 8080, targetPort: 8080 }] },
    }, labels)
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
          { name: 'workspace', hostPath: { path: join(this.config.nodeRoot, 'workspaces', workspace.id), type: 'Directory' } },
          { name: 'home', hostPath: { path: join(this.config.nodeRoot, 'homes', userId), type: 'Directory' } },
          { name: 'token', secret: { secretName: name, defaultMode: 0o400,
            items: [{ key: 'token', path: 'runner-token', mode: 0o400 }] } },
          { name: 'scratch', emptyDir: { sizeLimit: '256Mi' } },
        ],
      } } },
    }, labels)
    const deadline = Date.now() + this.config.readyTimeoutMs
    while (Date.now() < deadline) {
      const [sandbox, pod] = await Promise.all([this.get('sandboxes', name), this.get('pods', name)])
      const conditions = sandbox?.status?.conditions
      const ready = Array.isArray(conditions) && conditions.some(value =>
        typeof value === 'object' && value !== null && 'type' in value && value.type === 'Ready'
        && 'status' in value && value.status === 'True')
      const current = pod as Pod | null
      if (ready && current?.metadata.uid && current.metadata.labels?.['powerevolve.dev/session'] === sessionId
        && current.metadata.labels?.['powerevolve.dev/user'] === userId
        && current.metadata.ownerReferences?.some(ref => ref.uid === sandbox?.metadata.uid)
        && current.status?.phase === 'Running' && current.status.containerStatuses?.[0]?.ready) {
        try {
          const health = await this.runner<{ ready: boolean; instanceId: string }>(name, token, 'GET', '/health')
          if (health.ready && /^[a-f0-9-]{36}$/.test(health.instanceId)) {
            const finalizers = current.metadata.finalizers ?? []
            if (!finalizers.includes(STOP_FINALIZER)) {
              if (!current.metadata.resourceVersion || current.metadata.deletionTimestamp || finalizers.length > 16) {
                throw new Error('Ready Pod cannot retain a stop observation')
              }
              await this.kube.call('PATCH', this.kube.resourcePath(namespace, 'pods', name), {
                metadata: { resourceVersion: current.metadata.resourceVersion, finalizers: [...finalizers, STOP_FINALIZER] },
              })
            }
            const retained = await this.get('pods', name)
            if (!retained || retained.metadata.uid !== current.metadata.uid || retained.metadata.deletionTimestamp
              || !retained.metadata.finalizers?.includes(STOP_FINALIZER)) throw new Error('Ready Pod identity changed')
            return { name, podUid: current.metadata.uid, runnerInstanceId: health.instanceId, token,
              restartCount: current.status.containerStatuses[0].restartCount ?? 0 }
          }
        } catch (_notYetReachable) { /* The Service may lag the Pod Ready condition. */ }
      }
      await delay(250)
    }
    throw new Error('Sandbox did not become ready before its deadline')
  }

  runner<T>(name: string, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return this.kube.call<T>(method, this.kube.proxyPath(this.config.namespace, name, path), body, 10_000, token)
  }

  /** Keep the exact Pod until kubelet stop status is durable; absence alone is not stop proof. */
  async remove(sessionId: string): Promise<void> {
    const name = this.name(sessionId)
    const selected = await this.pool.query<{ pod_uid: string | null; stop_pod_uid: string | null }>(
      'SELECT pod_uid,stop_pod_uid FROM pe_sandbox_instances WHERE session_id=$1', [sessionId])
    const expectedUid = selected.rows[0]?.pod_uid ?? null
    let observedUid = expectedUid
    const sandbox = await this.get('sandboxes', name)
    if (sandbox && (sandbox.metadata.labels?.['powerevolve.dev/session'] !== sessionId
      || sandbox.metadata.labels?.['app.kubernetes.io/name'] !== 'power-evolve-sandbox')) {
      throw new Error('Refusing to delete an unowned Sandbox')
    }
    const firstPod = await this.get('pods', name)
    if (firstPod) {
      if (!firstPod.metadata.uid || firstPod.metadata.labels?.['powerevolve.dev/session'] !== sessionId
        || sandbox && !firstPod.metadata.ownerReferences?.some(ref => ref.uid === sandbox.metadata.uid)
        || expectedUid && firstPod.metadata.uid !== expectedUid) throw new Error('Sandbox Pod identity changed')
      if (expectedUid && !firstPod.metadata.finalizers?.includes(STOP_FINALIZER)) {
        throw new Error('Selected Pod has no retained stop observation')
      }
      observedUid = firstPod.metadata.finalizers?.includes(STOP_FINALIZER) ? firstPod.metadata.uid : expectedUid
    }
    if (sandbox) await this.kube.call('DELETE', this.kube.resourcePath(this.config.namespace, 'sandboxes', name),
      { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: sandbox.metadata.uid } })
    const deadline = Date.now() + this.config.readyTimeoutMs
    while (Date.now() < deadline) {
      const pod = await this.get('pods', name)
      if (pod) {
        if (observedUid && pod.metadata.uid !== observedUid || pod.metadata.labels?.['powerevolve.dev/session'] !== sessionId) {
          throw new Error('Sandbox Pod was replaced during termination')
        }
        if (pod.metadata.finalizers?.includes(STOP_FINALIZER)) {
          const prior = await this.pool.query<{ stop_pod_uid: string | null }>(
            'SELECT stop_pod_uid FROM pe_sandbox_instances WHERE session_id=$1', [sessionId])
          if (prior.rows[0]?.stop_pod_uid !== observedUid) {
            const status = kubernetesPodStopStatus(pod)
            if (status) {
              await this.pool.query(
                `UPDATE pe_sandbox_instances SET stop_pod_uid=$2,stop_evidence=$3,updated_at=now()
                 WHERE session_id=$1 AND (pod_uid=$2 OR pod_uid IS NULL)`,
                [sessionId, observedUid, JSON.stringify({ status, podUid: observedUid,
                  sandboxUid: sandbox?.metadata.uid ?? null, observedAt: new Date().toISOString() })])
            }
          }
          const stopped = await this.pool.query<{ stop_pod_uid: string | null }>(
            'SELECT stop_pod_uid FROM pe_sandbox_instances WHERE session_id=$1', [sessionId])
          if (stopped.rows[0]?.stop_pod_uid === observedUid) {
            if (!pod.metadata.resourceVersion) throw new Error('Stopped Pod lacks a version')
            await this.kube.call('PATCH', this.kube.resourcePath(this.config.namespace, 'pods', name), {
              metadata: { resourceVersion: pod.metadata.resourceVersion,
                finalizers: pod.metadata.finalizers.filter(value => value !== STOP_FINALIZER) },
            })
          }
        }
      } else if (observedUid) {
        const proof = await this.pool.query<{ stop_pod_uid: string | null }>(
          'SELECT stop_pod_uid FROM pe_sandbox_instances WHERE session_id=$1', [sessionId])
        if (proof.rows[0]?.stop_pod_uid !== observedUid) throw new Error('Pod disappeared without native stop proof')
      }
      if (!pod && !(await this.get('sandboxes', name))) break
      await delay(250)
    }
    if (await this.get('pods', name) || await this.get('sandboxes', name)) throw new Error('Sandbox stop remains unconfirmed')
    for (const resource of ['services', 'secrets'] as const) {
      const existing = await this.get(resource, name)
      if (existing && (existing.metadata.labels?.['powerevolve.dev/session'] !== sessionId
        || existing.metadata.labels?.['app.kubernetes.io/name'] !== 'power-evolve-sandbox')) {
        throw new Error(`Refusing to delete an unowned ${resource}`)
      }
      if (existing) await this.kube.call('DELETE', this.kube.resourcePath(this.config.namespace, resource, name),
        { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: existing.metadata.uid } })
    }
  }
}
