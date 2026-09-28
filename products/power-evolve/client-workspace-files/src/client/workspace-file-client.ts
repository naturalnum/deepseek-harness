/** Uploads through the authenticated product API into the user's POSIX Workspace. */
import { requireFileSessionId } from './session-id.ts'

const maxFileBytes = 2 * 1024 * 1024

export interface WorkspaceFileCapabilities {
  readonly maxFileBytes: number
}

export interface WorkspaceFileUpload {
  readonly displayName: string
  readonly workspacePath: string
}

function uploadName(file: File): string {
  const name = file.name.normalize('NFC')
  if (!name || name === '.' || name === '..' || name.length > 100 || name.includes('/')
    || name.includes('\\') || name.includes('\0')) throw new Error('Invalid file name')
  return name
}

export function encodeWorkspaceBytes(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  }
  return btoa(chunks.join(''))
}

export class WorkspaceFileHttpClient {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  async capabilities(): Promise<WorkspaceFileCapabilities> { return { maxFileBytes } }

  async upload(sessionId: string, file: File, signal: AbortSignal): Promise<WorkspaceFileUpload> {
    requireFileSessionId(sessionId)
    const name = uploadName(file)
    if (file.size > maxFileBytes) throw new Error('File exceeds upload limit')
    const requestId = crypto.randomUUID()
    const path = `uploads/${requestId}/${name}`
    const data = encodeWorkspaceBytes(new Uint8Array(await file.arrayBuffer()))
    signal.throwIfAborted()
    const response = await this.request('/api/powerEvolve/filesPut', { method: 'POST',
      credentials: 'same-origin', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ request: { sessionId, requestId, path, baseRevision: null, data } }),
    })
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`)
    const result: unknown = await response.json()
    if (typeof result !== 'object' || result === null || !('path' in result) || result.path !== path) {
      throw new Error('Upload result path mismatch')
    }
    return { displayName: name, workspacePath: `/workspace/${path}` }
  }
}

/** Preserve the established PowerEvolve composer reference wording. */
export function appendWorkspaceFileReference(draft: string, upload: WorkspaceFileUpload): string {
  const reference = `附件文件 ${JSON.stringify(upload.displayName)} 已上传到 ${JSON.stringify(upload.workspacePath)}。`
  return draft === '' ? reference : `${draft}\n\n${reference}`
}
