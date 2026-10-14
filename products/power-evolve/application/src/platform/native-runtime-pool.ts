/** Platform-owned tenant processes keep Creator code away from shared credentials and other Profiles. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Pool } from 'pg'
import { z } from 'zod'
import { accountUserId, type UserId } from '../account-contracts.ts'
import { PlatformError } from '../contracts.ts'
import { KubernetesClient, KubernetesError } from './kubernetes.ts'
import { NativeRuntimeAuthority } from './native-runtime-authority.ts'
import { nativeRuntimePodStopStatus } from './native-runtime-pod-stop.ts'
import { transaction } from './database.ts'
import { digest } from './identity.ts'

const dns = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u).max(63)
const milliseconds = z.number().int().min(1000).max(2_147_483_647)
const template = z.object({ mode: z.enum(['https', 'local-http']), privateDir: z.string(), dshHome: z.string(),
  hostOrigin: z.url(), platformOrigin: z.url(), platformInternalUrl: z.url(),
  runtimeIdentity: z.object({ userId: accountUserId, runtimeId: z.uuid(), generation: z.number().int().positive() }).strict().optional(),
  rows: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.json()))) }).strict()
const configuration = z.object({ kubeconfigFile: z.string().min(1), namespace: dns,
  image: z.string().regex(/^\S+@sha256:[a-f0-9]{64}$/u), runtimeClass: dns, volumeClaimName: dns,
  storageSubPath: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_/-]*$/u).refine(value => !value.split('/').includes('..')),
  localStateRoot: z.string().refine(value => isAbsolute(value) && resolve(value) === value),
  deployment: template, credentialLifetimeMs: milliseconds, readyTimeoutMs: milliseconds,
  requestTimeoutMs: milliseconds, stopTimeoutMs: milliseconds, reconcileMs: milliseconds,
  maxResponseBytes: z.number().int().positive().max(134_217_728),
  maxRuntimeSeconds: z.number().int().min(60).max(2_147_483_647),
  maxAccounts: z.number().int().positive().max(10000),
  lockConnections: z.number().int().positive().max(256),
  resources: z.object({ requests: z.object({ cpu: z.string().min(1), memory: z.string().min(1) }).strict(),
    limits: z.object({ cpu: z.string().min(1), memory: z.string().min(1) }).strict() }).strict(),
}).strict()
/** Operator-selected tenant process resources and named Profile overrides. */
export type NativeRuntimePoolConfig = z.infer<typeof configuration>

const instance = z.object({ runtime_id: z.uuid(), user_id: accountUserId, generation: z.number().int().positive(),
  namespace: dns, config_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  credential_id: z.uuid().nullable(), pod_uid: z.string().min(1).nullable(), pod_create_requested_at: z.date().nullable(),
  phase: z.enum(['creating', 'ready', 'stopping', 'stopped']), created_at: z.date(), stop_proof: z.unknown().nullable() })
type Instance = z.infer<typeof instance>
const resource = z.object({ metadata: z.object({ uid: z.string().min(1), resourceVersion: z.string().min(1),
  labels: z.record(z.string(), z.string()).optional(), deletionTimestamp: z.string().optional(),
  finalizers: z.array(z.string()).optional() }).loose(),
  status: z.object({ phase: z.string().optional(), containerStatuses: z.array(z.object({
    state: z.object({ terminated: z.object({ finishedAt: z.string().min(1) }).loose().optional() }).loose(),
  }).loose()).optional() }).loose().optional() }).loose()
const secret = z.object({ metadata: resource.shape.metadata, data: z.object({ 'runtime-token': z.string().min(1) }).loose() }).loose()
const ready = z.object({ runtimeUserId: accountUserId, runtimeId: z.uuid(), generation: z.number().int().positive() }).loose()
const podConfiguration = z.object({ spec: z.object({ runtimeClassName: z.string(),
  containers: z.array(z.object({ name: z.literal('native-runtime'), image: z.string() }).loose()).length(1) }).loose() }).loose()
const FINALIZER = 'power-evolve.io/native-runtime-stop'

/** Load a private deployment file before any account process is allocated.
 * @param path Explicit operator file; empty disables the pool.
 * @returns Validated configuration, or null when intentionally disabled.
 */
export async function loadNativeRuntimePoolConfig(path: string): Promise<NativeRuntimePoolConfig | null> {
  return path ? configuration.parse(JSON.parse(await readFile(path, 'utf8'))) : null
}

/** Bind an instance to the complete validated operator deployment, independent of JSON key order.
 * @param input Operator configuration containing paths and resource bounds, with runtime bearers issued separately.
 * @returns SHA-256 of canonical deployment JSON for durable generation fencing.
 */
export function nativeRuntimePoolConfigDigest(input: NativeRuntimePoolConfig): string {
  return digest(JSON.stringify(configuration.parse(input), (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  }))
}

/** One account has at most one live process; uncertain allocation and stop retain their exact identities. */
export class NativeRuntimePool {
  private readonly pending = new Set<Promise<unknown>>()
  private closing = false
  private closed: Promise<void> | undefined
  private readonly authority: NativeRuntimeAuthority
  private readonly configDigest: string
  private readonly config: NativeRuntimePoolConfig

  constructor(private readonly database: Pool, private readonly lockPool: Pool, private readonly kube: KubernetesClient,
    config: NativeRuntimePoolConfig) {
    this.authority = new NativeRuntimeAuthority(database)
    this.config = configuration.parse(config)
    this.configDigest = nativeRuntimePoolConfigDigest(this.config)
  }

  /** Resolve one current account process without returning Kubernetes or process credentials.
   * @param userId Browser-authenticated account selected by Platform.
   * @returns Exact ready instance and internal service name.
   */
  ensure(userId: UserId): Promise<{ runtimeId: string; generation: number; service: string }> {
    if (this.closing) return Promise.reject(new PlatformError(503, 'native_runtime_closing'))
    const work = this.withAccount(userId, async () => {
      let current = await this.current(userId)
      if (current) {
        if (current.phase === 'stopping') {
          await this.stopLocked(current)
          throw new PlatformError(503, 'native_runtime_stopping')
        }
        if (current.config_digest !== this.configDigest) {
          await this.markStopping(current)
          await this.stopLocked(current)
          current = null
        }
      }
      if (current) {
        try {
          const credentials = await this.credentials(current)
          await this.authority.authenticate(credentials.token, { userId, runtimeId: current.runtime_id })
          if (current.phase === 'creating') current = await this.createPod(current)
          await this.waitReady(current, credentials.token)
          return this.publicInstance(current)
        } catch (error) {
          // A transport failure preserves this generation; only an invalid credential retires it.
          if (!(error instanceof PlatformError) || error.code !== 'unauthorized_runtime') throw error
          await this.markStopping(current)
          await this.stopLocked(current)
          current = null
        }
      }
      const { runtimeId, next } = await transaction(this.database, async client => {
        await client.query('SELECT pg_advisory_xact_lock(72819545)')
        const count = await client.query<{ count: string }>(
          "SELECT count(*) FROM pe_native_runtime_instances WHERE phase<>'stopped'")
        if (Number(count.rows[0]?.count) >= this.config.maxAccounts) throw new PlatformError(429, 'native_runtime_capacity')
        const generation = await client.query<{ generation: number }>(`SELECT COALESCE(max(generation),0)+1 AS generation
          FROM (SELECT generation FROM pe_runtime_credentials WHERE user_id=$1
            UNION ALL SELECT generation FROM pe_native_runtime_instances WHERE user_id=$1) previous`, [userId])
        const runtimeId = randomUUID(), next = generation.rows[0]?.generation
        if (!next) throw new PlatformError(503, 'native_runtime_generation_unavailable')
        await client.query(`INSERT INTO pe_native_runtime_instances(runtime_id,user_id,generation,namespace,config_digest,phase)
          VALUES($1,$2,$3,$4,$5,'creating')`, [runtimeId, userId, next, this.config.namespace, this.configDigest])
        return { runtimeId, next }
      })
      current = await this.current(userId)
      if (!current) throw new PlatformError(503, 'native_runtime_allocation_unavailable')
      const credential = await this.authority.issue({ userId, runtimeId, generation: next,
        lifetimeMs: this.config.credentialLifetimeMs })
      await this.database.query('UPDATE pe_native_runtime_instances SET credential_id=$2 WHERE runtime_id=$1',
        [runtimeId, credential.credentialId])
      current = { ...current, credential_id: credential.credentialId }
      const name = this.name(current)
      await this.kube.call('POST', this.kube.resourcePath(current.namespace, 'secrets'), {
        apiVersion: 'v1', kind: 'Secret', metadata: { name, labels: this.labels(current) }, type: 'Opaque',
        stringData: { 'runtime-token': credential.token, 'deployment.json': JSON.stringify(this.deployment(current)) },
      })
      current = await this.createPod(current)
      await this.waitReady(current, credential.token)
      return this.publicInstance(current)
    })
    return this.track(work)
  }

  /** Invoke the complete native RPC using only the original browser credential and its account process.
   * @param userId Platform-authenticated account.
   * @param browserToken Original Agent bearer, checked again by the selected process.
   * @param request Native client envelope.
   * @returns Bounded original native response, with no method-specific adaptation.
   */
  invoke(userId: UserId, browserToken: string, request: unknown): Promise<unknown> {
    if (this.closing) return Promise.reject(new PlatformError(503, 'native_runtime_closing'))
    return this.track(this.invokeOwned(userId, browserToken, request))
  }

  private async invokeOwned(userId: UserId, browserToken: string, request: unknown): Promise<unknown> {
    const selected = await this.ensure(userId)
    const current = await this.current(userId)
    if (!current || current.runtime_id !== selected.runtimeId) throw new PlatformError(409, 'native_runtime_replaced')
    const credentials = await this.credentials(current)
    return this.kube.call('POST', this.kube.proxyPath(current.namespace, selected.service, '/native/runtime/invoke'),
      request, this.config.requestTimeoutMs, credentials.token, this.config.maxResponseBytes,
      { 'x-power-evolve-browser-token': browserToken, origin: this.config.deployment.hostOrigin })
  }

  /** Supply a credentialed service-proxy address only to the Platform-owned upgrade transport.
   * @param userId Platform-authenticated account.
   * @returns Internal path and per-account process token; never returned over HTTP.
   */
  streamTarget(userId: UserId): Promise<{ path: string; token: string }> {
    if (this.closing) return Promise.reject(new PlatformError(503, 'native_runtime_closing'))
    return this.track(this.streamTargetOwned(userId))
  }

  private async streamTargetOwned(userId: UserId): Promise<{ path: string; token: string }> {
    const selected = await this.ensure(userId), current = await this.current(userId)
    if (!current || current.runtime_id !== selected.runtimeId) throw new PlatformError(409, 'native_runtime_replaced')
    const credentials = await this.credentials(current)
    return { path: this.kube.proxyPath(current.namespace, selected.service, '/native/api/remote.mux'), token: credentials.token }
  }

  /** Observe original Pod identities and retire failed, revoked, expired or disabled account processes.
   * @returns Completion of this bounded observation pass.
   */
  reconcile(): Promise<void> {
    if (this.closing) return Promise.reject(new PlatformError(503, 'native_runtime_closing'))
    return this.track(this.reconcileOwned())
  }

  private async reconcileOwned(): Promise<void> {
    const rows = await this.database.query("SELECT * FROM pe_native_runtime_instances WHERE phase<>'stopped' ORDER BY created_at,runtime_id")
    const errors = await this.settleAccounts(rows.rows, async row => {
      const observed = await this.database.query(`SELECT r.*,
        (r.phase='stopping' OR c.id IS NULL OR c.revoked_at IS NOT NULL
          OR c.expires_at<=clock_timestamp() OR c.credential_version<>u.credential_version
          OR NOT u.enabled OR u.deleted_at IS NOT NULL) AS retire
        FROM pe_native_runtime_instances r
        LEFT JOIN pe_runtime_credentials c ON c.id=r.credential_id LEFT JOIN pe_users u ON u.id=r.user_id
        WHERE r.runtime_id=$1 AND r.phase<>'stopped'`, [row.runtime_id])
      const latest = observed.rows[0]
      if (!latest) return
      const current = instance.parse(latest)
      if (!z.object({ retire: z.boolean() }).parse(latest).retire) {
        if (!current.pod_uid && !current.pod_create_requested_at) return
        let pod: z.infer<typeof resource>
        try {
          pod = resource.parse(await this.kube.call('GET', this.kube.resourcePath(current.namespace, 'pods', this.name(current)),
            undefined, this.config.requestTimeoutMs))
        } catch (error) {
          if (!(error instanceof KubernetesError) || error.status !== 404) throw error
          await this.markStopping(current)
          await this.stopLocked(current)
          return
        }
        this.assertLabels(pod.metadata.labels, current)
        if (current.pod_uid && pod.metadata.uid !== current.pod_uid) {
          await this.markStopping(current)
          throw new PlatformError(409, 'native_runtime_pod_replaced')
        }
        if (!pod.metadata.deletionTimestamp && pod.status?.phase !== 'Failed' && pod.status?.phase !== 'Succeeded') return
      }
      await this.markStopping(current); await this.stopLocked(current)
    })
    if (errors.length) throw new AggregateError(errors, 'Native runtime reconciliation failed')
  }

  /** Join accepted operations, revoke credentials and physically stop every owned tenant process.
   * @returns Completion after exact stop evidence and owned resource cleanup; unconfirmed stops reject.
   */
  close(): Promise<void> {
    this.closing = true
    return this.closed ??= this.drain()
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([...this.pending])
    const rows = await this.database.query("SELECT * FROM pe_native_runtime_instances WHERE phase<>'stopped'")
    const errors = await this.settleAccounts(rows.rows, async row => { await this.markStopping(row); await this.stopLocked(row) })
    if (errors.length) throw new AggregateError(errors, 'Native runtime drain failed')
  }

  private async settleAccounts(rows: unknown[], work: (row: Instance) => Promise<void>): Promise<unknown[]> {
    const queue = rows.values(), errors: unknown[] = []
    await Promise.all(Array.from({ length: Math.min(rows.length, this.config.lockConnections) }, async () => {
      for (;;) {
        const next = queue.next()
        if (next.done) return
        try {
          const row = instance.parse(next.value)
          await this.withAccount(row.user_id, () => work(row))
        } catch (error) { errors.push(error) }
      }
    }))
    return errors
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work)).catch(() => { /* The original caller owns the failure. */ })
    return work
  }

  private async withAccount<T>(userId: UserId, work: () => Promise<T>): Promise<T> {
    const client = await this.lockPool.connect()
    let locked = false
    try {
      await client.query('SELECT pg_advisory_lock(72819544,hashtext($1))', [userId]); locked = true
      return await work()
    } finally {
      let disconnected = false
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(72819544,hashtext($1))', [userId]) }
        catch (_disconnected) { disconnected = true }
      }
      client.release(disconnected)
    }
  }

  private async current(userId: UserId): Promise<Instance | null> {
    const result = await this.database.query("SELECT * FROM pe_native_runtime_instances WHERE user_id=$1 AND phase<>'stopped'", [userId])
    return result.rows[0] ? instance.parse(result.rows[0]) : null
  }

  private name(row: Instance): string { return `pe-runtime-${row.runtime_id}` }
  private labels(row: Instance): Record<string, string> {
    return { 'power-evolve.io/runtime': row.runtime_id, 'power-evolve.io/user': row.user_id }
  }
  private publicInstance(row: Instance): { runtimeId: string; generation: number; service: string } {
    return { runtimeId: row.runtime_id, generation: row.generation, service: this.name(row) }
  }
  private deployment(row: Instance): z.infer<typeof template> {
    const value = structuredClone(this.config.deployment), role = value.rows['native-runtime']
    if (!role) throw new Error('Native runtime deployment requires its named Profile rows')
    value.privateDir = '/runtime/private'; value.dshHome = '/runtime/state/dsh'
    value.runtimeIdentity = { userId: row.user_id, runtimeId: row.runtime_id, generation: row.generation }
    role['power-evolve-runtime'] = { ...role['power-evolve-runtime'], workerId: row.runtime_id,
      runtimeUserId: row.user_id, runtimeTokenFile: '/runtime/private/runtime-token', workerTokenFile: '',
      platformUrl: value.platformInternalUrl }
    role['power-evolve-host'] = { ...role['power-evolve-host'], origin: value.hostOrigin,
      platformOrigin: value.platformOrigin, nativeShellEnabled: false }
    role['webserver'] = { ...role['webserver'], host: '0.0.0.0', port: 8080 }
    return value
  }

  private async credentials(row: Instance): Promise<{ token: string }> {
    let raw: unknown
    try { raw = await this.kube.call('GET', this.kube.resourcePath(row.namespace, 'secrets', this.name(row))) }
    catch (error) {
      if (error instanceof KubernetesError && error.status === 404) throw new PlatformError(401, 'unauthorized_runtime')
      throw error
    }
    const value = secret.parse(raw)
    this.assertLabels(value.metadata.labels, row)
    const token = Buffer.from(value.data['runtime-token'], 'base64').toString('utf8')
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('Native runtime credential file invalid')
    return { token }
  }

  private assertLabels(labels: Record<string, string> | undefined, row: Instance): void {
    if (labels?.['power-evolve.io/runtime'] !== row.runtime_id || labels['power-evolve.io/user'] !== row.user_id) {
      throw new PlatformError(409, 'native_runtime_resource_owner_mismatch')
    }
  }

  private async createPod(row: Instance): Promise<Instance> {
    await this.prepareStateDirectory(row.user_id)
    const name = this.name(row), labels = this.labels(row)
    const podPath = this.kube.resourcePath(row.namespace, 'pods', name)
    const podTemplate = {
      apiVersion: 'v1', kind: 'Pod', metadata: { name, labels, finalizers: [FINALIZER] }, spec: {
        automountServiceAccountToken: false, runtimeClassName: this.config.runtimeClass, restartPolicy: 'Never',
        activeDeadlineSeconds: this.config.maxRuntimeSeconds, terminationGracePeriodSeconds: 15,
        securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, runAsNonRoot: true,
          seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'native-runtime', image: this.config.image, imagePullPolicy: 'IfNotPresent',
          args: ['native-runtime', '/runtime/private/deployment.json'],
          env: [{ name: 'NODE_ENV', value: 'production' }], ports: [{ name: 'http', containerPort: 8080 }],
          securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
          resources: this.config.resources,
          volumeMounts: [{ name: 'private', mountPath: '/runtime/private', readOnly: true },
            { name: 'state', mountPath: '/runtime/state', subPath: `${this.config.storageSubPath}/${row.user_id}/.native-runtime` },
            { name: 'tmp', mountPath: '/tmp' }],
        }], volumes: [{ name: 'private', secret: { secretName: name, defaultMode: 0o440 } },
          { name: 'state', persistentVolumeClaim: { claimName: this.config.volumeClaimName } },
          { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '128Mi' } }],
      },
    }
    let pod: z.infer<typeof resource>
    if (row.pod_uid || row.pod_create_requested_at) {
      try { pod = resource.parse(await this.kube.call('GET', podPath)) }
      catch (error) {
        if (error instanceof KubernetesError && error.status === 404) {
          await this.markStopping(row)
          throw new PlatformError(503, 'native_runtime_stop_proof_unavailable')
        }
        throw error
      }
    } else {
      const requested = await this.database.query<{ pod_create_requested_at: Date }>(
        `UPDATE pe_native_runtime_instances SET pod_create_requested_at=clock_timestamp()
         WHERE runtime_id=$1 AND pod_create_requested_at IS NULL RETURNING pod_create_requested_at`, [row.runtime_id])
      const intent = requested.rows[0]
      if (!intent) throw new PlatformError(409, 'native_runtime_pod_intent_changed')
      row = { ...row, pod_create_requested_at: intent.pod_create_requested_at }
      try { pod = resource.parse(await this.kube.call('POST', this.kube.resourcePath(row.namespace, 'pods'), podTemplate)) }
      catch (_podCreateOutcomeUnknown) {
        try { pod = resource.parse(await this.kube.call('GET', podPath)) }
        catch (readError) {
          if (readError instanceof KubernetesError && readError.status === 404) {
            await this.markStopping(row)
            throw new PlatformError(503, 'native_runtime_stop_proof_unavailable')
          }
          throw readError
        }
      }
    }
    this.assertLabels(pod.metadata.labels, row)
    this.assertPodConfiguration(pod)
    if (row.pod_uid && pod.metadata.uid !== row.pod_uid) throw new PlatformError(409, 'native_runtime_pod_replaced')
    if (!pod.metadata.finalizers?.includes(FINALIZER)) throw new PlatformError(409, 'native_runtime_stop_finalizer_missing')
    await this.database.query('UPDATE pe_native_runtime_instances SET pod_uid=$2 WHERE runtime_id=$1 AND pod_uid IS NULL',
      [row.runtime_id, pod.metadata.uid])
    const service = await this.createOrRead('services', row, {
      apiVersion: 'v1', kind: 'Service', metadata: { name, labels },
      spec: { selector: labels, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] },
    })
    this.assertLabels(service.metadata.labels, row)
    return { ...row, pod_uid: pod.metadata.uid }
  }

  private assertPodConfiguration(pod: unknown): void {
    const parsed = podConfiguration.parse(pod)
    if (parsed.spec.runtimeClassName !== this.config.runtimeClass || parsed.spec.containers[0]?.image !== this.config.image) {
      throw new PlatformError(409, 'native_runtime_pod_configuration_mismatch')
    }
  }

  private async prepareStateDirectory(userId: UserId): Promise<void> {
    const root = this.config.localStateRoot
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) {
      throw new Error('Native runtime state root must be a canonical directory')
    }
    for (const path of [resolve(root, userId), resolve(root, userId, '.native-runtime')]) {
      try { await mkdir(path, { mode: 0o700 }) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
        throw new Error('Native runtime account state must be a canonical directory')
      }
    }
  }

  private async createOrRead(kind: 'services', row: Instance, value: unknown): Promise<z.infer<typeof resource>> {
    try { return resource.parse(await this.kube.call('POST', this.kube.resourcePath(row.namespace, kind), value)) }
    catch (error) {
      try { return resource.parse(await this.kube.call('GET', this.kube.resourcePath(row.namespace, kind, this.name(row)))) }
      catch (readError) {
        if (readError instanceof KubernetesError && readError.status === 404) throw error
        throw readError
      }
    }
  }

  private async waitReady(row: Instance, token: string): Promise<void> {
    const deadline = Date.now() + this.config.readyTimeoutMs
    while (Date.now() < deadline) {
      const pod = resource.parse(await this.kube.call('GET', this.kube.resourcePath(row.namespace, 'pods', this.name(row))))
      this.assertLabels(pod.metadata.labels, row)
      this.assertPodConfiguration(pod)
      if (row.pod_uid && pod.metadata.uid !== row.pod_uid) throw new PlatformError(409, 'native_runtime_pod_replaced')
      if (!pod.metadata.finalizers?.includes(FINALIZER)) throw new PlatformError(409, 'native_runtime_stop_finalizer_missing')
      if (pod.metadata.deletionTimestamp || ['Failed', 'Succeeded'].includes(pod.status?.phase ?? '')) {
        throw new PlatformError(503, 'native_runtime_process_stopped')
      }
      try {
        const response = ready.parse(await this.kube.call('GET', this.kube.proxyPath(row.namespace,
          this.name(row), '/native/runtime/ready'), undefined, this.config.requestTimeoutMs, token))
        if (response.runtimeUserId !== row.user_id || response.runtimeId !== row.runtime_id || response.generation !== row.generation) {
          throw new PlatformError(409, 'native_runtime_identity_mismatch')
        }
        await this.database.query("UPDATE pe_native_runtime_instances SET phase='ready' WHERE runtime_id=$1 AND phase='creating'",
          [row.runtime_id])
        return
      } catch (error) {
        if (!(error instanceof KubernetesError) || ![502, 503, 504].includes(error.status)) throw error
      }
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(this.config.reconcileMs, deadline - Date.now())))
    }
    throw new PlatformError(503, 'native_runtime_ready_timeout')
  }

  private async markStopping(row: Instance): Promise<void> {
    await this.database.query(`UPDATE pe_runtime_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp())
      WHERE runtime_id=$1 AND user_id=$2 AND generation=$3`, [row.runtime_id, row.user_id, row.generation])
    await this.database.query("UPDATE pe_native_runtime_instances SET phase='stopping' WHERE runtime_id=$1 AND phase<>'stopped'", [row.runtime_id])
  }

  private async stopLocked(row: Instance): Promise<void> {
    const latest = await this.database.query('SELECT * FROM pe_native_runtime_instances WHERE runtime_id=$1 AND user_id=$2',
      [row.runtime_id, row.user_id])
    if (!latest.rows[0]) throw new PlatformError(409, 'native_runtime_instance_missing')
    row = instance.parse(latest.rows[0])
    if (row.phase === 'stopped') return
    const name = this.name(row), path = this.kube.resourcePath(row.namespace, 'pods', name)
    let proof: z.infer<typeof resource> | null = row.stop_proof === null ? null : resource.parse(row.stop_proof)
    if (proof) {
      this.assertLabels(proof.metadata.labels, row)
      if (!row.pod_uid || proof.metadata.uid !== row.pod_uid || !nativeRuntimePodStopStatus(proof, row.pod_uid, 15)) {
        throw new PlatformError(503, 'native_runtime_stop_proof_unavailable')
      }
    }
    let observed: z.infer<typeof resource> | null
    try { observed = resource.parse(await this.kube.call('GET', path)) }
    catch (error) {
      if (!(error instanceof KubernetesError) || error.status !== 404) throw error
      if ((row.pod_uid || row.pod_create_requested_at) && !proof) throw new PlatformError(503, 'native_runtime_stop_proof_unavailable')
      observed = null
    }
    if (observed) {
      this.assertLabels(observed.metadata.labels, row)
      if (row.pod_uid && observed.metadata.uid !== row.pod_uid) throw new PlatformError(409, 'native_runtime_pod_replaced')
      const uid = observed.metadata.uid
      await this.database.query('UPDATE pe_native_runtime_instances SET pod_uid=$2 WHERE runtime_id=$1 AND pod_uid IS NULL', [row.runtime_id, uid])
      if (!proof) {
        if (!observed.metadata.finalizers?.includes(FINALIZER)) throw new PlatformError(503, 'native_runtime_stop_finalizer_missing')
        if (!observed.metadata.deletionTimestamp) await this.kube.call('DELETE', path, {
          apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid }, gracePeriodSeconds: 15 })
        const deadline = Date.now() + this.config.stopTimeoutMs
        for (;;) {
          observed = resource.parse(await this.kube.call('GET', path))
          this.assertLabels(observed.metadata.labels, row)
          if (observed.metadata.uid !== uid) throw new PlatformError(409, 'native_runtime_pod_replaced')
          if (!observed.metadata.finalizers?.includes(FINALIZER)) throw new PlatformError(503, 'native_runtime_stop_finalizer_missing')
          if (nativeRuntimePodStopStatus(observed, uid, 15)) break
          if (Date.now() >= deadline) throw new PlatformError(503, 'native_runtime_stop_proof_pending')
          await new Promise<void>(resolve => setTimeout(resolve, this.config.reconcileMs))
        }
        proof = observed
        await this.database.query(`UPDATE pe_native_runtime_instances SET stop_proof=$2::jsonb,stopped_at=clock_timestamp()
          WHERE runtime_id=$1 AND pod_uid=$3 AND stop_proof IS NULL`, [row.runtime_id, JSON.stringify(proof), uid])
      }
      if (observed.metadata.finalizers?.includes(FINALIZER)) await this.kube.call('PATCH', path, {
        metadata: { uid, resourceVersion: observed.metadata.resourceVersion,
          finalizers: observed.metadata.finalizers.filter(value => value !== FINALIZER) } })
    }
    for (const kind of ['services', 'secrets'] as const) {
      const target = this.kube.resourcePath(row.namespace, kind, name)
      try {
        const owned = resource.parse(await this.kube.call('GET', target)); this.assertLabels(owned.metadata.labels, row)
        await this.kube.call('DELETE', target, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: owned.metadata.uid } })
      } catch (error) { if (!(error instanceof KubernetesError) || error.status !== 404) throw error }
    }
    await this.database.query("UPDATE pe_native_runtime_instances SET phase='stopped',stopped_at=COALESCE(stopped_at,clock_timestamp()) WHERE runtime_id=$1", [row.runtime_id])
  }
}
