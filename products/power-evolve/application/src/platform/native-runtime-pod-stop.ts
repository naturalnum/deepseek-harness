/** Exact tenant Runtime stop facts include a Never Pod that completed before its first deletion generation. */
import { z } from 'zod'
import { kubernetesPodStopStatus, type KubernetesPodStopStatus } from './pod-stop-status.ts'

const time = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u)
const image = z.string().regex(/^[^\s]+@sha256:[a-f0-9]{64}$/u)
const containerId = z.string().regex(/^[a-z][a-z0-9-]*:\/\/[a-f0-9]{64}$/u)
const reason = z.string().refine(value => value !== 'NodeLost' && value !== 'ContainerStatusUnknown').optional()
const stoppedContainer = z.object({ name: z.string(), ready: z.boolean(), started: z.literal(false),
  restartCount: z.literal(0), containerID: z.union([containerId, z.literal('')]).optional(), imageID: z.string().optional(),
  lastState: z.object({}).strict().optional(), reason,
  state: z.union([z.object({ terminated: z.object({ containerID: containerId, exitCode: z.number().int().nonnegative(),
    startedAt: time, finishedAt: time, reason }).loose() }).strict(),
  z.object({ waiting: z.object({ reason }).loose() }).strict()]),
}).loose()
const completedBeforeDeletion = z.object({
  metadata: z.object({ uid: z.string().min(1), generation: z.literal(2), deletionTimestamp: time,
    deletionGracePeriodSeconds: z.number().int().nonnegative().optional(), finalizers: z.array(z.string()) }).loose(),
  spec: z.object({ restartPolicy: z.literal('Never'), nodeName: z.string().min(1),
    terminationGracePeriodSeconds: z.number().int().nonnegative(),
    containers: z.array(z.object({ name: z.literal('native-runtime'), image }).loose()).length(1),
    initContainers: z.array(z.object({ name: z.literal('prepare-private'), image }).loose()).max(1).optional(),
    ephemeralContainers: z.array(z.unknown()).length(0).optional(),
  }).loose(),
  status: z.object({ observedGeneration: z.literal(1), phase: z.enum(['Failed', 'Succeeded']), reason,
    containerStatuses: z.array(stoppedContainer).length(1), initContainerStatuses: z.array(stoppedContainer).max(1).optional(),
    ephemeralContainerStatuses: z.array(z.unknown()).length(0).optional(),
    conditions: z.array(z.object({ type: z.enum(['PodReadyToStartContainers', 'Initialized', 'Ready', 'ContainersReady',
      'PodScheduled', 'DisruptionTarget']), status: z.enum(['True', 'False']),
    observedGeneration: z.literal(1).optional(), lastTransitionTime: time.optional(), reason }).loose()).max(6),
  }).loose(),
}).loose()

/** Validate native stop without rewriting the original Kubernetes observation or relaxing shared classifiers.
 * A completed Never Runtime may retain generation-one kubelet status after the first DELETE increments
 * its metadata generation. This narrow fallback requires the sandbox and every process to have ended
 * strictly before the deletion cutoff. The sandbox-stop condition may equal that cutoff only
 * when both timestamps have whole-second precision; fractional equality remains uncertain.
 * An exit field alone never proves whole-Pod quiescence.
 * @param pod Original authenticated API observation, retained unchanged in the durable proof.
 * @param expectedUid Original immutable Pod UID, independently fenced by its owner.
 * @param maximumGraceSeconds Original controller deletion-grace ceiling.
 * @returns Positive native stop status, or null while any original stop fact remains uncertain.
 */
export function nativeRuntimePodStopStatus(pod: unknown, expectedUid: string, maximumGraceSeconds: number): KubernetesPodStopStatus {
  const identity = z.object({ metadata: z.object({ uid: z.string().min(1) }).loose() }).loose().safeParse(pod)
  if (!identity.success || identity.data.metadata.uid !== expectedUid) return null
  const ordinary = kubernetesPodStopStatus(pod)
  if (ordinary) return ordinary
  if (!Number.isSafeInteger(maximumGraceSeconds) || maximumGraceSeconds < 0) return null
  const parsed = completedBeforeDeletion.safeParse(pod)
  if (!parsed.success) return null
  const { metadata, spec, status } = parsed.data
  if (!metadata.finalizers.includes('power-evolve.io/native-runtime-stop') || spec.nodeName.length > 253
    || !spec.nodeName.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u.test(label))
    || spec.terminationGracePeriodSeconds > maximumGraceSeconds) return null
  const grace = metadata.deletionGracePeriodSeconds ?? spec.terminationGracePeriodSeconds
  if (grace > maximumGraceSeconds) return null
  const cutoff = Date.parse(metadata.deletionTimestamp) - grace * 1000
  if (!Number.isFinite(cutoff) || cutoff <= 0) return null
  const declared = [...spec.containers, ...(spec.initContainers ?? [])]
  const actual = [...status.containerStatuses, ...(status.initContainerStatuses ?? [])]
  if (actual.length !== declared.length) return null
  let latestExit = 0, failedInit = false, hasExit = false
  const seen = new Set<string>()
  for (const worker of actual) {
    const expected = declared.find(container => container.name === worker.name)
    if (!expected || seen.has(worker.name)) return null
    seen.add(worker.name)
    if ('waiting' in worker.state) {
      if (worker.name !== 'native-runtime' || worker.ready || worker.containerID !== undefined && worker.containerID !== ''
        || worker.imageID !== undefined && worker.imageID !== '' || status.phase !== 'Failed') return null
      continue
    }
    const exit = worker.state.terminated, started = Date.parse(exit.startedAt), finished = Date.parse(exit.finishedAt)
    if (!worker.containerID || exit.containerID !== worker.containerID || worker.imageID !== expected.image
      || worker.ready && !(worker.name === 'prepare-private' && exit.exitCode === 0)
      || !Number.isFinite(started) || !Number.isFinite(finished) || started <= 0 || finished < started || finished >= cutoff
      || status.phase === 'Succeeded' && exit.exitCode !== 0) return null
    if (worker.name === 'prepare-private') {
      if (expected.image !== spec.containers[0]?.image) return null
      failedInit = exit.exitCode !== 0
    }
    latestExit = Math.max(latestExit, finished); hasExit = true
  }
  const runtimeState = status.containerStatuses[0]?.state
  if (!hasExit || runtimeState && 'waiting' in runtimeState && !failedInit) return null
  const conditions = new Set<string>()
  let sandboxGone = 0, sandboxTimestamp = ''
  for (const condition of status.conditions) {
    if (conditions.has(condition.type)) return null
    conditions.add(condition.type)
    if (['PodReadyToStartContainers', 'Ready', 'ContainersReady'].includes(condition.type) && condition.status !== 'False'
      || condition.type === 'PodScheduled' && condition.status !== 'True'
      || condition.type === 'Initialized' && condition.status !== (failedInit ? 'False' : 'True')) return null
    if (condition.type === 'PodReadyToStartContainers') {
      if (condition.observedGeneration !== 1 || condition.lastTransitionTime === undefined) return null
      sandboxTimestamp = condition.lastTransitionTime
      sandboxGone = Date.parse(sandboxTimestamp)
    }
  }
  if (!['PodReadyToStartContainers', 'Ready', 'ContainersReady', 'Initialized', 'PodScheduled'].every(name => conditions.has(name))
    || !Number.isFinite(sandboxGone) || sandboxGone < latestExit || sandboxGone > cutoff
    || sandboxGone === cutoff && (sandboxTimestamp.includes('.') || metadata.deletionTimestamp.includes('.'))) return null
  return 'KUBELET_STOPPED'
}
