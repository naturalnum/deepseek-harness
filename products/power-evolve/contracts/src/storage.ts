/** Cloud mount metadata; it grants neither directory recovery nor filesystem access. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Opaque logical Workspace identity. */
export type BindingWorkspaceId = Branded<'PowerEvolveBindingWorkspaceId'>
/** Parse server-resolved Workspace metadata. */
export const bindingWorkspaceId = z.uuid().transform(value => brandString<BindingWorkspaceId>(value))
/** Monotonic storage identity captured by an execution grant. */
export const bindingGeneration = z.number().int().positive()
/** Descriptor-relative storage location; no absolute paths or traversal. */
export const storageRelativePath = z.string().max(512).refine(value => value === ''
  || !value.includes('\\') && !/^[A-Za-z]:/u.test(value)
  && value.split('/').every(part => part.length > 0 && part.length <= 100 && part !== '.' && part !== '..')
  && !/[\x00-\x1f\x7f]/u.test(value))
/** Server-selected mount address inside the deployment's private root. */
export const workspaceStorageTarget = z.object({ spaceId: z.uuid(), rootRelativePath: storageRelativePath }).strict()
/** Validated mount address; browsers cannot select a physical root. */
export type WorkspaceStorageTarget = z.infer<typeof workspaceStorageTarget>
