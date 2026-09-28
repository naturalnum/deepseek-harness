/** Bounded, authenticated download of one file shown by the native DSH preview. */
const workspaceRoot = '/workspace/'
const maxBytes = 2 * 1024 * 1024

export interface DownloadedFile {
  readonly name: string
  readonly revision: string
  readonly bytes: Uint8Array<ArrayBuffer>
}

export class WorkspaceDownloadError extends Error {
  constructor(readonly status: number) {
    super(`File download failed: ${status}`)
  }
}

export function relativeWorkspacePath(absolutePath: string): string {
  if (!absolutePath.startsWith(workspaceRoot)) throw new Error('File is outside the Workspace')
  const relative = absolutePath.slice(workspaceRoot.length)
  if (!relative || relative.length > 512 || relative.includes('\\') || relative.includes('\0')
    || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid Workspace file path')
  }
  return relative
}

export class WorkspaceFileDownloadClient {
  constructor(private readonly request: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  async read(absolutePath: string, signal: AbortSignal): Promise<DownloadedFile> {
    const path = relativeWorkspacePath(absolutePath)
    const response = await this.request('/api/powerEvolve/fileRead', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: { path } }),
    })
    if (!response.ok) throw new WorkspaceDownloadError(response.status)
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || !('path' in value) || value.path !== path
      || !('size' in value) || typeof value.size !== 'number' || value.size > maxBytes || value.size < 0
      || !('revision' in value) || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
      || !('data' in value) || typeof value.data !== 'string') throw new Error('Invalid file response')
    const binary = atob(value.data)
    if (binary.length !== value.size) throw new Error('File size mismatch')
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    signal.throwIfAborted()
    return { name: path.split('/').at(-1)!, revision: value.revision, bytes }
  }
}

export function saveBrowserFile(file: DownloadedFile): void {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.append(link)
  try { link.click() } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}
