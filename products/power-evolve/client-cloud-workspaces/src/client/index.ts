import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CloudWorkspaceFlow } from './CloudWorkspaceFlow.tsx'
import { en, zh, type CloudWorkspaceLocaleKey } from './locales.ts'
import { installCloudWorkspaceStyles } from './styles.ts'
import { createWorkspaceBindingActions } from './api.ts'
import { createCloudWorkspaceStore } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'powerEvolve.cloudWorkspaces': CloudWorkspaceLocaleKey }
}

const namespace = 'powerEvolve.cloudWorkspaces'
export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  const store = createCloudWorkspaceStore()
  const operations = createWorkspaceBindingActions()
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'PowerEvolve cloud Workspace labels')
  ctx.effect(() => installCloudWorkspaceStyles(), 'PowerEvolve cloud Workspace styles')
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', locale: namespace,
        store, inject: () => operations }, CloudWorkspaceFlow)
      yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', locale: namespace,
        store, inject: () => operations }, CloudWorkspaceFlow)
    }))
}
