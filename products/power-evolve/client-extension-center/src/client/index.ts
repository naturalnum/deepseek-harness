import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SkillHttpClient } from './skills-api.ts'
import { fillSkillDraft, skillInvocationName } from './skill-try.ts'
import { SkillsPage } from './SkillsPage.tsx'
import { SkillsPanelIcon } from './SkillsPanelIcon.tsx'
import { ConnectorConfiguration } from './ConnectorConfiguration.tsx'
import { PersonalMcpConnectionHttpClient } from './personal-mcp-api.ts'
import { personalMcpSessionSource } from './personal-mcp-session-view.ts'
import { StdioV2HttpClient } from './stdio-v2-api.ts'
import { approvalUrl } from './approval-api.ts'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { en, NS, zh, type ExtensionCenterLocaleKey } from './locales.ts'
import { installExtensionCenterStyles } from './styles.ts'
import { CloudProjectDialog } from './CloudProjectDialog.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'powerEvolve.extensionCenter': ExtensionCenterLocaleKey }
}

export const SKILLS_PANEL_ID = 'power-evolve-skills'
export const inject = ['slots', 'locale', 'sessions', 'conversation', 'uiWorkspace']

/** Register cloud project creation, personal Skills and the official Host bundle configuration. */
export function apply(ctx: Context): void {
  const client = new SkillHttpClient()
  const personalMcp = new PersonalMcpConnectionHttpClient()
  const mcpSessions = personalMcpSessionSource(ctx.sessions)
  const stdioV2 = new StdioV2HttpClient()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'PowerEvolve extension center labels')
  ctx.effect(() => installExtensionCenterStyles(), 'PowerEvolve extension center styles')
  const t = ctx.locale.bind(NS)
  const projectPorts = () => ({
    createProjectDirectory: async (name: string) => {
      const { home } = await ctx.uiWorkspace.listDirectory()
      return ctx.uiWorkspace.createDirectory(home, name)
    },
  })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', locale: NS, priority: -10,
        inject: projectPorts }, CloudProjectDialog)
      yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', locale: NS, priority: -10,
        inject: projectPorts }, CloudProjectDialog)
    }))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: SKILLS_PANEL_ID, locale: NS, inject: () => ({ client,
      trySkill: (skill: import('./skills-api.ts').PersonalSkill) => fillSkillDraft(ctx,
        t('skillTryPrompt').replace('{alias}', skillInvocationName(skill)).replace('{name}', skill.name)) }),
  }, SkillsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: SKILLS_PANEL_ID, order: 20,
    locale: NS, label: () => t('skillsNav'),
  }, SkillsPanelIcon))
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'power-evolve-mcp', order: 50, label: () => t('mcpPluginTitle'), locale: NS,
    inject: () => ({ personalMcp, sessions: mcpSessions, stdioV2, approvalUrl }),
  }, ConnectorConfiguration))
}
