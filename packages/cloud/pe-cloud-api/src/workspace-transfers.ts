/** Account-selected HTTP responses over the existing files worker; bytes never enter Remote JSON. */
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { ZipFile } from 'yazl'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AccountFileSelection, CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import type { WorkspaceTransferLimits } from './types.ts'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Trusted native Session selection and exact files owner, repeated at actual I/O. */
export type WorkspaceTransferSelection = AccountFileSelection & { readonly files: CloudAccountFiles }
/** Existing API account and storage admission; request paths confer no authority. */
export type SelectWorkspaceTransfer = (id: SessionId, signal: AbortSignal) => Promise<WorkspaceTransferSelection>

const DOWNLOAD = '/api/workspace-files/download'
const DIRECTORY = '/api/workspace-files/directory'

function relative(path: string, root: string, maximum: number): string {
  if (Buffer.byteLength(path) > maximum || path.includes('\0') || path.includes('\\')
    || path.split('/').includes('..')) throw new Error('invalid-path')
  const value = posix.isAbsolute(path) ? posix.relative(root, path) : posix.normalize(path)
  if (value === '..' || value.startsWith('../') || posix.isAbsolute(value)
    || value.split('/').includes('.pe')) throw new Error('invalid-path')
  return value || '.'
}

/**
 * Register optional exact HTTP transfer routes in the existing account API fiber.
 * @param ctx Original native WorkspaceFiles Loader scope and Connection registry.
 * @param limits Explicit deployment limits, independently bounded by disk quota and files worker capacities.
 * @param select Original native Session/project selector.
 * @param admit Actual API exposure and graph check, repeated during response production.
 * @param lifetime Original account lifetime.
 * @returns Exact installed route declarations for the existing exposure audit.
 */
export function registerWorkspaceTransfers(ctx: Context, limits: WorkspaceTransferLimits,
  select: SelectWorkspaceTransfer, admit: (method: string, path: string) => void, lifetime: AbortSignal): readonly import('./types.ts').ExactFetchExposure[] {
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)
    || limits.chunkBytes > limits.maxFileBytes || limits.maxFileBytes > limits.maxTotalBytes
    || limits.timeoutMs > 2_147_483_647) throw new RangeError('Invalid workspace transfer limits.')
  const installed = new AbortController()
  ctx.effect(() => () => { installed.abort() }, 'workspace HTTP transfer lifetime')
  const routes = [
    { method: 'GET', path: DOWNLOAD }, { method: 'HEAD', path: DOWNLOAD }, { method: 'POST', path: DIRECTORY },
  ] as const
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const signal = AbortSignal.any([request.signal, lifetime, installed.signal, AbortSignal.timeout(limits.timeoutMs)])
    let output: Readable | undefined
    const current = (): void => { signal.throwIfAborted(); admit(request.method, url.pathname) }
    try {
      current()
      const id = url.searchParams.get('sessionId')
      if (!id || Buffer.byteLength(request.url) > limits.maxFiles * limits.maxPathBytes + 4096) throw new Error('invalid-request')
      const selected = await select(brandString<SessionId>(id), signal)
      const check = (): void => { current(); selected.assertCurrent() }
      check()
      if (url.pathname === DIRECTORY) {
        const directory = relative(url.searchParams.get('directory') ?? '.', selected.workspace.path, limits.maxPathBytes)
        const path = await selected.files.createWorkspaceDirectory(selected.workspace, directory,
          url.searchParams.get('name') ?? '', check, signal)
        check()
        return Response.json({ ok: true, path }, { headers: { 'cache-control': 'no-store' } })
      }
      const paths = url.searchParams.getAll('path')
      if (paths.length === 0 && request.method === 'HEAD') return new Response(null, { headers: {
        'x-workspace-max-files': String(limits.maxFiles), 'x-workspace-max-total-bytes': String(limits.maxTotalBytes),
        'x-workspace-max-file-bytes': String(limits.maxFileBytes), 'cache-control': 'no-store' } })
      if (paths.length < 1 || paths.length > limits.maxFiles) throw new Error('invalid-request')
      const backend = await selected.files.workspaceContent(selected.workspace, check, signal)
      const entries: { path: string; size: number; version: string }[] = []
      const seen = new Set<string>()
      let total = 0
      for (const raw of paths) {
        const path = relative(raw, selected.workspace.path, limits.maxPathBytes)
        if (path === '.' || seen.has(path)) throw new Error('invalid-path')
        seen.add(path)
        const held = await backend.lstat(path, signal)
        try {
          check()
          const info = held.value
          if (info?.type !== 'file' || info.size === undefined || info.size > limits.maxFileBytes) throw new Error('invalid-file')
          total += info.size
          if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) throw new Error('too-large')
          entries.push({ path, size: info.size, version: info.version })
        } finally { held.release() }
      }
      const verify = async (entry: typeof entries[number]): Promise<void> => {
        check()
        const held = await backend.lstat(entry.path, signal)
        try {
          check()
          if (held.value?.version !== entry.version || held.value.size !== entry.size) throw new Error('file-changed')
        } finally { held.release() }
      }
      const bytes = async function* (entry: typeof entries[number]) {
        for (let offset = 0; offset < entry.size;) {
          await verify(entry)
          const held = await backend.readByteRange(entry.path,
            { offset, length: Math.min(limits.chunkBytes, entry.size - offset) }, signal)
          try {
            check()
            if (!held.value.byteLength) throw new Error('incomplete-file')
            offset += held.value.byteLength
            yield held.value
          } finally { held.release() }
        }
        await verify(entry)
      }
      const single = entries.length === 1 ? entries[0] : undefined
      const filename = single === undefined ? 'workspace.zip' : posix.basename(single.path)
      const headers: Record<string, string> = { 'content-type': single === undefined ? 'application/zip' : 'application/octet-stream',
        'content-disposition': `attachment; filename="download${single === undefined ? '.zip' : ''}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
      if (single !== undefined) headers['content-length'] = String(single.size)
      if (request.method === 'HEAD') return new Response(null, { headers })
      let stream: Readable
      if (single !== undefined) stream = Readable.from(bytes(single), { objectMode: false, highWaterMark: limits.chunkBytes })
      else {
        const zip = new ZipFile()
        const sources = new Set<Readable>()
        stream = zip.outputStream as Readable
        zip.on('error', (error: Error) => { stream.destroy(error) })
        stream.once('close', () => { for (const source of sources) source.destroy() })
        for (const entry of entries) zip.addReadStreamLazy(entry.path, { size: entry.size, compress: false }, (callback) => {
          try {
            check()
            const source = Readable.from(bytes(entry), { objectMode: false, highWaterMark: limits.chunkBytes })
            sources.add(source)
            source.once('close', () => { sources.delete(source) })
            callback(null, source)
          } catch (error) { callback(error instanceof Error ? error : new Error('file-unavailable'), Readable.from([])) }
        })
        zip.end()
      }
      output = stream
      const abort = (): void => { stream.destroy(new Error('transfer-aborted')) }
      signal.addEventListener('abort', abort, { once: true })
      stream.once('close', () => { signal.removeEventListener('abort', abort) })
      if (signal.aborted) abort()
      check()
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers })
    } catch (_error) {
      output?.destroy()
      // A directory may already be committed if a post-publication check failed. Never promise rollback/retry.
      return Response.json({ ok: false, code: signal.aborted ? 'transfer/cancelled-or-unknown' : 'transfer/failed',
        outcome: url.pathname === DIRECTORY ? 'unknown' : 'not-started' }, { status: 400, headers: { 'cache-control': 'no-store' } })
    }
  }
  ctx.connection.fetch.register({ path: DOWNLOAD, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: handle })
  ctx.connection.fetch.register({ path: DIRECTORY, methods: ['POST'], requestBody: 'buffered', fetch: handle })
  return routes.map(route => ({ ...route, handlerId: 'native:workspaceFiles', guard: 'account-session' as const }))
}
