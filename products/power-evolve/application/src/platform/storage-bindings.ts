/** Platform-owned storage selection and durable binding recovery API. */
import type { z } from 'zod'
import type { Identity } from '../contracts.ts'
import type { storageSpacesView, storageDirectoryView, workspaceBindingsMissingView,
  WorkspaceBindingReceipt, WorkspaceBindingRestoreRequest, StorageDirectoriesRequest,
  StorageDirectoriesView, StorageDirectoryCreateRequest } from '@power-evolve/contracts/workspace-binding'
import type { StopWorkspaceWriter } from './workspace-binding-types.ts'

/** Deployment-owned identity and lease duration for one recovery poll. */
export interface StorageBindingWorker { ownerId: string; leaseMs: number }

/** Browser operations return only owner-scoped identities and canonical relative directories. */
export interface StorageBindingApi {
  /** List private roots, lazily initializing only the explicitly provisioning personal root. */
  spaces(user: Identity): Promise<z.infer<typeof storageSpacesView>>
  /** List a bounded immediate directory page through retained descriptors. */
  directories(user: Identity, request: StorageDirectoriesRequest): Promise<StorageDirectoriesView>
  /** Persist directory creation intent before mkdir; uncertain retries reconcile that same target. */
  createDirectory(user: Identity, request: StorageDirectoryCreateRequest): Promise<z.infer<typeof storageDirectoryView>>
  /** List existing unavailable bindings without creating replacement directories. */
  missing(user: Identity): Promise<z.infer<typeof workspaceBindingsMissingView>>
  /** Capture and fence the current writer before acknowledging a generation-conditional recovery. */
  restore(user: Identity, request: WorkspaceBindingRestoreRequest): Promise<WorkspaceBindingReceipt>
  /** Read the accepted owner's durable recovery receipt. */
  status(user: Identity, request: { requestId: string }): Promise<WorkspaceBindingReceipt>
  /** Claim at most one recovery; infrastructure cleanup uses only the captured stop target. */
  poll(stopWriter: StopWorkspaceWriter, signal: AbortSignal, worker: StorageBindingWorker): Promise<boolean>
}
