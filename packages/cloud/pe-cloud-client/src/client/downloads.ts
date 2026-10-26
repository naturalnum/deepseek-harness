/** Optional download actions bound to one original prepared page and actual native Remote. */
import { observeCloudDisposal } from './observe-disposal.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import { FileDownloadAction, type FileDownloadActionInjected } from './FileDownloadAction.tsx'
import { DOWNLOAD_NAMESPACE, downloadDictionaries } from './download/locales.ts'
import { ClientFailure } from './errors.ts'

/** Readonly original page facts; production supplies the real validated PreparedCloudPage. */
export interface FileDownloadPage {
  readonly maxDownloadBytes: number | undefined
  readonly bootstrap: { readonly capabilities: Pick<CloudBootstrap['capabilities'], 'filePreview'> }
  readonly lifetime: { readonly transport: { readonly signal: AbortSignal } }
}

const holes = ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable'] as const

/**
 * Install exact native preview action lists only with explicit cap and available preview metadata.
 * @param ctx Actual Cloud Loader entry; all registrations leave with its dependency/declaration scopes.
 * @param page Original prepared page, never a mutable current-account or current-Session lookup.
 */
export function installCloudFileDownloads(ctx: Context, page: FileDownloadPage): void {
  const maximum = page.maxDownloadBytes
  if (maximum === undefined || page.bootstrap.capabilities.filePreview.state !== 'available') return
  const signal = page.lifetime.transport.signal
  const revoked = (): boolean => signal.aborted
  if (revoked()) return
  const dependency = ctx.inject(['slots', 'locale', 'remote', 'remote.workspaceFiles'], (owner) => {
    if (revoked()) return
    const namespace = owner.remote.workspaceFiles
    const nativeReadBytes = namespace.readBytes.bind(namespace)
    owner.effect(() => {
      const disposers: (() => void)[] = []
      try {
        for (const [locale, dictionary] of Object.entries(downloadDictionaries)) {
          disposers.push(owner.locale.register(DOWNLOAD_NAMESPACE, locale, dictionary))
        }
      } catch (cause) {
        for (const dispose of disposers.reverse()) dispose()
        throw cause
      }
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'pe-cloud-client: download dictionaries')
    for (const hole of holes) {
      owner.slots.inject(hole, () => {
        if (revoked()) return () => {}
        let registered = true
        const current = (): void => {
          if (!registered || revoked()) throw new ClientFailure('closed')
          owner.fiber.assertActive()
        }
        const injected: FileDownloadActionInjected = {
          signal, maxFileBytes: maximum,
          readBytes: async (...args) => {
            current()
            const result = await nativeReadBytes(...args)
            current()
            return result
          },
        }
        const remove = owner.slots.register({ name: hole, id: 'cloud-download', locale: DOWNLOAD_NAMESPACE,
          inject: () => injected }, FileDownloadAction)
        return () => { registered = false; remove() }
      })
    }
  })
  const stop = (): void => {
    void observeCloudDisposal(dependency.dispose).catch((error: unknown) => { console.error('Cloud download withdrawal unconfirmed:', error) })
  }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => {
    signal.removeEventListener('abort', stop)
    await dependency.dispose()
  }, 'pe-cloud-client: withdraw downloads')
  if (revoked()) stop()
}
