/** Native pre-step wiring without an alternate inbox or Session event type. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { InstructionMessage } from './types.ts'

/**
 * Install a single immutable instruction message for each real Session turn.
 * The supplied adapter must validate the exact Agent's account/epoch/project,
 * reserve all retained bytes through files, and return a complete bounded native
 * context message with C-09 metadata and producer attribution. It must not return
 * before its observable I/O has settled; disposal waits for those operations.
 * @param ctx - owner of the scoped native listeners and their disposer.
 * @param accountLifetime - runtime-owned generation signal, independent of requests.
 * @param assertCurrent - owning account adapter's current admission check for this Agent.
 * @param prepare - owner adapter; this module does not manufacture authorization.
 */
export function installInstructionInjection(
  ctx: Context,
  accountLifetime: AbortSignal,
  assertCurrent: (agent: Agent) => void,
  prepare: (agent: Agent, signal: AbortSignal) => Promise<InstructionMessage>,
): void {
  const lifetime = new AbortController()
  const operations = new Set<Promise<InstructionMessage>>()
  const turns = new WeakMap<Session, {
    turn: number
    message: Promise<InstructionMessage>
    prepared?: InstructionMessage
    accepted: boolean
  }>()
  ctx.effect(() => async () => {
    lifetime.abort(new Error('pe-account-instructions disposed'))
    await Promise.allSettled(operations)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') turns.delete(session)
    else if (event.type === 'user/message' && event.data.source.kind === 'pe-account-instructions') {
      const state = turns.get(session)
      if (state?.prepared?.id === event.data.id) state.accepted = true
    }
  })
  ctx.on('agent/pre-step', async ({ agent, turn, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const control = AbortSignal.any([signal, accountLifetime, lifetime.signal])
    control.throwIfAborted()
    assertCurrent(agent)
    let snapshot = turns.get(agent.session)
    if (decision.messages.length === 0 && (snapshot === undefined || snapshot.turn !== turn || snapshot.accepted)) return decision
    if (snapshot === undefined || snapshot.turn !== turn) {
      const work = prepare(agent, control)
      const tracked = work.finally(() => operations.delete(tracked))
      operations.add(tracked)
      snapshot = { turn, message: tracked, accepted: false }
      turns.set(agent.session, snapshot)
    }
    const context = await snapshot.message
    control.throwIfAborted()
    assertCurrent(agent)
    if (snapshot.accepted) return decision
    // A returned decision is still replaceable; only the native log confirms acceptance.
    snapshot.prepared = context
    const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, context) }
  })
}
