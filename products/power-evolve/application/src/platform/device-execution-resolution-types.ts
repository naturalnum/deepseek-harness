/** Exact Device stop facts shared by closure and the original cleanup ACK. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { deviceClaim, deviceDispatchRequest, deviceFinishRequest, deviceExecutionResult, deviceStopObservation,
  ownedContainerReceipt } from '@power-evolve/contracts/device-execution'
import { resolutionRequestId } from '@power-evolve/contracts/execution-resolution'
import { PlatformError, userId, sessionId, operationId } from '../contracts.ts'

/** Persisted Desktop states; only independent approval may close an unknown outcome. */
export type DeviceExecutionState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain' | 'closed_unknown'
/** Legacy Device execution fields; generic STDIO rows use separate consumers and command output remains lossless JSON. */
export interface DeviceExecutionRow {
  execution_kind: 'legacy_command'
  id: string; user_id: string; session_id: string; operation_id: string; device_id: string; directory_id: string
  call_id: string; command: string; cwd: string; request_digest: string; state: DeviceExecutionState
  cancel_requested: boolean; device_instance_id: string | null; result: unknown; error_code: string | null
  continuation_request_id: string; created_at: Date
  dispatch_request: unknown; dispatch_id: string | null; dispatch_process_id: string | null
  container_receipt: unknown; start_authorized_at: Date | null; stop_request_id: string | null
  stop_record_digest: string | null; stop_observation: unknown; continuation_queued: boolean
}
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
/** Frozen original request and exact stopped-container facts; no browser supplies this snapshot. */
export const deviceResolutionSnapshot = z.object({
  userId, sessionId, operationId, executionId: deviceClaim.shape.executionId,
  deviceId: ownedContainerReceipt.shape.owner.shape.deviceId, directoryId: deviceDispatchRequest.shape.directoryId,
  enrollmentId: deviceFinishRequest.shape.instanceId, processId: deviceClaim.shape.processId,
  dispatchId: deviceClaim.shape.dispatchId,
  executionRequestDigest: digest, dispatchRequest: deviceDispatchRequest, receipt: ownedContainerReceipt,
  startAuthorizedAt: z.iso.datetime().nullable(), stopRequestId: deviceFinishRequest.shape.requestId, stopRecordDigest: digest,
  observation: deviceStopObservation, result: deviceExecutionResult, continuationRequestId: resolutionRequestId,
}).strict()
/** Validated immutable facts retained by one independent closure. */
export type DeviceResolutionSnapshot = z.infer<typeof deviceResolutionSnapshot>
/** Hash ordered, validated persistence fields.
 * @param value Canonical DTO or frozen snapshot.
 * @returns SHA-256 of its exact JSON representation.
 */
export function deviceResolutionDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
/** Validate matching request, ownership, stop observation and original output without inventing legacy facts.
 * @param input Persisted candidate snapshot.
 * @returns Exact validated facts; inconsistent values fail with a fixed code.
 */
export function validateDeviceResolutionSnapshot(input: unknown): DeviceResolutionSnapshot {
  const parsed = deviceResolutionSnapshot.safeParse(input)
  if (!parsed.success) throw new PlatformError(409, 'device_stop_record_unavailable')
  const s = parsed.data, r = s.receipt.owner
  if (s.dispatchRequest.deviceId !== s.deviceId || s.dispatchRequest.directoryId !== s.directoryId
    || deviceResolutionDigest(s.dispatchRequest) !== s.executionRequestDigest
    || r.deviceId !== s.deviceId || r.enrollmentId !== s.enrollmentId || r.executionId !== s.executionId
    || r.creationId !== s.dispatchId || r.requestDigest !== s.executionRequestDigest
    || deviceResolutionDigest(s.receipt) !== deviceResolutionDigest(s.observation.receipt)) {
    throw new PlatformError(409, 'device_resolution_identity_changed')
  }
  const stop = deviceFinishRequest.parse({ instanceId: s.enrollmentId, executionId: s.executionId,
    processId: s.processId, dispatchId: s.dispatchId, requestId: s.stopRequestId,
    observation: s.observation, result: s.result })
  if (deviceResolutionDigest(stop) !== s.stopRecordDigest) throw new PlatformError(409, 'device_stop_record_unavailable')
  return s
}
/** Capture only a complete original Device stop record; absence is not termination evidence.
 * @param row Locked original execution row.
 * @returns Snapshot binding every source identity and its unchanged stop record.
 */
export function captureDeviceResolutionSnapshot(row: DeviceExecutionRow): DeviceResolutionSnapshot {
  if (row.execution_kind !== 'legacy_command') throw new PlatformError(409, 'device_resolution_identity_changed')
  if (row.stop_observation === null || row.stop_request_id === null || row.stop_record_digest === null) {
    throw new PlatformError(409, 'device_stop_unconfirmed')
  }
  const snapshot = validateDeviceResolutionSnapshot({ userId: row.user_id, sessionId: row.session_id,
    operationId: row.operation_id, executionId: row.id, deviceId: row.device_id, directoryId: row.directory_id,
    enrollmentId: row.device_instance_id, processId: row.dispatch_process_id, dispatchId: row.dispatch_id,
    executionRequestDigest: row.request_digest, dispatchRequest: row.dispatch_request, receipt: row.container_receipt,
    startAuthorizedAt: row.start_authorized_at?.toISOString() ?? null, stopRequestId: row.stop_request_id,
    stopRecordDigest: row.stop_record_digest, observation: row.stop_observation, result: row.result,
    continuationRequestId: row.continuation_request_id })
  if (snapshot.dispatchRequest.command !== row.command || snapshot.dispatchRequest.cwd !== row.cwd) {
    throw new PlatformError(409, 'device_resolution_identity_changed')
  }
  return snapshot
}
