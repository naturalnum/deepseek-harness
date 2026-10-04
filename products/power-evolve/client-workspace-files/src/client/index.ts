/** PowerEvolve file controls in the native DSH composer, preview and Files tree. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PreviewEdit } from './PreviewEdit.tsx'
import { PreviewDownload } from './PreviewDownload.tsx'
import { WorkspaceFileButton, type WorkspaceFileActions } from './WorkspaceFileButton.tsx'
import { en, zh, type WorkspaceFileLocaleKey } from './locales.ts'
import { installWorkspaceFileStyles } from './styles.ts'
import { WorkspaceFileHttpClient } from './workspace-file-client.ts'
import { WorkspaceFileDownloadClient } from './workspace-file-download.ts'
import { WorkspaceFileEditorClient } from './workspace-file-editor.ts'
import { FileDownload, FileSelection } from './DownloadControls.tsx'
import { createDownloadSelectionStore } from './download-selection.ts'
import { WorkspaceDownloadClient } from './download-client.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'powerEvolve.workspaceFiles': WorkspaceFileLocaleKey
  }
}

const namespace = 'powerEvolve.workspaceFiles'
type SessionId = Session['sessionId']

/** Native slot and locale services required by the file adapter. */
export const inject = ['slots', 'locale']

/**
 * Register native file actions authorized by the product HTTP API.
 * @param ctx - Client plugin context owning all registrations.
 */
export function apply(ctx: Context): void {
  const client = new WorkspaceFileHttpClient()
  const downloads = new WorkspaceFileDownloadClient()
  const editor = new WorkspaceFileEditorClient(downloads)
  const batchDownloads = new WorkspaceDownloadClient()
  const selection = createDownloadSelectionStore()
  const selectionLifetime = new AbortController()
  const boundSignals = new WeakSet<AbortSignal>()
  ctx.effect(() => () => { selectionLifetime.abort() }, 'PowerEvolve selection lifetimes')
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'PowerEvolve file labels')
  ctx.effect(() => installWorkspaceFileStyles(), 'PowerEvolve file styles')
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'power-evolve-workspace-file', order: 20,
    locale: namespace,
    inject: (sessionId: SessionId): WorkspaceFileActions => ({
      capabilities: () => client.capabilities(),
      upload: (file, signal) => client.upload(sessionId, file, signal),
    }),
  }, WorkspaceFileButton)), 'PowerEvolve composer file upload')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'power-evolve-workspace-edit', order: 10,
    locale: namespace, inject: (sessionId: string) => ({ sessionId, client: editor }),
  }, PreviewEdit)), 'PowerEvolve file preview editor')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'power-evolve-workspace-download', order: 20,
    locale: namespace, inject: (sessionId: string) => ({ sessionId, client: downloads }),
  }, PreviewDownload)), 'PowerEvolve file preview download')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.files.entry.leading', () => ctx.slots.register({
    name: 'sidebar.right.tab.files.entry.leading', id: 'power-evolve-file-selection', order: 10,
    locale: namespace, store: selection,
  }, FileSelection)), 'PowerEvolve native Files selection')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.files.actions', id: 'power-evolve-files-download', order: 10,
    locale: namespace, store: selection,
    inject: (_sessionId, actions) => ({
      prepareDownload: batchDownloads.prepare.bind(batchDownloads),
      bindSelection: (tabId: string, signal: AbortSignal) => {
        if (signal.aborted) { actions.forget(tabId); return }
        if (boundSignals.has(signal)) return
        boundSignals.add(signal)
        const forget = (): void => { actions.forget(tabId); detach() }
        const detach = (): void => {
          signal.removeEventListener('abort', forget)
          selectionLifetime.signal.removeEventListener('abort', detach)
        }
        signal.addEventListener('abort', forget, { once: true })
        selectionLifetime.signal.addEventListener('abort', detach, { once: true })
      },
    }),
  }, FileDownload)), 'PowerEvolve native Files batch download')
}
