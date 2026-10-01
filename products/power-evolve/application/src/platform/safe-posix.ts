/** Bounded, one-shot bridge to Python's POSIX dir_fd operations. */
import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlatformError } from '../contracts.ts'

const MAX_IPC_BYTES = 4 * 1024 * 1024
const MAX_ACTIVE = 8
const HELPER = fileURLToPath(new URL('../../src/platform/safe-posix.py', import.meta.url))

export interface SafePosixOptions { executable?: string; timeoutMs?: number }
type Operation = 'probe' | 'ensure_workspace' | 'kind' | 'read' | 'list' | 'put'
interface Request {
  op: Operation; root: string; owner?: { uid: number; gid: number }; workspaceId?: string
  parts?: string[]; data?: string; digest?: string; baseRevision?: string | null; priorSameDigest?: boolean
}
interface Response { ok: boolean; code?: string; value?: unknown }

function unavailable(): PlatformError { return new PlatformError(503, 'workspace_unavailable') }

const statuses: Record<string, number> = {
  invalid_path: 400, invalid_file_data: 400, file_not_found: 404,
  file_revision_conflict: 409, file_too_large: 413, directory_too_large: 413,
  workspace_unavailable: 503,
}

/** Each call has a fresh process, a scrubbed environment, a hard deadline and bounded IPC. */
export class SafePosix {
  private root: string
  private readonly presentedRoot: string
  private active = 0
  private readonly executable: string
  private readonly timeoutMs: number
  constructor(root: string, private readonly owner?: { uid: number; gid: number }, options: SafePosixOptions = {}) {
    this.root = resolve(root)
    this.presentedRoot = this.root
    this.executable = options.executable ?? 'python3'
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  async init(): Promise<void> {
    const stat = await lstat(this.root).catch(() => { throw unavailable() })
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable()
    this.root = await realpath(this.root).catch(() => { throw unavailable() })
    const probe = await this.call({ op: 'probe', root: this.root }) as { ready?: boolean; python?: string }
    if (probe?.ready !== true || typeof probe.python !== 'string') throw unavailable()
  }

  path(workspaceId: string): string { return resolve(this.presentedRoot, workspaceId) }

  async ensureWorkspace(workspaceId: string): Promise<void> {
    await this.call({ op: 'ensure_workspace', root: this.root, workspaceId,
      ...(this.owner ? { owner: this.owner } : {}) })
  }

  async kind(workspaceId: string, parts: string[]): Promise<'file' | 'directory'> {
    const result = await this.call({ op: 'kind', root: this.root, workspaceId, parts,
      ...(this.owner ? { owner: this.owner } : {}) }) as { kind: 'file' | 'directory' }
    if (result?.kind !== 'file' && result?.kind !== 'directory') throw unavailable()
    return result.kind
  }

  async read(workspaceId: string, parts: string[], signal?: AbortSignal): Promise<Buffer | null> {
    const result = await this.call({ op: 'read', root: this.root, workspaceId, parts,
      ...(this.owner ? { owner: this.owner } : {}) }, signal) as { data: string | null }
    if (result?.data === null) return null
    if (typeof result?.data !== 'string' || result.data.length > MAX_IPC_BYTES) throw unavailable()
    const bytes = Buffer.from(result.data, 'base64')
    if (bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== result.data) throw unavailable()
    return bytes
  }

  async list(workspaceId: string, parts: string[]): Promise<{ missing: boolean; items: Array<{
    name: string; kind: 'file' | 'directory'; size: number | null; updatedAt: string
  }> }> {
    const result = await this.call({ op: 'list', root: this.root, workspaceId, parts,
      ...(this.owner ? { owner: this.owner } : {}) }) as {
      missing: boolean; items: Array<{ name: string; kind: 'file' | 'directory'; size: number | null; updatedAt: string }>
    }
    if (typeof result?.missing !== 'boolean' || !Array.isArray(result.items) || result.items.length > 200
      || result.items.some(item => typeof item.name !== 'string' || item.name.includes('/') || item.name.includes('\0')
        || !['file', 'directory'].includes(item.kind) || typeof item.updatedAt !== 'string'
        || item.size !== null && (!Number.isSafeInteger(item.size) || item.size < 0))) throw unavailable()
    return result
  }

  async put(workspaceId: string, parts: string[], data: string, digest: string,
    baseRevision: string | null, priorSameDigest: boolean): Promise<void> {
    const result = await this.call({ op: 'put', root: this.root, workspaceId, parts, data, digest,
      baseRevision, priorSameDigest, ...(this.owner ? { owner: this.owner } : {}) }) as { written: boolean }
    if (typeof result?.written !== 'boolean') throw unavailable()
  }

  private async call(request: Request, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    if (this.active >= MAX_ACTIVE) throw unavailable()
    this.active += 1
    try { return await this.dispatch(request, signal) }
    finally { this.active -= 1 }
  }

  private async dispatch(request: Request, signal?: AbortSignal): Promise<unknown> {
    const payload = JSON.stringify(request)
    if (Buffer.byteLength(payload) > MAX_IPC_BYTES) throw unavailable()
    const output = await new Promise<Buffer>((resolveResult, rejectResult) => {
      let done = false, tooLarge = false, timedOut = false, processError = false, total = 0
      const chunks: Buffer[] = []
      let child
      try {
        child = spawn(this.executable, ['-I', '-B', HELPER], { shell: false, windowsHide: true,
          cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'C', LC_ALL: 'C' },
          stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (_error) { rejectResult(unavailable()); return }
      const finish = (error?: Error, value?: Buffer) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) rejectResult(error)
        else resolveResult(value!)
      }
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, this.timeoutMs)
      // Keep the operation active until close confirms the killed helper has exited.
      const abort = () => { child.kill('SIGKILL') }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_IPC_BYTES) { tooLarge = true; child.kill('SIGKILL') }
        else chunks.push(chunk)
      })
      child.stderr.on('data', () => { /* Drain without exposing filesystem paths or private data. */ })
      child.stdin.on('error', () => { /* The close/error event below owns the outcome. */ })
      child.once('error', () => { processError = true; child.kill('SIGKILL') })
      child.once('close', code => finish(signal?.aborted
        ? signal.reason instanceof Error ? signal.reason : new DOMException('Download canceled', 'AbortError')
        : code === 0 && !tooLarge && !timedOut && !processError ? undefined : unavailable(),
        tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks, total)))
      child.stdin.end(payload)
    })
    let response: Response
    try { response = JSON.parse(output.toString('utf8')) as Response }
    catch (_error) { throw unavailable() }
    if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') throw unavailable()
    if (!response.ok) {
      const code = response.code
      if (typeof code !== 'string' || !(code in statuses)) throw unavailable()
      throw new PlatformError(statuses[code]!, code)
    }
    return response.value
  }
}
