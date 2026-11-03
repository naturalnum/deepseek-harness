import { readResponse } from './read-response.ts'
/** Page-owned binary HTTP operations for the original native workspace tree. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileManagement } from '@deepseek-ai/dsh-client-ui-sidebar-files/src/client/management.ts'
import type { FileUploadFetch } from '@deepseek-ai/dsh-client-file-upload/types'
import { CloudFileDownload } from './file-download.ts'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/**
 * Bind the native optional operation face to one immutable prepared page.
 * @param ctx Prepared native root before activation.
 * @param fetch Captured account-bound Fetch carrier.
 * @param navigationUrl Captured browser navigation binding, including account generation.
 * @param lifetime Original page lifetime.
 * @param maxFileBytes Explicit client acceptance bound; server limits and disk quota remain authoritative.
 * @param maxMetadataBytes Bounded receipt and directory-response budget from the prepared page.
 */
export function prepareWorkspaceManagement(ctx: Context, fetch: FileUploadFetch,
  navigationUrl: (path: string) => string, lifetime: AbortSignal, maxFileBytes: number, maxMetadataBytes: number): void {
  const path = (route: string, id: SessionId, values: Record<string, string>): string => {
    const params = new URLSearchParams({ sessionId: id, ...values })
    return `api/workspace-files/${route}?${params}`
  }
  const createDirectory: WorkspaceFileManagement['createDirectory'] = async (id, directory, name, signal) => {
    const response = await fetch(path('directory', id, { directory, name }), {
      method: 'POST', signal: AbortSignal.any([signal, lifetime]),
    })
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readResponse(response, maxMetadataBytes, signal)))
    if (!response.ok || typeof data !== 'object' || data === null || !('path' in data) || typeof data.path !== 'string') {
      throw new Error('directory-unconfirmed')
    }
    return data.path
  }
  const management: WorkspaceFileManagement = {
    createDirectory,
    download: async (id, paths, signal) => {
      const download = new CloudFileDownload({ sessionId: id, resourceAddress: sessionFileAddress(id, paths[0] ?? ''),
        paths, signal: AbortSignal.any([signal, lifetime]), fetch, navigationUrl, maxFileBytes })
      try { if ((await download.save()).kind !== 'started') throw new Error('download-failed') }
      finally { await download.dispose() }
    },
    upload: async (id, directory, files, signal, progress) => {
      const control = AbortSignal.any([signal, lifetime])
      const policy = await fetch(path('download', id, {}), { method: 'HEAD', signal: control })
      await policy.body?.cancel()
      const maximum = Number(policy.headers.get('x-workspace-max-files'))
      const totalMaximum = Number(policy.headers.get('x-workspace-max-total-bytes'))
      const fileMaximum = Number(policy.headers.get('x-workspace-max-file-bytes'))
      const total = files.reduce((sum, item) => sum + item.file.size, 0)
      if (!policy.ok || ![maximum, totalMaximum, fileMaximum].every(value => Number.isSafeInteger(value) && value > 0)
        || files.length > maximum || total > totalMaximum
        || files.some(item => item.file.size > Math.min(maxFileBytes, fileMaximum))) throw new Error('upload-too-large')
      const directories = new Map<string, string>([['', directory]])
      const ensure = async (parts: string[]): Promise<string> => {
        let key = '', parent = directory
        for (const name of parts) {
          key = key ? `${key}/${name}` : name
          const known = directories.get(key)
          if (known !== undefined) parent = known
          else {
            parent = await createDirectory(id, parent, name, control)
            directories.set(key, parent)
          }
        }
        return parent
      }
      let complete = 0
      for (const item of files) {
        control.throwIfAborted()
        const parts = item.path.split('/')
        if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('invalid-path')
        const name = parts.pop()
        if (name === undefined) throw new Error('invalid-path')
        const parent = await ensure(parts)
        const query = new URLSearchParams({ sessionId: id, name, directory: parent, workspaceOnly: 'true' })
        const response = await fetch(`api/session/uploadFileBinary?${query}`, { method: 'POST',
          headers: { 'content-type': 'application/octet-stream' }, body: item.file, signal: control })
        const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readResponse(response, maxMetadataBytes, control)))
        if (!response.ok || result === null || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
          throw new Error('upload-unconfirmed')
        }
        complete += item.file.size
        progress(complete, total)
      }
    },
  }
  ctx.provide('workspaceFileManagement', Object.freeze(management))
}
