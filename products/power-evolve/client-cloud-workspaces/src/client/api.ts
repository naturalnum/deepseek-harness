/** Authenticated native Host calls for private directories and generation-conditional binding recovery. */
import {
  WORKSPACE_BINDING_ROUTES, storageSpacesView, storageDirectoriesRequest, storageDirectoriesView,
  storageDirectoryCreateRequest, storageDirectoryView, workspaceBindingsMissingView,
  workspaceBindingRestoreRequest, workspaceBindingStatusRequest, workspaceBindingReceipt,
  type StorageDirectoriesRequest, type StorageDirectoryCreateRequest, type WorkspaceBindingRestoreRequest,
  type StorageSpaceView, type StorageDirectoriesView, type WorkspaceBindingView, type WorkspaceBindingReceipt,
} from '@power-evolve/contracts/workspace-binding'

/** A bounded Host failure; UI copy is selected from its locale dictionary. */
export class WorkspaceBindingHttpError extends Error {
  /** @param status - HTTP status.
   * @param code - validated Platform business error, when available.
   */
  constructor(readonly status: number, readonly code?: string) { super(`Workspace storage request failed: ${status}`) }
}

async function json(response: Response, signal: AbortSignal, maxBytes = 512 * 1024): Promise<unknown> {
  if (response.body === null) throw new Error('Missing storage response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const abort = () => { void reader.cancel().catch(() => { /* The aborted response has no remaining consumer. */ }) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const result = await reader.read()
      signal.throwIfAborted()
      if (result.done) break
      total += result.value.byteLength
      if (total > maxBytes) throw new Error('Storage response exceeds its byte limit')
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => { /* The bounded read has finished or failed. */ })
    reader.releaseLock()
  }
}

/** Plain operation callbacks injected into both native directory flows.
 * @returns validated operations; components receive these callbacks instead of a service object.
 */
export function createWorkspaceBindingActions(): WorkspaceBindingActions {
  const post = async (key: keyof typeof WORKSPACE_BINDING_ROUTES, request: object, signal: AbortSignal) => {
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const response = await fetch(`/api/powerEvolve/${key}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }), signal: lifetime,
    })
    if (!response.ok) {
      let code: string | undefined
      try {
        const body = await json(response, lifetime, 1024)
        if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
          && /^[a-z][a-z0-9_]{0,99}$/u.test(body.error)) code = body.error
      } catch (error) { if (lifetime.aborted) throw error /* An invalid failure body retains only its HTTP status. */ }
      throw new WorkspaceBindingHttpError(response.status, code)
    }
    return json(response, lifetime)
  }
  const receipt = (value: unknown, request: Pick<WorkspaceBindingRestoreRequest, 'requestId' | 'workspaceId' | 'expectedGeneration'>) => {
    const parsed = workspaceBindingReceipt.parse(value)
    if (parsed.requestId !== request.requestId || parsed.workspaceId !== request.workspaceId
      || parsed.expectedGeneration !== request.expectedGeneration) throw new Error('Mismatched binding receipt')
    return parsed
  }
  return {
    listStorageSpaces: async (signal: AbortSignal) => storageSpacesView.parse(await post('storageSpaces', {}, signal)).items,
    listMissingBindings: async (signal: AbortSignal) => workspaceBindingsMissingView.parse(await post('workspaceBindingsMissing', {}, signal)).items,
    listStorageDirectories: async (input: StorageDirectoriesRequest, signal: AbortSignal) => {
      const request = storageDirectoriesRequest.parse(input)
      const page = storageDirectoriesView.parse(await post('storageDirectories', request, signal))
      const prefix = request.parentPath === '' ? '' : `${request.parentPath}/`
      if (page.spaceId !== request.spaceId || page.parentPath !== request.parentPath
        || page.entries.length > request.limit || new Set(page.entries.map(entry => entry.path)).size !== page.entries.length
        || page.entries.some(entry => entry.name.includes('/') || entry.path !== `${prefix}${entry.name}`)
        || (page.nextCursor !== undefined && page.nextCursor === request.cursor)) throw new Error('Mismatched storage page')
      return page
    },
    createStorageDirectory: async (input: StorageDirectoryCreateRequest, signal: AbortSignal) => {
      const request = storageDirectoryCreateRequest.parse(input)
      const directory = storageDirectoryView.parse(await post('storageDirectoryCreate', request, signal))
      const expected = request.parentPath === '' ? request.name : `${request.parentPath}/${request.name}`
      if (directory.path !== expected || directory.name !== request.name) throw new Error('Mismatched created directory')
      return directory
    },
    restoreBinding: async (input: WorkspaceBindingRestoreRequest, signal: AbortSignal) => {
      const request = workspaceBindingRestoreRequest.parse(input)
      return receipt(await post('workspaceBindingRestore', request, signal), request)
    },
    checkBindingStatus: async (request: Pick<WorkspaceBindingRestoreRequest, 'requestId' | 'workspaceId' | 'expectedGeneration'>, signal: AbortSignal) =>
      receipt(await post('workspaceBindingStatus', workspaceBindingStatusRequest.parse({ requestId: request.requestId }), signal), request),
  }
}

/** Component injection share containing only bounded operation callbacks. */
export interface WorkspaceBindingActions {
  /** @param signal - modal lifetime.
   * @returns authenticated storage metadata.
   */
  listStorageSpaces(signal: AbortSignal): Promise<StorageSpaceView[]>
  /** @param signal - modal lifetime.
   * @returns existing bindings requiring recovery, including durable operation identities.
   */
  listMissingBindings(signal: AbortSignal): Promise<WorkspaceBindingView[]>
  /** @param input - canonical relative directory and bounded page query.
   * @param signal - browse lifetime.
   * @returns a validated page belonging to that exact directory.
   */
  listStorageDirectories(input: StorageDirectoriesRequest, signal: AbortSignal): Promise<StorageDirectoriesView>
  /** @param input - directory creation with its stable retry identity.
   * @param signal - modal lifetime.
   * @returns the exact created child directory.
   */
  createStorageDirectory(input: StorageDirectoryCreateRequest, signal: AbortSignal): Promise<ReturnType<typeof storageDirectoryView.parse>>
  /** @param input - target and observed generation for one durable recovery.
   * @param signal - browser request lifetime; cancellation does not withdraw Platform acceptance.
   * @returns a receipt matched to that request and original Workspace.
   */
  restoreBinding(input: WorkspaceBindingRestoreRequest, signal: AbortSignal): Promise<WorkspaceBindingReceipt>
  /** @param input - original Workspace, generation and persistent operation identity.
   * @param signal - modal lifetime.
   * @returns the matching recovery receipt.
   */
  checkBindingStatus(input: Pick<WorkspaceBindingRestoreRequest, 'requestId' | 'workspaceId' | 'expectedGeneration'>,
    signal: AbortSignal): Promise<WorkspaceBindingReceipt>
}
