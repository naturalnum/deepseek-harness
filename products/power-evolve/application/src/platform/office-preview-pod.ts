/** Exact, retained one-shot parser Pods; durable ownership and lease checks belong to OfficePreviewService. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { accountUserId, type UserId } from '@power-evolve/contracts/account'
import { officePreviewJobSchema, type OfficePreviewJob } from '@power-evolve/contracts/office-preview'
import { PlatformError } from '../contracts.ts'
import { KubernetesError, type KubernetesClient } from './kubernetes.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'

const FINALIZER = 'powerevolve.dev/retain-office-preview-stop'
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const name = z.string().min(1).max(63).regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u)
const relative = z.string().min(1).max(1024).refine(value => value.split('/').every(part =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) && part !== '.' && part !== '..'))
const immutableImage = z.string().max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/u)
const containerId = z.string().regex(/^[a-z][a-z0-9-]*:\/\/[a-f0-9]{64}$/u)
const timestamp = z.iso.datetime({ precision: null })

/** Fixed parser placement and resource budgets; the configured image supplies its own entrypoint. */
export interface OfficePreviewPodConfig {
  readonly namespace: string
  readonly image: string
  readonly volumeClaimName: string
  readonly volumeSubPath: string
  readonly kubernetesTimeoutMs: number
  readonly terminationGraceSeconds: number
  readonly cpuMilliCores: number
  readonly memoryMiB: number
  readonly temporaryMiB: number
}

const quantities = z.object({ cpu: z.string(), memory: z.string() }).strict()
const template = z.object({
  apiVersion: z.literal('v1'), kind: z.literal('Pod'),
  metadata: z.object({ name, namespace: name, labels: z.record(z.string(), z.string()),
    annotations: z.record(z.string(), z.string()), finalizers: z.tuple([z.literal(FINALIZER)]) }).strict(),
  spec: z.object({
    restartPolicy: z.literal('Never'), automountServiceAccountToken: z.literal(false),
    enableServiceLinks: z.literal(false), hostNetwork: z.literal(false), hostPID: z.literal(false), hostIPC: z.literal(false),
    activeDeadlineSeconds: z.number().int().positive(), terminationGracePeriodSeconds: z.number().int().nonnegative(),
    securityContext: z.object({ runAsNonRoot: z.literal(true), runAsUser: z.literal(1000),
      runAsGroup: z.literal(1000),
      seccompProfile: z.object({ type: z.literal('RuntimeDefault') }).strict() }).strict(),
    containers: z.tuple([z.object({
      name: z.literal('parser'), image: immutableImage, imagePullPolicy: z.literal('IfNotPresent'),
      env: z.tuple([z.object({ name: z.literal('HOME'), value: z.literal('/tmp') }).strict(),
        z.object({ name: z.literal('TMPDIR'), value: z.literal('/tmp') }).strict()]),
      securityContext: z.object({ allowPrivilegeEscalation: z.literal(false), privileged: z.literal(false),
        readOnlyRootFilesystem: z.literal(true), capabilities: z.object({ drop: z.tuple([z.literal('ALL')]) }).strict() }).strict(),
      resources: z.object({ requests: quantities, limits: quantities }).strict(),
      volumeMounts: z.tuple([
        z.object({ name: z.literal('preview'), mountPath: z.literal('/input'), subPath: relative, readOnly: z.literal(true) }).strict(),
        z.object({ name: z.literal('preview'), mountPath: z.literal('/output'), subPath: relative, readOnly: z.literal(false) }).strict(),
        z.object({ name: z.literal('temporary'), mountPath: z.literal('/tmp'), readOnly: z.literal(false) }).strict(),
      ]),
    }).strict()]),
    volumes: z.tuple([z.object({ name: z.literal('preview'),
      persistentVolumeClaim: z.object({ claimName: name }).strict() }).strict(),
    z.object({ name: z.literal('temporary'), emptyDir: z.object({ sizeLimit: z.string() }).strict() }).strict()]),
  }).strict(),
}).strict()

/** Frozen creation request; recovery submits neither a new name nor a replacement image. */
export const officePreviewPodIntent = z.object({
  job: officePreviewJobSchema, userId: accountUserId, template, templateDigest: digest,
  submittedAt: timestamp.nullable(),
}).strict().refine(value => hash(value.template) === value.templateDigest
  && value.template.metadata.name === `pe-op-${value.job.jobId.replaceAll('-', '')}`
  && value.template.metadata.labels['powerevolve.dev/preview-job'] === value.job.jobId
  && value.template.metadata.labels['powerevolve.dev/preview-nonce'] === value.job.nonce
  && value.template.metadata.labels['powerevolve.dev/user'] === value.userId
  && value.template.metadata.annotations['powerevolve.dev/preview-generation'] === value.job.generation)
/** Validated original Pod creation intent. */
export type OfficePreviewPodIntent = z.infer<typeof officePreviewPodIntent>
/** Captured native Pod identity; node and container identities can only advance from null. */
export const officePreviewPodIdentity = z.object({
  name, uid: z.uuid(), generation: z.number().int().positive(), nodeName: z.string().min(1).max(253).nullable(),
  containerId: containerId.nullable(), imageId: z.string().min(1).max(1024).nullable(),
}).strict()
/** Validated native identity retained across Platform recovery. */
export type OfficePreviewPodIdentity = z.infer<typeof officePreviewPodIdentity>
/** Native stop facts are stored before the retaining finalizer can be removed. */
export const officePreviewStopProof = z.object({
  status: z.enum(['UNSCHEDULED_DELETING', 'KUBELET_STOPPED']),
  jobId: officePreviewJobSchema.shape.jobId, nonce: officePreviewJobSchema.shape.nonce,
  generation: officePreviewJobSchema.shape.generation, identity: officePreviewPodIdentity,
  observedAt: timestamp,
}).strict()
/** Persisted stop observation, permanently bound to the original parser. */
export type OfficePreviewStopProof = z.infer<typeof officePreviewStopProof>

const resource = z.object({
  apiVersion: z.literal('v1'), kind: z.literal('Pod'),
  metadata: z.object({ name, namespace: name, uid: z.uuid(), resourceVersion: z.string().min(1).max(128),
    generation: z.number().int().positive(), labels: z.record(z.string(), z.string()),
    annotations: z.record(z.string(), z.string()), finalizers: z.array(z.string()).max(32).optional(),
    deletionTimestamp: timestamp.optional() }).loose(),
  spec: z.record(z.string(), z.unknown()), status: z.record(z.string(), z.unknown()).optional(),
}).loose()
/** Exact native worker termination record; unknown and missing states do not pass this parser. */
export const officePreviewWorkerExit = z.object({ containerId, imageId: z.string().min(1).max(1024), exitCode: z.number().int().nonnegative(),
  startedAt: timestamp, finishedAt: timestamp }).strict().refine(value => Date.parse(value.finishedAt) >= Date.parse(value.startedAt))
/** A worker exit is separate from native Pod stop confirmation and output validation. */
export type OfficePreviewWorkerExit = z.infer<typeof officePreviewWorkerExit>
/** Verified observation; null means missing and never establishes termination. */
export interface OfficePreviewPodObservation {
  readonly identity: OfficePreviewPodIdentity
  readonly deleting: boolean
  readonly retained: boolean
  readonly resourceVersion: string
  readonly finalizers: readonly string[]
  readonly workerExit: OfficePreviewWorkerExit | null
  readonly stopProof: OfficePreviewStopProof | null
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function hash(value: object): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** Exact parser identity or stop observations no longer match; the reservation must remain blocked. */
export class OfficePreviewPodBlocked extends PlatformError {
  constructor() { super(503, 'office_render_unavailable') }
}
function refusal(): PlatformError { return new OfficePreviewPodBlocked() }
function subset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length
    && expected.every((value, index) => subset(value, actual[index]))
  if (record(expected)) return record(actual) && Object.entries(expected).every(([key, value]) => subset(value, actual[key]))
  return expected === actual
}
function absent(value: unknown): boolean { return value === undefined || Array.isArray(value) && value.length === 0 }
function subsetExactSecurity(expected: object, actual: unknown): boolean {
  return record(actual) && canonical(expected) === canonical(actual)
}

/** One-shot Pod adapter; callers fence every infrastructure operation with their current PG lease. */
export class OfficePreviewPods {
  constructor(private readonly kube: Pick<KubernetesClient, 'call' | 'resourcePath'>,
    private readonly config: OfficePreviewPodConfig) {}

  /**
   * Build one immutable, network-policy-selected parser request with exact private PVC subpaths.
   * @param job Frozen source SHA, converter generation, creation nonce and parser limits.
   * @param userId Original authenticated source owner.
   * @returns Creation intent to persist before POST; it contains no bearer or shared root mount.
   */
  intent(job: OfficePreviewJob, userId: UserId): OfficePreviewPodIntent {
    const selected = officePreviewJobSchema.parse(job), c = this.config
    const resourceName = `pe-op-${selected.jobId.replaceAll('-', '')}`
    const cpu = c.cpuMilliCores % 1000 === 0 ? String(c.cpuMilliCores / 1000) : `${c.cpuMilliCores}m`
    const memory = c.memoryMiB % 1024 === 0 ? `${c.memoryMiB / 1024}Gi` : `${c.memoryMiB}Mi`
    const budget = { cpu, memory }, base = `${c.volumeSubPath}/${selected.jobId}`
    const body = template.parse({ apiVersion: 'v1', kind: 'Pod', metadata: {
      name: resourceName, namespace: c.namespace,
      labels: { 'app.kubernetes.io/name': 'power-evolve-office-preview', 'powerevolve.dev/preview-job': selected.jobId,
        'powerevolve.dev/preview-nonce': selected.nonce, 'powerevolve.dev/user': userId },
      annotations: { 'powerevolve.dev/preview-generation': selected.generation }, finalizers: [FINALIZER],
    }, spec: {
      restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
      hostNetwork: false, hostPID: false, hostIPC: false,
      activeDeadlineSeconds: Math.ceil(selected.limits.timeoutMs / 1000), terminationGracePeriodSeconds: c.terminationGraceSeconds,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'parser', image: c.image, imagePullPolicy: 'IfNotPresent',
        env: [{ name: 'HOME', value: '/tmp' }, { name: 'TMPDIR', value: '/tmp' }],
        securityContext: { allowPrivilegeEscalation: false, privileged: false, readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] } }, resources: { requests: budget, limits: budget },
        volumeMounts: [{ name: 'preview', mountPath: '/input', subPath: `${base}/input`, readOnly: true },
          { name: 'preview', mountPath: '/output', subPath: `${base}/output`, readOnly: false },
          { name: 'temporary', mountPath: '/tmp', readOnly: false }],
      }], volumes: [{ name: 'preview', persistentVolumeClaim: { claimName: c.volumeClaimName } },
        { name: 'temporary', emptyDir: { sizeLimit: c.temporaryMiB % 1024 === 0 ? `${c.temporaryMiB / 1024}Gi` : `${c.temporaryMiB}Mi` } }],
    } })
    return officePreviewPodIntent.parse({ job: selected, userId, template: body, templateDigest: hash(body), submittedAt: null })
  }

  /**
   * Submit only the persisted creation request; an ambiguous response must be followed by observation.
   * @param intent Original validated creation intent.
   * @returns Resolves after API acceptance; exceptions do not establish that no Pod was created.
   */
  async submit(intent: OfficePreviewPodIntent): Promise<void> {
    if (intent.submittedAt === null) throw refusal()
    await this.kube.call('POST', this.kube.resourcePath(intent.template.metadata.namespace, 'pods'),
      intent.template, this.config.kubernetesTimeoutMs)
  }

  /**
   * Observe only the intended parser and reject identity, mount, environment or safety-policy changes.
   * @param intent Original persisted creation request.
   * @param captured Previously captured native identity, if any.
   * @returns Verified original Pod facts, or null for 404; missing never means stopped.
   */
  async observe(intent: OfficePreviewPodIntent, captured?: OfficePreviewPodIdentity): Promise<OfficePreviewPodObservation | null> {
    let raw: unknown
    try { raw = await this.kube.call('GET', this.path(intent), undefined, this.config.kubernetesTimeoutMs) }
    catch (error) { if (error instanceof KubernetesError && error.status === 404) return null; throw error }
    const parsed = resource.safeParse(raw)
    if (!parsed.success) throw refusal()
    const pod = parsed.data, expected = intent.template, spec = pod.spec
    const containers = spec.containers
    const normalized = { ...spec, hostNetwork: spec.hostNetwork ?? false, hostPID: spec.hostPID ?? false,
      hostIPC: spec.hostIPC ?? false, containers: Array.isArray(containers) ? containers.map((container: unknown) =>
        record(container) ? { ...container, volumeMounts: Array.isArray(container.volumeMounts)
          ? container.volumeMounts.map((mount: unknown) => record(mount) ? { ...mount, readOnly: mount.readOnly ?? false } : mount)
          : container.volumeMounts } : container) : containers }
    if (!subset(expected.metadata.labels, pod.metadata.labels)
      || !subset(expected.metadata.annotations, pod.metadata.annotations)
      || pod.metadata.name !== expected.metadata.name || pod.metadata.namespace !== expected.metadata.namespace
      || !subset(expected.spec, normalized) || !absent(spec.initContainers) || !absent(spec.ephemeralContainers)
      || !Array.isArray(containers) || containers.length !== 1 || !record(containers[0])
      || !absent(containers[0].command) || !absent(containers[0].args) || !absent(containers[0].envFrom)
      || containers[0].lifecycle !== undefined || containers[0].workingDir !== undefined
      || containers[0].volumeDevices !== undefined || spec.hostAliases !== undefined
      || !subsetExactSecurity(expected.spec.securityContext, spec.securityContext)
      || !subsetExactSecurity(expected.spec.containers[0].securityContext, containers[0].securityContext)
      || Array.isArray(containers[0].volumeMounts) && containers[0].volumeMounts.some(mount =>
        record(mount) && (mount.subPathExpr !== undefined || mount.mountPropagation !== undefined))) throw refusal()
    const statuses = pod.status?.containerStatuses
    if (statuses !== undefined && (!Array.isArray(statuses) || statuses.length !== 1)) throw refusal()
    const worker: unknown = Array.isArray(statuses) ? statuses[0] : undefined
    if (worker !== undefined && (!record(worker) || worker.name !== 'parser' || worker.restartCount !== 0)) throw refusal()
    const identity = officePreviewPodIdentity.parse({ name: pod.metadata.name, uid: pod.metadata.uid,
      generation: pod.metadata.generation, nodeName: spec.nodeName || null,
      containerId: record(worker) && worker.containerID || null, imageId: record(worker) && worker.imageID || null })
    if (captured && (identity.name !== captured.name || identity.uid !== captured.uid || identity.generation !== captured.generation
      || captured.nodeName !== null && identity.nodeName !== captured.nodeName
      || captured.containerId !== null && identity.containerId !== captured.containerId
      || captured.imageId !== null && identity.imageId !== captured.imageId)) throw refusal()
    const state = record(worker) && record(worker.state) ? worker.state : null
    const terminated = state && record(state.terminated) ? state.terminated : null
    const exit = terminated && record(worker) ? officePreviewWorkerExit.safeParse({ containerId: worker.containerID,
      imageId: worker.imageID, exitCode: terminated.exitCode, startedAt: terminated.startedAt, finishedAt: terminated.finishedAt }) : null
    if (terminated && (!exit?.success || terminated.containerID !== identity.containerId
      || !state || Object.keys(state).length !== 1 || record(worker) && worker.ready !== false)) throw refusal()
    const status = kubernetesPodStopStatus(raw), retained = pod.metadata.finalizers?.includes(FINALIZER) ?? false
    return { identity, deleting: !!pod.metadata.deletionTimestamp, retained, resourceVersion: pod.metadata.resourceVersion,
      finalizers: pod.metadata.finalizers ?? [], workerExit: exit?.success ? exit.data : null,
      stopProof: status ? officePreviewStopProof.parse({ status, jobId: intent.job.jobId, nonce: intent.job.nonce,
        generation: intent.job.generation, identity, observedAt: new Date().toISOString() }) : null }
  }

  /**
   * Request deletion with the exact native UID; acknowledgment is not stop evidence.
   * @param intent Original creation request.
   * @param identity Captured original Pod identity.
   * @returns Resolves after the API request; 404 is an observation for recovery, not confirmation.
   */
  async delete(intent: OfficePreviewPodIntent, identity: OfficePreviewPodIdentity): Promise<void> {
    try { await this.kube.call('DELETE', this.path(intent), { apiVersion: 'v1', kind: 'DeleteOptions',
      gracePeriodSeconds: intent.template.spec.terminationGracePeriodSeconds, preconditions: { uid: identity.uid } }, this.config.kubernetesTimeoutMs) }
    catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error }
  }

  /**
   * Remove only this retained finalizer after the caller has durably stored the matching stop proof.
   * @param intent Original creation request.
   * @param observed Current verified original Pod, including resourceVersion.
   * @param proof Exact persisted native stop observation.
   * @returns Resolves after patch; loss or conflict must be reconciled by observing the same UID.
   */
  async release(intent: OfficePreviewPodIntent, observed: OfficePreviewPodObservation, proof: OfficePreviewStopProof): Promise<void> {
    if (proof.jobId !== intent.job.jobId || proof.nonce !== intent.job.nonce || proof.generation !== intent.job.generation
      || !subset(proof.identity, observed.identity) || !observed.deleting || !observed.stopProof
      || observed.stopProof.status !== proof.status) throw refusal()
    if (!observed.retained) return
    await this.kube.call('PATCH', this.path(intent), { metadata: { uid: observed.identity.uid,
      resourceVersion: observed.resourceVersion, finalizers: observed.finalizers.filter(value => value !== FINALIZER) } },
    this.config.kubernetesTimeoutMs)
  }

  private path(intent: OfficePreviewPodIntent): string {
    return this.kube.resourcePath(intent.template.metadata.namespace, 'pods', intent.template.metadata.name)
  }
}
