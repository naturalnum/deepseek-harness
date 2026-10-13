/** Native Pod deletion signals accepted as stop observations; null requires further reconciliation. */
export type KubernetesPodStopStatus = 'UNSCHEDULED_DELETING' | 'KUBELET_STOPPED' | null

const MAX_CONTAINERS_PER_KIND = 64
const MAX_TOTAL_CONTAINERS = 128
const CONTAINER_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u
const CONTAINER_ID = /^[a-z][a-z0-9-]*:\/\/[a-f0-9]{64}$/u
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u
const UNKNOWN_REASONS = new Set(['NodeLost', 'ContainerStatusUnknown'])

/** Classifies only native Pod stop signals; ownership, finalizers and durable replay belong to the caller.
 * @param pod Untrusted Kubernetes Pod observation, including its deletion timestamp, spec and container statuses.
 * @returns Confirmed native stop status, or null for incomplete or contradictory observations.
 */
export function kubernetesPodStopStatus(pod: unknown): KubernetesPodStopStatus {
  if (!record(pod) || !record(pod.metadata) || timestamp(pod.metadata.deletionTimestamp) === null
    || !record(pod.spec)) return null

  const expected = declaredContainers(pod.spec)
  if (expected === null) return null
  const status = pod.status
  if (status !== undefined && !record(status)) return null
  if (status !== undefined && unknownReason(status.reason)) return null
  const actual = containerStatuses(status, expected)
  if (actual === null) return null

  const nodeName = pod.spec.nodeName
  if (nodeName === undefined || nodeName === '') {
    if (status !== undefined && status.phase !== undefined
      && status.phase !== 'Pending' && status.phase !== 'Failed') return null
    if (hasContradictoryUnscheduledCondition(status?.conditions)) return null
    return actual.every(container => neverStarted(container)) ? 'UNSCHEDULED_DELETING' : null
  }
  if (typeof nodeName !== 'string' || !dnsSubdomain(nodeName)
    || status?.phase !== 'Succeeded' && status?.phase !== 'Failed'
    || !Number.isSafeInteger(pod.metadata.generation) || Number(pod.metadata.generation) < 1
    || !readyToStartContainersStopped(status.conditions, Number(pod.metadata.generation))
    || actual.length !== expected.size) return null

  return actual.every(container => stoppedOrNeverStarted(container, expected.get(String(container.name))))
    ? 'KUBELET_STOPPED' : null
}

function declaredContainers(spec: Readonly<Record<string, unknown>>): ReadonlyMap<string, string> | null {
  const declared = new Map<string, string>()
  for (const [kind, field] of [
    ['regular', 'containers'], ['init', 'initContainers'], ['ephemeral', 'ephemeralContainers'],
  ] as const) {
    const value = spec[field]
    if (value === undefined && kind !== 'regular') continue
    if (!Array.isArray(value) || value.length > MAX_CONTAINERS_PER_KIND
      || kind === 'regular' && value.length === 0) return null
    for (const container of value) {
      if (!record(container) || typeof container.name !== 'string'
        || !CONTAINER_NAME.test(container.name) || container.name.length > 63
        || declared.has(container.name)) return null
      declared.set(container.name, kind)
    }
  }
  return declared.size <= MAX_TOTAL_CONTAINERS ? declared : null
}

function containerStatuses(
  status: Readonly<Record<string, unknown>> | undefined,
  expected: ReadonlyMap<string, string>,
): readonly Readonly<Record<string, unknown>>[] | null {
  const seen = new Set<string>()
  const actual: Readonly<Record<string, unknown>>[] = []
  for (const [kind, field] of [
    ['regular', 'containerStatuses'], ['init', 'initContainerStatuses'],
    ['ephemeral', 'ephemeralContainerStatuses'],
  ] as const) {
    const value = status?.[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.length > MAX_CONTAINERS_PER_KIND) return null
    for (const container of value) {
      if (!record(container) || typeof container.name !== 'string'
        || expected.get(container.name) !== kind || seen.has(container.name)) return null
      seen.add(container.name)
      actual.push(container)
    }
  }
  return actual.length <= MAX_TOTAL_CONTAINERS ? actual : null
}

function readyToStartContainersStopped(conditions: unknown, generation: number): boolean {
  if (!Array.isArray(conditions) || conditions.length > 64) return false
  let count = 0
  for (const condition of conditions) {
    if (!record(condition) || typeof condition.type !== 'string'
      || unknownReason(condition.reason)) return false
    if (condition.type !== 'PodReadyToStartContainers') continue
    count += 1
    if (condition.status !== 'False' || condition.observedGeneration !== generation) return false
  }
  return count === 1
}

function hasContradictoryUnscheduledCondition(conditions: unknown): boolean {
  if (conditions === undefined) return false
  if (!Array.isArray(conditions) || conditions.length > 64) return true
  for (const condition of conditions) {
    if (!record(condition) || typeof condition.type !== 'string'
      || unknownReason(condition.reason)) return true
    if (condition.type === 'PodScheduled' && condition.status === 'True'
      || condition.type === 'PodReadyToStartContainers' && condition.status === 'True') return true
  }
  return false
}

function stoppedOrNeverStarted(container: Readonly<Record<string, unknown>>, kind: string | undefined): boolean {
  if (neverStarted(container)) return true
  const state = container.state
  // A completed ordinary init container retains Ready=true in kubelet status.
  // For regular and ephemeral containers, Ready=true is still contradictory to stop.
  if (container.started !== undefined
    && typeof container.started !== 'boolean'
    || !record(state) || Object.keys(state).length !== 1 || !record(state.terminated)
    || container.ready !== false && !(kind === 'init' && container.ready === true
      && state.terminated.exitCode === 0)
    || !validTerminated(state.terminated, container.containerID)
    || unknownReason(container.reason)) return false
  return validRestartCount(container.restartCount) && validPreviousState(container.lastState)
}

function neverStarted(container: Readonly<Record<string, unknown>>): boolean {
  if (!validRestartCount(container.restartCount) || container.restartCount !== 0
    || container.ready !== false
    || container.started !== undefined && container.started !== false
    || container.containerID !== undefined && container.containerID !== ''
    || container.imageID !== undefined && container.imageID !== ''
    || !emptyLastState(container.lastState)) return false
  const state = container.state
  return record(state) && Object.keys(state).length === 1 && record(state.waiting)
    && !unknownReason(state.waiting.reason) && !unknownReason(container.reason)
}

function validRestartCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function emptyLastState(value: unknown): boolean {
  return value === undefined || record(value) && Object.keys(value).length === 0
}

function validPreviousState(value: unknown): boolean {
  if (emptyLastState(value)) return true
  return record(value) && Object.keys(value).length === 1 && record(value.terminated)
    && validTerminated(value.terminated, value.terminated.containerID)
}

function validTerminated(value: Readonly<Record<string, unknown>>, containerID: unknown): boolean {
  if (typeof containerID !== 'string' || !CONTAINER_ID.test(containerID)
    || value.containerID !== containerID
    || !Number.isSafeInteger(value.exitCode) || Number(value.exitCode) < 0
    || unknownReason(value.reason)) return false
  const startedAt = timestamp(value.startedAt)
  const finishedAt = timestamp(value.finishedAt)
  return startedAt !== null && finishedAt !== null && finishedAt >= startedAt
}

function unknownReason(value: unknown): boolean {
  return value !== undefined && (typeof value !== 'string' || UNKNOWN_REASONS.has(value))
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dnsSubdomain(value: string): boolean {
  return value.length > 0 && value.length <= 253
    && value.split('.').every(label => label.length > 0 && label.length <= 63
      && CONTAINER_NAME.test(label))
}
