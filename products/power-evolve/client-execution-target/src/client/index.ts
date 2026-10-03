/** Per-submission cloud or authorized desktop selection inside the native DSH composer. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ExecutionTargetPicker } from './ExecutionTargetPicker.tsx'
import { ExecutionTargetClient } from './execution-target-client.ts'
import { ExecutionResolutionClient } from './execution-resolution-client.ts'
import { en, zh, type ExecutionTargetLocaleKey } from './locales.ts'
import { installExecutionTargetStyles } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'powerEvolve.executionTarget': ExecutionTargetLocaleKey
  }
}

const namespace = 'powerEvolve.executionTarget'
type SessionId = Session['sessionId']

export const inject = ['slots', 'locale', 'conversation']

export function apply(ctx: Context): void {
  const client = new ExecutionTargetClient()
  const resolutionClient = new ExecutionResolutionClient()
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'PowerEvolve execution target labels')
  ctx.effect(() => installExecutionTargetStyles(), 'PowerEvolve execution target styles')
  ctx.effect(() => ctx.conversation.registerPromptHint('powerEvolve.executionTarget',
    (sessionId: SessionId) => client.hint(sessionId)), 'PowerEvolve exact-submission execution target')
  ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'power-evolve-execution-target', order: 10,
    locale: namespace, inject: (sessionId: SessionId) => ({ sessionId, client, resolutionClient }),
  }, ExecutionTargetPicker)), 'PowerEvolve execution target picker')
}
