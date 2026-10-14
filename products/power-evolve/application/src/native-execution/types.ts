/** Native execution services bound to one revocable Platform-issued Agent world. */
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxMode, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { userId, sessionId, workspaceId, operationId } from '../contracts.ts'

/** Opaque execution-world identity, issued by Platform. */
export type NativeExecutionWorldId = Branded<'PowerEvolveNativeExecutionWorldId'>
/** Server-selected storage and permission generations; no credential is carried into payloads. */
export const nativeExecutionWorld = z.object({
  worldId: z.uuid().transform(value => brandString<NativeExecutionWorldId>(value)),
  userId, sessionId, agentId: z.string().min(1).max(256), workspaceId,
  operationId, operationEpoch: z.number().int().positive(),
  storageGeneration: z.number().int().positive(), permissionGeneration: z.number().int().positive(),
  mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  workspaceRoot: z.literal('/workspace'), homeRoot: z.literal('/home/agent'),
}).strict()
/** Frozen Agent execution address. */
export type NativeExecutionWorld = z.infer<typeof nativeExecutionWorld>

/** Already authorized services selected by the caller's original Agent scope. */
export interface NativeExecutionBinding {
  readonly world: NativeExecutionWorld
  readonly filesystem: FileSystem
  readonly subprocess: SubprocessRuntime
  readonly sandbox: SandboxProvider
}

/** Capture the caller synchronously before any asynchronous work; absence must throw. */
export type NativeExecutionBindingResolver = () => NativeExecutionBinding

/** Default-relative confinement fact published by the mounted native providers. */
export interface NativeExecutionProviderConfig {
  readonly defaultMode: SandboxMode
  readonly resolve: NativeExecutionBindingResolver
}
