/** Trusted Platform records joining storage selection, mount admission and recovery. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { accountUserId } from '@power-evolve/contracts/account'
import { workspaceStorageTarget, bindingWorkspaceId, bindingRequestId,
  bindingGeneration } from '@power-evolve/contracts/workspace-binding'

/** Immutable server-selected component beneath the managed POSIX storage root. */
export type StorageRootKey = Branded<'PowerEvolveStorageRootKey'>
/** The complete storage identity frozen before a Pod may receive writable mounts. */
export const storageBinding = workspaceStorageTarget.extend({
  workspaceId: bindingWorkspaceId,
  rootKey: z.uuid().transform(value => brandString<StorageRootKey>(value)),
  generation: bindingGeneration,
}).strict()
const mountGeneration = z.string().regex(/^(0|[1-9][0-9]*)$/u)
/** Durable writer identity captured while admission is fenced under the owner lock. */
export const recoveryStopTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no_writer'), mountGeneration }).strict(),
  z.object({ kind: z.literal('pod'), mountGeneration, sessionId: z.uuid(),
    podUid: z.uuid(), runnerInstanceId: z.uuid() }).strict(),
])
/** Recovery worker input; none of these authority fields is accepted from the browser. */
export const workspaceRecoveryClaim = z.object({
  userId: accountUserId, requestId: bindingRequestId, workspaceId: bindingWorkspaceId,
  expectedGeneration: bindingGeneration, stopTarget: recoveryStopTarget,
}).strict()
/** Stopping a known Pod requires kubelet evidence; a missing Pod is never equivalent. */
export const recoveryStopProof = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no_writer'), mountGeneration }).strict(),
  z.object({ kind: z.literal('kubelet_stopped'), mountGeneration, podUid: z.uuid() }).strict(),
])
/** Validated complete storage identity for file and execution adapters. */
export type StorageBinding = z.infer<typeof storageBinding>
/** Persisted intended writer stop, captured before infrastructure I/O. */
export type RecoveryStopTarget = z.infer<typeof recoveryStopTarget>
/** Fenced recovery worker input. */
export type WorkspaceRecoveryClaim = z.infer<typeof workspaceRecoveryClaim>
/** Evidence returned after the captured writer can no longer use its mounts. */
export type RecoveryStopProof = z.infer<typeof recoveryStopProof>
/** Stop only the captured writer; the callback renews and validates the worker lease. */
export type StopWorkspaceWriter = (claim: WorkspaceRecoveryClaim, assertLease: () => Promise<void>) => Promise<RecoveryStopProof>
