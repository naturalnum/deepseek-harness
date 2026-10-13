/** Trusted Platform records joining storage mount admission. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { workspaceStorageTarget, bindingWorkspaceId,
  bindingGeneration } from '@power-evolve/contracts/storage'

/** Immutable server-selected component beneath the managed POSIX storage root. */
export type StorageRootKey = Branded<'PowerEvolveStorageRootKey'>
/** The complete storage identity frozen before a Pod may receive writable mounts. */
export const storageBinding = workspaceStorageTarget.extend({
  workspaceId: bindingWorkspaceId,
  rootKey: z.uuid().transform(value => brandString<StorageRootKey>(value)),
  generation: bindingGeneration,
}).strict()
/** Validated fixed storage address for file and execution adapters. */
export type StorageBinding = z.infer<typeof storageBinding>
