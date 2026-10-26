/** Component-local observation of one explicit action; no transport, retry, request identity or persistence owner. */
import { useEffect, useRef, useState } from 'react'
import type { SkillActionOutcome } from './types.ts'
type ActionView = 'idle' | 'pending' | SkillActionOutcome

/** Observe explicit gestures; uncertain writes consume the interaction until it closes.
 * @param mode Read observations permit another explicit gesture after failure; omitted mode preserves once-only writes.
 * @returns Local observation state and an explicit once-only action runner.
 */
export function useSkillAction(mode: 'write' | 'read' = 'write'): {
  readonly state: ActionView
  readonly run: (operation: (signal: AbortSignal) => Promise<SkillActionOutcome>) => Promise<SkillActionOutcome | undefined>
} {
  const active = useRef<AbortController>(), used = useRef(false), alive = useRef(true)
  const [state, setState] = useState<ActionView>('idle')
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; active.current?.abort() }
  }, [])
  return { state, run: async (operation: (signal: AbortSignal) => Promise<SkillActionOutcome>): Promise<SkillActionOutcome | undefined> => {
    if (used.current || !alive.current) return undefined
    used.current = true
    const controller = new AbortController(); active.current = controller
    const isCurrent = (): boolean => alive.current && active.current === controller && !controller.signal.aborted
    setState('pending')
    let outcome: SkillActionOutcome
    try { outcome = await operation(controller.signal) }
    catch { outcome = 'unknown' }
    if (!isCurrent()) return undefined
    active.current = undefined
    if (outcome === 'confirmed' || mode === 'read') used.current = false
    setState(outcome)
    return outcome
  } }
}
