/** Native shell presentation for a confirmed revoked product login. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AccountExpiryView } from './session-expiry.ts'

/** Registrant-private facts become renderer-owned hooks. */
export interface SessionExpiredInjected {
  readonly hooks: { readonly accountExpiry: HostObservable<AccountExpiryView | undefined> }
  readonly returnToLogin: () => Promise<void>
}

/** Native overlay shares plus the local expiry hook and sign-in action. */
export type SessionExpiredNoticeProps = PropsRuntime<'shell.overlay'> & PropsLocale<'powerEvolve.account'> & InjectFace<SessionExpiredInjected>

/** Cover stale native views until the configured login navigation completes.
 * @param props - renderer-bound expiry fact, localized copy and navigation retry.
 * @returns the required sign-in modal, or nothing for an active login.
 */
export function SessionExpiredNotice({ useAccountExpiry, returnToLogin, t }: SessionExpiredNoticeProps) {
  const expiry = useAccountExpiry(state => state)
  if (!expiry) return null
  return <Modal open headless title={t('sessionExpired')} onClose={() => {}}>
    <div style={{ display: 'grid', gap: 16, padding: 24 }}>
      <h2 style={{ margin: 0 }}>{t('sessionExpired')}</h2>
      <p style={{ margin: 0 }}>{t('nativeSignInHint')}</p>
      {expiry.loginUnavailable && <p role="alert" style={{ margin: 0 }}>{t('loginAddressUnavailable')}</p>}
      <Button variant="primary" data-modal-autofocus disabled={expiry.findingLogin}
        onClick={() => { void returnToLogin() }}>{t(expiry.findingLogin ? 'openingLogin' : 'signInAgain')}</Button>
    </div>
  </Modal>
}
