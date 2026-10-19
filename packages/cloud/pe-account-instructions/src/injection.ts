/** Native pre-step wiring without an alternate inbox or Session event type. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { InstructionMessage } from './types.ts'

/** A complete snapshot whose files-owned reservation remains held until native handoff or withdrawal. */
export interface PreparedInstruction {
  readonly message: InstructionMessage
  /**
   * Release the retained reservation without throwing; underlying I/O has already settled.
   * @returns No value; the files owner no longer retains the snapshot's reserved bytes.
   */
  release(): void
}

interface TurnSnapshot {
  readonly turn: number
  readonly work: Promise<PreparedInstruction>
  retained?: PreparedInstruction
  offeredId?: InstructionMessage['id']
  accepted: boolean
}

/**
 * Install a single immutable instruction message for each real Session turn.
 * The supplied adapter must validate the exact Agent's account/epoch/project,
 * reserve all retained bytes through files, and return a complete bounded native
 * context message with C-09 metadata and producer attribution. It must not return
 * before its observable I/O has settled; disposal waits for those operations.
 * The reservation transfers to the native Session on its accepted user/message;
 * turn end, generation withdrawal or disposal releases an unaccepted snapshot.
 * @param ctx - owner of the scoped native listeners and their disposer.
 * @param accountLifetime - runtime-owned generation signal, independent of requests.
 * @param assertCurrent - owning account adapter's current admission check for this Agent.
 * @param prepare - owner adapter; this module does not manufacture authorization.
 * @returns No value; the owner retains the listeners and preparation drain effect.
 */
export function installInstructionInjection(
  ctx: Context,
  accountLifetime: AbortSignal,
  assertCurrent: (agent: Agent) => void,
  prepare: (agent: Agent, signal: AbortSignal) => Promise<PreparedInstruction>,
): void {
  const lifetime = new AbortController()
  const operations = new Set<Promise<PreparedInstruction>>()
  const turns = new Map<Session, TurnSnapshot>()
  const release = (snapshot: TurnSnapshot): void => {
    const held = snapshot.retained
    delete snapshot.retained
    held?.release()
  }
  const withdraw = (): void => {
    lifetime.abort(new Error('pe-account-instructions withdrawn'))
    for (const snapshot of turns.values()) release(snapshot)
    turns.clear()
  }
  accountLifetime.addEventListener('abort', withdraw, { once: true })
  if (accountLifetime.aborted) withdraw()
  ctx.effect(() => async () => {
    accountLifetime.removeEventListener('abort', withdraw)
    withdraw()
    await Promise.allSettled(operations)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      const snapshot = turns.get(session)
      turns.delete(session)
      if (snapshot !== undefined) release(snapshot)
    }
    else if (event.type === 'user/message' && event.data.source.kind === 'pe-account-instructions') {
      const snapshot = turns.get(session)
      if (snapshot?.offeredId === event.data.id) {
        snapshot.accepted = true
        release(snapshot)
      }
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
      if (snapshot !== undefined) release(snapshot)
      const work = Promise.resolve().then(() => {
        control.throwIfAborted()
        return prepare(agent, control)
      }).then((held) => {
        if (control.aborted || turns.get(agent.session) !== state) held.release()
        else state.retained = held
        return held
      })
      const tracked = work.finally(() => operations.delete(tracked))
      const state: TurnSnapshot = { turn, accepted: false, work: tracked }
      operations.add(tracked)
      snapshot = state
      turns.set(agent.session, snapshot)
    }
    const held = await snapshot.work
    try {
      control.throwIfAborted()
      assertCurrent(agent)
    } catch (error) { release(snapshot); throw error }
    if (snapshot.accepted) return decision
    // A returned decision is still replaceable; only the native log confirms acceptance.
    const context = held.message
    snapshot.offeredId = context.id
    const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
    return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, context) }
  })
}
