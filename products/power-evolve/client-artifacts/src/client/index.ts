/** Native publication, verified execution rows and closing-scoped inline file actions. */
import type { ChatFileMentions, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Session } from '@deepseek-ai/dsh-api-session-controller/client'
import { ExecutionFacts, filesForClosing, producedFileKey } from './execution-facts.ts'
import { artifactDefinition, basename, referencesForClosing, resolveArtifactMention } from './produced-artifacts.ts'
import { ProducedArtifacts } from './ProducedArtifacts.tsx'
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
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'workspaces', 'uiConversation', 'conversation', 'sessions']

/** Register native artifact contributions.
 * @param ctx - owning plugin context and its scoped native services.
 */
export function apply(ctx: Context): void {
  const client = new ArtifactHttpClient()
  const changed = new EventTarget()
  const t = ctx.locale.bind(namespace)
  const facts = new ExecutionFacts(client, () => { changed.dispatchEvent(new Event('published')) }, (sessionId, changed) => {
    const scope = ctx.sessions.scope(sessionId)
    if (scope !== undefined) ctx.conversation.input.for(scope).notify('error', t(changed ? 'sourceChanged' : 'publishFailed'))
  })
  ctx.effect(() => () => { facts.dispose() }, 'PowerEvolve execution observations')
  ctx.uiConversation.events.register(artifactDefinition)
  const mentions = {
    changesForSession: (sessionId: Session['sessionId']) => facts.changesForSession(sessionId),
    forClosing: (owner, sessionId) => {
      const source = facts.forClosing(sessionId, owner)
      const references = referencesForClosing(owner, true)
      return { resolve: value => {
        const snapshot = source.getSnapshot()
        const file = resolveArtifactMention(filesForClosing(snapshot, references), value)
        if (file === undefined) return undefined
        const state = snapshot.publications[producedFileKey(file)]
        return { label: state === 'busy' ? t('publishing') : basename(file.path),
          title: state === 'changed' ? t('sourceChanged') : `${t('publishDownload')}: /workspace/${file.path}`,
          open: () => { if (state !== 'changed') void source.publish(file) } }
      } }
    },
  } satisfies ChatFileMentions
  ctx.provide('chatFileMentions', mentions)
  ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'power-evolve-produced-artifacts', order: 20, locale: namespace,
    inject: (sessionId: Session['sessionId']) => ({
      forClosing: (owner: TurnTailOwnerProps) => {
        const source = facts.forClosing(sessionId, owner)
        return { key: source.key, refresh: source.refresh, publish: source.publish }
      },
      keyedHooks: { closingFacts: (key: string) => facts.source(sessionId, key) },
    }),
  }, ProducedArtifacts)), 'PowerEvolve native execution file rows')
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'PowerEvolve artifact labels')
  ctx.effect(() => installArtifactStyles(), 'PowerEvolve artifact styles')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id, kind, priority: 'builtin', title: () => t('title'),
    guide: [{ id: 'artifacts', order: 20, title: () => t('guide'), description: () => t('guideDescription') }],
  }), 'PowerEvolve artifact tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: id, locale: namespace,
    inject: (sessionId: Session['sessionId']) => ({
      sessionId, client, changed,
      workspaceId: ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.some(id => id === sessionId))?.workspaceId,
    }),
  }, ArtifactsTab))
  ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'power-evolve-artifact-publish', order: 30,
    locale: namespace,
    inject: (sessionId: Session['sessionId']) => ({ sessionId, client, onPublished: () => {
      changed.dispatchEvent(new Event('published'))
      ctx.sidebarRight.openTab(kind)
    } }),
  }, PublishAction))
}
