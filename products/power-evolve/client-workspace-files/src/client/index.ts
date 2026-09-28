/** PowerEvolve upload control in the native DSH conversation composer. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PreviewDownload } from './PreviewDownload.tsx'
import { WorkspaceFileButton, type WorkspaceFileActions } from './WorkspaceFileButton.tsx'
import { en, zh, type WorkspaceFileLocaleKey } from './locales.ts'
import { installWorkspaceFileStyles } from './styles.ts'
import { WorkspaceFileHttpClient } from './workspace-file-client.ts'
import { WorkspaceFileDownloadClient } from './workspace-file-download.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'powerEvolve.workspaceFiles': WorkspaceFileLocaleKey
  }
}

const namespace = 'powerEvolve.workspaceFiles'
type SessionId = Session['sessionId']

export const inject = ['slots', 'locale', 'workspaces']

export function apply(ctx: Context): void {
  const client = new WorkspaceFileHttpClient()
  const downloads = new WorkspaceFileDownloadClient()
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'PowerEvolve file labels')
  ctx.effect(() => installWorkspaceFileStyles(), 'PowerEvolve file styles')
  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'power-evolve-workspace-file', order: 20,
    locale: namespace,
    inject: (sessionId: SessionId): WorkspaceFileActions => ({
      capabilities: () => client.capabilities(),
      upload: async (file, signal) => {
        const workspace = ctx.workspaces.list.getSnapshot().items.find(
          item => item.sessionIds.includes(sessionId),
        )
        if (workspace === undefined) throw new Error('Current Session has no active Workspace')
        // The first cloud slice has one persistent Workspace per user. The
        // platform derives its owner from the authenticated request cookie.
        return client.upload(file, signal)
      },
    }),
  }, WorkspaceFileButton)), 'PowerEvolve composer file upload')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'power-evolve-workspace-download', order: 20,
    locale: namespace, inject: () => ({ client: downloads }),
  }, PreviewDownload)), 'PowerEvolve file preview download')
}
