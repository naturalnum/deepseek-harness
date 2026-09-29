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
import { fillSkillDraft } from './skill-try.ts'
import { SkillsPage } from './SkillsPage.tsx'
import { SkillsPanelIcon } from './SkillsPanelIcon.tsx'
import { PluginsPage } from './PluginsPage.tsx'
import { PluginsPanelIcon } from './PluginsPanelIcon.tsx'
import { PluginHttpClient, approvalUrl } from './plugins-api.ts'
import { FixedMcpHttpClient } from './mcp-api.ts'
import { StdioMcpHttpClient } from './stdio-mcp-api.ts'
import { PersonalSshHttpClient } from './ssh-api.ts'
import { en, NS, zh, type ExtensionCenterLocaleKey } from './locales.ts'
import { installExtensionCenterStyles } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'powerEvolve.extensionCenter': ExtensionCenterLocaleKey }
}

export const SKILLS_PANEL_ID = 'power-evolve-skills'
export const PLUGINS_PANEL_ID = 'power-evolve-plugins'
export const inject = ['slots', 'locale', 'sessions', 'conversation', 'uiWorkspace']

/** Register the personal Skills and Plugins pages in the native DSH Web shell. */
export function apply(ctx: Context): void {
  const client = new SkillHttpClient()
  const plugins = new PluginHttpClient()
  const mcp = new FixedMcpHttpClient()
  const stdio = new StdioMcpHttpClient()
  const ssh = new PersonalSshHttpClient()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'PowerEvolve extension center labels')
  ctx.effect(() => installExtensionCenterStyles(), 'PowerEvolve extension center styles')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: SKILLS_PANEL_ID, locale: NS, inject: () => ({ client,
      trySkill: (skill: import('./skills-api.ts').PersonalSkill) => fillSkillDraft(ctx,
        t('skillTryPrompt').replace('{name}', skill.name)) }),
  }, SkillsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: SKILLS_PANEL_ID, order: 20,
    locale: NS, label: () => t('skillsNav'),
  }, SkillsPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PLUGINS_PANEL_ID, locale: NS, inject: () => ({ plugins, mcp, stdio, ssh, approvalUrl }),
  }, PluginsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PLUGINS_PANEL_ID, order: 21,
    locale: NS, label: () => t('pluginsNav'),
  }, PluginsPanelIcon))
}
