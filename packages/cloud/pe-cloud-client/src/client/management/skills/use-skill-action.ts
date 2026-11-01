/** Component-local observation of one explicit action; no transport, retry, request identity or persistence owner. */
import { useEffect, useRef, useState } from 'react'
import type { SkillActionOutcome } from './types.ts'
type ActionView<Additional extends string> = 'idle' | 'pending' | SkillActionOutcome | Additional
type ActionOperation<Additional extends string> = (signal: AbortSignal) => Promise<SkillActionOutcome | Additional>

/** Observe explicit gestures; uncertain writes consume the interaction until it closes.
 * @param mode Read observations permit another explicit gesture after failure; omitted mode preserves once-only writes.
 * @returns Local observation state and an explicit once-only action runner.
 */
export function useSkillAction<Additional extends string = never>(mode: 'write' | 'read' = 'write'): {
  readonly state: ActionView<Additional>
  readonly run: (operation: ActionOperation<Additional>) => Promise<SkillActionOutcome | Additional | undefined>
} {
  const active = useRef<AbortController>(), used = useRef(false), alive = useRef(true)
  const [state, setState] = useState<ActionView<Additional>>('idle')
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; active.current?.abort() }
  }, [])
  return { state, run: async (operation: ActionOperation<Additional>): Promise<SkillActionOutcome | Additional | undefined> => {
    if (used.current || !alive.current) return undefined
    used.current = true
    const controller = new AbortController(); active.current = controller
    const isCurrent = (): boolean => alive.current && active.current === controller && !controller.signal.aborted
    setState('pending')
    let outcome: SkillActionOutcome | Additional
    try { outcome = await operation(controller.signal) }
    catch { outcome = 'unknown' }
    if (!isCurrent()) return undefined
    active.current = undefined
    if (outcome === 'confirmed' || mode === 'read') used.current = false
    setState(outcome)
    return outcome
  } }
}
