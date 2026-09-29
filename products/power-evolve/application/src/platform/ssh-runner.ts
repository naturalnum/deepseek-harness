/** Platform-only, one-call Kubernetes placement for the isolated SSH Connector Runner. */
import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { KubernetesError, type KubernetesClient } from './kubernetes.ts'

type Kube = Pick<KubernetesClient, 'call' | 'resourcePath' | 'proxyPath'>
type Method = 'GET' | 'POST'
type Role = 'canary' | 'call'
interface Metadata { name: string; uid?: string; labels?: Record<string, string>; deletionTimestamp?: string }
interface Resource { metadata: Metadata; spec?: unknown; data?: Record<string, string> }
interface Pod extends Resource { status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean; restartCount?: number }> } }
interface Health { ready: boolean; instanceId: string }
export interface SshRunnerDestination {
  /** A platform-pinned IP literal. DNS resolution cannot change the policy target. */
  readonly ip: string
  readonly port: number
  readonly username: string
  readonly hostKeySha256: string
}
export interface SshRunnerConfig {
  /** Dedicated, preprovisioned namespace; never the writable Sandbox namespace. */
  readonly namespace: string
  readonly image: string
  readonly runtimeClassName: string
  readonly controlKey: string
  readonly readyTimeoutMs: number
  /** Exact source CIDRs for API server service-proxy traffic and/or Platform callback. */
  readonly platformIngressCidrs: readonly string[]
  /** Live, platform-operated listener that must be forbidden from Runner Pods. */
  readonly forbiddenProbe: { readonly ip: string; readonly port: number }
  /** Independent control-path check of the forbidden listener. Fail closed if it is not live. */
  readonly proveForbiddenListener: () => Promise<boolean>
  readonly imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never'
}
export interface SshRunnerHandle {
  readonly callId: string
  readonly podUid: string
  readonly instanceId: string
  readonly destination: SshRunnerDestination
}
export type SshRunnerRequest =
  | { readonly kind: 'ssh.authenticate'; readonly credential: { readonly kind: 'password'; readonly password: string }; readonly timeoutMs: number; readonly maxOutputBytes: number }
  | { readonly kind: 'ssh.execute'; readonly credential: { readonly kind: 'password'; readonly password: string }; readonly command: string; readonly timeoutMs: number; readonly maxOutputBytes: number }
export interface SshRunnerStatus {
  readonly callId: string
  readonly instanceId: string
  readonly digest: string
  readonly state: 'running' | 'succeeded' | 'failed'
  readonly result?: unknown
  readonly errorCode?: string
}
export type SshRunnerObservation = { readonly state: 'absent' }
  | { readonly state: 'known'; readonly status: SshRunnerStatus }
  | { readonly state: 'uncertain'; readonly reason: string }

export class SshRunnerBlocked extends Error {
  constructor(readonly code: string) { super(code) }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const fingerprint = /^SHA256:[A-Za-z0-9+/]{43}$/u
const label = 'powerevolve.dev/connector-call'
const nameOf = (callId: string) => `pe-cr-${callId.replaceAll('-', '')}`
const address = (ip: string) => isIP(ip) === 4 ? `${ip}/32` : `${ip}/128`
const keyOf = (ip: string, port: number) => isIP(ip) === 4 ? `${ip}:${port}` : `[${ip}]:${port}`
const exactCidr = (cidr: string) => {
  const [ip, bits, rest] = cidr.split('/')
  return rest === undefined && (isIP(ip!) === 4 && bits === '32' || isIP(ip!) === 6 && bits === '128')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
function digest(value: object, token: string): string {
  return createHmac('sha256', token).update(JSON.stringify(canonical(value))).digest('hex')
}
function equal(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false
    if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length
      && expected.every((item, index) => equal(item, actual[index]))
    return Object.entries(expected).every(([key, item]) => equal(item, (actual as Record<string, unknown>)[key]))
  }
  return expected === actual
}

/** The caller persists the handle and dispatch intent before invoking dispatchFirst. */
export class SshRunnerOrchestrator {
  constructor(private readonly kube: Kube, private readonly config: SshRunnerConfig) {
    if (!config.namespace || !config.image || !config.runtimeClassName || config.controlKey.length < 32
      || !Number.isSafeInteger(config.readyTimeoutMs) || config.readyTimeoutMs < 1000
      || !config.platformIngressCidrs.length || config.platformIngressCidrs.some(cidr => !exactCidr(cidr))
      || !isIP(config.forbiddenProbe.ip) || !Number.isSafeInteger(config.forbiddenProbe.port)
      || config.forbiddenProbe.port < 1 || config.forbiddenProbe.port > 65_535) {
      throw new SshRunnerBlocked('connector_runner_configuration_invalid')
    }
  }

  private validate(callId: string, target: SshRunnerDestination): void {
    if (!uuid.test(callId) || !isIP(target.ip) || !Number.isSafeInteger(target.port)
      || target.port < 1 || target.port > 65_535 || !target.username
      || Buffer.byteLength(target.username) > 256 || /[\x00-\x1f\x7f]/u.test(target.username)
      || !fingerprint.test(target.hostKeySha256)
      || target.ip === this.config.forbiddenProbe.ip && target.port === this.config.forbiddenProbe.port) {
      throw new SshRunnerBlocked('connector_runner_destination_invalid')
    }
  }

  private token(callId: string, role: Role): string {
    return createHmac('sha256', this.config.controlKey).update(`ssh-runner-v1:${callId}:${role}`).digest('hex')
  }
  private labels(callId: string, role?: Role): Record<string, string> {
    return { 'app.kubernetes.io/name': 'power-evolve-connector-runner', [label]: callId,
      ...(role ? { 'powerevolve.dev/connector-role': role } : {}) }
  }
  private path(kind: string, name?: string): string {
    const root = kind === 'networkpolicies' ? `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(this.config.namespace)}/networkpolicies`
      : this.kube.resourcePath(this.config.namespace, kind as 'pods' | 'services' | 'secrets')
    return name ? `${root}/${encodeURIComponent(name)}` : root
  }
  private async get<T extends Resource>(kind: string, name: string): Promise<T | null> {
    try { return await this.kube.call<T>('GET', this.path(kind, name)) }
    catch (error) { if (error instanceof KubernetesError && error.status === 404) return null; throw error }
  }
  private async ensure(kind: string, name: string, body: Record<string, unknown>, token?: string): Promise<void> {
    const matches = (resource: Resource | null) => resource?.metadata.name === name && !resource.metadata.deletionTimestamp
      && equal((body.metadata as Metadata).labels, resource.metadata.labels)
      && (kind === 'secrets' ? resource.data?.token === Buffer.from(token!).toString('base64')
        : equal(body.spec, resource.spec))
    const existing = await this.get(kind, name)
    if (existing) { if (!matches(existing)) throw new SshRunnerBlocked('connector_runner_resource_changed'); return }
    try { await this.kube.call('POST', this.path(kind), body) }
    catch (error) {
      if (!(error instanceof KubernetesError && error.status === 409) || !matches(await this.get(kind, name))) throw error
    }
  }
  private async runner<T>(name: string, token: string, method: Method, path: string, body?: unknown): Promise<T> {
    return this.kube.call<T>(method, this.kube.proxyPath(this.config.namespace, name, path), body, 10_000, token)
  }
  private policy(callId: string, target: SshRunnerDestination): Record<string, unknown> {
    const name = nameOf(callId)
    return { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name, namespace: this.config.namespace, labels: this.labels(callId) },
      spec: { podSelector: { matchLabels: this.labels(callId) }, policyTypes: ['Ingress', 'Egress'],
        ingress: [{ from: this.config.platformIngressCidrs.map(cidr => ({ ipBlock: { cidr } })),
          ports: [{ protocol: 'TCP', port: 8080 }] }],
        egress: [{ to: [{ ipBlock: { cidr: address(target.ip) } }],
          ports: [{ protocol: 'TCP', port: target.port }] }] } }
  }
  private async createPod(callId: string, role: Role, target: SshRunnerDestination): Promise<string> {
    const name = role === 'canary' ? `${nameOf(callId)}-check` : nameOf(callId)
    const token = this.token(callId, role), labels = this.labels(callId, role)
    await this.ensure('secrets', name, { apiVersion: 'v1', kind: 'Secret',
      metadata: { name, namespace: this.config.namespace, labels }, type: 'Opaque', stringData: { token } }, token)
    await this.ensure('services', name, { apiVersion: 'v1', kind: 'Service',
      metadata: { name, namespace: this.config.namespace, labels },
      spec: { type: 'ClusterIP', selector: labels, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] } })
    await this.ensure('pods', name, { apiVersion: 'v1', kind: 'Pod',
      metadata: { name, namespace: this.config.namespace, labels },
      spec: { automountServiceAccountToken: false,
        runtimeClassName: this.config.runtimeClassName, restartPolicy: 'Never',
        terminationGracePeriodSeconds: 5, activeDeadlineSeconds: 180, enableServiceLinks: false,
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001,
          fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'runner', image: this.config.image,
          imagePullPolicy: this.config.imagePullPolicy ?? 'IfNotPresent',
          ports: [{ name: 'http', containerPort: 8080 }],
          env: [{ name: 'CONNECTOR_RUNNER_ALLOWED_DESTINATIONS', value: keyOf(target.ip, target.port) },
            { name: 'CONNECTOR_RUNNER_FORBIDDEN_PROBE', value: keyOf(this.config.forbiddenProbe.ip, this.config.forbiddenProbe.port) }],
          readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 1, timeoutSeconds: 1 },
          resources: { requests: { cpu: '50m', memory: '96Mi' }, limits: { cpu: '500m', memory: '384Mi' } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
            runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, capabilities: { drop: ['ALL'] } },
          volumeMounts: [{ name: 'token', mountPath: '/run/power-evolve', readOnly: true },
            { name: 'scratch', mountPath: '/tmp' }] }],
        volumes: [{ name: 'token', secret: { secretName: name, defaultMode: 0o440,
          items: [{ key: 'token', path: 'runner-token', mode: 0o440 }] } },
        { name: 'scratch', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }] } })
    return name
  }

  private async ready(callId: string, role: Role, name: string): Promise<{ uid: string; instanceId: string }> {
    const until = Date.now() + this.config.readyTimeoutMs
    while (Date.now() < until) {
      const pod = await this.get<Pod>('pods', name)
      if (!pod || pod.metadata.deletionTimestamp || !equal(this.labels(callId, role), pod.metadata.labels)) {
        throw new SshRunnerBlocked('connector_runner_pod_identity_changed')
      }
      if (pod.metadata.uid && pod.status?.phase === 'Running' && pod.status.containerStatuses?.[0]?.ready
        && (pod.status.containerStatuses[0].restartCount ?? 0) === 0) {
        try {
          const health = await this.runner<Health>(name, this.token(callId, role), 'GET', '/health')
          if (health.ready && uuid.test(health.instanceId)) {
            const current = await this.get<Pod>('pods', name)
            if (current?.metadata.uid !== pod.metadata.uid || current.metadata.deletionTimestamp
              || (current.status?.containerStatuses?.[0]?.restartCount ?? 0) !== 0) {
              throw new SshRunnerBlocked('connector_runner_pod_identity_changed')
            }
            return { uid: pod.metadata.uid, instanceId: health.instanceId }
          }
        } catch (error) { if (error instanceof SshRunnerBlocked) throw error }
      }
      await delay(200)
    }
    throw new SshRunnerBlocked('connector_runner_not_ready')
  }

  private async deleteOne(kind: string, name: string): Promise<void> {
    try { await this.kube.call('DELETE', this.path(kind, name)) }
    catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
  }
  private async clearCanary(callId: string): Promise<void> {
    const name = `${nameOf(callId)}-check`
    await this.deleteOne('pods', name)
    await this.deleteOne('services', name)
    await this.deleteOne('secrets', name)
  }

  /** Creates policy before Pods, proves a forbidden listener is live, and inspects the allowed target without credentials. */
  async prepare(callId: string, target: SshRunnerDestination): Promise<SshRunnerHandle> {
    this.validate(callId, target)
    if (!await this.config.proveForbiddenListener()) throw new SshRunnerBlocked('connector_runner_probe_unavailable')
    await this.ensure('networkpolicies', nameOf(callId), this.policy(callId, target))
    try {
      const canaryName = await this.createPod(callId, 'canary', target)
      const canary = await this.ready(callId, 'canary', canaryName)
      const unsigned = { callId, instanceId: canary.instanceId, kind: 'ssh.inspect',
        destination: { host: target.ip, port: target.port, username: target.username },
        timeoutMs: 5000, maxOutputBytes: 1024 }
      const expectedDigest = digest(unsigned, this.token(callId, 'canary'))
      const status = await this.runner<SshRunnerStatus>(canaryName, this.token(callId, 'canary'), 'POST', '/calls',
        { ...unsigned, digest: expectedDigest })
      if (status.callId !== callId || status.instanceId !== canary.instanceId || status.digest !== expectedDigest) {
        throw new SshRunnerBlocked('connector_runner_canary_identity_changed')
      }
      let result = status
      const until = Date.now() + this.config.readyTimeoutMs
      while (result.state === 'running' && Date.now() < until) {
        await delay(200)
        result = await this.runner<SshRunnerStatus>(canaryName, this.token(callId, 'canary'), 'GET', `/calls/${callId}`)
      }
      if (result.callId !== callId || result.instanceId !== canary.instanceId || result.digest !== expectedDigest
        || result.state !== 'succeeded' || result.result === null || typeof result.result !== 'object'
        || (result.result as Record<string, unknown>).hostKeySha256 !== target.hostKeySha256) {
        throw new SshRunnerBlocked('connector_runner_canary_failed')
      }
    } finally { await this.clearCanary(callId) }
    const name = await this.createPod(callId, 'call', target)
    const ready = await this.ready(callId, 'call', name)
    return { callId, destination: target, podUid: ready.uid, instanceId: ready.instanceId }
  }

  private async identity(handle: SshRunnerHandle): Promise<'same' | 'changed'> {
    const pod = await this.get<Pod>('pods', nameOf(handle.callId))
    if (!pod || pod.metadata.uid !== handle.podUid || pod.metadata.deletionTimestamp
      || !equal(this.labels(handle.callId, 'call'), pod.metadata.labels)
      || (pod.status?.containerStatuses?.[0]?.restartCount ?? 0) !== 0) return 'changed'
    try {
      const health = await this.runner<Health>(nameOf(handle.callId), this.token(handle.callId, 'call'), 'GET', '/health')
      return health.ready && health.instanceId === handle.instanceId ? 'same' : 'changed'
    } catch (_error) { return 'changed' }
  }

  /** Persist this keyed digest with the dispatch intent; it is not an offline password verifier. */
  digestFor(handle: SshRunnerHandle, request: SshRunnerRequest): string {
    this.validate(handle.callId, handle.destination)
    if (request.credential.kind !== 'password' || !request.credential.password
      || request.credential.password.includes('\0')
      || Buffer.byteLength(request.credential.password) > 4096
      || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60_000
      || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1
      || request.maxOutputBytes > 131_072 || request.kind === 'ssh.execute'
      && (!request.command || Buffer.byteLength(request.command) > 16_384 || request.command.includes('\0'))) {
      throw new SshRunnerBlocked('connector_runner_request_invalid')
    }
    return digest(this.unsigned(handle, request), this.token(handle.callId, 'call'))
  }

  private unsigned(handle: SshRunnerHandle, request: SshRunnerRequest) {
    return { callId: handle.callId, instanceId: handle.instanceId, kind: request.kind,
      destination: { host: handle.destination.ip, port: handle.destination.port,
        username: handle.destination.username, hostKeySha256: handle.destination.hostKeySha256 },
      timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes,
      credential: request.credential, ...(request.kind === 'ssh.execute' ? { command: request.command } : {}) }
  }

  /** Read-only recovery. A missing in-memory call after a persisted dispatch intent is uncertain. */
  async reconcile(handle: SshRunnerHandle, dispatched: boolean, expectedDigest?: string): Promise<SshRunnerObservation> {
    this.validate(handle.callId, handle.destination)
    if (dispatched && !/^[0-9a-f]{64}$/u.test(expectedDigest ?? '')) {
      return { state: 'uncertain', reason: 'dispatch_digest_missing' }
    }
    if (await this.identity(handle) !== 'same') return { state: 'uncertain', reason: 'runner_identity_changed' }
    try {
      const status = await this.runner<SshRunnerStatus>(nameOf(handle.callId), this.token(handle.callId, 'call'),
        'GET', `/calls/${handle.callId}`)
      return status.callId === handle.callId && status.instanceId === handle.instanceId
        && (expectedDigest === undefined || status.digest === expectedDigest)
        ? { state: 'known', status } : { state: 'uncertain', reason: 'runner_status_identity_changed' }
    } catch (error) {
      if (error instanceof KubernetesError && error.status === 404) return dispatched
        ? { state: 'uncertain', reason: 'dispatched_call_missing' } : { state: 'absent' }
      return { state: 'uncertain', reason: 'runner_status_unavailable' }
    }
  }

  /** Invoke once after the caller durably marks dispatch intent. Never retry a transport-uncertain POST. */
  async dispatchFirst(handle: SshRunnerHandle, request: SshRunnerRequest): Promise<SshRunnerObservation> {
    this.validate(handle.callId, handle.destination)
    const unsigned = this.unsigned(handle, request)
    const token = this.token(handle.callId, 'call')
    const expectedDigest = this.digestFor(handle, request)
    const before = await this.reconcile(handle, false, expectedDigest)
    if (before.state !== 'absent') return before
    if (!await this.config.proveForbiddenListener()) {
      return { state: 'uncertain', reason: 'forbidden_probe_unavailable' }
    }
    if (await this.identity(handle) !== 'same') return { state: 'uncertain', reason: 'runner_identity_changed' }
    try {
      const status = await this.runner<SshRunnerStatus>(nameOf(handle.callId), token, 'POST', '/calls',
        { ...unsigned, digest: expectedDigest })
      return status.callId === handle.callId && status.instanceId === handle.instanceId
        && status.digest === expectedDigest
        ? { state: 'known', status } : { state: 'uncertain', reason: 'runner_status_identity_changed' }
    } catch (_error) { return { state: 'uncertain', reason: 'dispatch_outcome_unknown' } }
  }

  /** A Pod deletion cancels work physically; its prior remote effect remains uncertain. */
  async cancel(handle: SshRunnerHandle, expectedDigest: string): Promise<SshRunnerObservation> {
    const prior = await this.reconcile(handle, true, expectedDigest)
    await this.deleteOne('pods', nameOf(handle.callId))
    return prior.state === 'known' && prior.status.state !== 'running' ? prior
      : { state: 'uncertain', reason: 'cancel_effect_unknown' }
  }

  /** Call only after durable terminal status or explicit uncertain-state quarantine. */
  async cleanup(callId: string): Promise<void> {
    if (!uuid.test(callId)) throw new SshRunnerBlocked('connector_runner_call_id_invalid')
    await this.clearCanary(callId)
    const name = nameOf(callId)
    await this.deleteOne('pods', name)
    const until = Date.now() + this.config.readyTimeoutMs
    while (await this.get('pods', name)) {
      if (Date.now() >= until) throw new SshRunnerBlocked('connector_runner_deletion_unconfirmed')
      await delay(200)
    }
    await this.deleteOne('services', name)
    await this.deleteOne('secrets', name)
    await this.deleteOne('networkpolicies', name)
  }
}
