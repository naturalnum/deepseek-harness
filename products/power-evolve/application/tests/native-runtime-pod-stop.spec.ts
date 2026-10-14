/** Sanitized actual terminal-before-deletion shape; false or incomplete kubelet facts never release a Runtime. */
import { expect, test } from 'vitest'
import { nativeRuntimePodStopStatus } from '../src/platform/native-runtime-pod-stop.ts'
import { kubernetesPodStopStatus } from '../src/platform/pod-stop-status.ts'

const uid = 'original-owned-uid', image = 'fixture@sha256:' + 'a'.repeat(64), containerID = 'containerd://' + 'b'.repeat(64)
function observation() {
  return { metadata: { uid, generation: 2, deletionTimestamp: '2026-10-14T08:00:55Z', deletionGracePeriodSeconds: 0,
    finalizers: ['power-evolve.io/native-runtime-stop'] },
  spec: { restartPolicy: 'Never', nodeName: 'owned-node', terminationGracePeriodSeconds: 15,
    containers: [{ name: 'native-runtime', image }] },
  status: { observedGeneration: 1, phase: 'Failed',
    conditions: ['PodReadyToStartContainers', 'Initialized', 'Ready', 'ContainersReady', 'PodScheduled'].map(type => ({
      type, status: ['Initialized', 'PodScheduled'].includes(type) ? 'True' : 'False', observedGeneration: 1,
      lastTransitionTime: '2026-10-14T07:07:32Z' })),
    containerStatuses: [{ name: 'native-runtime', ready: false, started: false, restartCount: 0, containerID, imageID: image,
      lastState: {}, state: { terminated: { containerID, exitCode: 1, startedAt: '2026-10-14T07:07:31Z', finishedAt: '2026-10-14T07:07:31Z' } } }],
  } }
}

test('an exact Never Runtime stopped before first deletion retains its original generation-one kubelet facts', () => {
  const pod = observation(), unchanged = structuredClone(pod)
  expect(kubernetesPodStopStatus(pod)).toBeNull()
  expect(nativeRuntimePodStopStatus(pod, uid, 15)).toBe('KUBELET_STOPPED')
  expect(pod).toEqual(unchanged)
})

test('a completed ordinary private-preparation init is included in the same positive stop obligation', () => {
  const pod = observation(), initID = 'containerd://' + 'c'.repeat(64)
  const withInit = { ...pod, spec: { ...pod.spec, initContainers: [{ name: 'prepare-private', image }] },
    status: { ...pod.status, initContainerStatuses: [{ ...pod.status.containerStatuses[0], name: 'prepare-private', ready: true,
      containerID: initID, state: { terminated: { containerID: initID, exitCode: 0,
        startedAt: '2026-10-14T07:07:00Z', finishedAt: '2026-10-14T07:07:01Z' } } }] } }
  expect(nativeRuntimePodStopStatus(withInit, uid, 15)).toBe('KUBELET_STOPPED')
})

test('an exact failed init can prove stop while the native process never started', () => {
  const pod = observation(), initID = 'containerd://' + 'c'.repeat(64)
  const withInit = { ...pod, spec: { ...pod.spec, initContainers: [{ name: 'prepare-private', image }] },
    status: { ...pod.status, conditions: pod.status.conditions.map(condition => condition.type === 'Initialized' ? { ...condition, status: 'False' } : condition),
      containerStatuses: [{ name: 'native-runtime', ready: false, started: false, restartCount: 0, lastState: {},
        imageID: '', state: { waiting: { reason: 'PodInitializing' } } }],
      initContainerStatuses: [{ ...pod.status.containerStatuses[0], name: 'prepare-private', containerID: initID,
        state: { terminated: { containerID: initID, exitCode: 1, startedAt: '2026-10-14T07:07:00Z', finishedAt: '2026-10-14T07:07:01Z' } } }] } }
  expect(nativeRuntimePodStopStatus(withInit, uid, 15)).toBe('KUBELET_STOPPED')
})

for (const reason of ['NodeLost', 'ContainerStatusUnknown']) for (const field of ['pod', 'container', 'termination', 'condition'] as const)
  test(`${reason} at ${field} remains unknown despite an earlier exit`, () => {
    const pod = observation()
    const changed = field === 'pod' ? { ...pod, status: { ...pod.status, reason } }
      : field === 'container' ? { ...pod, status: { ...pod.status, containerStatuses: pod.status.containerStatuses.map(worker => ({ ...worker, reason })) } }
        : field === 'termination' ? { ...pod, status: { ...pod.status, containerStatuses: pod.status.containerStatuses.map(worker => ({ ...worker,
          state: { terminated: { ...worker.state.terminated, reason } } })) } }
          : { ...pod, status: { ...pod.status, conditions: pod.status.conditions.map(condition => ({ ...condition, reason })) } }
    expect(nativeRuntimePodStopStatus(changed, uid, 15)).toBeNull()
  })

test('changed UID, later generation, or mismatched original kubelet generation cannot borrow the exception', () => {
  const pod = observation()
  expect(nativeRuntimePodStopStatus(pod, 'replacement-uid', 15)).toBeNull()
  expect(nativeRuntimePodStopStatus({ ...pod, metadata: { ...pod.metadata, generation: 3 } }, uid, 15)).toBeNull()
  expect(nativeRuntimePodStopStatus({ ...pod, status: { ...pod.status, observedGeneration: 2 } }, uid, 15)).toBeNull()
  expect(nativeRuntimePodStopStatus({ ...pod, status: { ...pod.status,
    conditions: pod.status.conditions.map(condition => ({ ...condition, observedGeneration: 3 })) } }, uid, 15)).toBeNull()
})

test('termination during deletion or before sandbox shutdown is established remains blocked', () => {
  const pod = observation()
  const duringDelete = { ...pod, metadata: { ...pod.metadata, deletionTimestamp: '2026-10-14T07:07:32Z', deletionGracePeriodSeconds: 15 } }
  expect(nativeRuntimePodStopStatus(duringDelete, uid, 15)).toBeNull()
  expect(nativeRuntimePodStopStatus({ ...pod, status: { ...pod.status, conditions: pod.status.conditions.map(condition => ({ ...condition,
    lastTransitionTime: '2026-10-14T07:07:30Z' })) } }, uid, 15)).toBeNull()
  expect(nativeRuntimePodStopStatus({ ...pod, status: { ...pod.status, conditions: pod.status.conditions.map(condition => ({ ...condition,
    lastTransitionTime: '2026-10-14T08:00:56Z' })) } }, uid, 15)).toBeNull()
})

test('missing, duplicate, contradictory or foreign terminal conditions remain unknown', () => {
  const pod = observation(), original = pod.status.conditions
  for (const conditions of [original.slice(1), [...original, original[0]], [...original, { type: 'UnknownCondition', status: 'False', observedGeneration: 1 }],
    original.map(condition => condition.type === 'Ready' ? { ...condition, status: 'True' } : condition)]) {
    expect(nativeRuntimePodStopStatus({ ...pod, status: { ...pod.status, conditions } }, uid, 15)).toBeNull()
  }
})

test('restart, contradictory running state, changed image, missing ids or lost finalizer remain unknown', () => {
  const pod = observation(), original = pod.status.containerStatuses[0]
  if (!original) throw new Error('Fixture lost its original container')
  for (const worker of [{ ...original, restartCount: 1 }, { ...original, started: true }, { ...original, ready: true },
    { ...original, imageID: 'fixture@sha256:' + 'd'.repeat(64) }, { ...original, containerID: '' },
    { ...original, state: { ...original.state, running: {} } }]) {
    expect(nativeRuntimePodStopStatus({ ...pod, status: { ...pod.status, containerStatuses: [worker] } }, uid, 15)).toBeNull()
  }
  expect(nativeRuntimePodStopStatus({ ...pod, metadata: { ...pod.metadata, finalizers: [] } }, uid, 15)).toBeNull()
  expect(nativeRuntimePodStopStatus({ ...pod, spec: { ...pod.spec, restartPolicy: 'Always' } }, uid, 15)).toBeNull()
})

test('unexpected ephemeral or unfinished init processes never reuse completed application status', () => {
  const pod = observation()
  expect(nativeRuntimePodStopStatus({ ...pod, spec: { ...pod.spec, ephemeralContainers: [{ name: 'debug' }] } }, uid, 15)).toBeNull()
  expect(nativeRuntimePodStopStatus({ ...pod, spec: { ...pod.spec, initContainers: [{ name: 'prepare-private', image }] } }, uid, 15)).toBeNull()
})


test('a whole-second sandbox stop at deletion retains strict earlier container termination', () => {
  const pod = observation()
  pod.status.conditions[0]!.lastTransitionTime = pod.metadata.deletionTimestamp
  const unchanged = structuredClone(pod)
  expect(kubernetesPodStopStatus(pod)).toBeNull()
  expect(nativeRuntimePodStopStatus(pod, uid, 15)).toBe('KUBELET_STOPPED')
  expect(pod).toEqual(unchanged)
  pod.status.containerStatuses[0]!.state.terminated.finishedAt = pod.metadata.deletionTimestamp
  expect(nativeRuntimePodStopStatus(pod, uid, 15)).toBeNull()
})

test('sandbox stop after the cutoff or with fractional equality never borrows second precision', () => {
  for (const transition of ['2026-10-14T08:00:56Z', '2026-10-14T08:00:55.000000001Z',
    '2026-10-14T08:00:55.000Z']) {
    const pod = observation()
    pod.status.conditions[0]!.lastTransitionTime = transition
    expect(nativeRuntimePodStopStatus(pod, uid, 15)).toBeNull()
  }
  const pod = observation()
  pod.metadata.deletionTimestamp = '2026-10-14T08:00:55.000000001Z'
  pod.status.conditions[0]!.lastTransitionTime = '2026-10-14T08:00:55Z'
  expect(nativeRuntimePodStopStatus(pod, uid, 15)).toBeNull()
})
