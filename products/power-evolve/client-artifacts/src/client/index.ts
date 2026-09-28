import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ArtifactHttpClient } from './api.ts'
import { ArtifactsTab } from './ArtifactsTab.tsx'
import { en, zh, type ArtifactLocaleKey } from './locales.ts'
import { PublishAction } from './PublishAction.tsx'
import { installArtifactStyles } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'powerEvolve.artifacts': ArtifactLocaleKey }
}

const namespace = 'powerEvolve.artifacts'
const id = '@power-evolve/client-artifacts'
const kind = 'powerEvolveArtifacts'
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'workspaces']

export function apply(ctx: Context): void {
  const client = new ArtifactHttpClient()
  const changed = new EventTarget()
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'PowerEvolve artifact labels')
  ctx.effect(() => installArtifactStyles(), 'PowerEvolve artifact styles')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind, priority: 'builtin', title: () => t('title'),
    guide: [{ id: 'artifacts', order: 20, title: () => t('guide'), description: () => t('guideDescription') }],
  }), 'PowerEvolve artifact tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: id, locale: namespace,
    inject: (sessionId: string) => ({
      sessionId, client, changed,
      workspaceId: ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.some(id => id === sessionId))?.workspaceId,
    }),
  }, ArtifactsTab))
  ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'power-evolve-artifact-publish', order: 30,
    locale: namespace,
    inject: (sessionId: string) => ({ sessionId, client, onPublished: () => {
      changed.dispatchEvent(new Event('published'))
      ctx.sidebarRight.openTab(kind)
    } }),
  }, PublishAction))
}
