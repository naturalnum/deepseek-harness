/** Localized display of actual native metadata, without changing discovery or invocation. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillCard } from './types.ts'

/**
 * Localize known native source values while retaining unknown provider labels verbatim.
 * @param source Native source, or an existing account-supplied display label; absence remains absent.
 * @param t Skills copy for the current locale.
 * @returns A display label, or undefined when no source was supplied.
 */
export function skillSourceLabel(source: string | undefined, t: TranslateNS<'cloud-skill-management'>): string | undefined {
  switch (source) {
    case 'bundled': return t('bundledSource')
    case 'custom': return t('importedSource')
    case 'user-dsh': case 'user-agents': return t('userSource')
    case 'project-dsh': case 'project-agents': return t('projectSource')
    case 'runtime': return t('runtimeSource')
    default: return source
  }
}

/**
 * Describe the native invocation policy without implying an editable enablement switch.
 * @param invocation Actual model/user flags; absence leaves the policy undisclosed.
 * @param t Skills copy for the current locale.
 * @returns A localized scope label, or undefined when the source supplied no policy.
 */
export function skillInvocationLabel(invocation: SkillCard['invocation'], t: TranslateNS<'cloud-skill-management'>): string | undefined {
  if (invocation === undefined) return undefined
  return t(invocation.modelInvocable ? invocation.userInvocable ? 'invocationBoth' : 'invocationModel'
    : invocation.userInvocable ? 'invocationUser' : 'invocationNone')
}
