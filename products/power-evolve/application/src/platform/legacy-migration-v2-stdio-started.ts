/** Original fixed STDIO started closure requires the dispatched Runner result and the same actually stopped Pod. */
import { z } from 'zod'
import { LegacyImportError, legacyDigest } from './legacy-import-codec.ts'
import { legacyTimestamp, type LegacyPlannedRow } from './legacy-import-preflight.ts'
import { kubernetesPodStopStatus } from './pod-stop-status.ts'

const uuid = z.uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/u)
const identity = { callId: uuid, instanceId: uuid, digest }
const status = z.discriminatedUnion('state', [
  z.object({ ...identity, state: z.literal('succeeded'),
    result: z.object({ kind: z.literal('mcp.stdio.whoami'), text: z.string().max(8192) }).strict() }).strict(),
  z.object({ ...identity, state: z.literal('failed'), errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u) }).strict(),
])
/** Protected original dispatch, result, independent live probes and native Pod cleanup observations. */
export const legacyMigrationStdioStartedRequest = z.object({ userId: uuid, callId: uuid, sourceRowSha256: digest,
  namespace: z.string().min(1).max(63), namespaceUid: uuid, image: z.string().regex(/@sha256:[a-f0-9]{64}$/u),
  runtimeClassName: z.string().min(1).max(63), handle: z.object({ callId: uuid, podUid: uuid, instanceId: uuid }).strict(),
  preparedAt: z.string(), stoppedAt: z.string(), readyHealth: z.object({ ready: z.literal(true), instanceId: uuid }).strict(),
  podReady: z.record(z.string(), z.unknown()), podStopped: z.record(z.string(), z.unknown()),
  dispatch: z.object({ observedAt: z.string(), request: z.object({ kind: z.literal('mcp.stdio.whoami'),
    callId: uuid, instanceId: uuid, accountId: uuid, timeoutMs: z.literal(15000), maxOutputBytes: z.literal(8192), digest }).strict(),
  response: z.object({ callId: uuid, instanceId: uuid, digest, state: z.enum(['running', 'succeeded', 'failed']) }).loose() }).strict(),
  terminal: z.object({ observedAt: z.string(), status }).strict(),
  uncertainty: z.object({ observedAt: z.string(), observation: z.object({ state: z.literal('uncertain'),
    reason: z.literal('dispatch_result_unknown') }).strict() }).strict().optional(),
  probes: z.array(z.object({ observedAt: z.string(), serviceUid: uuid, ip: z.ipv4(), port: z.literal(8080),
    healthy: z.literal(true) }).strict()).min(3),
  observations: z.array(z.object({ method: z.enum(['GET', 'DELETE']),
    kind: z.enum(['pods', 'services', 'secrets', 'networkpolicies']), name: z.string().min(1).max(63),
    status: z.union([z.literal(200), z.literal(404)]), observedAt: z.string() }).strict()).min(8),
}).strict()
const pod = z.object({ metadata: z.object({ name: z.string(), namespace: z.string(), uid: uuid,
  labels: z.record(z.string(), z.string()), deletionTimestamp: z.string().optional() }).loose(),
spec: z.object({ runtimeClassName: z.string(), automountServiceAccountToken: z.literal(false),
  restartPolicy: z.literal('Never'), enableServiceLinks: z.literal(false),
  containers: z.tuple([z.object({ name: z.literal('runner'), image: z.string(),
    securityContext: z.object({ allowPrivilegeEscalation: z.literal(false), readOnlyRootFilesystem: z.literal(true),
      runAsNonRoot: z.literal(true), runAsUser: z.literal(10001), runAsGroup: z.literal(10001),
      capabilities: z.object({ drop: z.tuple([z.literal('ALL')]) }).strict() }).strict() }).loose()]),
}).loose(), status: z.object({ phase: z.string(), containerStatuses: z.tuple([z.object({ name: z.literal('runner'),
  restartCount: z.literal(0), ready: z.boolean(), imageID: z.string(), containerID: z.string() }).loose()]) }).loose(),
}).loose()
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value
function fail(code: string): never { throw new LegacyImportError(code) }

/** Validate one original terminal fixed STDIO call without creating dispatch or worker authority.
 * @param row Exact retained original call row.
 * @param proof Protected actual original SDK dispatch, result and Kubernetes lifecycle observations.
 * @param cut Authenticated stopped-source timestamp.
 * @returns Completion only when the same Runner and Pod produced the result and completed native cleanup.
 */
export function validateLegacyMigrationStdioStarted(row: LegacyPlannedRow,
  proof: z.infer<typeof legacyMigrationStdioStartedRequest>, cut: string): void {
  const value = row.values, handle = proof.handle, request = proof.dispatch.request, result = proof.terminal.status
  if (!['succeeded', 'failed', 'uncertain'].includes(value.state ?? '') || value.cleanup_complete !== 'true' || !/^[1-9]\d*$/u.test(value.lease_epoch ?? '')
    || value.lease_owner !== null || value.lease_until !== null || value.pod_uid !== handle.podUid
    || value.runner_instance_id !== handle.instanceId || value.dispatch_digest !== request.digest
    || handle.callId !== value.id || request.callId !== value.id || request.instanceId !== handle.instanceId
    || request.accountId !== value.user_id || proof.readyHealth.instanceId !== handle.instanceId
    || proof.dispatch.response.callId !== value.id || proof.dispatch.response.instanceId !== handle.instanceId
    || proof.dispatch.response.digest !== request.digest || result.callId !== value.id
    || result.instanceId !== handle.instanceId || result.digest !== request.digest) {
    fail('migration_stdio_call_original_started_identity')
  }
  if (result.state === 'succeeded' && result.result.text !== `user:${value.user_id}`
    || value.state === 'succeeded' && (result.state !== 'succeeded' || value.result !== result.result.text || value.error_code !== null)
    || value.state === 'failed' && (result.state !== 'failed' || value.result !== null || value.error_code !== result.errorCode)
    || value.state === 'uncertain' && (value.result !== null || value.error_code !== 'dispatch_result_unknown' || !proof.uncertainty)
    || value.state !== 'uncertain' && proof.uncertainty !== undefined) fail('migration_stdio_call_original_started_outcome')
  const ready = pod.parse(proof.podReady), stopped = pod.parse(proof.podStopped)
  const name = `pe-mcp-${proof.callId.replaceAll('-', '')}`
  const expectedLabels = { 'app.kubernetes.io/name': 'power-evolve-connector-runner', 'powerevolve.dev/stdio-call': proof.callId }
  const equal = (left: unknown, right: unknown) =>
    legacyDigest(JSON.stringify(canonical(left))) === legacyDigest(JSON.stringify(canonical(right)))
  if ([ready, stopped].some(item => item.metadata.name !== name || item.metadata.namespace !== proof.namespace
    || item.metadata.uid !== handle.podUid || !equal(item.metadata.labels, expectedLabels)
    || item.spec.runtimeClassName !== proof.runtimeClassName || item.spec.containers[0].image !== proof.image)
    || ready.metadata.deletionTimestamp !== undefined || ready.status.phase !== 'Running'
    || !ready.status.containerStatuses[0].ready || !equal(ready.spec, stopped.spec)
    || stopped.status.containerStatuses[0].containerID !== ready.status.containerStatuses[0].containerID
    || stopped.status.containerStatuses[0].imageID !== ready.status.containerStatuses[0].imageID
    || kubernetesPodStopStatus(proof.podStopped) !== 'KUBELET_STOPPED') {
    fail('migration_stdio_call_original_started_stop')
  }
  // Native deletionTimestamp is the grace deadline; a Kubelet stop can precede that deadline.
  const createdAt = legacyTimestamp(value.created_at ?? ''), preparedAt = legacyTimestamp(proof.preparedAt)
  const dispatchedAt = legacyTimestamp(proof.dispatch.observedAt), resultAt = legacyTimestamp(proof.terminal.observedAt)
  const settledAt = legacyTimestamp(value.updated_at ?? ''), stoppedAt = legacyTimestamp(proof.stoppedAt), cutAt = legacyTimestamp(cut)
  const outcomeTimes = value.state === 'uncertain'
    ? [legacyTimestamp(proof.uncertainty?.observedAt ?? ''), settledAt, resultAt] : [resultAt, settledAt]
  const timeline = [createdAt, preparedAt, dispatchedAt, ...outcomeTimes, stoppedAt, cutAt]
  const firstProbe = proof.probes[0]
  if (!firstProbe) fail('migration_stdio_call_original_started_timeline')
  if (timeline.some((time, index) => time < (timeline[index - 1] ?? time))
    || legacyTimestamp(stopped.metadata.deletionTimestamp ?? '') < settledAt
    || legacyTimestamp(stopped.metadata.deletionTimestamp ?? '') > cutAt
    || proof.probes.some(item => item.serviceUid !== firstProbe.serviceUid || item.ip !== firstProbe.ip
      || legacyTimestamp(item.observedAt) < createdAt || legacyTimestamp(item.observedAt) > cutAt)
    || !proof.probes.some(item => legacyTimestamp(item.observedAt) <= preparedAt)
    || !proof.probes.some(item => legacyTimestamp(item.observedAt) >= dispatchedAt)) {
    fail('migration_stdio_call_original_started_timeline')
  }
  if (proof.observations.some(item => item.name !== name || legacyTimestamp(item.observedAt) < settledAt
    || legacyTimestamp(item.observedAt) > cutAt)
    || ['pods', 'services', 'secrets', 'networkpolicies'].some(kind =>
      proof.observations.filter(item => item.kind === kind && item.method === 'DELETE' && item.status === 200).length !== 1
      || proof.observations.filter(item => item.kind === kind && item.method === 'GET' && item.status === 404).length < 1)
    || proof.observations.some(item => item.method === 'GET' && item.status === 404
      && legacyTimestamp(item.observedAt) < legacyTimestamp(proof.stoppedAt))
    || proof.observations.some(item => item.method === 'DELETE' && item.status === 200
      && (item.kind === 'pods' ? legacyTimestamp(item.observedAt) > legacyTimestamp(proof.stoppedAt)
        : legacyTimestamp(item.observedAt) < legacyTimestamp(proof.stoppedAt)))) {
    fail('migration_stdio_call_original_started_cleanup')
  }
}
