import type { Context } from '@deepseek-ai/cordis'
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
