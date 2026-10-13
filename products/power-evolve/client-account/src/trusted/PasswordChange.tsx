import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
/** Password fields stay inside the Platform-origin account page. */
import { useEffect, useRef, useState } from 'react'
import { AccountActionError, type AccountTranslate } from './view.ts'

/** Immutable password gesture kept only in this component's memory. */
export interface PasswordChangeIntent {
  readonly requestId: string
  readonly currentPassword: string
  readonly newPassword: string
}

/** Actions and validated limits supplied by the trusted page. */
export interface PasswordChangeProps {
  readonly required: boolean
  readonly minBytes: number
  readonly maxBytes: number
  readonly change: (intent: PasswordChangeIntent, signal: AbortSignal) => Promise<void>
  readonly onChanged: () => void
  readonly onExpired: () => void
  readonly t: AccountTranslate
}

/** Migrate the current/new/confirmation form with one stable request on retries.
 * @param props - Platform actions, limits and localized copy.
 * @returns the personal password form.
 */
export function PasswordChange({ required, minBytes, maxBytes, change, onChanged, onExpired, t }: PasswordChangeProps) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [problem, setProblem] = useState<'passwordMismatch' | 'passwordLength' | 'passwordSame' | 'passwordUncertain' | 'passwordRejected'>()
  const [busy, setBusy] = useState(false)
  const pending = useRef<PasswordChangeIntent>()
  const request = useRef<AbortController>()
  useEffect(() => () => { request.current?.abort(); pending.current = undefined }, [])
  const submit = async () => {
    if (request.current || busy) return
    if (!pending.current) {
      if (next !== confirm) { setProblem('passwordMismatch'); return }
      const bytes = new TextEncoder().encode(next).byteLength
      if (!current || bytes < minBytes || bytes > maxBytes) { setProblem('passwordLength'); return }
      if (current === next) { setProblem('passwordSame'); return }
      pending.current = { requestId: randomUUID(), currentPassword: current, newPassword: next }
    }
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setProblem(undefined)
    try {
      await change(pending.current, controller.signal)
      if (controller.signal.aborted) return
      pending.current = undefined
      setCurrent(''); setNext(''); setConfirm('')
      onChanged()
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof AccountActionError) {
        pending.current = undefined
        if (error.problem === 'permissionLost') {
          setCurrent(''); setNext(''); setConfirm(''); onExpired()
        } else setProblem('passwordRejected')
      } else setProblem('passwordUncertain')
    } finally {
      request.current = undefined
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const locked = busy || pending.current !== undefined
  return <section className="pe-account-panel pe-password-change" data-account-password="">
    <header><h2>{t(required ? 'firstPasswordTitle' : 'changePassword')}</h2></header>
    <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {required && <p>{t('firstPasswordHint')}</p>}
      <p>{t('passwordHint')} {minBytes}–{maxBytes}</p>
      <label>{t('currentPassword')}<input type="password" autoComplete="current-password" required
        maxLength={maxBytes} value={current} disabled={locked} onChange={(event) =>{  setCurrent(event.target.value) }} /></label>
      <label>{t('newPassword')}<input type="password" autoComplete="new-password" required
        maxLength={maxBytes} value={next} disabled={locked} onChange={(event) =>{  setNext(event.target.value) }} /></label>
      <label>{t('confirmPassword')}<input type="password" autoComplete="new-password" required
        maxLength={maxBytes} value={confirm} disabled={locked} onChange={(event) =>{  setConfirm(event.target.value) }} /></label>
      {problem && <p role="alert" className="pe-users-error">{t(problem)}</p>}
      <button type="submit" disabled={busy}>{t(busy ? 'passwordSaving' : pending.current ? 'retryPassword' : 'savePassword')}</button>
    </form>
  </section>
}
