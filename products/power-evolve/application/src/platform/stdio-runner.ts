/** Dedicated no-egress Kubernetes placement for one process MCP call. */
import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { KubernetesError, type KubernetesClient } from './kubernetes.ts'
import type { SshRunnerConfig } from './ssh-runner.ts'

type Kube = Pick<KubernetesClient, 'call' | 'resourcePath' | 'proxyPath'>
type Resource = { metadata: { name: string; uid?: string; labels?: Record<string, string>;
  deletionTimestamp?: string }; spec?: unknown; data?: Record<string, string>;
  status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean; restartCount?: number }> } }
export interface StdioRunnerHandle { readonly callId: string; readonly podUid: string; readonly instanceId: string }
export interface StdioRunnerStatus { readonly callId: string; readonly instanceId: string;
  readonly digest: string; readonly state: 'running' | 'succeeded' | 'failed';
  readonly result?: { kind: 'mcp.stdio.whoami'; text: string }; readonly errorCode?: string }
export type StdioObservation = { readonly state: 'absent' }
  | { readonly state: 'known'; readonly status: StdioRunnerStatus }
  | { readonly state: 'uncertain'; readonly reason: string }

export class StdioRunnerBlocked extends Error {
  constructor(readonly code: string) { super(code) }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const hex = /^[0-9a-f]{64}$/u
const nameOf = (id: string) => `pe-mcp-${id.replaceAll('-', '')}`
const label = 'powerevolve.dev/stdio-call'
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value

/** A Pod has no egress exception; only a live forbidden-listener probe can open its call API. */
export class StdioRunnerOrchestrator {
  constructor(private readonly kube: Kube, private readonly config: SshRunnerConfig) {
    if (!config.namespace || !config.image || !config.runtimeClassName || config.controlKey.length < 32
      || !config.platformIngressCidrs.length || !Number.isSafeInteger(config.readyTimeoutMs)
      || config.readyTimeoutMs < 1000) throw new StdioRunnerBlocked('mcp_runner_configuration_invalid')
  }

  private token(id: string): string {
    return createHmac('sha256', this.config.controlKey).update(`stdio-runner-v1:${id}`).digest('hex')
  }
  private digest(body: object, id: string): string {
    return createHmac('sha256', this.token(id)).update(JSON.stringify(canonical(body))).digest('hex')
  }
  private labels(id: string): Record<string, string> {
    return { 'app.kubernetes.io/name': 'power-evolve-connector-runner', [label]: id }
  }
  private path(kind: string, name?: string): string {
    const base = kind === 'networkpolicies'
      ? `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(this.config.namespace)}/networkpolicies`
      : this.kube.resourcePath(this.config.namespace, kind as 'pods' | 'services' | 'secrets')
    return name ? `${base}/${encodeURIComponent(name)}` : base
  }
  private async get(kind: string, name: string): Promise<Resource | null> {
    try { return await this.kube.call<Resource>('GET', this.path(kind, name)) }
    catch (error) { if (error instanceof KubernetesError && error.status === 404) return null; throw error }
  }
  private async ensure(kind: string, name: string, desired: Record<string, unknown>, token?: string): Promise<void> {
    const matches = (value: Resource | null) => value?.metadata.name === name
      && !value.metadata.deletionTimestamp
      && JSON.stringify(value.metadata.labels) === JSON.stringify((desired.metadata as Resource['metadata']).labels)
      && (kind === 'secrets' ? value.data?.token === Buffer.from(token!).toString('base64')
        : JSON.stringify(canonical(value.spec)) === JSON.stringify(canonical(desired.spec)))
    const prior = await this.get(kind, name)
    if (prior) { if (!matches(prior)) throw new StdioRunnerBlocked('mcp_runner_resource_changed'); return }
    try { await this.kube.call('POST', this.path(kind), desired) }
    catch (error) {
      if (!(error instanceof KubernetesError && error.status === 409) || !matches(await this.get(kind, name))) throw error
    }
  }
  private runner<T>(id: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return this.kube.call<T>(method, this.kube.proxyPath(this.config.namespace, nameOf(id), path),
      body, 10_000, this.token(id))
  }
  private async liveProbe(): Promise<boolean> {
    try { return await this.config.proveForbiddenListener() }
    catch (_unavailable) { return false }
  }

  /** Create no-egress policy before Pod creation; retain exact Pod identity for recovery. */
  async prepare(id: string): Promise<StdioRunnerHandle> {
    if (!uuid.test(id)) throw new StdioRunnerBlocked('mcp_runner_call_id_invalid')
    if (!await this.liveProbe()) throw new StdioRunnerBlocked('mcp_runner_probe_unavailable')
    const name = nameOf(id), labels = this.labels(id), token = this.token(id)
    await this.ensure('networkpolicies', name, { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name, namespace: this.config.namespace, labels },
      spec: { podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'],
        ingress: [{ from: this.config.platformIngressCidrs.map(cidr => ({ ipBlock: { cidr } })),
          ports: [{ protocol: 'TCP', port: 8080 }] }], egress: [] } })
    await this.ensure('secrets', name, { apiVersion: 'v1', kind: 'Secret',
      metadata: { name, namespace: this.config.namespace, labels }, type: 'Opaque',
      stringData: { token } }, token)
    await this.ensure('services', name, { apiVersion: 'v1', kind: 'Service',
      metadata: { name, namespace: this.config.namespace, labels },
      spec: { type: 'ClusterIP', selector: labels, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] } })
    await this.ensure('pods', name, { apiVersion: 'v1', kind: 'Pod',
      metadata: { name, namespace: this.config.namespace, labels },
      spec: { automountServiceAccountToken: false, runtimeClassName: this.config.runtimeClassName,
        restartPolicy: 'Never', terminationGracePeriodSeconds: 5, activeDeadlineSeconds: 180,
        enableServiceLinks: false,
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001,
          seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'runner', image: this.config.image,
          imagePullPolicy: this.config.imagePullPolicy ?? 'IfNotPresent',
          ports: [{ name: 'http', containerPort: 8080 }],
          env: [{ name: 'CONNECTOR_RUNNER_FORBIDDEN_PROBE', value:
            `${this.config.forbiddenProbe.ip}:${this.config.forbiddenProbe.port}` },
          { name: 'CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL', value: '1' }],
          readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 1, timeoutSeconds: 1 },
          resources: { requests: { cpu: '50m', memory: '96Mi' }, limits: { cpu: '500m', memory: '384Mi' } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
            runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, capabilities: { drop: ['ALL'] } },
          volumeMounts: [{ name: 'token', mountPath: '/run/power-evolve', readOnly: true },
            { name: 'scratch', mountPath: '/tmp' }] }],
        volumes: [{ name: 'token', secret: { secretName: name, defaultMode: 0o440,
          items: [{ key: 'token', path: 'runner-token', mode: 0o440 }] } },
        { name: 'scratch', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }] } })
    const until = Date.now() + this.config.readyTimeoutMs
    while (Date.now() < until) {
      const pod = await this.get('pods', name)
      if (!pod || pod.metadata.deletionTimestamp || !pod.metadata.uid
        || JSON.stringify(pod.metadata.labels) !== JSON.stringify(labels)) {
        throw new StdioRunnerBlocked('mcp_runner_pod_identity_changed')
      }
      if (pod.status?.phase === 'Running' && pod.status.containerStatuses?.[0]?.ready
        && (pod.status.containerStatuses[0].restartCount ?? 0) === 0) {
        try {
          const health = await this.runner<{ ready: boolean; instanceId: string }>(id, 'GET', '/health')
          if (health.ready && uuid.test(health.instanceId) && await this.liveProbe()) {
            const current = await this.get('pods', name)
            if (current?.metadata.uid !== pod.metadata.uid
              || (current.status?.containerStatuses?.[0]?.restartCount ?? 0) !== 0) {
              throw new StdioRunnerBlocked('mcp_runner_pod_identity_changed')
            }
            return { callId: id, podUid: pod.metadata.uid, instanceId: health.instanceId }
          }
        } catch (error) { if (error instanceof StdioRunnerBlocked) throw error }
      }
      await delay(200)
    }
    throw new StdioRunnerBlocked('mcp_runner_not_ready')
  }

  private unsigned(handle: StdioRunnerHandle, accountId: string) {
    return { kind: 'mcp.stdio.whoami' as const, callId: handle.callId, instanceId: handle.instanceId,
      accountId, timeoutMs: 15_000, maxOutputBytes: 8192 }
  }
  digestFor(handle: StdioRunnerHandle, accountId: string): string {
    if (!uuid.test(accountId)) throw new StdioRunnerBlocked('mcp_runner_account_invalid')
    return this.digest(this.unsigned(handle, accountId), handle.callId)
  }
  private async same(handle: StdioRunnerHandle): Promise<boolean> {
    const pod = await this.get('pods', nameOf(handle.callId))
    if (pod?.metadata.uid !== handle.podUid || pod.metadata.deletionTimestamp
      || (pod.status?.containerStatuses?.[0]?.restartCount ?? 0) !== 0) return false
    try {
      const health = await this.runner<{ ready: boolean; instanceId: string }>(handle.callId, 'GET', '/health')
      return health.ready && health.instanceId === handle.instanceId && await this.liveProbe()
    } catch (_unavailable) { return false }
  }
  /** A missing record after dispatch intent is uncertain, never a reason to POST again. */
  async reconcile(handle: StdioRunnerHandle, dispatched: boolean, expectedDigest?: string): Promise<StdioObservation> {
    if (dispatched && !hex.test(expectedDigest ?? '')) return { state: 'uncertain', reason: 'dispatch_digest_missing' }
    if (!await this.same(handle)) return { state: 'uncertain', reason: 'runner_identity_changed' }
    try {
      const status = await this.runner<StdioRunnerStatus>(handle.callId, 'GET', `/calls/${handle.callId}`)
      return status.callId === handle.callId && status.instanceId === handle.instanceId
        && (!expectedDigest || status.digest === expectedDigest)
        ? { state: 'known', status } : { state: 'uncertain', reason: 'runner_status_identity_changed' }
    } catch (error) {
      if (error instanceof KubernetesError && error.status === 404) return dispatched
        ? { state: 'uncertain', reason: 'dispatched_call_missing' } : { state: 'absent' }
      return { state: 'uncertain', reason: 'runner_status_unavailable' }
    }
  }
  /** Call only once after the platform commits the digest and dispatch intent. */
  async dispatchFirst(handle: StdioRunnerHandle, accountId: string): Promise<StdioObservation> {
    const digest = this.digestFor(handle, accountId)
    const prior = await this.reconcile(handle, false, digest)
    if (prior.state !== 'absent') return prior
    const unsigned = this.unsigned(handle, accountId)
    try {
      const status = await this.runner<StdioRunnerStatus>(handle.callId, 'POST', '/calls', { ...unsigned, digest })
      return status.callId === handle.callId && status.instanceId === handle.instanceId
        && status.digest === digest ? { state: 'known', status }
        : { state: 'uncertain', reason: 'runner_status_identity_changed' }
    } catch (_unavailable) { return { state: 'uncertain', reason: 'dispatch_result_unknown' } }
  }
  /** Cleanup retains the Pod until an exact UID deletion is observed. */
  async cleanup(callId: string, expectedPodUid?: string): Promise<void> {
    if (!uuid.test(callId)) throw new StdioRunnerBlocked('mcp_runner_call_id_invalid')
    const name = nameOf(callId)
    const pod = await this.get('pods', name)
    if (pod && (expectedPodUid && pod.metadata.uid !== expectedPodUid
      || JSON.stringify(pod.metadata.labels) !== JSON.stringify(this.labels(callId)))) {
      throw new StdioRunnerBlocked('mcp_runner_pod_identity_changed')
    }
    try { await this.kube.call('DELETE', this.path('pods', name)) }
    catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
    const until = Date.now() + this.config.readyTimeoutMs
    while (Date.now() < until) {
      const current = await this.get('pods', name)
      if (!current) break
      if (expectedPodUid && current.metadata.uid !== expectedPodUid) {
        throw new StdioRunnerBlocked('mcp_runner_pod_identity_changed')
      }
      await delay(200)
    }
    if (await this.get('pods', name)) throw new StdioRunnerBlocked('mcp_runner_deletion_unconfirmed')
    for (const kind of ['services', 'secrets', 'networkpolicies']) {
      try { await this.kube.call('DELETE', this.path(kind, name)) }
      catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
    }
  }
}
