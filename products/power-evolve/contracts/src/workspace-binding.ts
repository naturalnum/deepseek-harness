/** Browser-safe private storage selection and durable Workspace binding recovery records. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { fileDownloadPath } from './file-download.ts'

/** Platform-owned personal storage identity; it never names a physical root. */
export type StorageSpaceId = Branded<'PowerEvolveStorageSpaceId'>
/** Stable Workspace identity retained by existing Sessions during recovery. */
export type BindingWorkspaceId = Branded<'PowerEvolveBindingWorkspaceId'>
/** Owner-scoped stable identity of a storage or binding mutation. */
export type BindingRequestId = Branded<'PowerEvolveBindingRequestId'>
/** Parse an opaque storage identity without granting access to it. */
export const storageSpaceId = z.uuid().transform(value => brandString<StorageSpaceId>(value))
/** Parse the immutable Workspace identity affected by a binding request. */
export const bindingWorkspaceId = z.uuid().transform(value => brandString<BindingWorkspaceId>(value))
/** Parse the owner-scoped request identity used for deduplication. */
export const bindingRequestId = z.uuid().transform(value => brandString<BindingRequestId>(value))
/** Empty selects the private root; nonempty paths use canonical relative components. */
export const storageRelativePath = z.union([z.literal(''), fileDownloadPath])
/** A binding generation must be compared exactly before committing recovery. */
export const bindingGeneration = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const title = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/u.test(value))

/** A directory selected within an authenticated user's existing private storage. */
export const workspaceStorageTarget = z.object({ spaceId: storageSpaceId, rootRelativePath: storageRelativePath }).strict()
/** Explicit native creation keeps one request identity while its first response is uncertain. */
export const workspaceCreateSelection = z.object({
  requestId: bindingRequestId, title, target: workspaceStorageTarget.optional(),
}).strict()
/** Private storage metadata; neither credentials nor physical paths cross to the browser. */
export const storageSpaceView = z.object({ spaceId: storageSpaceId, title, isDefault: z.boolean(), available: z.boolean() }).strict()
/** Bounded owner-scoped storage catalogue. */
export const storageSpacesView = z.object({ items: z.array(storageSpaceView).max(200) }).strict()
/** List immediate child directories without interpreting a browser value as a physical path. */
export const storageDirectoriesRequest = z.object({
  spaceId: storageSpaceId, parentPath: storageRelativePath,
  cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(200).default(100),
}).strict()
/** One directory entry, relative to its identified private storage. */
export const storageDirectoryView = z.object({ name: z.string().min(1).max(100), path: fileDownloadPath }).strict()
/** A directory page; cursors never grant authority or allow changing the owner. */
export const storageDirectoriesView = z.object({
  spaceId: storageSpaceId, parentPath: storageRelativePath,
  entries: z.array(storageDirectoryView).max(200), nextCursor: z.string().min(1).max(2048).optional(),
}).strict()
/** Explicit directory creation has an owner-scoped retry identity. */
export const storageDirectoryCreateRequest = z.object({
  requestId: bindingRequestId, spaceId: storageSpaceId, parentPath: storageRelativePath,
  name: fileDownloadPath.refine(value => !value.includes('/')),
}).strict()
/** Current binding state; missing storage remains visible and is never silently initialized. */
export const workspaceBindingView = z.object({
  workspaceId: bindingWorkspaceId, title, generation: bindingGeneration,
  state: z.enum(['ready', 'missing', 'recovering', 'blocked']), target: workspaceStorageTarget.nullable(),
  recoveryRequestId: bindingRequestId.nullable(),
}).strict().refine(value => (value.state !== 'ready' || value.target !== null)
  && (!['recovering', 'blocked'].includes(value.state) || value.recoveryRequestId !== null))
/** Existing Workspaces which need explicit storage recovery. */
export const workspaceBindingsMissingView = z.object({ items: z.array(workspaceBindingView).max(200) }).strict()
/** Explicit recovery binds its target and expected generation to one stable request. */
export const workspaceBindingRestoreRequest = workspaceStorageTarget.extend({
  requestId: bindingRequestId, workspaceId: bindingWorkspaceId, expectedGeneration: bindingGeneration,
}).strict()
/** Query a durable recovery after a lost response, refresh or service restart. */
export const workspaceBindingStatusRequest = z.object({ requestId: bindingRequestId }).strict()
/** Public recovery progress; stopped writer evidence remains in the trusted Platform. */
export const workspaceBindingReceipt = z.object({
  requestId: bindingRequestId, workspaceId: bindingWorkspaceId,
  state: z.enum(['accepted', 'stopping', 'completed', 'blocked']),
  expectedGeneration: bindingGeneration, bindingGeneration: bindingGeneration.nullable(),
  errorCode: z.string().min(1).max(100).nullable(),
}).strict().refine(value => value.state === 'completed'
  ? value.bindingGeneration === value.expectedGeneration + 1 && value.errorCode === null
  : value.bindingGeneration === null && (value.state === 'blocked' ? value.errorCode !== null : value.errorCode === null))

/** Shared native Host RPC and trusted Platform route mapping. */
export const WORKSPACE_BINDING_ROUTES = {
  storageSpaces: '/storage/spaces', storageDirectories: '/storage/directories',
  storageDirectoryCreate: '/storage/directories/create', workspaceBindingsMissing: '/workspaces/bindings/missing',
  workspaceBindingRestore: '/workspaces/bindings/restore', workspaceBindingStatus: '/workspaces/bindings/status',
} as const

/** Parsed directory target, without physical storage authority. */
export type WorkspaceStorageTarget = z.infer<typeof workspaceStorageTarget>
/** Parsed creation input; omitting the target requests a new private directory. */
export type WorkspaceCreateSelection = z.infer<typeof workspaceCreateSelection>
/** Parsed private storage metadata. */
export type StorageSpaceView = z.infer<typeof storageSpaceView>
/** Parsed directory query. */
export type StorageDirectoriesRequest = z.infer<typeof storageDirectoriesRequest>
/** Parsed directory page. */
export type StorageDirectoriesView = z.infer<typeof storageDirectoriesView>
/** Parsed explicit directory creation. */
export type StorageDirectoryCreateRequest = z.infer<typeof storageDirectoryCreateRequest>
/** Parsed existing Workspace binding metadata. */
export type WorkspaceBindingView = z.infer<typeof workspaceBindingView>
/** Parsed generation-conditional binding mutation. */
export type WorkspaceBindingRestoreRequest = z.infer<typeof workspaceBindingRestoreRequest>
/** Parsed durable binding mutation result. */
export type WorkspaceBindingReceipt = z.infer<typeof workspaceBindingReceipt>
