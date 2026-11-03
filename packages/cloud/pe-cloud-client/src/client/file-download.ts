/** Browser-native attachments with bounded HEAD preflight; content never enters JavaScript memory. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileUploadFetch } from '@deepseek-ai/dsh-client-file-upload/types'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/** Immutable page and native resource occurrence. */
export interface CloudFileDownloadInput {
  readonly sessionId: SessionId
  readonly resourceAddress: string
  readonly paths?: readonly string[]
  readonly signal: AbortSignal
  readonly fetch: FileUploadFetch
  readonly navigationUrl: (path: string) => string
  readonly maxFileBytes: number
}
/** Browser handoff does not confirm operating-system persistence. */
export type CloudFileDownloadResult = { readonly kind: 'started' | 'cancelled' | 'busy' }
  | { readonly kind: 'failed'; readonly reason: 'invalid-resource' | 'too-large' | 'incomplete' | 'native' | 'browser'; readonly cause?: unknown }

/** One preflight at a time; browser owns download progress, cancellation and failure after handoff. */
export class CloudFileDownload {
  private readonly control = new AbortController()
  private active: Promise<CloudFileDownloadResult> | undefined
  constructor(private readonly input: CloudFileDownloadInput) {
    if (!Number.isSafeInteger(input.maxFileBytes) || input.maxFileBytes < 1) throw new RangeError('A positive finite limit is required.')
  }
  /** Start one browser attachment after its authorized preflight.
   * @returns Preflight result or native browser handoff; no file bytes are fetched by JavaScript. */
  save(): Promise<CloudFileDownloadResult> {
    if (this.input.signal.aborted || this.control.signal.aborted) return Promise.resolve({ kind: 'cancelled' })
    if (this.active !== undefined) return Promise.resolve({ kind: 'busy' })
    const task = this.perform()
    this.active = task
    void task.finally(() => { if (this.active === task) this.active = undefined })
    return task
  }
  /** Cancel this occurrence before browser handoff.
   * @returns Settlement of preflight cancellation; browser downloads are cancelled in the browser download UI. */
  async cancel(): Promise<void> { this.control.abort(); await this.active }
  /** End this occurrence and join its preflight.
   * @returns Actual preflight settlement after this resource occurrence is withdrawn. */
  async dispose(): Promise<void> { await this.cancel() }
  private async perform(): Promise<CloudFileDownloadResult> {
    const { input } = this
    const signal = AbortSignal.any([input.signal, this.control.signal])
    try {
      const file = parseFileAddress(input.resourceAddress)
      if (file?.scope !== 'session' || file.sessionId !== input.sessionId || !file.path) return { kind: 'failed', reason: 'invalid-resource' }
      const query = new URLSearchParams({ sessionId: input.sessionId })
      for (const path of input.paths ?? [file.path]) query.append('path', path)
      const path = `api/workspace-files/download?${query}`
      const response = await input.fetch(path, { method: 'HEAD', signal })
      await response.body?.cancel()
      signal.throwIfAborted()
      if (!response.ok) return { kind: 'failed', reason: 'native' }
      if ((input.paths?.length ?? 1) === 1 && Number(response.headers.get('content-length')) > input.maxFileBytes) {
        return { kind: 'failed', reason: 'too-large' }
      }
      const anchor = document.createElement('a')
      anchor.href = input.navigationUrl(path)
      anchor.download = ''
      anchor.rel = 'noopener'
      anchor.hidden = true
      document.body.append(anchor)
      try { anchor.click() } finally { anchor.remove() }
      return { kind: 'started' }
    } catch (cause) { return signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', reason: 'browser', cause } }
  }
}
