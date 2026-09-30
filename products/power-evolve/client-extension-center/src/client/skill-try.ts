import type { Context } from '@deepseek-ai/cordis'
import type { PersonalSkill } from './skills-api.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { powerEvolveSkillTry: unknown }
}

/** Open a fresh native Conversation in the default cloud Workspace with an editable skill prompt. */
export async function fillSkillDraft(ctx: Context, prompt: string): Promise<void> {
  const sessionId = await ctx.sessions.create()
  await ctx.sessions.using(sessionId, { source: 'powerEvolveSkillTry' }, reference => {
    const scope = ctx.sessions.scope(reference.sessionId)
    if (scope === undefined) throw new Error('Skill trial session unavailable')
    ctx.conversation.input.for(scope).setDraft(prompt)
    ctx.uiWorkspace.openSession(reference.sessionId)
  })
}

/** Match the Host's stable native invocation alias while keeping the original display name. */
export function skillInvocationName(skill: Pick<PersonalSkill, 'skillId' | 'name'>): string {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.name) && !skill.name.startsWith('pe-user-skill-')
    ? skill.name : `pe-user-skill-${skill.skillId}`
}
