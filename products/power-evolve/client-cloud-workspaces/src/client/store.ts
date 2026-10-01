/** Retry records shared by the two native directory-flow entries for the plugin lifetime. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { BindingRequestId, StorageDirectoryCreateRequest, WorkspaceBindingRestoreRequest, WorkspaceCreateSelection } from '@power-evolve/contracts/workspace-binding'

type State = {
  create: WorkspaceCreateSelection | null
  restore: WorkspaceBindingRestoreRequest | null
  directory: StorageDirectoryCreateRequest | null
}
type Actions = {
  rememberCreate: (draft: State, request: WorkspaceCreateSelection) => void
  rememberRestore: (draft: State, request: WorkspaceBindingRestoreRequest) => void
  rememberDirectory: (draft: State, request: StorageDirectoryCreateRequest) => void
  completeCreate: (draft: State, requestId: BindingRequestId) => void
}

/** Declare shared interaction records without copying authoritative binding data into a store.
 * @returns a handle retaining mutation identities across modal closure and entry remounts.
 */
export function createCloudWorkspaceStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({ create: null, restore: null, directory: null }),
    actions: {
      rememberCreate: (draft, request) => { draft.create = request },
      rememberRestore: (draft, request) => { draft.restore = request },
      rememberDirectory: (draft, request) => { draft.directory = request },
      completeCreate: (draft, requestId) => { if (draft.create?.requestId === requestId) draft.create = null },
    },
  })
}
