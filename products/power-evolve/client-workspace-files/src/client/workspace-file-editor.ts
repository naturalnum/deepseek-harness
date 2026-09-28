/** Conditional text edits in a tenant-owned POSIX Workspace. */
import { encodeWorkspaceBytes } from './workspace-file-client.ts'
import { relativeWorkspacePath, WorkspaceDownloadError, WorkspaceFileDownloadClient } from './workspace-file-download.ts'
import { requireFileSessionId } from './session-id.ts'

const maxFileBytes = 2 * 1024 * 1024

export interface EditableFile {
  readonly sessionId: string
  readonly absolutePath: string
  readonly revision: string
  readonly text: string
}

export class WorkspaceFileEditError extends Error {
  constructor(readonly reason: 'binary' | 'large' | 'conflict' | 'denied' | 'missing' | 'failed') {
    super(`Workspace edit: ${reason}`)
  }
}

export class WorkspaceFileEditorClient {
  constructor(
    private readonly files: WorkspaceFileDownloadClient = new WorkspaceFileDownloadClient(),
    private readonly request: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  async open(sessionId: string, absolutePath: string, signal: AbortSignal): Promise<EditableFile> {
    requireFileSessionId(sessionId)
    let file
    try { file = await this.files.read(sessionId, absolutePath, signal) }
    catch (error) {
      if (error instanceof WorkspaceDownloadError && error.status === 413) throw new WorkspaceFileEditError('large')
      throw error
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes) }
    catch { throw new WorkspaceFileEditError('binary') }
    if (text.includes('\0')) throw new WorkspaceFileEditError('binary')
    return { sessionId, absolutePath, revision: file.revision, text }
  }

  async save(sessionId: string, file: EditableFile, text: string, requestId: string, signal: AbortSignal): Promise<string> {
    requireFileSessionId(sessionId)
    if (file.sessionId !== sessionId) throw new WorkspaceFileEditError('denied')
    const path = relativeWorkspacePath(file.absolutePath)
    const bytes = new TextEncoder().encode(text)
    if (bytes.length > maxFileBytes) throw new WorkspaceFileEditError('large')
    const response = await this.request('/api/powerEvolve/filesPut', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: { sessionId, requestId, path, baseRevision: file.revision,
        data: encodeWorkspaceBytes(bytes) } }),
    })
    if (!response.ok) throw new WorkspaceFileEditError(response.status === 409 ? 'conflict'
      : response.status === 401 || response.status === 403 ? 'denied'
        : response.status === 404 ? 'missing' : response.status === 413 ? 'large' : 'failed')
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || !('path' in value) || value.path !== path
      || !('revision' in value) || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) {
      throw new WorkspaceFileEditError('failed')
    }
    signal.throwIfAborted()
    return value.revision
  }
}
