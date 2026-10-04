/** Private parent/Device IPC; no local path, nonce, credential or command is transported. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { deviceClaimClosureReceipt, deviceStopObservation } from './device-execution.ts'

/** One Electron-owned child launch, independent of persistent enrollment. */
export type DeviceLaunchId = Branded<'power-evolve/DeviceLaunchId'>
/** Stable correlation identity for one private lifecycle request. */
export type DeviceLifecycleRequestId = Branded<'power-evolve/DeviceLifecycleRequestId'>
/** Fresh local HTTP service identity for one child process. */
export type DeviceServiceInstanceId = Branded<'power-evolve/DeviceServiceInstanceId'>

const launchId = z.uuid().transform(value => brandString<DeviceLaunchId>(value))
const requestId = z.uuid().transform(value => brandString<DeviceLifecycleRequestId>(value))
const instanceId = z.uuid().transform(value => brandString<DeviceServiceInstanceId>(value))
const base = z.object({ kind: z.literal('power-evolve-device-lifecycle'), version: z.literal(1), launchId }).strict()
const executionId = deviceClaimClosureReceipt.shape.executionId
const count = z.number().int().nonnegative().safe()

/** Persisted facts for one unresolved journal entry, never inferred from process exit. */
export const deviceDrainEntry = z.discriminatedUnion('state', [
  z.object({ executionId, state: z.literal('stopConfirmed'), observation: deviceStopObservation }).strict(),
  z.object({ executionId, state: z.literal('notStarted'), receipt: deviceClaimClosureReceipt }).strict(),
  z.object({ executionId, state: z.literal('unconfirmed') }).strict(),
]).superRefine((entry, ctx) => {
  if (entry.state === 'stopConfirmed' && entry.observation.receipt.owner.executionId !== entry.executionId
    || entry.state === 'notStarted' && entry.receipt.executionId !== entry.executionId) {
    ctx.addIssue({ code: 'custom', message: 'device_drain_identity_mismatch' })
  }
})

/** Residual durable work observed while the Worker owns its journal lock; not an all-stopped claim. */
export const deviceDrainReport = z.object({
  entries: z.array(deviceDrainEntry).max(1024), cleanupPending: count,
}).strict().refine(report => new Set(report.entries.map(entry => entry.executionId)).size === report.entries.length,
  'duplicate_device_drain_entry')

/** Local process work and residual durable facts are reported separately. */
export const deviceLifecycleSnapshot = z.object({
  phase: z.enum(['starting', 'ready', 'draining', 'quiescent', 'error']),
  admissionOpen: z.boolean(), pendingActions: count, journalEntries: count,
  drain: deviceDrainReport.nullable(),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.phase === 'quiescent' && (snapshot.admissionOpen || snapshot.pendingActions !== 0 || snapshot.drain === null)
    || snapshot.phase === 'draining' && snapshot.admissionOpen) {
    ctx.addIssue({ code: 'custom', message: 'invalid_device_quiescence' })
  }
})

/** Inspect/quiesce can cancel a startup before its instance is known; terminate requires that instance. */
export const deviceLifecycleRequest = base.extend({
  type: z.literal('request'), instanceId: instanceId.nullable(), requestId,
  action: z.enum(['inspect', 'quiesce', 'terminate']),
}).refine(request => request.action !== 'terminate' || request.instanceId !== null,
  'terminate_requires_device_instance')

const url = z.string().url().refine(value => {
  const target = new URL(value)
  return target.protocol === 'http:' && target.hostname === '127.0.0.1' && target.port !== ''
    && target.username === '' && target.password === '' && target.pathname === '/'
    && target.search === '' && target.hash === ''
}, 'device_ready_requires_exact_loopback_origin')

/** Sent only after the official Profile launcher commits successful boot. */
export const deviceLifecycleReady = base.extend({
  type: z.literal('ready'), instanceId, pid: z.number().int().positive().safe(), url,
})

/** Bounded private response; errors carry fixed codes rather than paths or exception text. */
export const deviceLifecycleResponse = z.discriminatedUnion('status', [
  base.extend({ type: z.literal('response'), instanceId, requestId,
    action: deviceLifecycleRequest.shape.action, status: z.literal('ok'), snapshot: deviceLifecycleSnapshot }),
  base.extend({ type: z.literal('response'), instanceId, requestId,
    action: deviceLifecycleRequest.shape.action, status: z.literal('error'),
    code: z.enum(['invalid_request', 'wrong_instance', 'not_quiescent', 'quiesce_failed', 'not_ready']) }),
])

/** Validated residual journal entry with matching execution identity. */
export type DeviceDrainEntry = z.infer<typeof deviceDrainEntry>
/** Validated residual durable facts; quiescence is supplied separately by the snapshot. */
export type DeviceDrainReport = z.infer<typeof deviceDrainReport>
/** Validated private lifecycle observation. */
export type DeviceLifecycleSnapshot = z.infer<typeof deviceLifecycleSnapshot>
/** Validated action scoped to the owned launch and expected child instance. */
export type DeviceLifecycleRequest = z.infer<typeof deviceLifecycleRequest>
/** Validated successful Profile boot, requiring parent-side PID and URL verification. */
export type DeviceLifecycleReady = z.infer<typeof deviceLifecycleReady>
/** Validated private request result, independent of child exit. */
export type DeviceLifecycleResponse = z.infer<typeof deviceLifecycleResponse>
