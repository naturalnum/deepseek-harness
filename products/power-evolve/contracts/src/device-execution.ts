/** Durable Device dispatch and exact-container stop records; parsing does not authorize execution. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { deviceMaterialBinding, deviceMaterialSelection } from './device-materials.ts'

export { deviceMaterialBinding, deviceMaterialSelection, deviceSkillManifest, deviceSkillMaterial,
  DEVICE_MATERIAL_MAX_BYTES, DEVICE_MATERIAL_MAX_FILES, DEVICE_MATERIAL_MAX_RESPONSE_BYTES,
  type DeviceMaterialBinding, type DeviceMaterialDigest, type DeviceMaterialSkillId,
  type DeviceSkillMaterial, type DeviceSkillManifest } from './device-materials.ts'

/** Exact Docker container ID, never a name or shortened prefix. */
export type DeviceContainerId = Branded<'power-evolve/DeviceContainerId'>
/** Immutable local Docker image ID. */
export type DeviceContainerImageId = Branded<'power-evolve/DeviceContainerImageId'>
/** Enrolled Device identity. */
export type ContainerDeviceId = Branded<'power-evolve/ContainerDeviceId'>
/** Persistent enrollment identity, distinct from a worker process. */
export type ContainerEnrollmentId = Branded<'power-evolve/ContainerEnrollmentId'>
/** Original durable execution identity. */
export type ContainerExecutionId = Branded<'power-evolve/ContainerExecutionId'>
/** Platform-issued dispatch identity used in Docker ownership labels. */
export type ContainerCreationId = Branded<'power-evolve/ContainerCreationId'>
/** SHA-256 of the frozen accepted request. */
export type ContainerRequestDigest = Branded<'power-evolve/ContainerRequestDigest'>
/** One worker process generation; restarting cannot reclaim permission to start. */
export type DeviceProcessId = Branded<'power-evolve/DeviceProcessId'>
/** Stable identity of a persisted stop report. */
export type DeviceStopRequestId = Branded<'power-evolve/DeviceStopRequestId'>
/** Cloud-visible directory grant; it contains no local path. */
export type DeviceDirectoryId = Branded<'power-evolve/DeviceDirectoryId'>
/** Stable identity for fencing one interrupted claim before any start authorization. */
export type DeviceClaimClosureRequestId = Branded<'power-evolve/DeviceClaimClosureRequestId'>

const deviceId = z.uuid().transform(value => brandString<ContainerDeviceId>(value))
const instanceId = z.uuid().transform(value => brandString<ContainerEnrollmentId>(value))
const executionId = z.uuid().transform(value => brandString<ContainerExecutionId>(value))
const dispatchId = z.uuid().transform(value => brandString<ContainerCreationId>(value))
const processId = z.uuid().transform(value => brandString<DeviceProcessId>(value))
const directoryId = z.uuid().transform(value => brandString<DeviceDirectoryId>(value))
const digest = z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<ContainerRequestDigest>(value))
/** Frozen owner checked against the original dispatch by the Platform and Docker adapter. */
export const ownedContainerOwner = z.object({
  deviceId, enrollmentId: instanceId, executionId, creationId: dispatchId, requestDigest: digest,
}).strict()
/** Exact identity captured before any Docker start request. */
export const ownedContainerReceipt = z.object({
  containerId: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<DeviceContainerId>(value)),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(value => brandString<DeviceContainerImageId>(value)),
  owner: ownedContainerOwner,
}).strict()
/** Owner persisted in Docker labels and the private journal. */
export type OwnedContainerOwner = z.infer<typeof ownedContainerOwner>
/** Immutable container capture persisted locally and by the Platform. */
export type OwnedContainerReceipt = z.infer<typeof ownedContainerReceipt>

/** Original execution inputs, including the timeout selected at durable acceptance. */
export const deviceDispatchRequest = z.object({
  command: z.string().min(1).max(8192), cwd: z.string().max(4096), timeoutMs: z.number().int().positive(),
  deviceId, directoryId,
  materials: deviceMaterialSelection.optional(),
}).strict()
const command = z.object({ executionId, directoryId, command: deviceDispatchRequest.shape.command,
  cwd: deviceDispatchRequest.shape.cwd, timeoutMs: deviceDispatchRequest.shape.timeoutMs, digest,
  materials: deviceMaterialSelection.optional() }).strict()
/** Bounded polling record; cancellation and unknown outcomes grant no permission to start. */
export const deviceJob = command.extend({
  state: z.enum(['queued', 'running', 'cancelling', 'uncertain']), cancelRequested: z.boolean(),
})
/** A claim binds one process to one durable dispatch. */
export const deviceClaimRequest = z.object({ instanceId, executionId, processId }).strict()
/** The original command and Platform-issued dispatch; retries retain exactly these identities. */
export const deviceClaim = command.extend({ dispatchId, processId })
/** Read one frozen package only through its original live dispatch; no storage path or user ID is accepted. */
export const deviceMaterialRequest = deviceClaimRequest.extend({ dispatchId, digest,
  skillId: deviceMaterialBinding.shape.skillId,
})
/** Validated original dispatch reference for one selected immutable package. */
export type DeviceMaterialRequest = z.infer<typeof deviceMaterialRequest>
/** Original claiming intent; no caller-supplied command, output or stop observation is accepted. */
export const deviceClaimClosureRequest = deviceClaimRequest.extend({ directoryId, digest,
  requestId: z.uuid().transform(value => brandString<DeviceClaimClosureRequestId>(value)),
})
/** Platform's permanent start fence, distinct from an observed Docker stop or a known command result. */
export const deviceClaimClosureReceipt = deviceClaimClosureRequest.extend({
  kind: z.literal('unstarted_claim_closed'), deviceId, dispatchId: dispatchId.nullable(),
  state: z.literal('cancelled'), startNeverAuthorized: z.literal(true), continuationQueued: z.boolean(),
})
/** Validated original interrupted claim and stable closure request. */
export type DeviceClaimClosureRequest = z.infer<typeof deviceClaimClosureRequest>
/** Validated permanent no-start fence; it authorizes no execution or invented stop facts. */
export type DeviceClaimClosureReceipt = z.infer<typeof deviceClaimClosureReceipt>
/** Registering an exact container requires its original claimed process and dispatch. */
export const deviceContainerRegistration = deviceClaimRequest.extend({ dispatchId, receipt: ownedContainerReceipt })
  .refine(value => value.receipt.owner.executionId === value.executionId
    && value.receipt.owner.creationId === value.dispatchId && value.receipt.owner.enrollmentId === value.instanceId)
/** Start permission is granted only by the first registration transaction; an ACK loss cannot replay it. */
export const deviceContainerRegistered = z.object({ executionId, dispatchId, receipt: ownedContainerReceipt,
  canStart: z.boolean() }).strict()
/** A non-running observation of the exact registered container, distinct from a known command result. */
export const deviceStopObservation = z.object({ receipt: ownedContainerReceipt, Running: z.literal(false),
  ExitCode: z.number().int(), Status: z.enum(['created', 'exited', 'dead']),
  StartedAt: z.string().max(100), FinishedAt: z.string().max(100) }).strict()
/** Bounded output preserves unknown effects independently of writer termination. */
export const deviceExecutionResult = z.object({
  state: z.enum(['succeeded', 'failed', 'cancelled', 'uncertain']), exitCode: z.number().int().nullable(),
  stdout: z.string().max(65_536), stderr: z.string().max(65_536), stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(), timedOut: z.boolean(),
}).strict()
/** Only the enrolled Device may report stop facts for its original registered dispatch. */
export const deviceFinishRequest = deviceClaimRequest.extend({ dispatchId,
  requestId: z.uuid().transform(value => brandString<DeviceStopRequestId>(value)),
  observation: deviceStopObservation, result: deviceExecutionResult,
}).refine(value => value.observation.receipt.owner.executionId === value.executionId
  && value.observation.receipt.owner.creationId === value.dispatchId
  && value.observation.receipt.owner.enrollmentId === value.instanceId)
/** A stop ACK permits local cleanup only for this exact persisted dispatch and receipt. */
export const deviceFinishReceipt = z.object({ executionId, dispatchId,
  requestId: deviceFinishRequest.shape.requestId, stopConfirmed: z.literal(true),
  state: z.enum(['succeeded', 'failed', 'cancelled', 'uncertain', 'closed_unknown']),
}).passthrough()
/** Validated original Device dispatch. */
export type DeviceClaim = z.infer<typeof deviceClaim>
/** Validated container registration. */
export type DeviceContainerRegistration = z.infer<typeof deviceContainerRegistration>
/** Validated stop and result report. */
export type DeviceFinishRequest = z.infer<typeof deviceFinishRequest>
