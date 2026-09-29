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
import { en, NS, zh, type ExtensionCenterLocaleKey } from './locales.ts'
import { installExtensionCenterStyles } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'powerEvolve.extensionCenter': ExtensionCenterLocaleKey }
}

export const SKILLS_PANEL_ID = 'power-evolve-skills'
export const inject = ['slots', 'locale', 'sessions', 'conversation', 'uiWorkspace']

/** The S4 personal Skills page; the S6 Plugins page will register in this package. */
export function apply(ctx: Context): void {
  const client = new SkillHttpClient()
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
}
