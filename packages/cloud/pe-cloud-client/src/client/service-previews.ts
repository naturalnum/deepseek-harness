/** Optional native Tool presentation captured from one original immutable Cloud page. */
import { observeCloudDisposal } from './observe-disposal.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { CloudBootstrap } from '@deepseek-ai/dsh-pe-cloud-access/types'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ServicePreviewRow, type ServicePreviewRowInjected } from './ServicePreviewRow.tsx'
import { SERVICE_PREVIEW_NAMESPACE, servicePreviewDictionaries } from './service-preview-locales.ts'
import type { CloudServicePreviewNavigation } from './service-preview.ts'

/** Production supplies the original PreparedCloudPage and its actual captured navigation function. */
export interface CloudServicePreviewPage {
  readonly bootstrap: { readonly capabilities: Pick<CloudBootstrap['capabilities'], 'servicePreview'> }
  readonly lifetime: { readonly transport: { readonly signal: AbortSignal } }
  readonly servicePreviewNavigation?: CloudServicePreviewNavigation
}

/**
 * Register the existing dev_service keyed slot only with an available capability and actual page carrier.
 * @param ctx Original Cloud browser Loader context.
 * @param page Original immutable page owner; no global current account or URL builder is consulted.
 */
export function installCloudServicePreviews(ctx: Context, page: CloudServicePreviewPage): void {
  const navigate = page.servicePreviewNavigation, signal = page.lifetime.transport.signal
  const aborted = (): boolean => signal.aborted
  if (navigate === undefined || page.bootstrap.capabilities.servicePreview.state !== 'available' || signal.aborted) return
  const dependency = ctx.inject(['slots', 'locale'], (owner) => {
    if (signal.aborted) return
    owner.effect(() => {
      const disposers: (() => void)[] = []
      try {
        for (const [locale, dictionary] of Object.entries(servicePreviewDictionaries)) {
          disposers.push(owner.locale.register(SERVICE_PREVIEW_NAMESPACE, locale, dictionary))
        }
      } catch (cause) {
        for (const dispose of disposers.reverse()) dispose()
        throw cause
      }
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'pe-cloud-client: service preview dictionaries')
    owner.slots.inject('tool.call.toolview', () => {
      if (signal.aborted) return () => {}
      let registered = true
      const injected: ServicePreviewRowInjected = {
        navigatePreview: (selection) => { if (registered && !signal.aborted) navigate(selection) },
      }
      const remove = owner.slots.register({ name: 'tool.call.toolview', key: 'dev_service', locale: SERVICE_PREVIEW_NAMESPACE,
        inject: () => injected }, ServicePreviewRow)
      return () => { registered = false; remove() }
    })
  })
  const stop = (): void => {
    void observeCloudDisposal(dependency.dispose).catch((error: unknown) => { console.error('Cloud service preview withdrawal unconfirmed:', error) })
  }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => {
    signal.removeEventListener('abort', stop)
    await dependency.dispose()
  }, 'pe-cloud-client: withdraw service preview row')
  if (aborted()) stop()
}
